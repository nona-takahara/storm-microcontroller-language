#!/usr/bin/env node
// CLI entrypoint that exposes the standard xml2dsl/dsl2xml workflow and related validation commands.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  applyProjectSourceLayoutOverrides,
  buildGateSpec,
  buildSpecOverview,
  buildStormworksXmlFromProjectSource,
  buildStormworksXmlTreeFromProjectSource,
  computeProjectLayoutOverrides,
  createFileSystemProjectSourceDocumentLoader,
  createLayoutOverridingDocumentLoader,
  formatGateSpecListText,
  formatGateSpecText,
  formatSpecOverviewText,
  importStormworksXmlToProjectSource,
  listGateSpecSummaries,
  loadBundledNodeBehaviorNotes,
  loadBundledNodeDefinitions,
  loadBundledStormworksSystemNotes,
  loadProjectSourceFromProjectJsonFile,
  readUtf8TextFile,
  resolveLayoutTargets,
  resolveProjectSource,
  runLayoutDslForTarget,
  serializeSourceDocumentTexts,
  type LayoutTarget,
  type StormworksSwMclDocument,
  createErrorDiagnostic,
  formatDiagnostic,
  hasErrorDiagnostics,
  type Diagnostic,
  type StormworksProjectSource,
  validateProjectSource,
  writeProjectSourceToDirectory,
  writeUtf8TextFile,
} from "../node.js";
import { extname } from "node:path";

// Dispatch one CLI invocation to the selected command handler.
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "xml2dsl":
      return runXml2DslCommand(rest);
    case "dsl2xml":
      return runDsl2XmlCommand(rest);
    case "dsl2xml-tree":
      return runDsl2XmlTreeCommand(rest);
    case "check-dsl":
      return runCheckDslCommand(rest);
    case "typecheck-dsl":
      return runTypecheckDslCommand(rest);
    case "layout-dsl":
      return runLayoutDslCommand(rest);
    case "spec":
      return runSpecCommand(rest);
    default:
      printUsage();
      return command ? 1 : 0;
  }
}

// Convert XML into the standard project.json + sw-net + sw-mcl file set.
async function runXml2DslCommand(args: string[]): Promise<number> {
  const parsedArgs = parseXml2DslArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const xmlRead = await readTextFileToDiagnostics(parsedArgs.inputPath);

  if (!xmlRead.value) {
    printDiagnostics(xmlRead.diagnostics);
    return 1;
  }

  const xmlText = xmlRead.value;
  const result = importStormworksXmlToProjectSource(xmlText, {
    definitions,
    sourceName: parsedArgs.inputPath,
    entryDocumentId: "main.sw-net",
  });
  const hasErrors = printDiagnostics(result.diagnostics);

  if (!result.value) {
    return 1;
  }

  if (parsedArgs.outputDirectory) {
    await writeProjectSourceToDirectory(result.value, parsedArgs.outputDirectory);
    const entryRelativePath = resolveEntryDocumentRelativePath(result.value);
    const entrySwMclRelativePath = replaceSwNetExtensionForDisplay(entryRelativePath, ".sw-mcl");
    console.error(`Wrote ${parsedArgs.outputDirectory}/project.json`);
    console.error(`Wrote ${parsedArgs.outputDirectory}/${entryRelativePath}`);
    console.error(`Wrote ${parsedArgs.outputDirectory}/${entrySwMclRelativePath}`);

    for (const relativeScriptPath of Object.keys(result.value.entryDocument.scripts).sort()) {
      const scriptOutputPath = joinRelativeDisplayPath(entryRelativePath, relativeScriptPath);
      console.error(`Wrote ${parsedArgs.outputDirectory}/${scriptOutputPath}`);
    }

    return hasErrors ? 1 : 0;
  }

  // Without --out-dir, print the standard file set to stdout in labeled sections for inspection.
  const entryTexts = serializeSourceDocumentTexts(result.value.entryDocument);
  const entryRelativePath = resolveEntryDocumentRelativePath(result.value);
  const entrySwMclRelativePath = replaceSwNetExtensionForDisplay(entryRelativePath, ".sw-mcl");

  console.log("=== project.json ===");
  console.log(JSON.stringify(result.value.project, null, 2));
  console.log("");
  console.log(`=== ${entrySwMclRelativePath} ===`);
  console.log(entryTexts.swMclText);
  console.log("");
  console.log(`=== ${entryRelativePath} ===`);
  console.log(entryTexts.swNetText);

  for (const [relativeScriptPath, scriptText] of Object.entries(entryTexts.scripts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    console.log("");
    console.log(`=== ${joinRelativeDisplayPath(entryRelativePath, relativeScriptPath)} ===`);
    process.stdout.write(scriptText);

    if (!scriptText.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }

  return hasErrors ? 1 : 0;
}

// Load the standard DSL file set and rebuild Stormworks XML text.
async function runDsl2XmlCommand(args: string[]): Promise<number> {
  const parsedArgs = parseDsl2XmlArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const overridesByDocumentId = await computeLayoutOverrides(parsedArgs.projectJsonPath);

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const projectSource = applyProjectSourceLayoutOverrides(loadResult.value, overridesByDocumentId);
  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlFromProjectSource(projectSource, {
    definitions,
    loadImportedDocument: createLayoutOverridingDocumentLoader(
      createFileSystemProjectSourceDocumentLoader(),
      overridesByDocumentId,
    ),
  });
  const buildHasErrors = printDiagnostics(buildResult.diagnostics);

  if (!buildResult.value) {
    return 1;
  }

  if (parsedArgs.outputPath) {
    await writeUtf8TextFile(parsedArgs.outputPath, buildResult.value.xml);
    console.error(`Wrote ${parsedArgs.outputPath}`);
    return loadHasErrors || buildHasErrors ? 1 : 0;
  }

  process.stdout.write(buildResult.value.xml);
  return loadHasErrors || buildHasErrors ? 1 : 0;
}

// Load the standard DSL file set and print the reconstructed intermediate XML tree.
async function runDsl2XmlTreeCommand(args: string[]): Promise<number> {
  const parsedArgs = parseProjectJsonPathArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const overridesByDocumentId = await computeLayoutOverrides(parsedArgs.projectJsonPath);

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const projectSource = applyProjectSourceLayoutOverrides(loadResult.value, overridesByDocumentId);
  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlTreeFromProjectSource(projectSource, {
    definitions,
    loadImportedDocument: createLayoutOverridingDocumentLoader(
      createFileSystemProjectSourceDocumentLoader(),
      overridesByDocumentId,
    ),
  });
  const buildHasErrors = printDiagnostics(buildResult.diagnostics);

  if (!buildResult.value) {
    return 1;
  }

  console.log(JSON.stringify(buildResult.value.tree, null, 2));
  return loadHasErrors || buildHasErrors ? 1 : 0;
}

// Run the shared implicit-auto-layout pass (see layout-dsl-runner.ts) purely in memory, print any of
// its notices as CLI warnings, and hand back the computed overrides for dsl2xml/dsl2xml-tree to splice
// into the loaded project source before building XML. Nothing is written to disk here — that still
// requires an explicit `layout-dsl` call.
async function computeLayoutOverrides(projectJsonPath: string): Promise<Map<string, StormworksSwMclDocument>> {
  const { messages, overridesByDocumentId } = await computeProjectLayoutOverrides(projectJsonPath);

  for (const message of messages) {
    console.error(`[auto-layout] ${message}`);
  }

  return overridesByDocumentId;
}

// Resolve imports and report the reachable sw-net document/module graph.
async function runCheckDslCommand(args: string[]): Promise<number> {
  const parsedArgs = parseProjectJsonPathArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const resolveResult = await resolveProjectSource(loadResult.value, {
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  const resolveHasErrors = printDiagnostics(resolveResult.diagnostics);

  if (!resolveResult.value) {
    return 1;
  }

  console.log(
    `Resolved ${resolveResult.value.documents.length} document(s), ${resolveResult.value.swNet.modules.length} module(s), and ${resolveResult.value.swNet.uses.length} use statement(s).`,
  );

  return loadHasErrors || resolveHasErrors ? 1 : 0;
}

// Validate the loaded DSL file set against definitions and local assets.
async function runTypecheckDslCommand(args: string[]): Promise<number> {
  const parsedArgs = parseProjectJsonPathArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const validationResult = await validateProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  const validationHasErrors = printDiagnostics(validationResult.diagnostics);

  if (validationResult.isValid) {
    console.log("DSL typecheck passed.");
  }

  return loadHasErrors || validationHasErrors || !validationResult.isValid ? 1 : 0;
}

// Look up gate/tool behavior spec: no args prints the tool+system overview, --list enumerates
// every definition id, and a bare id prints that gate's full port/property/behavior-notes spec.
async function runSpecCommand(args: string[]): Promise<number> {
  const parsedArgs = parseSpecArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();

  if (parsedArgs.list) {
    const summaries = listGateSpecSummaries(definitions);
    console.log(parsedArgs.json ? JSON.stringify(summaries, null, 2) : formatGateSpecListText(summaries));
    return 0;
  }

  if (parsedArgs.gateId) {
    const notesDoc = await loadBundledNodeBehaviorNotes();
    const spec = buildGateSpec(parsedArgs.gateId, definitions, notesDoc);

    if (!spec) {
      console.error(`Unknown gate id: ${parsedArgs.gateId}. Run \`storm-mcl spec --list\` to see valid ids.`);
      return 1;
    }

    console.log(parsedArgs.json ? JSON.stringify(spec, null, 2) : formatGateSpecText(spec));
    return 0;
  }

  const systemNotes = await loadBundledStormworksSystemNotes();
  const overview = buildSpecOverview(systemNotes);
  console.log(parsedArgs.json ? JSON.stringify(overview, null, 2) : formatSpecOverviewText(overview));
  return 0;
}

// Compute and write .sw-mcl layout files from the .sw-net graph, filling or regenerating positions via ELK.
async function runLayoutDslCommand(args: string[]): Promise<number> {
  const parsedArgs = parseLayoutDslArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  let targets: LayoutTarget[];

  try {
    targets = await resolveLayoutTargets(parsedArgs.projectJsonPath, {
      document: parsedArgs.document,
      module: parsedArgs.module,
      allSubmodules: parsedArgs.allSubmodules,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let hasErrors = false;

  for (const target of targets) {
    try {
      const targetHasErrors = await layoutOneTarget(target, parsedArgs);
      hasErrors = hasErrors || targetHasErrors;
    } catch (error) {
      console.error(`[error] ${target.swNetPath}: ${error instanceof Error ? error.message : String(error)}`);
      hasErrors = true;
    }
  }

  return hasErrors ? 1 : 0;
}

// Compute and (unless --dry-run) write the layout for one resolved sw-net/sw-mcl target pair,
// printing CLI-formatted diagnostics around the shared runLayoutDslForTarget core.
async function layoutOneTarget(target: LayoutTarget, args: LayoutDslArgs): Promise<boolean> {
  const result = await runLayoutDslForTarget(target, {
    force: args.force,
    dryRun: args.dryRun,
    gridSize: args.gridSize,
  });

  if (!result.ok) {
    console.error(`[error] ${target.swNetPath}: ${result.errorMessage}`);
    return true;
  }

  for (const warning of result.warnings) {
    console.error(`[warning] ${target.swNetPath}: ${warning}`);
  }

  if (result.summary) {
    console.error(
      `${target.swMclPath}: ${result.summary.kept} kept, ${result.summary.added} added, ${result.summary.overwritten} overwritten.`,
    );
  }

  if (args.dryRun) {
    console.log(JSON.stringify(result.document, null, 2));
    return false;
  }

  console.error(`Wrote ${target.swMclPath}`);
  return false;
}

interface LayoutDslArgs {
  projectJsonPath: string;
  module?: string;
  document?: string;
  allSubmodules: boolean;
  force: boolean;
  dryRun: boolean;
  gridSize?: number;
}

// Parse layout-dsl-specific command-line arguments.
function parseLayoutDslArgs(args: string[]): LayoutDslArgs | undefined {
  let projectJsonPath: string | undefined;
  let moduleId: string | undefined;
  let documentPath: string | undefined;
  let allSubmodules = false;
  let force = false;
  let dryRun = false;
  let gridSize: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      return undefined;
    }

    if (arg === "--module") {
      const next = args[index + 1];

      if (!next || moduleId !== undefined) {
        return undefined;
      }

      moduleId = next;
      index += 1;
      continue;
    }

    if (arg === "--document") {
      const next = args[index + 1];

      if (!next || documentPath !== undefined) {
        return undefined;
      }

      documentPath = next;
      index += 1;
      continue;
    }

    if (arg === "--all-submodules") {
      allSubmodules = true;
      continue;
    }

    if (arg === "--force" || arg === "--regenerate") {
      force = true;
      continue;
    }

    if (arg === "--dry-run" || arg === "--check") {
      dryRun = true;
      continue;
    }

    if (arg === "--grid-size") {
      const next = args[index + 1];
      const parsed = next ? Number(next) : Number.NaN;

      if (!next || gridSize !== undefined || !Number.isFinite(parsed)) {
        return undefined;
      }

      gridSize = parsed;
      index += 1;
      continue;
    }

    if (!projectJsonPath) {
      projectJsonPath = arg;
      continue;
    }

    return undefined;
  }

  if (!projectJsonPath || (allSubmodules && (moduleId !== undefined || documentPath !== undefined))) {
    return undefined;
  }

  return {
    projectJsonPath,
    module: moduleId,
    document: documentPath,
    allSubmodules,
    force,
    dryRun,
    gridSize,
  };
}

interface SpecArgs {
  gateId?: string;
  list: boolean;
  json: boolean;
}

// Parse spec-specific command-line arguments: at most one gate id, exclusive with --list.
function parseSpecArgs(args: string[]): SpecArgs | undefined {
  let gateId: string | undefined;
  let list = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--list") {
      list = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (!gateId) {
      gateId = arg;
      continue;
    }

    return undefined;
  }

  if (list && gateId !== undefined) {
    return undefined;
  }

  return { gateId, list, json };
}

// Parse xml2dsl-specific command-line arguments.
function parseXml2DslArgs(
  args: string[],
): { inputPath: string; outputDirectory?: string } | undefined {
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      return undefined;
    }

    if (arg === "--out-dir") {
      const next = args[index + 1];

      if (!next || outputDirectory !== undefined) {
        return undefined;
      }

      outputDirectory = next;
      index += 1;
      continue;
    }

    if (!inputPath) {
      inputPath = arg;
      continue;
    }

    return undefined;
  }

  return inputPath ? { inputPath, outputDirectory } : undefined;
}

// Parse dsl2xml-specific command-line arguments.
function parseDsl2XmlArgs(
  args: string[],
): { projectJsonPath: string; outputPath?: string } | undefined {
  let projectJsonPath: string | undefined;
  let outputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      return undefined;
    }

    if (arg === "--out") {
      const next = args[index + 1];

      if (!next || outputPath !== undefined) {
        return undefined;
      }

      outputPath = next;
      index += 1;
      continue;
    }

    if (!projectJsonPath) {
      projectJsonPath = arg;
      continue;
    }

    return undefined;
  }

  return projectJsonPath ? { projectJsonPath, outputPath } : undefined;
}


// File-system failures are user input errors in the CLI, so report them as diagnostics rather
// than leaking raw Node.js exceptions from individual command handlers.
async function readTextFileToDiagnostics(
  filePath: string,
): Promise<{ value?: string; diagnostics: Diagnostic[] }> {
  try {
    return { value: await readUtf8TextFile(filePath), diagnostics: [] };
  } catch (error) {
    const code = isNodeErrorCode(error, "ENOENT") ? "FILE_NOT_FOUND" : "FILE_READ_FAILED";
    return {
      diagnostics: [
        createErrorDiagnostic(
          code,
          error instanceof Error ? error.message : String(error),
          "cli",
          filePath,
        ),
      ],
    };
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

// Parse commands that take exactly one project.json path.
function parseProjectJsonPathArgs(
  args: string[],
): { projectJsonPath: string } | undefined {
  const [projectJsonPath, ...rest] = args;

  if (!projectJsonPath || rest.length > 0) {
    return undefined;
  }

  return { projectJsonPath };
}

// Print diagnostics and return whether any of them were errors.
function printDiagnostics(diagnostics: Diagnostic[]): boolean {
  for (const diagnostic of diagnostics) {
    console.error(formatDiagnostic(diagnostic));
  }

  return hasErrorDiagnostics(diagnostics);
}

// Print the supported CLI command list.
function printUsage(): void {
  console.log("Usage:");
  console.log("  storm-mcl xml2dsl <input.xml> [--out-dir output-directory]");
  console.log("  storm-mcl dsl2xml <project.json> [--out output.xml]");
  console.log("  storm-mcl dsl2xml-tree <project.json>");
  console.log("  storm-mcl check-dsl <project.json>");
  console.log("  storm-mcl typecheck-dsl <project.json>");
  console.log(
    "  storm-mcl layout-dsl <project.json> [--module <id>] [--document <path>] [--all-submodules] [--force] [--dry-run] [--grid-size <n>]",
  );
  console.log("  storm-mcl spec [<definitionId>] [--list] [--json]");
}

// Resolve the entry sw-net relative path to display from the loaded project source.
function resolveEntryDocumentRelativePath(
  projectSource: StormworksProjectSource,
): string {
  const entrySubmodule =
    projectSource?.project.submodules.find((submodule) => submodule.id === projectSource.entryModuleId) ??
    projectSource?.project.submodules.find((submodule) => submodule.name === projectSource.entryModuleId);

  return entrySubmodule?.relativePath ?? "main.sw-net";
}

// Replace a displayed .sw-net suffix with the matching companion suffix without normalizing the rest of the path.
function replaceSwNetExtensionForDisplay(filePath: string, nextExtension: string): string {
  return extname(filePath) === ".sw-net" ? `${filePath.slice(0, -".sw-net".length)}${nextExtension}` : filePath;
}

// Join a relative asset path under the displayed document path for human-readable CLI output.
function joinRelativeDisplayPath(baseDocumentPath: string, relativeAssetPath: string): string {
  const slashIndex = baseDocumentPath.lastIndexOf("/");

  if (slashIndex < 0) {
    return relativeAssetPath;
  }

  return `${baseDocumentPath.slice(0, slashIndex + 1)}${relativeAssetPath}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      printDiagnostics([
        createErrorDiagnostic("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), "cli"),
      ]);
      process.exitCode = 1;
    });
}
