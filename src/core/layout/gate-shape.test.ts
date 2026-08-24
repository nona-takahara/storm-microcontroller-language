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
  it("places both sides after 1.5 rows of top padding at a fixed 0.25 pitch", () => {
    const shape = computeGateShape(unknownGate(["a"], ["x", "y", "z"]), definitions);

    expect(shape).toMatchObject({ width: 1, height: 1 });
    expect(shape.inputs.map(({ position }) => position)).toEqual([{ x: 0, y: 0.375 }]);
    expect(shape.outputs.map(({ position }) => position)).toEqual([
      { x: 1, y: 0.375 },
      { x: 1, y: 0.625 },
      { x: 1, y: 0.875 },
    ]);
  });

  it("adds 0.25 to the longest side's rows with a 0.5 minimum", () => {
    expect(computeGateShape(unknownGate([], []), definitions).height).toBe(0.5);
    expect(computeGateShape(unknownGate(["a"], []), definitions).height).toBe(0.5);
    expect(computeGateShape(unknownGate(["a", "b"], []), definitions).height).toBe(0.75);
  });

  it("orders Composite Write inputs as composite, dynamic values, then external offset", () => {
    const statement: SwNetStatement = {
      kind: "inst",
      typeId: "COMPOSITE_WRITE_NUMBER",
      instanceId: "writer",
      attributes: [
        { key: "count", value: { kind: "number", value: 3 } },
        { key: "offset", value: { kind: "number", value: -1 } },
      ],
      inputs: [],
      outputs: [],
    };

    const shape = computeGateShape(statement, definitions);

    expect(shape.height).toBe(1.5);
    expect(shape.inputs.map(({ key, position }) => ({ key, y: position.y }))).toEqual([
      { key: "inc", y: 0.375 },
      { key: "in1", y: 0.625 },
      { key: "in2", y: 0.875 },
      { key: "in3", y: 1.125 },
      { key: "offset_input", y: 1.375 },
    ]);
  });
});
