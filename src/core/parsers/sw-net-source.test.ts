import { describe, expect, it } from "vitest";

import { serializeSwNetStatement } from "../serializers/sw-net-document.js";
import {
  applySwNetTextEdits,
  createSwNetElementRemovalEdit,
  createSwNetImportInsertionEdit,
  createSwNetStatementInsertionEdit,
  parseSwNetSourceDocument,
} from "./sw-net-source.js";
import { parseSwNetDocument, type SwNetInstStatement } from "./sw-net.js";

describe("parseSwNetSourceDocument", () => {
  it("retains exact text, semantic token offsets, trivia, and element spans", () => {
    const text = [
      "# heading\r\n",
      'module main\r\n',
      '    port in "On" : boolean # port comment\r\n',
      "\r\n",
      "    inst LOGIC n1 (value=true) : in=On -> out=result\r\n",
      "end\r\n",
    ].join("");
    const source = parseSwNetSourceDocument(text);
    const statement = source.ast.modules[0]!.statements[0]!;

    expect(source.text).toBe(text);
    expect(source.newline).toBe("\r\n");
    expect(source.tokens[0]).toMatchObject({ text: "module", start: 11, end: 17 });
    expect(source.trivia.filter((item) => item.kind === "comment").map((item) => item.text)).toEqual([
      "# heading",
      "# port comment",
    ]);
    expect(text.slice(source.spanOf(statement).start, source.spanOf(statement).end)).toBe(
      "inst LOGIC n1 (value=true) : in=On -> out=result",
    );
  });

  it("keeps the original document byte-for-byte when no edits are applied", () => {
    const text = "module main\n\t# unusual formatting\nend";
    expect(applySwNetTextEdits(text, [])).toBe(text);
  });
});

describe("sw-net text edits", () => {
  it("round-trips quoted assignment keys used by human-readable module ports", () => {
    const statement = parseSwNetDocument(
      'module main\n  use child nested : "Ext In"="source" -> "Ext Out"="sink"\nend\n',
    ).modules[0]!.statements[0]!;

    expect(statement.inputs).toEqual([{ key: "Ext In", value: { kind: "string", value: "source" } }]);
    expect(statement.outputs).toEqual([{ key: "Ext Out", value: { kind: "string", value: "sink" } }]);
    expect(serializeSwNetStatement(statement)).toBe(
      'use child nested : "Ext In"="source" -> "Ext Out"="sink"',
    );
  });

  it("rejects overlapping and out-of-range edits", () => {
    expect(() =>
      applySwNetTextEdits("abcdef", [
        { start: 1, end: 4, newText: "x" },
        { start: 3, end: 5, newText: "y" },
      ]),
    ).toThrow(/Overlapping/u);
    expect(() => applySwNetTextEdits("abc", [{ start: 0, end: 4, newText: "" }])).toThrow(/Invalid/u);
  });

  it("removes a multiline statement but preserves its trailing comment", () => {
    const text = [
      "module main\n",
      "  inst LOGIC n1 (\n",
      "    value=true\n",
      "  ) : in=input -> out=result  # retain this\n",
      "  inst LOGIC n2 : ->\n",
      "end\n",
    ].join("");
    const source = parseSwNetSourceDocument(text);
    const edit = createSwNetElementRemovalEdit(source, source.ast.modules[0]!.statements[0]!);
    const result = applySwNetTextEdits(text, [edit]);

    expect(result).toContain("  # retain this\n");
    expect(result).not.toContain("value=true");
    expect(() => parseSwNetDocument(result)).not.toThrow();
  });

  it("removes a complete statement line when it has no adjacent comment", () => {
    const text = "module main\r\n\tinst LOGIC n1 : ->\r\nend\r\n";
    const source = parseSwNetSourceDocument(text);
    const result = applySwNetTextEdits(text, [
      createSwNetElementRemovalEdit(source, source.ast.modules[0]!.statements[0]!),
    ]);

    expect(result).toBe("module main\r\nend\r\n");
    expect(() => parseSwNetDocument(result)).not.toThrow();
  });

  it("inserts a statement with surrounding indentation and newline style", () => {
    const text = 'module main\r\n    port in "input" : boolean\r\n\r\nend\r\n';
    const source = parseSwNetSourceDocument(text);
    const statement: SwNetInstStatement = {
      kind: "inst",
      typeId: "LOGIC",
      instanceId: "n7",
      attributes: [],
      inputs: [],
      outputs: [],
    };
    const result = applySwNetTextEdits(text, [
      createSwNetStatementInsertionEdit(
        source,
        source.ast.modules[0]!,
        serializeSwNetStatement(statement),
      ),
    ]);

    expect(result).toContain("    inst LOGIC n7 : ->\r\nend");
    expect(() => parseSwNetDocument(result)).not.toThrow();
  });

  it("inserts a new import before the first module when none exist yet", () => {
    const text = "module main\nend\n";
    const source = parseSwNetSourceDocument(text);
    const result = applySwNetTextEdits(text, [
      createSwNetImportInsertionEdit(source, 'import helper from "./helper.sw-net"'),
    ]);

    expect(result).toBe('import helper from "./helper.sw-net"\n\nmodule main\nend\n');
    expect(() => parseSwNetDocument(result)).not.toThrow();
  });

  it("inserts a new import after the last existing import", () => {
    const text = 'import a from "./a.sw-net"\nmodule main\nend\n';
    const source = parseSwNetSourceDocument(text);
    const result = applySwNetTextEdits(text, [
      createSwNetImportInsertionEdit(source, 'import b from "./b.sw-net"'),
    ]);

    expect(result).toBe('import a from "./a.sw-net"\nimport b from "./b.sw-net"\nmodule main\nend\n');
    expect(() => parseSwNetDocument(result)).not.toThrow();
  });
});
