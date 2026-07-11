// Node-side helper that loads an external definitions.json file into the indexed registry format.
import { loadNodeDefinitionsJson, type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { readUtf8TextFile } from "./text-file.js";

// Read and parse one definitions.json file from disk.
export async function loadNodeDefinitionsFromFile(filePath: string): Promise<NodeDefinitionRegistry> {
  const jsonText = await readUtf8TextFile(filePath);
  return loadNodeDefinitionsJson(jsonText);
}
