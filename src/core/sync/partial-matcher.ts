import { comparableNodeKind } from "../compare/fingerprint.js";
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
}

const DEFAULT_PARTIAL_SEARCH_STEPS = 20_000;

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
  let bestScore: CorrespondenceScore = [-1, -1, -1, -1];
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
        countNameMatches(current),
        countPropertyMatches(current),
      ];
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
      const requiredSignature = mappedIncidentSignature(existing.links, nodeA.node.id, bIdByAId);
      if (requiredSignature !== "") {
        const exactChoices = (candidates.get(nodeA) ?? []).filter(
          (nodeB) =>
            !incomingIds.has(nodeB.node.id) &&
            incidentSignatureAmongForced(incoming.links, nodeB.node.id, incomingIds) === requiredSignature,
        );
        const isOnlyExactClaimant =
          exactChoices.length === 1 &&
          existing.nodes.filter(
            (other) =>
              !existingIds.has(other.node.id) &&
              mappedIncidentSignature(existing.links, other.node.id, bIdByAId) === requiredSignature &&
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

      // A cheap, linear-time counterpart to the structural-only rule above: when this node's `n`
      // display label picks out exactly one of its remaining structurally-valid candidates, and no
      // other remaining node sharing that same label could also validly claim that candidate, the
      // label alone is decisive. Without this, a cluster of same-kind nodes disambiguated only by
      // distinct labels (issue #71's actual shape) falls entirely to the exponential backtracking
      // search below and can exhaust its step budget well before a realistic cluster size.
      const label = nameLabel(nodeA);
      if (label !== undefined) {
        const labelChoices = choices.filter((nodeB) => nameLabel(nodeB) === label);
        // `choices` is already narrowed by adjacency compatibility against pairs forced so far, and
        // that narrowing is deliberately lenient (a missing edge on either side does not disqualify a
        // candidate, see `hasCompatibleCertainAdjacency`). So a single label match in `choices` alone
        // is not proof of uniqueness -- it could just be that adjacency happened to rule the other
        // same-label incoming node out at this point in the fixed-point loop. Require the label to
        // also pick out exactly one candidate in nodeA's full (adjacency-unfiltered) candidate list.
        const unusedLabelCandidates = (candidates.get(nodeA) ?? []).filter(
          (nodeB) => !incomingIds.has(nodeB.node.id) && nameLabel(nodeB) === label,
        );
        const isOnlyLabelClaimant =
          labelChoices.length === 1 &&
          unusedLabelCandidates.length === 1 &&
          existing.nodes.filter(
            (other) =>
              !existingIds.has(other.node.id) &&
              nameLabel(other) === label &&
              (candidates.get(other) ?? []).some((candidate) => candidate.node.id === labelChoices[0]!.node.id),
          ).length === 1;

        if (isOnlyLabelClaimant) {
          pairs.push({ a: nodeA, b: labelChoices[0]! });
          existingIds.add(nodeA.node.id);
          incomingIds.add(labelChoices[0]!.node.id);
          changed = true;
          break;
        }
      }
    }
  }

  return { pairs, existingIds };
}

/** The Stormworks in-game custom display name, when the DSL/XML source set a non-empty one. */
function nameLabel(node: ComparableNode): string | undefined {
  const value = node.attributes.n;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `nodeId`'s links to nodes already forced (per `existingToIncoming`), rewritten in terms of their
 * incoming-side ids so the result is directly comparable to `incidentSignatureAmongForced` on the
 * incoming graph. Links to not-yet-forced neighbors are excluded, not treated as mismatches.
 */
function mappedIncidentSignature(
  links: ComparableModuleGraph["links"],
  nodeId: string,
  existingToIncoming: Map<string, string>,
): string {
  return links
    .flatMap((link) => {
      if (link.from.nodeId === nodeId && existingToIncoming.has(link.to.nodeId)) {
        return [`out:${link.from.portKey}:${existingToIncoming.get(link.to.nodeId)}:${link.to.portKey}`];
      }
      if (link.to.nodeId === nodeId && existingToIncoming.has(link.from.nodeId)) {
        return [`in:${link.to.portKey}:${existingToIncoming.get(link.from.nodeId)}:${link.from.portKey}`];
      }
      return [];
    })
    .sort()
    .join("\n");
}

/** `nodeId`'s links restricted to neighbors in `forcedIds`, in the same format as `mappedIncidentSignature`. */
function incidentSignatureAmongForced(
  links: ComparableModuleGraph["links"],
  nodeId: string,
  forcedIds: Set<string>,
): string {
  return links
    .flatMap((link) => {
      if (link.from.nodeId === nodeId && forcedIds.has(link.to.nodeId)) {
        return [`out:${link.from.portKey}:${link.to.nodeId}:${link.to.portKey}`];
      }
      if (link.to.nodeId === nodeId && forcedIds.has(link.from.nodeId)) {
        return [`in:${link.to.portKey}:${link.from.nodeId}:${link.from.portKey}`];
      }
      return [];
    })
    .sort()
    .join("\n");
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
 *  3. matching `n` display-label attributes (a strong but weaker-than-wiring identity signal);
 *  4. matching non-`n` property values, one point per pair at most (a strong signal too, but a
 *     mismatch here never subtracts — it is deliberately not a veto, only the absence of a bonus).
 */
type CorrespondenceScore = [number, number, number, number];

function compareScore(left: CorrespondenceScore, right: CorrespondenceScore): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3] - right[3];
}

/** Count pairs whose `n` (display-label) attribute is present on both sides and equal. */
function countNameMatches(pairs: MatchedNodePair[]): number {
  return pairs.filter((pair) => attributesEqual(pair.a.attributes.n, pair.b.attributes.n)).length;
}

/**
 * Count pairs whose non-`n` attributes are fully equal, capped at one point per pair so a
 * property-rich node cannot outweigh several sparser ones in the same search branch.
 */
function countPropertyMatches(pairs: MatchedNodePair[]): number {
  return pairs.filter((pair) => {
    const keys = new Set([...Object.keys(pair.a.attributes), ...Object.keys(pair.b.attributes)].filter((key) => key !== "n"));
    return keys.size > 0 && [...keys].every((key) => attributesEqual(pair.a.attributes[key], pair.b.attributes[key]));
  }).length;
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
