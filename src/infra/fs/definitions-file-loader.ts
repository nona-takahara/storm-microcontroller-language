import { loadNodeDefinitionsJson, type NodeDefinitionRegistry } from "../../core/definitions/loader.js";
import { readUtf8TextFile } from "./text-file.js";

export async function loadNodeDefinitionsFromFile(filePath: string): Promise<NodeDefinitionRegistry> {
  const jsonText = await readUtf8TextFile(filePath);
  return loadNodeDefinitionsJson(jsonText);
}
