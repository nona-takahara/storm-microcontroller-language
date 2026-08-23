import { comparableNodeKind } from "../compare/fingerprint.js";
import {
  displayNameEvidenceValue,
  ordinaryAttributeEvidenceKeys,
  STRONG_CORRESPONDENCE_EVIDENCE_KEYS,
  strongCorrespondenceEvidenceValue,
} from "../compare/correspondence-evidence.js";
import { incidentKeys, mappedIncidentKeys } from "../compare/structural-correspondence.js";
import {
  type ComparableModuleGraph,
  type ComparableNode,
  type MatchedNodePair,
} from "../compare/types.js";
import { type IrScalarValue } from "../ir.js";

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
  /** Complete optimal mappings, available only when the search finished. Sync compares their projected outputs. */
  optimalCorrespondences: MatchedNodePair[][];
}

// With the skip-branch pruning above, the search's remaining cost for a residual `propagateCertainPairs`
// could not resolve is the number of full candidate assignments within that residual -- it must
// enumerate every one to prove the best-scoring assignment is unique -- which is factorial in the
// residual's size for a fully symmetric same-kind cluster (no distinguishing link or label, resolved
// only by the soft property-value score). A real project (NITS_Simple_Bridge, see issue #71/#72's
// regression follow-up) hit an 8-node fully symmetric residual on an otherwise no-op re-import; it
// measures 178,882 steps to resolve. This budget covers that with headroom, plus a 9-node cluster
// (1,609,940 measured), while still completing in low single-digit seconds. It does not make
// arbitrarily large symmetric clusters tractable -- a 10-node cluster is already ~9x that -- but an
// exhaustive search fundamentally can't scale past what a project actually produces; making bigger
// clusters tractable needs a polynomial assignment-problem formulation instead, tracked separately.
const DEFAULT_PARTIAL_SEARCH_STEPS = 2_000_000;
// Keep the exhaustive fallback's memory bounded as well as its running time. Exact-equivalence
// symmetry is handled by the polynomial/exact path; a changed graph that still produces more than
// this many equally optimal partial mappings is safer to report as search exhaustion than to retain
// an unbounded factorial result set merely to compare projected outputs.
const MAX_RETAINED_OPTIMAL_CORRESPONDENCES = 10_000;

/**
 * Find only correspondences shared by every optimal partial graph mapping. Object ids and property
 * values never decide which candidates are *eligible* to correspond (that stays purely structural,
 * see `hasSameIdentityClass`); once multiple structurally-tied candidates remain, matching `n`
 * (display-label) and other property values break the tie as described by `compareScore` below.
 * A correspondence is reported as `certainPairs` only when it is the single best-scoring one shared
 * by every optimal search branch, so a tie that neither structure nor properties resolve still
 * surfaces as an ambiguous-correspondence conflict instead of being guessed.
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
  let bestScore: CorrespondenceScore = [-1, -1, -1, -1, -1];
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

    // Branch-and-bound on the score's first (and most significant) component: with `current.length`
    // pairs already decided and `ordered.length - index` nodes left to decide, no completion reached
    // from here can match more than `current.length + (ordered.length - index)` pairs. If that can't
    // reach the best full-match count found so far, every remaining branch here -- most importantly
    // every branch that leaves a node unmatched (the unconditional `visit(index + 1)` skip call
    // below), which otherwise turns this search from "try every candidate assignment" into "try
    // every subset of every assignment" -- is provably worse and can be skipped outright. This does
    // not change which correspondences end up in `certainPairs`: ties on the full score still reach
    // the leaf and still accumulate into `optimal`, so ambiguity detection is unaffected.
    if (current.length + (ordered.length - index) < bestScore[0]) {
      return;
    }

    if (index === ordered.length) {
      const score: CorrespondenceScore = [
        current.length,
        countPreservedLinks(existing, incoming, current),
        countExpressionMatches(current),
        countNameMatches(current),
        countPropertyKeyMatches(current),
      ];
      const comparison = compareScore(score, bestScore);
      if (comparison > 0) {
        bestScore = score;
        optimal.length = 0;
        optimal.push([...current]);
      } else if (comparison === 0) {
        if (optimal.length >= MAX_RETAINED_OPTIMAL_CORRESPONDENCES) {
          truncated = true;
          return;
        }
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
  // Once search is truncated, unexplored branches may invalidate every search-derived conclusion.
  // Only fixed-point propagation pairs were proved independently of the incomplete enumeration.
  const certainPairs = truncated ? forced.pairs : intersectPairs(completed);
  const certainA = new Set(certainPairs.map((pair) => pair.a.node.id));
  const certainB = new Set(certainPairs.map((pair) => pair.b.node.id));
  const everMatchedA = new Set(completed.flatMap((pairs) => pairs.map((pair) => pair.a.node.id)));
  const everMatchedB = new Set(completed.flatMap((pairs) => pairs.map((pair) => pair.b.node.id)));

  return {
    certainPairs,
    unmatchedExisting: truncated ? [] : existing.nodes.filter((node) => !everMatchedA.has(node.node.id)),
    unmatchedIncoming: truncated ? [] : incoming.nodes.filter((node) => !everMatchedB.has(node.node.id)),
    ambiguousExisting: existing.nodes.filter((node) =>
      truncated ? !certainA.has(node.node.id) : everMatchedA.has(node.node.id) && !certainA.has(node.node.id),
    ),
    ambiguousIncoming: incoming.nodes.filter((node) =>
      truncated ? !certainB.has(node.node.id) : everMatchedB.has(node.node.id) && !certainB.has(node.node.id),
    ),
    optimalCorrespondenceCount: completed.length,
    searchSteps: steps,
    truncated,
    optimalCorrespondences: truncated ? [] : completed.map((pairs) => [...pairs]),
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
    const bIdByAId = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
    for (const nodeA of existing.nodes) {
      if (existingIds.has(nodeA.node.id)) {
        continue;
      }

      // The strongest, least-presumptuous signal: a node whose links to already-forced neighbors
      // have exactly one candidate with that same set of links to those same forced neighbors is
      // that candidate, full stop -- no adjacency leniency, no labels, no properties involved. This
      // mirrors the exact-match propagation compare-dsl's equivalence search already relies on
      // (see `module-graph-comparator.ts`'s `propagateForcedPairs`) and is what lets a real,
      // sparsely-linked circuit converge by cascading outward from its few naturally unique anchors
      // (project ports, uniquely-labeled nodes) instead of falling straight to the exponential
      // fallback search below for every node the cheaper rules beneath it cannot yet resolve. A node
      // with no links to forced neighbors yet (signature is empty) skips this rule and falls to the
      // ones below; a genuinely rewired node's signature can never match a wrong candidate's, so it
      // also falls through rather than being mis-forced.
      const requiredSignature = mappedIncidentKeys(existing, nodeA.node.id, bIdByAId).join("\n");
      if (requiredSignature !== "") {
        const exactChoices = (candidates.get(nodeA) ?? []).filter(
          (nodeB) =>
            !incomingIds.has(nodeB.node.id) &&
            incidentKeys(incoming, nodeB.node.id, incomingIds).join("\n") === requiredSignature,
        );
        const isOnlyExactClaimant =
          exactChoices.length === 1 &&
          existing.nodes.filter(
            (other) =>
              !existingIds.has(other.node.id) &&
              mappedIncidentKeys(existing, other.node.id, bIdByAId).join("\n") === requiredSignature &&
              (candidates.get(other) ?? []).some((candidate) => candidate.node.id === exactChoices[0]!.node.id),
          ).length === 1;

        if (isOnlyExactClaimant) {
          pairs.push({ a: nodeA, b: exactChoices[0]! });
          existingIds.add(nodeA.node.id);
          incomingIds.add(exactChoices[0]!.node.id);
          changed = true;
          break;
        }
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

      // Strong authored evidence is propagated in the shared policy's priority order. The full
      // candidate-list check prevents a temporary adjacency narrowing from manufacturing certainty.
      let strongCandidate: ComparableNode | undefined;
      for (const evidenceKey of STRONG_CORRESPONDENCE_EVIDENCE_KEYS) {
        if (
          evidenceKey === "n" &&
          strongCorrespondenceEvidenceValue(nodeA, "propertyLabel") !== undefined
        ) continue;
        const value = strongCorrespondenceEvidenceValue(nodeA, evidenceKey);
        if (value === undefined) continue;
        const evidenceChoices = choices.filter(
          (nodeB) => strongCorrespondenceEvidenceValue(nodeB, evidenceKey) === value,
        );
        const unusedEvidenceCandidates = (candidates.get(nodeA) ?? []).filter(
          (nodeB) => !incomingIds.has(nodeB.node.id) && strongCorrespondenceEvidenceValue(nodeB, evidenceKey) === value,
        );
        const isOnlyEvidenceClaimant =
          evidenceChoices.length === 1 &&
          unusedEvidenceCandidates.length === 1 &&
          existing.nodes.filter((other) =>
            !existingIds.has(other.node.id) &&
            strongCorrespondenceEvidenceValue(other, evidenceKey) === value &&
            (candidates.get(other) ?? []).some((candidate) => candidate.node.id === evidenceChoices[0]!.node.id),
          ).length === 1;
        if (isOnlyEvidenceClaimant) {
          strongCandidate = evidenceChoices[0]!;
          break;
        }
      }
      if (strongCandidate) {
        pairs.push({ a: nodeA, b: strongCandidate });
        existingIds.add(nodeA.node.id);
        incomingIds.add(strongCandidate.node.id);
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

/**
 * Score tuple compared lexicographically, most significant first:
 *  1. total matched pairs (more correspondence coverage always wins);
 *  2. preserved incident links (wiring topology is the strongest disambiguator once counts tie);
 *  3. matching function expressions (authored behavior and the strongest property evidence);
 *  4. matching `n` display-label attributes;
 *  5. matching ordinary property/literal-input values, counted per key. A mismatch never excludes
 *     a candidate; strong and correspondence-derived keys are excluded by the shared policy.
 */
type CorrespondenceScore = [number, number, number, number, number];

function compareScore(left: CorrespondenceScore, right: CorrespondenceScore): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3] - right[3] || left[4] - right[4];
}

function countExpressionMatches(pairs: MatchedNodePair[]): number {
  return countStrongEvidenceMatches(pairs, "expression");
}

/** Count pairs whose `n` (display-label) attribute is present on both sides and equal. */
function countNameMatches(pairs: MatchedNodePair[]): number {
  return pairs.filter((pair) => {
    const value = displayNameEvidenceValue(pair.a);
    return value !== undefined && value === displayNameEvidenceValue(pair.b);
  }).length;
}

function countStrongEvidenceMatches(
  pairs: MatchedNodePair[],
  key: (typeof STRONG_CORRESPONDENCE_EVIDENCE_KEYS)[number],
): number {
  return pairs.filter((pair) => {
    const value = strongCorrespondenceEvidenceValue(pair.a, key);
    return value !== undefined && value === strongCorrespondenceEvidenceValue(pair.b, key);
  }).length;
}

function countPropertyKeyMatches(pairs: MatchedNodePair[]): number {
  return pairs.reduce((count, pair) => {
    const attributeKeys = new Set([...ordinaryAttributeEvidenceKeys(pair.a), ...ordinaryAttributeEvidenceKeys(pair.b)]);
    const literalKeys = new Set([...Object.keys(pair.a.literalInputs), ...Object.keys(pair.b.literalInputs)]);
    return count +
      [...attributeKeys].filter((key) => attributesEqual(pair.a.attributes[key], pair.b.attributes[key])).length +
      [...literalKeys].filter((key) => attributesEqual(pair.a.literalInputs[key], pair.b.literalInputs[key])).length;
  }, 0);
}

function attributesEqual(left: IrScalarValue | undefined, right: IrScalarValue | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
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
