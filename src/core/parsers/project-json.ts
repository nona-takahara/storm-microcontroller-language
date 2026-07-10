// project.json parser that validates the project-surface document used alongside sw-net and sw-mcl.
import { type IrScalarValue, type IrVector2 } from "../ir.js";
import {
  expectArrayWith,
  expectFiniteNumberWith,
  expectRecordWith,
  expectStringWith,
  optionalStringWith,
  parseVector2With,
} from "../shared/json-schema-helpers.js";
import {
  STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
  type ProjectJsonConstantDocument,
  type ProjectJsonDocument,
  type ProjectJsonLinkDocument,
  type ProjectJsonLinkEndpoint,
  type ProjectJsonNodeDocument,
  type ProjectJsonSubmoduleDocument,
} from "../serializers/project-json.js";

/** Error type for malformed or schema-incompatible project.json documents. */
export class ProjectJsonParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "ProjectJsonParseError";
  }
}

// Parse project.json text into the validated in-memory document shape.
export function parseProjectJsonText(text: string): ProjectJsonDocument {
  return parseProjectJsonDocument(JSON.parse(text));
}

// Parse and validate the in-memory project.json document shape.
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

// Parse one project-node entry from project.json. A legacy "position" (bridge-canvas position) key
// may still be present in older files — it's part of .sw-mcl's domain now (see xml-tree.ts's bridge
// export, which sources it from the module port slot), so it's intentionally accepted-but-unused here
// rather than rejected.
function parseProjectJsonNode(input: unknown, path: string): ProjectJsonNodeDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    type: expectString(record.type, `${path}.type`),
    label: optionalStringOrNull(record.label, `${path}.label`),
    description: optionalStringOrNull(record.description, `${path}.description`),
    nodePosition: parseVector2(record.nodePosition, `${path}.nodePosition`),
  };
}

// Parse one project-surface constant entry from project.json.
function parseProjectJsonConstant(input: unknown, path: string): ProjectJsonConstantDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    value: parseScalarValue(record.value, `${path}.value`),
    position: optionalVector2OrNull(record.position, `${path}.position`),
  };
}

// Parse one submodule reference entry from project.json.
function parseProjectJsonSubmodule(input: unknown, path: string): ProjectJsonSubmoduleDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    name: expectString(record.name, `${path}.name`),
    relativePath: expectString(record.relativePath, `${path}.relativePath`),
    position: optionalVector2OrNull(record.position, `${path}.position`),
  };
}

// Parse one project-surface link entry from project.json.
function parseProjectJsonLink(input: unknown, path: string): ProjectJsonLinkDocument {
  const record = expectRecord(input, path);

  return {
    from: parseProjectJsonLinkEndpoint(record.from, `${path}.from`),
    to: parseProjectJsonLinkEndpoint(record.to, `${path}.to`),
  };
}

// Parse one project-surface link endpoint.
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

// Shared JSON guards remove parser-to-parser copy/paste while this file keeps the
// nullable project.json conventions close to their call sites.
const parseVector2 = (input: unknown, path: string) => parseVector2With(input, path, ProjectJsonParseError);

// Parse an optional vector that may be absent or null in persisted project.json.
function optionalVector2OrNull(input: unknown, path: string): IrVector2 | null {
  if (input === null || input === undefined) {
    return null;
  }

  return parseVector2(input, path);
}

// Parse one scalar JSON value used by project-surface constants.
function parseScalarValue(input: unknown, path: string): IrScalarValue {
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean" || input === null) {
    return input;
  }

  throw new ProjectJsonParseError("Expected scalar value", path);
}

const expectRecord = (input: unknown, path: string) => expectRecordWith(input, path, ProjectJsonParseError);
const expectArray = (input: unknown, path: string) => expectArrayWith(input, path, ProjectJsonParseError);
const expectString = (input: unknown, path: string) => expectStringWith(input, path, ProjectJsonParseError);
const optionalString = (input: unknown, path: string) => optionalStringWith(input, path, ProjectJsonParseError);

// Parse an optional string field that may be absent or explicitly null.
function optionalStringOrNull(input: unknown, path: string): string | null {
  if (input === undefined || input === null) {
    return null;
  }

  return expectString(input, path);
}

const expectFiniteNumber = (input: unknown, path: string) =>
  expectFiniteNumberWith(input, path, ProjectJsonParseError);

// Parse an optional finite number that may be absent or explicitly null.
function optionalFiniteNumberOrNull(input: unknown, path: string): number | null {
  if (input === undefined || input === null) {
    return null;
  }

  return expectFiniteNumber(input, path);
}
