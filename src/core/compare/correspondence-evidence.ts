import { type ComparableNode } from "./types.js";

const FUNCTION_DEFINITION_IDS = new Set([
  "BOOL_FUNC_4",
  "BOOL_FUNC_8",
  "FUNC_NUM_1",
  "FUNC_NUM_3",
  "FUNC_NUM_8",
]);

export type StrongCorrespondenceEvidenceKey = "expression" | "n";

/**
 * Shared strongest-first policy for authored attributes that identify a node more strongly than
 * routine mutable properties. Lua content and script_ref intentionally live outside this policy:
 * the former participates in projected-output safety and the latter is derived from correspondence.
 */
export const STRONG_CORRESPONDENCE_EVIDENCE_KEYS: readonly StrongCorrespondenceEvidenceKey[] = [
  "expression",
  "n",
];

export function strongCorrespondenceEvidenceValue(
  node: ComparableNode,
  key: StrongCorrespondenceEvidenceKey,
): string | undefined {
  if (key === "expression" && !FUNCTION_DEFINITION_IDS.has(node.node.definitionId)) return undefined;
  const value = node.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ordinaryAttributeEvidenceKeys(node: ComparableNode): string[] {
  return Object.keys(node.attributes).filter(
    (key) => key !== "script_ref" && !STRONG_CORRESPONDENCE_EVIDENCE_KEYS.includes(key as StrongCorrespondenceEvidenceKey),
  );
}
