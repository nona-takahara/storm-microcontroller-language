import { describe, expect, it } from "vitest";

import { createTranslator } from "../i18n/translator.js";
import { formatSynchronizationReport } from "./format.js";
import { type SynchronizationPlan } from "./types.js";

describe("formatSynchronizationReport", () => {
  it("lists every change and localizes warnings, conflicts, suggestions, and write state", () => {
    const plan: SynchronizationPlan = {
      applicable: false,
      changes: [
        { kind: "added", incoming: { nodeId: "new", definitionId: "ADD", instanceId: "n1" } },
        { kind: "removed", existing: { nodeId: "old", definitionId: "ABS", instanceId: "old" } },
      ],
      warnings: [{ kind: "layout-overwrite", reason: "", impacts: [{ moduleId: "main", instanceId: "n1" }], selectedPosition: { x: 2, y: 3 } }],
      conflicts: [{
        kind: "module-boundary",
        reason: "",
        impacts: [{ moduleId: "main", instanceId: "port" }],
        suggestions: [{ kind: "add-module-port", description: "", impacts: [] }],
      }],
      sourceEdits: [], project: project(), layouts: [],
      lua: { create: {}, update: {}, remove: [] },
      summary: { added: 1, removed: 1, updated: 0, rewired: 0, conflicts: 1 },
      proposedPositions: {},
    };
    const report = formatSynchronizationReport(plan, createTranslator("ja"), "blocked");

    expect(report).toContain("- 追加: n1 (ADD)");
    expect(report).toContain("- 削除: old (ABS)");
    expect(report).toContain("レイアウト上書き");
    expect(report).toContain("module境界");
    expect(report).toContain("編集候補: moduleポートを編集する");
    expect(report).toContain("ファイルは変更していません");
  });
});

function project(): SynchronizationPlan["project"] {
  return {
    formatVersion: "stormworks-project-json-v11", name: null, description: null,
    width: null, length: null, icon: null, nodes: [], submodule: null, warnings: [],
  };
}
