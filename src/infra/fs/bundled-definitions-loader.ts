// Node-side helper that resolves and loads the bundled definitions.json file from the built package.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { loadNodeDefinitionsFromFile } from "./definitions-file-loader.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledDefinitionsPath = resolve(moduleDir, "../../definitions.json");

// Return the resolved on-disk path of the bundled definitions file.
export function getBundledDefinitionsPath(): string {
  return bundledDefinitionsPath;
}

// Load the bundled definitions file from disk into the indexed registry format.
export async function loadBundledNodeDefinitions(): Promise<NodeDefinitionRegistry> {
  return loadNodeDefinitionsFromFile(bundledDefinitionsPath);
}
