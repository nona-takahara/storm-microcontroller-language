import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { resolveSwNetDocumentGraph } from "../resolvers/sw-net.js";
import { buildStormworksXmlTree } from "./xml-tree.js";

async function exportSwNet(source: string) {
  const document = parseSwNetDocument(source);
  const swNet = await resolveSwNetDocumentGraph(
    { path: "main.sw-net", document },
    {
      resolveImportPath: () => {
        throw new Error("This fixture has no imports.");
      },
      loadDocument: () => {
        throw new Error("This fixture has no imports.");
      },
    },
  );

  return buildStormworksXmlTree(
    {
      project: {
        formatVersion: "stormworks-project-json-v11",
        name: "PROPERTY_DROPDOWN items regression",
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
    },
    { definitions: createBundledNodeDefinitions() },
  );
}

function findDropdownObject(result: Awaited<ReturnType<typeof exportSwNet>>) {
  const group = result.tree.microprocessor.group as {
    components: { c: Array<{ "@_type"?: string; object: Record<string, unknown> }> };
  };

  return group.components.c.find((component) => component["@_type"] === "20")?.object;
}

describe("PROPERTY_DROPDOWN items export", () => {
  it("renders a list literal to the same <items> tree as the equivalent plain JSON string", async () => {
    const listResult = await exportSwNet(
      [
        "module main",
        '  inst PROPERTY_DROPDOWN gate (items=[None=0, "Single arm inner"=1]) : -> out=gate_out',
        "end",
      ].join("\n"),
    );
    const plainResult = await exportSwNet(
      [
        "module main",
        `  inst PROPERTY_DROPDOWN gate (items="[{\\"l\\":\\"None\\",\\"value\\":\\"0\\"},{\\"l\\":\\"Single arm inner\\",\\"value\\":\\"1\\"}]") : -> out=gate_out`,
        "end",
      ].join("\n"),
    );

    const listObject = findDropdownObject(listResult);
    const plainObject = findDropdownObject(plainResult);

    expect(listObject).toBeDefined();
    expect(listObject).toEqual(plainObject);
    expect(listObject?.items).toEqual({
      i: [
        { "@_l": "None", v: { "@_text": "0", "@_value": "0" } },
        { "@_l": "Single arm inner", v: { "@_text": "1", "@_value": "1" } },
      ],
    });
  });

  it("skips a list literal on a non-itemList property with an attributeNonScalar warning", async () => {
    const result = await exportSwNet(
      ["module main", "  inst CLAMP gate (min=[a=1]) : value=4 -> out=gate_out", "end"].join("\n"),
    );

    const group = result.tree.microprocessor.group as {
      components: { c: Array<{ "@_type"?: string; object: Record<string, unknown> }> };
    };
    const clampObject = group.components.c[0]?.object;

    expect(clampObject).not.toHaveProperty("min");
    expect(result.warnings.some((warning) => warning.messageId === "export.attributeNonScalar")).toBe(true);
  });
});
