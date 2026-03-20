// AST-level sw-net serializer used when callers already operate on parsed sw-net documents.
import {
  type SwNetAssignment,
  type SwNetDocument,
  type SwNetExpression,
  type SwNetModule,
  type SwNetStatement,
} from "../parsers/sw-net.js";

export interface SerializeSwNetDocumentOptions {
  newlineAtEnd?: boolean;
}

// Serialize a parsed sw-net document back into canonical text form.
export function serializeSwNetDocument(
  document: SwNetDocument,
  options: SerializeSwNetDocumentOptions = {},
): string {
  const lines: string[] = [];

  for (const imported of document.imports) {
    lines.push(`import ${imported.alias} from ${JSON.stringify(imported.path)}`);
  }

  // Keep one blank line between imports and modules so the result matches the hand-written style.
  if (document.imports.length > 0 && document.modules.length > 0) {
    lines.push("");
  }

  document.modules.forEach((module, index) => {
    if (index > 0) {
      lines.push("");
    }

    lines.push(...serializeSwNetModule(module));
  });

  const rendered = lines.join("\n");
  return (options.newlineAtEnd ?? true) ? `${rendered}\n` : rendered;
}

// Serialize one sw-net module declaration.
function serializeSwNetModule(module: SwNetModule): string[] {
  const lines: string[] = [];

  lines.push(`module ${module.id}`);

  for (const port of module.ports) {
    lines.push(`  port ${port.direction} ${formatPortName(port.name)} : ${port.signal}`);
  }

  if (module.ports.length > 0 && module.statements.length > 0) {
    lines.push("");
  }

  for (const statement of module.statements) {
    lines.push(`  ${serializeSwNetStatement(statement)}`);
  }

  lines.push("end");

  return lines;
}

// Serialize either an inst or use statement from the sw-net AST.
function serializeSwNetStatement(statement: SwNetStatement): string {
  if (statement.kind === "inst") {
    const attributesText =
      statement.attributes.length > 0 ? ` (${serializeAssignments(statement.attributes)})` : "";

    return `inst ${statement.typeId} ${statement.instanceId}${attributesText} ${serializePinAssignments(
      statement.inputs,
      statement.outputs,
    )}`;
  }

  const moduleRef =
    statement.moduleRef.kind === "local"
      ? statement.moduleRef.moduleId
      : `${statement.moduleRef.alias}.${statement.moduleRef.moduleId}`;

  return `use ${moduleRef} ${statement.instanceId} ${serializePinAssignments(
    statement.inputs,
    statement.outputs,
  )}`;
}

// Serialize the shared `: inputs -> outputs` clause used by inst and use statements.
function serializePinAssignments(inputs: SwNetAssignment[], outputs: SwNetAssignment[]): string {
  const inputText = serializeAssignments(inputs);
  const outputText = serializeAssignments(outputs);
  const rightHandSide = outputText.length > 0 ? `-> ${outputText}` : "->";

  return inputText.length > 0 ? `: ${inputText} ${rightHandSide}` : `: ${rightHandSide}`;
}

// Serialize a comma-separated assignment list.
function serializeAssignments(assignments: SwNetAssignment[]): string {
  return assignments.map((assignment) => `${assignment.key}=${serializeExpression(assignment.value)}`).join(", ");
}

// Serialize one sw-net expression back to source text.
function serializeExpression(expression: SwNetExpression): string {
  switch (expression.kind) {
    case "identifier":
      return expression.value;
    case "string":
      return JSON.stringify(expression.value);
    case "number":
      return Number.isInteger(expression.value) ? String(expression.value) : String(expression.value);
    case "boolean":
      return expression.value ? "true" : "false";
    case "null":
      return "null";
  }
}

// Quote port names only when a bare identifier would not preserve the original text.
function formatPortName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}
