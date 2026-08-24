import { describe, expect, it } from "vitest";

import { NODE_DEFINITIONS_SCHEMA_VERSION, NodeDefinitionsSchemaError, parseNodeDefinitionsDocument } from "./schema.js";

describe("node definitions schema", () => {
  it("parses a DSL-level property activation condition on a fixed port", () => {
    const document = parseNodeDefinitionsDocument({
      schemaVersion: NODE_DEFINITIONS_SCHEMA_VERSION,
      nodes: [],
      components: [
        {
          id: "CONDITIONAL_INPUT",
          displayName: "Conditional Input",
          category: "test",
          stormworks: { type: "1" },
          ports: {
            inputs: [
              {
                key: "value_input",
                signal: "number",
                activeWhen: { property: "value", equals: -1 },
              },
            ],
            outputs: [],
          },
          properties: [{ key: "value", valueType: "number" }],
          defaults: { value: 1 },
        },
      ],
    });

    expect(document.components[0]?.ports.inputs[0]?.activeWhen).toEqual({ property: "value", equals: -1 });
  });

  it("rejects a non-scalar activation value with the condition's exact schema path", () => {
    expect(() =>
      parseNodeDefinitionsDocument({
        schemaVersion: NODE_DEFINITIONS_SCHEMA_VERSION,
        nodes: [],
        components: [
          {
            id: "CONDITIONAL_INPUT",
            displayName: "Conditional Input",
            category: "test",
            stormworks: { type: "1" },
            ports: {
              inputs: [
                {
                  key: "value_input",
                  signal: "number",
                  activeWhen: { property: "value", equals: [] },
                },
              ],
              outputs: [],
            },
          },
        ],
      }),
    ).toThrowError(
      new NodeDefinitionsSchemaError("Expected a scalar value", "$.components[0].ports.inputs[0].activeWhen.equals"),
    );
  });
});
