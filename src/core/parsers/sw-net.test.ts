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

describe("sw-net Unicode identifiers", () => {
  it("keeps existing bare ASCII identifiers parsing unchanged", () => {
    const document = parseSwNetDocument(`
      module main
        inst ABS n1 : value=in1 -> out=net1
      end
    `);

    expect(document.modules[0]?.id).toBe("main");
    expect(document.modules[0]?.statements[0]).toMatchObject({ kind: "inst", instanceId: "n1" });
  });

  it("parses Japanese module ids, instance ids, and net names", () => {
    const document = parseSwNetDocument(`
      module 電圧モジュール
        inst ABS 電圧絶対値 : value=in1 -> out=結果
        inst ADD 加算 : a=結果, b=1 -> out=最終
      end
    `);

    expect(document.modules[0]?.id).toBe("電圧モジュール");
    const [first, second] = document.modules[0]?.statements ?? [];
    expect(first).toMatchObject({ kind: "inst", instanceId: "電圧絶対値" });
    expect(second).toMatchObject({ kind: "inst", instanceId: "加算" });
  });

  it("allows underscore-joined mixed-script identifiers", () => {
    const document = parseSwNetDocument(`
      module main
        inst ABS ゲート_1 : value=in1 -> out=出力_1
      end
    `);

    expect(document.modules[0]?.statements[0]).toMatchObject({ kind: "inst", instanceId: "ゲート_1" });
  });

  it("rejects a supplementary-plane character inside a bare identifier", () => {
    // Documented scope boundary: the lexer scans one UTF-16 code unit at a time, so a character
    // outside the Basic Multilingual Plane (most emoji, some rare CJK extension ideographs) is a
    // lone surrogate to `\p{ID_Start}`/`\p{ID_Continue}` and cannot start or extend a bare
    // identifier. It fails to parse with a clear error instead of silently truncating the name.
    expect(() => parseSwNetDocument("module main\n  inst ABS \u{1F600} : -> out=net1\nend\n")).toThrow(
      /Unexpected character/,
    );
  });
});
