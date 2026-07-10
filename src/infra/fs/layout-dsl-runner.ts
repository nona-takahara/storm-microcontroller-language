// Shared layout-dsl execution core used by both the CLI (`storm-mcl layout-dsl`) and the MCP
// `layout_dsl` tool, so the two front ends stay behaviorally identical.
import { computeSwNetModuleLayout, type AutoLayoutExistingPositions } from "../../core/layout/auto-layout.js";
import { type IrVector2 } from "../../core/ir.js";
import { compareSwNetIdentifier, formatPortOccurrenceKey } from "../../core/serializers/sw-net-shared.js";
import { STORMWORKS_SW_MCL_FORMAT_VERSION, type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { type SwMclInstanceDocument, type SwMclPortDocument } from "../../core/serializers/sw-mcl.js";
import { type SwNetModule } from "../../core/parsers/sw-net.js";
import { type LayoutTarget, readSwNetAndOptionalSwMcl, writeSwMclDocument } from "./sw-net-layout-file-loader.js";

export interface RunLayoutDslTargetOptions {
  force: boolean;
  dryRun: boolean;
  gridSize?: number;
}

export interface LayoutDslTargetResult {
  target: LayoutTarget;
  ok: boolean;
  errorMessage?: string;
  warnings: string[];
  document?: StormworksSwMclDocument;
  written: boolean;
  summary?: { kept: number; added: number; overwritten: number };
}

// Compute (and unless dryRun, write) the layout for one resolved sw-net/sw-mcl target pair.
export async function runLayoutDslForTarget(
  target: LayoutTarget,
  options: RunLayoutDslTargetOptions,
): Promise<LayoutDslTargetResult> {
  const { swNet, existingSwMcl } = await readSwNetAndOptionalSwMcl(target.swNetPath, target.swMclPath);
  const selection = selectTargetModule(swNet.modules, target.moduleId, existingSwMcl?.moduleId);

  if (!selection) {
    const availableIds = swNet.modules.map((module) => module.id).join(", ") || "(none)";
    return {
      target,
      ok: false,
      errorMessage: `no target module found; use --module/module_id to select one of: ${availableIds}.`,
      warnings: [],
      written: false,
    };
  }

  const warnings = selection.skipped.map(
    (skippedModuleId) =>
      `module ${skippedModuleId} is outside layout-dsl's v1 scope (one module per file) and was left untouched; see issue #7.`,
  );

  const mode = options.force ? "force" : "fill";
  const existing = mode === "fill" ? buildExistingPositions(existingSwMcl) : undefined;
  const result = await computeSwNetModuleLayout(selection.module, {
    mode,
    existing,
    gridSize: options.gridSize,
  });
  warnings.push(...result.warnings);

  const document: StormworksSwMclDocument = {
    formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
    sourceName: target.documentId,
    moduleId: selection.module.id,
    ports: [...result.ports].sort(comparePorts),
    instances: [...result.instances].sort(compareInstances),
    warnings: [...(existingSwMcl?.warnings ?? [])],
  };

  const summary = summarizeLayoutChange(existingSwMcl, document, mode);

  if (!options.dryRun) {
    await writeSwMclDocument(target.swMclPath, document);
  }

  return { target, ok: true, warnings, document, written: !options.dryRun, summary };
}

// Select the module a sw-net document's layout applies to, mirroring sw-mcl.ts's selectSwMclSubmodule rule.
function selectTargetModule(
  modules: SwNetModule[],
  requestedModuleId: string | undefined,
  fallbackModuleId: string | undefined,
): { module: SwNetModule; skipped: string[] } | undefined {
  const preferredId = requestedModuleId ?? fallbackModuleId;
  const selected =
    (preferredId ? modules.find((module) => module.id === preferredId) : undefined) ??
    modules.find((module) => module.id === "main") ??
    (modules.length === 1 ? modules[0] : undefined);

  if (!selected) {
    return undefined;
  }

  return {
    module: selected,
    skipped: modules.filter((module) => module.id !== selected.id).map((module) => module.id),
  };
}

// Build the existing-position lookup fed to computeSwNetModuleLayout's fill mode.
function buildExistingPositions(existingSwMcl: StormworksSwMclDocument | undefined): AutoLayoutExistingPositions | undefined {
  if (!existingSwMcl) {
    return undefined;
  }

  const ports = new Map<string, IrVector2>(
    existingSwMcl.ports.map((port) => [formatPortOccurrenceKey(port.direction, port.name, port.occurrence), port.position]),
  );
  const instances = new Map<string, IrVector2>(
    existingSwMcl.instances.map((instance) => [instance.id, instance.position]),
  );

  return { ports, instances };
}

// Summarize how many port/instance layout entries were kept as-is, newly added, or overwritten.
function summarizeLayoutChange(
  existing: StormworksSwMclDocument | undefined,
  next: StormworksSwMclDocument,
  mode: "fill" | "force",
): { kept: number; added: number; overwritten: number } {
  const existingKeys = new Set([
    ...(existing?.ports ?? []).map((port) => `port:${formatPortOccurrenceKey(port.direction, port.name, port.occurrence)}`),
    ...(existing?.instances ?? []).map((instance) => `instance:${instance.id}`),
  ]);
  const nextKeys = [
    ...next.ports.map((port) => `port:${formatPortOccurrenceKey(port.direction, port.name, port.occurrence)}`),
    ...next.instances.map((instance) => `instance:${instance.id}`),
  ];

  let kept = 0;
  let added = 0;
  let overwritten = 0;

  for (const key of nextKeys) {
    if (!existingKeys.has(key)) {
      added += 1;
    } else if (mode === "force") {
      overwritten += 1;
    } else {
      kept += 1;
    }
  }

  return { kept, added, overwritten };
}

// Sort ports in the same diff-stable order sw-mcl.ts's serializer produces.
function comparePorts(left: SwMclPortDocument, right: SwMclPortDocument): number {
  const directionComparison = compareSwNetIdentifier(left.direction, right.direction);

  if (directionComparison !== 0) {
    return directionComparison;
  }

  const nameComparison = compareSwNetIdentifier(left.name, right.name);

  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.occurrence - right.occurrence;
}

// Sort instances in the same diff-stable order sw-mcl.ts's serializer produces.
function compareInstances(left: SwMclInstanceDocument, right: SwMclInstanceDocument): number {
  return compareSwNetIdentifier(left.id, right.id);
}
