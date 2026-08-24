import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { buildStormworksXmlTree } from "../exporters/xml-tree.js";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { resolveSwNetDocumentGraph } from "../resolvers/sw-net.js";
import { importStormworksXml } from "./xml.js";

describe("importStormworksXml composite variable-channel bindings", () => {
  it("maps Stormworks-authored read and write channel inputs to their DSL ports", () => {
    const xml = [
      "<microprocessor>",
      "  <group><components>",
      '    <c type="29"><object id="8" i="-1"><in2 component_id="12"/></object></c>',
      '    <c type="31"><object id="9" i="-1"><in2 component_id="12"/></object></c>',
      '    <c type="40"><object id="10" count="1" offset="-1"><in1/><inoff component_id="12"/></object></c>',
      '    <c type="41"><object id="11" count="1" offset="-1"><in1/><inoff component_id="12"/></object></c>',
      '    <c type="15"><object id="12"><n value="1"/></object></c>',
      "  </components></group>",
      "</microprocessor>",
    ].join("\n");

    const result = importStormworksXml(xml, { definitions: createBundledNodeDefinitions() });
    const importedBindings = result.program.links.map((link) => ({
      definitionId: result.program.nodes.find((node) => node.id === link.to.nodeId)?.definitionId,
      portKey: link.to.portKey,
    }));

    expect(importedBindings).toEqual([
      { definitionId: "COMPOSITE_READ_BOOLEAN", portKey: "channel_input" },
      { definitionId: "COMPOSITE_READ_NUMBER", portKey: "channel_input" },
      { definitionId: "COMPOSITE_WRITE_NUMBER", portKey: "offset_input" },
      { definitionId: "COMPOSITE_WRITE_BOOLEAN", portKey: "offset_input" },
    ]);
  });

  it("exports the variable channel inputs with the keys Stormworks preserves", async () => {
    const document = parseSwNetDocument([
      "module main",
      "  inst CONST channel (value=1) : -> value=channel_value",
      "  inst COMPOSITE_READ_BOOLEAN read_boolean (channel=-1) : channel_input=channel_value -> out=read_boolean_out",
      "  inst COMPOSITE_READ_NUMBER read_number (channel=-1) : channel_input=channel_value -> out=read_number_out",
      "  inst COMPOSITE_WRITE_NUMBER write_number (count=1, offset=-1) : offset_input=channel_value -> out=write_number_out",
      "  inst COMPOSITE_WRITE_BOOLEAN write_boolean (count=1, offset=-1) : offset_input=channel_value -> out=write_boolean_out",
      "end",
    ].join("\n"));
    const swNet = await resolveSwNetDocumentGraph(
      { path: "main.sw-net", document },
      {
        resolveImportPath: () => { throw new Error("This fixture has no imports."); },
        loadDocument: () => { throw new Error("This fixture has no imports."); },
      },
    );
    const result = buildStormworksXmlTree({
      project: {
        formatVersion: "stormworks-project-json-v11",
        name: "Composite binding regression",
        description: null,
        width: 2,
        length: 2,
        icon: null,
        nodes: [],
        submodule: { name: "main", relativePath: "main.sw-net" },
        warnings: [],
      },
      swNet,
      swMclByDocumentPath: new Map([["main.sw-net", null]]),
    }, { definitions: createBundledNodeDefinitions() });
    const group = result.tree.microprocessor.group as {
      components: { c: Array<{ "@_type"?: string; object: Record<string, unknown> }> };
    };
    const objectByType = new Map(group.components.c.map((component) => [component["@_type"], component.object]));

    expect(objectByType.get("29")).toHaveProperty("in2");
    expect(objectByType.get("31")).toHaveProperty("in2");
    expect(objectByType.get("40")).toHaveProperty("inoff");
    expect(objectByType.get("41")).toHaveProperty("inoff");
    expect(objectByType.get("29")).not.toHaveProperty("inoff");
    expect(objectByType.get("31")).not.toHaveProperty("inoff");
  });
});
