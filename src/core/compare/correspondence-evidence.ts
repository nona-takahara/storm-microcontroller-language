import { type ComparableNode } from "./types.js";

const FUNCTION_DEFINITION_IDS = new Set([
  "BOOL_FUNC_4",
  "BOOL_FUNC_8",
  "FUNC_NUM_1",
  "FUNC_NUM_3",
  "FUNC_NUM_8",
]);

/** Function expressions are authored behavior and therefore stronger identity evidence than ordinary properties. */
export function functionExpression(node: ComparableNode): string | undefined {
  if (!FUNCTION_DEFINITION_IDS.has(node.node.definitionId)) return undefined;
  const expression = node.attributes.expression;
  return typeof expression === "string" && expression.length > 0 ? expression : undefined;
}
