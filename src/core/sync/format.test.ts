import { describe, expect, it } from "vitest";

import { createTranslator } from "../i18n/translator.js";
import { parseSourceDocumentTexts, resolveProjectSource, type StormworksProjectSource } from "../project-source.js";
import { buildSynchronizationPlan } from "./engine.js";
import { formatSynchronizationReport } from "./format.js";
import { type SynchronizationPlan } from "./types.js";

describe("formatSynchronizationReport", () => {
  it("lists every change and localizes warnings, conflicts, suggestions, and write state", () => {
    const plan: SynchronizationPlan = {
      applicable: false,
      changes: [
        { kind: "added", incoming: { nodeId: "new", definitionId: "ADD", instanceId: "n1" } },
        { kind: "removed", existing: { nodeId: "old", definitionId: "ABS", instanceId: "old" } },
        {
          kind: "updated",
          existing: { nodeId: "gain", definitionId: "PROPERTY_NUMBER", instanceId: "gain" },
          incoming: { nodeId: "n3", definitionId: "PROPERTY_NUMBER", instanceId: "n3" },
          propertyChanges: { value: { before: 1, after: 2 } },
        },
        {
          kind: "rewired",
          existing: { nodeId: "sink", definitionId: "SINK", instanceId: "sink" },
          incoming: { nodeId: "n4", definitionId: "SINK", instanceId: "n4" },
          connections: { before: ["in in <- old.out"], after: ["in in <- n1.out"] },
        },
      ],
      warnings: [{ kind: "layout-overwrite", reason: "", impacts: [{ moduleId: "main", instanceId: "n1" }], selectedPosition: { x: 2, y: 3 } }],
      conflicts: [{
        kind: "module-boundary",
        reason: "Port signal changed.",
        impacts: [{ moduleId: "main", instanceId: "port" }],
        suggestions: [{
          kind: "add-module-port",
          description: "Edit the public port explicitly.",
          impacts: [],
          details: { ports: ["input_a", "input_b"] },
        }],
      }],
      sourceEdits: [], project: project(), layouts: [],
      lua: { create: [], update: [{ documentPath: "main.sw-net", path: "scripts/stable.lua", text: "return 2" }], remove: [] },
      summary: { added: 1, removed: 1, updated: 1, rewired: 1, conflicts: 1 },
      proposedPositions: {},
    };
    const report = formatSynchronizationReport(plan, createTranslator("ja"), "blocked");

    expect(report).toContain("- 追加: n1 (ADD)");
    expect(report).toContain("- 削除: old (ABS)");
    expect(report).toContain("レイアウト上書き");
    expect(report).toContain("module境界");
    expect(report).toContain("編集候補: moduleポートを編集する");
    expect(report).toContain("property value: 1 -> 2");
    expect(report).toContain("接続: [in in <- old.out] -> [in in <- n1.out]");
    expect(report).toContain("Lua sidecar（1件）");
    expect(report).toContain("main.sw-net::scripts/stable.lua（本文は省略）");
    expect(report).toContain("理由: Port signal changed.");
    expect(report).toContain("ports: input_a, input_b");
    expect(report).toContain("ファイルは変更していません");

    const english = formatSynchronizationReport(plan, createTranslator("en"), "blocked");
    expect(english).toContain("property value: 1 -> 2");
    expect(english).toContain("connections: [in in <- old.out] -> [in in <- n1.out]");
    expect(english).toContain("Lua sidecars (1)");
    expect(english).toContain("Reason: Port signal changed.");
    expect(english).toContain("No files were written");
  });

  it("renders engine-produced boundary and Lua evidence instead of formatter-only fixture data", async () => {
    const boundaryExisting = sourceProject('module main\n  port in "a" : number\nend\n');
    const boundaryIncoming = sourceProject('module main\n  port in "b" : number\nend\n');
    const boundaryResolved = await resolveProjectSource(boundaryExisting);
    const boundaryPlan = buildSynchronizationPlan(boundaryResolved.value!, boundaryIncoming);
    const boundaryReport = formatSynchronizationReport(boundaryPlan, createTranslator("ja"), "blocked");
    expect(boundaryReport).toContain('in "a" : number');
    expect(boundaryReport).toContain("pinAssignments");
    expect(boundaryReport).toContain("ファイルは変更していません");

    const luaExisting = sourceProject(
      'module main\n  inst LUA stable (script_ref="scripts/stable.lua") : ->\nend\n',
      { "scripts/stable.lua": "old body" },
    );
    const luaIncoming = sourceProject(
      'module main\n  inst LUA n1 (script_ref="scripts/n1.lua") : ->\nend\n',
      { "scripts/n1.lua": "new body" },
    );
    const luaResolved = await resolveProjectSource(luaExisting);
    const luaPlan = buildSynchronizationPlan(luaResolved.value!, luaIncoming);
    const luaReport = formatSynchronizationReport(luaPlan, createTranslator("en"), "dry-run");
    expect(luaReport).toContain("main.sw-net::scripts/stable.lua (body not shown)");
    expect(luaReport).toContain("Dry run completed. No files were written.");
  });
});

function sourceProject(swNetText: string, scripts: Record<string, string> = {}): StormworksProjectSource {
  const entryDocument = parseSourceDocumentTexts({ documentId: "main.sw-net", swNetText, scripts }).value!;
  return { project: project(), entryDocument, entryModuleId: "main", warnings: [] };
}

function project(): SynchronizationPlan["project"] {
  return {
    formatVersion: "stormworks-project-json-v11", name: null, description: null,
    width: null, length: null, icon: null, nodes: [], submodule: null, warnings: [],
  };
}
