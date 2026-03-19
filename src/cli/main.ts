import { pathToFileURL } from "node:url";

import { loadBundledNodeDefinitions } from "../infra/fs/bundled-definitions-loader.js";
import { resolveSwNetFromFile } from "../infra/fs/sw-net-file-loader.js";
import { readUtf8TextFile } from "../infra/fs/text-file.js";
import { buildStormworksXmlTree } from "../core/exporters/xml-tree.js";
import { parseProjectJsonText } from "../core/parsers/project-json.js";
import { parseStormworksSwMclText } from "../core/parsers/sw-mcl.js";
import { serializeProjectJson } from "../core/serializers/project-json.js";
import { serializeStormworksSwMcl } from "../core/serializers/sw-mcl.js";
import { serializeStormworksSwNet } from "../core/serializers/sw-net.js";

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "import-xml":
      return runImportXmlCommand(rest);
    case "serialize-sw-net":
      return runSerializeSwNetCommand(rest);
    case "build-xml-tree":
      return runBuildXmlTreeCommand(rest);
    default:
      printUsage();
      return command ? 1 : 0;
  }
}

async function runImportXmlCommand(args: string[]): Promise<number> {
  const inputPath = parseInputPath(args);

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

async function runSerializeSwNetCommand(args: string[]): Promise<number> {
  const parsedArgs = parseSerializeSwNetArgs(args);
  const inputPath = parsedArgs?.inputPath;

  if (!parsedArgs || !inputPath) {
    printUsage();
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const xmlText = await readUtf8TextFile(inputPath);
  const { importStormworksXml } = await import("../core/importers/xml.js");
  const imported = importStormworksXml(xmlText, {
    definitions,
    sourceName: inputPath,
  });

  try {
    const projectJson = serializeProjectJson(imported.program);
    const swMclText = parsedArgs.emitLayout ? serializeStormworksSwMcl(imported.program) : undefined;
    const artifact = serializeStormworksSwNet(imported.program, {
      definitions,
    });
    const swNetText = new TextDecoder().decode(artifact.bytes);

    console.log("=== project.json ===");
    console.log(projectJson);
    if (swMclText) {
      console.log("");
      console.log("=== main.sw-mcl ===");
      console.log(swMclText);
    }
    console.log("");
    console.log("=== main.sw-net ===");
    console.log(swNetText);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

async function runBuildXmlTreeCommand(args: string[]): Promise<number> {
  const parsedArgs = parseBuildXmlTreeArgs(args);

  if (!parsedArgs) {
    printUsage();
    return 1;
  }

  const definitions = await loadBundledNodeDefinitions();
  const [projectJsonText, swMclText] = await Promise.all([
    readUtf8TextFile(parsedArgs.projectJsonPath),
    readUtf8TextFile(parsedArgs.swMclPath),
  ]);
  const [project, swNet, swMcl] = await Promise.all([
    Promise.resolve(parseProjectJsonText(projectJsonText)),
    resolveSwNetFromFile(parsedArgs.swNetPath),
    Promise.resolve(parseStormworksSwMclText(swMclText)),
  ]);

  try {
    const result = buildStormworksXmlTree(
      {
        project,
        swNet,
        swMcl,
      },
      {
        definitions,
      },
    );

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.error(`[warning] ${warning}`);
      }
    }

    console.log(JSON.stringify(result.tree, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

function parseInputPath(args: string[]): string | undefined {
  const [inputPath, ...rest] = args;

  if (rest.length > 0) {
    return undefined;
  }

  return inputPath;
}

function parseSerializeSwNetArgs(
  args: string[],
): { inputPath: string; emitLayout: boolean } | undefined {
  let inputPath: string | undefined;
  let emitLayout = false;

  for (const arg of args) {
    if (arg === "--layout") {
      emitLayout = true;
      continue;
    }

    if (inputPath === undefined) {
      inputPath = arg;
      continue;
    }

    return undefined;
  }

  return inputPath ? { inputPath, emitLayout } : undefined;
}

function parseBuildXmlTreeArgs(
  args: string[],
): { projectJsonPath: string; swNetPath: string; swMclPath: string } | undefined {
  const [projectJsonPath, swNetPath, swMclPath, ...rest] = args;

  if (!projectJsonPath || !swNetPath || !swMclPath || rest.length > 0) {
    return undefined;
  }

  return {
    projectJsonPath,
    swNetPath,
    swMclPath,
  };
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  storm-mcl import-xml <input.xml>");
  console.log("  storm-mcl serialize-sw-net <input.xml> [--layout]");
  console.log("  storm-mcl build-xml-tree <project.json> <main.sw-net> <main.sw-mcl>");
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
