import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type SwNetModule, parseSwNetDocument } from "../parsers/sw-net.js";
import { compareSwNetModules } from "./module-graph-comparator.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("compareSwNetModules exact matching", () => {
  it("matches a renamed and reordered unambiguous graph", () => {
    const result = compareSwNetModules(singleModule("renamed-reordered-a.sw-net"), singleModule("renamed-reordered-b.sw-net"));

    expect(result.value?.verdict).toBe("equivalent");
    expect(result.value?.matchedPairs).toHaveLength(5);
    expect(result.value?.differences).toEqual([]);
  });

  it.each([
    ["asymmetric_a", "asymmetric_b"],
    ["output_port_a", "output_port_b"],
    ["fanout_a", "fanout_b"],
  ])("proves %s and %s different when forced endpoint wiring differs", (moduleA, moduleB) => {
    const modules = fixtureModules("edge-mismatches.sw-net");
    const result = compareSwNetModules(modules.get(moduleA)!, modules.get(moduleB)!);

    expect(result.value?.verdict).toBe("different");
    expect(result.value?.differences.length).toBeGreaterThan(0);
  });

  it.each([
    ["number_port", "boolean_port"],
    ["one_abs", "two_abs"],
  ])("proves %s and %s different from their node-kind counts", (moduleA, moduleB) => {
    const modules = fixtureModules("ports-and-counts.sw-net");
    const result = compareSwNetModules(modules.get(moduleA)!, modules.get(moduleB)!);

    expect(result.value?.verdict).toBe("different");
    expect(result.value?.reason).toContain("multiset differs");
  });

  it("does not guess among symmetric candidates before bounded search is available", () => {
    const modules = fixtureModules("symmetric-search.sw-net");
    const result = compareSwNetModules(modules.get("symmetric_a")!, modules.get("symmetric_b")!);

    expect(result.value?.verdict).toBe("indeterminate");
    expect(result.value?.reason).toContain("bounded search");
  });
});

function singleModule(name: string): SwNetModule {
  return parseSwNetDocument(readFileSync(join(fixtureDirectory, name), "utf8")).modules[0]!;
}

function fixtureModules(name: string): Map<string, SwNetModule> {
  return new Map(
    parseSwNetDocument(readFileSync(join(fixtureDirectory, name), "utf8")).modules.map((module) => [module.id, module]),
  );
}
