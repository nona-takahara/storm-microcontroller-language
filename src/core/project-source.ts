import {
  extractCompatibleStormworksType,
  findCompatibleComponentDefinition,
  type NodeDefinitionRegistry,
} from "./definitions/loader.js";
import {
  buildStormworksXml,
  type BuildStormworksXmlOptions,
  type BuildStormworksXmlResult,
} from "./exporters/xml.js";
import {
  buildStormworksXmlTree,
  type BuildStormworksXmlTreeOptions,
  type BuildStormworksXmlTreeResult,
} from "./exporters/xml-tree.js";
import { importStormworksXml } from "./importers/xml.js";
import { type IrProgram } from "./ir.js";
import { parseSwNetDocument, type SwNetDocument, type SwNetInstStatement } from "./parsers/sw-net.js";
import { parseStormworksSwMclText } from "./parsers/sw-mcl.js";
import {
  resolveSwNetDocumentGraph,
  type SwNetDocumentHandle,
  type SwNetDocumentResolver,
  type SwNetResolutionResult,
} from "./resolvers/sw-net.js";
import { buildProjectJsonDocument, type ProjectJsonDocument } from "./serializers/project-json.js";
import { serializeSwNetDocument } from "./serializers/sw-net-document.js";
import { getSwNetInstanceName } from "./serializers/sw-net-shared.js";
import { buildStormworksSwMclDocument, type StormworksSwMclDocument } from "./serializers/sw-mcl.js";
import { serializeStormworksSwNet } from "./serializers/sw-net.js";

// High-level facade for GUI and other callers.
// This layer keeps file I/O outside, and treats imported documents as callback-resolved assets.
export interface StormworksSourceDocument {
  documentId: string;
  swNet: SwNetDocument;
  swMcl: StormworksSwMclDocument;
  scripts: Record<string, string>;
}

export interface StormworksProjectSource {
  project: ProjectJsonDocument;
  entryDocument: StormworksSourceDocument;
  entryModuleId: string;
  sourceName?: string;
  warnings: string[];
}

export interface StormworksDocumentLoader {
  loadImportedDocument(args: {
    fromDocumentId: string;
    importPath: string;
  }): Promise<StormworksSourceDocument | undefined>;
}

export interface StormworksSourceDocumentTextInput {
  documentId: string;
  swNetText: string;
  swMclText: string;
  scripts?: Record<string, string>;
}

export interface StormworksSourceDocumentTexts {
  documentId: string;
  swNetText: string;
  swMclText: string;
  scripts: Record<string, string>;
}

export interface StormworksLibraryDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  documentId?: string;
  path?: string;
  source: "project" | "sw-net" | "sw-mcl" | "script" | "xml" | "library";
}

export interface StormworksLibraryResult<T> {
  value?: T;
  diagnostics: StormworksLibraryDiagnostic[];
}

export interface ImportStormworksXmlToProjectSourceOptions {
  definitions: NodeDefinitionRegistry;
  sourceName?: string;
  entryDocumentId?: string;
}

export interface ResolveProjectSourceOptions {
  loadImportedDocument?: StormworksDocumentLoader["loadImportedDocument"];
}

export interface ValidateProjectSourceOptions extends ResolveProjectSourceOptions {
  definitions: NodeDefinitionRegistry;
}

export interface BuildStormworksXmlFromProjectSourceOptions
  extends Omit<BuildStormworksXmlOptions, "resolveScriptText" | "entryModuleId">,
    ResolveProjectSourceOptions {
  definitions: NodeDefinitionRegistry;
}

export interface BuildStormworksXmlTreeFromProjectSourceOptions
  extends Omit<BuildStormworksXmlTreeOptions, "resolveScriptText" | "entryModuleId">,
    ResolveProjectSourceOptions {
  definitions: NodeDefinitionRegistry;
}

export interface ResolvedStormworksProjectSource {
  projectSource: StormworksProjectSource;
  documents: StormworksSourceDocument[];
  swNet: SwNetResolutionResult;
}

export interface ValidateProjectSourceResult {
  isValid: boolean;
  diagnostics: StormworksLibraryDiagnostic[];
}

export function parseSourceDocumentTexts(
  input: StormworksSourceDocumentTextInput,
): StormworksLibraryResult<StormworksSourceDocument> {
  const diagnostics: StormworksLibraryDiagnostic[] = [];

  try {
    const swNet = parseSwNetDocument(input.swNetText, {
      sourceName: input.documentId,
    });
    const swMcl = parseStormworksSwMclText(input.swMclText);

    return {
      value: {
        documentId: input.documentId,
        swNet,
        swMcl,
        scripts: { ...(input.scripts ?? {}) },
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "DOCUMENT_PARSE_FAILED",
        error instanceof Error ? error.message : String(error),
        "library",
        input.documentId,
      ),
    );

    return { diagnostics };
  }
}

export function serializeSourceDocumentTexts(
  sourceDocument: StormworksSourceDocument,
): StormworksSourceDocumentTexts {
  return {
    documentId: sourceDocument.documentId,
    swNetText: serializeSwNetDocument(sourceDocument.swNet),
    swMclText: JSON.stringify(sourceDocument.swMcl, null, 2),
    scripts: { ...sourceDocument.scripts },
  };
}

export function importStormworksXmlToProjectSource(
  xmlText: string,
  options: ImportStormworksXmlToProjectSourceOptions,
): StormworksLibraryResult<StormworksProjectSource> {
  const diagnostics: StormworksLibraryDiagnostic[] = [];

  try {
    const imported = importStormworksXml(xmlText, {
      definitions: options.definitions,
      sourceName: options.sourceName,
    });
    const entryDocumentId = options.entryDocumentId ?? "main.sw-net";
    const project = buildProjectJsonDocument(imported.program);
    const swNetText = new TextDecoder().decode(
      serializeStormworksSwNet(imported.program, {
        definitions: options.definitions,
      }).bytes,
    );
    const parsedSourceDocument = parseSourceDocumentTexts({
      documentId: entryDocumentId,
      swNetText,
      swMclText: JSON.stringify(buildStormworksSwMclDocument(imported.program), null, 2),
      scripts: collectLocalScriptsFromProgram(imported.program),
    });

    diagnostics.push(
      ...imported.warnings.map((warning) =>
        createWarningDiagnostic(warning.code, warning.message, "xml", options.sourceName, warning.path),
      ),
    );
    diagnostics.push(...parsedSourceDocument.diagnostics);

    if (!parsedSourceDocument.value) {
      return { diagnostics };
    }

    return {
      value: {
        project: applyEntryDocumentPath(project, parsedSourceDocument.value.swMcl.moduleId, entryDocumentId),
        entryDocument: parsedSourceDocument.value,
        entryModuleId: parsedSourceDocument.value.swMcl.moduleId,
        sourceName: options.sourceName,
        warnings: [...imported.program.metadata.warnings],
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "XML_IMPORT_TO_PROJECT_SOURCE_FAILED",
        error instanceof Error ? error.message : String(error),
        "xml",
        options.sourceName,
      ),
    );

    return { diagnostics };
  }
}

export async function resolveProjectSource(
  projectSource: StormworksProjectSource,
  options: ResolveProjectSourceOptions = {},
): Promise<StormworksLibraryResult<ResolvedStormworksProjectSource>> {
  // Preload imported documents first so the sw-net resolver can stay purely in-memory.
  const preloadResult = await preloadProjectSourceDocuments(projectSource, options.loadImportedDocument);
  const diagnostics = [...preloadResult.diagnostics];

  if (hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  try {
    const entryHandle: SwNetDocumentHandle = {
      path: projectSource.entryDocument.documentId,
      document: projectSource.entryDocument.swNet,
    };
    const resolver = createProjectSourceSwNetResolver(
      preloadResult.documentsById,
      preloadResult.resolvedImports,
    );
    const swNet = await resolveSwNetDocumentGraph(entryHandle, resolver);

    return {
      value: {
        projectSource,
        documents: [...preloadResult.documentsById.values()].sort(compareSourceDocuments),
        swNet,
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "PROJECT_SOURCE_RESOLVE_FAILED",
        error instanceof Error ? error.message : String(error),
        "library",
        projectSource.entryDocument.documentId,
      ),
    );

    return { diagnostics };
  }
}

export async function validateProjectSource(
  projectSource: StormworksProjectSource,
  options: ValidateProjectSourceOptions,
): Promise<ValidateProjectSourceResult> {
  const diagnostics = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  return {
    isValid: !hasErrorDiagnostics(diagnostics),
    diagnostics,
  };
}

export async function buildStormworksXmlTreeFromProjectSource(
  projectSource: StormworksProjectSource,
  options: BuildStormworksXmlTreeFromProjectSourceOptions,
): Promise<StormworksLibraryResult<BuildStormworksXmlTreeResult>> {
  const diagnostics = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  if (hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  const resolved = await resolveProjectSource(projectSource, {
    loadImportedDocument: options.loadImportedDocument,
  });
  diagnostics.push(...resolved.diagnostics);

  if (!resolved.value || hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  try {
    const result = buildStormworksXmlTree(
      {
        project: projectSource.project,
        swNet: resolved.value.swNet,
        swMcl: projectSource.entryDocument.swMcl,
      },
      {
        ...options,
        entryModuleId: projectSource.entryModuleId,
        resolveScriptText: (scriptRef, context) =>
          resolved.value?.documents.find((document) => document.documentId === context.documentPath)?.scripts[scriptRef],
      },
    );

    diagnostics.push(
      ...result.warnings.map((warning) =>
        createWarningDiagnostic("XML_TREE_BUILD_WARNING", warning, "xml", projectSource.entryDocument.documentId),
      ),
    );

    return {
      value: result,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "XML_TREE_BUILD_FAILED",
        error instanceof Error ? error.message : String(error),
        "xml",
        projectSource.entryDocument.documentId,
      ),
    );

    return { diagnostics };
  }
}

export async function buildStormworksXmlFromProjectSource(
  projectSource: StormworksProjectSource,
  options: BuildStormworksXmlFromProjectSourceOptions,
): Promise<StormworksLibraryResult<BuildStormworksXmlResult>> {
  const diagnostics = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  if (hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  const resolved = await resolveProjectSource(projectSource, {
    loadImportedDocument: options.loadImportedDocument,
  });
  diagnostics.push(...resolved.diagnostics);

  if (!resolved.value || hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  try {
    const result = buildStormworksXml(
      {
        project: projectSource.project,
        swNet: resolved.value.swNet,
        swMcl: projectSource.entryDocument.swMcl,
      },
      {
        ...options,
        entryModuleId: projectSource.entryModuleId,
        resolveScriptText: (scriptRef, context) =>
          resolved.value?.documents.find((document) => document.documentId === context.documentPath)?.scripts[scriptRef],
      },
    );

    diagnostics.push(
      ...result.warnings.map((warning) =>
        createWarningDiagnostic("XML_BUILD_WARNING", warning, "xml", projectSource.entryDocument.documentId),
      ),
    );

    return {
      value: result,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createErrorDiagnostic(
        "XML_BUILD_FAILED",
        error instanceof Error ? error.message : String(error),
        "xml",
        projectSource.entryDocument.documentId,
      ),
    );

    return { diagnostics };
  }
}

async function collectProjectSourceDiagnostics(
  projectSource: StormworksProjectSource,
  definitions: NodeDefinitionRegistry,
  loadImportedDocument: StormworksDocumentLoader["loadImportedDocument"] | undefined,
): Promise<StormworksLibraryDiagnostic[]> {
  // Validation walks both the project surface and every reachable sw-net document.
  const preloadResult = await preloadProjectSourceDocuments(projectSource, loadImportedDocument);
  const diagnostics = [...preloadResult.diagnostics];

  validateProjectDocument(projectSource.project, definitions, diagnostics);

  for (const document of preloadResult.documentsById.values()) {
    validateSourceDocument(document, definitions, diagnostics, projectSource);
  }

  if (projectSource.entryDocument.swMcl.moduleId !== projectSource.entryModuleId) {
    diagnostics.push(
      createErrorDiagnostic(
        "ENTRY_MODULE_LAYOUT_MISMATCH",
        `entryDocument.swMcl.moduleId is ${projectSource.entryDocument.swMcl.moduleId}, expected ${projectSource.entryModuleId}.`,
        "sw-mcl",
        projectSource.entryDocument.documentId,
      ),
    );
  }

  return diagnostics;
}

async function preloadProjectSourceDocuments(
  projectSource: StormworksProjectSource,
  loadImportedDocument: StormworksDocumentLoader["loadImportedDocument"] | undefined,
): Promise<{
  documentsById: Map<string, StormworksSourceDocument>;
  resolvedImports: Map<string, string>;
  diagnostics: StormworksLibraryDiagnostic[];
}> {
  const diagnostics: StormworksLibraryDiagnostic[] = [];
  const documentsById = new Map<string, StormworksSourceDocument>([
    [projectSource.entryDocument.documentId, projectSource.entryDocument],
  ]);
  const resolvedImports = new Map<string, string>();
  const pendingDocumentIds = [projectSource.entryDocument.documentId];

  while (pendingDocumentIds.length > 0) {
    const currentDocumentId = pendingDocumentIds.shift();

    if (!currentDocumentId) {
      continue;
    }

    const currentDocument = documentsById.get(currentDocumentId);

    if (!currentDocument) {
      continue;
    }

    for (const imported of currentDocument.swNet.imports) {
      const resolutionKey = formatImportResolutionKey(currentDocument.documentId, imported.path);

      if (resolvedImports.has(resolutionKey)) {
        continue;
      }

      if (!loadImportedDocument) {
        diagnostics.push(
          createErrorDiagnostic(
            "IMPORTED_DOCUMENT_LOADER_REQUIRED",
            `Document ${currentDocument.documentId} imports ${imported.path}, but no loadImportedDocument callback was provided.`,
            "library",
            currentDocument.documentId,
            imported.path,
          ),
        );
        continue;
      }

      try {
        const loadedDocument = await loadImportedDocument({
          fromDocumentId: currentDocument.documentId,
          importPath: imported.path,
        });

        if (!loadedDocument) {
          diagnostics.push(
            createErrorDiagnostic(
              "IMPORTED_DOCUMENT_NOT_FOUND",
              `Could not load imported document ${imported.path} from ${currentDocument.documentId}.`,
              "library",
              currentDocument.documentId,
              imported.path,
            ),
          );
          continue;
        }

        resolvedImports.set(resolutionKey, loadedDocument.documentId);

        if (!documentsById.has(loadedDocument.documentId)) {
          documentsById.set(loadedDocument.documentId, loadedDocument);
          pendingDocumentIds.push(loadedDocument.documentId);
        }
      } catch (error) {
        diagnostics.push(
          createErrorDiagnostic(
            "IMPORTED_DOCUMENT_LOAD_FAILED",
            error instanceof Error ? error.message : String(error),
            "library",
            currentDocument.documentId,
            imported.path,
          ),
        );
      }
    }
  }

  return {
    documentsById,
    resolvedImports,
    diagnostics,
  };
}

function validateProjectDocument(
  project: ProjectJsonDocument,
  definitions: NodeDefinitionRegistry,
  diagnostics: StormworksLibraryDiagnostic[],
): void {
  for (const node of project.nodes) {
    const definition = definitions.byId.get(node.type);

    if (!definition || !("stormworks" in definition) || definition.category !== "project") {
      diagnostics.push(
        createErrorDiagnostic(
          "PROJECT_NODE_DEFINITION_MISSING",
          `Project node type ${node.type} is not defined in definitions.`,
          "project",
          undefined,
          node.id,
        ),
      );
    }
  }
}

function validateSourceDocument(
  sourceDocument: StormworksSourceDocument,
  definitions: NodeDefinitionRegistry,
  diagnostics: StormworksLibraryDiagnostic[],
  projectSource: StormworksProjectSource,
): void {
  const hasLayoutModule = sourceDocument.swNet.modules.some(
    (module) => module.id === sourceDocument.swMcl.moduleId,
  );

  if (!hasLayoutModule) {
    diagnostics.push(
      createErrorDiagnostic(
        "SW_MCL_MODULE_MISSING",
        `sw-mcl moduleId ${sourceDocument.swMcl.moduleId} does not exist in ${sourceDocument.documentId}.`,
        "sw-mcl",
        sourceDocument.documentId,
      ),
    );
  }

  if (
    sourceDocument.documentId === projectSource.entryDocument.documentId &&
    !sourceDocument.swNet.modules.some((module) => module.id === projectSource.entryModuleId)
  ) {
    diagnostics.push(
      createErrorDiagnostic(
        "ENTRY_MODULE_NOT_FOUND",
        `Entry module ${projectSource.entryModuleId} does not exist in ${sourceDocument.documentId}.`,
        "sw-net",
        sourceDocument.documentId,
      ),
    );
  }

  for (const statement of sourceDocument.swNet.modules.flatMap((module) => module.statements)) {
    if (statement.kind !== "inst") {
      continue;
    }

    validateInstStatement(sourceDocument, statement, definitions, diagnostics);
  }
}

function validateInstStatement(
  sourceDocument: StormworksSourceDocument,
  statement: SwNetInstStatement,
  definitions: NodeDefinitionRegistry,
  diagnostics: StormworksLibraryDiagnostic[],
): void {
  if (
    !findCompatibleComponentDefinition(definitions, statement.typeId) &&
    !extractCompatibleStormworksType(statement.typeId)
  ) {
    diagnostics.push(
      createWarningDiagnostic(
        "COMPONENT_DEFINITION_MISSING",
        `Component type ${statement.typeId} is not defined in definitions.`,
        "sw-net",
        sourceDocument.documentId,
        statement.instanceId,
      ),
    );
  }

  const scriptRefValue = statement.attributes.find(
    (attribute) => attribute.key === "script_ref" && attribute.value.kind === "string",
  )?.value.value;
  const scriptRef = typeof scriptRefValue === "string" ? scriptRefValue : undefined;

  if (scriptRef && sourceDocument.scripts[scriptRef] === undefined) {
    diagnostics.push(
      createWarningDiagnostic(
        "SCRIPT_REF_MISSING",
        `Script ${scriptRef} was not found in document ${sourceDocument.documentId}.`,
        "script",
        sourceDocument.documentId,
        statement.instanceId,
      ),
    );
  }
}

function createProjectSourceSwNetResolver(
  documentsById: Map<string, StormworksSourceDocument>,
  resolvedImports: Map<string, string>,
): SwNetDocumentResolver {
  return {
    resolveImportPath(fromDocumentPath, importPath) {
      const resolvedDocumentId = resolvedImports.get(formatImportResolutionKey(fromDocumentPath, importPath));

      if (!resolvedDocumentId) {
        throw new Error(`No resolved document was registered for ${fromDocumentPath} -> ${importPath}.`);
      }

      return resolvedDocumentId;
    },
    async loadDocument(documentPath): Promise<SwNetDocument> {
      const sourceDocument = documentsById.get(documentPath);

      if (!sourceDocument) {
        throw new Error(`Document ${documentPath} was not preloaded.`);
      }

      return sourceDocument.swNet;
    },
  };
}

function collectLocalScriptsFromProgram(program: IrProgram): Record<string, string> {
  const scripts: Record<string, string> = {};

  for (const node of program.nodes) {
    if (node.layer !== "logic" || node.definitionId !== "LUA") {
      continue;
    }

    const scriptText = typeof node.properties.script === "string" ? node.properties.script : undefined;

    if (scriptText === undefined) {
      continue;
    }

    scripts[`scripts/${getSwNetInstanceName(node)}.lua`] = scriptText;
  }

  return scripts;
}

function formatImportResolutionKey(fromDocumentId: string, importPath: string): string {
  return `${fromDocumentId}\u0000${importPath}`;
}

function applyEntryDocumentPath(
  project: ProjectJsonDocument,
  moduleId: string,
  entryDocumentId: string,
): ProjectJsonDocument {
  return {
    ...project,
    submodules: project.submodules.map((submodule) =>
      submodule.id === moduleId || submodule.name === moduleId
        ? {
            ...submodule,
            relativePath: entryDocumentId,
          }
        : submodule,
    ),
  };
}

function compareSourceDocuments(left: StormworksSourceDocument, right: StormworksSourceDocument): number {
  return left.documentId.localeCompare(right.documentId);
}

function hasErrorDiagnostics(diagnostics: StormworksLibraryDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function createWarningDiagnostic(
  code: string,
  message: string,
  source: StormworksLibraryDiagnostic["source"],
  documentId?: string,
  path?: string,
): StormworksLibraryDiagnostic {
  return {
    severity: "warning",
    code,
    message,
    source,
    documentId,
    path,
  };
}

function createErrorDiagnostic(
  code: string,
  message: string,
  source: StormworksLibraryDiagnostic["source"],
  documentId?: string,
  path?: string,
): StormworksLibraryDiagnostic {
  return {
    severity: "error",
    code,
    message,
    source,
    documentId,
    path,
  };
}
