import { type Diagnostic, type StormworksLibraryResult } from "../diagnostics.js";
import { type IrLink } from "../ir.js";
import { type SwNetModule } from "../parsers/sw-net.js";
import { normalizeComparableModule } from "./comparable-node.js";
import { comparableNodeKind, compareNodeKindCounts } from "./fingerprint.js";
import {
  type ComparableModuleGraph,
  type ComparableNode,
  type MatchedNodePair,
  type NetworkComparisonResult,
  type NetworkDifference,
} from "./types.js";

export interface NetworkComparisonOptions {
  maxSearchSteps?: number;
}

/**
 * Compare two modules without treating instance ids, statement order, or layout as identity.
 *
 * The initial implementation intentionally stops at unresolved symmetric type classes. Bounded
 * search for those classes is layered on separately; this function never guesses a correspondence.
 */
export function compareSwNetModules(
  a: SwNetModule,
  b: SwNetModule,
  _options: NetworkComparisonOptions = {},
): StormworksLibraryResult<NetworkComparisonResult> {
  const normalizedA = normalizeComparableModule(a);
  const normalizedB = normalizeComparableModule(b);
  const diagnostics = [...normalizedA.diagnostics, ...normalizedB.diagnostics];

  if (!normalizedA.value || !normalizedB.value) {
    return { diagnostics };
  }

  return {
    value: compareComparableModuleGraphs(normalizedA.value, normalizedB.value, diagnostics),
    diagnostics,
  };
}

export function compareComparableModuleGraphs(
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  diagnostics: Diagnostic[] = [],
): NetworkComparisonResult {
  const countMismatches = compareNodeKindCounts(a, b);

  if (countMismatches.length > 0) {
    const reason = countMismatches
      .map(({ kind, countA, countB }) => `${kind} (${countA} in A, ${countB} in B)`)
      .join(", ");
    return resultFromPairs(
      "different",
      [],
      a,
      b,
      diagnostics,
      `Node kind multiset differs: ${reason}.`,
    );
  }

  const nodesAByKind = groupNodesByKind(a.nodes);
  const nodesBByKind = groupNodesByKind(b.nodes);
  const pairs: MatchedNodePair[] = [];

  for (const kind of [...nodesAByKind.keys()].sort()) {
    const candidatesA = nodesAByKind.get(kind) ?? [];
    const candidatesB = nodesBByKind.get(kind) ?? [];

    if (candidatesA.length === 1) {
      pairs.push({ a: candidatesA[0]!, b: candidatesB[0]! });
    }
  }

  const hasForcedMismatch = propagateForcedPairs(a, b, pairs);

  if (pairs.length < a.nodes.length) {
    return resultFromPairs(
      hasForcedMismatch ? "different" : "indeterminate",
      pairs,
      a,
      b,
      diagnostics,
      hasForcedMismatch
        ? "A forced node has no candidate with matching incident endpoint/port wiring."
        : "Structurally ambiguous node classes require bounded search.",
    );
  }

  const linkDifferences = compareLinks(a, b, pairs);
  if (linkDifferences.length > 0) {
    return resultFromPairs(
      "different",
      pairs,
      a,
      b,
      diagnostics,
      "The forced node correspondence has different endpoint/port wiring.",
      linkDifferences,
    );
  }

  return resultFromPairs("equivalent", pairs, a, b, diagnostics);
}

function propagateForcedPairs(a: ComparableModuleGraph, b: ComparableModuleGraph, pairs: MatchedNodePair[]): boolean {
  let changed = true;

  while (changed) {
    changed = false;
    const matchedA = new Set(pairs.map((pair) => pair.a.node.id));
    const matchedB = new Set(pairs.map((pair) => pair.b.node.id));
    const bIdByAId = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
    const remainingA = a.nodes.filter((node) => !matchedA.has(node.node.id));
    const remainingB = b.nodes.filter((node) => !matchedB.has(node.node.id));
    const candidates = new Map<ComparableNode, ComparableNode[]>();

    for (const nodeA of remainingA) {
      candidates.set(
        nodeA,
        remainingB.filter(
          (nodeB) =>
            comparableNodeKind(nodeA) === comparableNodeKind(nodeB) &&
            mappedIncidentKeys(a.links, nodeA.node.id, bIdByAId).join("\n") ===
              incidentKeys(b.links, nodeB.node.id, matchedB).join("\n"),
        ),
      );
    }

    if ([...candidates.values()].some((choices) => choices.length === 0)) {
      return true;
    }

    for (const nodeA of remainingA) {
      const choices = candidates.get(nodeA) ?? [];
      if (
        choices.length === 1 &&
        remainingA.filter((otherA) => (candidates.get(otherA) ?? []).includes(choices[0]!)).length === 1
      ) {
        pairs.push({ a: nodeA, b: choices[0]! });
        changed = true;
        break;
      }
    }
  }

  return false;
}

function mappedIncidentKeys(links: IrLink[], nodeId: string, bIdByAId: Map<string, string>): string[] {
  return links
    .flatMap((link) => {
      if (link.from.nodeId === nodeId && bIdByAId.has(link.to.nodeId)) {
        return [`out:${link.from.portKey}:${bIdByAId.get(link.to.nodeId)}:${link.to.portKey}`];
      }
      if (link.to.nodeId === nodeId && bIdByAId.has(link.from.nodeId)) {
        return [`in:${link.to.portKey}:${bIdByAId.get(link.from.nodeId)}:${link.from.portKey}`];
      }
      return [];
    })
    .sort();
}

function incidentKeys(links: IrLink[], nodeId: string, includedNodeIds: Set<string>): string[] {
  return links
    .flatMap((link) => {
      if (link.from.nodeId === nodeId && includedNodeIds.has(link.to.nodeId)) {
        return [`out:${link.from.portKey}:${link.to.nodeId}:${link.to.portKey}`];
      }
      if (link.to.nodeId === nodeId && includedNodeIds.has(link.from.nodeId)) {
        return [`in:${link.to.portKey}:${link.from.nodeId}:${link.from.portKey}`];
      }
      return [];
    })
    .sort();
}

function groupNodesByKind(nodes: ComparableNode[]): Map<string, ComparableNode[]> {
  const result = new Map<string, ComparableNode[]>();
  for (const node of nodes) {
    const kind = comparableNodeKind(node);
    const group = result.get(kind) ?? [];
    group.push(node);
    result.set(kind, group);
  }
  return result;
}

function compareLinks(
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  pairs: MatchedNodePair[],
): NetworkDifference[] {
  const bIdByAId = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
  const remainingB = new Map<string, IrLink[]>();

  for (const link of b.links) {
    const key = linkKey(link);
    const links = remainingB.get(key) ?? [];
    links.push(link);
    remainingB.set(key, links);
  }

  const differences: NetworkDifference[] = [];
  for (const link of a.links) {
    const mappedFrom = bIdByAId.get(link.from.nodeId);
    const mappedTo = bIdByAId.get(link.to.nodeId);
    const mappedKey =
      mappedFrom && mappedTo
        ? linkKey({ ...link, from: { ...link.from, nodeId: mappedFrom }, to: { ...link.to, nodeId: mappedTo } })
        : undefined;
    const matches = mappedKey ? remainingB.get(mappedKey) : undefined;

    if (!matches || matches.length === 0) {
      differences.push({ kind: "unmatched-link", side: "a", link });
    } else {
      matches.pop();
    }
  }

  for (const links of remainingB.values()) {
    for (const link of links) {
      differences.push({ kind: "unmatched-link", side: "b", link });
    }
  }

  return differences;
}

function linkKey(link: IrLink): string {
  return JSON.stringify([link.from.nodeId, link.from.portKey, link.to.nodeId, link.to.portKey]);
}

function resultFromPairs(
  verdict: NetworkComparisonResult["verdict"],
  pairs: MatchedNodePair[],
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  diagnostics: NetworkComparisonResult["diagnostics"],
  reason?: string,
  differences: NetworkDifference[] = [],
): NetworkComparisonResult {
  const matchedA = new Set(pairs.map((pair) => pair.a.node.id));
  const matchedB = new Set(pairs.map((pair) => pair.b.node.id));
  const unmatchedInA = a.nodes.filter((node) => !matchedA.has(node.node.id));
  const unmatchedInB = b.nodes.filter((node) => !matchedB.has(node.node.id));

  return {
    verdict,
    matchedPairs: pairs,
    unmatchedInA,
    unmatchedInB,
    differences: [
      ...differences,
      ...unmatchedInA.map((node): NetworkDifference => ({ kind: "unmatched-node", side: "a", node })),
      ...unmatchedInB.map((node): NetworkDifference => ({ kind: "unmatched-node", side: "b", node })),
    ],
    reason,
    diagnostics,
  };
}
