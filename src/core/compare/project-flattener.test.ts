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
import { flattenSwNetProject } from "./project-flattener.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("project flattening", () => {
  it("inlines use statements while preserving properties, literals, and provenance", async () => {
    const resolution = await resolveFixture("project-modular");
    const flattened = flattenSwNetProject(resolution).value!;

    expect(flattened.module.statements).toHaveLength(2);
    expect(flattened.module.statements.every((statement) => statement.kind === "inst")).toBe(true);
    expect(flattened.module.statements.map((statement) => statement.instanceId)).toEqual([
      "nested/internal_add",
      "renamed_absolute",
    ]);
    expect(flattened.provenanceByInstanceId["nested/internal_add"]).toEqual({
      moduleId: "renamed_helper",
      instanceIds: ["nested", "internal_add"],
    });
  });

  it("preserves attributes and literal input assignments through nested expansion", async () => {
    const document = parseSwNetDocument(`
      module helper
        port out "value" : number
        inst CLAMP gate(min=-1, max=1) : value=4 -> out="value"
      end
      module main
        port out "result" : number
        use helper nested : -> value="result"
      end
    `);
    const resolution = await resolveDocument(document);
    const statement = flattenSwNetProject(resolution).value!.module.statements[0]!;

    expect(statement.kind).toBe("inst");
    if (statement.kind === "inst") {
      expect(statement.attributes.map(({ key, value }) => [key, value.value])).toEqual([
        ["min", -1],
        ["max", 1],
      ]);
      expect(statement.inputs[0]?.value).toMatchObject({ kind: "number", value: 4 });
    }
  });

  it("scopes internal nets independently for repeated submodule instances", async () => {
    const document = parseSwNetDocument(`
      module helper
        port in "x" : number
        port out "y" : number
        inst ADD pre : a="x", b=1 -> out=temp
        inst ABS post : value=temp -> out="y"
      end
      module main
        port in "left" : number
        port in "right" : number
        port out "out1" : number
        port out "out2" : number
        use helper nested1 : x="left" -> y="out1"
        use helper nested2 : x="right" -> y="out2"
      end
    `);
    const flattened = flattenSwNetProject(await resolveDocument(document)).value!;
    const internalNetValues = flattened.module.statements.flatMap((statement) => [
      ...statement.inputs,
      ...statement.outputs,
    ]).flatMap(({ value }) => value.kind === "identifier" ? [value.value] : []);

    expect(internalNetValues).toEqual([
      "nested1/%24temp",
      "nested1/%24temp",
      "nested2/%24temp",
      "nested2/%24temp",
    ]);
    expect(new Set(internalNetValues)).toEqual(
      new Set(["nested1/%24temp", "nested2/%24temp"]),
    );
  });
});

async function resolveFixture(name: string): Promise<SwNetResolutionResult> {
  const path = join(fixtureDirectory, name, "main.sw-net");
  return resolveDocument(parseSwNetDocument(readFileSync(path, "utf8")), path);
}

async function resolveDocument(
  document: SwNetDocument,
  path = "/fixture/main.sw-net",
): Promise<SwNetResolutionResult> {
  const resolver: SwNetDocumentResolver = {
    resolveImportPath: (_from, imported) => imported,
    loadDocument: async () => {
      throw new Error("Unexpected import.");
    },
  };
  return resolveSwNetDocumentGraph({ path, document }, resolver);
}
