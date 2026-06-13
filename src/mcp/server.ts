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

const server = new Server(
  { name: "storm-mcl", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "xml_to_dsl",
      description:
        "StormworksのマイコンXMLファイルをDSL形式（project.json + .sw-net + .sw-mcl）に変換します。",
      inputSchema: {
        type: "object",
        properties: {
          xml_path: {
            type: "string",
            description: "変換元のXMLファイルの絶対パス",
          },
          out_dir: {
            type: "string",
            description: "DSLファイルの出力先ディレクトリの絶対パス",
          },
        },
        required: ["xml_path", "out_dir"],
      },
    },
    {
      name: "dsl_to_xml",
      description:
        "DSL形式（project.json + .sw-net + .sw-mcl）をStormworksのマイコンXMLファイルに変換します。",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "project.jsonファイルの絶対パス",
          },
          out_path: {
            type: "string",
            description: "出力XMLファイルの絶対パス（省略時はXMLテキストを返す）",
          },
        },
        required: ["project_json_path"],
      },
    },
    {
      name: "check_dsl",
      description:
        "DSLファイルの構文と参照（importの解決）を検証します。エラーと警告の一覧を返します。",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "project.jsonファイルの絶対パス",
          },
        },
        required: ["project_json_path"],
      },
    },
    {
      name: "typecheck_dsl",
      description:
        "DSLファイルの信号型の整合性を検証します。ポートの型ミスマッチなどを検出します。",
      inputSchema: {
        type: "object",
        properties: {
          project_json_path: {
            type: "string",
            description: "project.jsonファイルの絶対パス",
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
    return errorResult(`変換に失敗しました。\n${diagnosticLines}`);
  }

  await writeProjectSourceToDirectory(result.value, args.out_dir);

  const lines = [
    `変換が完了しました: ${args.out_dir}`,
    "",
    `出力ファイル:`,
    `  ${args.out_dir}/project.json`,
    `  ${args.out_dir}/main.sw-net`,
    `  ${args.out_dir}/main.sw-mcl`,
  ];

  if (diagnosticLines) {
    lines.push("", "警告:", diagnosticLines);
  }

  return textResult(lines.join("\n"));
}

async function handleDslToXml(args: { project_json_path: string; out_path?: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`DSLの読み込みに失敗しました。\n${formatDiagnostics(diagnostics)}`);
  }

  const definitions = await loadBundledNodeDefinitions();
  const buildResult = await buildStormworksXmlFromProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...buildResult.diagnostics);

  if (!buildResult.value) {
    return errorResult(`XML生成に失敗しました。\n${formatDiagnostics(diagnostics)}`);
  }

  if (args.out_path) {
    await writeUtf8TextFile(args.out_path, buildResult.value.xml);
    const lines = [`XML出力が完了しました: ${args.out_path}`];

    if (diagnostics.length > 0) {
      lines.push("", "警告:", formatDiagnostics(diagnostics));
    }

    return textResult(lines.join("\n"));
  }

  return textResult(buildResult.value.xml);
}

async function handleCheckDsl(args: { project_json_path: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`DSLの読み込みに失敗しました。\n${formatDiagnostics(diagnostics)}`);
  }

  const resolveResult = await resolveProjectSource(loadResult.value, {
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...resolveResult.diagnostics);

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const summary = resolveResult.value
    ? `ドキュメント数: ${resolveResult.value.documents.length} / モジュール数: ${resolveResult.value.swNet.modules.length} / use文: ${resolveResult.value.swNet.uses.length}`
    : "解決失敗";

  const lines = [hasErrors ? "チェック失敗" : "チェック通過", summary];

  if (diagnostics.length > 0) {
    lines.push("", formatDiagnostics(diagnostics));
  }

  return hasErrors ? errorResult(lines.join("\n")) : textResult(lines.join("\n"));
}

async function handleTypecheckDsl(args: { project_json_path: string }) {
  const loadResult = await loadProjectSourceFromProjectJsonFile(args.project_json_path);
  const diagnostics = [...loadResult.diagnostics];

  if (!loadResult.value) {
    return errorResult(`DSLの読み込みに失敗しました。\n${formatDiagnostics(diagnostics)}`);
  }

  const definitions = await loadBundledNodeDefinitions();
  const validationResult = await validateProjectSource(loadResult.value, {
    definitions,
    loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
  });
  diagnostics.push(...validationResult.diagnostics);

  const hasErrors = diagnostics.some((d) => d.severity === "error") || !validationResult.isValid;
  const lines = [validationResult.isValid ? "型チェック通過" : "型チェック失敗"];

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
