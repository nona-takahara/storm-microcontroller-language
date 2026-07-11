// Node-side helper that resolves and loads the bundled behavior-notes JSON files from the built package.
import {
  NODE_BEHAVIOR_NOTES_SCHEMA_VERSION,
  STORMWORKS_SYSTEM_NOTES_SCHEMA_VERSION,
  parseNodeBehaviorNotesDocument,
  parseStormworksSystemNotesDocument,
  type NodeBehaviorNotesDocument,
  type StormworksSystemNotesDocument,
} from "../../core/behavior-notes/schema.js";
import { getBundledJsonPath, loadBundledJson } from "./bundled-json-loader.js";

const NODE_BEHAVIOR_NOTES_FILE = "node-behavior-notes.json";
const STORMWORKS_SYSTEM_NOTES_FILE = "stormworks-system-notes.json";

export function getBundledNodeBehaviorNotesPath(): string {
  return getBundledJsonPath(NODE_BEHAVIOR_NOTES_FILE);
}

export function getBundledStormworksSystemNotesPath(): string {
  return getBundledJsonPath(STORMWORKS_SYSTEM_NOTES_FILE);
}

export async function loadBundledNodeBehaviorNotes(): Promise<NodeBehaviorNotesDocument> {
  return loadBundledJson(
    NODE_BEHAVIOR_NOTES_FILE,
    parseNodeBehaviorNotesDocument,
    NODE_BEHAVIOR_NOTES_SCHEMA_VERSION,
  );
}

export async function loadBundledStormworksSystemNotes(): Promise<StormworksSystemNotesDocument> {
  return loadBundledJson(
    STORMWORKS_SYSTEM_NOTES_FILE,
    parseStormworksSystemNotesDocument,
    STORMWORKS_SYSTEM_NOTES_SCHEMA_VERSION,
  );
}
