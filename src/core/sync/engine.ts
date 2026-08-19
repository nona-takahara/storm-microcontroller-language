import { normalizeComparableModule } from "../compare/comparable-node.js";
import { compareComparableModuleGraphs } from "../compare/module-graph-comparator.js";
import { flattenSwNetProject } from "../compare/project-flattener.js";
import {
  type ComparableModuleGraph,
  type ComparableNode,
  type MatchedNodePair,
  type ProvenancePath,
} from "../compare/types.js";
import { type IrLink, type IrScalarValue } from "../ir.js";
import { type StormworksProjectSource, type ResolvedStormworksProjectSource, type StormworksSourceDocument } from "../project-source.js";
import {
  applySwNetTextEdits,
  createSwNetElementRemovalEdit,
  createSwNetStatementInsertionEdit,
  type SwNetTextEdit,
} from "../parsers/sw-net-source.js";
import {
  type SwNetAssignment,
  type SwNetExpression,
  type SwNetModule,
  type SwNetStatement,
} from "../parsers/sw-net.js";
import { serializeSwNetStatement } from "../serializers/sw-net-document.js";
import { type StormworksSwMclDocument } from "../serializers/sw-mcl.js";
import { findPartialNodeCorrespondence, type PartialCorrespondenceOptions } from "./partial-matcher.js";
import {
  type SynchronizationChange,
  type SynchronizationConflict,
  type SynchronizationImpact,
  type SynchronizationLayoutUpdate,
  type SynchronizationNodeRef,
  type SynchronizationPlan,
  type SynchronizationWarning,
} from "./types.js";

export interface BuildSynchronizationPlanOptions extends PartialCorrespondenceOptions {}

/** Build a deterministic, side-effect-free plan for projecting an imported project into existing DSL. */
export function buildSynchronizationPlan(
  existing: ResolvedStormworksProjectSource,
  incoming: StormworksProjectSource,
  options: BuildSynchronizationPlanOptions = {},
): SynchronizationPlan {
  const flattened = flattenSwNetProject(existing.swNet, {
    entryModuleId: existing.projectSource.entryModuleId,
  });
  if (!flattened.value) {
    throw new Error(flattened.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  const oldNormalized = normalizeComparableModule(flattened.value.module);
  const incomingModule = selectIncomingModule(incoming);
  const newNormalized = normalizeComparableModule(incomingModule);
  if (!oldNormalized.value || !newNormalized.value) {
    throw new Error([...oldNormalized.diagnostics, ...newNormalized.diagnostics].map((item) => item.message).join("\n"));
  }

  const oldGraph = attachProvenance(
    oldNormalized.value,
    flattened.value.provenanceByInstanceId,
    flattened.value.documentPathByInstanceId,
  );
  const newGraph = newNormalized.value;
  const full = compareComparableModuleGraphs(oldGraph, newGraph, [], options);
  const partial =
    full.matchedPairs.length === oldGraph.nodes.length && full.matchedPairs.length === newGraph.nodes.length
      ? {
          certainPairs: full.matchedPairs,
          unmatchedExisting: [],
          unmatchedIncoming: [],
          ambiguousExisting: [],
          ambiguousIncoming: [],
          optimalCorrespondenceCount: 1,
          searchSteps: 0,
          truncated: false,
        }
      : findPartialNodeCorrespondence(oldGraph, newGraph, options);
  const changes = classifyChanges(oldGraph, newGraph, partial.certainPairs, partial.unmatchedExisting, partial.unmatchedIncoming);
  const conflicts: SynchronizationConflict[] = [];
  const warnings: SynchronizationWarning[] = [];

  if (partial.truncated || partial.ambiguousExisting.length > 0 || partial.ambiguousIncoming.length > 0) {
    conflicts.push({
      kind: "ambiguous-correspondence",
      reason: partial.truncated
        ? `Partial correspondence search exhausted its budget after ${partial.searchSteps} steps.`
        : `${partial.optimalCorrespondenceCount} optimal correspondences disagree on one or more node pairs.`,
      impacts: [
        ...partial.ambiguousExisting.map((node) => impactFromNode(node)),
        ...partial.ambiguousIncoming.map((node) => ({ instanceId: node.node.id })),
      ],
      suggestions: [{
        kind: "review-candidates",
        description: "Review the symmetric or otherwise indistinguishable nodes and make their local wiring distinguishable.",
        impacts: partial.ambiguousExisting.map((node) => impactFromNode(node)),
      }],
    });
  }

  const pairByIncomingId = new Map(partial.certainPairs.map((pair) => [pair.b.node.id, pair] as const));
  const placements = planAddedPlacements(newGraph, partial.unmatchedIncoming, pairByIncomingId, conflicts);
  detectPortBoundaryChanges(changes, conflicts);
  detectSharedModuleDivergence(oldGraph.nodes, newGraph, changes, partial.certainPairs, conflicts);
  const projectedLayout = projectLayoutToExistingModules(existing, incoming, partial.certainPairs, placements, warnings);

  const project = {
    ...incoming.project,
    submodule: existing.projectSource.project.submodule
      ? { ...existing.projectSource.project.submodule }
      : incoming.project.submodule,
  };
  const lua = planLua(existing.documents, incoming.entryDocument);
  let sourceEdits: SynchronizationPlan["sourceEdits"] = [];
  let layouts: SynchronizationLayoutUpdate[] = [];

  if (conflicts.length === 0) {
    sourceEdits = buildSourceEdits(existing, incomingModule, newGraph, partial.certainPairs, changes, placements);
    layouts = buildLayoutUpdates(existing.documents, partial.certainPairs, placements, projectedLayout);
  }

  return {
    applicable: conflicts.length === 0,
    changes,
    conflicts,
    warnings,
    sourceEdits,
    project,
    layouts,
    lua,
    summary: {
      added: changes.filter((change) => change.kind === "added").length,
      removed: changes.filter((change) => change.kind === "removed").length,
      updated: changes.filter((change) => change.kind === "updated").length,
      rewired: changes.filter((change) => change.kind === "rewired").length,
      conflicts: conflicts.length,
    },
    proposedPositions: Object.fromEntries(
      incoming.entryDocument.swMcl?.instances.map((item) => [item.id, { ...item.position }]) ?? [],
    ),
  };
}

/** Materialize one plan's source edits in memory; callers still own validation and file writes. */
export function materializeSynchronizationSources(
  existing: ResolvedStormworksProjectSource,
  plan: SynchronizationPlan,
): Record<string, string> {
  if (!plan.applicable) {
    throw new Error("A synchronization plan with blocking conflicts cannot be materialized.");
  }
  const sourceByPath = new Map(existing.documents.map((document) => [document.documentId, document] as const));
  return Object.fromEntries(plan.sourceEdits.map(({ documentPath, edits }) => {
    const source = sourceByPath.get(documentPath)?.swNetSource;
    if (!source) {
      throw new Error(`Exact sw-net source text is unavailable for ${documentPath}.`);
    }
    return [documentPath, applySwNetTextEdits(source.text, edits)];
  }));
}

function selectIncomingModule(incoming: StormworksProjectSource): SwNetModule {
  return incoming.entryDocument.swNet.modules.find((module) => module.id === incoming.entryModuleId) ??
    incoming.entryDocument.swNet.modules.find((module) => module.id === "main") ??
    incoming.entryDocument.swNet.modules[0] ??
    (() => { throw new Error("The incoming project has no sw-net module."); })();
}

function attachProvenance(
  graph: ComparableModuleGraph,
  provenanceByInstanceId: Record<string, ProvenancePath>,
  documentPathByInstanceId: Record<string, string>,
): ComparableModuleGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      node: documentPathByInstanceId[node.node.id]
        ? { ...node.node, source: { format: "sw-net", path: documentPathByInstanceId[node.node.id] } }
        : node.node,
      provenance: provenanceByInstanceId[node.node.id],
    })),
  };
}

function classifyChanges(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
  pairs: MatchedNodePair[],
  removed: ComparableNode[],
  added: ComparableNode[],
): SynchronizationChange[] {
  const changes: SynchronizationChange[] = [];
  const incomingIdByExistingId = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
  for (const node of removed) {
    changes.push({ kind: "removed", existing: nodeRef(node) });
  }
  for (const node of added) {
    changes.push({ kind: "added", incoming: nodeRef(node) });
  }
  for (const pair of pairs) {
    const propertyChanges = compareProperties(pair.a.attributes, pair.b.attributes);
    if (Object.keys(propertyChanges).length > 0) {
      changes.push({ kind: "updated", existing: nodeRef(pair.a), incoming: nodeRef(pair.b), propertyChanges });
    }
    if (incidentSignature(existing.links, pair.a.node.id, incomingIdByExistingId) !== incidentSignature(incoming.links, pair.b.node.id)) {
      changes.push({ kind: "rewired", existing: nodeRef(pair.a), incoming: nodeRef(pair.b) });
    }
  }
  return changes;
}

function compareProperties(
  before: Record<string, IrScalarValue>,
  after: Record<string, IrScalarValue>,
): Record<string, { before?: IrScalarValue; after?: IrScalarValue }> {
  const result: Record<string, { before?: IrScalarValue; after?: IrScalarValue }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) {
      result[key] = { before: before[key], after: after[key] };
    }
  }
  return result;
}

function incidentSignature(links: IrLink[], nodeId: string, mappedIds?: Map<string, string>): string {
  return links.flatMap((link) => {
    if (link.from.nodeId === nodeId) {
      return [`out:${link.from.portKey}->${mappedIds?.get(link.to.nodeId) ?? link.to.nodeId}:${link.to.portKey}`];
    }
    if (link.to.nodeId === nodeId) {
      return [`in:${link.to.portKey}<-${mappedIds?.get(link.from.nodeId) ?? link.from.nodeId}:${link.from.portKey}`];
    }
    return [];
  }).sort().join("|");
}

interface AddedPlacement { node: ComparableNode; documentPath: string; moduleId: string; usePath: string[]; instanceId: string }

function planAddedPlacements(
  incoming: ComparableModuleGraph,
  added: ComparableNode[],
  pairByIncomingId: Map<string, MatchedNodePair>,
  conflicts: SynchronizationConflict[],
): AddedPlacement[] {
  const placements: AddedPlacement[] = [];
  const occupied = new Set([...pairByIncomingId.values()].map((pair) => pair.a.provenance?.instanceIds.at(-1)).filter((id): id is string => Boolean(id)));
  for (const node of added.filter((item) => !item.port)) {
    const neighbors = incoming.links.flatMap((link) => link.from.nodeId === node.node.id ? [link.to.nodeId] : link.to.nodeId === node.node.id ? [link.from.nodeId] : []);
    const contexts = new Map<string, { provenance: ProvenancePath; documentPath: string }>();
    for (const neighbor of neighbors) {
      const provenance = pairByIncomingId.get(neighbor)?.a.provenance;
      const documentPath = pairByIncomingId.get(neighbor)?.a.node.source?.path;
      if (provenance && documentPath) {
        contexts.set(`${documentPath}\0${provenance.moduleId}\0${provenance.instanceIds.slice(0, -1).join("/")}`, { provenance, documentPath });
      }
    }
    if (contexts.size !== 1) {
      const kind = contexts.size === 0 ? "module-boundary" : "ambiguous-placement";
      const impacts = [...contexts.values()].map(({ provenance, documentPath }) => impactFromProvenance(provenance, undefined, documentPath));
      conflicts.push({
        kind,
        reason: contexts.size === 0
          ? `Added node ${node.node.id} has no matched neighbor that establishes an existing module placement.`
          : `Added node ${node.node.id} connects to more than one existing module context.`,
        impacts,
        suggestions: [{
          kind: "review-candidates",
          description: "Choose the owning module and add any required boundary ports and use bindings manually.",
          impacts,
        }],
      });
      continue;
    }
    const { provenance, documentPath } = [...contexts.values()][0]!;
    const preferred = preferredInstanceName(node.node.objectId ?? node.node.id);
    const instanceId = reserveName(preferred, occupied);
    placements.push({ node, documentPath, moduleId: provenance.moduleId, usePath: provenance.instanceIds.slice(0, -1), instanceId });
  }
  return placements;
}

function detectPortBoundaryChanges(changes: SynchronizationChange[], conflicts: SynchronizationConflict[]): void {
  const ports = changes.filter((change) => (change.existing?.nodeId ?? change.incoming?.nodeId)?.startsWith("port:"));
  if (ports.length === 0) return;
  const impacts = ports.map((change) => ({ moduleId: change.existing?.moduleId, instanceId: change.existing?.instanceId ?? change.incoming?.instanceId }));
  conflicts.push({
    kind: "module-boundary",
    reason: "Project or module ports changed and require explicit module-boundary edits.",
    impacts,
    suggestions: [
      { kind: "add-module-port", description: "Add or remove the affected module port declarations.", impacts },
      { kind: "add-pin-assignment", description: "Update internal pin assignments for the changed ports.", impacts },
      { kind: "add-use-binding", description: "Update every affected use binding.", impacts },
    ],
  });
}

function detectSharedModuleDivergence(
  existingNodes: ComparableNode[],
  incoming: ComparableModuleGraph,
  changes: SynchronizationChange[],
  pairs: MatchedNodePair[],
  conflicts: SynchronizationConflict[],
): void {
  const occurrences = new Map<string, ComparableNode[]>();
  for (const node of existingNodes) {
    const provenance = node.provenance;
    const documentPath = node.node.source?.path;
    if (!provenance || !documentPath) continue;
    const key = `${documentPath}\0${provenance.moduleId}\0${provenance.instanceIds.at(-1)}`;
    const group = occurrences.get(key) ?? [];
    group.push(node);
    occurrences.set(key, group);
  }
  for (const group of occurrences.values()) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map((node) => {
      const nodeChanges = changes.filter((change) => change.existing?.nodeId === node.node.id);
      if (nodeChanges.length === 0) return "unchanged";
      if (nodeChanges.some((change) => change.kind === "removed")) return "removed";
      const pair = pairs.find((item) => item.a.node.id === node.node.id);
      return pair
        ? `${pair.b.node.definitionId}\0${JSON.stringify(pair.b.attributes)}\0${nodeChanges.map((item) => item.kind).sort().join(",")}\0${structuralIncidentSignature(incoming, pair.b)}`
        : "changed";
    }));
    if (signatures.size > 1) {
      const impacts = group.map(impactFromNode);
      conflicts.push({
        kind: "shared-module-divergence",
        reason: "Different expansions of one shared module require different local changes.",
        impacts,
        suggestions: [
          { kind: "duplicate-module", description: "Duplicate the module for the use sites that diverge, then apply the local change there.", impacts },
          { kind: "update-shared-module", description: "Apply one common change to every use of the shared module.", impacts },
        ],
      });
    }
  }
}

function structuralIncidentSignature(graph: ComparableModuleGraph, node: ComparableNode): string {
  const nodeById = new Map(graph.nodes.map((item) => [item.node.id, item] as const));
  return graph.links.flatMap((link) => {
    if (link.from.nodeId === node.node.id) {
      return [`out:${link.from.portKey}->${nodeById.get(link.to.nodeId)?.node.definitionId}:${link.to.portKey}`];
    }
    if (link.to.nodeId === node.node.id) {
      return [`in:${link.to.portKey}<-${nodeById.get(link.from.nodeId)?.node.definitionId}:${link.from.portKey}`];
    }
    return [];
  }).sort().join("|");
}

interface ProjectedLayout {
  existingByNodeId: Map<string, { x: number; y: number }>;
  addedByNodeId: Map<string, { x: number; y: number }>;
}

function projectLayoutToExistingModules(
  existing: ResolvedStormworksProjectSource,
  incoming: StormworksProjectSource,
  pairs: MatchedNodePair[],
  placements: AddedPlacement[],
  warnings: SynchronizationWarning[],
): ProjectedLayout {
  const incomingPosition = new Map(incoming.entryDocument.swMcl?.instances.map((item) => [item.id, item.position] as const) ?? []);
  const existingByNodeId = new Map<string, { x: number; y: number }>();
  const addedByNodeId = new Map<string, { x: number; y: number }>();
  const localPositions = new Map<string, Array<{ position: { x: number; y: number }; impact: SynchronizationImpact }>>();

  for (const pair of pairs) {
    const absolute = incomingPosition.get(pair.b.node.id);
    const provenance = pair.a.provenance;
    if (!absolute || !provenance) continue;
    const projection = subtractUseAnchors(existing, provenance.instanceIds.slice(0, -1), absolute);
    if (!projection) {
      addLayoutProjectionWarning(warnings, impactFromNode(pair.a));
      continue;
    }
    existingByNodeId.set(pair.a.node.id, projection);
    const documentPath = pair.a.node.source?.path;
    const localInstanceId = provenance.instanceIds.at(-1);
    const previous = documentPath && localInstanceId
      ? existing.documents.find((document) => document.documentId === documentPath)?.swMcl?.instances.find((instance) => instance.id === localInstanceId)?.position
      : undefined;
    if (previous && (previous.x !== projection.x || previous.y !== projection.y)) {
      warnings.push({
        kind: "layout-overwrite",
        reason: `Layout position will be overwritten from (${previous.x}, ${previous.y}) to (${projection.x}, ${projection.y}).`,
        impacts: [impactFromNode(pair.a)],
        selectedPosition: projection,
      });
    }
    const key = `${pair.a.node.source?.path}\0${provenance.moduleId}\0${provenance.instanceIds.at(-1)}`;
    const entries = localPositions.get(key) ?? [];
    entries.push({ position: projection, impact: impactFromNode(pair.a) });
    localPositions.set(key, entries);
  }

  for (const placement of placements) {
    const absolute = incomingPosition.get(placement.node.node.id);
    if (!absolute) continue;
    const projection = subtractUseAnchors(existing, placement.usePath, absolute);
    if (!projection) {
      addLayoutProjectionWarning(warnings, { documentPath: placement.documentPath, moduleId: placement.moduleId, instanceId: placement.instanceId, usePath: placement.usePath });
      continue;
    }
    addedByNodeId.set(placement.node.node.id, projection);
  }

  for (const entries of localPositions.values()) {
    const positions = new Set(entries.map(({ position }) => `${position.x}\0${position.y}`));
    if (entries.length > 1 && positions.size > 1) {
      const impacts = entries.map((entry) => entry.impact);
      const selectedPosition = entries[0]!.position;
      warnings.push({
        kind: "layout-overwrite",
        reason: "Shared module expansions implied different local positions; the first deterministic projection will overwrite the shared module layout.",
        impacts,
        selectedPosition,
      });
      for (const entry of entries) {
        const matching = pairs.find((pair) => {
          const impact = impactFromNode(pair.a);
          return impact.documentPath === entry.impact.documentPath &&
            impact.moduleId === entry.impact.moduleId &&
            impact.instanceId === entry.impact.instanceId &&
            JSON.stringify(impact.usePath) === JSON.stringify(entry.impact.usePath);
        });
        if (matching) existingByNodeId.set(matching.a.node.id, selectedPosition);
      }
    }
  }

  return { existingByNodeId, addedByNodeId };
}

function subtractUseAnchors(
  existing: ResolvedStormworksProjectSource,
  usePath: string[],
  absolute: { x: number; y: number },
): { x: number; y: number } | undefined {
  let current = existing.swNet.modules.find(
    (module) => module.key.documentPath === existing.swNet.entryDocumentPath && module.key.moduleId === existing.projectSource.entryModuleId,
  );
  let offsetX = 0;
  let offsetY = 0;
  for (const useId of usePath) {
    if (!current) return undefined;
    const document = existing.documents.find((item) => item.documentId === current!.key.documentPath);
    const anchor = document?.swMcl?.instances.find((item) => item.id === useId)?.position;
    const use = current.uses.find((item) => item.statement.instanceId === useId);
    if (!anchor || !use) return undefined;
    offsetX += anchor.x;
    offsetY += anchor.y;
    current = existing.swNet.modules.find(
      (module) => module.key.documentPath === use.target.documentPath && module.key.moduleId === use.target.moduleId,
    );
  }
  return { x: absolute.x - offsetX, y: absolute.y - offsetY };
}

function addLayoutProjectionWarning(warnings: SynchronizationWarning[], impact: SynchronizationImpact): void {
  warnings.push({
    kind: "layout-projection",
    reason: "An XML absolute position was not applied because an existing use anchor is missing or unresolved.",
    impacts: [impact],
  });
}

function buildSourceEdits(
  existing: ResolvedStormworksProjectSource,
  incomingModule: SwNetModule,
  incomingGraph: ComparableModuleGraph,
  pairs: MatchedNodePair[],
  changes: SynchronizationChange[],
  placements: AddedPlacement[],
): SynchronizationPlan["sourceEdits"] {
  const editsByDocument = new Map<string, SwNetTextEdit[]>();
  const documents = new Map(existing.documents.map((document) => [document.documentId, document] as const));
  const incomingStatementById = new Map(incomingModule.statements.map((statement) => [statement.instanceId, statement] as const));
  const pairByIncomingId = new Map(pairs.map((pair) => [pair.b.node.id, pair] as const));
  const placementByIncomingId = new Map(placements.map((placement) => [placement.node.node.id, placement] as const));
  const netMap = buildIncomingNetMap(existing, incomingModule, pairs, placements);
  const editedLocalKeys = new Set<string>();

  for (const change of changes) {
    const oldRef = change.existing;
    if (!oldRef?.documentPath || !oldRef.moduleId || !oldRef.instanceId || oldRef.nodeId.startsWith("port:")) continue;
    const key = `${oldRef.documentPath}\0${oldRef.moduleId}\0${oldRef.instanceId}`;
    if (editedLocalKeys.has(key)) continue;
    const document = documents.get(oldRef.documentPath);
    const module = document?.swNet.modules.find((item) => item.id === oldRef.moduleId);
    const statement = module?.statements.find((item) => item.instanceId === oldRef.instanceId);
    const source = document?.swNetSource;
    if (!document || !module || !statement || !source) throw new Error(`Cannot project source edit for ${key}.`);
    const edits = editsByDocument.get(document.documentId) ?? [];
    if (change.kind === "removed") {
      edits.push(createSwNetElementRemovalEdit(source, statement));
    } else {
      const pair = pairs.find((item) => item.a.node.id === oldRef.nodeId);
      const incomingStatement = pair ? incomingStatementById.get(pair.b.node.id) : undefined;
      if (incomingStatement) {
        edits.push({ ...source.spanOf(statement), newText: serializeSwNetStatement(projectStatement(incomingStatement, oldRef.instanceId, netMap)) });
      }
    }
    editsByDocument.set(document.documentId, edits);
    editedLocalKeys.add(key);
  }

  for (const placement of placements) {
    const document = documents.get(placement.documentPath);
    const module = document?.swNet.modules.find((item) => item.id === placement.moduleId);
    const source = document?.swNetSource;
    const incomingStatement = incomingStatementById.get(placement.node.node.id);
    if (!document || !module || !source || !incomingStatement) throw new Error(`Cannot insert ${placement.node.node.id}.`);
    const edit = createSwNetStatementInsertionEdit(source, module, serializeSwNetStatement(projectStatement(incomingStatement, placement.instanceId, netMap)));
    const edits = editsByDocument.get(document.documentId) ?? [];
    edits.push(edit);
    editsByDocument.set(document.documentId, edits);
  }

  void incomingGraph;
  void pairByIncomingId;
  void placementByIncomingId;
  return [...editsByDocument].map(([documentPath, edits]) => ({ documentPath, edits }));
}

function buildIncomingNetMap(
  existing: ResolvedStormworksProjectSource,
  incoming: SwNetModule,
  pairs: MatchedNodePair[],
  placements: AddedPlacement[],
): Map<string, string> {
  const result = new Map<string, string>();
  const oldStatementByFlatId = new Map<string, SwNetStatement>();
  for (const pair of pairs) {
    const provenance = pair.a.provenance;
    const documentPath = pair.a.node.source?.path;
    if (!provenance || !documentPath) continue;
    const document = existing.documents.find((item) => item.documentId === documentPath);
    const statement = document?.swNet.modules.find((module) => module.id === provenance.moduleId)?.statements.find((item) => item.instanceId === provenance.instanceIds.at(-1));
    if (statement) oldStatementByFlatId.set(pair.a.node.id, statement);
  }
  const incomingById = new Map(incoming.statements.map((statement) => [statement.instanceId, statement] as const));
  for (const pair of pairs) {
    const oldStatement = oldStatementByFlatId.get(pair.a.node.id);
    const newStatement = incomingById.get(pair.b.node.id);
    if (!oldStatement || !newStatement) continue;
    for (const output of newStatement.outputs) {
      const oldOutput = oldStatement.outputs.find((item) => item.key === output.key);
      if (output.value.kind === "identifier" && oldOutput?.value.kind === "identifier") result.set(output.value.value, oldOutput.value.value);
    }
  }
  for (const placement of placements) {
    const statement = incomingById.get(placement.node.node.id);
    for (const output of statement?.outputs ?? []) {
      if (output.value.kind === "identifier") result.set(output.value.value, `${placement.instanceId}_${output.key}`);
    }
  }
  return result;
}

function projectStatement(statement: SwNetStatement, instanceId: string, netMap: Map<string, string>): SwNetStatement {
  const rewrite = (assignment: SwNetAssignment): SwNetAssignment => ({ key: assignment.key, value: rewriteExpression(assignment.value, netMap) });
  return statement.kind === "inst"
    ? { ...statement, instanceId, attributes: statement.attributes.map(rewrite), inputs: statement.inputs.map(rewrite), outputs: statement.outputs.map(rewrite) }
    : { ...statement, instanceId, inputs: statement.inputs.map(rewrite), outputs: statement.outputs.map(rewrite) };
}

function rewriteExpression(expression: SwNetExpression, netMap: Map<string, string>): SwNetExpression {
  return expression.kind === "identifier" ? { ...expression, value: netMap.get(expression.value) ?? expression.value } : { ...expression };
}

function buildLayoutUpdates(
  documents: StormworksSourceDocument[],
  pairs: MatchedNodePair[],
  placements: AddedPlacement[],
  projected: ProjectedLayout,
): SynchronizationLayoutUpdate[] {
  const updates = new Map<string, StormworksSwMclDocument>();
  for (const pair of pairs) {
    const provenance = pair.a.provenance;
    const position = projected.existingByNodeId.get(pair.a.node.id);
    const documentPath = pair.a.node.source?.path;
    if (!provenance || !documentPath || !position) continue;
    updateLayoutInstance(documents, updates, documentPath, provenance.instanceIds.at(-1)!, pair.a.node.definitionId, position);
  }
  for (const placement of placements) {
    const position = projected.addedByNodeId.get(placement.node.node.id);
    if (position) updateLayoutInstance(documents, updates, placement.documentPath, placement.instanceId, placement.node.node.definitionId, position);
  }
  return [...updates].map(([documentPath, swMcl]) => ({ documentPath, swMcl }));
}

function updateLayoutInstance(
  documents: StormworksSourceDocument[],
  updates: Map<string, StormworksSwMclDocument>,
  documentPath: string,
  id: string,
  type: string,
  position: { x: number; y: number },
): void {
  const document = documents.find((item) => item.documentId === documentPath);
  const base = updates.get(documentPath) ?? document?.swMcl;
  if (!base) return;
  const cloned = updates.get(documentPath) ?? { ...base, ports: base.ports.map((item) => ({ ...item, position: { ...item.position } })), instances: base.instances.map((item) => ({ ...item, position: { ...item.position } })), warnings: [...base.warnings] };
  const existing = cloned.instances.find((item) => item.id === id);
  if (existing) existing.position = { ...position };
  else cloned.instances.push({ id, type, position: { ...position } });
  updates.set(documentPath, cloned);
}

function planLua(documents: StormworksSourceDocument[], incoming: StormworksSourceDocument): SynchronizationPlan["lua"] {
  const existingScripts = Object.assign({}, ...documents.map((document) => document.scripts));
  const create: Record<string, string> = {};
  const update: Record<string, string> = {};
  for (const [path, text] of Object.entries(incoming.scripts)) {
    if (!(path in existingScripts)) create[path] = text;
    else if (existingScripts[path] !== text) update[path] = text;
  }
  return { create, update, remove: Object.keys(existingScripts).filter((path) => !(path in incoming.scripts)).sort() };
}

function nodeRef(node: ComparableNode): SynchronizationNodeRef {
  return {
    nodeId: node.node.id,
    definitionId: node.node.definitionId,
    documentPath: node.node.source?.path,
    moduleId: node.provenance?.moduleId,
    instanceId: node.provenance?.instanceIds.at(-1) ?? node.node.id,
    usePath: node.provenance?.instanceIds.slice(0, -1),
  };
}

function impactFromNode(node: ComparableNode): SynchronizationImpact { return impactFromProvenance(node.provenance, node.node.id, node.node.source?.path); }
function impactFromProvenance(provenance?: ProvenancePath, fallback?: string, documentPath?: string): SynchronizationImpact {
  return { documentPath, moduleId: provenance?.moduleId, instanceId: provenance?.instanceIds.at(-1) ?? fallback, usePath: provenance?.instanceIds.slice(0, -1) };
}

function preferredInstanceName(objectId: string): string { return `n${objectId.replace(/[^A-Za-z0-9_]/gu, "_")}`; }
function reserveName(preferred: string, occupied: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;
  while (occupied.has(candidate)) candidate = `${preferred}_${suffix++}`;
  occupied.add(candidate);
  return candidate;
}
