import { type IrLink, type IrScalarValue } from "../ir.js";
import {
  type ComparableNode,
  type NetworkComparisonResult,
  type NetworkDifference,
  type ProjectComparisonResult,
} from "./types.js";

/** Format a comparison result for human-facing CLI and MCP text output. */
export function formatNetworkComparison(result: NetworkComparisonResult): string {
  const lines = [
    `Network comparison: ${result.verdict}`,
    `Matched nodes: ${result.matchedPairs.length}`,
  ];

  if (result.reason) {
    lines.push(`Reason: ${result.reason}`);
  }

  if (result.differences.length === 0) {
    lines.push("Differences: none");
  } else {
    lines.push(`Differences (${result.differences.length}):`);
    lines.push(...result.differences.map((difference) => `- ${formatDifference(difference)}`));
  }

  return lines.join("\n");
}

/** Format a project result, including module-level groupings when available. */
export function formatProjectComparison(result: ProjectComparisonResult): string {
  const lines = [formatNetworkComparison(result)];

  if (result.moduleResults.length > 0) {
    lines.push("", `Module comparisons (${result.moduleResults.length}):`);
    for (const entry of result.moduleResults) {
      lines.push(
        `- ${entry.moduleKeyA} ↔ ${entry.moduleKeyB}: ${entry.result.verdict} ` +
          `(${entry.result.matchedPairs.length} matched, ${entry.result.differences.length} differences)`,
      );
      if (entry.result.reason) {
        lines.push(`  Reason: ${entry.result.reason}`);
      }
      lines.push(
        ...entry.result.differences.map(
          (difference) => `  - ${formatDifference(difference)}`,
        ),
      );
    }
  }

  if (result.unmatchedModulesInA.length > 0) {
    lines.push("", `Unmatched modules in A: ${result.unmatchedModulesInA.join(", ")}`);
  }
  if (result.unmatchedModulesInB.length > 0) {
    lines.push("", `Unmatched modules in B: ${result.unmatchedModulesInB.join(", ")}`);
  }

  return lines.join("\n");
}

export function formatDifference(difference: NetworkDifference): string {
  switch (difference.kind) {
    case "unmatched-node":
      return `node ${formatNode(difference.node)} exists only in ${difference.side.toUpperCase()}`;
    case "unmatched-link":
      return `link ${formatLink(difference.link)} exists only in ${difference.side.toUpperCase()}`;
    case "input-mismatch":
      return (
        `input ${JSON.stringify(difference.portKey)} differs between ` +
        `${formatNode(difference.nodeA)} and ${formatNode(difference.nodeB)}`
      );
    case "property-value-mismatch":
      return (
        `${difference.source} ${JSON.stringify(difference.key)} differs between ` +
        `${formatNode(difference.nodeA)} (${formatValue(difference.valueA)}) and ` +
        `${formatNode(difference.nodeB)} (${formatValue(difference.valueB)})`
      );
  }
}

function formatNode(node: ComparableNode): string {
  if (node.port) {
    return (
      `${JSON.stringify(node.node.id)} ` +
      `(port ${node.port.direction} ${JSON.stringify(node.port.name)}, ${node.port.signal}, occurrence ${node.port.occurrence})`
    );
  }

  return `${JSON.stringify(node.node.id)} (${node.node.definitionId})`;
}

function formatLink(link: IrLink): string {
  return (
    `${JSON.stringify(link.from.nodeId)}.${JSON.stringify(link.from.portKey)} -> ` +
    `${JSON.stringify(link.to.nodeId)}.${JSON.stringify(link.to.portKey)}`
  );
}

function formatValue(value: IrScalarValue | undefined): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}
