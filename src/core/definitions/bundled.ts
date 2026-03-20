import bundledDefinitionsJson from "../../definitions.json" with { type: "json" };

import {
  createNodeDefinitionRegistry,
  type NodeDefinitionRegistry,
} from "./loader.js";
import {
  parseNodeDefinitionsDocument,
  type NodeDefinitionsDocument,
} from "./schema.js";

export const bundledNodeDefinitionsDocument: NodeDefinitionsDocument =
  parseNodeDefinitionsDocument(bundledDefinitionsJson);

export function createBundledNodeDefinitions(): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(bundledNodeDefinitionsDocument);
}
