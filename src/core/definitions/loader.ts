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

export function parseNodeDefinitionsJson(jsonText: string): NodeDefinitionsDocument {
  return parseNodeDefinitionsDocument(JSON.parse(jsonText));
}

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

export function loadNodeDefinitionsDocument(input: unknown): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(parseNodeDefinitionsDocument(input));
}

export function loadNodeDefinitionsJson(jsonText: string): NodeDefinitionRegistry {
  return createNodeDefinitionRegistry(parseNodeDefinitionsJson(jsonText));
}

export function createProjectNodeStormworksKey(type: string, mode?: string): string {
  return `${type}:${mode ?? "0"}`;
}

export function findProjectNodeDefinition(
  registry: NodeDefinitionRegistry,
  type: string,
  mode?: string,
): ProjectNodeDefinition | undefined {
  return registry.nodeByStormworksKey.get(createProjectNodeStormworksKey(type, mode));
}

export function findComponentDefinitionByStormworksType(
  registry: NodeDefinitionRegistry,
  type: string,
): ComponentDefinition | undefined {
  return registry.componentByStormworksType.get(type);
}

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

function registerComponentDefinition(
  componentByStormworksType: Map<string, ComponentDefinition>,
  definition: ComponentDefinition,
): void {
  if (componentByStormworksType.has(definition.stormworks.type)) {
    throw new Error(`Duplicate Stormworks component definition: ${definition.stormworks.type}`);
  }

  componentByStormworksType.set(definition.stormworks.type, definition);
}
