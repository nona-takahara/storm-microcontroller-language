// project.json parser that validates the project-surface document used alongside sw-net and sw-mcl.
import { isValidMicroprocessorIconShape } from "../shared/microprocessor-icon.js";
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
  type ProjectJsonDocument,
  type ProjectJsonNodeDocument,
  type ProjectJsonSubmoduleDocument,
} from "../serializers/project-json.js";

// project.json's previous format: `submodules` was an array, and connectivity lived in a separate
// `links` array (with `constants` derived from it). A node's id now doubles as the matching .sw-net
// port name instead (see serializers/project-json.ts and shared/pin-naming.ts). Legacy files are
// still accepted on read so they don't need hand-migration; regenerating (e.g. via xml2dsl) upgrades
// them to the current v11 shape.
const LEGACY_V10_FORMAT_VERSION = "stormworks-project-json-v10";

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

  if (formatVersion === LEGACY_V10_FORMAT_VERSION) {
    return parseLegacyV10Document(root);
  }

  if (formatVersion !== STORMWORKS_PROJECT_JSON_FORMAT_VERSION) {
    throw new ProjectJsonParseError(
      `Unsupported project format version ${formatVersion}; expected ${STORMWORKS_PROJECT_JSON_FORMAT_VERSION} (or legacy ${LEGACY_V10_FORMAT_VERSION})`,
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
    icon: parseIconOrNull(root.icon, "$.icon"),
    nodes: expectArray(root.nodes, "$.nodes").map((value, index) =>
      parseProjectJsonNode(value, `$.nodes[${index}]`),
    ),
    submodule: optionalSubmodule(root.submodule, "$.submodule"),
    warnings: expectArray(root.warnings, "$.warnings").map((value, index) =>
      expectString(value, `$.warnings[${index}]`),
    ),
  };
}

// Parse a legacy v10 document. `submodules` was an array (v10 tooling only ever wrote 0 or 1
// entries; extras are kept as a warning rather than an error), and the separate `links`/`constants`
// arrays are read but discarded -- they carried connectivity project.json no longer represents that
// way (see serializers/project-json.ts).
function parseLegacyV10Document(root: Record<string, unknown>): ProjectJsonDocument {
  const legacySubmodules = expectArray(root.submodules, "$.submodules").map((value, index) =>
    parseLegacyV10Submodule(value, `$.submodules[${index}]`),
  );
  const warnings = expectArray(root.warnings, "$.warnings").map((value, index) =>
    expectString(value, `$.warnings[${index}]`),
  );

  if (legacySubmodules.length > 1) {
    warnings.push(
      `project.json declared ${legacySubmodules.length} submodules under the legacy v10 format; only the first (${legacySubmodules[0]?.name}) is kept.`,
    );
  }

  warnings.push(
    `project.json uses the legacy ${LEGACY_V10_FORMAT_VERSION} format (links/constants/submodules[]); regenerate it (e.g. via xml2dsl) to migrate to ${STORMWORKS_PROJECT_JSON_FORMAT_VERSION}.`,
  );

  return {
    formatVersion: STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
    sourceName: optionalString(root.sourceName, "$.sourceName"),
    name: optionalStringOrNull(root.name, "$.name"),
    description: optionalStringOrNull(root.description, "$.description"),
    width: optionalFiniteNumberOrNull(root.width, "$.width"),
    length: optionalFiniteNumberOrNull(root.length, "$.length"),
    icon: parseIconOrNull(root.icon, "$.icon"),
    nodes: expectArray(root.nodes, "$.nodes").map((value, index) =>
      parseProjectJsonNode(value, `$.nodes[${index}]`),
    ),
    submodule: legacySubmodules[0] ?? null,
    warnings,
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

// Parse an optional submodule reference that may be absent or explicitly null.
function optionalSubmodule(input: unknown, path: string): ProjectJsonSubmoduleDocument | null {
  if (input === undefined || input === null) {
    return null;
  }

  return parseProjectJsonSubmodule(input, path);
}

// Parse one submodule reference entry from project.json.
function parseProjectJsonSubmodule(input: unknown, path: string): ProjectJsonSubmoduleDocument {
  const record = expectRecord(input, path);

  return {
    name: expectString(record.name, `${path}.name`),
    relativePath: expectString(record.relativePath, `${path}.relativePath`),
  };
}

// Parse one legacy v10 submodule entry. The "id" and "position" keys may still be present but are
// intentionally not read: "id" always duplicated "name", and "position" was always {0,0}.
function parseLegacyV10Submodule(input: unknown, path: string): ProjectJsonSubmoduleDocument {
  const record = expectRecord(input, path);

  return {
    name: expectString(record.name, `${path}.name`),
    relativePath: expectString(record.relativePath, `${path}.relativePath`),
  };
}

// Shared JSON guards remove parser-to-parser copy/paste while this file keeps the
// nullable project.json conventions close to their call sites.
const parseVector2 = (input: unknown, path: string) => parseVector2With(input, path, ProjectJsonParseError);

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

// Parse the optional 16x16 "#"/"." icon (see shared/microprocessor-icon.ts for the row/bit layout).
function parseIconOrNull(input: unknown, path: string): string[] | null {
  if (input === undefined || input === null) {
    return null;
  }

  if (!isValidMicroprocessorIconShape(input)) {
    throw new ProjectJsonParseError("Expected 16 rows of 16 \"#\"/\".\" characters", path);
  }

  return input;
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
