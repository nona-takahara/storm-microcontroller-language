import { describe, expect, it } from "vitest";
import { parseSwNetDocument, tokenizeSwNetDocument } from "./sw-net.js";

describe("sw-net list literals", () => {
  it("tokenizes [ and ] as lbracket/rbracket", () => {
    const kinds = tokenizeSwNetDocument("[]").map((token) => token.kind);
    expect(kinds).toEqual(["lbracket", "rbracket", "eof"]);
  });

  it("parses a bracketed label=value list into a list expression", () => {
    const document = parseSwNetDocument(`
      module main
        inst PROPERTY_DROPDOWN gate (items=[None=0, "Single arm inner"=1]) : -> out=gate_out
      end
    `);
    const statement = document.modules[0]?.statements[0];
    expect(statement?.kind).toBe("inst");

    if (statement?.kind !== "inst") {
      throw new Error("Expected an inst statement.");
    }

    const items = statement.attributes.find((attribute) => attribute.key === "items");
    expect(items?.value).toEqual({
      kind: "list",
      entries: [
        { key: "None", value: { kind: "number", value: 0 } },
        { key: "Single arm inner", value: { kind: "number", value: 1 } },
      ],
    });
  });

  it("parses an empty list literal", () => {
    const document = parseSwNetDocument(`
      module main
        inst PROPERTY_DROPDOWN gate (items=[]) : -> out=gate_out
      end
    `);
    const statement = document.modules[0]?.statements[0];

    if (statement?.kind !== "inst") {
      throw new Error("Expected an inst statement.");
    }

    const items = statement.attributes.find((attribute) => attribute.key === "items");
    expect(items?.value).toEqual({ kind: "list", entries: [] });
  });
});
