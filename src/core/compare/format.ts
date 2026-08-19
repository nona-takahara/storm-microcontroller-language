import { type IrLink, type IrScalarValue } from "../ir.js";
import { englishTranslator, type Translator } from "../i18n/index.js";
import {
  type ComparableNode,
  type NetworkComparisonResult,
  type NetworkDifference,
  type ProjectComparisonResult,
} from "./types.js";

/** Format a comparison result for human-facing CLI and MCP text output. */
export function formatNetworkComparison(
  result: NetworkComparisonResult,
  translator: Translator = englishTranslator,
): string {
  const verdict = formatVerdict(result.verdict, translator);
  const lines = [
    translator.format("compare.network", { verdict }),
    translator.format("compare.matchedNodes", { count: result.matchedPairs.length }),
  ];

  if (result.reason) {
    lines.push(translator.format("compare.reason", { reason: result.reason }));
  }

  if (result.differences.length === 0) {
    lines.push(translator.format("compare.noDifferences"));
  } else {
    lines.push(translator.format("compare.differences", { count: result.differences.length }));
    lines.push(...result.differences.map((difference) => `- ${formatDifference(difference, translator)}`));
  }

  return lines.join("\n");
}

/** Format a project result, including module-level groupings when available. */
export function formatProjectComparison(
  result: ProjectComparisonResult,
  translator: Translator = englishTranslator,
): string {
  const lines = [formatNetworkComparison(result, translator)];

  if (result.moduleResults.length > 0) {
    lines.push("", translator.format("compare.moduleComparisons", { count: result.moduleResults.length }));
    for (const entry of result.moduleResults) {
      lines.push(
        `- ${translator.format("compare.moduleSummary", {
          moduleA: entry.moduleKeyA,
          moduleB: entry.moduleKeyB,
          verdict: formatVerdict(entry.result.verdict, translator),
          matched: entry.result.matchedPairs.length,
          differences: entry.result.differences.length,
        })}`,
      );
      if (entry.result.reason) {
        lines.push(`  ${translator.format("compare.reason", { reason: entry.result.reason })}`);
      }
      lines.push(
        ...entry.result.differences.map(
          (difference) => `  - ${formatDifference(difference, translator)}`,
        ),
      );
    }
  }

  if (result.unmatchedModulesInA.length > 0) {
    lines.push("", translator.format("compare.unmatchedModulesA", { modules: result.unmatchedModulesInA.join(", ") }));
  }
  if (result.unmatchedModulesInB.length > 0) {
    lines.push("", translator.format("compare.unmatchedModulesB", { modules: result.unmatchedModulesInB.join(", ") }));
  }

  return lines.join("\n");
}

export function formatDifference(
  difference: NetworkDifference,
  translator: Translator = englishTranslator,
): string {
  switch (difference.kind) {
    case "unmatched-node":
      return translator.format("compare.difference.unmatchedNode", {
        node: formatNode(difference.node, translator),
        side: difference.side.toUpperCase(),
      });
    case "unmatched-link":
      return translator.format("compare.difference.unmatchedLink", {
        link: formatLink(difference.link),
        side: difference.side.toUpperCase(),
      });
    case "input-mismatch":
      return translator.format("compare.difference.inputMismatch", {
        portKey: JSON.stringify(difference.portKey),
        nodeA: formatNode(difference.nodeA, translator),
        nodeB: formatNode(difference.nodeB, translator),
      });
    case "property-value-mismatch":
      return translator.format("compare.difference.propertyMismatch", {
        source: difference.source,
        key: JSON.stringify(difference.key),
        nodeA: formatNode(difference.nodeA, translator),
        valueA: formatValue(difference.valueA, translator),
        nodeB: formatNode(difference.nodeB, translator),
        valueB: formatValue(difference.valueB, translator),
      });
  }
}

function formatNode(node: ComparableNode, translator: Translator): string {
  if (node.port) {
    return translator.format("compare.node.port", {
      id: JSON.stringify(node.node.id),
      direction: node.port.direction,
      name: JSON.stringify(node.port.name),
      signal: node.port.signal,
      occurrence: node.port.occurrence,
    });
  }

  return translator.format("compare.node.gate", {
    id: JSON.stringify(node.node.id),
    definitionId: node.node.definitionId,
  });
}

function formatLink(link: IrLink): string {
  return (
    `${JSON.stringify(link.from.nodeId)}.${JSON.stringify(link.from.portKey)} -> ` +
    `${JSON.stringify(link.to.nodeId)}.${JSON.stringify(link.to.portKey)}`
  );
}

function formatValue(value: IrScalarValue | undefined, translator: Translator): string {
  return value === undefined ? translator.format("compare.value.absent") : JSON.stringify(value);
}

function formatVerdict(verdict: NetworkComparisonResult["verdict"], translator: Translator): string {
  return translator.format(`compare.verdict.${verdict}`);
}
