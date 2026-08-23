import { describe, expect, it } from "vitest";

import { type IrScalarValue } from "../ir.js";
import { findExactNodeCorrespondence } from "./structural-correspondence.js";
import { type ComparableModuleGraph, type ComparableNode } from "./types.js";

describe("findExactNodeCorrespondence", () => {
  it("assigns twelve independent same-kind nodes by key-level properties without permutation search", () => {
    const size = 12;
    const existing = graph(Array.from({ length: size }, (_, index) => node(`old-${index}`, { value: index })), []);
    const incoming = graph(Array.from({ length: size }, (_, index) => node(`new-${index}`, { value: index })).reverse(), []);

    const result = findExactNodeCorrespondence(existing, incoming);

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(100);
    expect(result?.ambiguousExisting).toEqual([]);
    expect(new Map(result?.pairs.map((pair) => [pair.a.attributes.value, pair.b.attributes.value]))).toEqual(
      new Map(Array.from({ length: size }, (_, index) => [index, index])),
    );
  });

  it("reports interchangeable independent nodes without treating the assignment as certain", () => {
    const result = findExactNodeCorrespondence(
      graph([node("old-a"), node("old-b")], []),
      graph([node("new-a"), node("new-b")], []),
    );

    expect(result?.pairs).toHaveLength(2);
    expect(result?.certainPairs).toEqual([]);
    expect(result?.ambiguousExisting.map((item) => item.node.id)).toEqual(["old-a", "old-b"]);
  });

  it("keeps a unique property pair certain beside a duplicated-property ambiguity", () => {
    const result = findExactNodeCorrespondence(
      graph([node("old-a", { value: 1 }), node("old-b", { value: 1 }), node("old-c", { value: 2 })], []),
      graph([node("new-a", { value: 1 }), node("new-b", { value: 1 }), node("new-c", { value: 2 })], []),
    );

    expect(result?.certainPairs.map((pair) => [pair.a.node.id, pair.b.node.id])).toEqual([["old-c", "new-c"]]);
    expect(result?.ambiguousExisting.map((item) => item.node.id)).toEqual(["old-a", "old-b"]);
    expect(result?.ambiguousIncoming.map((item) => item.node.id)).toEqual(["new-a", "new-b"]);
  });

  it("never chooses a property-favored assignment that breaks cycle wiring", () => {
    const oldIds = ["old-0", "old-1", "old-2", "old-3"];
    const newIds = ["new-0", "new-1", "new-2", "new-3"];
    const cycleLinks = (ids: string[]) => ids.map((id, index) => ({ from: id, to: ids[(index + 1) % ids.length]! }));
    const existing = graph(oldIds.map((id, index) => node(id, { value: index })), cycleLinks(oldIds));
    const incoming = graph(newIds.map((id, index) => node(id, { value: (index + 2) % 4 })), cycleLinks(newIds));

    const result = findExactNodeCorrespondence(existing, incoming);

    expect(result).toBeDefined();
    expect(result?.ambiguousExisting).toEqual([]);
    expect(result?.pairs.every((pair) => pair.a.attributes.value === pair.b.attributes.value)).toBe(true);
  });

  it("keeps independent symmetry orbits separate inside one connected component", () => {
    const nodes = (prefix: string) => [
      node(`${prefix}-left-anchor`, {}, "LEFT_ANCHOR"),
      node(`${prefix}-left-a`, { value: 1 }),
      node(`${prefix}-left-b`, { value: 1 }),
      node(`${prefix}-right-anchor`, {}, "RIGHT_ANCHOR"),
      node(`${prefix}-right-a`, { value: 2 }),
      node(`${prefix}-right-b`, { value: 2 }),
    ];
    const links = (prefix: string) => [
      { from: `${prefix}-left-anchor`, to: `${prefix}-right-anchor`, fromKey: "bridge", toKey: "bridge" },
      { from: `${prefix}-left-anchor`, to: `${prefix}-left-a` },
      { from: `${prefix}-left-anchor`, to: `${prefix}-left-b` },
      { from: `${prefix}-right-anchor`, to: `${prefix}-right-a` },
      { from: `${prefix}-right-anchor`, to: `${prefix}-right-b` },
    ];

    const result = findExactNodeCorrespondence(graph(nodes("old"), links("old")), graph(nodes("new"), links("new")));

    expect(result?.ambiguityGroups).toHaveLength(2);
    expect(result?.ambiguityGroups.map((group) => [...new Set(group.incoming.map((node) => node.attributes.value))])).toEqual([
      [1],
      [2],
    ]);
  });

  it("assigns a fully interchangeable wired cluster without enumerating its permutations", () => {
    const size = 10;
    const oldIds = Array.from({ length: size }, (_, index) => `old-${index}`);
    const newIds = Array.from({ length: size }, (_, index) => `new-${index}`);
    const completeLinks = (ids: string[]) => ids.flatMap((from) => ids.filter((to) => to !== from).map((to) => ({ from, to })));
    const existing = graph(oldIds.map((id, index) => node(id, { value: index })), completeLinks(oldIds));
    const incoming = graph(newIds.map((id, index) => node(id, { value: index })).reverse(), completeLinks(newIds));

    const result = findExactNodeCorrespondence(existing, incoming);

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(100);
    expect(result?.ambiguousExisting).toEqual([]);
    expect(result?.pairs.every((pair) => pair.a.attributes.value === pair.b.attributes.value)).toBe(true);
  });

  it("assigns a large same-kind star without enumerating leaf permutations", () => {
    const leafCount = 11;
    const oldLeaves = Array.from({ length: leafCount }, (_, index) => `old-leaf-${index}`);
    const newLeaves = Array.from({ length: leafCount }, (_, index) => `new-leaf-${index}`);
    const existing = graph(
      [node("old-center", { value: 100 }), ...oldLeaves.map((id, index) => node(id, { value: index }))],
      oldLeaves.map((to) => ({ from: "old-center", to })),
    );
    const incoming = graph(
      [node("new-center", { value: 100 }), ...newLeaves.map((id, index) => node(id, { value: index })).reverse()],
      newLeaves.map((to) => ({ from: "new-center", to })),
    );

    const result = findExactNodeCorrespondence(existing, incoming);

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(100);
    expect(result?.ambiguousExisting).toEqual([]);
    expect(result?.pairs.every((pair) => pair.a.attributes.value === pair.b.attributes.value)).toBe(true);
  });

  it("propagates an exact long chain from one port anchor in near-linear work", () => {
    const length = 60;
    const oldIds = Array.from({ length }, (_, index) => `old-${index}`);
    const newIds = Array.from({ length }, (_, index) => `new-${index}`);
    const chainLinks = (anchor: string, ids: string[]) => [
      { from: anchor, to: ids[0]! },
      ...ids.slice(0, -1).map((from, index) => ({ from, to: ids[index + 1]! })),
    ];
    const existing = graph(
      [node("anchor-old", {}, "PORT"), ...oldIds.map((id) => node(id))],
      chainLinks("anchor-old", oldIds),
    );
    const incoming = graph(
      [node("anchor-new", {}, "PORT"), ...newIds.map((id) => node(id))],
      chainLinks("anchor-new", newIds),
    );

    const result = findExactNodeCorrespondence(existing, incoming);

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(200);
    expect(result?.ambiguousExisting).toEqual([]);
  });

  it("compresses the exponential automorphisms of a fully symmetric binary tree", () => {
    const depth = 6;
    const tree = (prefix: string) => {
      const size = 2 ** (depth + 1) - 1;
      const ids = Array.from({ length: size }, (_, index) => `${prefix}-${index}`);
      return {
        nodes: ids.map((id) => node(id)),
        links: ids.slice(1).map((id, index) => ({ from: ids[Math.floor(index / 2)]!, to: id })),
      };
    };
    const existing = tree("old");
    const incoming = tree("new");

    const result = findExactNodeCorrespondence(
      graph(existing.nodes, existing.links),
      graph(incoming.nodes.reverse(), incoming.links),
    );

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(6_000);
    expect(result?.certainPairs.map((pair) => pair.a.node.id)).toEqual(["old-0"]);
    expect(result?.ambiguousExisting).toHaveLength(existing.nodes.length - 1);
  });

  it("keeps property-distinguished leaves certain without expanding binary-tree automorphisms", () => {
    const depth = 5;
    const tree = (prefix: string) => {
      const size = 2 ** (depth + 1) - 1;
      const firstLeaf = 2 ** depth - 1;
      const ids = Array.from({ length: size }, (_, index) => `${prefix}-${index}`);
      return {
        nodes: ids.map((id, index) => node(id, index >= firstLeaf ? { value: index - firstLeaf } : {})),
        links: ids.slice(1).map((id, index) => ({ from: ids[Math.floor(index / 2)]!, to: id })),
      };
    };
    const existing = tree("old");
    const incoming = tree("new");
    const result = findExactNodeCorrespondence(graph(existing.nodes, existing.links), graph(incoming.nodes.reverse(), incoming.links));

    expect(result).toBeDefined();
    expect(result?.searchSteps).toBeLessThan(1_500);
    expect(result?.ambiguousExisting).toEqual([]);
    expect(result?.certainPairs).toHaveLength(existing.nodes.length);
  });

  it("returns undefined when endpoint port keys make the structures different", () => {
    const existing = graph([node("a"), node("b")], [{ from: "a", to: "b", fromKey: "out" }]);
    const incoming = graph([node("x"), node("y")], [{ from: "x", to: "y", fromKey: "other" }]);

    expect(findExactNodeCorrespondence(existing, incoming)).toBeUndefined();
  });
});

function node(id: string, attributes: Record<string, IrScalarValue> = {}, definitionId = "TYPE"): ComparableNode {
  return {
    node: { id, definitionId, layer: "logic", properties: attributes },
    attributes,
    literalInputs: {},
  };
}

function graph(
  nodes: ComparableNode[],
  links: Array<{ from: string; to: string; fromKey?: string; toKey?: string }>,
): ComparableModuleGraph {
  return {
    moduleId: "main",
    nodes,
    links: links.map((link, index) => ({
      id: String(index),
      from: { nodeId: link.from, portKey: link.fromKey ?? "out" },
      to: { nodeId: link.to, portKey: link.toKey ?? "in" },
    })),
  };
}
