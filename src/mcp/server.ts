import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  buildStormworksXmlFromProjectSource,
  createFileSystemProjectSourceDocumentLoader,
  importStormworksXmlToProjectSource,
  loadBundledNodeDefinitions,
  loadProjectSourceFromProjectJsonFile,
  readUtf8TextFile,
  resolveProjectSource,
  validateProjectSource,
  writeProjectSourceToDirectory,
  writeUtf8TextFile,
  type StormworksLibraryDiagnostic,
} from "../node.js";


function readPackageVersion(): string {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

const server = new Server(
  { name: "storm-mcl", version: readPackageVersion() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "xml_to_dsl",
      description:
        "Convert a Stormworks microcontroller XML file into the DSL file set (project.json + .sw-net + .sw-mcl).",
      inputSchema: {
        type: "object",
        properties: {
          xml_path: {
            type: "string",
            description: "Absolute path to the source XML file",
          },
          out_dir: {
            type: "string",
            description: "Absolute output directory for DSL files",
          },
        },
        required: ["xml_path", "out_dir"],
      },
    },
    {
      name: "dsl_to_xml",
      description:
        "Convert the DSL file set (project.json + .sw-net + .sw-mcl) into Stormworks microcontroller XML.",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "Absolute path to project.json",
          },
          out_path: {
            type: "string",
            description: "Absolute output XML path; when omitted, XML text is returned",
          },
        },
        required: ["project_json_path"],
      },
    },
    {
      name: "check_dsl",
      description:
        "Validate DSL syntax and import resolution, returning errors and warnings.",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "Absolute path to project.json",
          },
        },
        required: ["project_json_path"],
      },
    },
    {
      name: "typecheck_dsl",
      description:
        "Validate DSL signal types and report issues such as port type mismatches.",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "Absolute path to project.json",
          },
        },
        required: ["project_json_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "xml_to_dsl":
        return await handleXmlToDsl(args as { xml_path: string; out_dir: string });
      case "dsl_to_xml":
        return await handleDslToXml(args as { project_json_path: string; out_path?: string });
      case "check_dsl":
        return await handleCheckDsl(args as { project_json_path: string });
      case "typecheck_dsl":
        return await handleTypecheckDsl(args as { project_json_path: string });
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

async function handleXmlToDsl(args: { xml_path: string; out_dir: string }) {
  const definitions = await loadBundledNodeDefinitions();
  const xmlText = await readUtf8TextFile(args.xml_path);
  const result = importStormworksXmlToProjectSource(xmlText, {
    definitions,
    sourceName: args.xml_path,
    entryDocumentId: "main.sw-net",
  });

  const diagnosticLines = formatDiagnostics(result.diagnostics);

  if (!result.value) {
    return errorResult(`Conversion failed.\n${diagnosticLines}`);
  }

  await writeProjectSourceToDirectory(result.value, args.out_dir);

  const lines = [
    `Conversion completed: ${args.out_dir}`,
    "",
    `Output files:`,
    `  ${args.out_dir}/project.json`,
    `  ${args.out_dir}/main.sw-net`,
    `  ${args.out_dir}/main.sw-mcl`,
  ];

  if (diagnosticLines) {
    lines.push("", "Warnings:", diagnosticLines);
  }

  return textResult(lines.join("\n"));
}

async function handleDslToXml(args: { project_json_path: string; out_path?: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`Failed to load DSL.\n${formatDiagnostics(diagnostics)}`);
  }

  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlFromProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...buildResult.diagnostics);

  if (!buildResult.value) {
    return errorResult(`Failed to generate XML.\n${formatDiagnostics(diagnostics)}`);
  }

  if (args.out_path) {
    await writeUtf8TextFile(args.out_path, buildResult.value.xml);
    const lines = [`XML output completed: ${args.out_path}`];

    if (diagnostics.length > 0) {
      lines.push("", "Warnings:", formatDiagnostics(diagnostics));
    }

    return textResult(lines.join("\n"));
  }

  return textResult(buildResult.value.xml);
}

async function handleCheckDsl(args: { project_json_path: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`Failed to load DSL.\n${formatDiagnostics(diagnostics)}`);
  }

  const resolveResult = await resolveProjectSource(loadResult.value, {
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...resolveResult.diagnostics);

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const summary = resolveResult.value
    ? `Documents: ${resolveResult.value.documents.length} / Modules: ${resolveResult.value.swNet.modules.length} / use statements: ${resolveResult.value.swNet.uses.length}`
    : "Resolution failed";

  const lines = [hasErrors ? "Check failed" : "Check passed", summary];

  if (diagnostics.length > 0) {
    lines.push("", formatDiagnostics(diagnostics));
  }

  return hasErrors ? errorResult(lines.join("\n")) : textResult(lines.join("\n"));
}

async function handleTypecheckDsl(args: { project_json_path: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`Failed to load DSL.\n${formatDiagnostics(diagnostics)}`);
  }

  const definitions = await loadBundledNodeDefinitions();
  const validationResult = await validateProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...validationResult.diagnostics);

  const hasErrors = diagnostics.some((d) => d.severity === "error") || !validationResult.isValid;
  const lines = [validationResult.isValid ? "Typecheck passed" : "Typecheck failed"];

  if (diagnostics.length > 0) {
    lines.push("", formatDiagnostics(diagnostics));
  }

  return hasErrors ? errorResult(lines.join("\n")) : textResult(lines.join("\n"));
}

function formatDiagnostics(diagnostics: StormworksLibraryDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const location = [d.documentId, d.path].filter(Boolean).join(":");
      const suffix = location ? ` (${location})` : "";
      return `[${d.severity}] ${d.code}${suffix}: ${d.message}`;
    })
    .join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
