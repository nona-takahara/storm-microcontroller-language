import { type DefinitionValueType } from "../definitions/schema.js";
import { type IrScalarValue } from "../ir.js";
import { type SwNetAssignment, type SwNetExpression } from "../parsers/sw-net.js";

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

// Encode one sw-net list-literal's entries into the canonical {l, value} JSON string that
// PROPERTY_DROPDOWN-style itemList properties store at the IR/XML level (see extractItemListValue
// in importers/xml.ts and applyItemListWriteTarget in exporters/xml-tree.ts). Shared by the exporter
// and the DSL/IR comparator so both sides stay byte-identical.
export function encodeSwNetItemListEntries(entries: readonly SwNetAssignment[]): string {
  const items = entries.map((entry) => ({
    l: entry.key,
    value: coerceScalarValue(extractItemListEntryRawValue(entry.value), "string", { preserveNull: true }) ?? null,
  }));

  return JSON.stringify(items);
}

// Reduce one list-entry's value expression to a raw scalar before string coercion; a nested list
// isn't a meaningful item value and falls back to null (via preserveNull) rather than being rejected.
function extractItemListEntryRawValue(expression: SwNetExpression): IrScalarValue | undefined {
  return expression.kind === "list" ? undefined : expression.value;
}
