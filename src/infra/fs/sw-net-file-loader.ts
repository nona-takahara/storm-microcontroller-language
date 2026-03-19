import { dirname, resolve } from "node:path";

import {
  parseSwNetDocument,
  type SwNetDocument,
  type SwNetParseOptions,
} from "../../core/parsers/sw-net.js";
import {
  resolveSwNetDocumentGraph,
  type SwNetDocumentHandle,
  type SwNetDocumentResolver,
  type SwNetResolutionResult,
} from "../../core/resolvers/sw-net.js";
import { readUtf8TextFile } from "./text-file.js";

export async function loadSwNetDocumentFromFile(
  filePath: string,
  options: SwNetParseOptions = {},
): Promise<SwNetDocumentHandle> {
  const resolvedPath = resolve(filePath);
  const text = await readUtf8TextFile(resolvedPath);

  return {
    path: resolvedPath,
    document: parseSwNetDocument(text, {
      sourceName: options.sourceName ?? resolvedPath,
    }),
  };
}

export function resolveRelativeSwNetImportPath(fromDocumentPath: string, importPath: string): string {
  return resolve(dirname(fromDocumentPath), importPath);
}

export function createFileSystemSwNetDocumentResolver(): SwNetDocumentResolver {
  return {
    resolveImportPath(fromDocumentPath, importPath) {
      return resolveRelativeSwNetImportPath(fromDocumentPath, importPath);
    },
    async loadDocument(documentPath): Promise<SwNetDocument> {
      const loaded = await loadSwNetDocumentFromFile(documentPath);
      return loaded.document;
    },
  };
}

export async function resolveSwNetFromFile(entryFilePath: string): Promise<SwNetResolutionResult> {
  const entry = await loadSwNetDocumentFromFile(entryFilePath);
  return resolveSwNetDocumentGraph(entry, createFileSystemSwNetDocumentResolver());
}
