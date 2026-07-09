// Lightweight schema for the hand-curated gate/system behavior-notes knowledge base.
// These are internal bundled assets (not user-supplied input), so validation here is
// intentionally lighter than definitions/schema.ts's fully recursive validator.

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
  focusHints: string[];
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
  focusHints: string[];
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
    focusHints: expectArray(record.focusHints, `${path}.focusHints`).map((value, index) =>
      expectString(value, `${path}.focusHints[${index}]`),
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
    focusHints: expectArray(record.focusHints, `${path}.focusHints`).map((value, index) =>
      expectString(value, `${path}.focusHints[${index}]`),
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

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new BehaviorNotesSchemaError("Expected an object", path);
}

function expectArray(input: unknown, path: string): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  throw new BehaviorNotesSchemaError("Expected an array", path);
}

function expectString(input: unknown, path: string): string {
  if (typeof input === "string") {
    return input;
  }

  throw new BehaviorNotesSchemaError("Expected a string", path);
}

function expectInteger(input: unknown, path: string): number {
  if (typeof input === "number" && Number.isInteger(input)) {
    return input;
  }

  throw new BehaviorNotesSchemaError("Expected an integer", path);
}
