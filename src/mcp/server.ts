import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  applyProjectSourceLayoutOverrides,
  buildGateSpec,
  buildSpecOverview,
  buildStormworksXmlFromProjectSource,
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
  validateProjectSource,
  writeProjectSourceToDirectory,
  writeUtf8TextFile,
  formatDiagnostics,
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
        "Convert the DSL file set (project.json + .sw-net + .sw-mcl) into Stormworks microcontroller XML. Any module with a missing or incomplete .sw-mcl gets ELK auto-layout computed in memory for this conversion only; no .sw-mcl file is created or modified on disk (use layout_dsl to persist a layout).",
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
    {
      name: "spec",
      description:
        "Read the Stormworks gate and tool behavior reference. With no arguments it returns the overview; use list=true for all gate IDs or gate_id for one gate.",
      inputSchema: {
        type: "object",
        properties: {
          gate_id: {
            type: "string",
            description: "Optional gate definition ID to inspect, for example SR_LATCH",
          },
          list: {
            type: "boolean",
            description: "When true, list every queryable gate ID instead of returning details",
          },
          json: {
            type: "boolean",
            description: "When true, return machine-readable JSON instead of formatted text",
          },
        },
      },
    },
    {
      name: "layout_dsl",
      description:
        "Compute (and by default write) .sw-mcl auto-layout for one or more sw-net modules via ELK. Missing positions are filled in unless force=true, which regenerates every position. Known limitation: one module per file (see issue #7); other modules in the same file are left untouched with a warning.",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "Absolute path to project.json",
          },
          module_id: {
            type: "string",
            description: "Optional module ID to target; defaults to the entry module (or the file's sole module)",
          },
          document_path: {
            type: "string",
            description:
              "Optional path to a specific .sw-net document (relative to project.json's directory) to target instead of the entry module",
          },
          all_submodules: {
            type: "boolean",
            description: "When true, run layout for every submodule listed in project.json instead of just one target",
          },
          force: {
            type: "boolean",
            description: "When true, regenerate every port/instance position instead of only filling in missing ones",
          },
          dry_run: {
            type: "boolean",
            description: "When true, compute the layout and return it without writing any .sw-mcl file",
          },
          grid_size: {
            type: "number",
            description: "Optional snap grid size for computed positions",
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
      case "spec":
        return await handleSpec(args as { gate_id?: string; list?: boolean; json?: boolean } | undefined);
      case "layout_dsl":
        return await handleLayoutDsl(
          args as {
            project_json_path: string;
            module_id?: string;
            document_path?: string;
            all_submodules?: boolean;
            force?: boolean;
            dry_run?: boolean;
            grid_size?: number;
          },
        );
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
  const layoutResult = await computeProjectLayoutOverrides(args.project_json_path);
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`Failed to load DSL.\n${formatDiagnostics(diagnostics)}`);
  }

  const projectSource = applyProjectSourceLayoutOverrides(loadResult.value, layoutResult.overridesByDocumentId);
  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlFromProjectSource(projectSource, {
    definitions,
    loadImportedDocument: createLayoutOverridingDocumentLoader(
      createFileSystemProjectSourceDocumentLoader(),
      layoutResult.overridesByDocumentId,
    ),
  });
  diagnostics.push(...buildResult.diagnostics);

  if (!buildResult.value) {
    return errorResult(`Failed to generate XML.\n${formatDiagnostics(diagnostics)}`);
  }

  if (args.out_path) {
    await writeUtf8TextFile(args.out_path, buildResult.value.xml);
    const lines = [`XML output completed: ${args.out_path}`, ...layoutResult.messages.map((message) => `Auto-layout: ${message}`)];

    if (diagnostics.length > 0) {
      lines.push("", "Warnings:", formatDiagnostics(diagnostics));
    }

    return textResult(lines.join("\n"));
  }

  // Documented contract: with no out_path, the response is exactly the XML text (agents may save it
  // verbatim), so auto-layout notices/diagnostics are intentionally not prepended here.
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

async function handleSpec(args: { gate_id?: string; list?: boolean; json?: boolean } = {}) {
  if (args.list && args.gate_id) {
    return errorResult("Use either list=true or gate_id, not both.");
  }

  const definitions = await loadBundledNodeDefinitions();

  // Keep the MCP behavior aligned with `storm-mcl spec`: the overview is cheap and helps
  // agents understand tool conventions, while per-gate behavior notes are loaded only when
  // a specific definition is requested. This avoids surprising latency for simple ID lists.
  if (args.list) {
    const summaries = listGateSpecSummaries(definitions);
    return textResult(args.json ? JSON.stringify(summaries, null, 2) : formatGateSpecListText(summaries));
  }

  if (args.gate_id) {
    const notesDoc = await loadBundledNodeBehaviorNotes();
    const spec = buildGateSpec(args.gate_id, definitions, notesDoc);

    if (!spec) {
      return errorResult(`Unknown gate id: ${args.gate_id}. Use the spec tool with list=true to see valid ids.`);
    }

    return textResult(args.json ? JSON.stringify(spec, null, 2) : formatGateSpecText(spec));
  }

  const systemNotes = await loadBundledStormworksSystemNotes();
  const overview = buildSpecOverview(systemNotes);
  return textResult(args.json ? JSON.stringify(overview, null, 2) : formatSpecOverviewText(overview));
}

async function handleLayoutDsl(args: {
  project_json_path: string;
  module_id?: string;
  document_path?: string;
  all_submodules?: boolean;
  force?: boolean;
  dry_run?: boolean;
  grid_size?: number;
}) {
  if (args.all_submodules && (args.module_id !== undefined || args.document_path !== undefined)) {
    return errorResult("Use all_submodules alone; it cannot be combined with module_id or document_path.");
  }

  const targets = await resolveLayoutTargets(args.project_json_path, {
    document: args.document_path,
    module: args.module_id,
    allSubmodules: args.all_submodules,
  });

  const sections: string[] = [];
  let hasErrors = false;

  for (const target of targets) {
    const lines = [`${target.swMclPath}:`];

    let result: Awaited<ReturnType<typeof runLayoutDslForTarget>>;

    try {
      result = await runLayoutDslForTarget(target, {
        force: args.force ?? false,
        dryRun: args.dry_run ?? false,
        gridSize: args.grid_size,
      });
    } catch (error) {
      hasErrors = true;
      lines.push(`  error: ${error instanceof Error ? error.message : String(error)}`);
      sections.push(lines.join("\n"));
      continue;
    }

    if (!result.ok) {
      hasErrors = true;
      lines.push(`  error: ${result.errorMessage}`);
      sections.push(lines.join("\n"));
      continue;
    }

    for (const warning of result.warnings) {
      lines.push(`  warning: ${warning}`);
    }

    if (result.summary) {
      lines.push(
        `  ${result.summary.kept} kept, ${result.summary.added} added, ${result.summary.overwritten} overwritten.`,
      );
    }

    lines.push(result.written ? `  Wrote ${target.swMclPath}` : "  (dry run, not written)");

    if (args.dry_run && result.document) {
      lines.push("", JSON.stringify(result.document, null, 2));
    }

    sections.push(lines.join("\n"));
  }

  const text = sections.join("\n\n");
  return hasErrors ? errorResult(text) : textResult(text);
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
