import { XMLParser } from "fast-xml-parser";

import {
  createEmptyIrProgram,
  type IrMicroprocessorMetadata,
  type IrNode,
  type IrProgram,
  type IrScalarValue,
  type IrSignalKind,
} from "../ir.js";
import {
  findProjectNodeDefinition,
  findComponentDefinitionByStormworksType,
  type NodeDefinitionRegistry,
} from "../definitions/loader.js";
import {
  type ComponentDefinition,
  type DefinitionBase,
  type DefinitionValueType,
  type ProjectNodeDefinition,
  type NodePropertySource,
} from "../definitions/schema.js";

export type StormworksXmlParserOptions = NonNullable<ConstructorParameters<typeof XMLParser>[0]>;

export interface ParsedStormworksXmlDocument {
  raw: unknown;
  parserOptions: StormworksXmlParserOptions;
}

export interface StormworksXmlImportWarning {
  code: string;
  message: string;
  path?: string;
}

export interface StormworksXmlImportOptions {
  definitions: NodeDefinitionRegistry;
  parserOptions?: Partial<StormworksXmlParserOptions>;
  sourceName?: string;
}

export interface StormworksXmlImportResult {
  document: ParsedStormworksXmlDocument;
  program: IrProgram;
  warnings: StormworksXmlImportWarning[];
}

type SubmodulePortDirection = "input" | "output";

interface ProjectNodeBinding {
  definitionId: string;
  direction: SubmodulePortDirection;
  signal: IrSignalKind;
  projectPortKey: string;
}

interface ProjectNodeContext {
  rawId: string;
  typeKey: string;
  label: string;
  irNode: IrNode;
  definition?: ProjectNodeDefinition;
  binding: ProjectNodeBinding;
  path: string;
}

interface BridgeStateContext {
  rawId: string;
  record: Record<string, unknown>;
  path: string;
}

interface SubmodulePortContext {
  rawId: string;
  direction: SubmodulePortDirection;
  signal: IrSignalKind;
  irNode: IrNode;
  projectFacingPortKey: string;
  logicFacingPortKey: string;
}

const DEFAULT_XML_PARSER_OPTIONS: StormworksXmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
};

const IMPLICIT_SUBMODULE_ID = "submodule:main";
const IMPLICIT_SUBMODULE_NAME = "main";
const SUBMODULE_INPUT_FROM_PROJECT_PORT_KEY = "fromProject";
const SUBMODULE_INPUT_TO_LOGIC_PORT_KEY = "toLogic";
const SUBMODULE_OUTPUT_FROM_LOGIC_PORT_KEY = "fromLogic";
const SUBMODULE_OUTPUT_TO_PROJECT_PORT_KEY = "toProject";

export function parseStormworksXml(
  xmlText: string,
  parserOptions: Partial<StormworksXmlParserOptions> = {},
): ParsedStormworksXmlDocument {
  const effectiveOptions: StormworksXmlParserOptions = {
    ...DEFAULT_XML_PARSER_OPTIONS,
    ...parserOptions,
  };
  const parser = new XMLParser(effectiveOptions);

  return {
    raw: parser.parse(xmlText),
    parserOptions: effectiveOptions,
  };
}

export function importStormworksXml(
  xmlText: string,
  options: StormworksXmlImportOptions,
): StormworksXmlImportResult {
  const document = parseStormworksXml(xmlText, options.parserOptions);
  const warnings: StormworksXmlImportWarning[] = [];
  const program = buildIrProgram(document.raw, options.definitions, options.sourceName, warnings);

  program.metadata.warnings = warnings.map((warning) => warning.message);

  if (program.nodes.length === 0) {
    warnings.push({
      code: "XML_IMPORT_EMPTY",
      message: `No IR nodes were imported. Loaded ${options.definitions.nodes.length + options.definitions.components.length} definitions but did not match any XML content.`,
    });
    program.metadata.warnings = warnings.map((warning) => warning.message);
  }

  return {
    document,
    program,
    warnings,
  };
}

function buildIrProgram(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  sourceName: string | undefined,
  warnings: StormworksXmlImportWarning[],
): IrProgram {
  const program = createEmptyIrProgram({
    sourceFormat: "stormworks-xml",
    sourceName,
  });
  program.metadata.microprocessor = extractMicroprocessorMetadata(root);

  const bridgeStates = collectBridgeStates(root);
  const projectNodes = collectProjectNodes(root, definitions, bridgeStates, program, warnings);
  const logicNodes = collectLogicNodes(root, definitions, program, warnings);
  const submodulePorts = synthesizeSubmodulePorts(projectNodes, bridgeStates, program, warnings);

  importLogicLinks(root, definitions, program, logicNodes, submodulePorts, warnings);
  importProjectAndBridgeLinks(projectNodes, bridgeStates, definitions, program, logicNodes, submodulePorts, warnings);
  registerImplicitSubmodule(program, submodulePorts, logicNodes);

  warnings.unshift({
    code: "XML_IMPORT_SUMMARY",
    message: `Imported ${program.nodes.length} nodes, ${program.links.length} links, and ${program.submodules.length} submodules from XML.`,
  });

  return program;
}

function extractMicroprocessorMetadata(root: unknown): IrMicroprocessorMetadata | undefined {
  const microprocessorRecord = asRecord(getValueByPath(root, "microprocessor"));

  if (!microprocessorRecord) {
    return undefined;
  }

  const metadata: IrMicroprocessorMetadata = {
    name: getAttribute(microprocessorRecord, "name"),
    description: getAttribute(microprocessorRecord, "description"),
    width: parseNumberAttribute(microprocessorRecord, "width"),
    length: parseNumberAttribute(microprocessorRecord, "length"),
  };

  if (
    metadata.name === undefined &&
    metadata.description === undefined &&
    metadata.width === undefined &&
    metadata.length === undefined
  ) {
    return undefined;
  }

  return metadata;
}

function collectProjectNodes(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  bridgeStates: Map<string, BridgeStateContext>,
  program: IrProgram,
  warnings: StormworksXmlImportWarning[],
): Map<string, ProjectNodeContext> {
  const contexts = new Map<string, ProjectNodeContext>();
  const projectNodes = getArrayByPath(root, "microprocessor.nodes.n");

  for (let index = 0; index < projectNodes.length; index += 1) {
    const record = asRecord(projectNodes[index]);

    if (!record) {
      continue;
    }

    const rawId = getAttribute(record, "component_id");
    const nodeRecord = asRecord(record.node);

    if (!rawId || !nodeRecord) {
      warnings.push({
        code: "PROJECT_NODE_SKIPPED",
        message: "Skipped a project node because component_id or node data was missing.",
        path: `microprocessor.nodes.n[${index}]`,
      });
      continue;
    }

    const rawType = getAttribute(nodeRecord, "type");
    const rawMode = getAttribute(nodeRecord, "mode");
    const type = rawType ?? "0";
    const mode = rawMode;
    const typeKey = toProjectTypeKey(type, mode);
    const label = getAttribute(nodeRecord, "label") ?? rawId;
    const definition = findProjectNodeDefinition(definitions, type, mode);
    const binding = resolveProjectNodeBinding(type, mode, definition, bridgeStates.get(rawId)?.record);
    const importedNode: IrNode = {
      id: `project:${rawId}`,
      layer: "project",
      definitionId: binding.definitionId,
      position: readProjectPosition(nodeRecord),
      properties: {
        componentId: rawId,
        projectNodeId: getAttribute(record, "id") ?? rawId,
        type: rawType ?? null,
        mode: rawMode ?? null,
        label,
        name: label,
        description: getAttribute(nodeRecord, "description") ?? null,
        signal: binding.signal,
        direction: binding.direction,
        layer: "project",
      },
      source: {
        format: "stormworks-xml",
        path: `microprocessor.nodes.n[${index}]`,
      },
    };

    if (binding.definitionId.startsWith("PROJECT_NODE:")) {
      warnings.push({
        code: "PROJECT_NODE_UNCLASSIFIED",
        message: `Project node ${typeKey} is not classified yet; imported with inferred direction=${binding.direction} signal=${binding.signal}.`,
        path: `microprocessor.nodes.n[${index}]`,
      });
    }

    program.nodes.push(importedNode);
    contexts.set(rawId, {
      rawId,
      typeKey,
      label,
      irNode: importedNode,
      definition,
      binding,
      path: `microprocessor.nodes.n[${index}]`,
    });
  }

  return contexts;
}

function collectBridgeStates(root: unknown): Map<string, BridgeStateContext> {
  const bridgeStates = new Map<string, BridgeStateContext>();
  const bridgeGroup = asRecord(getValueByPath(root, "microprocessor.group.component_bridge_states"));

  if (!bridgeGroup) {
    return bridgeStates;
  }

  for (const [childName, childValue] of Object.entries(bridgeGroup)) {
    if (!/^c\d+$/.test(childName)) {
      continue;
    }

    const record = asRecord(childValue);
    const rawId = record ? getAttribute(record, "id") : undefined;

    if (!record || !rawId) {
      continue;
    }

    bridgeStates.set(rawId, {
      rawId,
      record,
      path: `microprocessor.group.component_bridge_states.${childName}`,
    });
  }

  return bridgeStates;
}

function collectLogicNodes(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  warnings: StormworksXmlImportWarning[],
): Map<string, IrNode> {
  const logicNodes = new Map<string, IrNode>();
  const components = getArrayByPath(root, "microprocessor.group.components.c");

  for (let index = 0; index < components.length; index += 1) {
    const component = asRecord(components[index]);

    if (!component) {
      continue;
    }

    const componentType = getAttribute(component, "type");
    const objectRecord = asRecord(component.object);
    const rawId = objectRecord ? getAttribute(objectRecord, "id") : undefined;

    if (!componentType || !objectRecord || !rawId) {
      warnings.push({
        code: "LOGIC_COMPONENT_SKIPPED",
        message: "Skipped a logic component because type, object, or object id was missing.",
        path: `microprocessor.group.components.c[${index}]`,
      });
      continue;
    }

    const definition = findComponentDefinitionByStormworksType(definitions, componentType);
    const importedNode: IrNode = {
      id: `logic:${rawId}`,
      layer: "logic",
      definitionId: definition?.id ?? `LOGIC_COMPONENT:${componentType}`,
      position: readLogicPosition(component),
      properties: {
        objectId: rawId,
        stormworksType: componentType,
        layer: "logic",
        ...extractObjectAttributes(objectRecord, definition),
        ...extractDefinedProperties(component, definition, warnings, `microprocessor.group.components.c[${index}]`),
      },
      source: {
        format: "stormworks-xml",
        path: `microprocessor.group.components.c[${index}]`,
      },
    };

    if (!definition) {
      warnings.push({
        code: "LOGIC_COMPONENT_UNRESOLVED",
        message: `No definition matched logic component type ${componentType}; imported as a generic logic node.`,
        path: `microprocessor.group.components.c[${index}]`,
      });
    }

    program.nodes.push(importedNode);
    logicNodes.set(rawId, importedNode);
  }

  return logicNodes;
}

function synthesizeSubmodulePorts(
  projectNodes: Map<string, ProjectNodeContext>,
  bridgeStates: Map<string, BridgeStateContext>,
  program: IrProgram,
  warnings: StormworksXmlImportWarning[],
): Map<string, SubmodulePortContext> {
  const ports = new Map<string, SubmodulePortContext>();

  for (const [rawId, projectNode] of projectNodes) {
    const bridgeState = bridgeStates.get(rawId);
    const importedNode: IrNode = {
      id: `submodule:${rawId}`,
      layer: "submodule",
      definitionId: createSyntheticSubmoduleDefinitionId(projectNode.binding.direction, projectNode.binding.signal),
      position: bridgeState ? readBridgePosition(bridgeState.record) : projectNode.irNode.position,
      properties: {
        componentId: rawId,
        name: projectNode.label,
        label: projectNode.label,
        direction: projectNode.binding.direction,
        signal: projectNode.binding.signal,
        projectDefinitionId: projectNode.irNode.definitionId,
        projectNodeId: projectNode.irNode.id,
        layer: "submodule",
      },
      source: {
        format: "stormworks-xml",
        path: bridgeState?.path ?? projectNode.path,
      },
    };

    if (!bridgeState) {
      warnings.push({
        code: "PROJECT_NODE_WITHOUT_BRIDGE",
        message: `Project node ${rawId} has no component_bridge_states entry.`,
        path: projectNode.path,
      });
    }

    program.nodes.push(importedNode);
    ports.set(rawId, {
      rawId,
      direction: projectNode.binding.direction,
      signal: projectNode.binding.signal,
      irNode: importedNode,
      projectFacingPortKey:
        projectNode.binding.direction === "input"
          ? SUBMODULE_INPUT_FROM_PROJECT_PORT_KEY
          : SUBMODULE_OUTPUT_TO_PROJECT_PORT_KEY,
      logicFacingPortKey:
        projectNode.binding.direction === "input"
          ? SUBMODULE_INPUT_TO_LOGIC_PORT_KEY
          : SUBMODULE_OUTPUT_FROM_LOGIC_PORT_KEY,
    });
  }

  for (const [rawId, bridgeState] of bridgeStates) {
    if (!projectNodes.has(rawId)) {
      warnings.push({
        code: "BRIDGE_WITHOUT_PROJECT_NODE",
        message: `component_bridge_states entry ${rawId} has no matching project node.`,
        path: bridgeState.path,
      });
    }
  }

  return ports;
}

function importLogicLinks(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  logicNodes: Map<string, IrNode>,
  submodulePorts: Map<string, SubmodulePortContext>,
  warnings: StormworksXmlImportWarning[],
): void {
  const components = getArrayByPath(root, "microprocessor.group.components.c");

  for (let index = 0; index < components.length; index += 1) {
    const component = asRecord(components[index]);

    if (!component) {
      continue;
    }

    const componentType = getAttribute(component, "type");
    const objectRecord = asRecord(component.object);
    const rawId = objectRecord ? getAttribute(objectRecord, "id") : undefined;

    if (!componentType || !objectRecord || !rawId) {
      continue;
    }

    const targetNode = logicNodes.get(rawId);
    const targetDefinition = findComponentDefinitionByStormworksType(definitions, componentType);

    if (!targetNode) {
      continue;
    }

    for (const [childName, childValue] of Object.entries(objectRecord)) {
      if (!isInputTagName(childName)) {
        continue;
      }

      const inputRecord = asRecord(childValue);

      if (!inputRecord) {
        continue;
      }

      const sourceRawId = getAttribute(inputRecord, "component_id");

      if (!sourceRawId) {
        continue;
      }

      const logicSourceNode = logicNodes.get(sourceRawId);
      const sourceSubmodulePort =
        logicSourceNode === undefined
          ? ensureSubmoduleInputPort(submodulePorts, sourceRawId, program, warnings, inputRecord)
          : undefined;

      program.links.push({
        id: `logic:${sourceRawId}->${rawId}:${childName}`,
        from: {
          nodeId: logicSourceNode?.id ?? sourceSubmodulePort?.irNode.id ?? `submodule:${sourceRawId}`,
          portKey:
            logicSourceNode !== undefined
              ? resolveSourcePortKey(logicSourceNode, definitions, inputRecord)
              : sourceSubmodulePort?.logicFacingPortKey ?? SUBMODULE_INPUT_TO_LOGIC_PORT_KEY,
        },
        to: {
          nodeId: targetNode.id,
          portKey: resolveTargetPortKey(targetDefinition, childName),
        },
        source: {
          format: "stormworks-xml",
          path: `microprocessor.group.components.c[${index}].object.${childName}`,
        },
      });
    }
  }
}

function importProjectAndBridgeLinks(
  projectNodes: Map<string, ProjectNodeContext>,
  bridgeStates: Map<string, BridgeStateContext>,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  logicNodes: Map<string, IrNode>,
  submodulePorts: Map<string, SubmodulePortContext>,
  warnings: StormworksXmlImportWarning[],
): void {
  for (const [rawId, projectNode] of projectNodes) {
    const bridgeState = bridgeStates.get(rawId);
    const submodulePort = submodulePorts.get(rawId);

    if (!submodulePort) {
      continue;
    }

    if (projectNode.binding.direction === "input") {
      program.links.push({
        id: `project:${projectNode.irNode.id}->${submodulePort.irNode.id}`,
        from: {
          nodeId: projectNode.irNode.id,
          portKey: projectNode.binding.projectPortKey,
        },
        to: {
          nodeId: submodulePort.irNode.id,
          portKey: submodulePort.projectFacingPortKey,
        },
        source: {
          format: "stormworks-xml",
          path: bridgeState?.path ?? projectNode.path,
        },
      });
      continue;
    }

    const outputBindings = getBridgeInputBindings(bridgeState?.record);

    if (!bridgeState) {
      warnings.push({
        code: "PROJECT_OUTPUT_WITHOUT_BRIDGE",
        message: `Project output node ${rawId} has no component_bridge_states entry.`,
        path: projectNode.path,
      });
    } else if (outputBindings.length === 0) {
      warnings.push({
        code: "BRIDGE_OUTPUT_SOURCE_MISSING",
        message: `Output bridge ${rawId} does not specify an internal source component.`,
        path: bridgeState.path,
      });
    }

    for (const binding of outputBindings) {
      const sourceRawId = getAttribute(binding.record, "component_id");

      if (!sourceRawId) {
        continue;
      }

      const logicSourceNode = logicNodes.get(sourceRawId);
      const sourceSubmodulePort =
        logicSourceNode === undefined
          ? ensureSubmoduleInputPort(submodulePorts, sourceRawId, program, warnings, binding.record)
          : undefined;

      program.links.push({
        id: `submodule-binding:${sourceRawId}->${rawId}:${binding.tagName}`,
        from: {
          nodeId: logicSourceNode?.id ?? sourceSubmodulePort?.irNode.id ?? `submodule:${sourceRawId}`,
          portKey:
            logicSourceNode !== undefined
              ? resolveSourcePortKey(logicSourceNode, definitions, binding.record)
              : sourceSubmodulePort?.logicFacingPortKey ?? SUBMODULE_INPUT_TO_LOGIC_PORT_KEY,
        },
        to: {
          nodeId: submodulePort.irNode.id,
          portKey: submodulePort.logicFacingPortKey,
        },
        source: {
          format: "stormworks-xml",
          path: bridgeState ? `${bridgeState.path}.${binding.tagName}` : projectNode.path,
        },
      });
    }

    program.links.push({
      id: `project:${submodulePort.irNode.id}->${projectNode.irNode.id}`,
      from: {
        nodeId: submodulePort.irNode.id,
        portKey: submodulePort.projectFacingPortKey,
      },
      to: {
        nodeId: projectNode.irNode.id,
        portKey: projectNode.binding.projectPortKey,
      },
      source: {
        format: "stormworks-xml",
        path: bridgeState?.path ?? projectNode.path,
      },
    });
  }
}

function registerImplicitSubmodule(
  program: IrProgram,
  submodulePorts: Map<string, SubmodulePortContext>,
  logicNodes: Map<string, IrNode>,
): void {
  program.submodules.push({
    id: IMPLICIT_SUBMODULE_ID,
    name: IMPLICIT_SUBMODULE_NAME,
    portNodeIds: [...submodulePorts.values()].map((port) => port.irNode.id),
    logicNodeIds: [...logicNodes.values()].map((node) => node.id),
    source: {
      format: "stormworks-xml",
      path: "microprocessor.group",
    },
  });
}

function ensureSubmoduleInputPort(
  submodulePorts: Map<string, SubmodulePortContext>,
  rawId: string,
  program: IrProgram,
  warnings: StormworksXmlImportWarning[],
  inputRecord: Record<string, unknown>,
): SubmodulePortContext {
  const existing = submodulePorts.get(rawId);

  if (existing) {
    return existing;
  }

  const importedNode: IrNode = {
    id: `submodule:${rawId}`,
    layer: "submodule",
    definitionId: createSyntheticSubmoduleDefinitionId("input", "unknown"),
    properties: {
      componentId: rawId,
      name: rawId,
      label: rawId,
      direction: "input",
      signal: "unknown",
      external: true,
      layer: "submodule",
    },
    source: {
      format: "stormworks-xml",
      path: describeInputRecord(inputRecord),
    },
  };

  warnings.push({
    code: "SUBMODULE_EXTERNAL_INPUT_SYNTHESIZED",
    message: `Synthesized a submodule input port for external component_id=${rawId} referenced from components.c or component_bridge_states.`,
    path: describeInputRecord(inputRecord),
  });

  program.nodes.push(importedNode);

  const context: SubmodulePortContext = {
    rawId,
    direction: "input",
    signal: "unknown",
    irNode: importedNode,
    projectFacingPortKey: SUBMODULE_INPUT_FROM_PROJECT_PORT_KEY,
    logicFacingPortKey: SUBMODULE_INPUT_TO_LOGIC_PORT_KEY,
  };

  submodulePorts.set(rawId, context);
  return context;
}

function resolveProjectNodeBinding(
  type: string,
  mode: string | undefined,
  definition: ProjectNodeDefinition | undefined,
  bridgeRecord: Record<string, unknown> | undefined,
): ProjectNodeBinding {
  if (definition) {
    return createProjectNodeBindingFromDefinition(definition);
  }

  const normalizedMode = mode ?? "0";
  const direction = inferProjectDirection(normalizedMode, bridgeRecord);
  const signal = inferProjectSignal(type);

  return {
    definitionId: `PROJECT_NODE:${toProjectTypeKey(type, mode)}`,
    direction,
    signal,
    projectPortKey: createProjectPortKey(direction, signal),
  };
}

function createProjectNodeBindingFromDefinition(definition: ProjectNodeDefinition): ProjectNodeBinding {
  const direction = definition.ports.outputs.length > 0 ? "input" : "output";
  const signal =
    direction === "input"
      ? (definition.ports.outputs[0]?.signal ?? definition.ports.inputs[0]?.signal ?? "unknown")
      : (definition.ports.inputs[0]?.signal ?? definition.ports.outputs[0]?.signal ?? "unknown");

  return {
    definitionId: definition.id,
    direction,
    signal,
    projectPortKey: createProjectPortKey(direction, signal),
  };
}

function inferProjectDirection(
  mode: string,
  bridgeRecord: Record<string, unknown> | undefined,
): SubmodulePortDirection {
  if (mode === "1") {
    return "input";
  }

  if (getBridgeInputBindings(bridgeRecord).length > 0) {
    return "output";
  }

  return "output";
}

function inferProjectSignal(type: string): IrSignalKind {
  if (type === "0") {
    return "boolean";
  }

  if (type === "1") {
    return "number";
  }

  if (type === "5") {
    return "composite";
  }

  if (type === "6") {
    return "video";
  }

  return "unknown";
}

function createProjectPortKey(
  direction: SubmodulePortDirection,
  signal: IrSignalKind,
): string {
  if (signal === "boolean") {
    return "boolean";
  }

  if (signal === "number") {
    return "number";
  }

  if (signal === "composite") {
    return "composite";
  }

  if (signal === "video") {
    return "video";
  }

  return direction === "input" ? "out1" : "in1";
}

function createSyntheticSubmoduleDefinitionId(
  direction: SubmodulePortDirection,
  signal: IrSignalKind,
): string {
  return `SUBMODULE_PORT:${direction}:${signal}`;
}

function getBridgeInputBindings(
  bridgeRecord: Record<string, unknown> | undefined,
): Array<{ tagName: string; record: Record<string, unknown> }> {
  if (!bridgeRecord) {
    return [];
  }

  const bindings: Array<{ tagName: string; record: Record<string, unknown> }> = [];

  for (const [tagName, value] of Object.entries(bridgeRecord)) {
    if (!isInputTagName(tagName)) {
      continue;
    }

    const record = asRecord(value);

    if (record) {
      bindings.push({ tagName, record });
    }
  }

  return bindings;
}

function extractDefinedProperties(
  sourceRecord: Record<string, unknown>,
  definition: DefinitionBase | undefined,
  warnings: StormworksXmlImportWarning[],
  path: string,
): Record<string, IrScalarValue> {
  const properties: Record<string, IrScalarValue> = {
    ...(definition?.defaults ?? {}),
  };

  for (const propertyDefinition of definition?.properties ?? []) {
    const value = extractPropertyValue(sourceRecord, propertyDefinition.valueType, propertyDefinition.source);

    if (value !== undefined) {
      properties[propertyDefinition.key] = value;
      continue;
    }

    if (propertyDefinition.required && properties[propertyDefinition.key] === undefined) {
      warnings.push({
        code: "PROPERTY_MISSING",
        message: `Required property ${propertyDefinition.key} was not found for ${definition?.id ?? "unknown"}.`,
        path,
      });
    }
  }

  return properties;
}

function extractObjectAttributes(
  objectRecord: Record<string, unknown>,
  definition: DefinitionBase | undefined,
): Record<string, IrScalarValue> {
  const properties: Record<string, IrScalarValue> = {};
  const consumedAttributeNames = new Set(
    (definition?.properties ?? [])
      .map((propertyDefinition) => tryGetDirectObjectAttributeName(propertyDefinition.source))
      .filter((attributeName): attributeName is string => attributeName !== undefined),
  );

  for (const [key, rawValue] of Object.entries(objectRecord)) {
    if (!key.startsWith("@_")) {
      continue;
    }

    const attributeName = key.slice(2);

    if (attributeName === "id" || consumedAttributeNames.has(attributeName)) {
      continue;
    }

    const value = coerceXmlAttributeScalar(rawValue);

    if (value !== undefined) {
      properties[attributeName] = value;
    }
  }

  return properties;
}

function tryGetDirectObjectAttributeName(source: NodePropertySource | undefined): string | undefined {
  if (!source) {
    return undefined;
  }

  const match = /^object\.@([A-Za-z0-9_]+)$/.exec(source.xmlPath);
  return match?.[1];
}

function extractPropertyValue(
  sourceRecord: Record<string, unknown>,
  valueType: DefinitionValueType,
  source: NodePropertySource | undefined,
): IrScalarValue | undefined {
  if (!source) {
    return undefined;
  }

  const rawValue = getValueByPath(sourceRecord, source.xmlPath);

  if (rawValue === undefined) {
    return undefined;
  }

  return coerceScalarValue(rawValue, valueType);
}

function coerceScalarValue(value: unknown, valueType: DefinitionValueType): IrScalarValue | undefined {
  if (valueType === "string") {
    return typeof value === "string" ? value : String(value);
  }

  if (valueType === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true" || value === "1") {
      return true;
    }

    if (value === "false" || value === "0") {
      return false;
    }
  }

  return undefined;
}

function coerceXmlAttributeScalar(value: unknown): IrScalarValue | undefined {
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }

  return value;
}

function toProjectTypeKey(type: string, mode?: string): string {
  return `${type}:${mode ?? "0"}`;
}

function resolveSourcePortKey(
  sourceNode: IrNode,
  definitions: NodeDefinitionRegistry,
  inputRecord: Record<string, unknown>,
): string {
  const sourceDefinition = definitions.byId.get(sourceNode.definitionId);
  const rawIndex = getAttribute(inputRecord, "node_index");
  const parsedIndex = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;

  if (sourceDefinition && Number.isInteger(parsedIndex) && parsedIndex > 0) {
    const explicitOutput = sourceDefinition.ports.outputs.find((output) => output.stormworks?.nodeIndex === parsedIndex);

    if (explicitOutput) {
      return explicitOutput.key;
    }

    const output = sourceDefinition.ports.outputs[parsedIndex - 1];
    return output?.key ?? `out${parsedIndex}`;
  }

  if (sourceDefinition && sourceDefinition.ports.outputs.length > 0) {
    return sourceDefinition.ports.outputs[0]?.key ?? "out1";
  }

  if (Number.isInteger(parsedIndex) && parsedIndex > 0) {
    return `out${parsedIndex}`;
  }

  return "out1";
}

function resolveTargetPortKey(definition: ComponentDefinition | undefined, rawPortKey: string): string {
  if (!definition) {
    return rawPortKey;
  }

  const explicitInput = definition.ports.inputs.find((input) => input.stormworks?.xmlKey === rawPortKey);

  if (explicitInput) {
    return explicitInput.key;
  }

  if (rawPortKey === "inc") {
    return rawPortKey;
  }

  const match = /^in(\d+)$/.exec(rawPortKey);

  if (!match) {
    return rawPortKey;
  }

  const indexText = match[1];

  if (!indexText) {
    return rawPortKey;
  }

  const index = Number.parseInt(indexText, 10);
  const input = definition.ports.inputs[index - 1];
  return input?.key ?? rawPortKey;
}

function readProjectPosition(nodeRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  const positionRecord = asRecord(nodeRecord.position);

  if (!positionRecord) {
    return undefined;
  }

  return {
    x: parseNumberAttribute(positionRecord, "x") ?? 0,
    y: parseNumberAttribute(positionRecord, "z") ?? 0,
  };
}

function readBridgePosition(bridgeRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  const positionRecord = asRecord(bridgeRecord.pos);

  if (!positionRecord) {
    return undefined;
  }

  return {
    x: parseNumberAttribute(positionRecord, "x") ?? 0,
    y: parseNumberAttribute(positionRecord, "y") ?? 0,
  };
}

function readLogicPosition(componentRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  const positionRecord = asRecord(getValueByPath(componentRecord, "object.pos"));

  if (!positionRecord) {
    return undefined;
  }

  return {
    x: parseNumberAttribute(positionRecord, "x") ?? 0,
    y: parseNumberAttribute(positionRecord, "y") ?? 0,
  };
}

function getValueByPath(root: unknown, path: string): unknown {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  let current = root;

  for (const segment of segments) {
    const record = asRecord(current);

    if (!record) {
      return undefined;
    }

    const key = segment.startsWith("@") ? `@_${segment.slice(1)}` : segment;
    current = record[key];
  }

  return current;
}

function getArrayByPath(root: unknown, path: string): unknown[] {
  const value = getValueByPath(root, path);

  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined) {
    return [];
  }

  return [value];
}

function getAttribute(record: Record<string, unknown>, attributeName: string): string | undefined {
  const value = record[`@_${attributeName}`];
  return typeof value === "string" ? value : undefined;
}

function parseNumberAttribute(record: Record<string, unknown>, attributeName: string): number | undefined {
  const value = getAttribute(record, attributeName);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function isInputTagName(name: string): boolean {
  return name === "inc" || /^in\d+$/.test(name);
}

function describeInputRecord(inputRecord: Record<string, unknown>): string {
  const componentId = getAttribute(inputRecord, "component_id");
  const nodeIndex = getAttribute(inputRecord, "node_index");

  if (componentId && nodeIndex) {
    return `component_id=${componentId},node_index=${nodeIndex}`;
  }

  if (componentId) {
    return `component_id=${componentId}`;
  }

  return "unknown";
}
