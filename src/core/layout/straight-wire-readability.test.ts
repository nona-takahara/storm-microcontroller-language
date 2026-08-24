import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import { formatPortOccurrenceKey } from "../serializers/sw-net-shared.js";
import {
  evaluateStraightWireReadability,
  improveStraightWireLayout,
  type StraightWireLayout,
} from "./straight-wire-readability.js";

const definitions = createBundledNodeDefinitions();

function source(id: string, net: string): SwNetStatement {
  return { kind: "inst", typeId: "UNKNOWN", instanceId: id, attributes: [], inputs: [], outputs: [{ key: "out", value: { kind: "identifier", value: net } }] };
}

function sink(id: string, net: string): SwNetStatement {
  return { kind: "inst", typeId: "UNKNOWN", instanceId: id, attributes: [], inputs: [{ key: "in", value: { kind: "identifier", value: net } }], outputs: [] };
}

function layout(entries: Array<[string, number, number]>): StraightWireLayout {
  return { ports: new Map(), instances: new Map(entries.map(([id, x, y]) => [id, { x, y }])) };
}

describe("straight-wire readability", () => {
  it("reconstructs exact gate-port segments and penalizes crossings", () => {
    const module: SwNetModule = { id: "main", ports: [], statements: [source("a", "a"), source("b", "b"), sink("c", "b"), sink("d", "a")] };
    const result = evaluateStraightWireReadability(module, layout([["a", 0, 0], ["b", 0, 1], ["c", 3, 0], ["d", 3, 1]]), definitions);

    expect(result.wires).toContainEqual({ source: { x: 1, y: 0.375 }, target: { x: 3, y: 1.375 }, sourceOwner: "a", targetOwner: "d" });
    expect(result.breakdown.crossings).toBe(1);
  });

  it("uses the inner handles and full frames of boundary-port gates", () => {
    const consumer: SwNetStatement = { kind: "inst", typeId: "UNKNOWN", instanceId: "consumer", attributes: [], inputs: [{ key: "in", value: { kind: "string", value: "input" } }], outputs: [] };
    const producer: SwNetStatement = { kind: "inst", typeId: "UNKNOWN", instanceId: "producer", attributes: [], inputs: [], outputs: [{ key: "out", value: { kind: "string", value: "output" } }] };
    const module: SwNetModule = {
      id: "main",
      ports: [
        { direction: "in", name: "input", signal: "number" },
        { direction: "out", name: "output", signal: "number" },
      ],
      statements: [consumer, producer],
    };
    const result = evaluateStraightWireReadability(
      module,
      {
        ports: new Map([
          [formatPortOccurrenceKey("in", "input", 1), { x: -2, y: 0 }],
          [formatPortOccurrenceKey("out", "output", 1), { x: 4, y: 0 }],
        ]),
        instances: new Map([["consumer", { x: 0, y: 0 }], ["producer", { x: 2, y: 0 }]]),
      },
      definitions,
    );

    expect(result.wires).toEqual([
      { source: { x: -1, y: 0.375 }, target: { x: 0, y: 0.375 }, sourceOwner: `port:${formatPortOccurrenceKey("in", "input", 1)}`, targetOwner: "consumer" },
      { source: { x: 3, y: 0.375 }, target: { x: 4, y: 0.375 }, sourceOwner: "producer", targetOwner: `port:${formatPortOccurrenceKey("out", "output", 1)}` },
    ]);
    expect(result.breakdown.area).toBe(3.5);
  });

  it("distinguishes a shallow crossing when crossing counts are equal", () => {
    const module: SwNetModule = { id: "main", ports: [], statements: [source("a", "a"), source("b", "b"), sink("c", "b"), sink("d", "a")] };
    const shallow = evaluateStraightWireReadability(module, layout([["a", 0, 0], ["b", 0, 0.5], ["c", 5, 0], ["d", 5, 0.5]]), definitions);
    const clear = evaluateStraightWireReadability(module, layout([["a", 0, 0], ["b", 0, 2], ["c", 3, 0], ["d", 3, 2]]), definitions);

    expect(shallow.breakdown.crossings).toBe(1);
    expect(clear.breakdown.crossings).toBe(1);
    expect(shallow.breakdown.shallowCrossings).toBeGreaterThan(clear.breakdown.shallowCrossings);
  });

  it("penalizes a wire crossing an unrelated gate", () => {
    const module: SwNetModule = { id: "main", ports: [], statements: [source("a", "net"), sink("b", "net"), source("blocker", "unused")] };
    const blocked = evaluateStraightWireReadability(module, layout([["a", 0, 0], ["blocker", 2, 0], ["b", 4, 0]]), definitions);
    const clear = evaluateStraightWireReadability(module, layout([["a", 0, 0], ["blocker", 2, 1], ["b", 4, 0]]), definitions);

    expect(blocked.breakdown.gateIntersections).toBe(1);
    expect(clear.breakdown.gateIntersections).toBe(0);
    expect(blocked.score).toBeGreaterThan(clear.score);
  });

  it("swaps adjacent gates within a rank to remove a crossing", () => {
    const module: SwNetModule = { id: "main", ports: [], statements: [source("a", "a"), source("b", "b"), sink("c", "b"), sink("d", "a")] };
    const initial = layout([["a", 0, 0], ["b", 0, 1], ["c", 3, 0], ["d", 3, 1]]);
    const improved = improveStraightWireLayout(module, initial, definitions, { gridSize: 0.25 });

    expect(evaluateStraightWireReadability(module, initial, definitions).breakdown.crossings).toBe(1);
    expect(evaluateStraightWireReadability(module, improved, definitions).breakdown.crossings).toBe(0);
    expect(improved.instances.get("a")?.x).toBe(0);
    expect(improved.instances.get("d")?.x).toBe(3);
  });

  it("is deterministic and obeys the candidate-evaluation bound", () => {
    const module: SwNetModule = { id: "main", ports: [], statements: [source("a", "a"), source("b", "b"), sink("c", "b"), sink("d", "a")] };
    const initial = layout([["a", 0, 0], ["b", 0, 1], ["c", 3, 0], ["d", 3, 1]]);
    const bounded = improveStraightWireLayout(module, initial, definitions, { gridSize: 0.25, maxCandidateEvaluations: 0 });
    const first = improveStraightWireLayout(module, initial, definitions, { gridSize: 0.25 });
    const second = improveStraightWireLayout(module, initial, definitions, { gridSize: 0.25 });

    expect(bounded.instances).toEqual(initial.instances);
    expect(second.instances).toEqual(first.instances);
  });

  it("keeps the main left-to-right order in a feedback loop", () => {
    const first: SwNetStatement = { kind: "inst", typeId: "UNKNOWN", instanceId: "first", attributes: [], inputs: [{ key: "in", value: { kind: "identifier", value: "feedback" } }], outputs: [{ key: "out", value: { kind: "identifier", value: "forward" } }] };
    const second: SwNetStatement = { kind: "inst", typeId: "UNKNOWN", instanceId: "second", attributes: [], inputs: [{ key: "in", value: { kind: "identifier", value: "forward" } }], outputs: [{ key: "out", value: { kind: "identifier", value: "feedback" } }] };
    const module: SwNetModule = { id: "main", ports: [], statements: [first, second] };
    const improved = improveStraightWireLayout(module, layout([["first", 0, 0], ["second", 2, 0]]), definitions, { gridSize: 0.25 });

    expect(improved.instances.get("first")?.x).toBeLessThan(improved.instances.get("second")?.x ?? 0);
  });
});
