import { normalizeComparableModule } from "../compare/comparable-node.js";
import { flattenSwNetProject } from "../compare/project-flattener.js";
import { findExactNodeCorrespondence } from "../compare/structural-correspondence.js";
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
  // Exact structural equivalence and changed-network inference have different completion contracts.
  // The exact path preserves every endpoint/port link and uses assignment for interchangeable
  // disconnected components, so a no-op re-import never consumes the partial matcher's budget. Do
  // not replace it with compare-dsl's first-found mapping: sync needs property-preferred mappings and
  // must still inspect whether alternative mappings project different edits (issue #71 / PR #81).
  const exact = findExactNodeCorrespondence(oldGraph, newGraph);
  const partial = exact ? undefined : findPartialNodeCorrespondence(oldGraph, newGraph, options);
  const ambiguousExisting = exact?.ambiguousExisting ?? partial!.ambiguousExisting;
  const ambiguousIncoming = exact?.ambiguousIncoming ?? partial!.ambiguousIncoming;
  const partialHasAmbiguity = Boolean(partial && !partial.truncated && (ambiguousExisting.length > 0 || ambiguousIncoming.length > 0));
  const partialAmbiguityChangesOutput = partialHasAmbiguity
    ? partialCorrespondenceOutputsDiffer(incoming, oldGraph, newGraph, partial!.optimalCorrespondences)
    : false;
  const stablePartialRepresentative = partialHasAmbiguity && !partialAmbiguityChangesOutput
    ? partial!.optimalCorrespondences[0]
    : undefined;
  const correspondencePairs = exact?.pairs ?? stablePartialRepresentative ?? partial!.certainPairs;
  const matchedExistingIds = new Set(correspondencePairs.map((pair) => pair.a.node.id));
  const matchedIncomingIds = new Set(correspondencePairs.map((pair) => pair.b.node.id));
  const unmatchedExisting = exact ? [] : stablePartialRepresentative
    ? oldGraph.nodes.filter((node) => !matchedExistingIds.has(node.node.id))
    : partial!.unmatchedExisting;
  const unmatchedIncoming = exact ? [] : stablePartialRepresentative
    ? newGraph.nodes.filter((node) => !matchedIncomingIds.has(node.node.id))
    : partial!.unmatchedIncoming;
  const changes = classifyChanges(oldGraph, newGraph, correspondencePairs, unmatchedExisting, unmatchedIncoming);
  const conflicts: SynchronizationConflict[] = [];
  const warnings: SynchronizationWarning[] = [];

  const exactAmbiguityChangesOutput = exact && ambiguousExisting.length > 0
    ? correspondenceAmbiguityChangesOutput(incoming, exact.ambiguityGroups)
    : false;
  if (partial?.truncated || partialAmbiguityChangesOutput || exactAmbiguityChangesOutput) {
    conflicts.push({
      kind: "ambiguous-correspondence",
      reason: partial?.truncated
        ? `Partial correspondence search exhausted its budget after ${partial.searchSteps} steps. ${partial.certainPairs.length} matched pairs are certain; ${ambiguousExisting.length} existing and ${ambiguousIncoming.length} incoming nodes remain unresolved. Applicable changes listed in this report were not written because synchronization is atomic.`
        : exact
          ? `${exact.alternativeCount} or more exact structural correspondences project different property, layout, or Lua edits.`
          : `${partial!.optimalCorrespondenceCount} optimal partial correspondences project different source, layout, wiring, placement, or Lua outputs.`,
      impacts: [
        ...ambiguousExisting.map((node) => impactFromNode(node)),
        ...ambiguousIncoming.map((node) => ({ instanceId: node.node.id })),
      ],
      suggestions: [{
        kind: "review-candidates",
        description: "Review the listed candidates and the property, layout, and Lua content that would be projected to each existing instance.",
        impacts: ambiguousExisting.map((node) => impactFromNode(node)),
        details: {
          existingCandidates: ambiguousExisting.map((node) => node.node.id),
          incomingCandidates: ambiguousIncoming.map((node) => node.node.id),
          existingOutputs: describeExistingCandidateOutputs(existing, ambiguousExisting),
          incomingOutputs: describeIncomingCandidateOutputs(incoming, ambiguousIncoming),
        },
      }],
    });
  }

  const pairByIncomingId = new Map(correspondencePairs.map((pair) => [pair.b.node.id, pair] as const));
  const occupiedLuaNames = existing.documents.flatMap((document) => Object.keys(document.scripts)).flatMap((path) => {
    const match = /^scripts\/([^/]+)\.lua$/u.exec(path);
    return match ? [match[1]!] : [];
  });
  const placements = planAddedPlacements(oldGraph.nodes, occupiedLuaNames, newGraph, unmatchedIncoming, pairByIncomingId, conflicts);
  applyAddedPlacementRefs(changes, placements, newGraph, correspondencePairs);
  detectPortBoundaryChanges(existing, changes, conflicts);
  detectSharedModuleDivergence(oldGraph.nodes, newGraph, changes, correspondencePairs, conflicts);
  const projectedLayout = projectLayoutToExistingModules(existing, incoming, correspondencePairs, placements, warnings);

  const project = {
    ...incoming.project,
    submodule: existing.projectSource.project.submodule
      ? { ...existing.projectSource.project.submodule }
      : incoming.project.submodule,
  };
  const luaProjection = projectLuaIdentity(existing, incoming, correspondencePairs, placements);
  const lua = planLua(existing.documents, luaProjection.scripts);
  let sourceEdits: SynchronizationPlan["sourceEdits"] = [];
  let layouts: SynchronizationLayoutUpdate[] = [];

  if (conflicts.length === 0) {
    sourceEdits = buildSourceEdits(existing, luaProjection.module, newGraph, correspondencePairs, changes, placements);
    layouts = buildLayoutUpdates(existing.documents, correspondencePairs, placements, projectedLayout);
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
  const existingDisplayIds = new Map(existing.nodes.map((node) => [node.node.id, nodeRef(node).instanceId ?? node.node.id] as const));
  const incomingDisplayIds = new Map(incoming.nodes.map((node) => {
    const pair = pairs.find((candidate) => candidate.b.node.id === node.node.id);
    return [node.node.id, pair ? nodeRef(pair.a).instanceId ?? pair.a.node.id : node.node.id] as const;
  }));
  for (const node of removed) {
    changes.push({
      kind: "removed",
      existing: nodeRef(node),
      connections: { before: connectionSnapshot(existing, node.node.id, existingDisplayIds), after: [] },
    });
  }
  for (const node of added) {
    changes.push({
      kind: "added",
      incoming: nodeRef(node),
      connections: { before: [], after: connectionSnapshot(incoming, node.node.id, incomingDisplayIds) },
    });
  }
  for (const pair of pairs) {
    const propertyChanges = compareProperties(pair.a.attributes, pair.b.attributes);
    if (Object.keys(propertyChanges).length > 0) {
      changes.push({ kind: "updated", existing: nodeRef(pair.a), incoming: nodeRef(pair.b), propertyChanges });
    }
    if (incidentSignature(existing.links, pair.a.node.id, incomingIdByExistingId) !== incidentSignature(incoming.links, pair.b.node.id)) {
      changes.push({
        kind: "rewired",
        existing: nodeRef(pair.a),
        incoming: nodeRef(pair.b),
        connections: {
          before: connectionSnapshot(existing, pair.a.node.id, existingDisplayIds),
          after: connectionSnapshot(incoming, pair.b.node.id, incomingDisplayIds),
        },
      });
    }
  }
  return changes;
}

function connectionSnapshot(
  graph: ComparableModuleGraph,
  nodeId: string,
  displayIds: Map<string, string>,
): string[] {
  return graph.links.flatMap((link) => {
    if (link.from.nodeId === nodeId) {
      return [`out ${link.from.portKey} -> ${displayIds.get(link.to.nodeId) ?? link.to.nodeId}.${link.to.portKey}`];
    }
    if (link.to.nodeId === nodeId) {
      return [`in ${link.to.portKey} <- ${displayIds.get(link.from.nodeId) ?? link.from.nodeId}.${link.from.portKey}`];
    }
    return [];
  }).sort();
}

function compareProperties(
  before: Record<string, IrScalarValue>,
  after: Record<string, IrScalarValue>,
): Record<string, { before?: IrScalarValue; after?: IrScalarValue }> {
  const result: Record<string, { before?: IrScalarValue; after?: IrScalarValue }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // The importer derives this path from its temporary instance id. Matched Lua nodes retain the
    // existing sidecar identity; the path is projected separately by `projectLuaIdentity`.
    if (key === "script_ref") continue;
    if (before[key] !== after[key]) {
      result[key] = { before: before[key], after: after[key] };
    }
  }
  return result;
}

function correspondenceAmbiguityChangesOutput(
  incoming: StormworksProjectSource,
  groups: Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }>,
): boolean {
  const incomingPositions = new Map(
    incoming.entryDocument.swMcl?.instances.map((instance) => [instance.id, instance.position] as const) ?? [],
  );
  const statementById = new Map(
    selectIncomingModule(incoming).statements.map((statement) => [statement.instanceId, statement] as const),
  );
  const payload = (node: ComparableNode): string => {
    const statement = statementById.get(node.node.id);
    const scriptRef = statement?.kind === "inst" ? getScriptRef(statement) : undefined;
    return JSON.stringify({
      definitionId: node.node.definitionId,
      attributes: Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== "script_ref")),
      literalInputs: node.literalInputs,
      position: incomingPositions.get(node.node.id),
      script: scriptRef ? incoming.entryDocument.scripts[scriptRef] : undefined,
    });
  };

  // Different existing locations alone do not make the result ambiguous. If every incoming payload
  // within one independently interchangeable group is identical, each candidate location receives
  // the same source/layout/Lua content regardless of which representative isomorphism was chosen.
  return groups.some((group) => group.existing.length > 0 && new Set(group.incoming.map(payload)).size > 1);
}

function partialCorrespondenceOutputsDiffer(
  incoming: StormworksProjectSource,
  existingGraph: ComparableModuleGraph,
  incomingGraph: ComparableModuleGraph,
  correspondences: MatchedNodePair[][],
): boolean {
  const positions = new Map(
    incoming.entryDocument.swMcl?.instances.map((instance) => [instance.id, instance.position] as const) ?? [],
  );
  const statements = new Map(selectIncomingModule(incoming).statements.map((statement) => [statement.instanceId, statement] as const));
  const payload = (node: ComparableNode): object => {
    const statement = statements.get(node.node.id);
    const scriptRef = statement?.kind === "inst" ? getScriptRef(statement) : undefined;
    return {
      definitionId: node.node.definitionId,
      attributes: Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== "script_ref").sort(([a], [b]) => a.localeCompare(b))),
      literalInputs: Object.fromEntries(Object.entries(node.literalInputs).sort(([a], [b]) => a.localeCompare(b))),
      position: positions.get(node.node.id),
      script: scriptRef ? incoming.entryDocument.scripts[scriptRef] : undefined,
    };
  };
  const fingerprints = correspondences.map((pairs) => {
    const pairByExistingId = new Map(pairs.map((pair) => [pair.a.node.id, pair] as const));
    const existingIdByIncomingId = new Map(pairs.map((pair) => [pair.b.node.id, pair.a.node.id] as const));
    const matchedIncomingIds = new Set(existingIdByIncomingId.keys());
    const existingProjection = existingGraph.nodes.slice().sort((a, b) => a.node.id.localeCompare(b.node.id)).map((node) => {
      const pair = pairByExistingId.get(node.node.id);
      return pair
        ? [node.node.id, payload(pair.b), incidentSignature(incomingGraph.links, pair.b.node.id, existingIdByIncomingId)]
        : [node.node.id, "removed"];
    });
    const additions = incomingGraph.nodes.filter((node) => !matchedIncomingIds.has(node.node.id))
      .sort((a, b) => a.node.id.localeCompare(b.node.id))
      .map((node) => [node.node.id, payload(node), incidentSignature(incomingGraph.links, node.node.id, existingIdByIncomingId)]);
    return JSON.stringify({ existingProjection, additions });
  });
  return new Set(fingerprints).size > 1;
}

function describeIncomingCandidateOutputs(
  incoming: StormworksProjectSource,
  nodes: ComparableNode[],
): string[] {
  const positions = new Map(
    incoming.entryDocument.swMcl?.instances.map((instance) => [instance.id, instance.position] as const) ?? [],
  );
  const statements = new Map(selectIncomingModule(incoming).statements.map((statement) => [statement.instanceId, statement] as const));
  return nodes.map((node) => {
    const statement = statements.get(node.node.id);
    const scriptRef = statement?.kind === "inst" ? getScriptRef(statement) : undefined;
    const position = positions.get(node.node.id);
    const properties = Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== "script_ref"));
    return [
      `${node.node.id}: properties=${JSON.stringify(properties)}`,
      `position=${position ? `(${position.x}, ${position.y})` : "unchanged/absent"}`,
      `lua=${scriptRef ? `${scriptRef} (${incoming.entryDocument.scripts[scriptRef] === undefined ? "body missing" : "body present; content omitted"})` : "none"}`,
    ].join(", ");
  });
}

function describeExistingCandidateOutputs(
  existing: ResolvedStormworksProjectSource,
  nodes: ComparableNode[],
): string[] {
  const documentById = new Map(existing.documents.map((document) => [document.documentId, document] as const));
  return nodes.map((node) => {
    const ref = nodeRef(node);
    const document = ref.documentPath ? documentById.get(ref.documentPath) : undefined;
    const statement = document?.swNet.modules.find((module) => module.id === ref.moduleId)?.statements
      .find((candidate) => candidate.instanceId === ref.instanceId);
    const scriptRef = statement?.kind === "inst" ? getScriptRef(statement) : undefined;
    const position = document?.swMcl?.instances.find((instance) => instance.id === ref.instanceId)?.position;
    const properties = Object.fromEntries(Object.entries(node.attributes).filter(([key]) => key !== "script_ref"));
    return [
      `${formatNodeRefLocation(ref)}: properties=${JSON.stringify(properties)}`,
      `position=${position ? `(${position.x}, ${position.y})` : "unchanged/absent"}`,
      `lua=${scriptRef ? `${ref.documentPath ?? "?"}::${scriptRef} (${document?.scripts[scriptRef] === undefined ? "body missing" : "body present; content omitted"})` : "none"}`,
    ].join(", ");
  });
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

function applyAddedPlacementRefs(
  changes: SynchronizationChange[],
  placements: AddedPlacement[],
  incoming: ComparableModuleGraph,
  pairs: MatchedNodePair[],
): void {
  const placementByNodeId = new Map(placements.map((placement) => [placement.node.node.id, placement] as const));
  const pairByIncomingId = new Map(pairs.map((pair) => [pair.b.node.id, pair] as const));
  const displayIds = new Map(incoming.nodes.map((node) => {
    const placement = placementByNodeId.get(node.node.id);
    const pair = pairByIncomingId.get(node.node.id);
    return [node.node.id, placement?.instanceId ?? (pair ? nodeRef(pair.a).instanceId : undefined) ?? node.node.id] as const;
  }));
  for (const change of changes) {
    if (!change.incoming) continue;
    if (change.kind === "added") {
      const placement = placementByNodeId.get(change.incoming.nodeId);
      if (placement) {
        change.incoming = {
          ...change.incoming,
          documentPath: placement.documentPath,
          moduleId: placement.moduleId,
          instanceId: placement.instanceId,
          usePath: placement.usePath,
        };
      }
    }
    if (change.connections) {
      change.connections.after = connectionSnapshot(incoming, change.incoming.nodeId, displayIds);
    }
  }
}

function planAddedPlacements(
  existingNodes: ComparableNode[],
  occupiedLuaNames: string[],
  incoming: ComparableModuleGraph,
  added: ComparableNode[],
  pairByIncomingId: Map<string, MatchedNodePair>,
  conflicts: SynchronizationConflict[],
): AddedPlacement[] {
  const placements: AddedPlacement[] = [];
  const occupied = new Set([
    ...existingNodes.map((node) => node.provenance?.instanceIds.at(-1)).filter((id): id is string => Boolean(id)),
    ...occupiedLuaNames,
  ]);
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

function detectPortBoundaryChanges(
  existing: ResolvedStormworksProjectSource,
  changes: SynchronizationChange[],
  conflicts: SynchronizationConflict[],
): void {
  const ports = changes.filter((change) => (change.existing?.nodeId ?? change.incoming?.nodeId)?.startsWith("port:"));
  if (ports.length === 0) return;
  const impacts = ports.map((change) => ({ moduleId: change.existing?.moduleId, instanceId: change.existing?.instanceId ?? change.incoming?.instanceId }));
  const portDetails = ports.flatMap((change) => [change.existing, change.incoming].flatMap((ref) => ref?.port ? [
    `${ref.port.direction} ${JSON.stringify(ref.port.name)} : ${ref.port.signal} occurrence=${ref.port.occurrence} at ${formatNodeRefLocation(ref)}`,
  ] : []));
  const pinAssignments = ports.flatMap((change) => {
    const before = change.connections?.before ?? [];
    const after = change.connections?.after ?? [];
    const ref = change.existing ?? change.incoming;
    const location = ref ? formatNodeRefLocation(ref) : "unknown port";
    return [
      ...(before.length > 0 ? before.map((binding) => `${location} before: ${binding}`) : [`${location} before: unbound`]),
      ...(after.length > 0 ? after.map((binding) => `${location} after: ${binding}`) : [`${location} after: unbound`]),
    ];
  });
  const affectedModuleKeys = new Set(ports.flatMap((change) => [change.existing, change.incoming].flatMap((ref) =>
    ref?.documentPath && ref.moduleId ? [`${ref.documentPath}\0${ref.moduleId}`] : [],
  )));
  const useBindings = existing.swNet.uses.filter((use) =>
    affectedModuleKeys.has(`${use.target.documentPath}\0${use.target.moduleId}`),
  ).map((use) =>
    `${use.caller.documentPath}::${use.caller.moduleId}: ${serializeSwNetStatement(use.statement)}`,
  );
  conflicts.push({
    kind: "module-boundary",
    reason: "Project or module ports changed and require explicit module-boundary edits.",
    impacts,
    suggestions: [
      {
        kind: "add-module-port",
        description: "Add or remove the affected module port declarations.",
        impacts,
        details: { affectedPorts: portDetails },
      },
      { kind: "add-pin-assignment", description: "Update internal pin assignments for the changed ports.", impacts, details: { pinAssignments } },
      { kind: "add-use-binding", description: "Update every affected use binding.", impacts, details: { useBindings: useBindings.length > 0 ? useBindings : ["entry module surface (no enclosing use)"] } },
    ],
  });
}

function formatNodeRefLocation(ref: SynchronizationNodeRef): string {
  return [ref.documentPath, ref.moduleId, ...(ref.usePath ?? []), ref.instanceId]
    .filter((value): value is string => Boolean(value)).join("::") || ref.nodeId;
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
      const changedUses = group.filter((node) => changes.some((change) => change.existing?.nodeId === node.node.id)).map((node) => formatImpactDetail(impactFromNode(node)));
      const unchangedUses = group.filter((node) => !changes.some((change) => change.existing?.nodeId === node.node.id)).map((node) => formatImpactDetail(impactFromNode(node)));
      conflicts.push({
        kind: "shared-module-divergence",
        reason: "Different expansions of one shared module require different local changes.",
        impacts,
        suggestions: [
          {
            kind: "duplicate-module",
            description: "Duplicate the module for the use sites that diverge, then apply the local change there.",
            impacts,
            details: { changedUses, unchangedUses },
          },
          {
            kind: "update-shared-module",
            description: "Apply one common change to every use of the shared module.",
            impacts,
            details: { changedUses, unchangedUses },
          },
        ],
      });
    }
  }
}

function formatImpactDetail(impact: SynchronizationImpact): string {
  return [impact.documentPath, impact.moduleId, ...(impact.usePath ?? []), impact.instanceId]
    .filter((value): value is string => Boolean(value)).join("::") || "?";
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

interface LuaIdentityProjection {
  module: SwNetModule;
  scripts: Array<{ documentPath: string; path: string; text: string }>;
}

function projectLuaIdentity(
  existing: ResolvedStormworksProjectSource,
  incoming: StormworksProjectSource,
  pairs: MatchedNodePair[],
  placements: AddedPlacement[],
): LuaIdentityProjection {
  const incomingModule = selectIncomingModule(incoming);
  const targetByIncomingId = new Map<string, { documentPath: string; path: string }>();
  const targetsByIncomingPath = new Map<string, Map<string, { documentPath: string; path: string }>>();
  const existingDocumentByPath = new Map(existing.documents.map((document) => [document.documentId, document] as const));
  const incomingStatementById = new Map(incomingModule.statements.map((statement) => [statement.instanceId, statement] as const));

  for (const pair of pairs) {
    const incomingStatement = incomingStatementById.get(pair.b.node.id);
    const incomingPath = incomingStatement?.kind === "inst" ? getScriptRef(incomingStatement) : undefined;
    const provenance = pair.a.provenance;
    const documentPath = pair.a.node.source?.path;
    if (!incomingPath || !provenance || !documentPath) continue;
    const existingStatement = existingDocumentByPath.get(documentPath)?.swNet.modules
      .find((module) => module.id === provenance.moduleId)?.statements
      .find((statement) => statement.instanceId === provenance.instanceIds.at(-1));
    const existingPath = existingStatement?.kind === "inst" ? getScriptRef(existingStatement) : undefined;
    if (existingPath) {
      const target = { documentPath, path: existingPath };
      targetByIncomingId.set(pair.b.node.id, target);
      const targets = targetsByIncomingPath.get(incomingPath) ?? new Map<string, typeof target>();
      targets.set(`${documentPath}\0${existingPath}`, target);
      targetsByIncomingPath.set(incomingPath, targets);
    }
  }
  for (const placement of placements) {
    const statement = incomingStatementById.get(placement.node.node.id);
    const incomingPath = statement?.kind === "inst" ? getScriptRef(statement) : undefined;
    if (incomingPath) {
      const target = { documentPath: placement.documentPath, path: `scripts/${placement.instanceId}.lua` };
      targetByIncomingId.set(placement.node.node.id, target);
      const targets = targetsByIncomingPath.get(incomingPath) ?? new Map<string, typeof target>();
      targets.set(`${target.documentPath}\0${target.path}`, target);
      targetsByIncomingPath.set(incomingPath, targets);
    }
  }

  const rewriteAttributes = (statement: SwNetStatement): SwNetStatement => {
    if (statement.kind !== "inst") return statement;
    const target = targetByIncomingId.get(statement.instanceId);
    return {
      ...statement,
      attributes: statement.attributes.map((attribute) =>
        target && attribute.key === "script_ref" && attribute.value.kind === "string"
          ? { ...attribute, value: { ...attribute.value, value: target.path } }
          : attribute,
      ),
    };
  };
  const module: SwNetModule = {
    ...incomingModule,
    statements: incomingModule.statements.map(rewriteAttributes),
  };
  const scripts = new Map<string, { documentPath: string; path: string; text: string }>();
  for (const [path, text] of Object.entries(incoming.entryDocument.scripts)) {
    const targets = targetsByIncomingPath.get(path);
    if (targets && targets.size > 0) {
      for (const target of targets.values()) scripts.set(`${target.documentPath}\0${target.path}`, { ...target, text });
    } else {
      const documentPath = incoming.entryDocument.documentId;
      scripts.set(`${documentPath}\0${path}`, { documentPath, path, text });
    }
  }
  return { module, scripts: [...scripts.values()] };
}

function getScriptRef(statement: Extract<SwNetStatement, { kind: "inst" }>): string | undefined {
  const value = statement.attributes.find((attribute) => attribute.key === "script_ref")?.value;
  return value?.kind === "string" ? value.value : undefined;
}

function planLua(
  documents: StormworksSourceDocument[],
  incomingScripts: Array<{ documentPath: string; path: string; text: string }>,
): SynchronizationPlan["lua"] {
  const existingScripts = new Map(documents.flatMap((document) => Object.entries(document.scripts).map(([path, text]) => [
    `${document.documentId}\0${path}`,
    { documentPath: document.documentId, path, text },
  ] as const)));
  const incomingByKey = new Map(incomingScripts.map((script) => [`${script.documentPath}\0${script.path}`, script] as const));
  const create = incomingScripts.filter((script) => !existingScripts.has(`${script.documentPath}\0${script.path}`));
  const update = incomingScripts.filter((script) => {
    const existing = existingScripts.get(`${script.documentPath}\0${script.path}`);
    return existing !== undefined && existing.text !== script.text;
  });
  const remove = [...existingScripts].filter(([key]) => !incomingByKey.has(key)).map(([, script]) => ({
    documentPath: script.documentPath,
    path: script.path,
  })).sort((left, right) => left.documentPath.localeCompare(right.documentPath) || left.path.localeCompare(right.path));
  return { create, update, remove };
}

function nodeRef(node: ComparableNode): SynchronizationNodeRef {
  return {
    nodeId: node.node.id,
    definitionId: node.node.definitionId,
    documentPath: node.node.source?.path,
    moduleId: node.provenance?.moduleId,
    instanceId: node.provenance?.instanceIds.at(-1) ?? node.node.id,
    usePath: node.provenance?.instanceIds.slice(0, -1),
    port: node.port ? { ...node.port } : undefined,
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
