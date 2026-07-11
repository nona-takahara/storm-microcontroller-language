// Browser-safe access to the bundled sample definitions shipped with the package.
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

// Create a fresh definitions registry from the bundled definitions document.
export function createBundledNodeDefinitions(): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(bundledNodeDefinitionsDocument);
}
