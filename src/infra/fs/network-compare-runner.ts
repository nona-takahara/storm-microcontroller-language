import { extname } from "node:path";

import {
  compareSwNetModules,
  compareSwNetProjects,
  createErrorDiagnostic,
  resolveProjectSource,
  resolveSwNetDocumentGraph,
  runAsyncToDiagnostics,
  type Diagnostic,
  type NetworkComparisonResult,
  type ProjectComparisonResult,
  type SwNetResolutionResult,
  type SwNetResolvedModule,
} from "../../index.js";
import {
  createFileSystemProjectSourceDocumentLoader,
  loadProjectSourceFromProjectJsonFile,
  loadSourceDocumentFromSwNetFile,
} from "./project-source-file-loader.js";
import { resolveRelativeSwNetImportPath } from "./sw-net-file-loader.js";

export interface CompareDslTarget {
  path: string;
  moduleId?: string;
}

export type RunCompareDslResult =
  | {
      kind: "network";
      comparison?: NetworkComparisonResult;
      loadDiagnostics: Diagnostic[];
      diagnostics: Diagnostic[];
    }
  | {
      kind: "project";
      comparison?: ProjectComparisonResult;
      loadDiagnostics: Diagnostic[];
      diagnostics: Diagnostic[];
    };

interface LoadedCompareTarget {
  resolution?: SwNetResolutionResult;
  entryModuleId?: string;
  loadDiagnostics: Diagnostic[];
}

// Load and resolve two project.json or bare .sw-net targets, then run the shared pure comparator.
export async function runCompareDsl(
  a: CompareDslTarget,
  b: CompareDslTarget,
): Promise<RunCompareDslResult> {
  const [loadedA, loadedB] = await Promise.all([loadCompareTarget(a.path), loadCompareTarget(b.path)]);
  const loadDiagnostics = [...loadedA.loadDiagnostics, ...loadedB.loadDiagnostics];
  const networkMode = a.moduleId !== undefined || b.moduleId !== undefined;

  if (!loadedA.resolution || !loadedB.resolution) {
    return {
      kind: networkMode ? "network" : "project",
      loadDiagnostics,
      diagnostics: [],
    };
  }

  if (networkMode) {
    if (a.moduleId === undefined || b.moduleId === undefined) {
      return {
        kind: "network",
        loadDiagnostics: [
          ...loadDiagnostics,
          createErrorDiagnostic(
            "COMPARE_MODULE_IDS_MUST_BE_PAIRED",
            "Module IDs must be provided for both comparison targets or neither target.",
            "compare",
          ),
        ],
        diagnostics: [],
      };
    }

    const moduleDiagnostics: Diagnostic[] = [];
    const moduleA = selectModule(loadedA.resolution, a.moduleId, "A", moduleDiagnostics);
    const moduleB = selectModule(loadedB.resolution, b.moduleId, "B", moduleDiagnostics);
    loadDiagnostics.push(...moduleDiagnostics);

    if (!moduleA || !moduleB) {
      return { kind: "network", loadDiagnostics, diagnostics: [] };
    }

    const result = compareSwNetModules(moduleA.module, moduleB.module);
    return {
      kind: "network",
      comparison: result.value,
      loadDiagnostics,
      diagnostics: result.diagnostics,
    };
  }

  const result = compareSwNetProjects(loadedA.resolution, loadedB.resolution, {
    entryModuleA: loadedA.entryModuleId,
    entryModuleB: loadedB.entryModuleId,
  });
  return {
    kind: "project",
    comparison: result.value,
    loadDiagnostics,
    diagnostics: result.diagnostics,
  };
}

async function loadCompareTarget(path: string): Promise<LoadedCompareTarget> {
  const extension = extname(path);

  if (extension === ".json") {
    const loadResult = await loadProjectSourceFromProjectJsonFile(path);
    const loadDiagnostics = [...loadResult.diagnostics];
    if (!loadResult.value) {
      return { loadDiagnostics };
    }

    const resolveResult = await resolveProjectSource(loadResult.value, {
      loadImportedDocument: createFileSystemProjectSourceDocumentLoader(),
    });
    loadDiagnostics.push(...resolveResult.diagnostics);
    return {
      resolution: resolveResult.value?.swNet,
      entryModuleId: loadResult.value.entryModuleId,
      loadDiagnostics,
    };
  }

  if (extension === ".sw-net") {
    const resolveResult = await runAsyncToDiagnostics(
      async () => {
        const entryDocument = await loadSourceDocumentFromSwNetFile(path);
        return resolveSwNetDocumentGraph(
          { path: entryDocument.documentId, document: entryDocument.swNet },
          {
            resolveImportPath: resolveRelativeSwNetImportPath,
            loadDocument: async (documentPath) =>
              (await loadSourceDocumentFromSwNetFile(documentPath)).swNet,
          },
        );
      },
      "compare",
      "COMPARE_DSL_LOAD_FAILED",
      path,
    );
    return {
      resolution: resolveResult.value,
      loadDiagnostics: resolveResult.diagnostics,
    };
  }

  return {
    loadDiagnostics: [
      createErrorDiagnostic(
        "COMPARE_DSL_UNSUPPORTED_INPUT",
        `Expected a project.json or .sw-net path, received ${path}.`,
        "compare",
        path,
      ),
    ],
  };
}

function selectModule(
  resolution: SwNetResolutionResult,
  moduleId: string,
  side: "A" | "B",
  diagnostics: Diagnostic[],
): SwNetResolvedModule | undefined {
  const matches = resolution.modules.filter((module) => module.key.moduleId === moduleId);

  if (matches.length === 1) {
    return matches[0];
  }

  const message =
    matches.length === 0
      ? `Module ${moduleId} was not found in comparison target ${side}.`
      : `Module ${moduleId} is ambiguous in comparison target ${side}; it is defined in multiple documents.`;
  diagnostics.push(
    createErrorDiagnostic(
      matches.length === 0 ? "COMPARE_MODULE_NOT_FOUND" : "COMPARE_MODULE_AMBIGUOUS",
      message,
      "compare",
      resolution.entryDocumentPath,
    ),
  );
  return undefined;
}
