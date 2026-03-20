import { type IrScalarValue, type IrVector2 } from "../ir.js";
import {
  STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
  type ProjectJsonConstantDocument,
  type ProjectJsonDocument,
  type ProjectJsonLinkDocument,
  type ProjectJsonLinkEndpoint,
  type ProjectJsonNodeDocument,
  type ProjectJsonSubmoduleDocument,
} from "../serializers/project-json.js";

export class ProjectJsonParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "ProjectJsonParseError";
  }
}

export function parseProjectJsonText(text: string): ProjectJsonDocument {
  return parseProjectJsonDocument(JSON.parse(text));
}

export function parseProjectJsonDocument(input: unknown): ProjectJsonDocument {
  const root = expectRecord(input, "$");
  const formatVersion = expectString(root.formatVersion, "$.formatVersion");

  if (formatVersion !== STORMWORKS_PROJECT_JSON_FORMAT_VERSION) {
    throw new ProjectJsonParseError(
      `Unsupported project format version ${formatVersion}; expected ${STORMWORKS_PROJECT_JSON_FORMAT_VERSION}`,
      "$.formatVersion",
    );
  }

  return {
    formatVersion,
    sourceName: optionalString(root.sourceName, "$.sourceName"),
    name: optionalStringOrNull(root.name, "$.name"),
    description: optionalStringOrNull(root.description, "$.description"),
    width: optionalFiniteNumberOrNull(root.width, "$.width"),
    length: optionalFiniteNumberOrNull(root.length, "$.length"),
    nodes: expectArray(root.nodes, "$.nodes").map((value, index) =>
      parseProjectJsonNode(value, `$.nodes[${index}]`),
    ),
    constants: expectArray(root.constants, "$.constants").map((value, index) =>
      parseProjectJsonConstant(value, `$.constants[${index}]`),
    ),
    submodules: expectArray(root.submodules, "$.submodules").map((value, index) =>
      parseProjectJsonSubmodule(value, `$.submodules[${index}]`),
    ),
    links: expectArray(root.links, "$.links").map((value, index) =>
      parseProjectJsonLink(value, `$.links[${index}]`),
    ),
    warnings: expectArray(root.warnings, "$.warnings").map((value, index) =>
      expectString(value, `$.warnings[${index}]`),
    ),
  };
}

function parseProjectJsonNode(input: unknown, path: string): ProjectJsonNodeDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    type: expectString(record.type, `${path}.type`),
    label: optionalStringOrNull(record.label, `${path}.label`),
    description: optionalStringOrNull(record.description, `${path}.description`),
    nodePosition: parseVector2(record.nodePosition, `${path}.nodePosition`),
    position: optionalVector2OrNull(record.position, `${path}.position`),
  };
}

function parseProjectJsonConstant(input: unknown, path: string): ProjectJsonConstantDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    value: parseScalarValue(record.value, `${path}.value`),
    position: optionalVector2OrNull(record.position, `${path}.position`),
  };
}

function parseProjectJsonSubmodule(input: unknown, path: string): ProjectJsonSubmoduleDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    name: expectString(record.name, `${path}.name`),
    relativePath: expectString(record.relativePath, `${path}.relativePath`),
    position: optionalVector2OrNull(record.position, `${path}.position`),
  };
}

function parseProjectJsonLink(input: unknown, path: string): ProjectJsonLinkDocument {
  const record = expectRecord(input, path);

  return {
    from: parseProjectJsonLinkEndpoint(record.from, `${path}.from`),
    to: parseProjectJsonLinkEndpoint(record.to, `${path}.to`),
  };
}

function parseProjectJsonLinkEndpoint(input: unknown, path: string): ProjectJsonLinkEndpoint {
  const record = expectRecord(input, path);
  const kind = expectString(record.kind, `${path}.kind`);

  if (kind !== "node" && kind !== "submodule_port" && kind !== "constant") {
    throw new ProjectJsonParseError("Expected one of node | submodule_port | constant", `${path}.kind`);
  }

  return {
    kind,
    id: optionalString(record.id, `${path}.id`),
    submodule: optionalString(record.submodule, `${path}.submodule`),
    port: optionalString(record.port, `${path}.port`),
  };
}

function parseVector2(input: unknown, path: string): IrVector2 {
  const record = expectRecord(input, path);

  return {
    x: expectFiniteNumber(record.x, `${path}.x`),
    y: expectFiniteNumber(record.y, `${path}.y`),
  };
}

function optionalVector2OrNull(input: unknown, path: string): IrVector2 | null {
  if (input === null || input === undefined) {
    return null;
  }

  return parseVector2(input, path);
}

function parseScalarValue(input: unknown, path: string): IrScalarValue {
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean" || input === null) {
    return input;
  }

  throw new ProjectJsonParseError("Expected scalar value", path);
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new ProjectJsonParseError("Expected object", path);
}

function expectArray(input: unknown, path: string): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  throw new ProjectJsonParseError("Expected array", path);
}

function expectString(input: unknown, path: string): string {
  if (typeof input === "string") {
    return input;
  }

  throw new ProjectJsonParseError("Expected string", path);
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return expectString(input, path);
}

function optionalStringOrNull(input: unknown, path: string): string | null {
  if (input === undefined || input === null) {
    return null;
  }

  return expectString(input, path);
}

function expectFiniteNumber(input: unknown, path: string): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  throw new ProjectJsonParseError("Expected finite number", path);
}

function optionalFiniteNumberOrNull(input: unknown, path: string): number | null {
  if (input === undefined || input === null) {
    return null;
  }

  return expectFiniteNumber(input, path);
}
