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
  return resolveSubmoduleFootprintsRecursive(swNetPath, swNet, module, new Set());
}

async function resolveSubmoduleFootprintsRecursive(
  swNetPath: string,
  swNet: SwNetDocument,
  module: SwNetModule,
  visited: Set<string>,
): Promise<ResolveSubmoduleFootprintsResult> {
  const footprints = new Map<string, ModuleFootprint>();
  const warnings: string[] = [];
  const visitedKey = `${swNetPath}#${module.id}`;

  if (visited.has(visitedKey)) {
    return { footprints, warnings };
  }

  visited.add(visitedKey);

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
    let targetSwNet: SwNetDocument;
    let targetSwMcl: StormworksSwMclDocument | undefined;

    try {
      const loaded = await readSwNetAndOptionalSwMcl(targetSwNetPath, replaceSwNetExtension(targetSwNetPath, ".sw-mcl"));
      targetSwNet = loaded.swNet;
      targetSwMcl = loaded.existingSwMcl;
    } catch (error) {
      warnings.push(
        `Could not load ${targetSwNetPath} referenced by ${statement.instanceId}: ${error instanceof Error ? error.message : String(error)}; using a generic box for its layout footprint.`,
      );
      continue;
    }

    if (!targetSwMcl || targetSwMcl.moduleId !== targetModuleId) {
      warnings.push(
        `No layout found for module ${targetModuleId} in ${targetSwNetPath} (referenced by ${statement.instanceId}); using a generic box for its layout footprint.`,
      );
      continue;
    }

    const targetModule = targetSwNet.modules.find((candidate) => candidate.id === targetModuleId);

    if (!targetModule) {
      warnings.push(
        `Module ${targetModuleId} was not found in ${targetSwNetPath} (referenced by ${statement.instanceId}); using a generic box for its layout footprint.`,
      );
      continue;
    }

    const nested = await resolveSubmoduleFootprintsRecursive(targetSwNetPath, targetSwNet, targetModule, visited);
    warnings.push(...nested.warnings);

    const footprint = computeModuleFootprint(targetModule, targetSwMcl, nested.footprints);

    if (!footprint) {
      warnings.push(
        `Layout for module ${targetModuleId} in ${targetSwNetPath} (referenced by ${statement.instanceId}) has no positioned ports or instances; using a generic box for its layout footprint.`,
      );
      continue;
    }

    footprints.set(statement.instanceId, footprint);
  }

  return { footprints, warnings };
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
