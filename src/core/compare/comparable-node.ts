import { type StormworksLibraryResult } from "../diagnostics.js";
import { type IrNode, type IrScalarValue } from "../ir.js";
import { resolveSwNetModuleGraph } from "../module-net-view.js";
import {
  type SwNetAssignment,
  type SwNetExpression,
  type SwNetModule,
  type SwNetStatement,
} from "../parsers/sw-net.js";
import { formatPortNameKey } from "../serializers/sw-net-shared.js";
import { type ComparableModuleGraph, type ComparableNode, type ComparablePortIdentity } from "./types.js";

/** Resolve and enrich one module into the complete, position-independent shape used for comparison. */
export function normalizeComparableModule(module: SwNetModule): StormworksLibraryResult<ComparableModuleGraph> {
  const graphResult = resolveSwNetModuleGraph(module, null);

  if (!graphResult.value) {
    return { diagnostics: graphResult.diagnostics };
  }

  const statementById = new Map(module.statements.map((statement) => [statement.instanceId, statement] as const));
  const portByNodeId = buildPortIdentityIndex(module);

  return {
    value: {
      moduleId: module.id,
      nodes: graphResult.value.nodes.map((node) =>
        normalizeNode(node, statementById.get(node.id), portByNodeId.get(node.id)),
      ),
      links: graphResult.value.links,
    },
    diagnostics: graphResult.diagnostics,
  };
}

function normalizeNode(
  node: IrNode,
  statement: SwNetStatement | undefined,
  port: ComparablePortIdentity | undefined,
): ComparableNode {
  return {
    node: { ...node, position: undefined },
    port,
    attributes: statement?.kind === "inst" ? assignmentsToScalarRecord(statement.attributes) : {},
    literalInputs: statement ? literalInputRecord(statement.inputs) : {},
  };
}

function buildPortIdentityIndex(module: SwNetModule): Map<string, ComparablePortIdentity> {
  const occurrenceByNameKey = new Map<string, number>();
  const result = new Map<string, ComparablePortIdentity>();

  for (const port of module.ports) {
    const nameKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByNameKey.get(nameKey) ?? 0) + 1;
    occurrenceByNameKey.set(nameKey, occurrence);
    result.set(`port:${port.direction}:${port.name}:${occurrence}`, { ...port, occurrence });
  }

  return result;
}

function assignmentsToScalarRecord(assignments: readonly SwNetAssignment[]): Record<string, IrScalarValue> {
  return Object.fromEntries(assignments.map((assignment) => [assignment.key, expressionToScalar(assignment.value)]));
}

function literalInputRecord(assignments: readonly SwNetAssignment[]): Record<string, IrScalarValue> {
  return Object.fromEntries(
    assignments.flatMap((assignment) => {
      const value = assignment.value;
      return value.kind === "number" || value.kind === "boolean" || value.kind === "null"
        ? [[assignment.key, value.value] as const]
        : [];
    }),
  );
}

function expressionToScalar(expression: SwNetExpression): IrScalarValue {
  return expression.value;
}
