import { describe, expect, it } from "vitest";

import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { buildElkGraphStructure, computeSwNetModuleLayout } from "./auto-layout.js";

function gate(id: string, inputNets: string[], outputNet: string): SwNetStatement {
  return {
    kind: "inst",
    typeId: "UNKNOWN_GATE",
    instanceId: id,
    attributes: [],
    inputs: inputNets.map((value, index) => ({ key: `in${index + 1}`, value: { kind: "identifier", value } })),
    outputs: [{ key: "out", value: { kind: "identifier", value: outputNet } }],
  };
}

async function positions(statements: SwNetStatement[]) {
  const module: SwNetModule = { id: "main", ports: [], statements };
  const result = await computeSwNetModuleLayout(module, { mode: "force" });
  return Object.fromEntries(result.instances.map(({ id, position }) => [id, position]));
}

function x(result: Record<string, { x: number; y: number }>, id: string): number {
  const position = result[id];
  if (!position) throw new Error(`Missing position for ${id}`);
  return position.x;
}

describe("computeSwNetModuleLayout flow constraints", () => {
  it("connects ELK edges to fixed west/east gate ports instead of node centers", () => {
    const statements = [gate("producer", [], "net"), gate("consumer", ["net"], "result")];
    const structure = buildElkGraphStructure(
      [],
      statements,
      new Map([["net", { instanceId: "producer", outputKey: "out" }]]),
      [],
      undefined,
      createBundledNodeDefinitions(),
    );

    expect(structure.children[0]).toMatchObject({
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [{
        id: "n$producer$output$out",
        x: 1,
        y: 0.25,
        layoutOptions: { "elk.port.side": "EAST" },
      }],
    });
    expect(structure.edges[0]).toMatchObject({
      sources: ["n$producer$output$out"],
      targets: ["n$consumer$input$in1"],
    });
  });

  it("keeps an ordinary chain left to right and is deterministic", async () => {
    const statements = [gate("source", [], "a"), gate("middle", ["a"], "b"), gate("sink", ["b"], "c")];
    const first = await positions(statements);
    const second = await positions(statements);

    expect(x(first, "source")).toBeLessThan(x(first, "middle"));
    expect(x(first, "middle")).toBeLessThan(x(first, "sink"));
    expect(second).toEqual(first);
  });

  it("places a branch before its merge", async () => {
    const result = await positions([
      gate("source", [], "root"),
      gate("upper", ["root"], "upperNet"),
      gate("lower", ["root"], "lowerNet"),
      gate("merge", ["upperNet", "lowerNet"], "merged"),
    ]);

    expect(x(result, "source")).toBeLessThan(x(result, "upper"));
    expect(x(result, "source")).toBeLessThan(x(result, "lower"));
    expect(x(result, "upper")).toBeLessThan(x(result, "merge"));
    expect(x(result, "lower")).toBeLessThan(x(result, "merge"));
  });

  it("keeps model-forward flow left to right when the graph has feedback", async () => {
    const result = await positions([gate("first", ["feedback"], "forward"), gate("second", ["forward"], "feedback")]);

    expect(x(result, "first")).toBeLessThan(x(result, "second"));
  });
});
