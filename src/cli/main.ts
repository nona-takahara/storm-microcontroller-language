import { pathToFileURL } from "node:url";

import {
  buildStormworksXmlFromProjectSource,
  buildStormworksXmlTreeFromProjectSource,
  createFileSystemProjectSourceDocumentLoader,
  importStormworksXmlToProjectSource,
  loadBundledNodeDefinitions,
  loadProjectSourceFromProjectJsonFile,
  readUtf8TextFile,
  resolveProjectSource,
  serializeSourceDocumentTexts,
  type StormworksLibraryDiagnostic,
  type StormworksProjectSource,
  validateProjectSource,
  writeProjectSourceToDirectory,
  writeUtf8TextFile,
} from "../node.js";
import { extname } from "node:path";

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
    default:
      printUsage();
      return command ? 1 : 0;
  }
}

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

function parseProjectJsonPathArgs(
  args: string[],
): { projectJsonPath: string } | undefined {
  const [projectJsonPath, ...rest] = args;

  if (!projectJsonPath || rest.length > 0) {
    return undefined;
  }

  return { projectJsonPath };
}

function parseSingleInputPath(args: string[]): string | undefined {
  const [inputPath, ...rest] = args;

  if (!inputPath || rest.length > 0) {
    return undefined;
  }

  return inputPath;
}

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

function printUsage(): void {
  console.log("Usage:");
  console.log("  storm-mcl xml2dsl <input.xml> [--out-dir output-directory]");
  console.log("  storm-mcl dsl2xml <project.json> [--out output.xml]");
  console.log("  storm-mcl dsl2xml-tree <project.json>");
  console.log("  storm-mcl check-dsl <project.json>");
  console.log("  storm-mcl typecheck-dsl <project.json>");
  console.log("");
  console.log("Legacy / debug:");
  console.log("  storm-mcl import-xml <input.xml>");
  console.log("  storm-mcl serialize-sw-net <input.xml> [--out-dir output-directory]");
  console.log("  storm-mcl build-xml <project.json> [--out output.xml]");
  console.log("  storm-mcl build-xml-tree <project.json>");
}

function resolveEntryDocumentRelativePath(
  projectSource: StormworksProjectSource,
): string {
  const entrySubmodule =
    projectSource?.project.submodules.find((submodule) => submodule.id === projectSource.entryModuleId) ??
    projectSource?.project.submodules.find((submodule) => submodule.name === projectSource.entryModuleId);

  return entrySubmodule?.relativePath ?? "main.sw-net";
}

function replaceSwNetExtensionForDisplay(filePath: string, nextExtension: string): string {
  return extname(filePath) === ".sw-net" ? `${filePath.slice(0, -".sw-net".length)}${nextExtension}` : filePath;
}

function joinRelativeDisplayPath(baseDocumentPath: string, relativeAssetPath: string): string {
  const slashIndex = baseDocumentPath.lastIndexOf("/");

  if (slashIndex < 0) {
    return relativeAssetPath;
  }

  return `${baseDocumentPath.slice(0, slashIndex + 1)}${relativeAssetPath}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
