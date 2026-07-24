// Node-side helpers that load and write the standard CLI project-source file layout on disk.
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  parseProjectJsonText,
  parseSourceDocumentTexts,
  createErrorDiagnostic,
  createWarningDiagnostic,
  serializeSourceDocumentTexts,
  type Diagnostic,
  type ProjectJsonDocument,
  type StormworksDocumentLoader,
  type StormworksLibraryResult,
  type StormworksProjectSource,
  type StormworksSourceDocument,
} from "../../index.js";
import { type SwNetDocument, type SwNetInstStatement } from "../../core/parsers/sw-net.js";
import { parseStormworksSwMclText } from "../../core/parsers/sw-mcl.js";
import { type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { readUtf8TextFile, writeUtf8TextFile } from "./text-file.js";
import { selectEntrySubmodule, isFileNotFoundError } from "./project-file-helpers.js";
import { resolveRelativeSwNetAssetPath, resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";

export const DEFAULT_PROJECT_JSON_FILE_NAME = "project.json";
export const DEFAULT_ENTRY_SW_NET_FILE_NAME = "main.sw-net";
export const DEFAULT_ENTRY_SW_MCL_FILE_NAME = "main.sw-mcl";

export interface ProjectSourceFilePaths {
  projectJsonPath: string;
  entrySwNetPath: string;
  entrySwMclPath: string;
  directoryPath: string;
}

// Resolve the standard companion-file paths for one project.json location.
export function resolveProjectSourceFilePaths(
  projectJsonPath: string,
  project?: ProjectJsonDocument,
): ProjectSourceFilePaths {
  const resolvedProjectJsonPath = resolve(projectJsonPath);
  const directoryPath = dirname(resolvedProjectJsonPath);
  const entryRelativePath = project ? (selectEntrySubmodule(project)?.relativePath ?? DEFAULT_ENTRY_SW_NET_FILE_NAME) : DEFAULT_ENTRY_SW_NET_FILE_NAME;
  const entrySwNetPath = resolve(directoryPath, ...entryRelativePath.split("/"));

  return {
    projectJsonPath: resolvedProjectJsonPath,
    entrySwNetPath,
    entrySwMclPath: replaceSwNetExtension(entrySwNetPath, ".sw-mcl"),
    directoryPath,
  };
}

// Load project.json plus its standard entry sw-net/sw-mcl companions from disk.
export async function loadProjectSourceFromProjectJsonFile(
  projectJsonPath: string,
): Promise<StormworksLibraryResult<StormworksProjectSource>> {
  const diagnostics: Diagnostic[] = [];
  const filePaths = resolveProjectSourceFilePaths(projectJsonPath);

  try {
    const projectJsonText = await readUtf8TextFile(filePaths.projectJsonPath);
    const project = parseProjectJsonText(projectJsonText);
    // The entry sw-net path comes from project.json when available so renamed entry documents still load correctly.
    const entrySubmodule = selectEntrySubmodule(project);
    const entryRelativePath = entrySubmodule?.relativePath ?? DEFAULT_ENTRY_SW_NET_FILE_NAME;
    const entrySwNetPath = resolve(filePaths.directoryPath, ...entryRelativePath.split("/"));
    const entrySwMclPath = replaceSwNetExtension(entrySwNetPath, ".sw-mcl");
    const entryModuleId = basename(entrySwNetPath, ".sw-net");
    const [swNetText, swMcl] = await Promise.all([
      readUtf8TextFile(entrySwNetPath),
      readSwMclDocumentOrNull(entrySwMclPath),
    ]);
    const parsedEntry = parseSourceDocumentTexts({
      documentId: entrySwNetPath,
      swNetText,
    });

    diagnostics.push(...parsedEntry.diagnostics);

    if (!parsedEntry.value) {
      return { diagnostics };
    }

    const scripts = await loadReferencedScriptsFromDocument(entrySwNetPath, parsedEntry.value.swNet);
    const entryDocument: StormworksSourceDocument = {
      ...parsedEntry.value,
      swMcl,
      scripts,
      swMclOrigin: swMcl === null ? undefined : "file",
    };

    return {
      value: {
        project,
        entryDocument,
        entryModuleId: entrySubmodule?.name ?? entryDocument.swMcl?.moduleId ?? entryModuleId,
        sourceName: project.sourceName ?? filePaths.projectJsonPath,
        warnings: project.warnings.map((warning) =>
          createWarningDiagnostic("PROJECT_JSON_WARNING", warning, "project", filePaths.projectJsonPath),
        ),
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "PROJECT_SOURCE_LOAD_FAILED",
        error instanceof Error ? error.message : String(error),
        "library",
        filePaths.projectJsonPath,
      ),
    );

    return { diagnostics };
  }
}

// Create a document loader that resolves imported sw-net files from the local file system.
export function createFileSystemProjectSourceDocumentLoader(): StormworksDocumentLoader["loadImportedDocument"] {
  return async ({ fromDocumentId, importPath }) => {
    const resolvedSwNetPath = resolveRelativeSwNetImportPath(fromDocumentId, importPath);

    try {
      return await loadSourceDocumentFromSwNetFile(resolvedSwNetPath);
    } catch {
      return undefined;
    }
  };
}

// Load one sw-net/sw-mcl document pair plus its referenced script assets from disk.
export async function loadSourceDocumentFromSwNetFile(
  swNetPath: string,
): Promise<StormworksSourceDocument> {
  const resolvedSwNetPath = resolve(swNetPath);
  const swMclPath = replaceSwNetExtension(resolvedSwNetPath, ".sw-mcl");
  const [swNetText, swMcl] = await Promise.all([
    readUtf8TextFile(resolvedSwNetPath),
    readSwMclDocumentOrNull(swMclPath),
  ]);
  const parsed = parseSourceDocumentTexts({
    documentId: resolvedSwNetPath,
    swNetText,
  });

  if (!parsed.value) {
    throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  return {
    ...parsed.value,
    swMcl,
    scripts: await loadReferencedScriptsFromDocument(resolvedSwNetPath, parsed.value.swNet),
    swMclOrigin: swMcl === null ? undefined : "file",
  };
}

// Write the standard CLI file layout for one project source into a target directory.
export async function writeProjectSourceToDirectory(
  projectSource: StormworksProjectSource,
  outputDirectory: string,
): Promise<void> {
  const resolvedOutputDirectory = resolve(outputDirectory);
  const serializedEntry = serializeSourceDocumentTexts(projectSource.entryDocument);
  const entrySubmodule = selectEntrySubmodule(projectSource.project);
  const entryRelativePath = entrySubmodule?.relativePath ?? DEFAULT_ENTRY_SW_NET_FILE_NAME;
  const entrySwNetPath = join(resolvedOutputDirectory, ...entryRelativePath.split("/"));
  const entrySwMclPath = replaceSwNetExtension(entrySwNetPath, ".sw-mcl");
  const entryAssetDirectory = dirname(entrySwNetPath);

  // Create directories up front so writes can happen in parallel without races on missing folders.
  await mkdir(resolvedOutputDirectory, { recursive: true });
  await mkdir(dirname(entrySwNetPath), { recursive: true });
  await Promise.all([
    writeUtf8TextFile(join(resolvedOutputDirectory, DEFAULT_PROJECT_JSON_FILE_NAME), `${JSON.stringify(projectSource.project, null, 2)}\n`),
    writeUtf8TextFile(entrySwNetPath, serializedEntry.swNetText),
    // A null swMclText means the source document has no real layout data; skip writing a placeholder
    // so a missing .sw-mcl doesn't get permanently baked to disk as if it were real data.
    ...(serializedEntry.swMclText !== null ? [writeUtf8TextFile(entrySwMclPath, `${serializedEntry.swMclText}\n`)] : []),
    ...Object.entries(serializedEntry.scripts).map(async ([relativeScriptPath, text]) => {
      const targetPath = join(entryAssetDirectory, ...relativeScriptPath.split("/"));
      await mkdir(dirname(targetPath), { recursive: true });
      await writeUtf8TextFile(targetPath, text);
    }),
  ]);
}

// Load script files referenced by script_ref attributes within one sw-net document.
async function loadReferencedScriptsFromDocument(
  documentPath: string,
  swNet: SwNetDocument,
): Promise<Record<string, string>> {
  const scripts: Record<string, string> = {};
  const scriptRefs = collectScriptRefs(swNet);

  await Promise.all(
    [...scriptRefs].map(async (scriptRef) => {
      try {
        scripts[scriptRef] = await readUtf8TextFile(resolveRelativeSwNetAssetPath(documentPath, scriptRef));
      } catch {
        // Missing scripts are surfaced by validation later; this loader simply omits absent files.
        // Missing scripts are validated later; loading omits them.
      }
    }),
  );

  return scripts;
}

// Collect the distinct script_ref paths mentioned by inst statements in a sw-net document.
function collectScriptRefs(swNet: SwNetDocument): Set<string> {
  const scriptRefs = new Set<string>();

  for (const statement of swNet.modules.flatMap((module) => module.statements)) {
    if (statement.kind !== "inst") {
      continue;
    }

    const scriptRef = getStatementScriptRef(statement);

    if (scriptRef) {
      scriptRefs.add(scriptRef);
    }
  }

  return scriptRefs;
}

// Extract one string-valued script_ref from an inst statement when present.
function getStatementScriptRef(statement: SwNetInstStatement): string | undefined {
  const scriptRefValue = statement.attributes.find(
    (attribute) => attribute.key === "script_ref" && attribute.value.kind === "string",
  )?.value.value;

  return typeof scriptRefValue === "string" ? scriptRefValue : undefined;
}

// Replace a .sw-net extension with the matching companion-file extension.
export function replaceSwNetExtension(filePath: string, nextExtension: string): string {
  if (extname(filePath) !== ".sw-net") {
    throw new Error(`Expected a .sw-net file path, received ${filePath}.`);
  }

  return filePath.slice(0, -".sw-net".length) + nextExtension;
}

// Read and parse a sw-mcl file, returning null (rather than a synthesized placeholder) if no file exists.
async function readSwMclDocumentOrNull(swMclPath: string): Promise<StormworksSwMclDocument | null> {
  try {
    return parseStormworksSwMclText(await readUtf8TextFile(swMclPath));
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}
