import {
  createErrorDiagnostic,
  type Diagnostic,
  type StormworksLibraryResult,
} from "../diagnostics.js";
import {
  type SwNetAssignment,
  type SwNetExpression,
  type SwNetModule,
  type SwNetPort,
  type SwNetStatement,
} from "../parsers/sw-net.js";
import {
  type SwNetResolutionResult,
  type SwNetResolvedModule,
  type SwNetResolvedModuleKey,
} from "../resolvers/sw-net.js";
import { type ProvenancePath } from "./types.js";

export interface FlattenSwNetProjectOptions {
  entryModuleId?: string;
}

export interface FlattenedSwNetProject {
  module: SwNetModule;
  provenanceByInstanceId: Record<string, ProvenancePath>;
}

/**
 * Inline the selected entry module's complete `use` tree into one ordinary sw-net module.
 * This is the comparison authority: its shape matches the circuit after module boundaries vanish.
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

  const moduleByKey = new Map(
    resolution.modules.map((resolved) => [formatModuleKey(resolved.key), resolved] as const),
  );
  const statements: SwNetStatement[] = [];
  const provenanceByInstanceId: Record<string, ProvenancePath> = {};
  const rootBindings = new Map(
    entry.module.ports.map((port) => [portBindingKey(port), stringExpression(port.name)] as const),
  );

  flattenModule(
    entry,
    [],
    rootBindings,
    moduleByKey,
    statements,
    provenanceByInstanceId,
  );

  return {
    value: {
      module: {
        id: entry.module.id,
        ports: entry.module.ports,
        statements,
      },
      provenanceByInstanceId,
    },
    diagnostics,
  };
}

function flattenModule(
  resolved: SwNetResolvedModule,
  instancePath: string[],
  portBindings: Map<string, SwNetExpression>,
  moduleByKey: Map<string, SwNetResolvedModule>,
  statements: SwNetStatement[],
  provenanceByInstanceId: Record<string, ProvenancePath>,
): void {
  const useByInstanceId = new Map(
    resolved.uses.map((use) => [use.statement.instanceId, use] as const),
  );

  for (const statement of resolved.module.statements) {
    if (statement.kind === "inst") {
      const flattenedId = formatInstanceId([...instancePath, statement.instanceId]);
      statements.push({
        ...statement,
        instanceId: flattenedId,
        attributes: cloneAssignments(statement.attributes),
        inputs: rewriteAssignments(statement.inputs, resolved.module.ports, portBindings, instancePath, false),
        outputs: rewriteAssignments(statement.outputs, resolved.module.ports, portBindings, instancePath, true),
      });
      provenanceByInstanceId[flattenedId] = {
        moduleId: resolved.module.id,
        instanceIds: [...instancePath, statement.instanceId],
      };
      continue;
    }

    const use = useByInstanceId.get(statement.instanceId);
    const target = use ? moduleByKey.get(formatModuleKey(use.target)) : undefined;
    if (!target) {
      throw new Error(
        `Resolved use target for ${resolved.module.id}.${statement.instanceId} was not found.`,
      );
    }

    const childPath = [...instancePath, statement.instanceId];
    const childBindings = buildChildPortBindings(
      target.module.ports,
      statement.inputs,
      statement.outputs,
      resolved.module.ports,
      portBindings,
      instancePath,
      childPath,
    );
    flattenModule(
      target,
      childPath,
      childBindings,
      moduleByKey,
      statements,
      provenanceByInstanceId,
    );
  }
}

function buildChildPortBindings(
  childPorts: SwNetPort[],
  inputs: SwNetAssignment[],
  outputs: SwNetAssignment[],
  parentPorts: SwNetPort[],
  parentBindings: Map<string, SwNetExpression>,
  parentPath: string[],
  childPath: string[],
): Map<string, SwNetExpression> {
  const inputsByKey = new Map(inputs.map((assignment) => [assignment.key, assignment.value] as const));
  const outputsByKey = new Map(outputs.map((assignment) => [assignment.key, assignment.value] as const));
  const result = new Map<string, SwNetExpression>();

  for (const port of childPorts) {
    const assigned = (port.direction === "in" ? inputsByKey : outputsByKey).get(port.name);
    if (assigned) {
      result.set(
        portBindingKey(port),
        rewriteExpression(assigned, parentPorts, parentBindings, parentPath),
      );
    } else if (port.direction === "out") {
      result.set(portBindingKey(port), stringExpression(formatLocalNet(childPath, `port:${port.name}`)));
    }
  }

  return result;
}

function rewriteAssignments(
  assignments: SwNetAssignment[],
  ports: SwNetPort[],
  portBindings: Map<string, SwNetExpression>,
  instancePath: string[],
  keepUnboundPort: boolean,
): SwNetAssignment[] {
  return assignments.flatMap((assignment): SwNetAssignment[] => {
    const rewritten = rewriteExpressionOrUndefined(
      assignment.value,
      ports,
      portBindings,
      instancePath,
      keepUnboundPort,
    );
    return rewritten ? [{ key: assignment.key, value: rewritten }] : [];
  });
}

function rewriteExpression(
  expression: SwNetExpression,
  ports: SwNetPort[],
  portBindings: Map<string, SwNetExpression>,
  instancePath: string[],
): SwNetExpression {
  return (
    rewriteExpressionOrUndefined(expression, ports, portBindings, instancePath, true) ??
    expression
  );
}

function rewriteExpressionOrUndefined(
  expression: SwNetExpression,
  ports: SwNetPort[],
  portBindings: Map<string, SwNetExpression>,
  instancePath: string[],
  keepUnboundPort: boolean,
): SwNetExpression | undefined {
  if (expression.kind === "identifier") {
    return {
      kind: "identifier",
      value: formatLocalNet(instancePath, expression.value),
    };
  }

  if (expression.kind !== "string") {
    return { ...expression };
  }

  const matchingPorts = ports.filter((port) => port.name === expression.value);
  if (matchingPorts.length > 0) {
    for (const port of matchingPorts) {
      const binding = portBindings.get(portBindingKey(port));
      if (binding) {
        return { ...binding };
      }
    }
    return keepUnboundPort
      ? stringExpression(formatLocalNet(instancePath, `unbound:${expression.value}`))
      : undefined;
  }

  return stringExpression(formatLocalNet(instancePath, expression.value));
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
      ),
    );
    return undefined;
  }

  return candidates[0];
}

function rewriteAssignment(assignment: SwNetAssignment): SwNetAssignment {
  return { key: assignment.key, value: { ...assignment.value } };
}

function cloneAssignments(assignments: SwNetAssignment[]): SwNetAssignment[] {
  return assignments.map(rewriteAssignment);
}

function portBindingKey(port: SwNetPort): string {
  return `${port.direction}:${port.name}`;
}

function formatModuleKey(key: SwNetResolvedModuleKey): string {
  return JSON.stringify([key.documentPath, key.moduleId]);
}

function formatInstanceId(path: string[]): string {
  return path.map(encodeURIComponent).join("/");
}

function formatLocalNet(path: string[], netName: string): string {
  return formatInstanceId([...path, `$${netName}`]);
}

function stringExpression(value: string): SwNetExpression {
  return { kind: "string", value };
}
