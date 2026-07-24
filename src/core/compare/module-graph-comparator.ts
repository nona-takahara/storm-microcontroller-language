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

export const DEFAULT_MAX_SEARCH_STEPS = 10_000;

/**
 * Compare two modules without treating instance ids, statement order, or layout as identity.
 */
export function compareSwNetModules(
  a: SwNetModule,
  b: SwNetModule,
  options: NetworkComparisonOptions = {},
): StormworksLibraryResult<NetworkComparisonResult> {
  const normalizedA = normalizeComparableModule(a);
  const normalizedB = normalizeComparableModule(b);
  const diagnostics = [...normalizedA.diagnostics, ...normalizedB.diagnostics];

  if (!normalizedA.value || !normalizedB.value) {
    return { diagnostics };
  }

  return {
    value: compareComparableModuleGraphs(normalizedA.value, normalizedB.value, diagnostics, options),
    diagnostics,
  };
}

export function compareComparableModuleGraphs(
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  diagnostics: Diagnostic[] = [],
  options: NetworkComparisonOptions = {},
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
    if (hasForcedMismatch) {
      return resultFromPairs(
        "different",
        pairs,
        a,
        b,
        diagnostics,
        "A forced node has no candidate with matching incident endpoint/port wiring.",
      );
    }

    const search = searchCorrespondence(
      a,
      b,
      pairs,
      options.maxSearchSteps ?? DEFAULT_MAX_SEARCH_STEPS,
    );
    if (search.kind === "found") {
      return resultFromCompleteCorrespondence(search.pairs, a, b, diagnostics);
    }

    return resultFromPairs(
      search.kind === "truncated" ? "indeterminate" : "different",
      pairs,
      a,
      b,
      diagnostics,
      search.kind === "truncated"
        ? `Search budget exhausted after ${search.steps} candidate assignments.`
        : `Exhaustive search found no endpoint/port-preserving correspondence after ${search.steps} candidate assignments.`,
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

  return resultFromCompleteCorrespondence(pairs, a, b, diagnostics);
}

type SearchResult =
  | { kind: "found"; pairs: MatchedNodePair[]; steps: number }
  | { kind: "exhausted" | "truncated"; steps: number };

function searchCorrespondence(
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  forcedPairs: MatchedNodePair[],
  maxSearchSteps: number,
): SearchResult {
  const pairs = [...forcedPairs];
  const matchedA = new Set(pairs.map((pair) => pair.a.node.id));
  const matchedB = new Set(pairs.map((pair) => pair.b.node.id));
  let steps = 0;
  let truncated = false;

  const visit = (): MatchedNodePair[] | undefined => {
    if (pairs.length === a.nodes.length) {
      return compareLinks(a, b, pairs).length === 0 ? [...pairs] : undefined;
    }

    const bIdByAId = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
    const next = a.nodes
      .filter((node) => !matchedA.has(node.node.id))
      .map((nodeA) => ({
        nodeA,
        choices: b.nodes.filter(
          (nodeB) =>
            !matchedB.has(nodeB.node.id) &&
            comparableNodeKind(nodeA) === comparableNodeKind(nodeB) &&
            mappedIncidentKeys(a.links, nodeA.node.id, bIdByAId).join("\n") ===
              incidentKeys(b.links, nodeB.node.id, matchedB).join("\n"),
        ),
      }))
      .sort(
        (left, right) =>
          left.choices.length - right.choices.length ||
          comparableNodeKind(left.nodeA).localeCompare(comparableNodeKind(right.nodeA)) ||
          left.nodeA.node.id.localeCompare(right.nodeA.node.id),
      )[0];

    if (!next || next.choices.length === 0) {
      return undefined;
    }

    for (const nodeB of next.choices.sort((left, right) => left.node.id.localeCompare(right.node.id))) {
      if (steps >= Math.max(0, maxSearchSteps)) {
        truncated = true;
        return undefined;
      }
      steps += 1;
      pairs.push({ a: next.nodeA, b: nodeB });
      matchedA.add(next.nodeA.node.id);
      matchedB.add(nodeB.node.id);

      const found = visit();
      if (found) {
        return found;
      }

      pairs.pop();
      matchedA.delete(next.nodeA.node.id);
      matchedB.delete(nodeB.node.id);
      if (truncated) {
        return undefined;
      }
    }

    return undefined;
  };

  const found = visit();
  return found
    ? { kind: "found", pairs: found, steps }
    : { kind: truncated ? "truncated" : "exhausted", steps };
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

function resultFromCompleteCorrespondence(
  pairs: MatchedNodePair[],
  a: ComparableModuleGraph,
  b: ComparableModuleGraph,
  diagnostics: NetworkComparisonResult["diagnostics"],
): NetworkComparisonResult {
  const propertyDifferences = compareProperties(pairs);
  return resultFromPairs(
    propertyDifferences.length > 0 ? "different" : "equivalent",
    pairs,
    a,
    b,
    diagnostics,
    propertyDifferences.length > 0
      ? `${propertyDifferences.length} matched-node property value mismatch(es) found.`
      : undefined,
    propertyDifferences,
  );
}

function compareProperties(pairs: MatchedNodePair[]): NetworkDifference[] {
  return pairs.flatMap((pair) => [
    ...comparePropertySource(pair, "attribute", pair.a.attributes, pair.b.attributes),
    ...comparePropertySource(pair, "literalInput", pair.a.literalInputs, pair.b.literalInputs),
  ]);
}

function comparePropertySource(
  pair: MatchedNodePair,
  source: "attribute" | "literalInput",
  valuesA: Record<string, import("../ir.js").IrScalarValue>,
  valuesB: Record<string, import("../ir.js").IrScalarValue>,
): NetworkDifference[] {
  return [...new Set([...Object.keys(valuesA), ...Object.keys(valuesB)])]
    .sort()
    .flatMap((key): NetworkDifference[] => {
      const hasA = Object.hasOwn(valuesA, key);
      const hasB = Object.hasOwn(valuesB, key);
      if (hasA === hasB && valuesA[key] === valuesB[key]) {
        return [];
      }

      return [{
        kind: "property-value-mismatch",
        nodeA: pair.a,
        nodeB: pair.b,
        source,
        key,
        ...(hasA ? { valueA: valuesA[key] } : {}),
        ...(hasB ? { valueB: valuesB[key] } : {}),
      }];
    });
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
