import { comparableNodeKind } from "../compare/fingerprint.js";
import {
  type ComparableModuleGraph,
  type ComparableNode,
  type MatchedNodePair,
} from "../compare/types.js";

export interface PartialCorrespondenceOptions {
  maxSearchSteps?: number;
}

export interface PartialCorrespondenceResult {
  certainPairs: MatchedNodePair[];
  unmatchedExisting: ComparableNode[];
  unmatchedIncoming: ComparableNode[];
  ambiguousExisting: ComparableNode[];
  ambiguousIncoming: ComparableNode[];
  optimalCorrespondenceCount: number;
  searchSteps: number;
  truncated: boolean;
}

const DEFAULT_PARTIAL_SEARCH_STEPS = 20_000;

/**
 * Find only correspondences shared by every optimal partial graph mapping. Object ids and property
 * values deliberately never participate in identity.
 */
export function findPartialNodeCorrespondence(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
  options: PartialCorrespondenceOptions = {},
): PartialCorrespondenceResult {
  const candidates = buildCandidates(existing, incoming);
  const forced = propagateCertainPairs(existing, incoming, candidates);
  const remainingExisting = existing.nodes.filter((node) => !forced.existingIds.has(node.node.id));
  const usedIncoming = new Set(forced.pairs.map((pair) => pair.b.node.id));
  const ordered = remainingExisting.sort(
    (left, right) =>
      availableCandidates(candidates, left, usedIncoming).length -
        availableCandidates(candidates, right, usedIncoming).length ||
      left.node.id.localeCompare(right.node.id),
  );
  const maxSteps = Math.max(0, options.maxSearchSteps ?? DEFAULT_PARTIAL_SEARCH_STEPS);
  const current = [...forced.pairs];
  const optimal: MatchedNodePair[][] = [];
  let bestScore: [number, number] = [-1, -1];
  let steps = 0;
  let truncated = false;

  const visit = (index: number): void => {
    if (truncated) {
      return;
    }
    if (steps >= maxSteps) {
      truncated = true;
      return;
    }
    steps += 1;

    if (index === ordered.length) {
      const score: [number, number] = [current.length, countPreservedLinks(existing, incoming, current)];
      const comparison = compareScore(score, bestScore);
      if (comparison > 0) {
        bestScore = score;
        optimal.length = 0;
        optimal.push([...current]);
      } else if (comparison === 0) {
        optimal.push([...current]);
      }
      return;
    }

    const nodeA = ordered[index]!;
    const choices = availableCandidates(candidates, nodeA, usedIncoming);
    for (const nodeB of choices) {
      current.push({ a: nodeA, b: nodeB });
      usedIncoming.add(nodeB.node.id);
      visit(index + 1);
      usedIncoming.delete(nodeB.node.id);
      current.pop();
    }

    visit(index + 1);
  };

  visit(0);
  const completed = optimal.length > 0 ? optimal : [[...forced.pairs]];
  const certainPairs = intersectPairs(completed);
  const certainA = new Set(certainPairs.map((pair) => pair.a.node.id));
  const certainB = new Set(certainPairs.map((pair) => pair.b.node.id));
  const everMatchedA = new Set(completed.flatMap((pairs) => pairs.map((pair) => pair.a.node.id)));
  const everMatchedB = new Set(completed.flatMap((pairs) => pairs.map((pair) => pair.b.node.id)));

  return {
    certainPairs,
    unmatchedExisting: existing.nodes.filter((node) => !everMatchedA.has(node.node.id)),
    unmatchedIncoming: incoming.nodes.filter((node) => !everMatchedB.has(node.node.id)),
    ambiguousExisting: existing.nodes.filter(
      (node) => everMatchedA.has(node.node.id) && !certainA.has(node.node.id),
    ),
    ambiguousIncoming: incoming.nodes.filter(
      (node) => everMatchedB.has(node.node.id) && !certainB.has(node.node.id),
    ),
    optimalCorrespondenceCount: completed.length,
    searchSteps: steps,
    truncated,
  };
}

function buildCandidates(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
): Map<ComparableNode, ComparableNode[]> {
  const result = new Map<ComparableNode, ComparableNode[]>();
  for (const nodeA of existing.nodes) {
    result.set(
      nodeA,
      incoming.nodes.filter((nodeB) => hasSameIdentityClass(nodeA, nodeB)),
    );
  }
  return result;
}

function hasSameIdentityClass(left: ComparableNode, right: ComparableNode): boolean {
  if (left.port || right.port) {
    return JSON.stringify(left.port) === JSON.stringify(right.port);
  }
  return comparableNodeKind(left) === comparableNodeKind(right);
}

function propagateCertainPairs(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
  candidates: Map<ComparableNode, ComparableNode[]>,
): { pairs: MatchedNodePair[]; existingIds: Set<string> } {
  const pairs: MatchedNodePair[] = [];
  const existingIds = new Set<string>();
  const incomingIds = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const nodeA of existing.nodes) {
      if (existingIds.has(nodeA.node.id)) {
        continue;
      }
      const choices = (candidates.get(nodeA) ?? []).filter(
        (nodeB) =>
          !incomingIds.has(nodeB.node.id) &&
          hasCompatibleCertainAdjacency(existing, incoming, nodeA, nodeB, pairs),
      );
      const isOnlyClaimant =
        choices.length === 1 &&
        existing.nodes.filter(
          (other) =>
            !existingIds.has(other.node.id) &&
            (candidates.get(other) ?? []).some((candidate) => candidate.node.id === choices[0]!.node.id),
        ).length === 1;

      if (isOnlyClaimant) {
        pairs.push({ a: nodeA, b: choices[0]! });
        existingIds.add(nodeA.node.id);
        incomingIds.add(choices[0]!.node.id);
        changed = true;
        break;
      }
    }
  }

  return { pairs, existingIds };
}

function hasCompatibleCertainAdjacency(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
  nodeA: ComparableNode,
  nodeB: ComparableNode,
  pairs: MatchedNodePair[],
): boolean {
  return pairs.every((pair) => {
    const oldEdges = edgeKeysBetween(existing, nodeA.node.id, pair.a.node.id);
    const newEdges = edgeKeysBetween(incoming, nodeB.node.id, pair.b.node.id);
    return oldEdges.length === 0 || newEdges.length === 0 || oldEdges.some((key) => newEdges.includes(key));
  });
}

function availableCandidates(
  candidates: Map<ComparableNode, ComparableNode[]>,
  node: ComparableNode,
  usedIncoming: Set<string>,
): ComparableNode[] {
  return (candidates.get(node) ?? [])
    .filter((candidate) => !usedIncoming.has(candidate.node.id))
    .sort((left, right) => left.node.id.localeCompare(right.node.id));
}

function countPreservedLinks(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
  pairs: MatchedNodePair[],
): number {
  const incomingIdByExistingId = new Map(
    pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const),
  );
  const incomingLinks = new Set(incoming.links.map(linkKey));
  return existing.links.filter((link) => {
    const from = incomingIdByExistingId.get(link.from.nodeId);
    const to = incomingIdByExistingId.get(link.to.nodeId);
    return from && to
      ? incomingLinks.has(`${from}:${link.from.portKey}->${to}:${link.to.portKey}`)
      : false;
  }).length;
}

function edgeKeysBetween(graph: ComparableModuleGraph, first: string, second: string): string[] {
  return graph.links.flatMap((link) => {
    if (link.from.nodeId === first && link.to.nodeId === second) {
      return [`out:${link.from.portKey}:${link.to.portKey}`];
    }
    if (link.from.nodeId === second && link.to.nodeId === first) {
      return [`in:${link.to.portKey}:${link.from.portKey}`];
    }
    return [];
  });
}

function linkKey(link: ComparableModuleGraph["links"][number]): string {
  return `${link.from.nodeId}:${link.from.portKey}->${link.to.nodeId}:${link.to.portKey}`;
}

function compareScore(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

function intersectPairs(correspondences: MatchedNodePair[][]): MatchedNodePair[] {
  const first = correspondences[0] ?? [];
  return first.filter((pair) =>
    correspondences.every((candidate) =>
      candidate.some(
        (other) => other.a.node.id === pair.a.node.id && other.b.node.id === pair.b.node.id,
      ),
    ),
  );
}
