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

export function serializeSwNetDocument(
  document: SwNetDocument,
  options: SerializeSwNetDocumentOptions = {},
): string {
  const lines: string[] = [];

  for (const imported of document.imports) {
    lines.push(`import ${imported.alias} from ${JSON.stringify(imported.path)}`);
  }

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

function serializePinAssignments(inputs: SwNetAssignment[], outputs: SwNetAssignment[]): string {
  const inputText = serializeAssignments(inputs);
  const outputText = serializeAssignments(outputs);
  const rightHandSide = outputText.length > 0 ? `-> ${outputText}` : "->";

  return inputText.length > 0 ? `: ${inputText} ${rightHandSide}` : `: ${rightHandSide}`;
}

function serializeAssignments(assignments: SwNetAssignment[]): string {
  return assignments.map((assignment) => `${assignment.key}=${serializeExpression(assignment.value)}`).join(", ");
}

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

function formatPortName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}
