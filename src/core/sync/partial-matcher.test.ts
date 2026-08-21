import { describe, expect, it } from "vitest";

import { type ComparableModuleGraph, type ComparableNode } from "../compare/types.js";
import { type IrScalarValue } from "../ir.js";
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

  it("prioritizes the matching n label to resolve otherwise-symmetric same-type nodes", () => {
    // Reproduces issue #71: three same-definitionId nodes with no distinguishing link structure,
    // laid out at adjacent positions and re-imported with different (XML-assigned) ids. Positions
    // are not part of ComparableNode identity, so the only signals available are the n label and
    // the property value; the n label must decide the correspondence.
    const existing = graph([
      node("overspeed_threshold", "PROPERTY_NUMBER", { value: 32, n: "Over Speed Th. [m/s]" }),
      node("cam_advance_current_limit_base", "PROPERTY_NUMBER", { value: 210, n: "Power Limit Current [A]" }),
      node("brake_current_limit_scale", "PROPERTY_NUMBER", { value: 290, n: "Brake Limit@320kPa [A]" }),
    ], []);
    const incoming = graph([
      node("n50", "PROPERTY_NUMBER", { value: 32, n: "Over Speed Th. [m/s]" }),
      node("n51", "PROPERTY_NUMBER", { value: 210, n: "Power Limit Current [A]" }),
      node("n52", "PROPERTY_NUMBER", { value: 290, n: "Brake Limit@320kPa [A]" }),
    ], []);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.optimalCorrespondenceCount).toBe(1);
    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(new Map([
      ["overspeed_threshold", "n50"],
      ["cam_advance_current_limit_base", "n51"],
      ["brake_current_limit_scale", "n52"],
    ]));
    expect(result.ambiguousExisting).toEqual([]);
  });

  it("still blocks when neither the n label nor the property value disambiguates", () => {
    // Companion safety test: two same-type nodes whose n labels collide and whose property values
    // also differ from each other on both sides, so no signal -- structural, label, or value --
    // picks out a unique correspondence. The engine must keep refusing to guess here.
    const existing = graph([
      node("gain_a", "PROPERTY_NUMBER", { value: 1, n: "Gain" }),
      node("gain_b", "PROPERTY_NUMBER", { value: 2, n: "Gain" }),
    ], []);
    const incoming = graph([
      node("m1", "PROPERTY_NUMBER", { value: 3, n: "Gain" }),
      node("m2", "PROPERTY_NUMBER", { value: 4, n: "Gain" }),
    ], []);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.certainPairs).toEqual([]);
    expect(result.ambiguousExisting).toHaveLength(2);
    expect(result.optimalCorrespondenceCount).toBeGreaterThan(1);
  });
});

function node(id: string, definitionId: string, properties: Record<string, IrScalarValue> = {}): ComparableNode {
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
