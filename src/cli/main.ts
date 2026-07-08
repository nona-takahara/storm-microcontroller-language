// CLI entrypoint that exposes the standard xml2dsl/dsl2xml workflow and related validation commands.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  buildStormworksXmlFromProjectSource,
  buildStormworksXmlTreeFromProjectSource,
  compareSwNetIdentifier,
  createFileSystemProjectSourceDocumentLoader,
  formatPortOccurrenceKey,
  importStormworksXmlToProjectSource,
  loadBundledNodeDefinitions,
  loadProjectSourceFromProjectJsonFile,
  readSwNetAndOptionalSwMcl,
  readUtf8TextFile,
  resolveLayoutTargets,
  resolveProjectSource,
  serializeSourceDocumentTexts,
  STORMWORKS_SW_MCL_FORMAT_VERSION,
  type IrVector2,
  type LayoutTarget,
  type StormworksLibraryDiagnostic,
  type StormworksProjectSource,
  type StormworksSwMclDocument,
  type SwMclInstanceDocument,
  type SwMclPortDocument,
  type SwNetModule,
  validateProjectSource,
  writeProjectSourceToDirectory,
  writeSwMclDocument,
  writeUtf8TextFile,
} from "../node.js";
import { computeSwNetModuleLayout, type AutoLayoutExistingPositions } from "../core/layout/auto-layout.js";
import { extname } from "node:path";

// Dispatch one CLI invocation to the selected command handler.
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "xml2dsl":
    case "serialize-sw-net":
      return runXml2DslCommand(rest);
    case "dsl2xml":
    case "build-xml":
      return runDsl2XmlCommand(rest);
    case "dsl2xml-tree":
    case "build-xml-tree":
      return runDsl2XmlTreeCommand(rest);
    case "check-dsl":
      return runCheckDslCommand(rest);
    case "typecheck-dsl":
      return runTypecheckDslCommand(rest);
    case "import-xml":
      return runImportXmlCommand(rest);
    case "layout-dsl":
      return runLayoutDslCommand(rest);
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
  const xmlText = await readUtf8TextFile(parsedArgs.inputPath);
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
    console.error(`Wrote ${parsedArgs.outputDirectory}\\project.json`);
    console.error(`Wrote ${parsedArgs.outputDirectory}\\${entryRelativePath.replaceAll("/", "\\")}`);
    console.error(`Wrote ${parsedArgs.outputDirectory}\\${entrySwMclRelativePath.replaceAll("/", "\\")}`);

    for (const relativeScriptPath of Object.keys(result.value.entryDocument.scripts).sort()) {
      const scriptOutputPath = joinRelativeDisplayPath(entryRelativePath, relativeScriptPath);
      console.error(`Wrote ${parsedArgs.outputDirectory}\\${scriptOutputPath.replaceAll("/", "\\")}`);
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

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlFromProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
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

  const loadResult = await loadProjectSourceFromProjectJsonFile(parsedArgs.projectJsonPath);
  const loadHasErrors = printDiagnostics(loadResult.diagnostics);

  if (!loadResult.value) {
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlTreeFromProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  const buildHasErrors = printDiagnostics(buildResult.diagnostics);

  if (!buildResult.value) {
    return 1;
  }

  console.log(JSON.stringify(buildResult.value.tree, null, 2));
  return loadHasErrors || buildHasErrors ? 1 : 0;
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

// Debug command that prints the raw IR imported directly from XML.
async function runImportXmlCommand(args: string[]): Promise<number> {
  const inputPath = parseSingleInputPath(args);

  if (!inputPath) {
    printUsage();
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const xmlText = await readUtf8TextFile(inputPath);
  const { importStormworksXml } = await import("../core/importers/xml.js");
  const result = importStormworksXml(xmlText, {
    definitions,
    sourceName: inputPath,
  });

  console.log(JSON.stringify(result.program, null, 2));
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

// Compute and (unless --dry-run) write the layout for one resolved sw-net/sw-mcl target pair.
async function layoutOneTarget(target: LayoutTarget, args: LayoutDslArgs): Promise<boolean> {
  const { swNet, existingSwMcl } = await readSwNetAndOptionalSwMcl(target.swNetPath, target.swMclPath);
  const selection = selectTargetModule(swNet.modules, target.moduleId, existingSwMcl?.moduleId);

  if (!selection) {
    const availableIds = swNet.modules.map((module) => module.id).join(", ") || "(none)";
    console.error(`[error] ${target.swNetPath}: no target module found; use --module to select one of: ${availableIds}.`);
    return true;
  }

  for (const skippedModuleId of selection.skipped) {
    console.error(
      `[warning] ${target.swNetPath}: module ${skippedModuleId} is outside layout-dsl's v1 scope (one module per file) and was left untouched; see issue #7.`,
    );
  }

  const mode = args.force ? "force" : "fill";
  const existing = mode === "fill" ? buildExistingPositions(existingSwMcl) : undefined;
  const result = await computeSwNetModuleLayout(selection.module, {
    mode,
    existing,
    gridSize: args.gridSize,
  });

  for (const warning of result.warnings) {
    console.error(`[warning] ${target.swNetPath}: ${warning}`);
  }

  const document: StormworksSwMclDocument = {
    formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
    sourceName: target.documentId,
    moduleId: selection.module.id,
    ports: [...result.ports].sort(comparePorts),
    instances: [...result.instances].sort(compareInstances),
    warnings: [...(existingSwMcl?.warnings ?? [])],
  };

  const summary = summarizeLayoutChange(existingSwMcl, document, mode);
  console.error(
    `${target.swMclPath}: ${summary.kept} kept, ${summary.added} added, ${summary.overwritten} overwritten.`,
  );

  if (args.dryRun) {
    console.log(JSON.stringify(document, null, 2));
    return false;
  }

  await writeSwMclDocument(target.swMclPath, document);
  console.error(`Wrote ${target.swMclPath}`);
  return false;
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

    if (arg === "--layout") {
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

// Parse commands that take exactly one input path.
function parseSingleInputPath(args: string[]): string | undefined {
  const [inputPath, ...rest] = args;

  if (!inputPath || rest.length > 0) {
    return undefined;
  }

  return inputPath;
}

// Print diagnostics and return whether any of them were errors.
function printDiagnostics(diagnostics: StormworksLibraryDiagnostic[]): boolean {
  let hasErrors = false;

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      hasErrors = true;
    }

    const location = [diagnostic.documentId, diagnostic.path].filter((value): value is string => !!value).join(":");
    const suffix = location.length > 0 ? ` (${location})` : "";
    console.error(`[${diagnostic.severity}] ${diagnostic.code}${suffix}: ${diagnostic.message}`);
  }

  return hasErrors;
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
  console.log("");
  console.log("Legacy / debug:");
  console.log("  storm-mcl import-xml <input.xml>");
  console.log("  storm-mcl serialize-sw-net <input.xml> [--out-dir output-directory]");
  console.log("  storm-mcl build-xml <project.json> [--out output.xml]");
  console.log("  storm-mcl build-xml-tree <project.json>");
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
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
