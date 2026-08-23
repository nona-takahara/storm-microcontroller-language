import { type ComparableNode } from "./types.js";

const FUNCTION_DEFINITION_IDS = new Set([
  "BOOL_FUNC_4",
  "BOOL_FUNC_8",
  "FUNC_NUM_1",
  "FUNC_NUM_3",
  "FUNC_NUM_8",
]);

export type StrongCorrespondenceEvidenceKey = "expression" | "propertyLabel" | "n";

/**
 * Shared strongest-first policy for authored attributes that identify a node more strongly than
 * routine mutable properties. Lua content and script_ref intentionally live outside this policy:
 * the former participates in projected-output safety and the latter is derived from correspondence.
 */
export const STRONG_CORRESPONDENCE_EVIDENCE_KEYS: readonly StrongCorrespondenceEvidenceKey[] = [
  "expression",
  "propertyLabel",
  "n",
];

export function strongCorrespondenceEvidenceValue(
  node: ComparableNode,
  key: StrongCorrespondenceEvidenceKey,
): string | undefined {
  if (key === "expression" && !FUNCTION_DEFINITION_IDS.has(node.node.definitionId)) return undefined;
  const attributeKey = key === "propertyLabel"
    ? propertyLabelAttributeKey(node.node.definitionId)
    : key;
  if (!attributeKey) return undefined;
  const value = node.attributes[attributeKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Prefer a definition-owned Property label/name, falling back to the generic Stormworks `n`. */
export function displayNameEvidenceValue(node: ComparableNode): string | undefined {
  return strongCorrespondenceEvidenceValue(node, "propertyLabel") ?? strongCorrespondenceEvidenceValue(node, "n");
}

export function ordinaryAttributeEvidenceKeys(node: ComparableNode): string[] {
  const strongAttributeKeys = new Set([
    "expression",
    "n",
    propertyLabelAttributeKey(node.node.definitionId),
  ].filter((key): key is string => key !== undefined));
  return Object.keys(node.attributes).filter(
    (key) => key !== "script_ref" && !strongAttributeKeys.has(key),
  );
}

function propertyLabelAttributeKey(definitionId: string): "label" | "name" | undefined {
  if (definitionId === "PROPERTY_TOGGLE") return "label";
  if (definitionId === "PROPERTY_TEXT") return "name";
  return undefined;
}
