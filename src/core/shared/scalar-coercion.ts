import { type DefinitionValueType } from "../definitions/schema.js";
import { type IrScalarValue } from "../ir.js";

// Centralize loose XML/DSL scalar coercion so importer and serializer keep identical bool/number rules.
export function coerceScalarValue(
  value: unknown,
  valueType: DefinitionValueType,
  options: { preserveNull?: boolean } = {},
): IrScalarValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  // Serializer inputs can preserve null literals; importer XML fields normally do not use nulls.
  if (value === null) {
    return options.preserveNull ? null : valueType === "string" ? "null" : undefined;
  }

  if (valueType === "string") {
    return typeof value === "string" ? value : String(value);
  }

  if (valueType === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true" || value === "1") {
      return true;
    }

    if (value === "false" || value === "0") {
      return false;
    }
  }

  return undefined;
}
