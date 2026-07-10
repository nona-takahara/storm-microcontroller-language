// Node-side helper that resolves and loads the bundled definitions.json file from the built package.
import {
  NODE_DEFINITIONS_SCHEMA_VERSION,
  parseNodeDefinitionsDocument,
} from "../../core/definitions/schema.js";
import { createNodeDefinitionRegistry, type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { getBundledJsonPath, loadBundledJson } from "./bundled-json-loader.js";

const DEFINITIONS_FILE = "definitions.json";

export function getBundledDefinitionsPath(): string {
  return getBundledJsonPath(DEFINITIONS_FILE);
}

export async function loadBundledNodeDefinitions(): Promise<NodeDefinitionRegistry> {
  const document = await loadBundledJson(
    DEFINITIONS_FILE,
    parseNodeDefinitionsDocument,
    NODE_DEFINITIONS_SCHEMA_VERSION,
  );
  return createNodeDefinitionRegistry(document);
}
