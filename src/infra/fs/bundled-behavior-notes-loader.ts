// Node-side helper that resolves and loads the bundled behavior-notes JSON files from the built package.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseNodeBehaviorNotesDocument,
  parseStormworksSystemNotesDocument,
  type NodeBehaviorNotesDocument,
  type StormworksSystemNotesDocument,
} from "../../core/behavior-notes/schema.js";
import { readUtf8TextFile } from "./text-file.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledNodeBehaviorNotesPath = resolve(moduleDir, "../../node-behavior-notes.json");
const bundledStormworksSystemNotesPath = resolve(moduleDir, "../../stormworks-system-notes.json");

// Return the resolved on-disk path of the bundled gate behavior-notes file.
export function getBundledNodeBehaviorNotesPath(): string {
  return bundledNodeBehaviorNotesPath;
}

// Return the resolved on-disk path of the bundled Stormworks system-notes file.
export function getBundledStormworksSystemNotesPath(): string {
  return bundledStormworksSystemNotesPath;
}

// Load and parse the bundled gate behavior-notes file from disk.
export async function loadBundledNodeBehaviorNotes(): Promise<NodeBehaviorNotesDocument> {
  const text = await readUtf8TextFile(bundledNodeBehaviorNotesPath);
  return parseNodeBehaviorNotesDocument(JSON.parse(text));
}

// Load and parse the bundled Stormworks system-notes file from disk.
export async function loadBundledStormworksSystemNotes(): Promise<StormworksSystemNotesDocument> {
  const text = await readUtf8TextFile(bundledStormworksSystemNotesPath);
  return parseStormworksSystemNotesDocument(JSON.parse(text));
}
