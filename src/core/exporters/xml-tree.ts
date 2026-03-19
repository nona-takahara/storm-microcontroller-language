import { type NodeDefinitionRegistry } from "../definitions/loader.js";
import {
  type ComponentDefinition,
  type DefinitionValueType,
  type NodePropertyDefinition,
  type NodePropertyWriteTarget,
  type ProjectNodeDefinition,
} from "../definitions/schema.js";
import { type IrSignalKind, type IrScalarValue, type IrVector2 } from "../ir.js";
import { type SwNetAssignment, type SwNetExpression, type SwNetInstStatement } from "../parsers/sw-net.js";
import { type ProjectJsonDocument, type ProjectJsonLinkDocument, type ProjectJsonNodeDocument } from "../serializers/project-json.js";
import { type StormworksSwMclDocument, type SwMclModuleDocument } from "../serializers/sw-mcl.js";
import { type SwNetResolutionResult, type SwNetResolvedModule, type SwNetResolvedModuleKey } from "../resolvers/sw-net.js";

export type StormworksXmlTreeScalar = string | number | boolean | null;
export type StormworksXmlTreeValue = StormworksXmlTreeScalar | StormworksXmlTreeElement | StormworksXmlTreeValue[];

export interface StormworksXmlTreeElement {
  [key: string]: StormworksXmlTreeValue;
}

export interface StormworksXmlTreeDocument {
  microprocessor: StormworksXmlTreeElement;
}

export interface BuildStormworksXmlTreeOptions {
  definitions: NodeDefinitionRegistry;
  entryModuleId?: string;
  resolveScriptText?: (scriptRef: string, context: StormworksXmlScriptResolveContext) => string | undefined;
}

export interface StormworksXmlScriptResolveContext {
  moduleId: string;
  instanceId: string;
  typeId: string;
}

export interface BuildStormworksXmlTreeInput {
  project: ProjectJsonDocument;
  swNet: SwNetResolutionResult;
  swMcl: StormworksSwMclDocument;
}

export interface BuildStormworksXmlTreeResult {
  tree: StormworksXmlTreeDocument;
  warnings: string[];
}

interface ProjectNodeContext {
  document: ProjectJsonNodeDocument;
  definition: ProjectNodeDefinition;
  xmlNodeId: number;
  componentId: number;
  direction: "input" | "output";
  signal: IrSignalKind;
}

interface ModulePortSlot {
  key: string;
  name: string;
  direction: "in" | "out";
  signal: IrSignalKind;
  occurrence: number;
  position?: IrVector2;
}

interface LogicInstanceContext {
  statement: SwNetInstStatement;
  definition?: ComponentDefinition;
  stormworksType: string;
  objectId: number;
  position?: IrVector2;
}

interface NetProducer {
  instance: LogicInstanceContext;
  outputKey: string;
}

interface ProjectPortBindingContext {
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>;
  projectNodeByPortKey: Map<string, ProjectNodeContext>;
}

interface XmlIdAllocator {
  allocate(preferred?: number): number;
  max(): number;
}

const DEFAULT_GROUP_DATA_TYPE = "-1104064832";

export function buildStormworksXmlTree(
  input: BuildStormworksXmlTreeInput,
  options: BuildStormworksXmlTreeOptions,
): BuildStormworksXmlTreeResult {
  const warnings: string[] = [];
  const entryModule = resolveEntryModule(input.swNet, options.entryModuleId);
  ensureEntryModuleCanBeLowered(entryModule, input.swNet);

  const swMclModule = resolveSwMclModule(input.swMcl, entryModule.key.moduleId);
  const allocator = createXmlIdAllocator([]);
  const logicInstances = buildLogicInstanceContexts(
    entryModule.module.statements,
    swMclModule,
    options.definitions,
    allocator,
    warnings,
  );
  const projectNodes = buildProjectNodeContexts(input.project, options.definitions, allocator);
  const projectPortBindings = bindProjectNodesToModulePorts(
    input.project.links,
    projectNodes,
    buildModulePortSlots(entryModule.module, swMclModule, warnings),
    entryModule.key.moduleId,
    warnings,
  );
  const netProducerByName = buildNetProducerIndex(logicInstances, warnings);
  const projectOutputBindings = buildProjectOutputBindingIndex(logicInstances);
  const projectNodeElements = projectNodes.map((projectNode) => buildProjectNodeElement(projectNode));
  const componentElements = logicInstances.map((instance) =>
    buildComponentElement(
      instance,
      netProducerByName,
      projectPortBindings.projectNodeByPortKey,
      warnings,
      options,
      entryModule.key.moduleId,
    ),
  );
  const componentStateElements = buildComponentStateElements(componentElements);
  const bridgeStateElements = buildBridgeStateElements(
    projectNodes,
    projectPortBindings.portSlotsByProjectNodeId,
    projectOutputBindings,
    warnings,
  );
  const idCounter = Math.max(allocator.max(), ...projectNodes.map((projectNode) => projectNode.componentId));
  const idCounterNode = projectNodes.reduce((max, projectNode) => Math.max(max, projectNode.xmlNodeId), 0);

  return {
    tree: {
      microprocessor: buildMicroprocessorElement(
        input.project,
        projectNodeElements,
        componentElements,
        componentStateElements,
        bridgeStateElements,
        idCounter,
        idCounterNode,
      ),
    },
    warnings,
  };
}

function resolveEntryModule(
  swNet: SwNetResolutionResult,
  entryModuleId: string | undefined,
): SwNetResolvedModule {
  const entryDocument = swNet.documents.find((document) => document.path === swNet.entryDocumentPath);

  if (!entryDocument) {
    throw new Error(`Entry sw-net document ${swNet.entryDocumentPath} was not loaded.`);
  }

  const resolvedModuleId =
    entryModuleId ??
    entryDocument.document.modules.find((module) => module.id === "main")?.id ??
    (entryDocument.document.modules.length === 1 ? entryDocument.document.modules[0]?.id : undefined);

  if (!resolvedModuleId) {
    throw new Error(
      "Could not determine the entry module. Pass entryModuleId when the document does not define module main.",
    );
  }

  const resolvedModule = swNet.modules.find(
    (module) =>
      module.key.documentPath === swNet.entryDocumentPath &&
      module.key.moduleId === resolvedModuleId,
  );

  if (!resolvedModule) {
    throw new Error(`Entry module ${resolvedModuleId} was not resolved from ${swNet.entryDocumentPath}.`);
  }

  return resolvedModule;
}

function ensureEntryModuleCanBeLowered(
  entryModule: SwNetResolvedModule,
  swNet: SwNetResolutionResult,
): void {
  const moduleByKey = new Map(swNet.modules.map((module) => [formatModuleKey(module.key), module] as const));
  const visited = new Set<string>();
  const pending: SwNetResolvedModuleKey[] = [entryModule.key];

  while (pending.length > 0) {
    const current = pending.pop();

    if (!current) {
      continue;
    }

    const key = formatModuleKey(current);

    if (visited.has(key)) {
      continue;
    }

    visited.add(key);

    const resolvedModule = moduleByKey.get(key);

    if (!resolvedModule) {
      continue;
    }

    if (resolvedModule.uses.length > 0) {
      throw new Error(
        "XML tree reconstruction currently supports only flat entry modules and does not yet lower use statements.",
      );
    }

    for (const use of resolvedModule.uses) {
      pending.push(use.target);
    }
  }
}

function resolveSwMclModule(
  swMcl: StormworksSwMclDocument,
  moduleId: string,
): SwMclModuleDocument {
  const moduleDocument = swMcl.modules.find((module) => module.id === moduleId);

  if (!moduleDocument) {
    throw new Error(`sw-mcl layout does not contain module ${moduleId}.`);
  }

  return moduleDocument;
}

function collectPreferredLogicObjectIds(statements: SwNetResolvedModule["module"]["statements"]): number[] {
  const ids: number[] = [];

  for (const statement of statements) {
    if (statement.kind !== "inst") {
      continue;
    }

    const preferred = tryParseInstanceObjectId(statement.instanceId);

    if (preferred !== undefined) {
      ids.push(preferred);
    }
  }

  return ids;
}

function createXmlIdAllocator(preferredIds: number[]): XmlIdAllocator {
  const used = new Set<number>(preferredIds.filter((value) => value > 0));
  let nextCandidate = 1;

  return {
    allocate(preferred?: number): number {
      if (preferred !== undefined && preferred > 0 && !used.has(preferred)) {
        used.add(preferred);
        return preferred;
      }

      while (used.has(nextCandidate)) {
        nextCandidate += 1;
      }

      const allocated = nextCandidate;
      used.add(allocated);
      nextCandidate += 1;
      return allocated;
    },
    max(): number {
      return used.size === 0 ? 0 : Math.max(...used);
    },
  };
}

function buildProjectNodeContexts(
  project: ProjectJsonDocument,
  definitions: NodeDefinitionRegistry,
  allocator: XmlIdAllocator,
): ProjectNodeContext[] {
  let nextXmlNodeId = 1;

  return project.nodes.map((node) => {
    const definition = definitions.byId.get(node.type);

    if (!definition || !("stormworks" in definition) || definition.category !== "project") {
      throw new Error(`Project node type ${node.type} is not defined in definitions.json.`);
    }

    const projectDefinition = definition as ProjectNodeDefinition;
    const direction = projectDefinition.ports.outputs.length > 0 ? "input" : "output";
    const signal =
      direction === "input"
        ? (projectDefinition.ports.outputs[0]?.signal ?? "unknown")
        : (projectDefinition.ports.inputs[0]?.signal ?? "unknown");

    return {
      document: node,
      definition: projectDefinition,
      xmlNodeId: nextXmlNodeId++,
      componentId: allocator.allocate(),
      direction,
      signal,
    };
  });
}

function buildModulePortSlots(
  entryModule: SwNetResolvedModule["module"],
  swMclModule: SwMclModuleDocument,
  warnings: string[],
): ModulePortSlot[] {
  const occurrenceByKey = new Map<string, number>();
  const positionByKey = new Map(
    swMclModule.ports.map((port) => [formatPortOccurrenceKey(port.direction, port.name, port.occurrence), port.position] as const),
  );

  return entryModule.ports.map((port) => {
    const occurrenceKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByKey.get(occurrenceKey) ?? 0) + 1;
    occurrenceByKey.set(occurrenceKey, occurrence);
    const key = formatPortOccurrenceKey(port.direction, port.name, occurrence);
    const position = positionByKey.get(key);

    if (!position) {
      warnings.push(`sw-mcl is missing a port layout entry for ${key}.`);
    }

    return {
      key,
      name: port.name,
      direction: port.direction,
      signal: port.signal,
      occurrence,
      position,
    };
  });
}

function bindProjectNodesToModulePorts(
  links: ProjectJsonLinkDocument[],
  projectNodes: ProjectNodeContext[],
  portSlots: ModulePortSlot[],
  entryModuleId: string,
  warnings: string[],
): ProjectPortBindingContext {
  const projectNodeById = new Map(projectNodes.map((node) => [node.document.id, node] as const));
  const portSlotsByName = new Map<string, ModulePortSlot[]>();
  const pendingProjectNodesByPort = new Map<string, ProjectNodeContext[]>();
  const portSlotsByProjectNodeId = new Map<string, ModulePortSlot>();
  const projectNodeByPortKey = new Map<string, ProjectNodeContext>();

  for (const portSlot of portSlots) {
    const key = formatPortNameKey(portSlot.direction, portSlot.name);
    const list = portSlotsByName.get(key);

    if (list) {
      list.push(portSlot);
      continue;
    }

    portSlotsByName.set(key, [portSlot]);
  }

  for (const link of links) {
    const binding = resolveProjectPortLink(link, projectNodeById, entryModuleId);

    if (!binding) {
      continue;
    }

    const key = formatPortNameKey(binding.direction, binding.portName);
    const list = pendingProjectNodesByPort.get(key);

    if (list) {
      list.push(binding.projectNode);
      continue;
    }

    pendingProjectNodesByPort.set(key, [binding.projectNode]);
  }

  for (const [key, boundProjectNodes] of pendingProjectNodesByPort) {
    const slots = portSlotsByName.get(key) ?? [];

    if (slots.length !== boundProjectNodes.length) {
      warnings.push(`Project links reference ${boundProjectNodes.length} ${key} port(s), but sw-net defines ${slots.length}.`);
    }

    const count = Math.min(slots.length, boundProjectNodes.length);

    for (let index = 0; index < count; index += 1) {
      const slot = slots[index];
      const projectNode = boundProjectNodes[index];

      if (!slot || !projectNode) {
        continue;
      }

      portSlotsByProjectNodeId.set(projectNode.document.id, slot);

      if (projectNodeByPortKey.has(formatPortNameKey(slot.direction, slot.name))) {
        warnings.push(
          `Multiple project nodes map to ${formatPortNameKey(slot.direction, slot.name)}; later matches may be ambiguous.`,
        );
      }

      projectNodeByPortKey.set(formatPortNameKey(slot.direction, slot.name), projectNode);
    }
  }

  return {
    portSlotsByProjectNodeId,
    projectNodeByPortKey,
  };
}

function resolveProjectPortLink(
  link: ProjectJsonLinkDocument,
  projectNodeById: Map<string, ProjectNodeContext>,
  entryModuleId: string,
): { projectNode: ProjectNodeContext; direction: "in" | "out"; portName: string } | undefined {
  if (link.from.kind === "node" && link.to.kind === "submodule_port" && link.to.submodule === entryModuleId) {
    const projectNode = link.from.id ? projectNodeById.get(link.from.id) : undefined;
    const portName = link.to.port;

    if (!projectNode || !portName) {
      return undefined;
    }

    return {
      projectNode,
      direction: "in",
      portName,
    };
  }

  if (link.from.kind === "submodule_port" && link.from.submodule === entryModuleId && link.to.kind === "node") {
    const projectNode = link.to.id ? projectNodeById.get(link.to.id) : undefined;
    const portName = link.from.port;

    if (!projectNode || !portName) {
      return undefined;
    }

    return {
      projectNode,
      direction: "out",
      portName,
    };
  }

  return undefined;
}

function buildLogicInstanceContexts(
  statements: SwNetResolvedModule["module"]["statements"],
  swMclModule: SwMclModuleDocument,
  definitions: NodeDefinitionRegistry,
  allocator: XmlIdAllocator,
  warnings: string[],
): LogicInstanceContext[] {
  const positionsById = new Map(swMclModule.instances.map((instance) => [instance.id, instance.position] as const));
  const contexts: LogicInstanceContext[] = [];

  for (const statement of statements) {
    if (statement.kind !== "inst") {
      continue;
    }

    const definition = definitions.byId.get(statement.typeId);
    const componentDefinition =
      definition && "stormworks" in definition && definition.category !== "project"
        ? (definition as ComponentDefinition)
        : undefined;
    const stormworksType = resolveStormworksComponentType(statement.typeId, componentDefinition);
    const position = positionsById.get(statement.instanceId);

    if (!position) {
      warnings.push(`sw-mcl is missing an instance layout entry for ${statement.instanceId}.`);
    }

    contexts.push({
      statement,
      definition: componentDefinition,
      stormworksType,
      objectId: allocator.allocate(tryParseInstanceObjectId(statement.instanceId)),
      position,
    });
  }

  return contexts;
}

function buildNetProducerIndex(
  logicInstances: LogicInstanceContext[],
  warnings: string[],
): Map<string, NetProducer> {
  const producers = new Map<string, NetProducer>();

  for (const instance of logicInstances) {
    for (const output of instance.statement.outputs) {
      if (output.value.kind !== "identifier") {
        continue;
      }

      if (producers.has(output.value.value)) {
        warnings.push(`Multiple instance outputs drive net ${output.value.value}; using the first producer.`);
        continue;
      }

      producers.set(output.value.value, {
        instance,
        outputKey: output.key,
      });
    }
  }

  return producers;
}

function buildProjectOutputBindingIndex(
  logicInstances: LogicInstanceContext[],
): Map<string, NetProducer[]> {
  const bindings = new Map<string, NetProducer[]>();

  for (const instance of logicInstances) {
    for (const output of instance.statement.outputs) {
      if (output.value.kind !== "string") {
        continue;
      }

      const list = bindings.get(output.value.value);
      const binding: NetProducer = {
        instance,
        outputKey: output.key,
      };

      if (list) {
        list.push(binding);
        continue;
      }

      bindings.set(output.value.value, [binding]);
    }
  }

  for (const producers of bindings.values()) {
    producers.sort((left, right) => left.instance.objectId - right.instance.objectId || left.outputKey.localeCompare(right.outputKey));
  }

  return bindings;
}

function buildProjectNodeElement(projectNode: ProjectNodeContext): StormworksXmlTreeElement {
  const nodeElement: StormworksXmlTreeElement = {
    "@_label": projectNode.document.label ?? projectNode.document.id,
    "@_type": projectNode.definition.stormworks.type,
    "@_description": projectNode.document.description ?? "",
  };

  if (projectNode.definition.stormworks.mode !== undefined) {
    nodeElement["@_mode"] = projectNode.definition.stormworks.mode;
  }

  nodeElement.position = {
    "@_x": formatXmlNumber(projectNode.document.nodePosition.x),
    "@_z": formatXmlNumber(projectNode.document.nodePosition.y),
  };

  return {
    "@_id": String(projectNode.xmlNodeId),
    "@_component_id": String(projectNode.componentId),
    node: nodeElement,
  };
}

function buildComponentElement(
  instance: LogicInstanceContext,
  netProducerByName: Map<string, NetProducer>,
  projectNodeByPortKey: Map<string, ProjectNodeContext>,
  warnings: string[],
  options: BuildStormworksXmlTreeOptions,
  moduleId: string,
): StormworksXmlTreeElement {
  const componentElement: StormworksXmlTreeElement = {
    "@_type": instance.stormworksType,
    object: {
      "@_id": String(instance.objectId),
    },
  };
  const objectElement = asTreeElement(componentElement.object);

  applyInstanceAttributes(componentElement, instance, warnings, options, moduleId);

  if (instance.position) {
    objectElement.pos = {
      "@_x": formatXmlNumber(instance.position.x),
      "@_y": formatXmlNumber(instance.position.y),
    };
  }

  for (const input of instance.statement.inputs) {
    const xmlKey = resolveXmlInputKey(instance.definition, input.key);
    const inputElement = resolveXmlInputElement(
      input,
      instance,
      netProducerByName,
      projectNodeByPortKey,
      warnings,
    );

    if (!inputElement) {
      continue;
    }

    objectElement[xmlKey] = inputElement;
  }

  return componentElement;
}

function applyInstanceAttributes(
  componentElement: StormworksXmlTreeElement,
  instance: LogicInstanceContext,
  warnings: string[],
  options: BuildStormworksXmlTreeOptions,
  moduleId: string,
): void {
  for (const attribute of instance.statement.attributes) {
    if (attribute.key === "script_ref") {
      applyScriptReferenceAttribute(componentElement, instance, attribute, warnings, options, moduleId);
      continue;
    }

    const scalarValue = expressionToScalarValue(attribute.value);

    if (scalarValue === undefined) {
      warnings.push(`Attribute ${attribute.key} on ${instance.statement.instanceId} is not a scalar and was skipped.`);
      continue;
    }

    const propertyDefinition = resolveDslPropertyDefinition(instance.definition, attribute.key);

    if (!propertyDefinition) {
      asTreeElement(componentElement.object)[`@_${attribute.key}`] = formatXmlScalarValue(scalarValue);
      continue;
    }

    const targets = propertyDefinition.writeTargets ?? createDefaultWriteTargets(propertyDefinition);

    if (targets.length === 0) {
      asTreeElement(componentElement.object)[`@_${attribute.key}`] = formatXmlScalarValue(scalarValue);
      continue;
    }

    for (const target of targets) {
      applyXmlWriteTarget(componentElement, target, scalarValue);
    }
  }
}

function applyScriptReferenceAttribute(
  componentElement: StormworksXmlTreeElement,
  instance: LogicInstanceContext,
  attribute: SwNetAssignment,
  warnings: string[],
  options: BuildStormworksXmlTreeOptions,
  moduleId: string,
): void {
  const scalarValue = expressionToScalarValue(attribute.value);
  const scriptRef = typeof scalarValue === "string" ? scalarValue : undefined;

  if (!scriptRef) {
    warnings.push(`script_ref on ${instance.statement.instanceId} is not a string and was skipped.`);
    return;
  }

  const scriptText = options.resolveScriptText?.(scriptRef, {
    moduleId,
    instanceId: instance.statement.instanceId,
    typeId: instance.statement.typeId,
  });

  if (scriptText === undefined) {
    warnings.push(`No script text resolver value was provided for ${scriptRef}; exporting an empty Lua script.`);
  }

  asTreeElement(componentElement.object)["@_script"] = scriptText ?? "";
}

function resolveXmlInputElement(
  input: SwNetAssignment,
  instance: LogicInstanceContext,
  netProducerByName: Map<string, NetProducer>,
  projectNodeByPortKey: Map<string, ProjectNodeContext>,
  warnings: string[],
): StormworksXmlTreeElement | undefined {
  if (input.value.kind === "identifier") {
    const producer = netProducerByName.get(input.value.value);

    if (!producer) {
      warnings.push(`Input ${input.key} on ${instance.statement.instanceId} references unknown net ${input.value.value}.`);
      return undefined;
    }

    const element: StormworksXmlTreeElement = {
      "@_component_id": String(producer.instance.objectId),
    };
    const nodeIndex = resolveXmlOutputNodeIndex(producer.instance.definition, producer.outputKey);

    if (nodeIndex !== undefined) {
      element["@_node_index"] = String(nodeIndex);
    }

    return element;
  }

  if (input.value.kind === "string") {
    const projectNode = projectNodeByPortKey.get(formatPortNameKey("in", input.value.value));

    if (!projectNode) {
      warnings.push(`Input ${input.key} on ${instance.statement.instanceId} references unknown module input port ${input.value.value}.`);
      return undefined;
    }

    return {
      "@_component_id": String(projectNode.componentId),
    };
  }

  warnings.push(`Input ${input.key} on ${instance.statement.instanceId} uses a non-net expression and was skipped.`);
  return undefined;
}

function buildComponentStateElements(
  componentElements: StormworksXmlTreeElement[],
): StormworksXmlTreeElement {
  const componentStates: StormworksXmlTreeElement = {};

  componentElements.forEach((component, index) => {
    const objectElement = component.object;

    if (!objectElement || typeof objectElement !== "object" || Array.isArray(objectElement)) {
      return;
    }

    componentStates[`c${index}`] = cloneTreeValue(objectElement) as StormworksXmlTreeElement;
  });

  return componentStates;
}

function buildBridgeStateElements(
  projectNodes: ProjectNodeContext[],
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>,
  projectOutputBindings: Map<string, NetProducer[]>,
  warnings: string[],
): StormworksXmlTreeElement {
  const bridgeStates: StormworksXmlTreeElement = {};

  projectNodes.forEach((projectNode, index) => {
    const bridgeState: StormworksXmlTreeElement = {
      "@_id": String(projectNode.componentId),
    };
    const slot = portSlotsByProjectNodeId.get(projectNode.document.id);

    if (slot?.position) {
      bridgeState.pos = {
        "@_x": formatXmlNumber(slot.position.x),
        "@_y": formatXmlNumber(slot.position.y),
      };
    } else {
      warnings.push(`No submodule port layout was found for project node ${projectNode.document.id}.`);
    }

    if (projectNode.direction === "output") {
      const producers = slot ? projectOutputBindings.get(slot.name) ?? [] : [];

      if (producers.length === 0) {
        warnings.push(`Project output ${projectNode.document.id} is not driven by any sw-net output assignment.`);
      }

      producers.forEach((producer, producerIndex) => {
        const element: StormworksXmlTreeElement = {
          "@_component_id": String(producer.instance.objectId),
        };
        const nodeIndex = resolveXmlOutputNodeIndex(producer.instance.definition, producer.outputKey);

        if (nodeIndex !== undefined) {
          element["@_node_index"] = String(nodeIndex);
        }

        bridgeState[`in${producerIndex + 1}`] = element;
      });
    }

    bridgeStates[`c${index}`] = bridgeState;
  });

  return bridgeStates;
}

function buildMicroprocessorElement(
  project: ProjectJsonDocument,
  projectNodeElements: StormworksXmlTreeElement[],
  componentElements: StormworksXmlTreeElement[],
  componentStateElements: StormworksXmlTreeElement,
  bridgeStateElements: StormworksXmlTreeElement,
  idCounter: number,
  idCounterNode: number,
): StormworksXmlTreeElement {
  const microprocessor: StormworksXmlTreeElement = {
    "@_id_counter": String(idCounter),
    "@_id_counter_node": String(idCounterNode),
    nodes: {
      n: projectNodeElements,
    },
    group: {
      data: {
        "@_type": DEFAULT_GROUP_DATA_TYPE,
        inputs: {},
        outputs: {},
      },
      components: {
        c: componentElements,
      },
      component_states: componentStateElements,
      component_bridge_states: bridgeStateElements,
      group_states: {},
    },
  };

  if (project.name !== null) {
    microprocessor["@_name"] = project.name;
  }

  if (project.description !== null) {
    microprocessor["@_description"] = project.description;
  }

  if (project.width !== null) {
    microprocessor["@_width"] = String(project.width);
  }

  if (project.length !== null) {
    microprocessor["@_length"] = String(project.length);
  }

  return microprocessor;
}

function resolveStormworksComponentType(
  typeId: string,
  definition: ComponentDefinition | undefined,
): string {
  if (definition) {
    return definition.stormworks.type;
  }

  const match = /^LOGIC_COMPONENT_(\d+)$/.exec(typeId);

  if (match?.[1]) {
    return match[1];
  }

  throw new Error(`Cannot map sw-net instance type ${typeId} back to a Stormworks component type.`);
}

function resolveDslPropertyDefinition(
  definition: ComponentDefinition | undefined,
  dslKey: string,
): NodePropertyDefinition | undefined {
  const matches = (definition?.properties ?? []).filter(
    (propertyDefinition) => (propertyDefinition.dsl?.key ?? propertyDefinition.key) === dslKey,
  );

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((left, right) => scoreDslPropertyDefinition(right) - scoreDslPropertyDefinition(left));
  return matches[0];
}

function scoreDslPropertyDefinition(propertyDefinition: NodePropertyDefinition): number {
  return (
    (propertyDefinition.writeTargets ? 4 : 0) +
    (propertyDefinition.dsl?.key ? 2 : 0) +
    (propertyDefinition.source ? 1 : 0) +
    (propertyDefinition.dsl?.emit === false ? 0 : 1)
  );
}

function createDefaultWriteTargets(propertyDefinition: NodePropertyDefinition): NodePropertyWriteTarget[] {
  return propertyDefinition.source
    ? [
        {
          xmlPath: propertyDefinition.source.xmlPath,
          valueType: propertyDefinition.valueType,
        },
      ]
    : [];
}

function applyXmlWriteTarget(
  componentElement: StormworksXmlTreeElement,
  writeTarget: NodePropertyWriteTarget,
  value: IrScalarValue,
): void {
  const segments = writeTarget.xmlPath.split(".").filter((segment) => segment.length > 0);
  let current: StormworksXmlTreeElement = componentElement;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (!segment) {
      continue;
    }

    if (segment.startsWith("@")) {
      current[`@_${segment.slice(1)}`] = formatXmlScalarValue(value, writeTarget.valueType);
      return;
    }

    const existing = current[segment];

    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as StormworksXmlTreeElement;
      continue;
    }

    const next: StormworksXmlTreeElement = {};
    current[segment] = next;
    current = next;
  }
}

function resolveXmlInputKey(
  definition: ComponentDefinition | undefined,
  dslKey: string,
): string {
  if (!definition) {
    return dslKey;
  }

  const inputDefinition = definition.ports.inputs.find((input) => input.key === dslKey);

  if (!inputDefinition) {
    return dslKey;
  }

  if (inputDefinition.stormworks?.xmlKey) {
    return inputDefinition.stormworks.xmlKey;
  }

  if (dslKey === "inc") {
    return "inc";
  }

  const index = definition.ports.inputs.indexOf(inputDefinition);
  return index >= 0 ? `in${index + 1}` : dslKey;
}

function resolveXmlOutputNodeIndex(
  definition: ComponentDefinition | undefined,
  dslKey: string,
): number | undefined {
  if (!definition) {
    return tryParseTrailingNumber(dslKey);
  }

  const outputDefinition = definition.ports.outputs.find((output) => output.key === dslKey);

  if (!outputDefinition) {
    return tryParseTrailingNumber(dslKey);
  }

  return outputDefinition.stormworks?.nodeIndex;
}

function expressionToScalarValue(expression: SwNetExpression): IrScalarValue | undefined {
  switch (expression.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return expression.value;
    case "identifier":
      return expression.value;
    default:
      return undefined;
  }
}

function formatPortNameKey(direction: "in" | "out", name: string): string {
  return `${direction}:${name}`;
}

function formatPortOccurrenceKey(
  direction: "in" | "out",
  name: string,
  occurrence: number,
): string {
  return `${direction}:${name}:${occurrence}`;
}

function formatModuleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

function formatXmlScalarValue(value: IrScalarValue, valueType?: DefinitionValueType): string {
  if (value === null) {
    return "null";
  }

  if (valueType === "number" || typeof value === "number") {
    return formatXmlNumber(typeof value === "number" ? value : Number(value));
  }

  if (valueType === "boolean" || typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function formatXmlNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function tryParseInstanceObjectId(instanceId: string): number | undefined {
  const match = /^n(\d+)$/.exec(instanceId);

  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tryParseTrailingNumber(value: string): number | undefined {
  const match = /(\d+)$/.exec(value);

  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cloneTreeValue(value: StormworksXmlTreeValue): StormworksXmlTreeValue {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneTreeValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    const cloned: StormworksXmlTreeElement = {};

    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneTreeValue(entry);
    }

    return cloned;
  }

  return value;
}

function asTreeElement(value: StormworksXmlTreeValue | undefined): StormworksXmlTreeElement {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as StormworksXmlTreeElement;
  }

  throw new Error("Expected an XML tree element.");
}
