// sw-mcl parser that validates the module-local layout document paired with one sw-net file.
import {
  STORMWORKS_SW_MCL_FORMAT_VERSION,
  type StormworksSwMclDocument,
  type SwMclInstanceDocument,
  type SwMclPortDocument,
} from "../serializers/sw-mcl.js";
import {
  expectArrayWith,
  expectIntegerWith,
  expectRecordWith,
  expectStringWith,
  optionalStringWith,
  parseVector2With,
} from "../shared/json-schema-helpers.js";

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

// Parser-local wrappers preserve the public error class and exact messages while the
// repeated JSON guard logic lives in one shared helper module.
const parseVector2 = (input: unknown, path: string) => parseVector2With(input, path, SwMclParseError);
const expectRecord = (input: unknown, path: string) => expectRecordWith(input, path, SwMclParseError);
const expectArray = (input: unknown, path: string) => expectArrayWith(input, path, SwMclParseError);
const expectString = (input: unknown, path: string) => expectStringWith(input, path, SwMclParseError);
const optionalString = (input: unknown, path: string) => optionalStringWith(input, path, SwMclParseError);
const expectInteger = (input: unknown, path: string) => expectIntegerWith(input, path, SwMclParseError);
