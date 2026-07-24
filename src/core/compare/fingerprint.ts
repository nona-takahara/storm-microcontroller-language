import { type ComparableModuleGraph, type ComparableNode } from "./types.js";

export function comparableNodeKind(node: ComparableNode): string {
  if (node.port) {
    const { direction, name, occurrence, signal } = node.port;
    return `port:${direction}:${JSON.stringify(name)}:${signal}:${occurrence}`;
  }

  return `node:${node.node.layer}:${node.node.definitionId}`;
}

export function countNodeKinds(graph: ComparableModuleGraph): Map<string, number> {
  const counts = new Map<string, number>();

  for (const node of graph.nodes) {
    const kind = comparableNodeKind(node);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return counts;
}

export function compareNodeKindCounts(
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
): { kind: string; countA: number; countB: number }[] {
  const countsA = countNodeKinds(a);
  const countsB = countNodeKinds(b);
  const kinds = [...new Set([...countsA.keys(), ...countsB.keys()])].sort();

  return kinds.flatMap((kind) => {
    const countA = countsA.get(kind) ?? 0;
    const countB = countsB.get(kind) ?? 0;
    return countA === countB ? [] : [{ kind, countA, countB }];
  });
}
