import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { type SwNetStatement } from "../parsers/sw-net.js";
import { computeGateShape } from "./gate-shape.js";

const definitions = createBundledNodeDefinitions();

function unknownGate(inputKeys: string[], outputKeys: string[]): SwNetStatement {
  return {
    kind: "inst",
    typeId: "UNKNOWN_GATE",
    instanceId: "gate",
    attributes: [],
    inputs: inputKeys.map((key) => ({ key, value: { kind: "boolean", value: false } })),
    outputs: outputKeys.map((key) => ({ key, value: { kind: "null", value: null } })),
  };
}

describe("computeGateShape", () => {
  it("places both sides from the top at a fixed 0.25 pitch", () => {
    const shape = computeGateShape(unknownGate(["a"], ["x", "y", "z"]), definitions);

    expect(shape).toMatchObject({ width: 1, height: 1 });
    expect(shape.inputs.map(({ position }) => position)).toEqual([{ x: 0, y: 0.25 }]);
    expect(shape.outputs.map(({ position }) => position)).toEqual([
      { x: 1, y: 0.25 },
      { x: 1, y: 0.5 },
      { x: 1, y: 0.75 },
    ]);
  });

  it("keeps the minimum gate height and one row below the longest side", () => {
    expect(computeGateShape(unknownGate([], []), definitions).height).toBe(0.5);
    expect(computeGateShape(unknownGate(["a", "b"], []), definitions).height).toBe(0.75);
  });
});
