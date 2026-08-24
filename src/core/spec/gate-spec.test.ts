import { describe, expect, it } from "vitest";

import type { NodeBehaviorNotesDocument } from "../behavior-notes/schema.js";
import { createNodeDefinitionRegistry } from "../definitions/loader.js";
import type { NodeDefinitionsDocument } from "../definitions/schema.js";
import { buildGateSpec, formatGateSpecText } from "./gate-spec.js";

const emptyNotes: NodeBehaviorNotesDocument = {
  schemaVersion: "1",
  generatedFrom: "test",
  entries: {},
};

describe("gate spec port controls", () => {
  it("exposes a fixed port activation condition and omits an inactive port from the default example", () => {
    const spec = buildGateSpec(
      "CONDITIONAL_READ",
      createNodeDefinitionRegistry(definitions({
        id: "CONDITIONAL_READ",
        displayName: "Conditional Read",
        category: "test",
        stormworks: { type: "1" },
        ports: {
          inputs: [
            { key: "source", signal: "composite" },
            {
              key: "channel_input",
              signal: "number",
              activeWhen: { property: "channel", equals: -1 },
            },
          ],
          outputs: [{ key: "out", signal: "number" }],
        },
        properties: [{ key: "channel", valueType: "number", required: false }],
        defaults: { channel: 1 },
      })),
      emptyNotes,
    );

    expect(spec?.inputs[1]?.activeWhen).toEqual({ property: "channel", equals: -1 });
    expect(spec?.usageExample).toContain("source=sourceNet");
    expect(spec?.usageExample).not.toContain("channel_input=");
    expect(formatGateSpecText(spec!)).toContain("active when channel=-1");
  });

  it("keeps property-counted dynamic inputs structured and present in the default example", () => {
    const spec = buildGateSpec(
      "DYNAMIC_WRITE",
      createNodeDefinitionRegistry(definitions({
        id: "DYNAMIC_WRITE",
        displayName: "Dynamic Write",
        category: "test",
        stormworks: {
          type: "2",
          dynamicInputs: { prefix: "in", countProperty: "count", startIndex: 1, signal: "number" },
        },
        ports: {
          inputs: [{ key: "inc", signal: "composite" }],
          outputs: [{ key: "out", signal: "composite" }],
        },
        properties: [{ key: "count", valueType: "number", required: true }],
        defaults: { count: 2 },
      })),
      emptyNotes,
    );

    expect(spec?.dynamicInputs).toMatchObject({ countProperty: "count", exampleKeys: ["in1", "in2"] });
    expect(spec?.usageExample).toContain("in1=in1Net, in2=in2Net");
  });
});

function definitions(component: NodeDefinitionsDocument["components"][number]): NodeDefinitionsDocument {
  return { schemaVersion: "11", nodes: [], components: [component] };
}
