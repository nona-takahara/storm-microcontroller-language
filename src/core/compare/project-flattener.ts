import {
  createErrorDiagnostic,
  createWarningDiagnostic,
  type Diagnostic,
  type StormworksLibraryResult,
} from "../diagnostics.js";
import { walkFlattenedModule } from "../flatten/walk.js";
import { type ParamOrigin } from "../module-params.js";
import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import { type SwNetResolutionResult, type SwNetResolvedModule } from "../resolvers/sw-net.js";
import { type ProvenancePath } from "./types.js";

export interface FlattenSwNetProjectOptions {
  entryModuleId?: string;
}

export interface FlattenedSwNetProject {
  module: SwNetModule;
  provenanceByInstanceId: Record<string, ProvenancePath>;
  documentPathByInstanceId: Record<string, string>;
  /** Per flattened instance, which attributes were written as `@param` and where each one is controlled. `undefined` marks a reference that cannot be written back (inside a list literal). */
  paramOriginsByInstanceId: Record<string, Record<string, ParamOrigin | undefined>>;
}

/**
 * Inline the selected entry module's complete `use` tree into one ordinary sw-net module.
 * This is the comparison authority: its shape matches the circuit after module boundaries vanish.
 * The `use` lowering itself lives in src/core/flatten/walk.ts and is shared with dsl2xml.
 */
export function flattenSwNetProject(
  resolution: SwNetResolutionResult,
  options: FlattenSwNetProjectOptions = {},
): StormworksLibraryResult<FlattenedSwNetProject> {
  const diagnostics: Diagnostic[] = [];
  const entry = selectEntryModule(resolution, options.entryModuleId, diagnostics);
  if (!entry) {
    return { diagnostics };
  }

  const statements: SwNetStatement[] = [];
  const provenanceByInstanceId: Record<string, ProvenancePath> = {};
  const documentPathByInstanceId: Record<string, string> = {};
  const paramOriginsByInstanceId: Record<string, Record<string, ParamOrigin | undefined>> = {};

  try {
    walkFlattenedModule<void>(resolution.modules, entry.key, {
      naming: {
        instanceId: formatInstanceId,
        netName: (scopePath, name) => formatInstanceId([...scopePath, `$${name}`]),
      },
      rootScope: undefined,
      enterUse: () => undefined,
      onUnresolvedPort: ({ flattenedId, portName }) => {
        diagnostics.push(
          createWarningDiagnostic(
            "COMPARE_UNRESOLVED_MODULE_PORT",
            `Instance ${flattenedId} references module port "${portName}" that has no usable binding; the reference was dropped.`,
            "compare",
            undefined,
            flattenedId,
            { messageId: "compare.diagnostic.unresolvedPort", messageArgs: { instanceId: flattenedId, portName } },
          ),
        );
      },
      onInstance: ({ moduleKey, statement, instancePath, flattenedId, attributes, paramOrigins, inputs, outputs }) => {
        statements.push({
          ...statement,
          instanceId: flattenedId,
          attributes,
          inputs,
          outputs,
        });
        provenanceByInstanceId[flattenedId] = { moduleId: moduleKey.moduleId, instanceIds: instancePath };
        documentPathByInstanceId[flattenedId] = moduleKey.documentPath;
        if (Object.keys(paramOrigins).length > 0) {
          paramOriginsByInstanceId[flattenedId] = paramOrigins;
        }
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      createErrorDiagnostic(
        "COMPARE_FLATTEN_FAILED",
        `Could not inline the module tree: ${reason}`,
        "compare",
        resolution.entryDocumentPath,
        undefined,
        { messageId: "compare.diagnostic.flattenFailed", messageArgs: { reason } },
      ),
    );
    return { diagnostics };
  }

  return {
    value: {
      module: {
        id: entry.module.id,
        params: entry.module.params,
        ports: entry.module.ports,
        statements,
      },
      provenanceByInstanceId,
      documentPathByInstanceId,
      paramOriginsByInstanceId,
    },
    diagnostics,
  };
}

function selectEntryModule(
  resolution: SwNetResolutionResult,
  entryModuleId: string | undefined,
  diagnostics: Diagnostic[],
): SwNetResolvedModule | undefined {
  const candidates = resolution.modules.filter(
    (module) =>
      module.key.documentPath === resolution.entryDocumentPath &&
      (entryModuleId === undefined || module.key.moduleId === entryModuleId),
  );

  if (entryModuleId !== undefined && candidates.length === 0) {
    diagnostics.push(
      createErrorDiagnostic(
        "COMPARE_ENTRY_MODULE_NOT_FOUND",
        `Entry document does not define module ${entryModuleId}.`,
        "compare",
        resolution.entryDocumentPath,
        undefined,
        { messageId: "compare.diagnostic.entryNotFound", messageArgs: { moduleId: entryModuleId } },
      ),
    );
    return undefined;
  }

  if (entryModuleId === undefined) {
    const main = candidates.find((module) => module.key.moduleId === "main");
    if (main) {
      return main;
    }
  }

  if (candidates.length !== 1) {
    diagnostics.push(
      createErrorDiagnostic(
        "COMPARE_ENTRY_MODULE_AMBIGUOUS",
        "Select an entry module explicitly when the entry document does not have a unique module or a module named main.",
        "compare",
        resolution.entryDocumentPath,
        undefined,
        { messageId: "compare.diagnostic.entryAmbiguous" },
      ),
    );
    return undefined;
  }

  return candidates[0];
}

function formatInstanceId(path: string[]): string {
  return path.map(encodeURIComponent).join("/");
}
