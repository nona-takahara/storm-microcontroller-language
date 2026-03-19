import { type IrNode } from "../ir.js";

export function getSwNetInstanceTypeName(node: IrNode): string {
  if (node.definitionId.startsWith("LOGIC_COMPONENT:")) {
    return `LOGIC_COMPONENT_${node.definitionId.slice("LOGIC_COMPONENT:".length)}`;
  }

  return node.definitionId;
}

export function getSwNetInstanceName(node: IrNode): string {
  const rawObjectId = node.properties.objectId;

  if (typeof rawObjectId === "string" && rawObjectId.length > 0) {
    return `n${sanitizeSwNetIdentifier(rawObjectId)}`;
  }

  const fallbackId = tryParseSwNetTrailingNumber(node.id);
  if (fallbackId !== undefined) {
    return `n${fallbackId}`;
  }

  return `n_${sanitizeSwNetIdentifier(node.id)}`;
}

export function sanitizeSwNetIdentifier(value: string, emptyFallback = "node"): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : emptyFallback;
}

export function compareSwNetIdentifier(left: string, right: string): number {
  const leftNumeric = tryParseSwNetTrailingNumber(left);
  const rightNumeric = tryParseSwNetTrailingNumber(right);

  if (leftNumeric !== undefined && rightNumeric !== undefined && leftNumeric !== rightNumeric) {
    return leftNumeric - rightNumeric;
  }

  return left.localeCompare(right);
}

export function tryParseSwNetTrailingNumber(value: string): number | undefined {
  const match = /(\d+)$/.exec(value);

  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
