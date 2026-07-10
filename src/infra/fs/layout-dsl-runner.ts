// Shared layout-dsl execution core used by both the CLI (`storm-mcl layout-dsl`) and the MCP
// `layout_dsl` tool, so the two front ends stay behaviorally identical.
import { computeSwNetModuleLayout, type AutoLayoutExistingPositions } from "../../core/layout/auto-layout.js";
import { type IrVector2 } from "../../core/ir.js";
import { compareSwNetIdentifier, formatPortNameKey, formatPortOccurrenceKey } from "../../core/serializers/sw-net-shared.js";
import { STORMWORKS_SW_MCL_FORMAT_VERSION, type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { type SwMclInstanceDocument, type SwMclPortDocument } from "../../core/serializers/sw-mcl.js";
import { type SwNetDocument, type SwNetModule } from "../../core/parsers/sw-net.js";
import { replaceSwNetExtension } from "./project-source-file-loader.js";
import { resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";
import {
  type LayoutTarget,
  readSwNetAndOptionalSwMcl,
  resolveLayoutTargets,
  resolveSubmoduleFootprints,
  writeSwMclDocument,
} from "./sw-net-layout-file-loader.js";

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

  const submoduleFootprintResult = await resolveSubmoduleFootprints(target.swNetPath, swNet, selection.module);
  warnings.push(...submoduleFootprintResult.warnings);

  const mode = options.force ? "force" : "fill";
  const existing = mode === "fill" ? buildExistingPositions(existingSwMcl) : undefined;
  const result = await computeSwNetModuleLayout(selection.module, {
    mode,
    existing,
    gridSize: options.gridSize,
    submoduleFootprints: submoduleFootprintResult.footprints,
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
export function selectTargetModule(
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

// Check whether every port/instance a module declares already has a matching .sw-mcl layout entry,
// using the same occurrence-numbering scheme as computeSwNetModuleLayout/buildPortSlots. Callers use
// this to decide whether an implicit auto-layout pass is actually needed before invoking ELK.
export function isModuleLayoutComplete(
  module: SwNetModule,
  existingSwMcl: StormworksSwMclDocument | undefined,
): boolean {
  if (!existingSwMcl) {
    return false;
  }

  const instanceIds = new Set(existingSwMcl.instances.map((instance) => instance.id));

  if (module.statements.some((statement) => !instanceIds.has(statement.instanceId))) {
    return false;
  }

  const portKeys = new Set(
    existingSwMcl.ports.map((port) => formatPortOccurrenceKey(port.direction, port.name, port.occurrence)),
  );
  const occurrenceByKey = new Map<string, number>();

  for (const port of module.ports) {
    const nameKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByKey.get(nameKey) ?? 0) + 1;
    occurrenceByKey.set(nameKey, occurrence);

    if (!portKeys.has(formatPortOccurrenceKey(port.direction, port.name, occurrence))) {
      return false;
    }
  }

  return true;
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

export interface EnsureProjectLayoutResult {
  // One line per notice worth surfacing to the caller (auto-generated layout, or per-target
  // failures). Empty when every reachable module's .sw-mcl was already complete.
  messages: string[];
}

// Fill in any missing/incomplete .sw-mcl layout data via ELK auto-layout before dsl2xml/dsl2xml-tree
// (CLI) or dsl_to_xml (MCP) consume it, so a missing or partial .sw-mcl degrades to computed
// positions instead of the exporter's cruder shared-anchor/omitted-<pos> fallback (see
// src/core/exporters/xml-tree.ts's resolveInstancePosition). Best-effort: .sw-mcl has always been an
// optional input (CLAUDE.md), so failures here are reported as messages but never thrown — the
// caller's normal load/export flow still runs afterward and will surface any real, blocking problem.
//
// Covers every module reachable from the project, not just project.json's declared submodules:
// resolveLayoutTargets({ allSubmodules: true }) alone would (a) return nothing at all for the
// supported "no submodules array, fall back to main.sw-net" project.json shape, and (b) never look
// past project.json into cross-file `use ... from` imports (e.g. a main.sw-net that composes a
// separately-authored control_handle.sw-net) — both of which would silently leave those modules on
// the old degraded fallback. So this seeds from the entry module plus every declared submodule, then
// recursively follows each module's own imports the same way resolveSubmoduleFootprints does for
// footprint sizing.
export async function ensureProjectLayoutIsComplete(projectJsonPath: string): Promise<EnsureProjectLayoutResult> {
  const messages: string[] = [];
  let seedTargets: LayoutTarget[];

  try {
    const [entryTarget, declaredSubmoduleTargets] = await Promise.all([
      resolveLayoutTargets(projectJsonPath, {}),
      resolveLayoutTargets(projectJsonPath, { allSubmodules: true }),
    ]);
    seedTargets = dedupeLayoutTargets([...entryTarget, ...declaredSubmoduleTargets]);
  } catch (error) {
    messages.push(
      `Could not resolve layout targets for auto-layout: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { messages };
  }

  const targets = await collectReachableLayoutTargets(seedTargets);

  for (const target of targets) {
    try {
      const { swNet, existingSwMcl } = await readSwNetAndOptionalSwMcl(target.swNetPath, target.swMclPath);
      const selected = selectTargetModule(swNet.modules, target.moduleId, existingSwMcl?.moduleId);

      if (selected && isModuleLayoutComplete(selected.module, existingSwMcl)) {
        continue;
      }

      const result = await runLayoutDslForTarget(target, { force: false, dryRun: false });

      if (!result.ok) {
        messages.push(`Auto-layout skipped for ${target.swNetPath}: ${result.errorMessage}`);
        continue;
      }

      for (const warning of result.warnings) {
        messages.push(`${target.swNetPath}: ${warning}`);
      }

      if (result.summary && result.summary.added > 0) {
        messages.push(
          `Auto-generated missing layout for ${target.swMclPath}: ${result.summary.added} position(s) filled in.`,
        );
      }
    } catch (error) {
      messages.push(
        `Auto-layout failed for ${target.swNetPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { messages };
}

// De-duplicate layout targets by (file, module) so a document reachable through more than one seed
// (e.g. it's both project.json's entry and its only declared submodule) is only processed once.
function dedupeLayoutTargets(targets: LayoutTarget[]): LayoutTarget[] {
  const seen = new Set<string>();
  const deduped: LayoutTarget[] = [];

  for (const target of targets) {
    const key = `${target.swNetPath}#${target.moduleId ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

// Breadth-first walk of every module reachable from `seedTargets` via cross-file `use ... from`
// imports, mirroring resolveSubmoduleFootprintsForModule's traversal. Unreadable/malformed documents
// are left for the per-target loop in ensureProjectLayoutIsComplete to report; this walk just stops
// following that particular branch rather than failing the whole pass.
async function collectReachableLayoutTargets(seedTargets: LayoutTarget[]): Promise<LayoutTarget[]> {
  const visited = new Set<string>();
  const collected: LayoutTarget[] = [];
  const queue = [...seedTargets];

  while (queue.length > 0) {
    const target = queue.shift();

    if (!target) {
      break;
    }

    const key = `${target.swNetPath}#${target.moduleId ?? ""}`;

    if (visited.has(key)) {
      continue;
    }

    visited.add(key);
    collected.push(target);

    let swNet: SwNetDocument;

    try {
      swNet = (await readSwNetAndOptionalSwMcl(target.swNetPath, target.swMclPath)).swNet;
    } catch {
      continue;
    }

    const module = selectTargetModule(swNet.modules, target.moduleId, undefined)?.module;

    if (!module) {
      continue;
    }

    for (const statement of module.statements) {
      if (statement.kind !== "use" || statement.moduleRef.kind !== "imported") {
        continue;
      }

      const { alias, moduleId: importedModuleId } = statement.moduleRef;
      const importEntry = swNet.imports.find((imported) => imported.alias === alias);

      if (!importEntry) {
        continue;
      }

      const importedSwNetPath = resolveRelativeSwNetImportPath(target.swNetPath, importEntry.path);

      queue.push({
        documentId: importedSwNetPath,
        swNetPath: importedSwNetPath,
        swMclPath: replaceSwNetExtension(importedSwNetPath, ".sw-mcl"),
        moduleId: importedModuleId,
      });
    }
  }

  return collected;
}
