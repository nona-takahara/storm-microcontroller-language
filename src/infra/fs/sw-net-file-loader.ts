// Node-side sw-net file helpers that resolve imports and assets relative to on-disk documents.
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
import { readUtf8TextFile, readUtf8TextFileSync } from "./text-file.js";

// Load one sw-net file from disk and parse it into a document handle.
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

// Resolve a relative sw-net import path using the importing document as the base directory.
export function resolveRelativeSwNetImportPath(fromDocumentPath: string, importPath: string): string {
  return resolve(dirname(fromDocumentPath), importPath);
}

// Resolve a relative sw-net asset path, such as script_ref, using the current document as the base directory.
export function resolveRelativeSwNetAssetPath(fromDocumentPath: string, assetPath: string): string {
  return resolve(dirname(fromDocumentPath), assetPath);
}

// Read a text asset referenced from a sw-net document using synchronous disk access.
export function readRelativeSwNetTextFileSync(fromDocumentPath: string, assetPath: string): string {
  return readUtf8TextFileSync(resolveRelativeSwNetAssetPath(fromDocumentPath, assetPath));
}

// Adapt on-disk sw-net files to the generic document-resolver interface.
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

// Resolve the full imported-document closure for an entry sw-net file on disk.
export async function resolveSwNetFromFile(entryFilePath: string): Promise<SwNetResolutionResult> {
  const entry = await loadSwNetDocumentFromFile(entryFilePath);
  return resolveSwNetDocumentGraph(entry, createFileSystemSwNetDocumentResolver());
}
