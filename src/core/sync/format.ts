import { type Translator } from "../i18n/index.js";
import {
  type SynchronizationChangeKind,
  type SynchronizationConflictKind,
  type SynchronizationImpact,
  type SynchronizationManualSuggestion,
  type SynchronizationPlan,
} from "./types.js";

export type SynchronizationReportOutcome = "written" | "dry-run" | "blocked";

/** Format the complete human-facing sync report in the selected CLI language. */
export function formatSynchronizationReport(
  plan: SynchronizationPlan,
  translator: Translator,
  outcome: SynchronizationReportOutcome,
): string {
  const lines: string[] = [translator.format("sync.changes", { count: plan.changes.length })];
  for (const change of plan.changes) {
    const node = change.incoming ?? change.existing;
    lines.push(translator.format("sync.change", {
      kind: formatChangeKind(change.kind, translator),
      node: formatNode(node),
    }));
    for (const [key, values] of Object.entries(change.propertyChanges ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(translator.format("sync.change.property", {
        key,
        before: formatValue(values.before),
        after: formatValue(values.after),
      }));
    }
    if (change.connections && (change.connections.before.length > 0 || change.connections.after.length > 0)) {
      lines.push(translator.format("sync.change.connections", {
        before: change.connections.before.join(", ") || "-",
        after: change.connections.after.join(", ") || "-",
      }));
    }
  }

  const luaItems = [
    ...plan.lua.create.map((script) => translator.format("sync.lua.change", { kind: translator.format("sync.kind.added"), path: formatLuaPath(script) })),
    ...plan.lua.update.map((script) => translator.format("sync.lua.change", { kind: translator.format("sync.kind.updated"), path: formatLuaPath(script) })),
    ...plan.lua.remove.map((script) => translator.format("sync.lua.change", { kind: translator.format("sync.kind.removed"), path: formatLuaPath(script) })),
  ];
  if (luaItems.length > 0) lines.push("", translator.format("sync.lua", { count: luaItems.length }), ...luaItems);

  if (plan.warnings.length > 0) {
    lines.push("", translator.format("sync.warnings", { count: plan.warnings.length }));
    for (const warning of plan.warnings) {
      const position = warning.selectedPosition
        ? ` => (${warning.selectedPosition.x}, ${warning.selectedPosition.y})`
        : "";
      lines.push(translator.format("sync.warning", {
        kind: translator.format(warning.kind === "layout-overwrite" ? "sync.warning.layout-overwrite" : "sync.warning.layout-projection"),
        impacts: `${warning.impacts.map(formatImpact).join(", ")}${position}`,
      }));
      if (warning.reason) lines.push(translator.format("sync.reason", { reason: warning.reason }));
    }
  }

  if (plan.conflicts.length > 0) {
    lines.push("", translator.format("sync.conflicts", { count: plan.conflicts.length }));
    for (const conflict of plan.conflicts) {
      lines.push(translator.format("sync.conflict", {
        kind: formatConflictKind(conflict.kind, translator),
        impacts: conflict.impacts.map(formatImpact).join(", "),
      }));
      lines.push(translator.format("sync.reason", { reason: conflict.reason }));
      for (const suggestion of conflict.suggestions) {
        lines.push(translator.format("sync.suggestion", {
          suggestion: formatSuggestion(suggestion.kind, translator),
        }));
        if (suggestion.description) lines.push(translator.format("sync.suggestion.description", { description: suggestion.description }));
        for (const [key, value] of Object.entries(suggestion.details ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
          lines.push(translator.format("sync.suggestion.detail", {
            key,
            value: Array.isArray(value) ? value.join(", ") : value,
          }));
        }
      }
    }
  }

  lines.push("", translator.format("sync.summary", plan.summary));
  lines.push(translator.format(
    outcome === "written"
      ? "sync.result.written"
      : outcome === "dry-run"
        ? "sync.result.dryRun"
        : "sync.result.blocked",
  ));
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  return value === undefined ? "<absent>" : JSON.stringify(value);
}

function formatLuaPath(script: { documentPath: string; path: string }): string {
  return `${script.documentPath}::${script.path}`;
}

function formatNode(node: SynchronizationPlan["changes"][number]["incoming"]): string {
  if (!node) return "?";
  const location = [node.documentPath, node.moduleId, ...(node.usePath ?? []), node.instanceId]
    .filter((item): item is string => Boolean(item)).join("::");
  return `${location || node.nodeId} (${node.definitionId})`;
}

function formatImpact(impact: SynchronizationImpact): string {
  return [impact.documentPath, impact.moduleId, ...(impact.usePath ?? []), impact.instanceId]
    .filter((item): item is string => Boolean(item)).join("::") || "?";
}

function formatChangeKind(kind: SynchronizationChangeKind, translator: Translator): string {
  switch (kind) {
    case "added": return translator.format("sync.kind.added");
    case "removed": return translator.format("sync.kind.removed");
    case "updated": return translator.format("sync.kind.updated");
    case "rewired": return translator.format("sync.kind.rewired");
  }
}

function formatConflictKind(kind: SynchronizationConflictKind, translator: Translator): string {
  switch (kind) {
    case "module-boundary": return translator.format("sync.conflict.module-boundary");
    case "shared-module-divergence": return translator.format("sync.conflict.shared-module-divergence");
    case "ambiguous-correspondence": return translator.format("sync.conflict.ambiguous-correspondence");
    case "ambiguous-placement": return translator.format("sync.conflict.ambiguous-placement");
    case "layout-projection": return translator.format("sync.conflict.layout-projection");
  }
}

function formatSuggestion(kind: SynchronizationManualSuggestion["kind"], translator: Translator): string {
  switch (kind) {
    case "add-module-port": return translator.format("sync.suggestion.add-module-port");
    case "add-pin-assignment": return translator.format("sync.suggestion.add-pin-assignment");
    case "add-use-binding": return translator.format("sync.suggestion.add-use-binding");
    case "duplicate-module": return translator.format("sync.suggestion.duplicate-module");
    case "update-shared-module": return translator.format("sync.suggestion.update-shared-module");
    case "review-candidates": return translator.format("sync.suggestion.review-candidates");
  }
}
