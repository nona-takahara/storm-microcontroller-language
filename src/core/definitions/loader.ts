// Definitions registry helpers that validate, index, and resolve project/component definitions for the toolchain.
import {
  NODE_DEFINITIONS_SCHEMA_VERSION,
  type ComponentDefinition,
  type NodeDefinitionsDocument,
  type ProjectNodeDefinition,
  parseNodeDefinitionsDocument,
} from "./schema.js";

export interface NodeDefinitionRegistry {
  schemaVersion: string;
  nodes: ProjectNodeDefinition[];
  components: ComponentDefinition[];
  byId: Map<string, ProjectNodeDefinition | ComponentDefinition>;
  nodeByStormworksKey: Map<string, ProjectNodeDefinition>;
  componentByStormworksType: Map<string, ComponentDefinition>;
}

// Parse JSON text into the raw definitions document shape before registry indexing.
export function parseNodeDefinitionsJson(jsonText: string): NodeDefinitionsDocument {
  return parseNodeDefinitionsDocument(JSON.parse(jsonText));
}

// Build the indexed definitions registry used by importers, serializers, and validators.
export function createNodeDefinitionRegistry(document: NodeDefinitionsDocument): NodeDefinitionRegistry {
  if (document.schemaVersion !== NODE_DEFINITIONS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported node definition schema version: ${document.schemaVersion}. Expected ${NODE_DEFINITIONS_SCHEMA_VERSION}.`,
    );
  }

  const byId = new Map<string, ProjectNodeDefinition | ComponentDefinition>();
  const nodeByStormworksKey = new Map<string, ProjectNodeDefinition>();
  const componentByStormworksType = new Map<string, ComponentDefinition>();

  for (const node of document.nodes) {
    if (byId.has(node.id)) {
      throw new Error(`Duplicate node definition id: ${node.id}`);
    }

    byId.set(node.id, node);
    registerProjectNodeDefinition(nodeByStormworksKey, node);
  }

  for (const component of document.components) {
    if (byId.has(component.id)) {
      throw new Error(`Duplicate node definition id: ${component.id}`);
    }

    byId.set(component.id, component);
    registerComponentDefinition(componentByStormworksType, component);
  }

  return {
    schemaVersion: document.schemaVersion,
    nodes: document.nodes,
    components: document.components,
    byId,
    nodeByStormworksKey,
    componentByStormworksType,
  };
}

// Parse an unknown in-memory value and immediately index it as a definitions registry.
export function loadNodeDefinitionsDocument(input: unknown): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(parseNodeDefinitionsDocument(input));
}

// Parse JSON text and immediately index it as a definitions registry.
export function loadNodeDefinitionsJson(jsonText: string): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(parseNodeDefinitionsJson(jsonText));
}

// Build the normalized Stormworks lookup key used for project-node definitions.
export function createProjectNodeStormworksKey(type: string, mode?: string): string {
  return `${type}:${mode ?? "0"}`;
}

// Look up a project-node definition by the raw Stormworks type/mode pair.
export function findProjectNodeDefinition(
  registry: NodeDefinitionRegistry,
  type: string,
  mode?: string,
): ProjectNodeDefinition | undefined {
  return registry.nodeByStormworksKey.get(createProjectNodeStormworksKey(type, mode));
}

// Look up a component definition by the raw Stormworks component type code.
export function findComponentDefinitionByStormworksType(
  registry: NodeDefinitionRegistry,
  type: string,
): ComponentDefinition | undefined {
  return registry.componentByStormworksType.get(type);
}

// Resolve a component definition from either DSL ids, generic wrapper ids, or raw Stormworks type ids.
export function findCompatibleComponentDefinition(
  registry: NodeDefinitionRegistry,
  typeId: string,
): ComponentDefinition | undefined {
  const direct = registry.byId.get(typeId);

  if (direct && "stormworks" in direct && direct.category !== "project") {
    return direct as ComponentDefinition;
  }

  const byStormworksType = registry.componentByStormworksType.get(typeId);

  if (byStormworksType) {
    return byStormworksType;
  }

  const wrappedStormworksType = extractCompatibleStormworksType(typeId);

  if (!wrappedStormworksType) {
    return undefined;
  }

  return registry.componentByStormworksType.get(wrappedStormworksType);
}

// Extract a raw Stormworks type code from supported generic component id spellings.
export function extractCompatibleStormworksType(typeId: string): string | undefined {
  if (/^\d+$/.test(typeId)) {
    return typeId;
  }

  const wrappedMatch = /^LOGIC_COMPONENT_(\d+)$/.exec(typeId);

  if (wrappedMatch?.[1]) {
    return wrappedMatch[1];
  }

  const importedMatch = /^LOGIC_COMPONENT:(\d+)$/.exec(typeId);

  if (importedMatch?.[1]) {
    return importedMatch[1];
  }

  return undefined;
}

// Register one project-node definition into the Stormworks key index with duplicate checking.
function registerProjectNodeDefinition(
  nodeByStormworksKey: Map<string, ProjectNodeDefinition>,
  definition: ProjectNodeDefinition,
): void {
  const key = createProjectNodeStormworksKey(definition.stormworks.type, definition.stormworks.mode);

  if (nodeByStormworksKey.has(key)) {
    throw new Error(`Duplicate Stormworks node definition: ${key}`);
  }

  nodeByStormworksKey.set(key, definition);
}

// Register one component definition into the raw Stormworks type index with duplicate checking.
function registerComponentDefinition(
  componentByStormworksType: Map<string, ComponentDefinition>,
  definition: ComponentDefinition,
): void {
  if (componentByStormworksType.has(definition.stormworks.type)) {
    throw new Error(`Duplicate Stormworks component definition: ${definition.stormworks.type}`);
  }

  componentByStormworksType.set(definition.stormworks.type, definition);
}
