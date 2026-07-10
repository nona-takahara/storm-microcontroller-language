// Stormworks XML importer that rebuilds layered IR from project nodes, bridge components, and logic components.
import { XMLParser } from "fast-xml-parser";

import {
  createEmptyIrProgram,
  type IrMicroprocessorMetadata,
  type IrNode,
  type IrPortEndpoint,
  type IrProgram,
  type IrScalarValue,
  type IrSignalKind,
} from "../ir.js";
import {
  findCompatibleComponentDefinition,
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
import { createInfoDiagnostic, createWarningDiagnostic, type Diagnostic } from "../diagnostics.js";
import { coerceScalarValue } from "../shared/scalar-coercion.js";

export type StormworksXmlParserOptions = NonNullable<ConstructorParameters<typeof XMLParser>[0]>;

export interface ParsedStormworksXmlDocument {
  raw: unknown;
  parserOptions: StormworksXmlParserOptions;
}

export interface StormworksXmlImportOptions {
  definitions: NodeDefinitionRegistry;
  parserOptions?: Partial<StormworksXmlParserOptions>;
  sourceName?: string;
}

export interface StormworksXmlImportResult {
  document: ParsedStormworksXmlDocument;
  program: IrProgram;
  warnings: Diagnostic[];
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

interface ProjectBridgeContext {
  rawId: string;
  componentType?: string;
  bridgeRecord: Record<string, unknown>;
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
  processEntities: { maxTotalExpansions: 10000 },
};

const IMPLICIT_SUBMODULE_ID = "submodule:main";
const IMPLICIT_SUBMODULE_NAME = "main";
const SUBMODULE_INPUT_FROM_PROJECT_PORT_KEY = "fromProject";
const SUBMODULE_INPUT_TO_LOGIC_PORT_KEY = "toLogic";
const SUBMODULE_OUTPUT_FROM_LOGIC_PORT_KEY = "fromLogic";
const SUBMODULE_OUTPUT_TO_PROJECT_PORT_KEY = "toProject";

// Parse raw Stormworks XML into the generic object tree consumed by the importer.
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

// Parse Stormworks XML and lower it into the layered IR consumed by the rest of the toolchain.
export function importStormworksXml(
  xmlText: string,
  options: StormworksXmlImportOptions,
): StormworksXmlImportResult {
  const document = parseStormworksXml(xmlText, options.parserOptions);
  const warnings: Diagnostic[] = [];
  const program = buildIrProgram(document.raw, options.definitions, options.sourceName, warnings);

  program.metadata.warnings = [...warnings];

  if (program.nodes.length === 0) {
    warnings.push(createWarningDiagnostic(
      "XML_IMPORT_EMPTY",
      `No IR nodes were imported. Loaded ${options.definitions.nodes.length + options.definitions.components.length} definitions but did not match any XML content.`,
      "xml-importer",
      options.sourceName,
    ));
    program.metadata.warnings = [...warnings];
  }

  return {
    document,
    program,
    warnings,
  };
}

// Convert the parsed XML tree into the layered IR used by project.json, sw-net, and sw-mcl.
function buildIrProgram(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  sourceName: string | undefined,
  warnings: Diagnostic[],
): IrProgram {
  // Import is intentionally split into:
  // 1. project nodes from <nodes><n>
  // 2. project bridge components from <components_bridge><c>
  //    (with component_bridge_states as an alternate shape we have not fully characterized yet)
  // 3. pure logic graph from <components><c>
  const program = createEmptyIrProgram({
    sourceFormat: "stormworks-xml",
    sourceName,
  });
  program.metadata.microprocessor = extractMicroprocessorMetadata(root);

  // Import in source-order so later stages can resolve references against already-collected nodes.
  const projectBridges = collectProjectBridges(root, warnings);
  const projectNodes = collectProjectNodes(root, definitions, program, warnings);
  const logicNodes = collectLogicNodes(root, definitions, program, warnings);
  const submodulePorts = synthesizeSubmodulePorts(projectNodes, projectBridges, program, warnings);

  // Logic links and project/bridge links are rebuilt separately because they come from different XML sections.
  importLogicLinks(root, definitions, program, logicNodes, submodulePorts, warnings);
  importProjectAndBridgeLinks(projectNodes, projectBridges, definitions, program, logicNodes, submodulePorts, warnings);
  registerImplicitSubmodule(program, submodulePorts, logicNodes);

  warnings.unshift(createInfoDiagnostic(
    "XML_IMPORT_SUMMARY",
    `Imported ${program.nodes.length} nodes, ${program.links.length} links, and ${program.submodules.length} submodules from XML.`,
    "xml-importer",
    undefined,
  ));

  return program;
}

// Read top-level microprocessor metadata that belongs to project.json rather than the logic graph.
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

// Import project-facing pins from <nodes><n> and classify them with project-node definitions.
function collectProjectNodes(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  warnings: Diagnostic[],
): Map<string, ProjectNodeContext> {
  const contexts = new Map<string, ProjectNodeContext>();
  const projectNodes = getArrayByPath(root, "microprocessor.nodes.n");

  for (let index = 0; index < projectNodes.length; index += 1) {
    // Each <n> wraps a project-visible pin and points at the bridge/component id used elsewhere in XML.
    const record = asRecord(projectNodes[index]);

    if (!record) {
      continue;
    }

    const rawId = getAttribute(record, "component_id");
    const nodeRecord = asRecord(record.node);

    if (!rawId || !nodeRecord) {
      warnings.push(createWarningDiagnostic(
        "PROJECT_NODE_SKIPPED",
        "Skipped a project node because component_id or node data was missing.",
        "xml-importer",
        undefined,
        `microprocessor.nodes.n[${index}]`,
      ));
      continue;
    }

    const rawType = getAttribute(nodeRecord, "type");
    const rawMode = getAttribute(nodeRecord, "mode");
    const type = rawType ?? "0";
    const mode = rawMode;
    const typeKey = toProjectTypeKey(type, mode);
    const label = getAttribute(nodeRecord, "label") ?? rawId;
    const definition = findProjectNodeDefinition(definitions, type, mode);
    const binding = resolveProjectNodeBinding(type, mode, definition);
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
      warnings.push(createWarningDiagnostic(
        "PROJECT_NODE_UNCLASSIFIED",
        `Project node ${typeKey} is not classified yet; imported with inferred direction=${binding.direction} signal=${binding.signal}.`,
        "xml-importer",
        undefined,
        `microprocessor.nodes.n[${index}]`,
      ));
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

// Collect project/logics boundary data from bridge components, with alternate state data as a fallback while Stormworks variants are still being characterized.
function collectProjectBridges(
  root: unknown,
  warnings: Diagnostic[],
): Map<string, ProjectBridgeContext> {
  const bridgeComponents = getArrayByPath(root, "microprocessor.group.components_bridge.c");

  if (bridgeComponents.length > 0) {
    return collectProjectBridgesFromComponents(bridgeComponents, warnings);
  }

  return collectProjectBridgesFromAlternateStates(root);
}

// Read canonical bridge components from <components_bridge><c>.
function collectProjectBridgesFromComponents(
  bridgeComponents: unknown[],
  warnings: Diagnostic[],
): Map<string, ProjectBridgeContext> {
  const projectBridges = new Map<string, ProjectBridgeContext>();

  for (let index = 0; index < bridgeComponents.length; index += 1) {
    // Bridge components reuse the same <c><object> shape as logic components, so normalize them the same way.
    const component = asRecord(bridgeComponents[index]);

    if (!component) {
      continue;
    }

    const componentType = getAttribute(component, "type") ?? "0";
    const bridgeRecord = asRecord(component.object);
    const rawId = bridgeRecord ? getAttribute(bridgeRecord, "id") : undefined;

    if (!bridgeRecord || !rawId) {
      warnings.push(createWarningDiagnostic(
        "PROJECT_BRIDGE_SKIPPED",
        "Skipped a project bridge component because object or object id was missing.",
        "xml-importer",
        undefined,
        `microprocessor.group.components_bridge.c[${index}]`,
      ));
      continue;
    }

    projectBridges.set(rawId, {
      rawId,
      componentType,
      bridgeRecord,
      path: `microprocessor.group.components_bridge.c[${index}]`,
    });
  }

  return projectBridges;
}

// Fall back to editor-oriented bridge state data when bridge components are unavailable.
function collectProjectBridgesFromAlternateStates(root: unknown): Map<string, ProjectBridgeContext> {
  const projectBridges = new Map<string, ProjectBridgeContext>();
  const bridgeGroup = asRecord(getValueByPath(root, "microprocessor.group.component_bridge_states"));

  if (!bridgeGroup) {
    return projectBridges;
  }

  for (const [childName, childValue] of Object.entries(bridgeGroup)) {
    const bridgeRecord = asRecord(childValue);
    const rawId = bridgeRecord ? getAttribute(bridgeRecord, "id") : undefined;

    if (!bridgeRecord || !rawId) {
      continue;
    }

    projectBridges.set(rawId, {
      rawId,
      bridgeRecord,
      path: `microprocessor.group.component_bridge_states.${childName}`,
    });
  }

  return projectBridges;
}

// Import logic nodes from <components><c>, normalizing missing types to 0 for graph stability.
function collectLogicNodes(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  warnings: Diagnostic[],
): Map<string, IrNode> {
  const logicNodes = new Map<string, IrNode>();
  const components = getArrayByPath(root, "microprocessor.group.components.c");

  for (let index = 0; index < components.length; index += 1) {
    // object.id is the only identifier that later link sections can rely on, so missing ids are fatal here.
    const component = asRecord(components[index]);

    if (!component) {
      continue;
    }

    const componentType = getAttribute(component, "type") ?? "0";
    const objectRecord = asRecord(component.object);
    const rawId = objectRecord ? getAttribute(objectRecord, "id") : undefined;

    if (!objectRecord || !rawId) {
      warnings.push(createWarningDiagnostic(
        "LOGIC_COMPONENT_SKIPPED",
        "Skipped a logic component because object or object id was missing.",
        "xml-importer",
        undefined,
        `microprocessor.group.components.c[${index}]`,
      ));
      continue;
    }

    const definition = findComponentDefinitionByStormworksType(definitions, componentType);
    const definedProperties = extractDefinedProperties(
      component,
      definition,
      warnings,
      `microprocessor.group.components.c[${index}]`,
    );

    reconcileDynamicInputCount(objectRecord, definition, definedProperties);

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
        ...definedProperties,
      },
      source: {
        format: "stormworks-xml",
        path: `microprocessor.group.components.c[${index}]`,
      },
    };

    if (!definition) {
      warnings.push(createWarningDiagnostic(
        "LOGIC_COMPONENT_UNRESOLVED",
        `No definition matched logic component type ${componentType}; imported as a generic logic node.`,
        "xml-importer",
        undefined,
        `microprocessor.group.components.c[${index}]`,
      ));
    }

    program.nodes.push(importedNode);
    logicNodes.set(rawId, importedNode);
  }

  return logicNodes;
}

// Synthesize the implicit submodule boundary that sits between project pins and the logic body.
function synthesizeSubmodulePorts(
  projectNodes: Map<string, ProjectNodeContext>,
  projectBridges: Map<string, ProjectBridgeContext>,
  program: IrProgram,
  warnings: Diagnostic[],
): Map<string, SubmodulePortContext> {
  // XML has no explicit "submodule" object.
  // We synthesize one IR boundary so DSL/project representations can stay layered.
  const ports = new Map<string, SubmodulePortContext>();

  for (const [rawId, projectNode] of projectNodes) {
    const projectBridge = projectBridges.get(rawId);
    // The implicit submodule boundary keeps project.json and sw-net layered even though XML has no explicit module.
    const importedNode: IrNode = {
      id: `submodule:${rawId}`,
      layer: "submodule",
      definitionId: createSyntheticSubmoduleDefinitionId(projectNode.binding.direction, projectNode.binding.signal),
      position: projectBridge ? readBridgePosition(projectBridge.bridgeRecord) : projectNode.irNode.position,
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
        path: projectBridge?.path ?? projectNode.path,
      },
    };

    if (!projectBridge) {
      warnings.push(createWarningDiagnostic(
        "PROJECT_NODE_WITHOUT_BRIDGE",
        `Project node ${rawId} has no components_bridge.c entry.`,
        "xml-importer",
        undefined,
        projectNode.path,
      ));
    } else if (
      projectNode.definition?.stormworks.bridgeType !== undefined &&
      projectBridge.componentType !== undefined &&
      projectBridge.componentType !== projectNode.definition.stormworks.bridgeType
    ) {
      warnings.push(createWarningDiagnostic(
        "PROJECT_BRIDGE_TYPE_MISMATCH",
        `Project node ${rawId} expected bridge type ${projectNode.definition.stormworks.bridgeType} but found ${projectBridge.componentType}.`,
        "xml-importer",
        undefined,
        projectBridge.path,
      ));
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

  for (const [rawId, projectBridge] of projectBridges) {
    if (!projectNodes.has(rawId)) {
      warnings.push(createWarningDiagnostic(
        "BRIDGE_WITHOUT_PROJECT_NODE",
        `Bridge component ${rawId} has no matching project node.`,
        "xml-importer",
        undefined,
        projectBridge.path,
      ));
    }
  }

  return ports;
}

// Rebuild logic-to-logic and project-input-to-logic links from <components><c>.object.in* references.
function importLogicLinks(
  root: unknown,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  logicNodes: Map<string, IrNode>,
  submodulePorts: Map<string, SubmodulePortContext>,
  warnings: Diagnostic[],
): void {
  const components = getArrayByPath(root, "microprocessor.group.components.c");

  for (let index = 0; index < components.length; index += 1) {
    const component = asRecord(components[index]);

    if (!component) {
      continue;
    }

    const componentType = getAttribute(component, "type") ?? "0";
    const objectRecord = asRecord(component.object);
    const rawId = objectRecord ? getAttribute(objectRecord, "id") : undefined;

    if (!objectRecord || !rawId) {
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

      // Logic inputs can point either at another logic node or at a project-facing bridge component.
      const inputRecord = asRecord(childValue);

      if (!inputRecord) {
        continue;
      }

      const sourceRawId = getAttribute(inputRecord, "component_id");

      if (!sourceRawId) {
        continue;
      }

      const sourceEndpoint = resolveLinkSourceEndpoint(
        sourceRawId,
        logicNodes,
        submodulePorts,
        definitions,
        program,
        warnings,
        inputRecord,
      );

      program.links.push({
        id: `logic:${sourceRawId}->${rawId}:${childName}`,
        from: sourceEndpoint,
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

// Rebuild project-surface links, using bridge components to discover output-side bindings.
function importProjectAndBridgeLinks(
  projectNodes: Map<string, ProjectNodeContext>,
  projectBridges: Map<string, ProjectBridgeContext>,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  logicNodes: Map<string, IrNode>,
  submodulePorts: Map<string, SubmodulePortContext>,
  warnings: Diagnostic[],
): void {
  for (const [rawId, projectNode] of projectNodes) {
    const projectBridge = projectBridges.get(rawId);
    const submodulePort = submodulePorts.get(rawId);

    if (!submodulePort) {
      continue;
    }

    if (projectNode.binding.direction === "input") {
      // Project inputs are simple: XML already says the outside world feeds the module boundary directly.
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
          path: projectBridge?.path ?? projectNode.path,
        },
      });
      continue;
    }

    const outputBindings = getBridgeInputBindings(projectBridge?.bridgeRecord);

    // Project outputs need the bridge section because XML stores the internal driving component there.
    if (!projectBridge) {
      warnings.push(createWarningDiagnostic(
        "PROJECT_OUTPUT_WITHOUT_BRIDGE",
        `Project output node ${rawId} has no components_bridge.c entry.`,
        "xml-importer",
        undefined,
        projectNode.path,
      ));
    } else if (outputBindings.length === 0) {
      warnings.push(createWarningDiagnostic(
        "BRIDGE_OUTPUT_SOURCE_MISSING",
        `Output bridge ${rawId} does not specify an internal source component.`,
        "xml-importer",
        undefined,
        projectBridge.path,
      ));
    }

    for (const binding of outputBindings) {
      // Output bridges can currently fan in from either logic nodes or synthesized external inputs.
      const sourceRawId = getAttribute(binding.record, "component_id");

      if (!sourceRawId) {
        continue;
      }

      const sourceEndpoint = resolveLinkSourceEndpoint(
        sourceRawId,
        logicNodes,
        submodulePorts,
        definitions,
        program,
        warnings,
        binding.record,
      );

      program.links.push({
        id: `submodule-binding:${sourceRawId}->${rawId}:${binding.tagName}`,
        from: sourceEndpoint,
        to: {
          nodeId: submodulePort.irNode.id,
          portKey: submodulePort.logicFacingPortKey,
        },
        source: {
          format: "stormworks-xml",
          path: projectBridge ? `${projectBridge.path}.object.${binding.tagName}` : projectNode.path,
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
        path: projectBridge?.path ?? projectNode.path,
      },
    });
  }
}

// Resolve an XML component_id reference into the IR source endpoint used by link import paths.
function resolveLinkSourceEndpoint(
  sourceRawId: string,
  logicNodes: Map<string, IrNode>,
  submodulePorts: Map<string, SubmodulePortContext>,
  definitions: NodeDefinitionRegistry,
  program: IrProgram,
  warnings: Diagnostic[],
  inputRecord: Record<string, unknown>,
): IrPortEndpoint {
  const logicSourceNode = logicNodes.get(sourceRawId);

  if (logicSourceNode) {
    return {
      nodeId: logicSourceNode.id,
      portKey: resolveSourcePortKey(logicSourceNode, definitions, inputRecord),
    };
  }

  // Missing logic nodes can be legitimate project-boundary inputs; synthesize exactly once so links survive.
  const sourceSubmodulePort = ensureSubmoduleInputPort(submodulePorts, sourceRawId, program, warnings, inputRecord);
  return {
    nodeId: sourceSubmodulePort.irNode.id,
    portKey: sourceSubmodulePort.logicFacingPortKey,
  };
}

// Register the single implicit submodule that XML import exposes to the DSL side.
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

// Create synthetic module-input ports for unresolved external references so links do not disappear.
function ensureSubmoduleInputPort(
  submodulePorts: Map<string, SubmodulePortContext>,
  rawId: string,
  program: IrProgram,
  warnings: Diagnostic[],
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

  warnings.push(createWarningDiagnostic(
    "SUBMODULE_EXTERNAL_INPUT_SYNTHESIZED",
    `Synthesized a submodule input port for external component_id=${rawId} referenced from components.c or components_bridge.c.`,
    "xml-importer",
    undefined,
    describeInputRecord(inputRecord),
  ));

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

// Resolve a project pin into the normalized IR-facing binding used by later serializers.
function resolveProjectNodeBinding(
  type: string,
  mode: string | undefined,
  definition: ProjectNodeDefinition | undefined,
): ProjectNodeBinding {
  if (definition) {
    return createProjectNodeBindingFromDefinition(definition);
  }

  // Fallback inference keeps unknown project node types visible instead of dropping them on the floor.
  const direction = inferProjectDirection(mode ?? "0");
  const signal = inferProjectSignal(type);

  return {
    definitionId: `PROJECT_NODE:${toProjectTypeKey(type, mode)}`,
    direction,
    signal,
    projectPortKey: createProjectPortKey(direction, signal),
  };
}

// Convert a project-node definition into the normalized binding shape shared by inferred nodes.
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

// Infer project pin direction directly from node mode when no explicit definition is available.
function inferProjectDirection(
  mode: string,
): SubmodulePortDirection {
  if (mode === "1") {
    return "input";
  }

  return "output";
}

// Infer the project signal kind from the raw Stormworks node type code.
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

// Pick the normalized port key used by IR for project-facing pins.
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

// Name synthesized submodule boundary nodes in a way serializers can pattern-match later.
function createSyntheticSubmoduleDefinitionId(
  direction: SubmodulePortDirection,
  signal: IrSignalKind,
): string {
  return `SUBMODULE_PORT:${direction}:${signal}`;
}

// Read bridge-side source bindings from in* children on bridge records.
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

// Some Stormworks-authored saves omit a dynamic-input component's count attribute (e.g. after
// Stormworks-authored variants), even though wired inN entries extend past the schema default. Since links are
// imported independently of the declared count (see importLogicLinks), a too-small count would
// silently make dsl2xml re-export fewer <inN> slots than are actually wired, and Stormworks itself
// discards any connection beyond the declared count when it next resaves the file. Raise count to
// cover the highest wired dynamic input index actually present, matching what the source data implies.
function reconcileDynamicInputCount(
  objectRecord: Record<string, unknown>,
  definition: ComponentDefinition | undefined,
  properties: Record<string, IrScalarValue>,
): void {
  const dynamicInputs = definition?.stormworks.dynamicInputs;

  if (!dynamicInputs) {
    return;
  }

  const prefixPattern = new RegExp(`^${escapeRegExp(dynamicInputs.prefix)}(\\d+)$`);
  let maxWiredIndex = 0;

  for (const [childName, childValue] of Object.entries(objectRecord)) {
    const match = prefixPattern.exec(childName);

    if (!match?.[1]) {
      continue;
    }

    const childRecord = asRecord(childValue);

    if (!childRecord || getAttribute(childRecord, "component_id") === undefined) {
      continue;
    }

    const wiredIndex = Number.parseInt(match[1], 10);

    if (Number.isFinite(wiredIndex) && wiredIndex > maxWiredIndex) {
      maxWiredIndex = wiredIndex;
    }
  }

  if (maxWiredIndex === 0) {
    return;
  }

  const declaredCount = properties[dynamicInputs.countProperty];
  const numericDeclaredCount = typeof declaredCount === "number" ? declaredCount : 0;

  if (maxWiredIndex > numericDeclaredCount) {
    properties[dynamicInputs.countProperty] = maxWiredIndex;
  }
}

// Extract definition-driven properties from XML into normalized IR scalar values.
function extractDefinedProperties(
  sourceRecord: Record<string, unknown>,
  definition: DefinitionBase | undefined,
  warnings: Diagnostic[],
  path: string,
): Record<string, IrScalarValue> {
  const properties: Record<string, IrScalarValue> = {
    ...(definition?.defaults ?? {}),
  };

  for (const propertyDefinition of definition?.properties ?? []) {
    const value = extractPropertyValue(
      sourceRecord,
      propertyDefinition.valueType,
      propertyDefinition.source,
      propertyDefinition.enum,
      propertyDefinition.xmlDelta,
      propertyDefinition.xmlDeltaExcept,
    );

    if (value !== undefined) {
      properties[propertyDefinition.key] = value;
      continue;
    }

    if (propertyDefinition.required && properties[propertyDefinition.key] === undefined) {
      warnings.push(createWarningDiagnostic(
        "PROPERTY_MISSING",
        `Required property ${propertyDefinition.key} was not found for ${definition?.id ?? "unknown"}.`,
        "xml-importer",
        undefined,
        path,
      ));
    }
  }

  return properties;
}

// Preserve unclaimed object attributes so unknown nodes can still round-trip through the DSL.
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

// Detect when a definition property reads a direct object attribute so it is not duplicated later.
function tryGetDirectObjectAttributeName(source: NodePropertySource | undefined): string | undefined {
  if (!source) {
    return undefined;
  }

  const match = /^object\.@([A-Za-z0-9_]+)$/.exec(source.xmlPath);
  return match?.[1];
}

// Resolve one property value from its XML path and coerce it into the requested scalar type.
function extractPropertyValue(
  sourceRecord: Record<string, unknown>,
  valueType: DefinitionValueType,
  source: NodePropertySource | undefined,
  enumMapping?: Record<string, number>,
  xmlDelta?: number,
  xmlDeltaExcept?: number,
): IrScalarValue | undefined {
  if (!source) {
    return undefined;
  }

  const rawValue = getValueByPath(sourceRecord, source.xmlPath);

  if (rawValue === undefined) {
    return undefined;
  }

  if (source.itemList) {
    return extractItemListValue(rawValue);
  }

  const numericValue = coerceScalarValue(rawValue, "number");

  if (enumMapping !== undefined && typeof numericValue === "number") {
    const label = Object.entries(enumMapping).find(([, v]) => v === numericValue)?.[0];
    return label ?? numericValue;
  }

  if (xmlDelta !== undefined && typeof numericValue === "number") {
    if (xmlDeltaExcept === undefined || numericValue !== xmlDeltaExcept) {
      return numericValue - xmlDelta;
    }
    return numericValue;
  }

  return coerceScalarValue(rawValue, valueType);
}


// Read a Selector-style <items><i l=".."><v text=".." value=".."/></i></items> list into a stable
// {l, value} JSON array; attribute values are kept as raw strings to avoid numeric formatting drift.
// A childless self-closing <items/> parses to "" (not an object) and is treated as "no items" here.
function extractItemListValue(rawValue: unknown): IrScalarValue | undefined {
  const record = asRecord(rawValue);

  if (!record) {
    return undefined;
  }

  const rawItems = record.i;
  const itemRecords = rawItems === undefined ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];

  if (itemRecords.length === 0) {
    return undefined;
  }

  const items = itemRecords.map((itemValue) => {
    const itemRecord = asRecord(itemValue) ?? {};
    const valueRecord = asRecord(itemRecord.v) ?? {};

    return {
      l: getAttribute(itemRecord, "l") ?? null,
      value: getAttribute(valueRecord, "value") ?? getAttribute(valueRecord, "text") ?? null,
    };
  });

  return JSON.stringify(items);
}

// Coerce unclaimed object attributes into best-effort scalar values for generic round-tripping.
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

// Build the registry lookup key for project nodes from raw XML type/mode values.
function toProjectTypeKey(type: string, mode?: string): string {
  return `${type}:${mode ?? "0"}`;
}

// Resolve an XML-side output reference into a DSL/IR source port key.
function resolveSourcePortKey(
  sourceNode: IrNode,
  definitions: NodeDefinitionRegistry,
  inputRecord: Record<string, unknown>,
): string {
  const sourceDefinition = findCompatibleComponentDefinition(definitions, sourceNode.definitionId);
  const rawIndex = getAttribute(inputRecord, "node_index");
  const parsedIndex = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;

  // node_index is only meaningful for explicit multi-output components; otherwise we fall back to the primary output.
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

// Resolve an XML input tag such as in1/in2/inc into the normalized target port key.
function resolveTargetPortKey(definition: ComponentDefinition | undefined, rawPortKey: string): string {
  if (!definition) {
    return rawPortKey;
  }

  // Explicit xmlKey aliases win first, then dynamic inN families, then positional inN fallback.
  const explicitInput = definition.ports.inputs.find((input) => input.stormworks?.xmlKey === rawPortKey);

  if (explicitInput) {
    return explicitInput.key;
  }

  if (rawPortKey === "inc") {
    return rawPortKey;
  }

  const dynamicInputPrefix = definition.stormworks.dynamicInputs?.prefix;

  if (dynamicInputPrefix && new RegExp(`^${escapeRegExp(dynamicInputPrefix)}\\d+$`).test(rawPortKey)) {
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

// Escape literal text so XML input-key patterns can be compiled into safe regular expressions.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read a nested XML position record while allowing each Stormworks scope to use its own path/axis names.
function readPosition(record: Record<string, unknown>, positionPath: string, yAxisKey: "y" | "z"): { x: number; y: number } | undefined {
  const positionRecord = asRecord(getValueByPath(record, positionPath));

  if (!positionRecord) {
    return undefined;
  }

  return {
    x: parseNumberAttribute(positionRecord, "x") ?? 0,
    y: parseNumberAttribute(positionRecord, yAxisKey) ?? 0,
  };
}

// Read the vehicle-space position attached to a project node.
function readProjectPosition(nodeRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  return readPosition(nodeRecord, "position", "z");
}

// Read the bridge-canvas position attached to a project bridge record.
function readBridgePosition(bridgeRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  return readPosition(bridgeRecord, "pos", "y");
}

// Read the module-canvas position attached to a logic component.
function readLogicPosition(componentRecord: Record<string, unknown>): { x: number; y: number } | undefined {
  return readPosition(componentRecord, "object.pos", "y");
}

// Walk a dotted path through the parsed XML object tree.
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

// Normalize one tree value into an array so callers can consume singletons and arrays uniformly.
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

// Read one XML attribute from the parser's @_ prefixed attribute convention.
function getAttribute(record: Record<string, unknown>, attributeName: string): string | undefined {
  const value = record[`@_${attributeName}`];
  return typeof value === "string" ? value : undefined;
}

// Parse one numeric XML attribute from the parser's string-backed representation.
function parseNumberAttribute(record: Record<string, unknown>, attributeName: string): number | undefined {
  const value = getAttribute(record, attributeName);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Narrow unknown values into plain object records before property access.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

// Treat in1/in2/inc-style child names as XML input bindings.
function isInputTagName(name: string): boolean {
  return name === "inc" || /^in\d+$/.test(name);
}

// Describe one XML input record for diagnostics when no stable source path is available.
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
