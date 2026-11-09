import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSwNetDocument, type SwNetDocument } from "../parsers/sw-net.js";
import {
  resolveSwNetDocumentGraph,
  type SwNetDocumentResolver,
  type SwNetResolutionResult,
} from "../resolvers/sw-net.js";
import { compareSwNetEntryModules, compareSwNetProjects } from "./project-comparator.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("project comparison", () => {
  it("treats inline and modular forms of the same flattened circuit as equivalent", async () => {
    const inline = await resolveFixture("project-inline");
    const modular = await resolveFixture("project-modular");
    const comparison = compareSwNetProjects(inline, modular);

    expect(comparison.diagnostics).toEqual([]);
    expect(comparison.value?.verdict).toBe("equivalent");
    expect(comparison.value?.matchedPairs).toHaveLength(5);
    expect(
      comparison.value?.matchedPairs.find((pair) => pair.a.node.definitionId === "ADD")?.b.provenance,
    ).toEqual({
      moduleId: "renamed_helper",
      instanceIds: ["nested", "internal_add"],
    });
    expect(comparison.value?.unmatchedModulesInB).toContain(
      `${join(fixtureDirectory, "project-modular", "main.sw-net")}#renamed_helper`,
    );
  });

  it("makes nested property differences verdict-breaking after flattening", async () => {
    const projectA = await resolveDocument(parseSwNetDocument(`
      module helper
        port in "value" : number
        port out "result" : number
        inst CLAMP gate(min=0) : value="value" -> out="result"
      end
      module main
        port in "value" : number
        port out "result" : number
        use helper nested : value="value" -> result="result"
      end
    `));
    const projectB = await resolveDocument(parseSwNetDocument(`
      module renamed
        port in "value" : number
        port out "result" : number
        inst CLAMP other(min=1) : value="value" -> out="result"
      end
      module main
        port in "value" : number
        port out "result" : number
        use renamed wrapper : value="value" -> result="result"
      end
    `), "/fixture/b.sw-net");
    const result = compareSwNetProjects(projectA, projectB).value!;

    expect(result.verdict).toBe("different");
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: "property-value-mismatch",
      source: "attribute",
      key: "min",
      valueA: 0,
      valueB: 1,
    });
    expect(result.moduleResults.some((entry) => entry.result.verdict === "different")).toBe(true);
  });

  it("expands multi-level use trees with colliding internal net names on both comparison paths", async () => {
    const nested = await resolveFixture("project-nested-a");
    const inline = await resolveFixture("project-nested-b");

    const project = compareSwNetProjects(nested, inline);
    expect(project.value?.verdict).toBe("equivalent");
    expect(project.value?.matchedPairs).toHaveLength(8);
    const mainEntry = project.value?.moduleResults.find((entry) => entry.moduleKeyA.endsWith("#main"));
    expect(mainEntry?.moduleKeyB.endsWith("#main")).toBe(true);
    expect(mainEntry?.result.verdict).toBe("equivalent");

    const entry = compareSwNetEntryModules(
      { resolution: nested, key: { documentPath: nested.entryDocumentPath, moduleId: "main" } },
      { resolution: inline, key: { documentPath: inline.entryDocumentPath, moduleId: "main" } },
    );
    expect(entry.diagnostics).toEqual([]);
    expect(entry.value?.verdict).toBe("equivalent");
    expect(entry.value?.matchedPairs).toHaveLength(8);
  });

  it("compares a non-entry module of a multi-level project by its inlined circuit", async () => {
    const nested = await resolveFixture("project-nested-a");
    const mid = { documentPath: nested.entryDocumentPath, moduleId: "mid" };
    const leaf = { documentPath: nested.entryDocumentPath, moduleId: "leaf" };

    const same = compareSwNetEntryModules(
      { resolution: nested, key: mid },
      { resolution: nested, key: mid },
    );
    expect(same.value?.verdict).toBe("equivalent");
    expect(same.value?.matchedPairs).toHaveLength(7);

    const different = compareSwNetEntryModules(
      { resolution: nested, key: mid },
      { resolution: nested, key: leaf },
    );
    expect(different.value?.verdict).toBe("different");
  });

  it("reports an ambiguous entry document as diagnostics", async () => {
    const resolution = await resolveDocument(parseSwNetDocument(`
      module one
      end
      module two
      end
    `));

    const result = compareSwNetProjects(resolution, resolution);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("COMPARE_ENTRY_MODULE_AMBIGUOUS");
  });
});

async function resolveFixture(name: string): Promise<SwNetResolutionResult> {
  const path = join(fixtureDirectory, name, "main.sw-net");
  return resolveDocument(parseSwNetDocument(readFileSync(path, "utf8")), path);
}

async function resolveDocument(
  document: SwNetDocument,
  path = "/fixture/a.sw-net",
): Promise<SwNetResolutionResult> {
  const resolver: SwNetDocumentResolver = {
    resolveImportPath: (_from, imported) => imported,
    loadDocument: async () => {
      throw new Error("Unexpected import.");
    },
  };
  return resolveSwNetDocumentGraph({ path, document }, resolver);
}
