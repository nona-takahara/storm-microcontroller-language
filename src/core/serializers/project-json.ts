// Project-surface serializer that writes external pins, submodule references, and surface constants to JSON.
import { compareSwNetIdentifier, tryParseSwNetTrailingNumber } from "./sw-net-shared.js";
import { type IrLink, type IrNode, type IrProgram, type IrScalarValue, type IrSubmodule, type IrVector2 } from "../ir.js";

export const STORMWORKS_PROJECT_JSON_FORMAT_VERSION = "stormworks-project-json-v10";

export interface ProjectJsonNodeDocument {
  id: string;
  type: string;
  label: string | null;
  description: string | null;
  // nodePosition is the Stormworks vehicle-space position of the external pin.
  nodePosition: IrVector2;
}

export interface ProjectJsonConstantDocument {
  id: string;
  value: IrScalarValue;
  position: IrVector2 | null;
}

export interface ProjectJsonSubmoduleDocument {
  id: string;
  name: string;
  // relativePath points at the sw-net document that defines this submodule.
  relativePath: string;
  // Auto-generated submodules currently start at the origin and let sw-mcl own the inner layout.
  position: IrVector2 | null;
}

export interface ProjectJsonLinkEndpoint {
  kind: "node" | "submodule_port" | "constant";
  id?: string;
  submodule?: string;
  port?: string;
}

export interface ProjectJsonLinkDocument {
  from: ProjectJsonLinkEndpoint;
  to: ProjectJsonLinkEndpoint;
}

export interface ProjectJsonDocument {
  formatVersion: typeof STORMWORKS_PROJECT_JSON_FORMAT_VERSION;
  sourceName?: string;
  name: string | null;
  description: string | null;
  width: number | null;
  length: number | null;
  nodes: ProjectJsonNodeDocument[];
  constants: ProjectJsonConstantDocument[];
  submodules: ProjectJsonSubmoduleDocument[];
  links: ProjectJsonLinkDocument[];
  warnings: string[];
}

// Build the project-surface document that pairs with sw-net and sw-mcl.
export function buildProjectJsonDocument(program: IrProgram): ProjectJsonDocument {
  // project.json only describes the project surface.
  // Internal logic and its layout are serialized separately into sw-net and sw-mcl.
  const nodeById = new Map(program.nodes.map((node) => [node.id, node] as const));
  const submodulePortIndex = buildSubmodulePortIndex(program.submodules, nodeById);
  const projectNodes = program.nodes.filter((node) => node.layer === "project").sort(compareById);
  const projectNodeIdByIrId = buildProjectNodeIdMap(projectNodes);
  const projectLinks = program.links.filter((link) => isProjectSerializableLink(nodeById, link)).sort(compareById);
  const constantNodes = collectLinkedConstantNodes(projectLinks, nodeById);
  const constantIdByIrId = buildConstantIdMap(constantNodes);

  // Keep only the project-visible slice of the IR so project.json stays small and editor-friendly.
  return {
    formatVersion: STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
    sourceName: program.metadata.sourceName,
    name: asNullableString(program.metadata.microprocessor?.name),
    description: asNullableString(program.metadata.microprocessor?.description),
    width: asNullableNumber(program.metadata.microprocessor?.width),
    length: asNullableNumber(program.metadata.microprocessor?.length),
    nodes: projectNodes.map((node) => ({
      id: projectNodeIdByIrId.get(node.id) ?? node.id,
      type: node.definitionId,
      label: asNullableString(node.properties.label),
      description: asNullableString(node.properties.description),
      nodePosition: node.position ?? { x: 0, y: 0 },
    })),
    constants: constantNodes.map((node) => ({
      id: constantIdByIrId.get(node.id) ?? node.id,
      value: resolveConstValue(node.properties),
      position: node.position ?? null,
    })),
    submodules: program.submodules
      .slice()
      .sort(compareById)
      .map((submodule) => ({
        id: submodule.name,
        name: submodule.name,
        relativePath: `${submodule.name}.sw-net`,
        position: { x: 0, y: 0 },
      })),
    links: projectLinks.map((link) => ({
      from: formatProjectLinkEndpoint(link.from.nodeId, nodeById, projectNodeIdByIrId, constantIdByIrId, submodulePortIndex),
      to: formatProjectLinkEndpoint(link.to.nodeId, nodeById, projectNodeIdByIrId, constantIdByIrId, submodulePortIndex),
    })),
    warnings: program.metadata.warnings.map((warning) => warning.message),
  };
}

// Serialize the project-surface document to human-editable JSON text.
export function serializeProjectJson(program: IrProgram): string {
  return JSON.stringify(buildProjectJsonDocument(program), null, 2);
}

// Prefer readable project-node ids and suffix duplicates deterministically.
function buildProjectNodeIdMap(nodes: IrNode[]): Map<string, string> {
  const counts = new Map<string, number>();
  const idMap = new Map<string, string>();

  for (const node of nodes) {
    const baseId = chooseProjectNodeId(node);
    const nextCount = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, nextCount);
    idMap.set(node.id, nextCount === 1 ? baseId : `${baseId}_${nextCount}`);
  }

  return idMap;
}

// Give project-surface constant nodes stable exported ids.
function buildConstantIdMap(nodes: IrNode[]): Map<string, string> {
  const idMap = new Map<string, string>();

  for (const node of nodes) {
    const rawObjectId = node.objectId;
    const trailingId = rawObjectId ?? tryParseSwNetTrailingNumber(node.id)?.toString() ?? node.id;
    idMap.set(node.id, `const_${trailingId}`);
  }

  return idMap;
}

// Collect constants that actually appear on the project surface so the JSON stays compact.
function collectLinkedConstantNodes(links: IrLink[], nodeById: Map<string, IrNode>): IrNode[] {
  const constantNodes = new Map<string, IrNode>();

  for (const link of links) {
    for (const nodeId of [link.from.nodeId, link.to.nodeId]) {
      const node = nodeById.get(nodeId);

      if (node?.definitionId === "CONST") {
        constantNodes.set(node.id, node);
      }
    }
  }

  return [...constantNodes.values()].sort(compareById);
}

// Choose a human-readable project-node id from name/label before falling back to numeric suffixes.
function chooseProjectNodeId(node: IrNode): string {
  const preferred =
    (typeof node.properties.name === "string" && node.properties.name.length > 0
      ? node.properties.name
      : undefined) ??
    (typeof node.properties.label === "string" && node.properties.label.length > 0
      ? node.properties.label
      : undefined);

  if (preferred) {
    return preferred;
  }

  const trailingId = tryParseSwNetTrailingNumber(node.id);
  return trailingId !== undefined ? `node_${trailingId}` : node.id;
}

// Lower an IR endpoint into the project-surface endpoint vocabulary used by project.json.
function formatProjectLinkEndpoint(
  nodeId: string,
  nodeById: Map<string, IrNode>,
  projectNodeIdByIrId: Map<string, string>,
  constantIdByIrId: Map<string, string>,
  submodulePortIndex: Map<string, { submodule: string; port: string }>,
): ProjectJsonLinkEndpoint {
  const node = nodeById.get(nodeId);

  // Endpoints are lowered into the small project vocabulary instead of leaking raw IR ids everywhere.
  if (!node) {
    return { kind: "node", id: nodeId };
  }

  if (node.layer === "project") {
    return {
      kind: "node",
      id: projectNodeIdByIrId.get(node.id) ?? node.id,
    };
  }

  if (node.layer === "submodule") {
    const portRef = submodulePortIndex.get(node.id);

    return {
      kind: "submodule_port",
      submodule: portRef?.submodule ?? "main",
      port: portRef?.port ?? String(node.properties.name ?? node.id),
    };
  }

  if (node.definitionId === "CONST") {
    return {
      kind: "constant",
      id: constantIdByIrId.get(node.id) ?? node.id,
    };
  }

  return {
    kind: "node",
    id: node.id,
  };
}

// Build a lookup from submodule port node ids to exported submodule/port references.
function buildSubmodulePortIndex(
  submodules: IrSubmodule[],
  nodeById: Map<string, IrNode>,
): Map<string, { submodule: string; port: string }> {
  const index = new Map<string, { submodule: string; port: string }>();

  for (const submodule of submodules) {
    for (const portNodeId of submodule.portNodeIds) {
      const portNode = nodeById.get(portNodeId);

      if (!portNode) {
        continue;
      }

      index.set(portNodeId, {
        submodule: submodule.name,
        port: String(portNode.properties.name ?? portNode.properties.label ?? portNode.id),
      });
    }
  }

  return index;
}

// Keep only links that belong on the project surface rather than inside sw-net.
function isProjectSerializableLink(nodeById: Map<string, IrNode>, link: IrLink): boolean {
  const fromNode = nodeById.get(link.from.nodeId);
  const toNode = nodeById.get(link.to.nodeId);

  return isProjectSerializableNode(fromNode) && isProjectSerializableNode(toNode);
}

// Project JSON only knows about project pins, submodule ports, and explicit surface constants.
function isProjectSerializableNode(node: IrNode | undefined): boolean {
  if (!node) {
    return false;
  }

  return node.layer === "project" || node.layer === "submodule" || node.definitionId === "CONST";
}

// Prefer the canonical DSL-facing constant value while still tolerating raw imported property names.
function resolveConstValue(properties: IrNode["properties"]): IrScalarValue {
  const textValue = properties.text;

  if (typeof textValue === "string") {
    // Numeric-looking CONST text values are projected as numbers so project editors can treat them naturally.
    const parsed = Number(textValue);

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return textValue;
  }

  return properties.value ?? null;
}

// Normalize optional scalar values into nullable JSON strings.
function asNullableString(value: IrScalarValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

// Normalize optional numbers into nullable JSON numbers.
function asNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Sort id-bearing records by their exported identifier.
function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareIdentifier(left.id, right.id);
}

// Compare identifiers using the shared natural ordering helper.
function compareIdentifier(left: string, right: string): number {
  return compareSwNetIdentifier(left, right);
}
