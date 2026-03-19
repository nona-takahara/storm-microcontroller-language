import {
  type SwNetDocument,
  type SwNetImportedModuleRef,
  type SwNetImport,
  type SwNetModule,
  type SwNetModuleRef,
  type SwNetStatement,
  type SwNetUseStatement,
} from "../parsers/sw-net.js";

export interface SwNetDocumentHandle {
  path: string;
  document: SwNetDocument;
}

export interface SwNetDocumentResolver {
  resolveImportPath(fromDocumentPath: string, importPath: string): string;
  loadDocument(documentPath: string): Promise<SwNetDocument>;
}

export interface SwNetResolvedModuleKey {
  documentPath: string;
  moduleId: string;
}

export interface SwNetResolvedUse {
  caller: SwNetResolvedModuleKey;
  target: SwNetResolvedModuleKey;
  statement: SwNetUseStatement;
}

export interface SwNetResolvedModule {
  key: SwNetResolvedModuleKey;
  module: SwNetModule;
  uses: SwNetResolvedUse[];
}

export interface SwNetResolutionResult {
  entryDocumentPath: string;
  documents: SwNetDocumentHandle[];
  modules: SwNetResolvedModule[];
  uses: SwNetResolvedUse[];
}

export class SwNetResolveError extends Error {
  constructor(
    message: string,
    readonly context?: {
      documentPath?: string;
      moduleId?: string;
      importPath?: string;
    },
  ) {
    const suffixParts = [
      context?.documentPath ? `document=${context.documentPath}` : undefined,
      context?.moduleId ? `module=${context.moduleId}` : undefined,
      context?.importPath ? `import=${context.importPath}` : undefined,
    ].filter((part): part is string => part !== undefined);
    super(suffixParts.length > 0 ? `${message} (${suffixParts.join(", ")})` : message);
    this.name = "SwNetResolveError";
  }
}

export async function resolveSwNetDocumentGraph(
  entry: SwNetDocumentHandle,
  resolver: SwNetDocumentResolver,
): Promise<SwNetResolutionResult> {
  const documentsByPath = await loadDocumentClosure(entry, resolver);
  const resolvedModules: SwNetResolvedModule[] = [];
  const resolvedUses: SwNetResolvedUse[] = [];

  for (const documentHandle of documentsByPath.values()) {
    const importPathByAlias = buildImportAliasIndex(
      documentHandle.path,
      documentHandle.document.imports,
      resolver,
    );
    const localModuleIndex = buildLocalModuleIndex(documentHandle.path, documentHandle.document.modules);

    for (const module of documentHandle.document.modules) {
      const caller: SwNetResolvedModuleKey = {
        documentPath: documentHandle.path,
        moduleId: module.id,
      };
      const uses = collectUseStatements(module.statements).map((statement) =>
        resolveUseStatement(
          documentHandle.path,
          caller,
          statement,
          documentsByPath,
          localModuleIndex,
          importPathByAlias,
        ),
      );

      resolvedModules.push({
        key: caller,
        module,
        uses,
      });
      resolvedUses.push(...uses);
    }
  }

  ensureAcyclicModuleGraph(resolvedModules);

  return {
    entryDocumentPath: entry.path,
    documents: [...documentsByPath.values()].sort(compareDocumentHandles),
    modules: resolvedModules.sort(compareResolvedModules),
    uses: resolvedUses.sort(compareResolvedUses),
  };
}

async function loadDocumentClosure(
  entry: SwNetDocumentHandle,
  resolver: SwNetDocumentResolver,
): Promise<Map<string, SwNetDocumentHandle>> {
  const documentsByPath = new Map<string, SwNetDocumentHandle>();
  const pendingPaths: string[] = [];

  documentsByPath.set(entry.path, entry);
  pendingPaths.push(entry.path);

  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.shift();

    if (!currentPath) {
      continue;
    }

    const currentDocument = documentsByPath.get(currentPath);

    if (!currentDocument) {
      continue;
    }

    for (const imported of currentDocument.document.imports) {
      validateImportPath(imported.path, currentPath);
      const resolvedPath = resolver.resolveImportPath(currentPath, imported.path);

      if (documentsByPath.has(resolvedPath)) {
        continue;
      }

      const document = await resolver.loadDocument(resolvedPath);
      const handle: SwNetDocumentHandle = {
        path: resolvedPath,
        document,
      };

      documentsByPath.set(resolvedPath, handle);
      pendingPaths.push(resolvedPath);
    }
  }

  return documentsByPath;
}

function resolveUseStatement(
  documentPath: string,
  caller: SwNetResolvedModuleKey,
  statement: SwNetUseStatement,
  documentsByPath: Map<string, SwNetDocumentHandle>,
  localModuleIndex: Map<string, SwNetModule>,
  importPathByAlias: Map<string, string>,
): SwNetResolvedUse {
  const target = resolveModuleRef(documentPath, statement.moduleRef, documentsByPath, localModuleIndex, importPathByAlias);

  return {
    caller,
    target,
    statement,
  };
}

function resolveModuleRef(
  documentPath: string,
  moduleRef: SwNetModuleRef,
  documentsByPath: Map<string, SwNetDocumentHandle>,
  localModuleIndex: Map<string, SwNetModule>,
  importPathByAlias: Map<string, string>,
): SwNetResolvedModuleKey {
  if (moduleRef.kind === "local") {
    if (!localModuleIndex.has(moduleRef.moduleId)) {
      throw new SwNetResolveError(`Local module ${moduleRef.moduleId} was not found`, {
        documentPath,
        moduleId: moduleRef.moduleId,
      });
    }

    return {
      documentPath,
      moduleId: moduleRef.moduleId,
    };
  }

  return resolveImportedModuleRef(documentPath, moduleRef, documentsByPath, importPathByAlias);
}

function resolveImportedModuleRef(
  documentPath: string,
  moduleRef: SwNetImportedModuleRef,
  documentsByPath: Map<string, SwNetDocumentHandle>,
  importPathByAlias: Map<string, string>,
): SwNetResolvedModuleKey {
  const importedDocumentPath = importPathByAlias.get(moduleRef.alias);

  if (!importedDocumentPath) {
    throw new SwNetResolveError(`Import alias ${moduleRef.alias} was not found`, {
      documentPath,
      moduleId: moduleRef.moduleId,
    });
  }

  const importedDocument = documentsByPath.get(importedDocumentPath);

  if (!importedDocument) {
    throw new SwNetResolveError(`Imported document ${importedDocumentPath} was not loaded`, {
      documentPath,
      importPath: importedDocumentPath,
    });
  }

  const targetModule = importedDocument.document.modules.find((module) => module.id === moduleRef.moduleId);

  if (!targetModule) {
    throw new SwNetResolveError(`Imported module ${moduleRef.moduleId} was not found`, {
      documentPath: importedDocumentPath,
      moduleId: moduleRef.moduleId,
    });
  }

  return {
    documentPath: importedDocumentPath,
    moduleId: moduleRef.moduleId,
  };
}

function buildImportAliasIndex(
  documentPath: string,
  imports: SwNetImport[],
  resolver: SwNetDocumentResolver,
): Map<string, string> {
  const index = new Map<string, string>();

  for (const imported of imports) {
    if (index.has(imported.alias)) {
      throw new SwNetResolveError(`Duplicate import alias ${imported.alias}`, {
        documentPath,
        importPath: imported.path,
      });
    }

    validateImportPath(imported.path, documentPath);
    index.set(imported.alias, resolver.resolveImportPath(documentPath, imported.path));
  }

  return index;
}

function buildLocalModuleIndex(documentPath: string, modules: SwNetModule[]): Map<string, SwNetModule> {
  const index = new Map<string, SwNetModule>();

  for (const module of modules) {
    if (index.has(module.id)) {
      throw new SwNetResolveError(`Duplicate module id ${module.id}`, {
        documentPath,
        moduleId: module.id,
      });
    }

    index.set(module.id, module);
  }

  return index;
}

function collectUseStatements(statements: SwNetStatement[]): SwNetUseStatement[] {
  return statements.filter((statement): statement is SwNetUseStatement => statement.kind === "use");
}

function ensureAcyclicModuleGraph(modules: SwNetResolvedModule[]): void {
  const moduleByKey = new Map(modules.map((module) => [createModuleKeyText(module.key), module] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: SwNetResolvedModuleKey[] = [];

  for (const module of modules) {
    visitModule(module.key);
  }

  function visitModule(key: SwNetResolvedModuleKey): void {
    const keyText = createModuleKeyText(key);

    if (visited.has(keyText)) {
      return;
    }

    if (visiting.has(keyText)) {
      const cycleStartIndex = stack.findIndex((entry) => createModuleKeyText(entry) === keyText);
      const cycle = [...stack.slice(cycleStartIndex), key].map(formatModuleKey).join(" -> ");

      throw new SwNetResolveError(`Module call graph contains a cycle: ${cycle}`, {
        documentPath: key.documentPath,
        moduleId: key.moduleId,
      });
    }

    visiting.add(keyText);
    stack.push(key);

    const module = moduleByKey.get(keyText);

    if (!module) {
      throw new SwNetResolveError(`Resolved module ${formatModuleKey(key)} was not indexed`, {
        documentPath: key.documentPath,
        moduleId: key.moduleId,
      });
    }

    for (const use of module.uses) {
      visitModule(use.target);
    }

    stack.pop();
    visiting.delete(keyText);
    visited.add(keyText);
  }
}

function validateImportPath(importPath: string, documentPath: string): void {
  const isRelative = importPath.startsWith("./") || importPath.startsWith("../");

  if (!isRelative) {
    throw new SwNetResolveError("Import path must be relative", {
      documentPath,
      importPath,
    });
  }

  if (!importPath.endsWith(".sw-net")) {
    throw new SwNetResolveError("Import path must end with .sw-net", {
      documentPath,
      importPath,
    });
  }
}

function createModuleKeyText(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

function formatModuleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}:${key.moduleId}`;
}

function compareDocumentHandles(left: SwNetDocumentHandle, right: SwNetDocumentHandle): number {
  return left.path.localeCompare(right.path);
}

function compareResolvedModules(left: SwNetResolvedModule, right: SwNetResolvedModule): number {
  const pathComparison = left.key.documentPath.localeCompare(right.key.documentPath);

  if (pathComparison !== 0) {
    return pathComparison;
  }

  return left.key.moduleId.localeCompare(right.key.moduleId);
}

function compareResolvedUses(left: SwNetResolvedUse, right: SwNetResolvedUse): number {
  const callerComparison = createModuleKeyText(left.caller).localeCompare(createModuleKeyText(right.caller));

  if (callerComparison !== 0) {
    return callerComparison;
  }

  return createModuleKeyText(left.target).localeCompare(createModuleKeyText(right.target));
}
