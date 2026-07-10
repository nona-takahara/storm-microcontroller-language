// sw-net serializer that flattens one IR submodule into a human-readable netlist-style DSL.
import { type NodeDefinitionRegistry } from "../definitions/loader.js";
import { type ComponentDefinition } from "../definitions/schema.js";
import { type IrLink, type IrNode, type IrProgram, type IrScalarValue, type IrSubmodule } from "../ir.js";
import {
  compareSwNetIdentifier,
  getSwNetInstanceName,
  getSwNetInstanceTypeName,
  IDENTIFIER_PATTERN,
  sanitizeSwNetIdentifier,
} from "./sw-net-shared.js";

export const STORMWORKS_SW_NET_FILE_EXTENSION = ".sw-net";

export interface SwNetSerializationOptions {
  definitions: NodeDefinitionRegistry;
  formatVersion?: string;
}

export interface SwNetSerializationManifest {
  formatVersion: string;
  fileExtension: typeof STORMWORKS_SW_NET_FILE_EXTENSION;
  nodeCount: number;
  linkCount: number;
}

export interface SwNetSerializationArtifact {
  bytes: Uint8Array;
  manifest: SwNetSerializationManifest;
}

export interface SwNetSerializer {
  serialize(program: IrProgram, options: SwNetSerializationOptions): SwNetSerializationArtifact;
}

export interface SwNetRenderOptions {
  formatVersion?: string;
  definitions?: NodeDefinitionRegistry;
}

// Default serializer for the current flattened sw-net text format.
export class StormworksSwNetSerializer implements SwNetSerializer {
  // Serialize an IR program into bytes plus a small manifest for file-oriented callers.
  serialize(program: IrProgram, options: SwNetSerializationOptions): SwNetSerializationArtifact {
    const formatVersion = options.formatVersion ?? "stormworks-sw-net-v1";
    const text = renderStormworksSwNet(program, {
      formatVersion,
      definitions: options.definitions,
    });

    return {
      bytes: new TextEncoder().encode(text),
      manifest: {
        formatVersion,
        fileExtension: STORMWORKS_SW_NET_FILE_EXTENSION,
        nodeCount: program.nodes.length,
        linkCount: program.links.length,
      },
    };
  }
}

// Serialize an IR program into sw-net bytes plus a small manifest for callers.
export function serializeStormworksSwNet(
  program: IrProgram,
  options: SwNetSerializationOptions,
): SwNetSerializationArtifact {
  return new StormworksSwNetSerializer().serialize(program, options);
}

// Render an IR program into the human-readable sw-net DSL text.
export function renderStormworksSwNet(
  program: IrProgram,
  options: SwNetRenderOptions = {},
): string {
  // sw-net is emitted as a flattened module-local netlist.
  // Project wiring stays in project.json, while module-internal layout stays in sw-mcl.
  const nodeById = new Map(program.nodes.map((node) => [node.id, node] as const));
  const componentById = new Map(
    (options.definitions?.components ?? []).map((definition) => [definition.id, definition] as const),
  );
  const submodules = [...program.submodules].sort(compareById);

  // Old or partial IRs may not expose submodules yet, so fall back to a synthetic main module.
  if (submodules.length === 0) {
    return renderModule(
      {
        id: "submodule:main",
        name: "main",
        portNodeIds: [],
        logicNodeIds: program.nodes.filter((node) => node.layer === "logic").map((node) => node.id),
      },
      program,
      nodeById,
      componentById,
    );
  }

  return submodules
    .map((submodule) => renderModule(submodule, program, nodeById, componentById))
    .join("\n\n");
}

// Render one IR submodule as a flat sw-net module declaration.
function renderModule(
  submodule: IrSubmodule,
  program: IrProgram,
  nodeById: Map<string, IrNode>,
  componentById: Map<string, ComponentDefinition>,
): string {
  const lines: string[] = [];
  const submoduleNodeIds = new Set([...submodule.portNodeIds, ...submodule.logicNodeIds]);

  // Only links fully contained in this submodule are emitted; project wiring lives in project.json.
  const internalLinks = program.links
    .filter((link) => belongsToSubmodule(link, submoduleNodeIds))
    .sort(compareById);
  const linksBySourceNodeId = groupLinksBy(internalLinks, (link) => link.from.nodeId);
  const linksByTargetNodeId = groupLinksBy(internalLinks, (link) => link.to.nodeId);
  const portNodes = submodule.portNodeIds
    .map((id) => nodeById.get(id))
    .filter((node): node is IrNode => node !== undefined);
  const logicNodes = submodule.logicNodeIds
    .map((id) => nodeById.get(id))
    .filter((node): node is IrNode => node !== undefined);

  lines.push(`module ${formatBareIdentifier(submodule.name)}`);

  for (const portNode of portNodes) {
    lines.push(`  ${renderModulePort(portNode)}`);
  }

  if (portNodes.length > 0 && logicNodes.length > 0) {
    lines.push("");
  }

  for (const logicNode of logicNodes) {
    lines.push(
      `  ${renderInstance(logicNode, linksByTargetNodeId, linksBySourceNodeId, nodeById, componentById)}`,
    );
  }

  lines.push("end");

  return lines.join("\n");
}

// Render a project-facing boundary node as a sw-net port declaration.
function renderModulePort(node: IrNode): string {
  const direction = String(node.properties.direction ?? "unknown") === "input" ? "in" : "out";
  const signal = String(node.properties.signal ?? "unknown");
  const name = formatQuotedReference(String(node.properties.name ?? node.properties.label ?? node.id));

  return `port ${direction} ${name} : ${signal}`;
}

// Render a logic node as one inst line with attributes and folded wiring assignments.
function renderInstance(
  node: IrNode,
  linksByTargetNodeId: Map<string, IrLink[]>,
  linksBySourceNodeId: Map<string, IrLink[]>,
  nodeById: Map<string, IrNode>,
  componentById: Map<string, ComponentDefinition>,
): string {
  // Links are folded into the inst line so the DSL stays SPICE-like and easy to eyeball.
  const definition = componentById.get(node.definitionId);
  const typeName = getSwNetInstanceTypeName(node);
  const instanceName = getSwNetInstanceName(node);
  const attributeAssignments = collectAttributeAssignments(node, instanceName, definition);
  const inputAssignments = collectInputAssignments(
    linksByTargetNodeId.get(node.id) ?? [],
    nodeById,
  );
  const outputAssignments = collectOutputAssignments(
    instanceName,
    definition,
    linksBySourceNodeId.get(node.id) ?? [],
    nodeById,
  );
  const attributesText =
    attributeAssignments.length > 0 ? ` (${attributeAssignments.join(", ")})` : "";
  const inputText = inputAssignments.join(", ");
  const rightHandSide = outputAssignments.join(", ");
  const arrowClause = rightHandSide.length > 0 ? `-> ${rightHandSide}` : "->";
  const pinClause = inputText.length > 0 ? `: ${inputText} ${arrowClause}` : `: ${arrowClause}`;

  return `inst ${typeName} ${instanceName}${attributesText} ${pinClause}`;
}

// Project node properties into DSL attributes, respecting definition-level rename and hide rules.
function collectAttributeAssignments(
  node: IrNode,
  instanceName: string,
  definition: ComponentDefinition | undefined,
): string[] {
  const hiddenKeys = new Set(["objectId", "stormworksType", "layer", "script"]);
  const assignments: string[] = [];
  const emittedDslKeys = new Set<string>();
  const definedPropertyKeys = new Set((definition?.properties ?? []).map((property) => property.key));

  // LUA bodies are stored as sidecar files, so the DSL keeps only a script_ref attribute here.
  if (node.definitionId === "LUA") {
    assignments.push(`script_ref=${formatDslScalar(`scripts/${instanceName}.lua`)}`);
    emittedDslKeys.add("script_ref");
  }

  for (const propertyDefinition of definition?.properties ?? []) {
    if (propertyDefinition.key === "script" || hiddenKeys.has(propertyDefinition.key)) {
      continue;
    }

    if (propertyDefinition.dsl?.emit === false) {
      continue;
    }

    const dslKey = propertyDefinition.dsl?.key ?? propertyDefinition.key;

    if (emittedDslKeys.has(dslKey)) {
      continue;
    }

    const rawValue = node.properties[propertyDefinition.key];
    const dslValue = coerceDslScalarValue(
      rawValue,
      propertyDefinition.dsl?.valueType ?? propertyDefinition.valueType,
    );

    if (dslValue === undefined) {
      continue;
    }

    assignments.push(`${dslKey}=${formatDslScalar(dslValue)}`);
    emittedDslKeys.add(dslKey);
  }

  const extraKeys = Object.keys(node.properties)
    .filter((key) => !hiddenKeys.has(key) && !definedPropertyKeys.has(key))
    .sort(compareIdentifier);

  // Unknown but scalar properties are still surfaced so generic nodes do not silently lose information.
  for (const key of extraKeys) {
    if (emittedDslKeys.has(key)) {
      continue;
    }

    const value = node.properties[key];

    if (value === undefined) {
      continue;
    }

    assignments.push(`${key}=${formatDslScalar(value)}`);
    emittedDslKeys.add(key);
  }

  return assignments;
}

// Render incoming links as left-hand-side pin assignments.
function collectInputAssignments(
  incomingLinks: IrLink[],
  nodeById: Map<string, IrNode>,
): string[] {
  return [...incomingLinks]
    .sort(compareInputLinks)
    .map((link) => `${link.to.portKey}=${resolveIncomingReference(link, nodeById)}`);
}

// Render outgoing links as right-hand-side pin assignments, inferring named outputs when possible.
function collectOutputAssignments(
  instanceName: string,
  definition: ComponentDefinition | undefined,
  outgoingLinks: IrLink[],
  nodeById: Map<string, IrNode>,
): string[] {
  const assignments: string[] = [];
  const outgoingLinksByPort = groupLinksBy(outgoingLinks, (link) => link.from.portKey);
  const outputPortKeys = resolveOutputPortKeys(definition, outgoingLinksByPort);

  for (const outputPortKey of outputPortKeys) {
    const linksForPort = outgoingLinksByPort.get(outputPortKey) ?? [];
    const modulePortReferences = new Set<string>();
    let needsInternalNet = linksForPort.length === 0;

    // One output can feed both internal nets and module outputs, so emit both when needed.
    for (const link of linksForPort) {
      const targetNode = nodeById.get(link.to.nodeId);

      if (targetNode?.layer === "logic") {
        needsInternalNet = true;
        continue;
      }

      if (targetNode?.layer === "submodule") {
        modulePortReferences.add(formatQuotedReference(String(targetNode.properties.name ?? targetNode.id)));
      }
    }

    if (needsInternalNet) {
      assignments.push(`${outputPortKey}=${createInternalNetName(instanceName, outputPortKey)}`);
    }

    for (const modulePortReference of [...modulePortReferences].sort(compareIdentifier)) {
      assignments.push(`${outputPortKey}=${modulePortReference}`);
    }
  }

  return assignments;
}

// Resolve which output keys this node should expose in DSL form.
function resolveOutputPortKeys(
  definition: ComponentDefinition | undefined,
  outgoingLinksByPort: Map<string, IrLink[]>,
): string[] {
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const linkedKeys = new Set(outgoingLinksByPort.keys());

  // Prefer outputs that are actually used in links, then fall back to a single declared output when appropriate.
  if (linkedKeys.size > 0) {
    for (const port of definition?.ports.outputs ?? []) {
      if (linkedKeys.has(port.key) && !seenKeys.has(port.key)) {
        keys.push(port.key);
        seenKeys.add(port.key);
      }
    }

    for (const key of [...linkedKeys].sort(compareIdentifier)) {
      if (!seenKeys.has(key)) {
        keys.push(key);
        seenKeys.add(key);
      }
    }

    return keys;
  }

  if ((definition?.ports.outputs.length ?? 0) === 1) {
    const singleOutputKey = definition?.ports.outputs[0]?.key;

    if (singleOutputKey) {
      return [singleOutputKey];
    }
  }

  return keys;
}

// Convert an incoming link source into either a quoted module-port reference or an internal net name.
function resolveIncomingReference(link: IrLink, nodeById: Map<string, IrNode>): string {
  const sourceNode = nodeById.get(link.from.nodeId);

  if (!sourceNode) {
    return createInternalNetName(`n_${sanitizeSwNetIdentifier(link.from.nodeId)}`, link.from.portKey);
  }

  if (sourceNode.layer === "submodule") {
    return formatQuotedReference(String(sourceNode.properties.name ?? sourceNode.id));
  }

  return createInternalNetName(getSwNetInstanceName(sourceNode), link.from.portKey);
}

// Create the canonical internal net name for one instance output.
function createInternalNetName(instanceName: string, portKey: string): string {
  return `${instanceName}_${sanitizeSwNetIdentifier(portKey)}`;
}

// Keep generated identifiers valid and stable even when source names contain spaces.
function formatBareIdentifier(value: string): string {
  return IDENTIFIER_PATTERN.test(value) ? value : sanitizeSwNetIdentifier(value, "module");
}

// Keep user-facing module-port names verbatim by always quoting them in DSL.
function formatQuotedReference(value: string): string {
  return JSON.stringify(value);
}

// Format a scalar value using DSL literals rather than XML-specific spellings.
function formatDslScalar(value: IrScalarValue | undefined): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  return value ? "true" : "false";
}

// Coerce imported scalar values into the DSL type expected by a property definition.
function coerceDslScalarValue(
  value: IrScalarValue | undefined,
  valueType: "boolean" | "number" | "string",
): IrScalarValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  // Property definitions decide the DSL-side scalar type even when import preserved the raw XML value loosely.
  if (value === null) {
    return null;
  }

  if (valueType === "string") {
    return typeof value === "string" ? value : String(value);
  }

  if (valueType === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true" || value === "1") {
      return true;
    }

    if (value === "false" || value === "0") {
      return false;
    }
  }

  return undefined;
}

// Check whether a link is fully contained within one rendered submodule body.
function belongsToSubmodule(link: IrLink, submoduleNodeIds: Set<string>): boolean {
  return submoduleNodeIds.has(link.from.nodeId) && submoduleNodeIds.has(link.to.nodeId);
}

// Group links by one endpoint so per-node rendering can stay simple.
function groupLinksBy(
  links: IrLink[],
  selectKey: (link: IrLink) => string,
): Map<string, IrLink[]> {
  const grouped = new Map<string, IrLink[]>();

  for (const link of links) {
    // Grouping once keeps per-node rendering simple and avoids repeated scans over the full link set.
    const key = selectKey(link);
    const existing = grouped.get(key);

    if (existing) {
      existing.push(link);
      continue;
    }

    grouped.set(key, [link]);
  }

  return grouped;
}

const FUNCTION_PORT_KEY_ORDER: readonly string[] = ["x", "y", "z", "w", "a", "b", "c", "d"];

function compareFunctionPortKey(left: string, right: string): number {
  const leftIndex = FUNCTION_PORT_KEY_ORDER.indexOf(left);
  const rightIndex = FUNCTION_PORT_KEY_ORDER.indexOf(right);

  if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
  if (leftIndex !== -1) return -1;
  if (rightIndex !== -1) return 1;

  return compareIdentifier(left, right);
}

// Keep multi-input rendering stable by sorting links by target port and source id.
function compareInputLinks(left: IrLink, right: IrLink): number {
  const portComparison = compareFunctionPortKey(left.to.portKey, right.to.portKey);

  if (portComparison !== 0) {
    return portComparison;
  }

  const sourceNodeComparison = compareIdentifier(left.from.nodeId, right.from.nodeId);

  if (sourceNodeComparison !== 0) {
    return sourceNodeComparison;
  }

  return compareIdentifier(left.from.portKey, right.from.portKey);
}

// Sort id-bearing records with the shared sw-net identifier order.
function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareIdentifier(left.id, right.id);
}

// Compare identifiers using the shared natural ordering helper.
function compareIdentifier(left: string, right: string): number {
  return compareSwNetIdentifier(left, right);
}
