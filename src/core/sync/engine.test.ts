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
    expect(plan.changes.find((change) => change.kind === "added")).toEqual(expect.objectContaining({
      incoming: expect.objectContaining({ instanceId: "nz" }),
    }));
    expect(plan.changes.flatMap((change) => change.connections?.after ?? [])).toEqual(expect.arrayContaining([
      expect.stringContaining("nz.out"),
    ]));
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
    const boundary = plan.conflicts.find((conflict) => conflict.kind === "module-boundary");
    expect(boundary).toBeDefined();
    expect(boundary?.suggestions[0]?.details?.affectedPorts).toEqual(expect.arrayContaining([
      expect.stringContaining('in "a" : number'),
      expect.stringContaining('in "b" : number'),
    ]));
    expect(boundary?.suggestions[1]?.details?.pinAssignments).toEqual(expect.arrayContaining([
      expect.stringContaining("before: unbound"),
      expect.stringContaining("after: unbound"),
    ]));
    expect(boundary?.suggestions[2]?.details?.useBindings).toEqual(["entry module surface (no enclosing use)"]);
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

  it("keeps each node's own value and label on a no-op round trip through adjacent same-type nodes (issue #71)", async () => {
    // Regression test for issue #71: syncing XML that was freshly generated from this exact project
    // (a pure round trip, no external edits) previously swapped the value/n of two of three adjacent
    // same-definitionId nodes, because the XML importer assigns incoming instance ids independently
    // of the existing DSL instance names. The n display-label match must resolve the correspondence.
    const existingText = [
      "module main\n",
      '  inst PROPERTY_NUMBER overspeed_threshold (value=32, n="Over Speed Th. [m/s]") : ->\n',
      '  inst PROPERTY_NUMBER cam_advance_current_limit_base (value=210, n="Power Limit Current [A]") : ->\n',
      '  inst PROPERTY_NUMBER brake_current_limit_scale (value=290, n="Brake Limit@320kPa [A]") : ->\n',
      "end\n",
    ].join("");
    const existing = project(existingText, "old", [
      { id: "overspeed_threshold", type: "PROPERTY_NUMBER", position: { x: -9, y: -32 } },
      { id: "cam_advance_current_limit_base", type: "PROPERTY_NUMBER", position: { x: -7.75, y: -32 } },
      { id: "brake_current_limit_scale", type: "PROPERTY_NUMBER", position: { x: -6.5, y: -32 } },
    ]);
    const resolved = await resolveProjectSource(existing);
    expect(resolved.value).toBeDefined();

    const incoming = project([
      "module main\n",
      '  inst PROPERTY_NUMBER n50 (value=32, n="Over Speed Th. [m/s]") : ->\n',
      '  inst PROPERTY_NUMBER n51 (value=210, n="Power Limit Current [A]") : ->\n',
      '  inst PROPERTY_NUMBER n52 (value=290, n="Brake Limit@320kPa [A]") : ->\n',
      "end\n",
    ].join(""), "new", [
      { id: "n50", type: "PROPERTY_NUMBER", position: { x: -9, y: -32 } },
      { id: "n51", type: "PROPERTY_NUMBER", position: { x: -7.75, y: -32 } },
      { id: "n52", type: "PROPERTY_NUMBER", position: { x: -6.5, y: -32 } },
    ]);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings.some((warning) => warning.kind === "layout-overwrite")).toBe(false);
    expect(plan.applicable).toBe(true);
  });

  it("uses the exact path for twelve independent property-distinguished nodes regardless of the partial budget", async () => {
    const size = 12;
    const statements = (prefix: string, reverse = false) => {
      const indexes = Array.from({ length: size }, (_, index) => index);
      if (reverse) indexes.reverse();
      return [
        "module main\n",
        ...indexes.map((index) => `  inst PROPERTY_NUMBER ${prefix}${index} (value=${index}) : ->\n`),
        "end\n",
      ].join("");
    };
    const existing = project(statements("stable_"), "old", []);
    const incoming = project(statements("n", true), "new", []);
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming, { maxSearchSteps: 1 });

    expect(plan.applicable).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("keeps a uniquely labeled exact node matched when one ordinary property changes", async () => {
    const existing = project([
      "module main\n",
      '  inst PROPERTY_NUMBER gain (value=1, n="Gain") : ->\n',
      '  inst PROPERTY_NUMBER limit (value=10, n="Limit") : ->\n',
      "end\n",
    ].join(""), "old", []);
    const incoming = project([
      "module main\n",
      '  inst PROPERTY_NUMBER n1 (value=2, n="Gain") : ->\n',
      '  inst PROPERTY_NUMBER n2 (value=10, n="Limit") : ->\n',
      "end\n",
    ].join(""), "new", []);
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        kind: "updated",
        existing: expect.objectContaining({ instanceId: "gain" }),
        propertyChanges: { value: { before: 1, after: 2 } },
      }),
    ]);
  });

  it("allows multiple exact correspondences when every projected output is identical", async () => {
    const existing = project("module main\n  inst TYPE stable_a : ->\n  inst TYPE stable_b : ->\nend\n", "old", []);
    const incoming = project("module main\n  inst TYPE n1 : ->\n  inst TYPE n2 : ->\nend\n", "new", []);
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming, { maxSearchSteps: 0 });

    expect(plan.applicable).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("evaluates separate exact ambiguity groups independently", async () => {
    const statements = (prefix: string) => [
      "module main\n",
      `  inst PROPERTY_NUMBER ${prefix}one_a (value=1) : ->\n`,
      `  inst PROPERTY_NUMBER ${prefix}one_b (value=1) : ->\n`,
      `  inst PROPERTY_NUMBER ${prefix}two_a (value=2) : ->\n`,
      `  inst PROPERTY_NUMBER ${prefix}two_b (value=2) : ->\n`,
      "end\n",
    ].join("");
    const existing = project(statements("stable_"), "old", []);
    const incoming = project(statements("n_"), "new", []);
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("retains a matched Lua node's existing script_ref and sidecar path while updating its body", async () => {
    const existing = project(
      'module main\n  inst LUA stable (script_ref="scripts/stable.lua") : ->\nend\n',
      "old",
      [],
      "main",
      { "scripts/stable.lua": "return 1" },
    );
    const incoming = project(
      'module main\n  inst LUA n42 (script_ref="scripts/n42.lua") : ->\nend\n',
      "new",
      [],
      "main",
      { "scripts/n42.lua": "return 2" },
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.lua).toEqual({
      create: [],
      update: [{ documentPath: "main.sw-net", path: "scripts/stable.lua", text: "return 2" }],
      remove: [],
    });
    expect(plan.changes).toEqual([]);
  });

  it("blocks exact alternatives that would send different Lua bodies to different existing sidecars", async () => {
    const existing = project(
      [
        "module main\n",
        '  inst LUA stable_a (script_ref="scripts/stable_a.lua") : ->\n',
        '  inst LUA stable_b (script_ref="scripts/stable_b.lua") : ->\n',
        "end\n",
      ].join(""),
      "old",
      [],
      "main",
      { "scripts/stable_a.lua": "old a", "scripts/stable_b.lua": "old b" },
    );
    const incoming = project(
      [
        "module main\n",
        '  inst LUA n1 (script_ref="scripts/n1.lua") : ->\n',
        '  inst LUA n2 (script_ref="scripts/n2.lua") : ->\n',
        "end\n",
      ].join(""),
      "new",
      [],
      "main",
      { "scripts/n1.lua": "new a", "scripts/n2.lua": "new b" },
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(false);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        kind: "ambiguous-correspondence",
        reason: expect.stringContaining("Lua"),
      }),
    ]);
    expect(plan.sourceEdits).toEqual([]);
  });

  it("does not remove a deleted Lua node's sidecar while a retained node still references it", async () => {
    const existing = project(
      [
        "module main\n",
        '  inst LUA stable_a (script_ref="scripts/shared.lua", n="A") : ->\n',
        '  inst LUA stable_b (script_ref="scripts/shared.lua", n="B") : ->\n',
        "end\n",
      ].join(""),
      "old",
      [],
      "main",
      { "scripts/shared.lua": "shared body" },
    );
    const incoming = project(
      'module main\n  inst LUA n1 (script_ref="scripts/n1.lua", n="A") : ->\nend\n',
      "new",
      [],
      "main",
      { "scripts/n1.lua": "shared body" },
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.lua).toEqual({ create: [], update: [], remove: [] });
    expect(materializeSynchronizationSources(resolved.value!, plan)["main.sw-net"]).toContain(
      'script_ref="scripts/shared.lua"',
    );
  });

  it("fans one incoming shared Lua body out to each matched existing sidecar", async () => {
    const existing = project(
      [
        "module main\n",
        '  inst LUA stable_a (script_ref="scripts/stable_a.lua", n="A") : ->\n',
        '  inst LUA stable_b (script_ref="scripts/stable_b.lua", n="B") : ->\n',
        "end\n",
      ].join(""),
      "old",
      [],
      "main",
      { "scripts/stable_a.lua": "old a", "scripts/stable_b.lua": "old b" },
    );
    const incoming = project(
      [
        "module main\n",
        '  inst LUA n1 (script_ref="scripts/shared.lua", n="A") : ->\n',
        '  inst LUA n2 (script_ref="scripts/shared.lua", n="B") : ->\n',
        "end\n",
      ].join(""),
      "new",
      [],
      "main",
      { "scripts/shared.lua": "new shared body" },
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.lua).toEqual({
      create: [],
      update: [
        { documentPath: "main.sw-net", path: "scripts/stable_a.lua", text: "new shared body" },
        { documentPath: "main.sw-net", path: "scripts/stable_b.lua", text: "new shared body" },
      ],
      remove: [],
    });
  });

  it("plans a matched imported-module Lua update against its owning document", async () => {
    const entry = parseSourceDocumentTexts({
      documentId: "main.sw-net",
      swNetText: 'import helper from "./modules/sub.sw-net"\nmodule main\n  use helper.main child : ->\nend\n',
    }).value!;
    const imported = parseSourceDocumentTexts({
      documentId: "modules/sub.sw-net",
      swNetText: 'module main\n  inst LUA controller (script_ref="scripts/controller.lua", n="Controller") : ->\nend\n',
      scripts: { "scripts/controller.lua": "old body" },
    }).value!;
    const existing: StormworksProjectSource = {
      ...project("module main\nend\n", "old", []),
      entryDocument: entry,
    };
    const resolved = await resolveProjectSource(existing, { loadImportedDocument: async () => imported });
    expect(resolved.value).toBeDefined();
    const incoming = project(
      'module main\n  inst LUA n1 (script_ref="scripts/n1.lua", n="Controller") : ->\nend\n',
      "new",
      [],
      "main",
      { "scripts/n1.lua": "new body" },
    );

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.lua).toEqual({
      create: [],
      update: [{ documentPath: "modules/sub.sw-net", path: "scripts/controller.lua", text: "new body" }],
      remove: [],
    });
  });

  it("reserves one collision-free name for a new Lua instance and its sidecar", async () => {
    const existing = project(
      "module main\n  inst SOURCE source : -> out=wire\n  inst SINK sink : in=wire ->\nend\n",
      "old",
      [],
      "main",
      { "scripts/nadded.lua": "unreferenced existing body" },
    );
    const incoming = project(
      [
        "module main\n",
        "  inst SOURCE x : -> out=a\n",
        '  inst LUA added (script_ref="scripts/added.lua") : in=a -> out=b\n',
        "  inst SINK y : in=b ->\n",
        "end\n",
      ].join(""),
      "new",
      [],
      "main",
      { "scripts/added.lua": "new body" },
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(true);
    expect(plan.lua.create).toEqual([
      { documentPath: "main.sw-net", path: "scripts/nadded_2.lua", text: "new body" },
    ]);
    expect(plan.lua.remove).toEqual([{ documentPath: "main.sw-net", path: "scripts/nadded.lua" }]);
    expect(materializeSynchronizationSources(resolved.value!, plan)["main.sw-net"]).toContain(
      'inst LUA nadded_2 (script_ref="scripts/nadded_2.lua")',
    );
  });

  it("blocks as ambiguous when same-type nodes collide on every signal (issue #71 safety)", async () => {
    // Companion safety test: two same-type nodes share the same n label and their property values
    // also don't line up across the two sides, so no signal disambiguates them. The engine must
    // keep refusing to silently guess a correspondence here, the same way it already does for
    // fully symmetric nodes with no properties at all.
    const existing = project([
      "module main\n",
      '  inst PROPERTY_NUMBER gain_a (value=1, n="Gain") : ->\n',
      '  inst PROPERTY_NUMBER gain_b (value=2, n="Gain") : ->\n',
      "end\n",
    ].join(""), "old", [
      { id: "gain_a", type: "PROPERTY_NUMBER", position: { x: 0, y: 0 } },
      { id: "gain_b", type: "PROPERTY_NUMBER", position: { x: 1, y: 0 } },
    ]);
    const resolved = await resolveProjectSource(existing);
    expect(resolved.value).toBeDefined();

    const incoming = project([
      "module main\n",
      '  inst PROPERTY_NUMBER m1 (value=3, n="Gain") : ->\n',
      '  inst PROPERTY_NUMBER m2 (value=4, n="Gain") : ->\n',
      "end\n",
    ].join(""), "new", [
      { id: "m1", type: "PROPERTY_NUMBER", position: { x: 0, y: 0 } },
      { id: "m2", type: "PROPERTY_NUMBER", position: { x: 1, y: 0 } },
    ]);
    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.applicable).toBe(false);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        kind: "ambiguous-correspondence",
        reason: expect.stringContaining("exact structural correspondences"),
      }),
    ]);
  });

  it("reports partial search exhaustion separately from a proven output-changing ambiguity", async () => {
    const existing = project("module main\n  inst TYPE a : ->\n  inst TYPE b : ->\nend\n", "old", []);
    const incoming = project(
      "module main\n  inst TYPE x : -> out=wire\n  inst TYPE y : in=wire ->\nend\n",
      "new",
      [],
    );
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming, { maxSearchSteps: 0 });

    expect(plan.applicable).toBe(false);
    expect(plan.conflicts[0]).toEqual(expect.objectContaining({
      kind: "ambiguous-correspondence",
      reason: expect.stringContaining("search exhausted its budget"),
    }));
    expect(plan.conflicts[0]?.reason).toContain("remain unresolved");
  });

  it("accepts partial correspondence alternatives when every projected output is identical", async () => {
    const existing = project([
      "module main\n",
      "  inst TYPE a : ->\n",
      "  inst TYPE b : ->\n",
      "  inst SOURCE source : -> out=wire\n",
      "  inst SINK sink : in=wire ->\n",
      "end\n",
    ].join(""), "old", []);
    const incoming = project([
      "module main\n",
      "  inst TYPE x : ->\n",
      "  inst TYPE y : ->\n",
      "  inst SOURCE incoming_source : -> out=unused\n",
      "  inst SINK incoming_sink : ->\n",
      "end\n",
    ].join(""), "new", []);
    const resolved = await resolveProjectSource(existing);

    const plan = buildSynchronizationPlan(resolved.value!, incoming);

    expect(plan.conflicts.filter((conflict) => conflict.kind === "ambiguous-correspondence")).toEqual([]);
    expect(plan.applicable).toBe(true);
    expect(plan.summary.rewired).toBeGreaterThan(0);
  });
});

function project(
  swNetText: string,
  name: string,
  instances: Array<{ id: string; type: string; position: { x: number; y: number } }>,
  moduleId = "main",
  scripts: Record<string, string> = {},
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
    scripts,
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
