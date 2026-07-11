// Shared layout-dsl execution core used by both the CLI (`storm-mcl layout-dsl`) and the MCP
// `layout_dsl` tool, so the two front ends stay behaviorally identical.
import { computeSwNetModuleLayout, type AutoLayoutExistingPositions } from "../../core/layout/auto-layout.js";
import { type IrVector2 } from "../../core/ir.js";
import {
  type StormworksDocumentLoader,
  type StormworksProjectSource,
  type StormworksSourceDocument,
} from "../../core/project-source.js";
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

export interface ComputeProjectLayoutOverridesResult {
  // One line per notice worth surfacing to the caller (auto-computed layout, or per-target
  // failures). Empty when every reachable module's .sw-mcl was already complete.
  messages: string[];
  // Computed StormworksSwMclDocuments for reachable modules whose on-disk .sw-mcl was missing or
  // incomplete, keyed by documentId (the module's resolved .sw-net path, matching
  // StormworksSourceDocument.documentId). Nothing here has been written to disk; callers splice these
  // into the in-memory project source via applyLayoutOverride/createLayoutOverridingDocumentLoader
  // before building XML.
  overridesByDocumentId: Map<string, StormworksSwMclDocument>;
}

// Compute (but never write) ELK auto-layout for any module reachable from the project whose .sw-mcl
// is missing or incomplete, so dsl2xml/dsl2xml-tree (CLI) and dsl_to_xml (MCP) can feed computed
// positions into the exporter purely in memory instead of falling through to the exporter's cruder
// shared-anchor/omitted-<pos> degradation (see src/core/exporters/xml-tree.ts's
// resolveInstancePosition) -- without mutating the user's project directory as a side effect of what
// is otherwise a read-only conversion. Persisting a computed layout to disk still requires an
// explicit `layout-dsl`/`layout_dsl` call; this function is deliberately side-effect-free. Best-effort:
// .sw-mcl has always been an optional input (CLAUDE.md), so failures here are reported as messages but
// never thrown — the caller's normal load/export flow still runs afterward and will surface any real,
// blocking problem.
//
// Covers every module reachable from the project, not just project.json's declared submodules:
// resolveLayoutTargets({ allSubmodules: true }) alone would (a) return nothing at all for the
// supported "no submodules array, fall back to main.sw-net" project.json shape, and (b) never look
// past project.json into cross-file `use ... from` imports (e.g. a main.sw-net that composes a
// separately-authored control_handle.sw-net) — both of which would silently leave those modules on
// the old degraded fallback. So this seeds from the entry module plus every declared submodule, then
// recursively follows each module's own imports the same way resolveSubmoduleFootprints does for
// footprint sizing.
export async function computeProjectLayoutOverrides(projectJsonPath: string): Promise<ComputeProjectLayoutOverridesResult> {
  const messages: string[] = [];
  const overridesByDocumentId = new Map<string, StormworksSwMclDocument>();
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
    return { messages, overridesByDocumentId };
  }

  const targets = await collectReachableLayoutTargets(seedTargets);

  for (const target of targets) {
    try {
      const { swNet, existingSwMcl } = await readSwNetAndOptionalSwMcl(target.swNetPath, target.swMclPath);
      const selected = selectTargetModule(swNet.modules, target.moduleId, existingSwMcl?.moduleId);

      if (selected && isModuleLayoutComplete(selected.module, existingSwMcl)) {
        continue;
      }

      const result = await runLayoutDslForTarget(target, { force: false, dryRun: true });

      if (!result.ok) {
        messages.push(`Auto-layout skipped for ${target.swNetPath}: ${result.errorMessage}`);
        continue;
      }

      for (const warning of result.warnings) {
        messages.push(`${target.swNetPath}: ${warning}`);
      }

      if (result.document) {
        overridesByDocumentId.set(target.documentId, result.document);
      }

      if (result.summary && result.summary.added > 0) {
        messages.push(
          `Computed missing layout for ${target.documentId} in memory (not written to disk): ${result.summary.added} position(s) filled in.`,
        );
      }
    } catch (error) {
      messages.push(
        `Auto-layout failed for ${target.swNetPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { messages, overridesByDocumentId };
}

// Splice a computed layout override (see computeProjectLayoutOverrides) into one already-loaded
// source document, without touching whatever's on disk. Returns `document` unchanged when no override
// applies to it.
export function applyLayoutOverride(
  document: StormworksSourceDocument,
  overridesByDocumentId: Map<string, StormworksSwMclDocument>,
): StormworksSourceDocument {
  const override = overridesByDocumentId.get(document.documentId);

  if (!override) {
    return document;
  }

  return {
    ...document,
    swMcl: override,
    // A module with no .sw-mcl file on disk at all ("generated") must be re-tagged so
    // buildSwMclByDocumentPath (project-source.ts) treats the computed layout as real data instead of
    // filtering it out as "no layout data"; a module whose .sw-mcl file existed but was merely
    // incomplete keeps its "file" origin since real (if partial) data was already on disk.
    swMclOrigin: document.swMclOrigin === "generated" ? "computed" : document.swMclOrigin,
  };
}

// Wrap a StormworksDocumentLoader so every imported document it resolves also gets any computed
// layout override applied, the same way applyLayoutOverride does for the entry document.
export function createLayoutOverridingDocumentLoader(
  baseLoader: StormworksDocumentLoader["loadImportedDocument"],
  overridesByDocumentId: Map<string, StormworksSwMclDocument>,
): StormworksDocumentLoader["loadImportedDocument"] {
  return async (args) => {
    const document = await baseLoader(args);
    return document ? applyLayoutOverride(document, overridesByDocumentId) : document;
  };
}

// Splice a computed layout override into a loaded project source's entry document. Callers still need
// createLayoutOverridingDocumentLoader alongside this to cover documents pulled in via `use ... from`.
export function applyProjectSourceLayoutOverrides(
  projectSource: StormworksProjectSource,
  overridesByDocumentId: Map<string, StormworksSwMclDocument>,
): StormworksProjectSource {
  // When no .sw-mcl file exists on disk and project.json doesn't declare an explicit entry submodule,
  // loadProjectSourceFromProjectJsonFile can only guess entryModuleId from the generated stub (the
  // entry .sw-net file's basename), which is wrong whenever the file's sole/entry module has a
  // different real id. The old write-then-reload flow picked up the correct id automatically because
  // it re-read the freshly written .sw-mcl; now that nothing is written, adopt the override's real
  // moduleId ourselves so collectProjectSourceDiagnostics's entry-module/layout-moduleId check doesn't
  // fire spuriously against the stub's guess.
  const wasGenerated = projectSource.entryDocument.swMclOrigin === "generated";
  const entryDocument = applyLayoutOverride(projectSource.entryDocument, overridesByDocumentId);

  return {
    ...projectSource,
    entryDocument,
    entryModuleId: wasGenerated ? entryDocument.swMcl.moduleId : projectSource.entryModuleId,
  };
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
// are left for the per-target loop in computeProjectLayoutOverrides to report; this walk just stops
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
