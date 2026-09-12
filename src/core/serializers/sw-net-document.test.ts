import { describe, expect, it } from "vitest";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { serializeSwNetDocument } from "./sw-net-document.js";

describe("serializeSwNetDocument identifiers", () => {
  it("renders existing ASCII module/instance/net identifiers unchanged", () => {
    const text = "module main\n  inst ABS n1 : value=in1 -> out=net1\nend\n";
    const document = parseSwNetDocument(text);

    expect(serializeSwNetDocument(document)).toBe(text);
  });

  it("renders Japanese module ids, instance ids, and net names bare (unquoted)", () => {
    const text = "module 電圧モジュール\n  inst ABS 電圧絶対値 : value=in1 -> out=結果\nend\n";
    const document = parseSwNetDocument(text);

    expect(serializeSwNetDocument(document)).toBe(text);
  });

  it("quotes a property key that is a reserved literal keyword", () => {
    const text = 'module main\n  inst ABS a : "true"=1 -> out=r\nend\n';
    const document = parseSwNetDocument(text);

    expect(serializeSwNetDocument(document)).toBe(text);
  });
});
