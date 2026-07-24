import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { normalizeComparableModule } from "./comparable-node.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("normalizeComparableModule", () => {
  it("recovers literal inputs while preserving absent inputs as absent", () => {
    const [literal, absent] = parseFixture("properties.sw-net").modules;
    expect(literal).toBeDefined();
    expect(absent).toBeDefined();

    const literalGate = normalizeComparableModule(literal!).value?.nodes.find((node) => node.node.id === "gate");
    const absentGate = normalizeComparableModule(absent!).value?.nodes.find((node) => node.node.id === "gate");

    expect(literalGate?.literalInputs).toEqual({ a: 1, b: 2 });
    expect(absentGate?.literalInputs).toEqual({ b: 2 });
  });

  it("recovers inst attributes and leaves use/port attributes empty", () => {
    const module = parseFixture("properties.sw-net").modules.find(({ id }) => id === "attribute_a");
    expect(module).toBeDefined();

    const result = normalizeComparableModule(module!);
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.nodes.find((node) => node.node.id === "gate")?.attributes).toEqual({ min: 0, max: 1 });
    expect(result.value?.nodes.filter((node) => node.port).every((node) => Object.keys(node.attributes).length === 0)).toBe(
      true,
    );
  });

  it("gives duplicate ports signal-aware occurrence identities", () => {
    const source = `
module duplicate_ports
  port in "value" : number
  port in "value" : boolean
end
`;
    const module = parseSwNetDocument(source).modules[0];
    expect(module).toBeDefined();

    const ports = normalizeComparableModule(module!).value?.nodes.map((node) => node.port);
    expect(ports).toEqual([
      { direction: "in", name: "value", signal: "number", occurrence: 1 },
      { direction: "in", name: "value", signal: "boolean", occurrence: 2 },
    ]);
  });
});

function parseFixture(name: string) {
  return parseSwNetDocument(readFileSync(join(fixtureDirectory, name), "utf8"), { sourceName: name });
}
