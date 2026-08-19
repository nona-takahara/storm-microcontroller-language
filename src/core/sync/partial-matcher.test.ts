import { describe, expect, it } from "vitest";

import { type ComparableModuleGraph, type ComparableNode } from "../compare/types.js";
import { findPartialNodeCorrespondence } from "./partial-matcher.js";

describe("findPartialNodeCorrespondence", () => {
  it("matches renamed nodes around fixed project-port anchors without using properties", () => {
    const existing = graph([
      port("old-port", "input"),
      node("old-gate", "TYPE", { value: 1 }),
    ], [{ from: "old-port", fromKey: "out", to: "old-gate", toKey: "in" }]);
    const incoming = graph([
      port("new-port", "input"),
      node("renamed", "TYPE", { value: 999 }),
      node("added", "OTHER"),
    ], [{ from: "new-port", fromKey: "out", to: "renamed", toKey: "in" }]);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id])).toEqual([
      ["old-port", "new-port"],
      ["old-gate", "renamed"],
    ]);
    expect(result.unmatchedIncoming.map((item) => item.node.id)).toEqual(["added"]);
  });

  it("does not guess a pair that differs across equally optimal symmetric mappings", () => {
    const existing = graph([node("a1", "TYPE"), node("a2", "TYPE")], []);
    const incoming = graph([node("b1", "TYPE"), node("b2", "TYPE")], []);
    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.certainPairs).toEqual([]);
    expect(result.ambiguousExisting).toHaveLength(2);
    expect(result.optimalCorrespondenceCount).toBe(2);
  });

  it("reports budget exhaustion instead of selecting a partial guess", () => {
    const existing = graph([node("a1", "TYPE"), node("a2", "TYPE")], []);
    const incoming = graph([node("b1", "TYPE"), node("b2", "TYPE")], []);
    expect(findPartialNodeCorrespondence(existing, incoming, { maxSearchSteps: 1 }).truncated).toBe(true);
  });
});

function node(id: string, definitionId: string, properties: Record<string, number> = {}): ComparableNode {
  return { node: { id, definitionId, layer: "logic", properties }, attributes: properties, literalInputs: {} };
}

function port(id: string, name: string): ComparableNode {
  return {
    node: { id, definitionId: "SUBMODULE_PORT:in:number", layer: "submodule", properties: {} },
    port: { direction: "in", name, signal: "number", occurrence: 1 },
    attributes: {}, literalInputs: {},
  };
}

function graph(
  nodes: ComparableNode[],
  links: Array<{ from: string; fromKey: string; to: string; toKey: string }>,
): ComparableModuleGraph {
  return {
    moduleId: "main",
    nodes,
    links: links.map((link, index) => ({ id: String(index), from: { nodeId: link.from, portKey: link.fromKey }, to: { nodeId: link.to, portKey: link.toKey } })),
  };
}
