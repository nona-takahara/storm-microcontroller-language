// Node-side file helpers for the layout-dsl CLI command: resolve targets, read a sw-net/optional-sw-mcl
// pair, and write the computed sw-mcl document back to disk.
import { dirname, resolve } from "node:path";

import { type ModuleFootprint, computeModuleFootprint } from "../../core/layout/auto-layout.js";
import { parseProjectJsonText } from "../../core/parsers/project-json.js";
import { parseSwNetDocument, type SwNetDocument, type SwNetModule } from "../../core/parsers/sw-net.js";
import { parseStormworksSwMclText } from "../../core/parsers/sw-mcl.js";
import { type ProjectJsonSubmoduleDocument } from "../../core/serializers/project-json.js";
import { type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { DEFAULT_ENTRY_SW_NET_FILE_NAME, replaceSwNetExtension } from "./project-source-file-loader.js";
import { selectEntrySubmodule, isFileNotFoundError } from "./project-file-helpers.js";
import { resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";
import { readUtf8TextFile, writeUtf8TextFile } from "./text-file.js";

export interface LayoutTarget {
  documentId: string;
  swNetPath: string;
  swMclPath: string;
  moduleId?: string;
}

export interface ResolveLayoutTargetsOptions {
  document?: string;
  module?: string;
  allSubmodules?: boolean;
}

export interface SwNetAndOptionalSwMcl {
  swNet: SwNetDocument;
  existingSwMcl?: StormworksSwMclDocument;
}

// Resolve which .sw-net/.sw-mcl file pairs the layout-dsl command should target.
export async function resolveLayoutTargets(
  projectJsonPath: string,
  options: ResolveLayoutTargetsOptions = {},
): Promise<LayoutTarget[]> {
  const resolvedProjectJsonPath = resolve(projectJsonPath);
  const directoryPath = dirname(resolvedProjectJsonPath);
  const project = parseProjectJsonText(await readUtf8TextFile(resolvedProjectJsonPath));

  if (options.document) {
    const swNetPath = resolve(directoryPath, options.document);

    return [
      {
        documentId: swNetPath,
        swNetPath,
        swMclPath: replaceSwNetExtension(swNetPath, ".sw-mcl"),
        moduleId: options.module,
      },
    ];
  }

  if (options.allSubmodules) {
    return project.submodules.map((submodule) => buildTargetFromSubmodule(directoryPath, submodule, options.module));
  }

  const entrySubmodule = selectEntrySubmodule(project);

  if (!entrySubmodule) {
    const swNetPath = resolve(directoryPath, DEFAULT_ENTRY_SW_NET_FILE_NAME);

    return [
      {
        documentId: swNetPath,
        swNetPath,
        swMclPath: replaceSwNetExtension(swNetPath, ".sw-mcl"),
        moduleId: options.module,
      },
    ];
  }

  return [buildTargetFromSubmodule(directoryPath, entrySubmodule, options.module)];
}

// Read the required .sw-net document plus its .sw-mcl companion when one already exists on disk.
export async function readSwNetAndOptionalSwMcl(swNetPath: string, swMclPath: string): Promise<SwNetAndOptionalSwMcl> {
  const swNetText = await readUtf8TextFile(swNetPath);
  const swNet = parseSwNetDocument(swNetText, { sourceName: swNetPath });

  try {
    const swMclText = await readUtf8TextFile(swMclPath);
    return { swNet, existingSwMcl: parseStormworksSwMclText(swMclText) };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { swNet, existingSwMcl: undefined };
    }

    throw error;
  }
}

export interface ResolveSubmoduleFootprintsResult {
  footprints: Map<string, ModuleFootprint>;
  warnings: string[];
}

// One target module's own footprint, independent of which use-site is asking for it, so repeated
// `use`s of the same imported module (siblings, or shared across different branches of the
// resolution tree) can reuse a single computation instead of recomputing it once per use-site.
interface TargetFootprintResolution {
  footprint: ModuleFootprint | undefined;
  // Short reason the footprint could not be computed; undefined on success. Rendered per use-site
  // (with that use-site's own instanceId appended) rather than cached verbatim, since the same
  // target module can be `use`d from multiple instanceIds.
  failureReason?: string;
  // Warnings from the target's own nested `use` resolution. These already name their own
  // instanceIds (from the target's perspective) and are safe to reuse verbatim across cache hits.
  nestedWarnings: string[];
}

// Resolve real-footprint sizing for every `use` statement in `module` whose target already has its
// own real (non-generated) .sw-mcl layout, so layout-dsl can reserve accurately-sized space for it
// one level up instead of a generic placeholder box. Purely read-only: the target's own .sw-net/
// .sw-mcl files are only read, never written. Falls through to "no entry" (today's generic-box
// treatment) for local use targets (which can never have their own .sw-mcl, since .sw-mcl is 1:1
// with one file) and for any resolution failure, each reported as a warning.
export async function resolveSubmoduleFootprints(
  swNetPath: string,
  swNet: SwNetDocument,
  module: SwNetModule,
): Promise<ResolveSubmoduleFootprintsResult> {
  return resolveSubmoduleFootprintsForModule(swNetPath, swNet, module, new Set(), new Map());
}

async function resolveSubmoduleFootprintsForModule(
  swNetPath: string,
  swNet: SwNetDocument,
  module: SwNetModule,
  stack: Set<string>,
  cache: Map<string, TargetFootprintResolution>,
): Promise<ResolveSubmoduleFootprintsResult> {
  const footprints = new Map<string, ModuleFootprint>();
  const warnings: string[] = [];

  for (const statement of module.statements) {
    if (statement.kind !== "use" || statement.moduleRef.kind !== "imported") {
      continue;
    }

    const { alias, moduleId: targetModuleId } = statement.moduleRef;
    const importEntry = swNet.imports.find((imported) => imported.alias === alias);

    if (!importEntry) {
      warnings.push(
        `Import alias ${alias} referenced by ${statement.instanceId} was not found; using a generic box for its layout footprint.`,
      );
      continue;
    }

    const targetSwNetPath = resolveRelativeSwNetImportPath(swNetPath, importEntry.path);
    const resolution = await resolveTargetModuleFootprint(targetSwNetPath, targetModuleId, stack, cache);

    warnings.push(...resolution.nestedWarnings);

    if (resolution.footprint) {
      footprints.set(statement.instanceId, resolution.footprint);
      continue;
    }

    const reason = resolution.failureReason ?? `No layout found for module ${targetModuleId} in ${targetSwNetPath}`;
    warnings.push(`${reason} (referenced by ${statement.instanceId}); using a generic box for its layout footprint.`);
  }

  return { footprints, warnings };
}

// Resolve (and memoize) one target module's own footprint. `stack` tracks only the modules
// currently being resolved along the current recursion path, so it correctly stays empty for
// sibling/unrelated branches instead of permanently blacklisting every module visited anywhere in
// the traversal; `cache` then reuses the finished result for any later use-site that asks for the
// same target module.
async function resolveTargetModuleFootprint(
  targetSwNetPath: string,
  targetModuleId: string,
  stack: Set<string>,
  cache: Map<string, TargetFootprintResolution>,
): Promise<TargetFootprintResolution> {
  const key = `${targetSwNetPath}#${targetModuleId}`;
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }

  // A `use` cycle should already be a hard error from check-dsl/typecheck-dsl before layout-dsl
  // ever runs; this is a defensive backstop, not a case expected to fire in practice.
  if (stack.has(key)) {
    return { footprint: undefined, failureReason: `Module ${targetModuleId} in ${targetSwNetPath} is part of a use cycle`, nestedWarnings: [] };
  }

  stack.add(key);
  const resolution = await resolveTargetModuleFootprintUncached(targetSwNetPath, targetModuleId, stack, cache);
  stack.delete(key);

  cache.set(key, resolution);
  return resolution;
}

async function resolveTargetModuleFootprintUncached(
  targetSwNetPath: string,
  targetModuleId: string,
  stack: Set<string>,
  cache: Map<string, TargetFootprintResolution>,
): Promise<TargetFootprintResolution> {
  let targetSwNet: SwNetDocument;
  let targetSwMcl: StormworksSwMclDocument | undefined;

  try {
    const loaded = await readSwNetAndOptionalSwMcl(targetSwNetPath, replaceSwNetExtension(targetSwNetPath, ".sw-mcl"));
    targetSwNet = loaded.swNet;
    targetSwMcl = loaded.existingSwMcl;
  } catch (error) {
    return {
      footprint: undefined,
      failureReason: `Could not load ${targetSwNetPath}: ${error instanceof Error ? error.message : String(error)}`,
      nestedWarnings: [],
    };
  }

  if (!targetSwMcl || targetSwMcl.moduleId !== targetModuleId) {
    return { footprint: undefined, nestedWarnings: [] };
  }

  const targetModule = targetSwNet.modules.find((candidate) => candidate.id === targetModuleId);

  if (!targetModule) {
    return {
      footprint: undefined,
      failureReason: `Module ${targetModuleId} was not found in ${targetSwNetPath}`,
      nestedWarnings: [],
    };
  }

  const nested = await resolveSubmoduleFootprintsForModule(targetSwNetPath, targetSwNet, targetModule, stack, cache);
  const footprint = computeModuleFootprint(targetModule, targetSwMcl, nested.footprints);

  if (!footprint) {
    return {
      footprint: undefined,
      failureReason: `Layout for module ${targetModuleId} in ${targetSwNetPath} has no positioned ports or instances`,
      nestedWarnings: nested.warnings,
    };
  }

  return { footprint, nestedWarnings: nested.warnings };
}

// Write the computed sw-mcl document to disk, matching the trailing-newline convention used elsewhere.
export async function writeSwMclDocument(swMclPath: string, document: StormworksSwMclDocument): Promise<void> {
  await writeUtf8TextFile(swMclPath, `${JSON.stringify(document, null, 2)}\n`);
}

function buildTargetFromSubmodule(
  directoryPath: string,
  submodule: ProjectJsonSubmoduleDocument,
  moduleId: string | undefined,
): LayoutTarget {
  const swNetPath = resolve(directoryPath, ...submodule.relativePath.split("/"));

  return {
    documentId: swNetPath,
    swNetPath,
    swMclPath: replaceSwNetExtension(swNetPath, ".sw-mcl"),
    moduleId: moduleId ?? submodule.id,
  };
}
