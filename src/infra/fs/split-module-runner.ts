// Node-side file orchestration for the split-module CLI command (issue #64): resolves which
// .sw-net/module the request targets, runs the pure split engine, and turns its plan into concrete
// file contents -- a brand-new .sw-net (+ optional .sw-mcl) file for the extracted module, plus a
// rewritten original document and (if it had one) a trimmed original .sw-mcl.
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import { type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { createErrorDiagnostic, type Diagnostic, type StormworksLibraryResult } from "../../core/diagnostics.js";
import {
  applySwNetTextEdits,
  createSwNetImportInsertionEdit,
  parseSwNetSourceDocument,
} from "../../core/parsers/sw-net-source.js";
import { type SwNetImport } from "../../core/parsers/sw-net.js";
import { parseStormworksSwMclText } from "../../core/parsers/sw-mcl.js";
import { serializeSwNetDocument } from "../../core/serializers/sw-net-document.js";
import { STORMWORKS_SW_MCL_FORMAT_VERSION, type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { buildSplitModulePlan } from "../../core/split/engine.js";
import { reserveUniqueName } from "../../core/shared/name-reservation.js";
import { isFileNotFoundError } from "./project-file-helpers.js";
import { resolveLayoutTargets } from "./sw-net-layout-file-loader.js";
import { resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";
import { readUtf8TextFile, writeUtf8TextFile } from "./text-file.js";

export interface SplitModuleFileOptions {
  projectJsonPath: string;
  /** Relative sw-net path to operate on; defaults to the project's entry document. */
  document?: string;
  moduleId?: string;
  gateInstanceIds: string[];
  /** Output .sw-net path for the extracted module, relative to the project.json directory. */
  outSwNetPath: string;
  newModuleId?: string;
  newInstanceId?: string;
  definitions: NodeDefinitionRegistry;
}

export interface SplitModuleFileResult {
  sourceSwNetPath: string;
  sourceSwNetText: string;
  sourceSwMclPath: string;
  sourceSwMcl?: StormworksSwMclDocument;
  newSwNetPath: string;
  newSwNetText: string;
  newSwMclPath: string;
  newSwMcl?: StormworksSwMclDocument;
  newModuleId: string;
  movedInstanceIds: string[];
}

// Compute the full plan (new file contents, rewritten original text, layout moves) without writing
// anything to disk, so the CLI can render a --dry-run report from the same result it would write.
export async function planSplitModuleFiles(
  options: SplitModuleFileOptions,
): Promise<StormworksLibraryResult<SplitModuleFileResult>> {
  const diagnostics: Diagnostic[] = [];

  if (extname(options.outSwNetPath) !== ".sw-net") {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_OUT_PATH_INVALID",
        `--out must name a .sw-net file, received ${options.outSwNetPath}.`,
        "split",
      ),
    );
    return { diagnostics };
  }

  const targets = await resolveLayoutTargets(options.projectJsonPath, {
    document: options.document,
    module: options.moduleId,
  });
  const target = targets[0];

  if (!target?.moduleId) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_MODULE_NOT_SPECIFIED",
        "Could not determine which module to split; pass --module explicitly.",
        "split",
      ),
    );
    return { diagnostics };
  }

  const directoryPath = dirname(resolve(options.projectJsonPath));
  const newSwNetPath = resolve(directoryPath, ...options.outSwNetPath.split("/"));

  if (await pathExists(newSwNetPath)) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_OUT_PATH_EXISTS",
        `${newSwNetPath} already exists; choose a different --out path.`,
        "split",
        newSwNetPath,
      ),
    );
    return { diagnostics };
  }

  let swNetText: string;

  try {
    swNetText = await readUtf8TextFile(target.swNetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostics.push(createErrorDiagnostic("SPLIT_SOURCE_READ_FAILED", detail, "split", target.swNetPath));
    return { diagnostics };
  }

  const source = parseSwNetSourceDocument(swNetText, { sourceName: target.swNetPath });
  const newModuleId = options.newModuleId ?? basename(options.outSwNetPath, ".sw-net");
  const reservedAliases = new Set([
    ...source.ast.imports.map((imported) => imported.alias),
    ...source.ast.modules.map((module) => module.id),
  ]);
  const newImportAlias = reserveUniqueName(newModuleId, reservedAliases);

  const planResult = buildSplitModulePlan({
    definitions: options.definitions,
    source,
    moduleId: target.moduleId,
    gateInstanceIds: options.gateInstanceIds,
    newModuleId,
    newInstanceId: options.newInstanceId,
    newImportAlias,
  });

  diagnostics.push(...planResult.diagnostics);

  if (!planResult.value) {
    return { diagnostics };
  }

  const plan = planResult.value;

  // The new document needs its own `import` line for every alias a moved `use` statement still
  // references -- resolved relative to the NEW file's own directory, not the original document's.
  const neededAliases = [
    ...new Set(
      plan.newModule.statements.flatMap((statement) =>
        statement.kind === "use" && statement.moduleRef.kind === "imported" ? [statement.moduleRef.alias] : [],
      ),
    ),
  ];
  const newDocumentImports: SwNetImport[] = [];

  for (const alias of neededAliases) {
    const originalImport = source.ast.imports.find((imported) => imported.alias === alias);

    if (!originalImport) {
      diagnostics.push(
        createErrorDiagnostic(
          "SPLIT_IMPORT_ALIAS_MISSING",
          `Moved statement references import alias ${alias}, but ${target.swNetPath} does not declare it.`,
          "split",
          target.swNetPath,
        ),
      );
      continue;
    }

    const absoluteImportTarget = resolveRelativeSwNetImportPath(target.swNetPath, originalImport.path);
    newDocumentImports.push({ alias, path: toImportPathText(dirname(newSwNetPath), absoluteImportTarget) });
  }

  if (neededAliases.length !== newDocumentImports.length) {
    return { diagnostics };
  }

  const newSwNetText = serializeSwNetDocument({ imports: newDocumentImports, modules: [plan.newModule] });

  const ownImportEdit = createSwNetImportInsertionEdit(
    source,
    `import ${newImportAlias} from ${JSON.stringify(toImportPathText(dirname(target.swNetPath), newSwNetPath))}`,
  );
  const sourceSwNetText = applySwNetTextEdits(source.text, [...plan.sourceEdits, ownImportEdit]);

  const { sourceSwMcl, newSwMcl } = await splitLayout(target.swMclPath, plan.movedInstanceIds, newModuleId);

  return {
    value: {
      sourceSwNetPath: target.swNetPath,
      sourceSwNetText,
      sourceSwMclPath: target.swMclPath,
      sourceSwMcl,
      newSwNetPath,
      newSwNetText,
      newSwMclPath: newSwNetPath.slice(0, -".sw-net".length) + ".sw-mcl",
      newSwMcl,
      newModuleId,
      movedInstanceIds: plan.movedInstanceIds,
    },
    diagnostics,
  };
}

// Write a previously computed plan's file contents to disk.
export async function writeSplitModuleFiles(result: SplitModuleFileResult): Promise<void> {
  await mkdir(dirname(result.newSwNetPath), { recursive: true });
  await Promise.all([
    writeUtf8TextFile(result.sourceSwNetPath, result.sourceSwNetText),
    writeUtf8TextFile(result.newSwNetPath, result.newSwNetText),
    ...(result.sourceSwMcl
      ? [writeUtf8TextFile(result.sourceSwMclPath, `${JSON.stringify(result.sourceSwMcl, null, 2)}\n`)]
      : []),
    ...(result.newSwMcl ? [writeUtf8TextFile(result.newSwMclPath, `${JSON.stringify(result.newSwMcl, null, 2)}\n`)] : []),
  ]);
}

// Move each extracted instance's existing layout position from the original .sw-mcl into a fresh one
// for the new module; skipped entirely when the source has no real layout data (no file on disk), and
// the new .sw-mcl is only produced when at least one moved instance actually had a position to carry.
async function splitLayout(
  sourceSwMclPath: string,
  movedInstanceIds: string[],
  newModuleId: string,
): Promise<{ sourceSwMcl?: StormworksSwMclDocument; newSwMcl?: StormworksSwMclDocument }> {
  let existingSwMcl: StormworksSwMclDocument;

  try {
    existingSwMcl = parseStormworksSwMclText(await readUtf8TextFile(sourceSwMclPath));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }

  const movedIds = new Set(movedInstanceIds);
  const movedInstances = existingSwMcl.instances.filter((instance) => movedIds.has(instance.id));
  const sourceSwMcl: StormworksSwMclDocument = {
    ...existingSwMcl,
    instances: existingSwMcl.instances.filter((instance) => !movedIds.has(instance.id)),
  };

  if (movedInstances.length === 0) {
    return { sourceSwMcl };
  }

  const newSwMcl: StormworksSwMclDocument = {
    formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
    moduleId: newModuleId,
    ports: [],
    instances: movedInstances,
    warnings: [],
  };

  return { sourceSwMcl, newSwMcl };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Render an absolute sw-net path as an import-statement path relative to `fromDirectory`, matching
// the "./" prefix style already used throughout hand-written sw-net documents.
function toImportPathText(fromDirectory: string, absoluteTargetPath: string): string {
  const relativePath = relative(fromDirectory, absoluteTargetPath).split(sep).join("/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
