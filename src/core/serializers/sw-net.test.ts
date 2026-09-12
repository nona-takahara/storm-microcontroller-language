import { describe, expect, it } from "vitest";
import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { createEmptyIrProgram, type IrNode } from "../ir.js";
import { renderStormworksSwNet } from "./sw-net.js";

function renderDropdown(items: string): string {
  const program = createEmptyIrProgram({ sourceFormat: "sw-net" });
  const node: IrNode = {
    id: "gate",
    layer: "logic",
    definitionId: "PROPERTY_DROPDOWN",
    properties: { items },
  };
  program.nodes.push(node);

  return renderStormworksSwNet(program, { definitions: createBundledNodeDefinitions() });
}

describe("PROPERTY_DROPDOWN items serialization", () => {
  it("renders a {l, value}[] JSON string as a bracketed list literal", () => {
    const text = renderDropdown(
      '[{"l":"None","value":"0"},{"l":"Single arm inner","value":"1"}]',
    );

    expect(text).toContain('items=[None=0, "Single arm inner"=1]');
  });

  it("quotes labels that cannot be written as bare identifiers", () => {
    const text = renderDropdown(
      '[{"l":"a,b","value":"0"},{"l":"a=b","value":"1"},{"l":"true","value":"2"}]',
    );

    expect(text).toContain('items=["a,b"=0, "a=b"=1, "true"=2]');
  });

  it("renders a null item value as null and keeps non-numeric strings quoted", () => {
    const text = renderDropdown('[{"l":"None","value":null},{"l":"Other","value":"abc"}]');

    expect(text).toContain('items=[None=null, Other="abc"]');
  });

  it("falls back to the escaped plain-string form for malformed item-list JSON", () => {
    const text = renderDropdown("not valid json");

    expect(text).toContain('items="not valid json"');
  });
});
