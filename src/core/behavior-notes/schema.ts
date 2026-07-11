// Lightweight schema for the hand-curated gate/system behavior-notes knowledge base.
// These are internal bundled assets (not user-supplied input), so validation here is
// intentionally lighter than definitions/schema.ts's fully recursive validator.
import {
  expectArrayWith,
  expectIntegerWith,
  expectRecordWith,
  expectStringWith,
} from "../shared/json-schema-helpers.js";

export const NODE_BEHAVIOR_NOTES_SCHEMA_VERSION = "1";
export const STORMWORKS_SYSTEM_NOTES_SCHEMA_VERSION = "1";

export type BehaviorNoteConfidence = "verified" | "inferred" | "unconfirmed";

export interface BehaviorNote {
  category?: string;
  text: string;
  confidence?: BehaviorNoteConfidence;
  source?: string;
}

export type BehaviorNoteStatus = "todo" | "done";

export interface GateBehaviorEntry {
  displayName: string;
  category: string;
  status: BehaviorNoteStatus;
  relatedIssues: number[];
  notes: BehaviorNote[];
}

export interface NodeBehaviorNotesDocument {
  schemaVersion: string;
  generatedFrom: string;
  entries: Record<string, GateBehaviorEntry>;
}

export interface SystemTopicEntry {
  title: string;
  status: BehaviorNoteStatus;
  relatedIssues: number[];
  notes: BehaviorNote[];
}

export interface StormworksSystemNotesDocument {
  schemaVersion: string;
  description: string;
  entries: Record<string, SystemTopicEntry>;
}

export class BehaviorNotesSchemaError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "BehaviorNotesSchemaError";
  }
}

// Parse the gate-level behavior notes document (src/node-behavior-notes.json).
export function parseNodeBehaviorNotesDocument(input: unknown): NodeBehaviorNotesDocument {
  const root = expectRecord(input, "$");
  const entriesRecord = expectRecord(root.entries, "$.entries");
  const entries: Record<string, GateBehaviorEntry> = {};

  for (const [id, value] of Object.entries(entriesRecord)) {
    entries[id] = parseGateBehaviorEntry(value, `$.entries.${id}`);
  }

  return {
    schemaVersion: expectString(root.schemaVersion, "$.schemaVersion"),
    generatedFrom: expectString(root.generatedFrom, "$.generatedFrom"),
    entries,
  };
}

// Parse the platform-wide system notes document (src/stormworks-system-notes.json).
export function parseStormworksSystemNotesDocument(input: unknown): StormworksSystemNotesDocument {
  const root = expectRecord(input, "$");
  const entriesRecord = expectRecord(root.entries, "$.entries");
  const entries: Record<string, SystemTopicEntry> = {};

  for (const [id, value] of Object.entries(entriesRecord)) {
    entries[id] = parseSystemTopicEntry(value, `$.entries.${id}`);
  }

  return {
    schemaVersion: expectString(root.schemaVersion, "$.schemaVersion"),
    description: expectString(root.description, "$.description"),
    entries,
  };
}

function parseGateBehaviorEntry(input: unknown, path: string): GateBehaviorEntry {
  const record = expectRecord(input, path);

  return {
    displayName: expectString(record.displayName, `${path}.displayName`),
    category: expectString(record.category, `${path}.category`),
    status: parseStatus(record.status, `${path}.status`),
    relatedIssues: expectArray(record.relatedIssues, `${path}.relatedIssues`).map((value, index) =>
      expectInteger(value, `${path}.relatedIssues[${index}]`),
    ),
    notes: expectArray(record.notes, `${path}.notes`).map((value, index) => parseBehaviorNote(value, `${path}.notes[${index}]`)),
  };
}

function parseSystemTopicEntry(input: unknown, path: string): SystemTopicEntry {
  const record = expectRecord(input, path);

  return {
    title: expectString(record.title, `${path}.title`),
    status: parseStatus(record.status, `${path}.status`),
    relatedIssues: expectArray(record.relatedIssues, `${path}.relatedIssues`).map((value, index) =>
      expectInteger(value, `${path}.relatedIssues[${index}]`),
    ),
    notes: expectArray(record.notes, `${path}.notes`).map((value, index) => parseBehaviorNote(value, `${path}.notes[${index}]`)),
  };
}

function parseBehaviorNote(input: unknown, path: string): BehaviorNote {
  const record = expectRecord(input, path);

  return {
    category: record.category === undefined ? undefined : expectString(record.category, `${path}.category`),
    text: expectString(record.text, `${path}.text`),
    confidence: record.confidence === undefined ? undefined : parseConfidence(record.confidence, `${path}.confidence`),
    source: record.source === undefined ? undefined : expectString(record.source, `${path}.source`),
  };
}

function parseStatus(input: unknown, path: string): BehaviorNoteStatus {
  const value = expectString(input, path);

  if (value === "todo" || value === "done") {
    return value;
  }

  throw new BehaviorNotesSchemaError("Expected one of todo | done", path);
}

function parseConfidence(input: unknown, path: string): BehaviorNoteConfidence {
  const value = expectString(input, path);

  if (value === "verified" || value === "inferred" || value === "unconfirmed") {
    return value;
  }

  throw new BehaviorNotesSchemaError("Expected one of verified | inferred | unconfirmed", path);
}

// Behavior-notes validation is intentionally shallow, but still uses the same
// low-level guard helpers as the stricter public-input schemas to avoid drift.
const expectRecord = (input: unknown, path: string) =>
  expectRecordWith(input, path, BehaviorNotesSchemaError, "Expected an object");
const expectArray = (input: unknown, path: string) =>
  expectArrayWith(input, path, BehaviorNotesSchemaError, "Expected an array");
const expectString = (input: unknown, path: string) =>
  expectStringWith(input, path, BehaviorNotesSchemaError, "Expected a string");
const expectInteger = (input: unknown, path: string) =>
  expectIntegerWith(input, path, BehaviorNotesSchemaError, "Expected an integer");
