import { type ComparableModuleGraph, type ComparableNode, type ComparablePortIdentity } from "../compare/types.js";
import { type IrNode, type IrProgram, type IrScalarValue } from "../ir.js";

/** Normalize an imported XML program into the property-independent graph shape used by sync. */
export function normalizeIncomingProgram(program: IrProgram): ComparableModuleGraph {
  const selected =
    program.submodules.find((submodule) => submodule.name === "main") ??
    (program.submodules.length === 1 ? program.submodules[0] : undefined);
  const selectedIds = selected
    ? new Set([...selected.portNodeIds, ...selected.logicNodeIds])
    : new Set(program.nodes.filter((node) => node.layer !== "project").map((node) => node.id));
  const nodes = program.nodes.filter((node) => selectedIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const portOccurrences = new Map<string, number>();

  return {
    moduleId: selected?.name ?? "main",
    nodes: nodes.map((node) => normalizeNode(node, portOccurrences)),
    links: program.links.filter(
      (link) => nodeIds.has(link.from.nodeId) && nodeIds.has(link.to.nodeId),
    ),
  };
}

function normalizeNode(node: IrNode, portOccurrences: Map<string, number>): ComparableNode {
  const port = node.layer === "submodule" ? normalizePort(node, portOccurrences) : undefined;
  return {
    node: { ...node, position: undefined },
    port,
    attributes: { ...node.properties },
    literalInputs: extractLiteralInputs(node.properties),
  };
}

function normalizePort(
  node: IrNode,
  occurrences: Map<string, number>,
): ComparablePortIdentity | undefined {
  const rawDirection = node.properties.direction;
  const direction = rawDirection === "input" || rawDirection === "in" ? "in" : rawDirection === "output" || rawDirection === "out" ? "out" : undefined;
  const signal = node.properties.signal;
  const name = node.properties.name;
  if (!direction || typeof name !== "string" || typeof signal !== "string") {
    return undefined;
  }
  if (!isSignalKind(signal)) {
    return undefined;
  }
  const key = `${direction}:${name}`;
  const occurrence = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, occurrence);
  return { direction, name, signal, occurrence };
}

function extractLiteralInputs(properties: Record<string, IrScalarValue>): Record<string, IrScalarValue> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => key.startsWith("input:"))
      .map(([key, value]) => [key.slice("input:".length), value]),
  );
}

function isSignalKind(value: string): value is ComparablePortIdentity["signal"] {
  return ["number", "boolean", "composite", "video", "audio", "execute", "unknown"].includes(value);
}
