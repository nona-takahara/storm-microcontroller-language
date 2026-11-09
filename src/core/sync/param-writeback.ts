// Synchronization of gate properties that are controlled by module parameters (issue #109).
//
// A flattened gate whose attribute was written as `@param` expands to a value the XML can change. Such a
// change is written back to the `use` argument that controls it, but only when every expanded gate
// sharing that argument agrees on the new value. Anything else is reported as a conflict instead of
// guessing, because the argument also feeds the other gates (and other expansions) that share it.
import { type ComparableNode, type MatchedNodePair } from "../compare/types.js";
import { type IrScalarValue } from "../ir.js";
import { type ParamOrigin } from "../module-params.js";
import { type SwNetExpression, type SwNetModule } from "../parsers/sw-net.js";
import {
  type SynchronizationChange,
  type SynchronizationConflict,
  type SynchronizationImpact,
} from "./types.js";

export interface ParamArgumentWriteback {
  documentPath: string;
  moduleId: string;
  useInstanceId: string;
  argName: string;
  value: SwNetExpression;
}

export interface ParamWritebackPlan {
  writebacks: ParamArgumentWriteback[];
  conflicts: SynchronizationConflict[];
  /** Attribute keys per existing flattened node id that a parameter controls; the statement keeps `@param` for these. */
  derivedKeys: Map<string, Set<string>>;
}

interface Observation {
  node: ComparableNode;
  attrKey: string;
  before: IrScalarValue | undefined;
  after: IrScalarValue | undefined;
  incoming: SwNetExpression | undefined;
}

export function planParamWritebacks(
  existingNodes: readonly ComparableNode[],
  pairs: readonly MatchedNodePair[],
  originsByNodeId: Record<string, Record<string, ParamOrigin | undefined>>,
  incomingModule: SwNetModule,
  impactOf: (node: ComparableNode) => SynchronizationImpact,
): ParamWritebackPlan {
  const pairByExistingId = new Map(pairs.map((pair) => [pair.a.node.id, pair] as const));
  const incomingStatementById = new Map(incomingModule.statements.map((statement) => [statement.instanceId, statement] as const));
  const derivedKeys = new Map<string, Set<string>>();
  const groups = new Map<string, { origin: ParamOrigin | undefined; observations: Observation[] }>();

  for (const node of existingNodes) {
    const origins = originsByNodeId[node.node.id];
    if (!origins) continue;
    derivedKeys.set(node.node.id, new Set(Object.keys(origins)));
    const pair = pairByExistingId.get(node.node.id);
    if (!pair) continue;
    const incomingStatement = incomingStatementById.get(pair.b.node.id);

    for (const [attrKey, origin] of Object.entries(origins)) {
      const groupKey = origin ? JSON.stringify(origin) : `unsupported\0${node.node.id}\0${attrKey}`;
      const group = groups.get(groupKey) ?? { origin, observations: [] };
      group.observations.push({
        node,
        attrKey,
        before: node.attributes[attrKey],
        after: pair.b.attributes[attrKey],
        incoming: incomingStatement?.kind === "inst" ? incomingStatement.attributes.find((item) => item.key === attrKey)?.value : undefined,
      });
      groups.set(groupKey, group);
    }
  }

  const writebacks: ParamArgumentWriteback[] = [];
  const conflicts: SynchronizationConflict[] = [];

  for (const { origin, observations } of groups.values()) {
    if (!observations.some((item) => item.before !== item.after)) continue;
    const impacts = observations.map((item) => impactOf(item.node));
    const conflict = (reason: string) => conflicts.push({
      kind: "module-parameter",
      reason,
      impacts,
      suggestions: [{
        kind: "review-candidates",
        description: "Review every gate controlled by the parameter, then change the parameter's value in the use statement by hand.",
        impacts,
        details: { gates: observations.map((item) => `${item.node.node.id}.${item.attrKey}`) },
      }],
    });

    if (!origin) {
      conflict("A property written as @param inside a list literal changed; it cannot be written back automatically.");
      continue;
    }
    if (origin.kind === "entry-default") {
      conflict(`The entry module's own parameter ${origin.paramName} changed; no use statement passes it, so edit the default by hand.`);
      continue;
    }

    const values = new Set(observations.map((item) => item.after));
    const incoming = observations.find((item) => item.incoming !== undefined)?.incoming;
    if (values.size > 1 || values.has(undefined) || !incoming) {
      const detail = observations.map((item) => `${item.node.node.id}.${item.attrKey}=${String(item.after)}`).join(", ");
      conflict(`Gates controlled by parameter ${origin.argName} of ${origin.useInstanceId} no longer agree on one value (${detail}).`);
      continue;
    }

    writebacks.push({
      documentPath: origin.documentPath,
      moduleId: origin.moduleId,
      useInstanceId: origin.useInstanceId,
      argName: origin.argName,
      value: incoming,
    });
  }

  return { writebacks, conflicts, derivedKeys };
}

/** Drop parameter-controlled keys from update changes; they are handled by write-back, not by rewriting the gate. */
export function withoutParamDerivedChanges(
  changes: readonly SynchronizationChange[],
  derivedKeys: ReadonlyMap<string, ReadonlySet<string>>,
): SynchronizationChange[] {
  return changes.flatMap((change): SynchronizationChange[] => {
    const derived = change.existing ? derivedKeys.get(change.existing.nodeId) : undefined;
    if (change.kind !== "updated" || !derived || !change.propertyChanges) return [change];
    const remaining = Object.fromEntries(Object.entries(change.propertyChanges).filter(([key]) => !derived.has(key)));
    return Object.keys(remaining).length > 0 ? [{ ...change, propertyChanges: remaining }] : [];
  });
}
