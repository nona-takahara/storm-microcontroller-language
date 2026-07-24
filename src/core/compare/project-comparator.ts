import { type StormworksLibraryResult } from "../diagnostics.js";
import {
  type SwNetResolutionResult,
  type SwNetResolvedModule,
  type SwNetResolvedModuleKey,
} from "../resolvers/sw-net.js";
import { normalizeComparableModule } from "./comparable-node.js";
import {
  compareComparableModuleGraphs,
  compareSwNetModules,
  type NetworkComparisonOptions,
} from "./module-graph-comparator.js";
import {
  flattenSwNetProject,
  type FlattenSwNetProjectOptions,
  type FlattenedSwNetProject,
} from "./project-flattener.js";
import {
  type ModuleComparisonEntry,
  type NetworkComparisonResult,
  type ProjectComparisonResult,
} from "./types.js";

export interface ProjectComparisonOptions extends NetworkComparisonOptions {
  entryModuleA?: string;
  entryModuleB?: string;
}

/**
 * Compare two resolved projects by their fully inlined circuits.
 * Module comparisons are supplementary grouping information and never override the flat verdict.
 */
export function compareSwNetProjects(
  a: SwNetResolutionResult,
  b: SwNetResolutionResult,
  options: ProjectComparisonOptions = {},
): StormworksLibraryResult<ProjectComparisonResult> {
  const flattenedA = flattenSwNetProject(a, flattenOptions(options.entryModuleA));
  const flattenedB = flattenSwNetProject(b, flattenOptions(options.entryModuleB));
  const diagnostics = [...flattenedA.diagnostics, ...flattenedB.diagnostics];

  if (!flattenedA.value || !flattenedB.value) {
    return { diagnostics };
  }

  const flatResult = compareFlattenedProjects(flattenedA.value, flattenedB.value, options);
  diagnostics.push(...flatResult.diagnostics);
  if (!flatResult.value) {
    return { diagnostics };
  }

  const grouping = compareModuleStructures(a, b, options);
  return {
    value: {
      ...flatResult.value,
      moduleResults: grouping.entries,
      unmatchedModulesInA: grouping.unmatchedA,
      unmatchedModulesInB: grouping.unmatchedB,
    },
    diagnostics,
  };
}

function compareFlattenedProjects(
  a: FlattenedSwNetProject,
  b: FlattenedSwNetProject,
  options: NetworkComparisonOptions,
): StormworksLibraryResult<NetworkComparisonResult> {
  const normalizedA = normalizeComparableModule(a.module);
  const normalizedB = normalizeComparableModule(b.module);
  const diagnostics = [...normalizedA.diagnostics, ...normalizedB.diagnostics];
  if (!normalizedA.value || !normalizedB.value) {
    return { diagnostics };
  }

  for (const node of normalizedA.value.nodes) {
    node.provenance = a.provenanceByInstanceId[node.node.id];
  }
  for (const node of normalizedB.value.nodes) {
    node.provenance = b.provenanceByInstanceId[node.node.id];
  }

  return {
    value: compareComparableModuleGraphs(
      normalizedA.value,
      normalizedB.value,
      diagnostics,
      options,
    ),
    diagnostics,
  };
}

interface ModuleGrouping {
  entries: ModuleComparisonEntry[];
  unmatchedA: string[];
  unmatchedB: string[];
}

function compareModuleStructures(
  a: SwNetResolutionResult,
  b: SwNetResolutionResult,
  options: NetworkComparisonOptions,
): ModuleGrouping {
  const candidates = a.modules.flatMap((moduleA) =>
    b.modules
      .filter((moduleB) => portSignature(moduleA) === portSignature(moduleB))
      .map((moduleB) => ({
        moduleA,
        moduleB,
        result: compareSwNetModules(moduleA.module, moduleB.module, options).value,
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          moduleA: SwNetResolvedModule;
          moduleB: SwNetResolvedModule;
          result: NetworkComparisonResult;
        } => candidate.result !== undefined,
      ),
  );
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const entries: ModuleComparisonEntry[] = [];

  candidates.sort(
    (left, right) =>
      groupingRank(left.result) - groupingRank(right.result) ||
      moduleKey(left.moduleA.key).localeCompare(moduleKey(right.moduleA.key)) ||
      moduleKey(left.moduleB.key).localeCompare(moduleKey(right.moduleB.key)),
  );

  for (const candidate of candidates) {
    const keyA = moduleKey(candidate.moduleA.key);
    const keyB = moduleKey(candidate.moduleB.key);
    if (usedA.has(keyA) || usedB.has(keyB)) {
      continue;
    }
    usedA.add(keyA);
    usedB.add(keyB);
    entries.push({ moduleKeyA: keyA, moduleKeyB: keyB, result: candidate.result });
  }

  return {
    entries,
    unmatchedA: a.modules.map((module) => moduleKey(module.key)).filter((key) => !usedA.has(key)),
    unmatchedB: b.modules.map((module) => moduleKey(module.key)).filter((key) => !usedB.has(key)),
  };
}

function groupingRank(result: NetworkComparisonResult): number {
  const verdictRank = result.verdict === "equivalent" ? 0 : result.verdict === "different" ? 1 : 2;
  return verdictRank * 1_000_000 + result.unmatchedInA.length + result.unmatchedInB.length + result.differences.length;
}

function portSignature(module: SwNetResolvedModule): string {
  return JSON.stringify(
    module.module.ports.map((port) => [port.direction, port.name, port.signal]).sort(),
  );
}

function moduleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

function flattenOptions(entryModuleId: string | undefined): FlattenSwNetProjectOptions {
  return entryModuleId === undefined ? {} : { entryModuleId };
}
