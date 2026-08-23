import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  materializeSynchronizationSources,
  parseSourceDocumentTexts,
  validateProjectSource,
  type NodeDefinitionRegistry,
  type ResolvedStormworksProjectSource,
  type StormworksProjectSource,
  type StormworksSourceDocument,
  type SynchronizationPlan,
} from "../../index.js";
import { resolveRelativeSwNetAssetPath, resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";

export interface ApplySynchronizationPlanOptions {
  projectJsonPath: string;
  outputDirectory?: string;
  definitions: NodeDefinitionRegistry;
}

export interface ApplySynchronizationPlanResult {
  writtenPaths: string[];
  deletedPaths: string[];
}

interface PendingFileOperation { path: string; text?: string }

/** Validate the complete projected project, then replace only its explicit file set with rollback. */
export async function applySynchronizationPlanToDisk(
  existing: ResolvedStormworksProjectSource,
  plan: SynchronizationPlan,
  options: ApplySynchronizationPlanOptions,
): Promise<ApplySynchronizationPlanResult> {
  if (!plan.applicable) {
    throw new Error("A synchronization plan with blocking conflicts cannot be written.");
  }
  const prepared = prepareSynchronizedProject(existing, plan);
  const validation = await validateProjectSource(prepared.projectSource, {
    definitions: options.definitions,
    loadImportedDocument: async ({ fromDocumentId, importPath }) =>
      prepared.documentById.get(resolveRelativeSwNetImportPath(fromDocumentId, importPath)),
  });
  if (!validation.isValid) {
    throw new Error(validation.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  const operations = buildFileOperations(existing, prepared, plan, options);
  await replaceFilesWithRollback(operations);
  return {
    writtenPaths: operations.filter((operation) => operation.text !== undefined).map((operation) => operation.path),
    deletedPaths: operations.filter((operation) => operation.text === undefined).map((operation) => operation.path),
  };
}

function prepareSynchronizedProject(
  existing: ResolvedStormworksProjectSource,
  plan: SynchronizationPlan,
): { projectSource: StormworksProjectSource; documentById: Map<string, StormworksSourceDocument> } {
  const editedText = materializeSynchronizationSources(existing, plan);
  const layoutByDocument = new Map(plan.layouts.map((layout) => [layout.documentPath, layout.swMcl] as const));
  const documentById = new Map<string, StormworksSourceDocument>();

  for (const document of existing.documents) {
    const text = editedText[document.documentId] ?? document.swNetSource?.text;
    if (text === undefined) throw new Error(`Exact sw-net source text is unavailable for ${document.documentId}.`);
    const swMcl = layoutByDocument.get(document.documentId) ?? document.swMcl;
    const scripts = { ...document.scripts };
    for (const script of plan.lua.remove) {
      if (script.documentPath === document.documentId) delete scripts[script.path];
    }
    for (const script of [...plan.lua.create, ...plan.lua.update]) {
      if (script.documentPath === document.documentId) scripts[script.path] = script.text;
    }
    const parsed = parseSourceDocumentTexts({
      documentId: document.documentId,
      swNetText: text,
      swMclText: swMcl ? JSON.stringify(swMcl, null, 2) : undefined,
      scripts,
    });
    if (!parsed.value) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    documentById.set(document.documentId, { ...parsed.value, swMclOrigin: swMcl ? "file" : undefined });
  }

  const entryDocument = documentById.get(existing.projectSource.entryDocument.documentId);
  if (!entryDocument) throw new Error("The synchronized entry document was not prepared.");
  return {
    documentById,
    projectSource: { ...existing.projectSource, project: plan.project, entryDocument },
  };
}

function buildFileOperations(
  existing: ResolvedStormworksProjectSource,
  prepared: ReturnType<typeof prepareSynchronizedProject>,
  plan: SynchronizationPlan,
  options: ApplySynchronizationPlanOptions,
): PendingFileOperation[] {
  const sourceRoot = dirname(resolve(options.projectJsonPath));
  const targetRoot = options.outputDirectory ? resolve(options.outputDirectory) : sourceRoot;
  const copyAll = options.outputDirectory !== undefined;
  const editedDocuments = new Set(plan.sourceEdits.map((edit) => edit.documentPath));
  const layoutDocuments = new Set(plan.layouts.map((layout) => layout.documentPath));
  const writtenLua = new Set([...plan.lua.create, ...plan.lua.update].map((script) => `${script.documentPath}\0${script.path}`));
  const operations: PendingFileOperation[] = [
    { path: join(targetRoot, "project.json"), text: `${JSON.stringify(plan.project, null, 2)}\n` },
  ];

  for (const document of prepared.documentById.values()) {
    const relativeDocumentPath = safeRelativePath(sourceRoot, document.documentId);
    const targetDocumentPath = resolve(targetRoot, relativeDocumentPath);
    if (copyAll || editedDocuments.has(document.documentId)) {
      operations.push({ path: targetDocumentPath, text: document.swNetSource!.text });
    }
    if (document.swMcl && (copyAll || layoutDocuments.has(document.documentId))) {
      operations.push({ path: replaceExtension(targetDocumentPath, ".sw-mcl"), text: `${JSON.stringify(document.swMcl, null, 2)}\n` });
    }
    for (const [scriptPath, text] of Object.entries(document.scripts)) {
      if (copyAll || writtenLua.has(`${document.documentId}\0${scriptPath}`)) {
        const sourceAsset = resolveRelativeSwNetAssetPath(document.documentId, scriptPath);
        const relativeAsset = safeRelativePath(sourceRoot, sourceAsset);
        operations.push({ path: resolve(targetRoot, relativeAsset), text });
      }
    }
  }

  if (!copyAll) {
    const retainedScriptTargets = new Set([...prepared.documentById.values()].flatMap((document) =>
      Object.keys(document.scripts).map((scriptPath) => resolve(resolveRelativeSwNetAssetPath(document.documentId, scriptPath))),
    ));
    for (const script of plan.lua.remove) {
      const document = existing.documents.find((candidate) => candidate.documentId === script.documentPath);
      if (!document || !(script.path in document.scripts)) continue;
      const target = resolveRelativeSwNetAssetPath(document.documentId, script.path);
      safeRelativePath(sourceRoot, target);
      // Different sw-net documents can intentionally resolve the same relative script reference to
      // one physical sidecar. A document-scoped removal must not delete that asset while any
      // synchronized document still exposes it.
      if (retainedScriptTargets.has(resolve(target))) continue;
      operations.push({ path: target });
    }
  }
  return deduplicateOperations(operations);
}

async function replaceFilesWithRollback(operations: PendingFileOperation[]): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}`;
  const prepared: Array<PendingFileOperation & { temp?: string; backup?: string; existed: boolean }> = [];
  let committed = false;
  try {
    for (const [index, operation] of operations.entries()) {
      await mkdir(dirname(operation.path), { recursive: true });
      const existed = await pathExists(operation.path);
      const backup = existed ? `${operation.path}.storm-mcl-backup-${nonce}-${index}` : undefined;
      const temp = operation.text === undefined ? undefined : `${operation.path}.storm-mcl-temp-${nonce}-${index}`;
      if (temp && operation.text !== undefined) await writeFile(temp, operation.text, "utf8");
      prepared.push({ ...operation, temp, backup, existed });
    }
    for (const operation of prepared) {
      if (operation.backup) await rename(operation.path, operation.backup);
      if (operation.temp) await rename(operation.temp, operation.path);
    }
    committed = true;
  } catch (error) {
    for (const operation of [...prepared].reverse()) {
      if (operation.temp && await pathExists(operation.temp)) await unlink(operation.temp);
      if (operation.backup && await pathExists(operation.backup)) {
        if (await pathExists(operation.path)) await unlink(operation.path);
        await rename(operation.backup, operation.path);
      } else if (!operation.existed && await pathExists(operation.path)) {
        await unlink(operation.path);
      }
    }
    throw error;
  }
  if (committed) {
    for (const operation of prepared) {
      if (operation.backup) await unlink(operation.backup).catch(() => undefined);
    }
  }
}

function safeRelativePath(root: string, target: string): string {
  const value = relative(root, resolve(target));
  if (!value || value === "." || value.startsWith("..") || isAbsolute(value)) {
    throw new Error(`Synchronization target is outside the project root: ${target}`);
  }
  return value;
}

function replaceExtension(path: string, extension: string): string {
  return path.endsWith(".sw-net") ? `${path.slice(0, -".sw-net".length)}${extension}` : `${path}${extension}`;
}

function deduplicateOperations(operations: PendingFileOperation[]): PendingFileOperation[] {
  const result = new Map<string, PendingFileOperation>();
  for (const operation of operations) {
    const previous = result.get(operation.path);
    if (previous && previous.text !== operation.text) {
      throw new Error(`Conflicting synchronization operations target the same physical file: ${operation.path}`);
    }
    result.set(operation.path, operation);
  }
  return [...result.values()];
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
