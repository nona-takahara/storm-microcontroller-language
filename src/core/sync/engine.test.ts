import { describe, expect, it } from "vitest";

import { parseSourceDocumentTexts, resolveProjectSource, type StormworksProjectSource } from "../project-source.js";
import { STORMWORKS_PROJECT_JSON_FORMAT_VERSION } from "../serializers/project-json.js";
import { STORMWORKS_SW_MCL_FORMAT_VERSION } from "../serializers/sw-mcl.js";
import { buildSynchronizationPlan, materializeSynchronizationSources } from "./engine.js";

describe("buildSynchronizationPlan", () => {
  it("projects rename-independent updates, rewiring, additions, layout, and metadata into one module", async () => {
    const existingText = [
      "# keep heading\n",
      "module main\n",
      "  inst SOURCE source (value=1) : -> out=wire # keep inline\n",
      "  inst SINK sink : in=wire ->\n",
      "end\n",
    ].join("");
    const existing = project(existingText, "old", [
      { id: "source", type: "SOURCE", position: { x: 1, y: 1 } },
      { id: "sink", type: "SINK", position: { x: 2, y: 1 } },
    ]);
    const resolved = await resolveProjectSource(existing);
    expect(resolved.value).toBeDefined();

    const incoming = project([
      "module generated\n",
      "  inst SOURCE x (value=2) : -> out=a\n",
      "  inst MIDDLE z : in=a -> out=b\n",
      "  inst SINK y : in=b ->\n",
      "end\n",
    ].join(""), "new", [
      { id: "x", type: "SOURCE", position: { x: 10, y: 10 } },
      { id: "z", type: "MIDDLE", position: { x: 20, y: 10 } },
      { id: "y", type: "SINK", position: { x: 30, y: 10 } },
    ], "generated");
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.warnings.some((warning) => warning.kind === "layout-overwrite")).toBe(true);
    expect(plan.summary).toMatchObject({ added: 1, removed: 0, updated: 1 });
    expect(plan.project.name).toBe("new");
    expect(plan.project.submodule).toEqual(existing.project.submodule);
    const materialized = materializeSynchronizationSources(resolved.value!, plan)["main.sw-net"]!;
    expect(materialized).toContain("# keep heading");
    expect(materialized).toContain("# keep inline");
    expect(materialized).toContain("inst SOURCE source (value=2)");
    expect(materialized).toContain("inst MIDDLE nz : in=wire -> out=nz_out");
    expect(materialized).toContain("inst SINK sink : in=nz_out ->");
  });

  it("blocks unmatched project ports as module-boundary changes", async () => {
    const existing = project('module main\n  port in "a" : number\nend\n', "old", []);
    const incoming = project('module main\n  port in "b" : number\nend\n', "new", []);
    const resolved = await resolveProjectSource(existing);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(false);
    expect(plan.conflicts.some((conflict) => conflict.kind === "module-boundary")).toBe(true);
    expect(plan.sourceEdits).toEqual([]);
  });

  it("reports and applies a newly added node as an individual change", async () => {
    const existing = project([
      "module main\n",
      "  inst SOURCE source : -> out=wire\n",
      "  inst SINK sink : in=wire ->\n",
      "end\n",
    ].join(""), "old", []);
    const incoming = project([
      "module main\n",
      "  inst SOURCE renamed_source : -> out=a\n",
      "  inst MIDDLE added : in=a -> out=b\n",
      "  inst SINK renamed_sink : in=b ->\n",
      "end\n",
    ].join(""), "new", []);
    const resolved = await resolveProjectSource(existing);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.changes.filter((change) => change.kind === "added")).toEqual([
      expect.objectContaining({ incoming: expect.objectContaining({ nodeId: "added", definitionId: "MIDDLE" }) }),
    ]);
    expect(materializeSynchronizationSources(resolved.value!, plan)["main.sw-net"]).toContain(
      "inst MIDDLE nadded",
    );
  });

  it("reports and applies a removed node as an individual change", async () => {
    const existing = project([
      "module main\n",
      "  inst SOURCE source : -> out=a\n",
      "  inst MIDDLE middle : in=a -> out=b\n",
      "  inst SINK sink : in=b ->\n",
      "end\n",
    ].join(""), "old", []);
    const incoming = project([
      "module main\n",
      "  inst SOURCE renamed_source : -> out=direct\n",
      "  inst SINK renamed_sink : in=direct ->\n",
      "end\n",
    ].join(""), "new", []);
    const resolved = await resolveProjectSource(existing);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.changes.filter((change) => change.kind === "removed")).toEqual([
      expect.objectContaining({ existing: expect.objectContaining({ instanceId: "middle", definitionId: "MIDDLE" }) }),
    ]);
    const materialized = materializeSynchronizationSources(resolved.value!, plan)["main.sw-net"]!;
    expect(materialized).not.toContain("inst MIDDLE middle");
    expect(materialized).toContain("inst SINK sink : in=a ->");
  });

  it("lists every old and new node when the circuits are completely different", async () => {
    const existing = project([
      "module main\n",
      "  inst OLD_A old_a : ->\n",
      "  inst OLD_B old_b : ->\n",
      "end\n",
    ].join(""), "old", []);
    const incoming = project([
      "module main\n",
      "  inst NEW_A new_a : ->\n",
      "  inst NEW_B new_b : ->\n",
      "end\n",
    ].join(""), "new", []);
    const resolved = await resolveProjectSource(existing);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.changes.filter((change) => change.kind === "removed").map((change) => change.existing?.nodeId)).toEqual([
      "old_a",
      "old_b",
    ]);
    expect(plan.changes.filter((change) => change.kind === "added").map((change) => change.incoming?.nodeId)).toEqual([
      "new_a",
      "new_b",
    ]);
    expect(plan.applicable).toBe(false);
    expect(plan.conflicts.every((conflict) => conflict.kind === "module-boundary")).toBe(true);
  });
});

function project(
  swNetText: string,
  name: string,
  instances: Array<{ id: string; type: string; position: { x: number; y: number } }>,
  moduleId = "main",
): StormworksProjectSource {
  const parsed = parseSourceDocumentTexts({
    documentId: "main.sw-net",
    swNetText,
    swMclText: JSON.stringify({
      formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
      moduleId,
      ports: [],
      instances,
      warnings: [],
    }),
  });
  if (!parsed.value) throw new Error("fixture parse failed");
  return {
    project: {
      formatVersion: STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
      name,
      description: null,
      width: 1,
      length: 1,
      icon: null,
      nodes: [],
      submodule: { name: "main", relativePath: "main.sw-net" },
      warnings: [],
    },
    entryDocument: parsed.value,
    entryModuleId: moduleId,
    warnings: [],
  };
}
