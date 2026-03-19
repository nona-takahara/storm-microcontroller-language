import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { loadNodeDefinitionsFromFile } from "./definitions-file-loader.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledDefinitionsPath = resolve(moduleDir, "../../definitions.json");

export function getBundledDefinitionsPath(): string {
  return bundledDefinitionsPath;
}

export async function loadBundledNodeDefinitions(): Promise<NodeDefinitionRegistry> {
  return loadNodeDefinitionsFromFile(bundledDefinitionsPath);
}
