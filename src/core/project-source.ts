// Browser-safe facade that treats project.json, sw-net, sw-mcl, and scripts as one logical source package.
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
import { type ComponentDefinition } from "./definitions/schema.js";
import {
  buildStormworksXmlTree,
  resolveDynamicInputCount,
  type BuildStormworksXmlTreeOptions,
  type BuildStormworksXmlTreeResult,
} from "./exporters/xml-tree.js";
import { importStormworksXml } from "./importers/xml.js";
import {
  createErrorDiagnostic,
  createWarningDiagnostic,
  hasErrorDiagnostics,
  runAsyncToDiagnostics,
  runToDiagnostics,
  type Diagnostic,
  type StormworksLibraryResult,
} from "./diagnostics.js";
import { type IrProgram, type IrSignalKind } from "./ir.js";
import {
  parseSwNetDocument,
  type SwNetAssignment,
  type SwNetDocument,
  type SwNetInstStatement,
  type SwNetPort,
  type SwNetUseStatement,
} from "./parsers/sw-net.js";
import { parseStormworksSwMclText } from "./parsers/sw-mcl.js";
import {
  resolveSwNetDocumentGraph,
  type SwNetDocumentHandle,
  type SwNetDocumentResolver,
  type SwNetResolutionResult,
  type SwNetResolvedModule,
  type SwNetResolvedModuleKey,
  type SwNetResolvedUse,
} from "./resolvers/sw-net.js";
import { buildProjectJsonDocument, type ProjectJsonDocument } from "./serializers/project-json.js";
import { serializeSwNetDocument } from "./serializers/sw-net-document.js";
import { getSwNetInstanceName } from "./serializers/sw-net-shared.js";
import { buildModulePortNameSets, type ModulePortNameSets } from "./shared/module-port-directions.js";
import { buildStormworksSwMclDocument, type StormworksSwMclDocument } from "./serializers/sw-mcl.js";
import { serializeStormworksSwNet } from "./serializers/sw-net.js";

// High-level facade for GUI and other callers.
// This layer keeps file I/O outside, and treats imported documents as callback-resolved assets.
export interface StormworksSourceDocument {
  documentId: string;
  swNet: SwNetDocument;
  swMcl: StormworksSwMclDocument;
  scripts: Record<string, string>;
  // "generated" means no .sw-mcl file existed on disk and swMcl is a placeholder stub (treated as "no
  // layout data" by buildSwMclByDocumentPath below); "computed" means an implicit auto-layout pass
  // filled the module in memory for this export only (see computeProjectLayoutOverrides in
  // layout-dsl-runner.ts) and should be treated as real layout data even though nothing was written
  // back to disk; undefined/"file" means swMcl reflects real (possibly hand-authored) layout data read
  // from disk. Only file loaders and applyLayoutOverride set this.
  swMclOrigin?: "file" | "generated" | "computed";
}

export interface StormworksProjectSource {
  project: ProjectJsonDocument;
  entryDocument: StormworksSourceDocument;
  entryModuleId: string;
  sourceName?: string;
  warnings: Diagnostic[];
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
  diagnostics: Diagnostic[];
}

// Parse one paired sw-net/sw-mcl text set into the in-memory document shape used by the library.
export function parseSourceDocumentTexts(
  input: StormworksSourceDocumentTextInput,
): StormworksLibraryResult<StormworksSourceDocument> {
  const parsed = runToDiagnostics(
    () => ({
      swNet: parseSwNetDocument(input.swNetText, {
        sourceName: input.documentId,
      }),
      swMcl: parseStormworksSwMclText(input.swMclText),
    }),
    "library",
    "DOCUMENT_PARSE_FAILED",
    input.documentId,
  );

  if (!parsed.value) {
    return { diagnostics: parsed.diagnostics };
  }

  return {
    value: {
      documentId: input.documentId,
      swNet: parsed.value.swNet,
      swMcl: parsed.value.swMcl,
      scripts: { ...(input.scripts ?? {}) },
    },
    diagnostics: parsed.diagnostics,
  };
}

// Serialize one in-memory source document back to the standard CLI text-file shape.
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

// Import one XML microcontroller directly into the standard project + entry-document surface.
export function importStormworksXmlToProjectSource(
  xmlText: string,
  options: ImportStormworksXmlToProjectSourceOptions,
): StormworksLibraryResult<StormworksProjectSource> {
  const diagnostics: Diagnostic[] = [];

  try {
    // Import to IR first, then immediately project that IR into the standard CLI-facing document trio.
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

    diagnostics.push(...imported.warnings);
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

// Resolve imported sw-net documents through the caller-provided loader and build a linked module graph.
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

  const resolvedGraph = await resolveSwNetGraphFromPreload(projectSource, preloadResult);
  diagnostics.push(...resolvedGraph.diagnostics);

  if (!resolvedGraph.value) {
    return { diagnostics };
  }

  return {
    value: {
      projectSource,
      documents: [...preloadResult.documentsById.values()].sort(compareSourceDocuments),
      swNet: resolvedGraph.value,
    },
    diagnostics,
  };
}

// Shared sw-net-graph resolution step used by both resolveProjectSource (public API) and
// collectProjectSourceDiagnostics (validation + export path), so callers that already preloaded
// documents don't pay for a second preload+resolve pass just to validate `use` statements.
async function resolveSwNetGraphFromPreload(
  projectSource: StormworksProjectSource,
  preloadResult: { documentsById: Map<string, StormworksSourceDocument>; resolvedImports: Map<string, string> },
): Promise<StormworksLibraryResult<SwNetResolutionResult>> {
  // The actual sw-net resolver stays file-system agnostic; this facade only adapts preloaded documents to it.
  return runAsyncToDiagnostics(
    async () => {
      const entryHandle: SwNetDocumentHandle = {
        path: projectSource.entryDocument.documentId,
        document: projectSource.entryDocument.swNet,
      };
      const resolver = createProjectSourceSwNetResolver(
        preloadResult.documentsById,
        preloadResult.resolvedImports,
      );
      return resolveSwNetDocumentGraph(entryHandle, resolver);
    },
    "library",
    "PROJECT_SOURCE_RESOLVE_FAILED",
    projectSource.entryDocument.documentId,
  );
}

// Run structural validation across project.json, reachable sw-net documents, sw-mcl, and scripts.
export async function validateProjectSource(
  projectSource: StormworksProjectSource,
  options: ValidateProjectSourceOptions,
): Promise<ValidateProjectSourceResult> {
  const { diagnostics } = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  return {
    isValid: !hasErrorDiagnostics(diagnostics),
    diagnostics,
  };
}

// Build the intermediate XML tree from the standard project-source surface.
export async function buildStormworksXmlTreeFromProjectSource(
  projectSource: StormworksProjectSource,
  options: BuildStormworksXmlTreeFromProjectSourceOptions,
): Promise<StormworksLibraryResult<BuildStormworksXmlTreeResult>> {
  const { diagnostics, resolved } = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  if (hasErrorDiagnostics(diagnostics) || !resolved) {
    return { diagnostics };
  }

  try {
    const result = buildStormworksXmlTree(
      {
        project: projectSource.project,
        swNet: resolved.swNet,
        swMclByDocumentPath: buildSwMclByDocumentPath(resolved.documents),
      },
      {
        ...options,
        entryModuleId: projectSource.entryModuleId,
        resolveScriptText: (scriptRef, context) =>
          resolved.documents.find((document) => document.documentId === context.documentPath)?.scripts[scriptRef],
      },
    );

    diagnostics.push(...result.warnings);

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

// Build the final XML text from the standard project-source surface.
export async function buildStormworksXmlFromProjectSource(
  projectSource: StormworksProjectSource,
  options: BuildStormworksXmlFromProjectSourceOptions,
): Promise<StormworksLibraryResult<BuildStormworksXmlResult>> {
  const { diagnostics, resolved } = await collectProjectSourceDiagnostics(
    projectSource,
    options.definitions,
    options.loadImportedDocument,
  );

  if (hasErrorDiagnostics(diagnostics) || !resolved) {
    return { diagnostics };
  }

  try {
    const result = buildStormworksXml(
      {
        project: projectSource.project,
        swNet: resolved.swNet,
        swMclByDocumentPath: buildSwMclByDocumentPath(resolved.documents),
      },
      {
        ...options,
        entryModuleId: projectSource.entryModuleId,
        resolveScriptText: (scriptRef, context) =>
          resolved.documents.find((document) => document.documentId === context.documentPath)?.scripts[scriptRef],
      },
    );

    diagnostics.push(...result.warnings);

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

// Collect all diagnostics needed by validation and export without duplicating traversal logic.
async function collectProjectSourceDiagnostics(
  projectSource: StormworksProjectSource,
  definitions: NodeDefinitionRegistry,
  loadImportedDocument: StormworksDocumentLoader["loadImportedDocument"] | undefined,
): Promise<{ diagnostics: Diagnostic[]; resolved?: ResolvedStormworksProjectSource }> {
  // Validation walks both the project surface and every reachable sw-net document.
  const preloadResult = await preloadProjectSourceDocuments(projectSource, loadImportedDocument);
  const diagnostics = [...preloadResult.diagnostics];

  validateProjectDocument(projectSource.project, definitions, diagnostics);

  for (const document of preloadResult.documentsById.values()) {
    validateSourceDocument(document, definitions, diagnostics, projectSource);
  }

  if (
    projectSource.entryDocument.swMclOrigin !== "generated" &&
    projectSource.entryDocument.swMcl.moduleId !== projectSource.entryModuleId
  ) {
    diagnostics.push(
      createErrorDiagnostic(
        "ENTRY_MODULE_LAYOUT_MISMATCH",
        `entryDocument.swMcl.moduleId is ${projectSource.entryDocument.swMcl.moduleId}, expected ${projectSource.entryModuleId}.`,
        "sw-mcl",
        projectSource.entryDocument.documentId,
      ),
    );
  }

  if (hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }

  // `use` statements can only be checked against their target module's declared ports once the whole
  // module graph is resolved; reuse the same preload pass so export callers don't resolve it twice.
  const resolvedGraph = await resolveSwNetGraphFromPreload(projectSource, preloadResult);
  diagnostics.push(...resolvedGraph.diagnostics);

  if (!resolvedGraph.value) {
    return { diagnostics };
  }

  validateUseStatements(resolvedGraph.value, diagnostics);
  validateNetSignalConsistency(resolvedGraph.value, definitions, diagnostics);

  return {
    diagnostics,
    resolved: {
      projectSource,
      documents: [...preloadResult.documentsById.values()].sort(compareSourceDocuments),
      swNet: resolvedGraph.value,
    },
  };
}

// Preload every imported document reachable from the entry document through the caller-provided loader.
async function preloadProjectSourceDocuments(
  projectSource: StormworksProjectSource,
  loadImportedDocument: StormworksDocumentLoader["loadImportedDocument"] | undefined,
): Promise<{
  documentsById: Map<string, StormworksSourceDocument>;
  resolvedImports: Map<string, string>;
  diagnostics: Diagnostic[];
}> {
  const diagnostics: Diagnostic[] = [];
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
      // The library never interprets import paths itself; it only asks the caller to resolve them.
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

// Validate that every project node type still exists in the current definitions set.
function validateProjectDocument(
  project: ProjectJsonDocument,
  definitions: NodeDefinitionRegistry,
  diagnostics: Diagnostic[],
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

// Validate one source document against its paired sw-mcl document and all inst statements inside it.
function validateSourceDocument(
  sourceDocument: StormworksSourceDocument,
  definitions: NodeDefinitionRegistry,
  diagnostics: Diagnostic[],
  projectSource: StormworksProjectSource,
): void {
  const hasLayoutModule = sourceDocument.swNet.modules.some(
    (module) => module.id === sourceDocument.swMcl.moduleId,
  );

  // A missing .sw-mcl file is not an error: export falls back to a degraded shared-anchor layout.
  // Only a real, hand-authored .sw-mcl that names a module that doesn't exist is a genuine bug.
  if (!hasLayoutModule && sourceDocument.swMclOrigin !== "generated") {
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

// Validate one inst statement against definitions and referenced local script assets.
function validateInstStatement(
  sourceDocument: StormworksSourceDocument,
  statement: SwNetInstStatement,
  definitions: NodeDefinitionRegistry,
  diagnostics: Diagnostic[],
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

// Validate every resolved `use` statement in the module graph against its target module's declared ports.
function validateUseStatements(swNet: SwNetResolutionResult, diagnostics: Diagnostic[]): void {
  const moduleByKey = new Map(swNet.modules.map((module) => [formatResolvedModuleKey(module.key), module] as const));

  for (const callerModule of swNet.modules) {
    // The flatten pass' namespacing scheme depends on every inst/use statement in a module having a
    // unique instance id; catch violations here instead of letting export silently alias nets.
    const seenInstanceIds = new Set<string>();

    for (const statement of callerModule.module.statements) {
      if (seenInstanceIds.has(statement.instanceId)) {
        diagnostics.push(
          createErrorDiagnostic(
            "USE_INSTANCE_ID_DUPLICATE",
            `Instance id "${statement.instanceId}" is used more than once in module ${callerModule.key.moduleId}.`,
            "sw-net",
            callerModule.key.documentPath,
            statement.instanceId,
          ),
        );
      }

      seenInstanceIds.add(statement.instanceId);
    }
  }

  for (const use of swNet.uses) {
    validateUseStatement(use, moduleByKey, diagnostics);
  }
}

// Validate one resolved `use` statement's input/output bindings against its target module's ports.
function validateUseStatement(
  use: SwNetResolvedUse,
  moduleByKey: Map<string, SwNetResolvedModule>,
  diagnostics: Diagnostic[],
): void {
  const targetModule = moduleByKey.get(formatResolvedModuleKey(use.target));

  if (!targetModule) {
    // The resolver already raises a hard SwNetResolveError for a genuinely missing module/alias
    // before validation runs; this branch is defensive only.
    return;
  }

  const targetInputPorts = new Map(
    targetModule.module.ports.filter((port) => port.direction === "in").map((port) => [port.name, port] as const),
  );
  const targetOutputPorts = new Map(
    targetModule.module.ports.filter((port) => port.direction === "out").map((port) => [port.name, port] as const),
  );

  const boundInputKeys = validateUsePortAssignments(
    use,
    use.statement.inputs,
    targetInputPorts,
    "USE_INPUT_PORT_NOT_FOUND",
    diagnostics,
  );

  for (const inputPort of targetInputPorts.values()) {
    if (!boundInputKeys.has(inputPort.name)) {
      diagnostics.push(
        createWarningDiagnostic(
          "USE_INPUT_PORT_UNBOUND",
          `Input port "${inputPort.name}" of module ${use.target.moduleId} is not bound by ${use.statement.instanceId}.`,
          "sw-net",
          use.caller.documentPath,
          use.statement.instanceId,
        ),
      );
    }
  }

  // Unbound output ports are common and intentional (a submodule's output the caller simply doesn't
  // need), so only input-side unbound ports are worth warning about.
  validateUsePortAssignments(
    use,
    use.statement.outputs,
    targetOutputPorts,
    "USE_OUTPUT_PORT_NOT_FOUND",
    diagnostics,
  );
}

// Shared logic for the input/output assignment halves of one `use` statement: reports assignments
// that don't match a declared port and duplicate assignments to the same port. Signal-kind
// consistency is handled separately, net-wide, by validateNetSignalConsistency.
function validateUsePortAssignments(
  use: SwNetResolvedUse,
  assignments: SwNetAssignment[],
  targetPortsByName: Map<string, SwNetPort>,
  missingPortCode: string,
  diagnostics: Diagnostic[],
): Set<string> {
  const seenKeys = new Set<string>();

  for (const assignment of assignments) {
    if (seenKeys.has(assignment.key)) {
      diagnostics.push(
        createWarningDiagnostic(
          "USE_PORT_ASSIGNED_MULTIPLE_TIMES",
          `Port "${assignment.key}" is assigned more than once on ${use.statement.instanceId}.`,
          "sw-net",
          use.caller.documentPath,
          use.statement.instanceId,
        ),
      );
    }

    seenKeys.add(assignment.key);

    const targetPort = targetPortsByName.get(assignment.key);

    if (!targetPort) {
      diagnostics.push(
        createErrorDiagnostic(
          missingPortCode,
          `Module ${use.target.moduleId} has no port "${assignment.key}" (referenced by ${use.statement.instanceId}).`,
          "sw-net",
          use.caller.documentPath,
          use.statement.instanceId,
        ),
      );
    }
  }

  return seenKeys;
}

type NetSignalRole = "producer" | "consumer";

interface NetSignalEdge {
  signal: IrSignalKind;
  role: NetSignalRole;
  label: string;
}

// Validate signal-kind consistency across the whole net graph formed by inst/use port wiring in every
// resolved module (local nets plus the module's own boundary ports). Supersedes the narrower
// USE_PORT_SIGNAL_MISMATCH check that used to live here, which only covered the caller-forwarding
// (string-literal) case and never inferred a local net's signal kind across its producers/consumers.
function validateNetSignalConsistency(
  swNet: SwNetResolutionResult,
  definitions: NodeDefinitionRegistry,
  diagnostics: Diagnostic[],
): void {
  const moduleByKey = new Map(swNet.modules.map((module) => [formatResolvedModuleKey(module.key), module] as const));

  for (const resolvedModule of swNet.modules) {
    const nets = collectModuleNetSignalEdges(resolvedModule, moduleByKey, definitions, diagnostics);

    for (const [netKey, edges] of nets) {
      reportNetSignalMismatch(resolvedModule, netKey, edges, diagnostics);
    }
  }
}

// Build a net-name -> contributing-edges map for one module: the module's own boundary port
// declarations, plus every inst/use statement's input/output assignments. Local nets (identifier
// bindings) and boundary-port nets (string-literal bindings, keyed by direction + name since a module
// may legally declare `port in "x"` and `port out "x"` with the same name but different signals) are
// kept in disjoint key namespaces.
function collectModuleNetSignalEdges(
  resolvedModule: SwNetResolvedModule,
  moduleByKey: Map<string, SwNetResolvedModule>,
  definitions: NodeDefinitionRegistry,
  diagnostics: Diagnostic[],
): Map<string, NetSignalEdge[]> {
  const nets = new Map<string, NetSignalEdge[]>();
  const addEdge = (netKey: string | undefined, edge: NetSignalEdge): void => {
    if (!netKey) {
      // Number/boolean/null literal bindings have no net identity to track (see follow-up issue).
      return;
    }

    const existing = nets.get(netKey);

    if (existing) {
      existing.push(edge);
    } else {
      nets.set(netKey, [edge]);
    }
  };

  for (const port of resolvedModule.module.ports) {
    addEdge(`boundary:${port.direction}:${port.name}`, {
      signal: port.signal,
      role: port.direction === "in" ? "producer" : "consumer",
      label: `module's own ${port.direction} port "${port.name}"`,
    });
  }

  const useByStatement = new Map(resolvedModule.uses.map((use) => [use.statement, use] as const));
  const modulePorts = buildModulePortNameSets(resolvedModule.module.ports);

  for (const statement of resolvedModule.module.statements) {
    if (statement.kind === "inst") {
      collectInstNetEdges(statement, definitions, addEdge, resolvedModule, modulePorts, diagnostics);
    } else {
      collectUseNetEdges(statement, useByStatement.get(statement), moduleByKey, addEdge, resolvedModule, modulePorts, diagnostics);
    }
  }

  return nets;
}

// Resolve one assignment's net identity: identifiers join the local-net bucket; string literals join
// the boundary-port bucket for the *current* module's own port with that name — matching the
// exporter's flattening semantics (src/core/exporters/xml-tree.ts) exactly, on purpose, so this
// checker can't disagree with what dsl2xml actually wires. This is deliberately asymmetric: reading
// (usageDirection "in") may target either the module's own input port or, as internal feedback, its
// own output port — an output has exactly one producer inside the module but may have any number of
// readers, inside the module or out. Writing (usageDirection "out") may only ever target a declared
// output port; an input port's one and only producer is the caller's binding, so nothing inside the
// module may also drive it — that's flagged here as a hard error, the same as any other rule
// violation this checker catches, rather than left to surface later as an export-time warning.
function netKeyForAssignment(
  assignment: SwNetAssignment,
  usageDirection: "in" | "out",
  resolvedModule: SwNetResolvedModule,
  modulePorts: ModulePortNameSets,
  contextLabel: string,
  diagnostics: Diagnostic[],
): string | undefined {
  if (assignment.value.kind === "identifier") {
    return `local:${assignment.value.value}`;
  }

  if (assignment.value.kind === "string") {
    const portName = assignment.value.value;

    if (modulePorts[usageDirection].has(portName)) {
      return `boundary:${usageDirection}:${portName}`;
    }

    if (usageDirection === "in" && modulePorts.out.has(portName)) {
      return `boundary:out:${portName}`;
    }

    if (usageDirection === "out" && modulePorts.in.has(portName)) {
      diagnostics.push(
        createErrorDiagnostic(
          "MODULE_INPUT_PORT_DRIVEN_INTERNALLY",
          `${contextLabel} tries to drive its own input port "${portName}"; an input port has exactly one producer (the caller's binding), so nothing inside module ${resolvedModule.key.moduleId} may also drive it.`,
          "sw-net",
          resolvedModule.key.documentPath,
          resolvedModule.key.moduleId,
        ),
      );
      return undefined;
    }

    // Not declared as a port of this module in either direction — keep the assignment's own local
    // role as the net key so it still participates in cross-net signal checks instead of vanishing
    // silently; the exporter reports the "undeclared module port" warning for this case at export time.
    return `boundary:${usageDirection}:${portName}`;
  }

  return undefined;
}

// Collect net edges contributed by one `inst` statement: inputs are consumer edges (reading from a
// net), outputs are producer edges (writing to a net).
function collectInstNetEdges(
  statement: SwNetInstStatement,
  definitions: NodeDefinitionRegistry,
  addEdge: (netKey: string | undefined, edge: NetSignalEdge) => void,
  resolvedModule: SwNetResolvedModule,
  modulePorts: ModulePortNameSets,
  diagnostics: Diagnostic[],
): void {
  const definition = findCompatibleComponentDefinition(definitions, statement.typeId);

  for (const assignment of statement.inputs) {
    addEdge(
      netKeyForAssignment(assignment, "in", resolvedModule, modulePorts, `Input "${assignment.key}" of ${statement.instanceId}`, diagnostics),
      {
        signal: resolveInstPortSignal(definition, statement, assignment.key, "input"),
        role: "consumer",
        label: `input "${assignment.key}" of ${statement.instanceId}`,
      },
    );
  }

  for (const assignment of statement.outputs) {
    addEdge(
      netKeyForAssignment(assignment, "out", resolvedModule, modulePorts, `Output "${assignment.key}" of ${statement.instanceId}`, diagnostics),
      {
        signal: resolveInstPortSignal(definition, statement, assignment.key, "output"),
        role: "producer",
        label: `output "${assignment.key}" of ${statement.instanceId}`,
      },
    );
  }
}

// Resolve one inst statement's port key to its declared signal kind, covering both static ports and
// dynamic-input components (e.g. composite writers with a variable in1..inN). Falls back to "unknown"
// whenever the definition, port, or dynamic-input signal isn't available, matching the existing
// unknown-as-escape-hatch precedent used elsewhere in this module.
function resolveInstPortSignal(
  definition: ComponentDefinition | undefined,
  statement: SwNetInstStatement,
  key: string,
  direction: "input" | "output",
): IrSignalKind {
  if (!definition) {
    return "unknown";
  }

  const staticPorts = direction === "input" ? definition.ports.inputs : definition.ports.outputs;
  const staticPort = staticPorts.find((port) => port.key === key);

  if (staticPort) {
    return staticPort.signal;
  }

  const dynamicInputs = definition.stormworks.dynamicInputs;

  if (direction === "input" && dynamicInputs && key.startsWith(dynamicInputs.prefix)) {
    const index = Number(key.slice(dynamicInputs.prefix.length));
    const startIndex = dynamicInputs.startIndex ?? 1;
    const count = resolveDynamicInputCount(statement, dynamicInputs);

    if (Number.isInteger(index) && index >= startIndex && (count === undefined || index <= count)) {
      return dynamicInputs.signal ?? "unknown";
    }
  }

  return "unknown";
}

// Collect net edges contributed by one `use` statement against its resolved target module's declared
// ports: inputs are consumer edges, outputs are producer edges (from the caller module's perspective).
// Note the assignment *values* here are expressions in the calling module's own scope (they wire the
// callee's ports to the caller's nets/ports), so net-key resolution uses the caller's modulePorts.
function collectUseNetEdges(
  statement: SwNetUseStatement,
  use: SwNetResolvedUse | undefined,
  moduleByKey: Map<string, SwNetResolvedModule>,
  addEdge: (netKey: string | undefined, edge: NetSignalEdge) => void,
  resolvedModule: SwNetResolvedModule,
  modulePorts: ModulePortNameSets,
  diagnostics: Diagnostic[],
): void {
  if (!use) {
    // The resolver already raises a hard SwNetResolveError for a genuinely-unresolvable target;
    // this branch is defensive only (mirrors validateUseStatement above).
    return;
  }

  const targetModule = moduleByKey.get(formatResolvedModuleKey(use.target));

  if (!targetModule) {
    return;
  }

  const targetInputs = new Map(
    targetModule.module.ports.filter((port) => port.direction === "in").map((port) => [port.name, port] as const),
  );
  const targetOutputs = new Map(
    targetModule.module.ports.filter((port) => port.direction === "out").map((port) => [port.name, port] as const),
  );

  for (const assignment of statement.inputs) {
    addEdge(
      netKeyForAssignment(
        assignment,
        "in",
        resolvedModule,
        modulePorts,
        `Input "${assignment.key}" of ${statement.instanceId}`,
        diagnostics,
      ),
      {
        signal: targetInputs.get(assignment.key)?.signal ?? "unknown",
        role: "consumer",
        label: `input "${assignment.key}" of ${statement.instanceId} (${targetModuleLabel(use)})`,
      },
    );
  }

  for (const assignment of statement.outputs) {
    addEdge(
      netKeyForAssignment(
        assignment,
        "out",
        resolvedModule,
        modulePorts,
        `Output "${assignment.key}" of ${statement.instanceId}`,
        diagnostics,
      ),
      {
        signal: targetOutputs.get(assignment.key)?.signal ?? "unknown",
        role: "producer",
        label: `output "${assignment.key}" of ${statement.instanceId} (${targetModuleLabel(use)})`,
      },
    );
  }
}

// Emit one NET_SIGNAL_MISMATCH warning for a net whose contributing edges disagree on signal kind,
// ignoring "unknown" edges (a legitimate escape hatch, not a mismatch signal).
function reportNetSignalMismatch(
  resolvedModule: SwNetResolvedModule,
  netKey: string,
  edges: NetSignalEdge[],
  diagnostics: Diagnostic[],
): void {
  const distinctSignals = new Set(edges.map((edge) => edge.signal).filter((signal) => signal !== "unknown"));

  if (distinctSignals.size <= 1) {
    return;
  }

  const edgeDescriptions = edges
    .filter((edge) => edge.signal !== "unknown")
    .map((edge) => `${edge.label} (${edge.signal})`)
    .join(", ");

  diagnostics.push(
    createWarningDiagnostic(
      "NET_SIGNAL_MISMATCH",
      `Net "${describeNetKey(netKey)}" in module ${resolvedModule.key.moduleId} has inconsistent signal kinds: ${edgeDescriptions}.`,
      "sw-net",
      resolvedModule.key.documentPath,
      resolvedModule.key.moduleId,
    ),
  );
}

// Strip the internal local:/boundary:<direction>: namespace prefix for a human-readable net name.
function describeNetKey(netKey: string): string {
  const parts = netKey.split(":");
  return parts[parts.length - 1] ?? netKey;
}

// Human-readable label for the target module of a `use` statement, reused in diagnostic messages.
function targetModuleLabel(use: SwNetResolvedUse): string {
  return `${use.target.documentPath}#${use.target.moduleId}`;
}

// Build a stable lookup key for one resolved sw-net module (documentPath + moduleId).
function formatResolvedModuleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

// Adapt preloaded project-source documents to the sw-net resolver interface.
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

// Collect Lua source text from imported IR nodes into the per-document script map.
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

// Build a stable key for one import edge without imposing any path semantics on callers.
function formatImportResolutionKey(fromDocumentId: string, importPath: string): string {
  return `${fromDocumentId}\u0000${importPath}`;
}

// Rewrite the entry submodule path in project.json so library imports match the chosen document id.
function applyEntryDocumentPath(
  project: ProjectJsonDocument,
  moduleId: string,
  entryDocumentId: string,
): ProjectJsonDocument {
  return {
    ...project,
    submodule:
      project.submodule && project.submodule.name === moduleId
        ? { ...project.submodule, relativePath: entryDocumentId }
        : project.submodule,
  };
}

// Sort source documents by document id for stable diagnostics and export ordering.
function compareSourceDocuments(left: StormworksSourceDocument, right: StormworksSourceDocument): number {
  return left.documentId.localeCompare(right.documentId);
}

// Give the XML tree exporter access to every resolved document's own sw-mcl, keyed by document path,
// so `use` statements that pull in a module from another document can resolve its layout too.
// Documents whose sw-mcl was auto-generated (no real file on disk, and no in-memory auto-layout
// override applied either) are omitted so the exporter treats them as "no layout data" and falls back
// to its existing degraded shared-anchor placement. "computed" documents (an override was applied) are
// kept, same as "file", since they carry real (if not persisted) layout data.
function buildSwMclByDocumentPath(documents: StormworksSourceDocument[]): Map<string, StormworksSwMclDocument> {
  return new Map(
    documents
      .filter((document) => document.swMclOrigin !== "generated")
      .map((document) => [document.documentId, document.swMcl] as const),
  );
}
