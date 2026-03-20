// sw-mcl parser that validates the module-local layout document paired with one sw-net file.
import { type IrVector2 } from "../ir.js";
import {
  STORMWORKS_SW_MCL_FORMAT_VERSION,
  type StormworksSwMclDocument,
  type SwMclInstanceDocument,
  type SwMclPortDocument,
} from "../serializers/sw-mcl.js";

/** Error type for malformed or schema-incompatible sw-mcl documents. */
export class SwMclParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "SwMclParseError";
  }
}

// Parse sw-mcl JSON text into the validated in-memory layout document shape.
export function parseStormworksSwMclText(text: string): StormworksSwMclDocument {
  return parseStormworksSwMclDocument(JSON.parse(text));
}

// Parse and validate the in-memory sw-mcl document shape.
export function parseStormworksSwMclDocument(input: unknown): StormworksSwMclDocument {
  const root = expectRecord(input, "$");
  const formatVersion = expectString(root.formatVersion, "$.formatVersion");

  if (formatVersion !== STORMWORKS_SW_MCL_FORMAT_VERSION) {
    throw new SwMclParseError(
      `Unsupported sw-mcl format version ${formatVersion}; expected ${STORMWORKS_SW_MCL_FORMAT_VERSION}`,
      "$.formatVersion",
    );
  }

  return {
    formatVersion,
    sourceName: optionalString(root.sourceName, "$.sourceName"),
    moduleId: expectString(root.moduleId, "$.moduleId"),
    ports: expectArray(root.ports, "$.ports").map((value, index) =>
      parseSwMclPort(value, `$.ports[${index}]`),
    ),
    instances: expectArray(root.instances, "$.instances").map((value, index) =>
      parseSwMclInstance(value, `$.instances[${index}]`),
    ),
    warnings: expectArray(root.warnings, "$.warnings").map((value, index) =>
      expectString(value, `$.warnings[${index}]`),
    ),
  };
}

// Parse one module-port layout entry from sw-mcl.
function parseSwMclPort(input: unknown, path: string): SwMclPortDocument {
  const record = expectRecord(input, path);
  const direction = expectString(record.direction, `${path}.direction`);

  if (direction !== "in" && direction !== "out") {
    throw new SwMclParseError("Expected in or out", `${path}.direction`);
  }

  return {
    name: expectString(record.name, `${path}.name`),
    direction,
    occurrence: expectInteger(record.occurrence, `${path}.occurrence`),
    position: parseVector2(record.position, `${path}.position`),
  };
}

// Parse one logic-instance layout entry from sw-mcl.
function parseSwMclInstance(input: unknown, path: string): SwMclInstanceDocument {
  const record = expectRecord(input, path);

  return {
    id: expectString(record.id, `${path}.id`),
    type: expectString(record.type, `${path}.type`),
    position: parseVector2(record.position, `${path}.position`),
  };
}

// Parse a 2D vector used for port and instance positions.
function parseVector2(input: unknown, path: string): IrVector2 {
  const record = expectRecord(input, path);

  return {
    x: expectFiniteNumber(record.x, `${path}.x`),
    y: expectFiniteNumber(record.y, `${path}.y`),
  };
}

// Require a plain object at the current sw-mcl path.
function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new SwMclParseError("Expected object", path);
}

// Require an array at the current sw-mcl path.
function expectArray(input: unknown, path: string): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  throw new SwMclParseError("Expected array", path);
}

// Require a string at the current sw-mcl path.
function expectString(input: unknown, path: string): string {
  if (typeof input === "string") {
    return input;
  }

  throw new SwMclParseError("Expected string", path);
}

// Parse an optional string field that may be absent.
function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return expectString(input, path);
}

// Require a finite numeric value at the current sw-mcl path.
function expectFiniteNumber(input: unknown, path: string): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  throw new SwMclParseError("Expected finite number", path);
}

// Require an integer value at the current sw-mcl path.
function expectInteger(input: unknown, path: string): number {
  if (typeof input === "number" && Number.isInteger(input)) {
    return input;
  }

  throw new SwMclParseError("Expected integer", path);
}
