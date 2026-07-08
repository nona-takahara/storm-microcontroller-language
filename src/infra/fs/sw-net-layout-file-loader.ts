// Node-side file helpers for the layout-dsl CLI command: resolve targets, read a sw-net/optional-sw-mcl
// pair, and write the computed sw-mcl document back to disk.
import { dirname, resolve } from "node:path";

import { parseProjectJsonText } from "../../core/parsers/project-json.js";
import { parseSwNetDocument, type SwNetDocument } from "../../core/parsers/sw-net.js";
import { parseStormworksSwMclText } from "../../core/parsers/sw-mcl.js";
import { type ProjectJsonDocument, type ProjectJsonSubmoduleDocument } from "../../core/serializers/project-json.js";
import { type StormworksSwMclDocument } from "../../core/serializers/sw-mcl.js";
import { DEFAULT_ENTRY_SW_NET_FILE_NAME, replaceSwNetExtension } from "./project-source-file-loader.js";
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

function selectEntrySubmodule(project: ProjectJsonDocument): ProjectJsonSubmoduleDocument | undefined {
  return (
    project.submodules.find((submodule) => submodule.id === "main") ??
    project.submodules.find((submodule) => submodule.name === "main") ??
    (project.submodules.length === 1 ? project.submodules[0] : undefined)
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
