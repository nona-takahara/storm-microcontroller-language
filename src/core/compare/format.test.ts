import { describe, expect, it } from "vitest";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { formatNetworkComparison, formatProjectComparison } from "./format.js";
import { compareSwNetModules } from "./module-graph-comparator.js";
import { type ProjectComparisonResult } from "./types.js";

describe("comparison formatting", () => {
  it("renders verdict, matched count, and property differences", () => {
    const moduleA = parseSwNetDocument(`
      module main
        port in "input" : number
        port out "output" : number
        inst CLAMP a(min=1) : value="input" -> out="output"
      end
    `).modules[0]!;
    const moduleB = parseSwNetDocument(`
      module main
        port in "input" : number
        port out "output" : number
        inst CLAMP b(min=2) : value="input" -> out="output"
      end
    `).modules[0]!;
    const result = compareSwNetModules(moduleA, moduleB).value!;

    expect(formatNetworkComparison(result)).toContain("Network comparison: different");
    expect(formatNetworkComparison(result)).toContain("Matched nodes: 3");
    expect(formatNetworkComparison(result)).toContain('attribute "min" differs');
    expect(formatNetworkComparison(result)).toContain('"a" (CLAMP) (1)');
    expect(formatNetworkComparison(result)).toContain('"b" (CLAMP) (2)');
  });

  it("renders project module summaries and unmatched modules", () => {
    const module = parseSwNetDocument("module main\nend").modules[0]!;
    const network = compareSwNetModules(module, module).value!;
    const result: ProjectComparisonResult = {
      ...network,
      moduleResults: [{ moduleKeyA: "a:main", moduleKeyB: "b:main", result: network }],
      unmatchedModulesInA: ["a:unused"],
      unmatchedModulesInB: [],
    };

    const formatted = formatProjectComparison(result);
    expect(formatted).toContain("Module comparisons (1):");
    expect(formatted).toContain("a:main ↔ b:main: equivalent");
    expect(formatted).toContain("Unmatched modules in A: a:unused");
  });

  it("renders module-grouped project differences", () => {
    const moduleA = parseSwNetDocument(`
      module main
        port in "input" : number
        port out "output" : number
        inst CLAMP a(min=1) : value="input" -> out="output"
      end
    `).modules[0]!;
    const moduleB = parseSwNetDocument(`
      module main
        port in "input" : number
        port out "output" : number
        inst CLAMP b(min=2) : value="input" -> out="output"
      end
    `).modules[0]!;
    const network = compareSwNetModules(moduleA, moduleB).value!;
    const result: ProjectComparisonResult = {
      ...network,
      moduleResults: [{ moduleKeyA: "a:main", moduleKeyB: "b:main", result: network }],
      unmatchedModulesInA: [],
      unmatchedModulesInB: [],
    };

    const formatted = formatProjectComparison(result);
    expect(formatted).toContain("a:main ↔ b:main: different");
    expect(formatted).toContain('  - attribute "min" differs');
  });
});
