import { describe, expect, it } from "vitest";
import { serializeSwNetDocument } from "../serializers/sw-net-document.js";
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

describe("sw-net module parameters", () => {
  const source = [
    'module sub(arg1=0, arg2="rise")',
    '  port out "y" : number',
    "",
    "  inst PULSE edge (mode=@arg2) : -> out=y",
    "end",
    "",
    "module main",
    '  use sub s1 (arg1=3, arg2="fall") : -> y=out',
    "  use sub s2 : -> y=out2",
    "end",
    "",
  ].join("\n");

  it("tokenizes @ as its own token", () => {
    expect(tokenizeSwNetDocument("@arg").map((token) => token.kind)).toEqual(["at", "identifier", "eof"]);
  });

  it("parses module parameters, @references, and use arguments", () => {
    const [sub, main] = parseSwNetDocument(source).modules;

    expect(sub?.params).toEqual([
      { key: "arg1", value: { kind: "number", value: 0 } },
      { key: "arg2", value: { kind: "string", value: "rise" } },
    ]);
    const inst = sub?.statements[0];
    expect(inst?.kind === "inst" && inst.attributes).toEqual([
      { key: "mode", value: { kind: "paramRef", name: "arg2" } },
    ]);
    const [withArgs, withoutArgs] = main?.statements ?? [];
    expect(withArgs?.kind === "use" && withArgs.args).toEqual([
      { key: "arg1", value: { kind: "number", value: 3 } },
      { key: "arg2", value: { kind: "string", value: "fall" } },
    ]);
    expect(withoutArgs?.kind === "use" && withoutArgs.args).toEqual([]);
    expect(main?.params).toEqual([]);
  });

  it("round-trips through the serializer", () => {
    expect(serializeSwNetDocument(parseSwNetDocument(source))).toBe(source);
  });

  it("rejects a bare @ without a name", () => {
    expect(() => parseSwNetDocument("module main\n  inst ABS g (a=@) : -> out=x\nend\n")).toThrow(/identifier/);
  });
});
