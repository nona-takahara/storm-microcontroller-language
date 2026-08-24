import { comparableNodeKind } from "./fingerprint.js";
import {
  displayNameEvidenceValue,
  ordinaryAttributeEvidenceKeys,
  strongCorrespondenceEvidenceValue,
} from "./correspondence-evidence.js";
import { type ComparableModuleGraph, type ComparableNode, type MatchedNodePair } from "./types.js";

export interface ExactCorrespondenceResult {
  pairs: MatchedNodePair[];
  certainPairs: MatchedNodePair[];
  ambiguousExisting: ComparableNode[];
  ambiguousIncoming: ComparableNode[];
  ambiguityGroups: Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }>;
  alternativeCount: number;
  searchSteps: number;
}

interface Component {
  nodes: ComparableNode[];
  nodeIds: Set<string>;
  signature: string;
}

interface ComponentMatch {
  pairs: MatchedNodePair[];
  certainPairs: MatchedNodePair[];
  score: MatchScore;
  alternativeCount: number;
  searchSteps: number;
  ambiguityGroups: Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }>;
}

interface Assignment {
  columns: number[];
  cost: number;
}

interface GraphLinkIndex {
  incidentByNodeId: Map<string, ComparableModuleGraph["links"]>;
  relationKeysByNodePair: Map<string, string[]>;
}

type MatchScore = readonly [expressionMatches: number, nameMatches: number, propertyMatches: number];

// Comparable graphs are immutable snapshots for the lifetime of a comparison. Reusing this index
// avoids turning every candidate check into another full scan of the graph's links.
const graphLinkIndexes = new WeakMap<ComparableModuleGraph, GraphLinkIndex>();

/**
 * Find a property-preferred, endpoint/port-preserving isomorphism without using instance ids as
 * identity. Disconnected interchangeable components are assigned with a polynomial-time bipartite
 * assignment; wiring inside each component is always checked by an isomorphism search.
 *
 * This intentionally answers a lower-level question than either compare or sync. Compare needs one
 * complete isomorphism. Sync additionally decides whether alternatives project the same edits.
 */
export function findExactNodeCorrespondence(
  existing: ComparableModuleGraph,
  incoming: ComparableModuleGraph,
): ExactCorrespondenceResult | undefined {
  if (existing.nodes.length !== incoming.nodes.length || existing.links.length !== incoming.links.length) {
    return undefined;
  }

  const componentsA = connectedComponents(existing);
  const componentsB = connectedComponents(incoming);
  const signatures = [...new Set(componentsA.map((component) => component.signature))].sort();
  if (
    signatures.length !== new Set(componentsB.map((component) => component.signature)).size ||
    signatures.some(
      (signature) =>
        componentsA.filter((component) => component.signature === signature).length !==
        componentsB.filter((component) => component.signature === signature).length,
    )
  ) {
    return undefined;
  }

  const pairs: MatchedNodePair[] = [];
  const certainPairs: MatchedNodePair[] = [];
  const ambiguousExistingIds = new Set<string>();
  const ambiguousIncomingIds = new Set<string>();
  const ambiguityGroups: ExactCorrespondenceResult["ambiguityGroups"] = [];
  let alternativeCount = 1;
  let searchSteps = 0;

  for (const signature of signatures) {
    const groupA = componentsA.filter((component) => component.signature === signature);
    const groupB = componentsB.filter((component) => component.signature === signature);
    const matches = groupA.map((componentA) =>
      groupB.map((componentB) => matchComponents(existing, incoming, componentA, componentB)),
    );
    if (matches.some((row) => row.every((match) => match === undefined))) return undefined;

    const maxPropertyMatches = groupA.reduce(
      (sum, component) => sum + component.nodes.reduce(
        (count, node) => count + propertyKeys(node).length,
        0,
      ),
      0,
    );
    const propertyBase = maxPropertyMatches + 1;
    const nameBase = groupA.reduce((count, component) => count + component.nodes.length, 0) + 1;
    const costs = matches.map((row) => row.map((match) =>
      match ? -((match.score[0] * nameBase + match.score[1]) * propertyBase + match.score[2]) : Number.POSITIVE_INFINITY,
    ));
    const assignment = solveAssignment(costs);
    if (!assignment) return undefined;

    const assignmentGroups = optimalAssignmentGroups(costs, assignment.cost);
    const ambiguousRows = new Set(assignmentGroups.flatMap((group) => group.rows));
    for (const group of assignmentGroups) {
      const existingNodes = group.rows.flatMap((row) => groupA[row]!.nodes);
      const incomingNodes = group.columns.flatMap((column) => groupB[column]!.nodes);
      ambiguityGroups.push({ existing: existingNodes, incoming: incomingNodes });
      for (const node of existingNodes) ambiguousExistingIds.add(node.node.id);
      for (const node of incomingNodes) ambiguousIncomingIds.add(node.node.id);
    }
    for (let row = 0; row < assignment.columns.length; row += 1) {
      const column = assignment.columns[row]!;
      const match = matches[row]![column]!;
      pairs.push(...match.pairs);
      searchSteps += match.searchSteps;
      alternativeCount = cappedMultiply(alternativeCount, match.alternativeCount);

      if (!ambiguousRows.has(row)) {
        certainPairs.push(...match.certainPairs);
        for (const group of match.ambiguityGroups) {
          ambiguityGroups.push(group);
          for (const node of group.existing) ambiguousExistingIds.add(node.node.id);
          for (const node of group.incoming) ambiguousIncomingIds.add(node.node.id);
        }
      }
    }
    if (ambiguousRows.size > 0) alternativeCount = Math.max(2, alternativeCount);
  }

  pairs.sort(comparePairs);
  certainPairs.sort(comparePairs);
  return {
    pairs,
    certainPairs,
    ambiguousExisting: existing.nodes.filter((node) => ambiguousExistingIds.has(node.node.id)),
    ambiguousIncoming: incoming.nodes.filter((node) => ambiguousIncomingIds.has(node.node.id)),
    ambiguityGroups,
    alternativeCount,
    searchSteps,
  };
}

/** Incident edges to already-paired neighbors, mapped into the other graph's ids. */
export function mappedIncidentKeys(
  graph: ComparableModuleGraph,
  nodeId: string,
  mappedNeighborIds: Map<string, string>,
): string[] {
  return incidentLinks(graph, nodeId).flatMap((link) => {
    if (link.from.nodeId === nodeId && mappedNeighborIds.has(link.to.nodeId)) {
      return [`out:${link.from.portKey}:${mappedNeighborIds.get(link.to.nodeId)}:${link.to.portKey}`];
    }
    if (link.to.nodeId === nodeId && mappedNeighborIds.has(link.from.nodeId)) {
      return [`in:${link.to.portKey}:${mappedNeighborIds.get(link.from.nodeId)}:${link.from.portKey}`];
    }
    return [];
  }).sort();
}

/** Incident edges restricted to a known node-id set. */
export function incidentKeys(
  graph: ComparableModuleGraph,
  nodeId: string,
  includedNodeIds: Set<string>,
): string[] {
  return incidentLinks(graph, nodeId).flatMap((link) => {
    if (link.from.nodeId === nodeId && includedNodeIds.has(link.to.nodeId)) {
      return [`out:${link.from.portKey}:${link.to.nodeId}:${link.to.portKey}`];
    }
    if (link.to.nodeId === nodeId && includedNodeIds.has(link.from.nodeId)) {
      return [`in:${link.to.portKey}:${link.from.nodeId}:${link.from.portKey}`];
    }
    return [];
  }).sort();
}

function connectedComponents(graph: ComparableModuleGraph): Component[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.node.id, node] as const));
  const neighbors = new Map(graph.nodes.map((node) => [node.node.id, new Set<string>()] as const));
  for (const link of graph.links) {
    neighbors.get(link.from.nodeId)?.add(link.to.nodeId);
    neighbors.get(link.to.nodeId)?.add(link.from.nodeId);
  }
  const unseen = new Set(nodeById.keys());
  const result: Component[] = [];
  while (unseen.size > 0) {
    const first = [...unseen].sort()[0]!;
    const queue = [first];
    const nodeIds = new Set<string>();
    unseen.delete(first);
    while (queue.length > 0) {
      const id = queue.shift()!;
      nodeIds.add(id);
      for (const neighbor of neighbors.get(id) ?? []) {
        if (unseen.delete(neighbor)) queue.push(neighbor);
      }
    }
    const nodes = [...nodeIds].map((id) => nodeById.get(id)!).sort(compareNodes);
    result.push({ nodes, nodeIds, signature: componentSignature(graph, nodes, nodeIds) });
  }
  return result.sort((left, right) => left.signature.localeCompare(right.signature) || compareNodes(left.nodes[0]!, right.nodes[0]!));
}

function componentSignature(graph: ComparableModuleGraph, nodes: ComparableNode[], ids: Set<string>): string {
  const kinds = nodes.map(comparableNodeKind).sort();
  const nodeById = new Map(nodes.map((node) => [node.node.id, node] as const));
  const edges = graph.links.filter((link) => ids.has(link.from.nodeId) && ids.has(link.to.nodeId)).map((link) =>
    `${comparableNodeKind(nodeById.get(link.from.nodeId)!)}:${link.from.portKey}->${comparableNodeKind(nodeById.get(link.to.nodeId)!)}:${link.to.portKey}`,
  ).sort();
  return JSON.stringify([kinds, edges]);
}

function matchComponents(
  graphA: ComparableModuleGraph,
  graphB: ComparableModuleGraph,
  componentA: Component,
  componentB: Component,
): ComponentMatch | undefined {
  if (componentA.nodes.length !== componentB.nodes.length) return undefined;
  if (componentA.nodes.length === 1) {
    const a = componentA.nodes[0]!;
    const b = componentB.nodes[0]!;
    if (comparableNodeKind(a) !== comparableNodeKind(b)) return undefined;
    return { pairs: [{ a, b }], certainPairs: [{ a, b }], score: pairScore(a, b), alternativeCount: 1, searchSteps: 1, ambiguityGroups: [] };
  }
  if (isFullyInterchangeableComponent(graphA, componentA) && isFullyInterchangeableComponent(graphB, componentB)) {
    return matchInterchangeableNodes(componentA.nodes, componentB.nodes);
  }
  // High-degree stars are cheaper in the structural-twin path below; bounded-degree trees need the
  // rooted-subtree DP to avoid recursively enumerating isomorphic branch swaps.
  if (
    isUndirectedTree(graphA, componentA) && isUndirectedTree(graphB, componentB) &&
    maximumUndirectedDegree(graphA, componentA) <= 3 && maximumUndirectedDegree(graphB, componentB) <= 3
  ) {
    return matchTreeComponents(graphA, graphB, componentA, componentB);
  }

  const pairs: MatchedNodePair[] = [];
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  let bestScore: MatchScore | undefined;
  let bestPairs: MatchedNodePair[] | undefined;
  let certainPairs: MatchedNodePair[] = [];
  let optimalCandidatesByExistingId = new Map<string, Set<string>>();
  let alternativeCount = 0;
  let searchSteps = 0;
  const activeAmbiguityGroups: ComponentMatch["ambiguityGroups"] = [];
  const activeAlternativeCounts: number[] = [];

  const visit = (): void => {
    if (pairs.length === componentA.nodes.length) {
      if (!preservesComponentLinks(graphA, graphB, pairs, componentA.nodeIds, componentB.nodeIds)) return;
      const score = sumScore(pairs.map((pair) => pairScore(pair.a, pair.b)));
      const comparison = bestScore ? compareScore(score, bestScore) : 1;
      if (comparison > 0) {
        bestScore = score;
        bestPairs = [...pairs];
        certainPairs = [...pairs];
        optimalCandidatesByExistingId = candidateSetsFromPairs(pairs);
        addAmbiguityGroupsToCandidateSets(optimalCandidatesByExistingId, activeAmbiguityGroups);
        alternativeCount = activeAlternativeCounts.reduce(cappedMultiply, 1);
      } else if (comparison === 0) {
        certainPairs = certainPairs.filter((pair) => pairs.some((candidate) => samePair(pair, candidate)));
        addPairsToCandidateSets(optimalCandidatesByExistingId, pairs);
        addAmbiguityGroupsToCandidateSets(optimalCandidatesByExistingId, activeAmbiguityGroups);
        alternativeCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          alternativeCount + activeAlternativeCounts.reduce(cappedMultiply, 1),
        );
      }
      return;
    }

    const mapped = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
    const next = componentA.nodes.filter((node) => !usedA.has(node.node.id)).map((nodeA) => ({
      nodeA,
      choices: componentB.nodes.filter((nodeB) =>
        !usedB.has(nodeB.node.id) &&
        comparableNodeKind(nodeA) === comparableNodeKind(nodeB) &&
        mappedIncidentKeys(graphA, nodeA.node.id, mapped).join("\n") ===
          incidentKeys(graphB, nodeB.node.id, usedB).join("\n"),
      ),
    })).sort((left, right) => left.choices.length - right.choices.length || compareNodes(left.nodeA, right.nodeA))[0];
    if (!next) return;
    const twinGroupA = componentA.nodes.filter((node) =>
      !usedA.has(node.node.id) && areStructuralTwins(graphA, next.nodeA, node, componentA.nodes),
    );
    if (
      twinGroupA.length > 1 &&
      next.choices.length === twinGroupA.length &&
      next.choices.every((node) => areStructuralTwins(graphB, next.choices[0]!, node, componentB.nodes))
    ) {
      const assignment = matchInterchangeableNodes(twinGroupA, next.choices);
      if (!assignment) return;
      pairs.push(...assignment.pairs);
      for (const pair of assignment.pairs) {
        usedA.add(pair.a.node.id);
        usedB.add(pair.b.node.id);
      }
      activeAmbiguityGroups.push(...assignment.ambiguityGroups);
      activeAlternativeCounts.push(assignment.alternativeCount);
      searchSteps += twinGroupA.length;
      visit();
      activeAlternativeCounts.pop();
      activeAmbiguityGroups.splice(activeAmbiguityGroups.length - assignment.ambiguityGroups.length, assignment.ambiguityGroups.length);
      for (const pair of assignment.pairs) {
        usedA.delete(pair.a.node.id);
        usedB.delete(pair.b.node.id);
      }
      pairs.splice(pairs.length - assignment.pairs.length, assignment.pairs.length);
      return;
    }
    for (const nodeB of next.choices.sort(compareNodes)) {
      searchSteps += 1;
      pairs.push({ a: next.nodeA, b: nodeB });
      usedA.add(next.nodeA.node.id);
      usedB.add(nodeB.node.id);
      visit();
      usedA.delete(next.nodeA.node.id);
      usedB.delete(nodeB.node.id);
      pairs.pop();
    }
  };
  visit();
  const compressedCertainPairs = bestPairs?.filter((pair) =>
    optimalCandidatesByExistingId.get(pair.a.node.id)?.size === 1,
  );
  return bestPairs && bestScore
    ? {
      pairs: bestPairs,
      certainPairs: compressedCertainPairs ?? certainPairs,
      score: bestScore,
      alternativeCount,
      searchSteps,
      ambiguityGroups: ambiguityGroupsFromCandidates(componentA.nodes, componentB.nodes, optimalCandidatesByExistingId),
    }
    : undefined;
}

/**
 * Match a connected acyclic component by dynamic programming over rooted subtrees. A symmetric
 * binary tree has exponentially many whole-tree isomorphisms, but only quadratically many pairs of
 * rooted subtree states. Hungarian assignment combines interchangeable child subtrees without
 * enumerating their permutations.
 */
function matchTreeComponents(
  graphA: ComparableModuleGraph,
  graphB: ComparableModuleGraph,
  componentA: Component,
  componentB: Component,
): ComponentMatch | undefined {
  const neighborsA = treeNeighbors(graphA, componentA);
  const neighborsB = treeNeighbors(graphB, componentB);
  const centersA = treeCenters(componentA, neighborsA);
  const centersB = treeCenters(componentB, neighborsB);
  if (centersA.length !== centersB.length) return undefined;

  const nodeAById = new Map(componentA.nodes.map((node) => [node.node.id, node] as const));
  const nodeBById = new Map(componentB.nodes.map((node) => [node.node.id, node] as const));
  const propertyBase = componentA.nodes.reduce((count, node) => count + propertyKeys(node).length, 0) + 1;
  const nameBase = componentA.nodes.length + 1;
  const memo = new Map<string, ComponentMatch | undefined>();
  let searchSteps = 0;

  const rootedMatch = (aId: string, aParent: string | undefined, bId: string, bParent: string | undefined): ComponentMatch | undefined => {
    const memoKey = JSON.stringify([aId, aParent, bId, bParent]);
    if (memo.has(memoKey)) return memo.get(memoKey);
    searchSteps += 1;
    const a = nodeAById.get(aId)!;
    const b = nodeBById.get(bId)!;
    if (
      comparableNodeKind(a) !== comparableNodeKind(b) ||
      (aParent !== undefined && bParent !== undefined &&
        relationKeys(graphA, aId, aParent).join("\n") !== relationKeys(graphB, bId, bParent).join("\n"))
    ) {
      memo.set(memoKey, undefined);
      return undefined;
    }
    const childrenA = [...(neighborsA.get(aId) ?? [])].filter((id) => id !== aParent).sort();
    const childrenB = [...(neighborsB.get(bId) ?? [])].filter((id) => id !== bParent).sort();
    if (childrenA.length !== childrenB.length) {
      memo.set(memoKey, undefined);
      return undefined;
    }
    const childMatches = childrenA.map((childA) =>
      childrenB.map((childB) => rootedMatch(childA, aId, childB, bId)),
    );
    const costs = childMatches.map((row) => row.map((match) =>
      match ? -((match.score[0] * nameBase + match.score[1]) * propertyBase + match.score[2]) : Number.POSITIVE_INFINITY,
    ));
    const assignment = solveAssignment(costs);
    if (!assignment) {
      memo.set(memoKey, undefined);
      return undefined;
    }

    const pairs: MatchedNodePair[] = [{ a, b }];
    const certainPairs: MatchedNodePair[] = [{ a, b }];
    const ambiguityGroups: ComponentMatch["ambiguityGroups"] = [];
    let alternativeCount = 1;
    const assignmentGroups = optimalAssignmentGroups(costs, assignment.cost);
    const ambiguousRows = new Set(assignmentGroups.flatMap((group) => group.rows));
    for (const group of assignmentGroups) {
      ambiguityGroups.push({
        existing: group.rows.flatMap((row) => childMatches[row]![assignment.columns[row]!]!.pairs.map((pair) => pair.a)),
        incoming: group.columns.flatMap((column) => {
          const claimantRow = assignment.columns.indexOf(column);
          return childMatches[claimantRow]![column]!.pairs.map((pair) => pair.b);
        }),
      });
      alternativeCount = Math.max(2, alternativeCount);
    }
    for (let row = 0; row < childrenA.length; row += 1) {
      const child = childMatches[row]![assignment.columns[row]!]!;
      pairs.push(...child.pairs);
      alternativeCount = cappedMultiply(alternativeCount, child.alternativeCount);
      if (!ambiguousRows.has(row)) {
        certainPairs.push(...child.certainPairs);
        ambiguityGroups.push(...child.ambiguityGroups);
      }
    }
    const result: ComponentMatch = {
      pairs,
      certainPairs,
      score: sumScore(pairs.map((pair) => pairScore(pair.a, pair.b))),
      alternativeCount,
      searchSteps: 0,
      ambiguityGroups,
    };
    memo.set(memoKey, result);
    return result;
  };

  const rootCandidates = centersA.flatMap((aId) => centersB.flatMap((bId) => {
    const match = rootedMatch(aId, undefined, bId, undefined);
    return match ? [match] : [];
  }));
  if (rootCandidates.length === 0) return undefined;
  const bestScore = rootCandidates.reduce((best, candidate) => compareScore(candidate.score, best) > 0 ? candidate.score : best, rootCandidates[0]!.score);
  const optimal = rootCandidates.filter((candidate) => compareScore(candidate.score, bestScore) === 0);
  const representative = optimal[0]!;
  const candidateSets = candidateSetsFromPairs(representative.pairs);
  for (const candidate of optimal) {
    addPairsToCandidateSets(candidateSets, candidate.pairs);
    addAmbiguityGroupsToCandidateSets(candidateSets, candidate.ambiguityGroups);
  }
  const ambiguityGroups = ambiguityGroupsFromCandidates(componentA.nodes, componentB.nodes, candidateSets);
  return {
    pairs: representative.pairs,
    certainPairs: representative.pairs.filter((pair) => candidateSets.get(pair.a.node.id)?.size === 1),
    score: bestScore,
    alternativeCount: optimal.reduce((count, candidate) => Math.min(Number.MAX_SAFE_INTEGER, count + candidate.alternativeCount), 0),
    searchSteps,
    ambiguityGroups,
  };
}

function isUndirectedTree(graph: ComparableModuleGraph, component: Component): boolean {
  const undirectedEdges = new Set<string>();
  for (const link of graph.links) {
    if (!component.nodeIds.has(link.from.nodeId) || !component.nodeIds.has(link.to.nodeId)) continue;
    if (link.from.nodeId === link.to.nodeId) return false;
    undirectedEdges.add([link.from.nodeId, link.to.nodeId].sort().join("\u0000"));
  }
  return undirectedEdges.size === component.nodes.length - 1;
}

function maximumUndirectedDegree(graph: ComparableModuleGraph, component: Component): number {
  return Math.max(...[...treeNeighbors(graph, component).values()].map((neighbors) => neighbors.size));
}

function treeNeighbors(graph: ComparableModuleGraph, component: Component): Map<string, Set<string>> {
  const result = new Map(component.nodes.map((node) => [node.node.id, new Set<string>()] as const));
  for (const link of graph.links) {
    if (!component.nodeIds.has(link.from.nodeId) || !component.nodeIds.has(link.to.nodeId)) continue;
    result.get(link.from.nodeId)!.add(link.to.nodeId);
    result.get(link.to.nodeId)!.add(link.from.nodeId);
  }
  return result;
}

function treeCenters(component: Component, neighbors: Map<string, Set<string>>): string[] {
  if (component.nodes.length <= 2) return component.nodes.map((node) => node.node.id).sort();
  const degree = new Map([...neighbors].map(([id, adjacent]) => [id, adjacent.size] as const));
  let leaves = [...degree].filter(([, value]) => value <= 1).map(([id]) => id);
  let remaining = degree.size;
  while (remaining > 2) {
    remaining -= leaves.length;
    const next: string[] = [];
    for (const leaf of leaves) {
      for (const neighbor of neighbors.get(leaf) ?? []) {
        const value = degree.get(neighbor)! - 1;
        degree.set(neighbor, value);
        if (value === 1) next.push(neighbor);
      }
    }
    leaves = next;
  }
  return leaves.sort();
}

function areStructuralTwins(
  graph: ComparableModuleGraph,
  left: ComparableNode,
  right: ComparableNode,
  componentNodes: ComparableNode[],
): boolean {
  if (left.node.id === right.node.id) return true;
  if (comparableNodeKind(left) !== comparableNodeKind(right)) return false;
  if (relationKeys(graph, left.node.id, left.node.id).join("\n") !== relationKeys(graph, right.node.id, right.node.id).join("\n")) return false;
  if (relationKeys(graph, left.node.id, right.node.id).join("\n") !== relationKeys(graph, right.node.id, left.node.id).join("\n")) return false;
  return componentNodes.every((node) =>
    node.node.id === left.node.id ||
    node.node.id === right.node.id ||
    relationKeys(graph, left.node.id, node.node.id).join("\n") === relationKeys(graph, right.node.id, node.node.id).join("\n"),
  );
}

function candidateSetsFromPairs(pairs: MatchedNodePair[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  addPairsToCandidateSets(result, pairs);
  return result;
}

function addPairsToCandidateSets(candidates: Map<string, Set<string>>, pairs: MatchedNodePair[]): void {
  for (const pair of pairs) {
    const incomingIds = candidates.get(pair.a.node.id) ?? new Set<string>();
    incomingIds.add(pair.b.node.id);
    candidates.set(pair.a.node.id, incomingIds);
  }
}

function addAmbiguityGroupsToCandidateSets(
  candidates: Map<string, Set<string>>,
  groups: Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }>,
): void {
  for (const group of groups) {
    for (const existing of group.existing) {
      const incomingIds = candidates.get(existing.node.id) ?? new Set<string>();
      for (const incoming of group.incoming) incomingIds.add(incoming.node.id);
      candidates.set(existing.node.id, incomingIds);
    }
  }
}

function ambiguityGroupsFromCandidates(
  existing: ComparableNode[],
  incoming: ComparableNode[],
  candidates: Map<string, Set<string>>,
): Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }> {
  const existingById = new Map(existing.map((node) => [node.node.id, node] as const));
  const incomingById = new Map(incoming.map((node) => [node.node.id, node] as const));
  const existingIdsByIncomingId = new Map<string, Set<string>>();
  for (const [existingId, incomingIds] of candidates) {
    for (const incomingId of incomingIds) {
      const existingIds = existingIdsByIncomingId.get(incomingId) ?? new Set<string>();
      existingIds.add(existingId);
      existingIdsByIncomingId.set(incomingId, existingIds);
    }
  }
  const unseenExistingIds = new Set(existingById.keys());
  const result: Array<{ existing: ComparableNode[]; incoming: ComparableNode[] }> = [];
  while (unseenExistingIds.size > 0) {
    const first = [...unseenExistingIds][0]!;
    const existingIds = new Set<string>();
    const incomingIds = new Set<string>();
    const pending = [first];
    unseenExistingIds.delete(first);
    while (pending.length > 0) {
      const existingId = pending.shift()!;
      existingIds.add(existingId);
      for (const incomingId of candidates.get(existingId) ?? []) {
        if (incomingIds.has(incomingId)) continue;
        incomingIds.add(incomingId);
        for (const linkedExistingId of existingIdsByIncomingId.get(incomingId) ?? []) {
          if (unseenExistingIds.delete(linkedExistingId)) pending.push(linkedExistingId);
        }
      }
    }
    if (existingIds.size > 1 || incomingIds.size > 1) {
      result.push({
        existing: [...existingIds].map((id) => existingById.get(id)!).sort(compareNodes),
        incoming: [...incomingIds].map((id) => incomingById.get(id)!).sort(compareNodes),
      });
    }
  }
  return result;
}

function matchInterchangeableNodes(nodesA: ComparableNode[], nodesB: ComparableNode[]): ComponentMatch | undefined {
  const maxProperties = nodesA.reduce((count, node) => count + propertyKeys(node).length, 0);
  const propertyBase = maxProperties + 1;
  const nameBase = nodesA.length + 1;
  const scores = nodesA.map((nodeA) => nodesB.map((nodeB) => pairScore(nodeA, nodeB)));
  const costs = scores.map((row) => row.map((score) => -((score[0] * nameBase + score[1]) * propertyBase + score[2])));
  const assignment = solveAssignment(costs);
  if (!assignment) return undefined;
  const pairs = assignment.columns.map((column, row) => ({ a: nodesA[row]!, b: nodesB[column]! }));
  const groups = optimalAssignmentGroups(costs, assignment.cost);
  const ambiguousRows = new Set(groups.flatMap((group) => group.rows));
  const certainPairs = pairs.filter((_, row) => !ambiguousRows.has(row));
  return {
    pairs,
    certainPairs,
    score: sumScore(pairs.map((pair) => pairScore(pair.a, pair.b))),
    alternativeCount: ambiguousRows.size > 0 ? 2 : 1,
    searchSteps: nodesA.length,
    ambiguityGroups: groups.map((group) => ({
      existing: group.rows.map((row) => nodesA[row]!),
      incoming: group.columns.map((column) => nodesB[column]!),
    })),
  };
}

function isFullyInterchangeableComponent(graph: ComparableModuleGraph, component: Component): boolean {
  const kinds = new Set(component.nodes.map(comparableNodeKind));
  if (kinds.size !== 1) return false;
  const profiles = component.nodes.map((node) => component.nodes.map((other) =>
    relationKeys(graph, node.node.id, other.node.id).join("\n"),
  ));
  const selfProfile = profiles[0]?.[0];
  const otherProfile = profiles[0]?.[1];
  return profiles.every((row, rowIndex) => row.every((profile, columnIndex) =>
    rowIndex === columnIndex ? profile === selfProfile : profile === otherProfile,
  ));
}

function relationKeys(graph: ComparableModuleGraph, fromId: string, toId: string): string[] {
  return graphLinkIndex(graph).relationKeysByNodePair.get(nodePairKey(fromId, toId)) ?? [];
}

function incidentLinks(graph: ComparableModuleGraph, nodeId: string): ComparableModuleGraph["links"] {
  return graphLinkIndex(graph).incidentByNodeId.get(nodeId) ?? [];
}

function graphLinkIndex(graph: ComparableModuleGraph): GraphLinkIndex {
  const cached = graphLinkIndexes.get(graph);
  if (cached) return cached;

  const incidentByNodeId = new Map<string, ComparableModuleGraph["links"]>();
  const relationKeysByNodePair = new Map<string, string[]>();
  for (const link of graph.links) {
    appendMapValue(incidentByNodeId, link.from.nodeId, link);
    if (link.to.nodeId !== link.from.nodeId) appendMapValue(incidentByNodeId, link.to.nodeId, link);

    appendMapValue(
      relationKeysByNodePair,
      nodePairKey(link.from.nodeId, link.to.nodeId),
      `out:${link.from.portKey}:${link.to.portKey}`,
    );
    if (link.to.nodeId !== link.from.nodeId) {
      appendMapValue(
        relationKeysByNodePair,
        nodePairKey(link.to.nodeId, link.from.nodeId),
        `in:${link.to.portKey}:${link.from.portKey}`,
      );
    }
  }
  for (const keys of relationKeysByNodePair.values()) keys.sort();

  const result = { incidentByNodeId, relationKeysByNodePair };
  graphLinkIndexes.set(graph, result);
  return result;
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function nodePairKey(fromId: string, toId: string): string {
  return `${fromId}\u0000${toId}`;
}

function preservesComponentLinks(
  graphA: ComparableModuleGraph,
  graphB: ComparableModuleGraph,
  pairs: MatchedNodePair[],
  idsA: Set<string>,
  idsB: Set<string>,
): boolean {
  const map = new Map(pairs.map((pair) => [pair.a.node.id, pair.b.node.id] as const));
  const linksB = graphB.links.filter((link) => idsB.has(link.from.nodeId) && idsB.has(link.to.nodeId)).map(linkKey).sort();
  const mappedA = graphA.links.filter((link) => idsA.has(link.from.nodeId) && idsA.has(link.to.nodeId)).map((link) =>
    JSON.stringify([map.get(link.from.nodeId), link.from.portKey, map.get(link.to.nodeId), link.to.portKey]),
  ).sort();
  return JSON.stringify(mappedA) === JSON.stringify(linksB);
}

function linkKey(link: ComparableModuleGraph["links"][number]): string {
  return JSON.stringify([link.from.nodeId, link.from.portKey, link.to.nodeId, link.to.portKey]);
}

function pairScore(a: ComparableNode, b: ComparableNode): MatchScore {
  const expression = strongCorrespondenceEvidenceValue(a, "expression");
  const expressionMatches = expression !== undefined && expression === strongCorrespondenceEvidenceValue(b, "expression") ? 1 : 0;
  const displayName = displayNameEvidenceValue(a);
  const nameMatches = displayName !== undefined && displayName === displayNameEvidenceValue(b) ? 1 : 0;
  const keys = new Set([...propertyKeys(a), ...propertyKeys(b)]);
  let propertyMatches = 0;
  for (const key of keys) {
    const source = key[0] as "a" | "i";
    const property = key.slice(2);
    const left = source === "a" ? a.attributes[property] : a.literalInputs[property];
    const right = source === "a" ? b.attributes[property] : b.literalInputs[property];
    if (left !== undefined && left === right) propertyMatches += 1;
  }
  return [expressionMatches, nameMatches, propertyMatches];
}

function propertyKeys(node: ComparableNode): string[] {
  return [
    ...ordinaryAttributeEvidenceKeys(node).map((key) => `a:${key}`),
    ...Object.keys(node.literalInputs).map((key) => `i:${key}`),
  ];
}

function sumScore(scores: MatchScore[]): MatchScore {
  return scores.reduce<MatchScore>(
    (sum, score) => [sum[0] + score[0], sum[1] + score[1], sum[2] + score[2]],
    [0, 0, 0],
  );
}

function compareScore(left: MatchScore, right: MatchScore): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Hungarian algorithm for a square finite/infinite cost matrix. */
function solveAssignment(costs: number[][]): Assignment | undefined {
  const size = costs.length;
  if (size === 0) return { columns: [], cost: 0 };
  const finite = costs.flat().filter(Number.isFinite);
  if (finite.length === 0) return undefined;
  const unreachable = Math.max(...finite.map(Math.abs), 1) * (size + 1) * 4;
  const matrix = costs.map((row) => row.map((cost) => Number.isFinite(cost) ? cost : unreachable));
  const u = Array(size + 1).fill(0) as number[];
  const v = Array(size + 1).fill(0) as number[];
  const p = Array(size + 1).fill(0) as number[];
  const way = Array(size + 1).fill(0) as number[];
  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(size + 1).fill(Number.POSITIVE_INFINITY) as number[];
    const used = Array(size + 1).fill(false) as boolean[];
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue;
        const current = matrix[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (current < minv[j]!) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const columns = Array(size).fill(-1) as number[];
  for (let j = 1; j <= size; j += 1) columns[p[j]! - 1] = j - 1;
  if (columns.some((column, row) => !Number.isFinite(costs[row]![column]!))) return undefined;
  return { columns, cost: columns.reduce((sum, column, row) => sum + costs[row]![column]!, 0) };
}

function optimalAssignmentGroups(
  costs: number[][],
  optimalCost: number,
): Array<{ rows: number[]; columns: number[] }> {
  const optimalColumnsByRow = costs.map((row, rowIndex) => row.flatMap((_, columnIndex) =>
    isEdgeInOptimalAssignment(costs, optimalCost, rowIndex, columnIndex) ? [columnIndex] : [],
  ));
  const rowsByColumn = costs.map((_, columnIndex) => optimalColumnsByRow.flatMap((columns, rowIndex) =>
    columns.includes(columnIndex) ? [rowIndex] : [],
  ));
  const unseenRows = new Set(costs.map((_, index) => index));
  const groups: Array<{ rows: number[]; columns: number[] }> = [];

  while (unseenRows.size > 0) {
    const first = [...unseenRows][0]!;
    const rows = new Set<number>();
    const columns = new Set<number>();
    const pendingRows = [first];
    unseenRows.delete(first);
    while (pendingRows.length > 0) {
      const row = pendingRows.shift()!;
      rows.add(row);
      for (const column of optimalColumnsByRow[row] ?? []) {
        if (columns.has(column)) continue;
        columns.add(column);
        for (const linkedRow of rowsByColumn[column] ?? []) {
          if (unseenRows.delete(linkedRow)) pendingRows.push(linkedRow);
        }
      }
    }
    if (rows.size > 1 || columns.size > 1) {
      groups.push({ rows: [...rows].sort((a, b) => a - b), columns: [...columns].sort((a, b) => a - b) });
    }
  }
  return groups;
}

function isEdgeInOptimalAssignment(costs: number[][], optimalCost: number, row: number, column: number): boolean {
  if (!Number.isFinite(costs[row]?.[column])) return false;
  if (costs.length === 1) return costs[row]![column] === optimalCost;
  const reduced = costs.filter((_, candidateRow) => candidateRow !== row).map((values) =>
    values.filter((_, candidateColumn) => candidateColumn !== column),
  );
  const remainder = solveAssignment(reduced);
  return remainder !== undefined && costs[row]![column]! + remainder.cost === optimalCost;
}

function samePair(left: MatchedNodePair, right: MatchedNodePair): boolean {
  return left.a.node.id === right.a.node.id && left.b.node.id === right.b.node.id;
}

function comparePairs(left: MatchedNodePair, right: MatchedNodePair): number {
  return compareNodes(left.a, right.a) || compareNodes(left.b, right.b);
}

function compareNodes(left: ComparableNode, right: ComparableNode): number {
  return left.node.id.localeCompare(right.node.id);
}

function cappedMultiply(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left * right);
}
