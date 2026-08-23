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

  it("resolves many independent unlabeled twin pairs via property-value scoring within a tight step budget", () => {
    // Regression guard for a second blowup source found while validating the chain-forcing fix
    // above against real projects: once a full match is reached, `visit`'s unconditional "leave
    // this node unmatched" branch keeps exploring every subset of every remaining assignment even
    // though none of it can ever beat the match already found. Ten independent pairs of nodes that
    // share a definitionId only within their own pair (so each has exactly its twin as the sole
    // structural alternative, resolvable only by the softer property-value score, never forced by
    // `propagateCertainPairs`) reproduce that: without pruning the subset branches this explores
    // millions of leaves and exhausts the budget; with it, only the ~2^10 real twin-swap
    // alternatives remain to check.
    const pairCount = 10;
    const existingNodes = Array.from({ length: pairCount }, (_, i) => [
      node(`existing-${i}-a`, `TWIN_${i}`, { value: i * 10 + 1 }),
      node(`existing-${i}-b`, `TWIN_${i}`, { value: i * 10 + 2 }),
    ]).flat();
    const incomingNodes = Array.from({ length: pairCount }, (_, i) => [
      node(`incoming-${i}-b`, `TWIN_${i}`, { value: i * 10 + 2 }),
      node(`incoming-${i}-a`, `TWIN_${i}`, { value: i * 10 + 1 }),
    ]).flat();

    const existing = graph(existingNodes, []);
    const incoming = graph(incomingNodes, []);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.truncated).toBe(false);
    expect(result.ambiguousExisting).toEqual([]);
    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(
      new Map(
        Array.from({ length: pairCount }, (_, i) => [
          [`existing-${i}-a`, `incoming-${i}-a`],
          [`existing-${i}-b`, `incoming-${i}-b`],
        ]).flat() as [string, string][],
      ),
    );
    expect(result.searchSteps).toBeLessThan(10_000);
  });

  it("resolves a fully symmetric 8-node same-type cluster via property-value scoring alone", () => {
    // Reproduces the shape a real project (NITS_Simple_Bridge) hit after both fixes above: 8 nodes
    // sharing one definitionId, no links to each other or to any forced neighbor, and no `n` label --
    // so `propagateCertainPairs` cannot force any of them, and every one of the 8 is a structurally
    // valid candidate for every other. The unique correct answer exists (each node's `value` matches
    // exactly one counterpart) but confirming it is unique requires enumerating on the order of 8!
    // full assignments, which exceeded the previous, smaller step budget even with skip branches
    // pruned (see the DEFAULT_PARTIAL_SEARCH_STEPS comment).
    const size = 8;
    const existingNodes = Array.from({ length: size }, (_, i) => node(`existing-${i}`, "TYPE", { value: i }));
    const incomingNodes = Array.from({ length: size }, (_, i) => node(`incoming-${i}`, "TYPE", { value: i })).reverse();

    const result = findPartialNodeCorrespondence(graph(existingNodes, []), graph(incomingNodes, []));

    expect(result.truncated).toBe(false);
    expect(result.ambiguousExisting).toEqual([]);
    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(
      new Map(Array.from({ length: size }, (_, i) => [`existing-${i}`, `incoming-${i}`])),
    );
  });

  it("resolves a long chain of unlabeled same-type nodes anchored by one port within a tight step budget", () => {
    // Regression guard for the blowup PR #72 introduced (issue #71 follow-up): once sync stopped
    // reusing compare-dsl's full-match shortcut, every node the link-blind forcing rules could not
    // resolve fell to this matcher's exhaustive fallback -- and a long chain of same-kind, unlabeled
    // nodes is exactly the shape real circuits are full of, so real no-op re-imports were hitting the
    // step budget and getting blocked. `mappedIncidentSignature`/`incidentSignatureAmongForced` let
    // forcing cascade outward from the port anchor one link at a time instead, so this chain must
    // resolve fully well under budget.
    const length = 60;
    const existingChainIds = Array.from({ length }, (_, i) => `existing-${i}`);
    const incomingChainIds = Array.from({ length }, (_, i) => `incoming-${i}`);
    const chainLinks = (ids: string[]) =>
      ids.slice(0, -1).map((id, i) => ({ from: id, fromKey: "out", to: ids[i + 1]!, toKey: "in" }));

    const existing = graph(
      [port("old-port", "input"), ...existingChainIds.map((id) => node(id, "TYPE"))],
      [{ from: "old-port", fromKey: "out", to: existingChainIds[0]!, toKey: "in" }, ...chainLinks(existingChainIds)],
    );
    const incoming = graph(
      [port("new-port", "input"), ...incomingChainIds.map((id) => node(id, "TYPE"))],
      [{ from: "new-port", fromKey: "out", to: incomingChainIds[0]!, toKey: "in" }, ...chainLinks(incomingChainIds)],
    );

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(result.truncated).toBe(false);
    expect(result.ambiguousExisting).toEqual([]);
    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(
      new Map([
        ["old-port", "new-port"],
        ...existingChainIds.map((id, i) => [id, incomingChainIds[i]!] as const),
      ]),
    );
    expect(result.searchSteps).toBeLessThan(200);
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

  it("uses a function expression as stronger evidence than n", () => {
    const existing = graph([
      node("old-sum", "FUNC_NUM_3", { expression: "x+y", n: "left" }),
      node("old-product", "FUNC_NUM_3", { expression: "x*y", n: "right" }),
      node("removed", "OTHER"),
    ], []);
    const incoming = graph([
      node("new-product", "FUNC_NUM_3", { expression: "x*y", n: "left" }),
      node("new-sum", "FUNC_NUM_3", { expression: "x+y", n: "right" }),
    ], []);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(new Map([
      ["old-sum", "new-sum"],
      ["old-product", "new-product"],
    ]));
    expect(result.unmatchedExisting.map((node) => node.node.id)).toEqual(["removed"]);
  });

  it("propagates a Property Text name through the shared strong-evidence policy", () => {
    const existing = graph([
      node("old-title", "PROPERTY_TEXT", { name: "Train status" }),
      node("old-warning", "PROPERTY_TEXT", { name: "Brake warning" }),
      node("removed", "OTHER"),
    ], []);
    const incoming = graph([
      node("new-warning", "PROPERTY_TEXT", { name: "Brake warning" }),
      node("new-title", "PROPERTY_TEXT", { name: "Train status" }),
    ], []);

    const result = findPartialNodeCorrespondence(existing, incoming);

    expect(new Map(result.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id]))).toEqual(new Map([
      ["old-title", "new-title"],
      ["old-warning", "new-warning"],
    ]));
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
