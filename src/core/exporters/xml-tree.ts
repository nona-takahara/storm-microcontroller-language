// XML tree exporter that lowers project.json, sw-net, and sw-mcl into the object structure later written as XML.
import {
  extractCompatibleStormworksType,
  findCompatibleComponentDefinition,
  type NodeDefinitionRegistry,
} from "../definitions/loader.js";
import {
  type ComponentDefinition,
  type ComponentDynamicInputsBinding,
  type DefinitionValueType,
  type NodePropertyDefinition,
  type NodePropertyWriteTarget,
  type ProjectNodeDefinition,
} from "../definitions/schema.js";
import { createWarningDiagnostic, type Diagnostic } from "../diagnostics.js";
import { type IrSignalKind, type IrScalarValue, type IrVector2 } from "../ir.js";
import { type SwNetAssignment, type SwNetExpression, type SwNetInstStatement, type SwNetModule, type SwNetPort } from "../parsers/sw-net.js";
import { type ProjectJsonDocument, type ProjectJsonLinkDocument, type ProjectJsonNodeDocument } from "../serializers/project-json.js";
import { addVector } from "../serializers/submodule-layout.js";
import { type StormworksSwMclDocument } from "../serializers/sw-mcl.js";
import { formatPortNameKey, formatPortOccurrenceKey } from "../serializers/sw-net-shared.js";
import { type SwNetResolutionResult, type SwNetResolvedModule, type SwNetResolvedModuleKey } from "../resolvers/sw-net.js";
import { registerFirstProducer } from "../shared/producer-index.js";

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
  documentPath: string;
  moduleId: string;
  instanceId: string;
  typeId: string;
}

export interface BuildStormworksXmlTreeInput {
  project: ProjectJsonDocument;
  swNet: SwNetResolutionResult;
  // Keyed by sw-net document path so `use` statements can pull layout from a module living in another document.
  swMclByDocumentPath: Map<string, StormworksSwMclDocument>;
}

export interface BuildStormworksXmlTreeResult {
  tree: StormworksXmlTreeDocument;
  warnings: Diagnostic[];
}

interface ProjectNodeContext {
  document: ProjectJsonNodeDocument;
  definition: ProjectNodeDefinition;
  xmlNodeId: number;
  componentId: number;
  direction: "input" | "output";
  signal: IrSignalKind;
  bridgeType: string;
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
  // The module a flattened `use` instance was authored in, needed to resolve its script_ref against the right document.
  sourceModuleKey: SwNetResolvedModuleKey;
}

// One `use` statement lowered to a flat, namespaced inst-equivalent record ready for id allocation.
interface FlattenedInstance {
  statement: SwNetInstStatement;
  sourceModuleKey: SwNetResolvedModuleKey;
  position?: IrVector2;
}

// Absolute instance positions for the module currently being flattened, plus the degraded fallback
// used when that module's own sw-mcl could not be resolved (see buildFlattenLayoutContext).
interface FlattenLayoutContext {
  instancePositionById: Map<string, IrVector2>;
  fallbackPosition: IrVector2 | undefined;
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

// Export warnings are emitted as structured diagnostics at their source so callers do not need
// adapter code that can drift between CLI, MCP, and library entry points.
function pushExportWarning(warnings: Diagnostic[], message: string, path?: string): void {
  warnings.push(createWarningDiagnostic("EXPORT_WARNING", message, "exporter", undefined, path));
}


// Reconstruct the structured XML object tree from project.json, sw-net, and sw-mcl.
export function buildStormworksXmlTree(
  input: BuildStormworksXmlTreeInput,
  options: BuildStormworksXmlTreeOptions,
): BuildStormworksXmlTreeResult {
  // This stage stops at a plain object tree on purpose.
  // XML string generation is a separate concern layered on top of this structure.
  const warnings: Diagnostic[] = [];
  const entryModule = resolveEntryModule(input.swNet, options.entryModuleId);

  // Resolve every view of the same module before lowering:
  // sw-net for structure, sw-mcl for inner layout, and project.json for outer placement.
  const entrySwMcl = input.swMclByDocumentPath.get(entryModule.key.documentPath);
  const submoduleCanvasOrigin = resolveSubmoduleCanvasOrigin(input.project, entryModule.key.moduleId, warnings);

  if (!entrySwMcl) {
    pushExportWarning(
      warnings,
      `sw-mcl for entry module ${entryModule.key.moduleId} was not found; instances will share the module canvas anchor position.`,
    );
  }

  const swMclModule = entrySwMcl ? resolveSwMclModule(entrySwMcl, entryModule.key.moduleId) : null;
  const entryAnchorFallback = submoduleCanvasOrigin ?? { x: 0, y: 0 };
  const entryLayout = buildFlattenLayoutContext(
    swMclModule,
    submoduleCanvasOrigin,
    swMclModule ? undefined : entryAnchorFallback,
  );
  const moduleByKey = buildModuleByKeyIndex(input.swNet.modules);
  const flattenedInstances: FlattenedInstance[] = [];

  // `use` statements have no XML counterpart, so every reachable module is inlined into one flat
  // instance list here before any XML-shaped structures are built.
  flattenModule(
    entryModule.key,
    "",
    new Map(),
    entryLayout,
    true,
    moduleByKey,
    input.swMclByDocumentPath,
    flattenedInstances,
    warnings,
  );

  const allocator = createXmlIdAllocator([]);
  const logicInstances = buildLogicInstanceContexts(flattenedInstances, options.definitions, allocator);
  const projectNodes = buildProjectNodeContexts(input.project, options.definitions, allocator);
  const projectPortBindings = bindProjectNodesToModulePorts(
    input.project.links,
    projectNodes,
    buildModulePortSlots(entryModule.module, swMclModule, submoduleCanvasOrigin, warnings),
    entryModule.key.moduleId,
    warnings,
  );

  // Once project nodes, port slots, and logic producers are indexed, the remaining XML sections are pure projection.
  const netProducerByName = buildNetProducerIndex(logicInstances, warnings);
  const projectOutputBindings = buildProjectOutputBindingIndex(logicInstances);
  const projectNodeElements = projectNodes.map((projectNode) => buildProjectNodeElement(projectNode));
  const bridgeElements = buildBridgeElements(
    projectNodes,
    projectPortBindings.portSlotsByProjectNodeId,
    projectOutputBindings,
    warnings,
  );
  const componentElements = logicInstances.map((instance) =>
    buildComponentElement(instance, netProducerByName, projectPortBindings.projectNodeByPortKey, warnings, options),
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
        bridgeElements,
        componentStateElements,
        bridgeStateElements,
        idCounter,
        idCounterNode,
      ),
    },
    warnings,
  };
}

// Pick the single sw-net module that will be lowered into one Stormworks microcontroller body.
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

// Match the sw-mcl document to the entry module that is being exported.
function resolveSwMclModule(
  swMcl: StormworksSwMclDocument,
  moduleId: string,
): StormworksSwMclDocument {
  if (swMcl.moduleId !== moduleId) {
    throw new Error(`sw-mcl layout targets module ${swMcl.moduleId}, but XML export needs ${moduleId}.`);
  }

  return swMcl;
}

// Read the project-side placement anchor for the module canvas being exported.
function resolveSubmoduleCanvasOrigin(
  project: ProjectJsonDocument,
  moduleId: string,
  warnings: Diagnostic[],
): IrVector2 | null {
  // sw-mcl stores module-local positions; project.json provides the placement anchor for XML export.
  const matchingSubmodule =
    project.submodules.find((submodule) => submodule.id === moduleId) ??
    project.submodules.find((submodule) => submodule.name === moduleId);

  if (!matchingSubmodule) {
    pushExportWarning(warnings, `project.json does not define a submodule entry for ${moduleId}; treating sw-mcl positions as absolute.`);
    return null;
  }

  return matchingSubmodule.position;
}

// Allocate XML ids deterministically while avoiding collisions between regenerated nodes.
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

// Lower project.json node entries into export-ready contexts with resolved definitions and XML ids.
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
      bridgeType: projectDefinition.stormworks.bridgeType ?? inferBridgeType(direction, signal),
    };
  });
}

// Merge sw-net port declarations with sw-mcl positions into concrete export-time module port slots.
function buildModulePortSlots(
  entryModule: SwNetResolvedModule["module"],
  swMclModule: StormworksSwMclDocument | null,
  submoduleCanvasOrigin: IrVector2 | null,
  warnings: Diagnostic[],
): ModulePortSlot[] {
  const occurrenceByKey = new Map<string, number>();
  const positionByKey = new Map(
    (swMclModule?.ports ?? []).map((port) => [
      formatPortOccurrenceKey(port.direction, port.name, port.occurrence),
      addVector(port.position, submoduleCanvasOrigin),
    ] as const),
  );

  return entryModule.ports.map((port) => {
    // sw-net names ports semantically, while sw-mcl names positions by occurrence; join both here.
    const occurrenceKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByKey.get(occurrenceKey) ?? 0) + 1;
    occurrenceByKey.set(occurrenceKey, occurrence);
    const key = formatPortOccurrenceKey(port.direction, port.name, occurrence);
    const position = positionByKey.get(key);

    if (!position) {
      pushExportWarning(warnings, `sw-mcl is missing a port layout entry for ${key}.`);
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

// Bind project-surface nodes to concrete module-port occurrences using project.json links.
function bindProjectNodesToModulePorts(
  links: ProjectJsonLinkDocument[],
  projectNodes: ProjectNodeContext[],
  portSlots: ModulePortSlot[],
  entryModuleId: string,
  warnings: Diagnostic[],
): ProjectPortBindingContext {
  const projectNodeById = new Map(projectNodes.map((node) => [node.document.id, node] as const));
  const portSlotsByName = new Map<string, ModulePortSlot[]>();
  const pendingProjectNodesByPort = new Map<string, ProjectNodeContext[]>();
  const portSlotsByProjectNodeId = new Map<string, ModulePortSlot>();
  const projectNodeByPortKey = new Map<string, ProjectNodeContext>();

  for (const portSlot of portSlots) {
    // Group slots by semantic name first, then bind concrete occurrences in project-link order.
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

    // project.json and sw-net must agree on how many concrete ports exist for a given semantic name.
    if (slots.length !== boundProjectNodes.length) {
      pushExportWarning(warnings, `Project links reference ${boundProjectNodes.length} ${key} port(s), but sw-net defines ${slots.length}.`);
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
        pushExportWarning(
          warnings,
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

// Resolve one project.json link into a project-node-to-module-port binding candidate.
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

// Allocate XML ids and resolve component definitions for the already-flattened instance list.
function buildLogicInstanceContexts(
  flattenedInstances: FlattenedInstance[],
  definitions: NodeDefinitionRegistry,
  allocator: XmlIdAllocator,
): LogicInstanceContext[] {
  return flattenedInstances.map((flattened) => {
    // Export needs both the raw Stormworks type code and an allocated object id for every instance.
    const componentDefinition = findCompatibleComponentDefinition(definitions, flattened.statement.typeId);
    const stormworksType = resolveStormworksComponentType(flattened.statement.typeId, componentDefinition);

    return {
      statement: flattened.statement,
      definition: componentDefinition,
      stormworksType,
      objectId: allocator.allocate(tryParseInstanceObjectId(flattened.statement.instanceId)),
      position: flattened.position,
      sourceModuleKey: flattened.sourceModuleKey,
    };
  });
}

// Build a lookup from every resolved module's key to itself for O(1) access during flattening.
function buildModuleByKeyIndex(modules: SwNetResolvedModule[]): Map<string, SwNetResolvedModule> {
  return new Map(modules.map((module) => [formatModuleKey(module.key), module] as const));
}

// Reject a module body that declares two inst/use statements under the same instance id. The flatten
// pass' namespacing scheme (`${namespace}$${instanceId}`) only stays collision-free if every module's
// own statements already have unique instance ids; two `use` instances sharing an id would otherwise
// silently alias their inlined nets onto each other.
function assertUniqueStatementInstanceIds(module: SwNetModule, moduleKey: SwNetResolvedModuleKey): void {
  const seen = new Set<string>();

  for (const statement of module.statements) {
    if (seen.has(statement.instanceId)) {
      throw new Error(
        `Duplicate instance id ${statement.instanceId} in module ${formatModuleKey(moduleKey)}; every inst/use statement needs a unique instance id.`,
      );
    }

    seen.add(statement.instanceId);
  }
}

// Build the position lookup for one module's own instances, or the degraded single-anchor fallback
// used when that module's sw-mcl could not be resolved (e.g. a same-document helper module that isn't
// the file's paired layout module -- see known limitation tracked in issue #7).
function buildFlattenLayoutContext(
  swMclModule: StormworksSwMclDocument | null,
  positionAnchor: IrVector2 | null,
  fallbackPosition: IrVector2 | undefined,
): FlattenLayoutContext {
  if (!swMclModule) {
    return { instancePositionById: new Map(), fallbackPosition };
  }

  return {
    instancePositionById: new Map(
      swMclModule.instances.map((instance) => [instance.id, addVector(instance.position, positionAnchor)] as const),
    ),
    fallbackPosition: undefined,
  };
}

// Resolve one instance's absolute position, falling back to the shared anchor when the owning
// module's sw-mcl is unresolvable (skips the per-instance warning in that case; the caller already
// warned once when the sw-mcl lookup failed).
function resolveInstancePosition(
  layout: FlattenLayoutContext,
  instanceId: string,
  namespacedInstanceId: string,
  warnings: Diagnostic[],
): IrVector2 | undefined {
  if (layout.fallbackPosition !== undefined) {
    return layout.fallbackPosition;
  }

  const position = layout.instancePositionById.get(instanceId);

  if (!position) {
    pushExportWarning(warnings, `sw-mcl is missing an instance layout entry for ${namespacedInstanceId}.`);
  }

  return position;
}

// Look up a module's own paired sw-mcl without throwing (unlike resolveSwMclModule, which is reserved
// for the entry module where a mismatch is a hard configuration error).
function tryResolveModuleSwMcl(
  swMclByDocumentPath: Map<string, StormworksSwMclDocument>,
  moduleKey: SwNetResolvedModuleKey,
): StormworksSwMclDocument | null {
  const candidate = swMclByDocumentPath.get(moduleKey.documentPath);
  return candidate && candidate.moduleId === moduleKey.moduleId ? candidate : null;
}

// Resolve one sw-net expression from the module currently being flattened into a global, entry-scope
// expression: identifiers always get namespaced into module-local net names — per this tool's
// documented convention (src/core/spec/tool-conventions.ts), a bare identifier is always an internal
// net local to the module, even if its text happens to match a declared port name; only a quoted
// string references the module's own declared port. String port references get substituted with
// whatever the caller already bound that port to, looked up by the port's own declared direction
// rather than the local usage site's, since a module may read its own output port back internally as
// a feedback input (or, symmetrically, expose one of its own input ports as an output — unusual, but
// not disallowed). At the entry module, strings still name real project.json ports and pass through
// unchanged.
function resolveFlattenExpr(
  expr: SwNetExpression,
  direction: "in" | "out",
  namespace: string,
  portBindings: Map<string, SwNetExpression>,
  isEntryModule: boolean,
  modulePortDirections: ReadonlyMap<string, "in" | "out">,
  contextLabel: string,
  warnings: Diagnostic[],
): SwNetExpression | undefined {
  if (expr.kind === "identifier") {
    return {
      kind: "identifier",
      value: namespace ? `${namespace}$${expr.value}` : expr.value,
    };
  }

  if (expr.kind === "string") {
    if (isEntryModule) {
      return expr;
    }

    const portDirection = modulePortDirections.get(expr.value) ?? direction;
    const resolved = portBindings.get(formatPortBindingKey(portDirection, expr.value));

    if (!resolved) {
      pushExportWarning(warnings, `${contextLabel} references undeclared module port "${expr.value}".`);
      return undefined;
    }

    return resolved;
  }

  return expr;
}

// Build a name -> declared-direction map for the ports of the module currently being flattened, so a
// quoted string port reference resolves against the caller's binding for that port's own declared
// direction, regardless of which direction it's used in locally.
function buildModulePortDirections(ports: SwNetPort[]): ReadonlyMap<string, "in" | "out"> {
  return new Map(ports.map((port) => [port.name, port.direction]));
}

// Resolve a whole inst/use pin-assignment list through resolveFlattenExpr, dropping assignments that
// could not be resolved (resolveFlattenExpr already warned for those).
function resolveAssignmentList(
  assignments: SwNetAssignment[],
  direction: "in" | "out",
  namespace: string,
  portBindings: Map<string, SwNetExpression>,
  isEntryModule: boolean,
  modulePortDirections: ReadonlyMap<string, "in" | "out">,
  contextLabel: string,
  warnings: Diagnostic[],
): SwNetAssignment[] {
  const resolved: SwNetAssignment[] = [];

  for (const assignment of assignments) {
    const value = resolveFlattenExpr(
      assignment.value,
      direction,
      namespace,
      portBindings,
      isEntryModule,
      modulePortDirections,
      contextLabel,
      warnings,
    );

    if (value !== undefined) {
      resolved.push({ key: assignment.key, value });
    }
  }

  return resolved;
}

// Build the `in:<port>`/`out:<port>` binding-map key shared by resolveFlattenExpr and use-statement lowering.
function formatPortBindingKey(direction: "in" | "out", portName: string): string {
  return `${direction}:${portName}`;
}

// Recursively inline one module's statements into `out`, expanding every `use` statement into its
// target module's own (further-flattened) instances. Stormworks XML has no module concept, so this is
// the only place composite `use` semantics get lowered to something the rest of the exporter understands.
function flattenModule(
  moduleKey: SwNetResolvedModuleKey,
  namespace: string,
  portBindings: Map<string, SwNetExpression>,
  layout: FlattenLayoutContext,
  isEntryModule: boolean,
  moduleByKey: Map<string, SwNetResolvedModule>,
  swMclByDocumentPath: Map<string, StormworksSwMclDocument>,
  out: FlattenedInstance[],
  warnings: Diagnostic[],
): void {
  const resolvedModule = moduleByKey.get(formatModuleKey(moduleKey));

  if (!resolvedModule) {
    throw new Error(`Resolved module ${formatModuleKey(moduleKey)} was not indexed.`);
  }

  assertUniqueStatementInstanceIds(resolvedModule.module, moduleKey);

  const modulePortDirections = buildModulePortDirections(resolvedModule.module.ports);

  for (const statement of resolvedModule.module.statements) {
    const namespacedInstanceId = namespace ? `${namespace}$${statement.instanceId}` : statement.instanceId;
    const contextLabel = `Instance ${namespacedInstanceId}`;

    if (statement.kind === "inst") {
      out.push({
        statement: {
          kind: "inst",
          typeId: statement.typeId,
          instanceId: namespacedInstanceId,
          attributes: statement.attributes,
          inputs: resolveAssignmentList(
            statement.inputs,
            "in",
            namespace,
            portBindings,
            isEntryModule,
            modulePortDirections,
            contextLabel,
            warnings,
          ),
          outputs: resolveAssignmentList(
            statement.outputs,
            "out",
            namespace,
            portBindings,
            isEntryModule,
            modulePortDirections,
            contextLabel,
            warnings,
          ),
        },
        sourceModuleKey: moduleKey,
        position: resolveInstancePosition(layout, statement.instanceId, namespacedInstanceId, warnings),
      });
      continue;
    }

    // `use` statement: resolve its own bindings in the current scope, then recurse into the target
    // module with those as the child's port bindings.
    const childPortBindings = new Map<string, SwNetExpression>();

    for (const assignment of statement.inputs) {
      const value = resolveFlattenExpr(
        assignment.value,
        "in",
        namespace,
        portBindings,
        isEntryModule,
        modulePortDirections,
        contextLabel,
        warnings,
      );

      if (value !== undefined) {
        childPortBindings.set(formatPortBindingKey("in", assignment.key), value);
      }
    }

    for (const assignment of statement.outputs) {
      const value = resolveFlattenExpr(
        assignment.value,
        "out",
        namespace,
        portBindings,
        isEntryModule,
        modulePortDirections,
        contextLabel,
        warnings,
      );

      if (value !== undefined) {
        childPortBindings.set(formatPortBindingKey("out", assignment.key), value);
      }
    }

    const useEdge = resolvedModule.uses.find((candidate) => candidate.statement === statement);

    if (!useEdge) {
      throw new Error(`Use statement ${namespacedInstanceId} in ${formatModuleKey(moduleKey)} was not resolved.`);
    }

    const useAnchor = resolveInstancePosition(layout, statement.instanceId, namespacedInstanceId, warnings);
    const targetSwMclModule = tryResolveModuleSwMcl(swMclByDocumentPath, useEdge.target);

    if (!targetSwMclModule) {
      pushExportWarning(
        warnings,
        `sw-mcl for module ${formatModuleKey(useEdge.target)} was not found; instances embedded via "${namespacedInstanceId}" will share its anchor position.`,
      );
    }

    const childLayout = buildFlattenLayoutContext(
      targetSwMclModule,
      useAnchor ?? null,
      targetSwMclModule ? undefined : useAnchor,
    );

    flattenModule(
      useEdge.target,
      namespacedInstanceId,
      childPortBindings,
      childLayout,
      false,
      moduleByKey,
      swMclByDocumentPath,
      out,
      warnings,
    );
  }
}

// Index which logic instance produces each internal net name referenced by XML inputs.
function buildNetProducerIndex(
  logicInstances: LogicInstanceContext[],
  warnings: Diagnostic[],
): Map<string, NetProducer> {
  const producers = new Map<string, NetProducer>();

  for (const instance of logicInstances) {
    for (const output of instance.statement.outputs) {
      if (output.value.kind !== "identifier") {
        continue;
      }

      registerFirstProducer(
        producers,
        output.value.value,
        {
          instance,
          outputKey: output.key,
        },
        (netName) => {
          pushExportWarning(warnings, `Multiple instance outputs drive net ${netName}; using the first producer.`);
        },
      );
    }
  }

  return producers;
}

// Index which logic producer feeds each exported module output port.
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

// Stormworks omits type="0" (the default component/node/bridge type) from authored XML.
function isDefaultComponentType(type: string): boolean {
  return type === "0";
}

// Emit one <nodes><n> element for a project-facing pin.
function buildProjectNodeElement(projectNode: ProjectNodeContext): StormworksXmlTreeElement {
  const nodeElement: StormworksXmlTreeElement = {
    "@_label": projectNode.document.label ?? projectNode.document.id,
    "@_description": projectNode.document.description ?? "",
  };

  if (!isDefaultComponentType(projectNode.definition.stormworks.type)) {
    nodeElement["@_type"] = projectNode.definition.stormworks.type;
  }

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

// Emit one <components><c> element for a lowered sw-net instance.
function buildComponentElement(
  instance: LogicInstanceContext,
  netProducerByName: Map<string, NetProducer>,
  projectNodeByPortKey: Map<string, ProjectNodeContext>,
  warnings: Diagnostic[],
  options: BuildStormworksXmlTreeOptions,
): StormworksXmlTreeElement {
  const componentElement: StormworksXmlTreeElement = {
    object: {
      "@_id": String(instance.objectId),
    },
  };

  if (!isDefaultComponentType(instance.stormworksType)) {
    componentElement["@_type"] = instance.stormworksType;
  }

  const objectElement = asTreeElement(componentElement.object);

  applyInstanceAttributes(
    componentElement,
    instance,
    warnings,
    options,
    instance.sourceModuleKey.documentPath,
    instance.sourceModuleKey.moduleId,
  );

  if (instance.position) {
    objectElement.pos = {
      "@_x": formatXmlNumber(instance.position.x),
      "@_y": formatXmlNumber(instance.position.y),
    };
  }

  for (const input of instance.statement.inputs) {
    // Each DSL input assignment becomes one XML in* element after resolving net names and module-port refs.
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

  applyDynamicInputPlaceholders(instance, objectElement);

  return componentElement;
}

// Write definition-driven properties and preserved attributes back onto the XML object element.
function applyInstanceAttributes(
  componentElement: StormworksXmlTreeElement,
  instance: LogicInstanceContext,
  warnings: Diagnostic[],
  options: BuildStormworksXmlTreeOptions,
  documentPath: string,
  moduleId: string,
): void {
  for (const attribute of instance.statement.attributes) {
    if (attribute.key === "script_ref") {
      applyScriptReferenceAttribute(componentElement, instance, attribute, warnings, options, documentPath, moduleId);
      continue;
    }

    // Non-script attributes either map through definitions or fall back to raw object attributes.
    const scalarValue = expressionToScalarValue(attribute.value);

    if (scalarValue === undefined) {
      pushExportWarning(warnings, `Attribute ${attribute.key} on ${instance.statement.instanceId} is not a scalar and was skipped.`);
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

    const xmlValue = applyPropertyExportTransform(scalarValue, propertyDefinition);

    if (xmlValue === undefined) {
      continue;
    }

    // Two narrow, evidence-based omission cases confirmed by comparing our export against a file
    // Stormworks itself re-saved after loading it: xmlDelta-encoded properties (composite
    // channel/offset) represent "unset" as an omitted XML attribute, and empty-string properties
    // (e.g. PROPERTY_TOGGLE's label) are always omitted when empty, independent of other sibling
    // properties (e.g. on_label/off_label) being customized. Non-empty, non-delta defaults (e.g.
    // PROPERTY_TOGGLE's on_label="On", EQUAL's epsilon=0.0001) are NOT safe to omit this way:
    // Stormworks keeps those explicit once written, so this check stays narrow to the two cases above.
    const declaredDefault = instance.definition?.defaults?.[propertyDefinition.key];
    const isOmittableDefault =
      declaredDefault !== undefined &&
      scalarValue === declaredDefault &&
      (propertyDefinition.xmlDelta !== undefined || declaredDefault === "");

    if (isOmittableDefault) {
      continue;
    }

    for (const target of targets) {
      // A third evidence-based case from the same comparison: paired text/value numeric targets
      // (min/max/n/v/e-style properties) always keep @text, but Stormworks omits the numeric @value
      // mirror specifically when the value is exactly 0 (any other value, including negatives and
      // decimals, keeps @value). Confirmed across every zero-valued instance in the sample file with
      // no counterexample, independent of whether 0 happens to be that property's declared default.
      if (target.xmlPath.endsWith(".@value") && target.valueType === "number" && xmlValue === 0) {
        continue;
      }

      applyXmlWriteTarget(componentElement, target, xmlValue, warnings);
    }
  }
}

function applyPropertyExportTransform(
  value: IrScalarValue,
  propertyDefinition: NodePropertyDefinition,
): IrScalarValue | undefined {
  if (propertyDefinition.enum !== undefined && typeof value === "string") {
    const numericValue = propertyDefinition.enum[value];
    return numericValue !== undefined ? numericValue : undefined;
  }

  if (propertyDefinition.xmlDelta !== undefined && typeof value === "number") {
    if (propertyDefinition.xmlDeltaExcept === undefined || value !== propertyDefinition.xmlDeltaExcept) {
      return value + propertyDefinition.xmlDelta;
    }
  }

  return value;
}

// Materialize empty inN tags required by dynamic-input components so XML editors keep their shape.
function applyDynamicInputPlaceholders(
  instance: LogicInstanceContext,
  objectElement: StormworksXmlTreeElement,
): void {
  const dynamicInputs = instance.definition?.stormworks.dynamicInputs;

  if (!dynamicInputs) {
    return;
  }

  const dynamicInputCount = resolveDynamicInputCount(instance.statement, dynamicInputs);

  if (dynamicInputCount === undefined || dynamicInputCount < 1) {
    return;
  }

  const startIndex = dynamicInputs.startIndex ?? 1;

  for (let index = startIndex; index <= dynamicInputCount; index += 1) {
    const xmlKey = `${dynamicInputs.prefix}${index}`;

    if (objectElement[xmlKey] !== undefined) {
      continue;
    }

    objectElement[xmlKey] = {};
  }
}

// Infer how many dynamic input placeholders a component needs from its DSL attributes. Exported for
// reuse by net-wide signal validation (src/core/project-source.ts), which needs the same count to
// resolve dynamic input port keys (e.g. "in3") to their declared signal kind.
export function resolveDynamicInputCount(
  statement: SwNetInstStatement,
  dynamicInputs: ComponentDynamicInputsBinding,
): number | undefined {
  const assignment = statement.attributes.find((attribute) => attribute.key === dynamicInputs.countProperty);

  if (!assignment || assignment.value.kind !== "number") {
    return undefined;
  }

  return Number.isInteger(assignment.value.value) ? assignment.value.value : undefined;
}

// Resolve script_ref assets into inline XML script text at export time.
function applyScriptReferenceAttribute(
  componentElement: StormworksXmlTreeElement,
  instance: LogicInstanceContext,
  attribute: SwNetAssignment,
  warnings: Diagnostic[],
  options: BuildStormworksXmlTreeOptions,
  documentPath: string,
  moduleId: string,
): void {
  const scalarValue = expressionToScalarValue(attribute.value);
  const scriptRef = typeof scalarValue === "string" ? scalarValue : undefined;

  if (!scriptRef) {
    pushExportWarning(warnings, `script_ref on ${instance.statement.instanceId} is not a string and was skipped.`);
    return;
  }

  const scriptText = options.resolveScriptText?.(scriptRef, {
    documentPath,
    moduleId,
    instanceId: instance.statement.instanceId,
    typeId: instance.statement.typeId,
  });

  if (scriptText === undefined) {
    pushExportWarning(warnings, `No script text resolver value was provided for ${scriptRef}; exporting an empty Lua script.`);
  }

  asTreeElement(componentElement.object)["@_script"] = scriptText ?? "";
}

// Lower one sw-net input assignment into the corresponding XML in* element.
function resolveXmlInputElement(
  input: SwNetAssignment,
  instance: LogicInstanceContext,
  netProducerByName: Map<string, NetProducer>,
  projectNodeByPortKey: Map<string, ProjectNodeContext>,
  warnings: Diagnostic[],
): StormworksXmlTreeElement | undefined {
  if (input.value.kind === "identifier") {
    const producer = netProducerByName.get(input.value.value);

    if (!producer) {
      pushExportWarning(warnings, `Input ${input.key} on ${instance.statement.instanceId} references unknown net ${input.value.value}.`);
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
      pushExportWarning(warnings, `Input ${input.key} on ${instance.statement.instanceId} references unknown module input port ${input.value.value}.`);
      return undefined;
    }

    return {
      "@_component_id": String(projectNode.componentId),
    };
  }

  pushExportWarning(warnings, `Input ${input.key} on ${instance.statement.instanceId} uses a non-net expression and was skipped.`);
  return undefined;
}

// Regenerate component_states from the canonical component list for editor compatibility.
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

// Emit canonical bridge components that connect project pins to the logic body.
function buildBridgeElements(
  projectNodes: ProjectNodeContext[],
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>,
  projectOutputBindings: Map<string, NetProducer[]>,
  warnings: Diagnostic[],
): StormworksXmlTreeElement[] {
  return projectNodes.map((projectNode) =>
    buildBridgeComponentElement(projectNode, portSlotsByProjectNodeId, projectOutputBindings, warnings),
  );
}

// Regenerate bridge state elements as editor-facing mirrors of the bridge components.
function buildBridgeStateElements(
  projectNodes: ProjectNodeContext[],
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>,
  projectOutputBindings: Map<string, NetProducer[]>,
  warnings: Diagnostic[],
): StormworksXmlTreeElement {
  const bridgeStates: StormworksXmlTreeElement = {};

  projectNodes.forEach((projectNode, index) => {
    bridgeStates[`c${index}`] = buildBridgeObjectElement(
      projectNode,
      portSlotsByProjectNodeId,
      projectOutputBindings,
      warnings,
    );
  });

  return bridgeStates;
}

// Assemble the final XML tree rooted at <microprocessor>.
function buildMicroprocessorElement(
  project: ProjectJsonDocument,
  projectNodeElements: StormworksXmlTreeElement[],
  componentElements: StormworksXmlTreeElement[],
  bridgeElements: StormworksXmlTreeElement[],
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
      components_bridge: {
        c: bridgeElements,
      },
      groups: {},
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

// Emit one <components_bridge><c> element for a project-facing pin.
function buildBridgeComponentElement(
  projectNode: ProjectNodeContext,
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>,
  projectOutputBindings: Map<string, NetProducer[]>,
  warnings: Diagnostic[],
): StormworksXmlTreeElement {
  const element: StormworksXmlTreeElement = {
    object: buildBridgeObjectElement(projectNode, portSlotsByProjectNodeId, projectOutputBindings, warnings),
  };

  if (!isDefaultComponentType(projectNode.bridgeType)) {
    element["@_type"] = projectNode.bridgeType;
  }

  return element;
}

// Emit the bridge object shared by both bridge components and bridge states.
function buildBridgeObjectElement(
  projectNode: ProjectNodeContext,
  portSlotsByProjectNodeId: Map<string, ModulePortSlot>,
  projectOutputBindings: Map<string, NetProducer[]>,
  warnings: Diagnostic[],
): StormworksXmlTreeElement {
  // Bridge objects are the XML-side glue between project pins and the logic body.
  const bridgeState: StormworksXmlTreeElement = {
    "@_id": String(projectNode.componentId),
  };
  const slot = portSlotsByProjectNodeId.get(projectNode.document.id);
  const position = projectNode.document.position ?? slot?.position;

  if (position) {
    bridgeState.pos = {
      "@_x": formatXmlNumber(position.x),
      "@_y": formatXmlNumber(position.y),
    };
  } else {
    pushExportWarning(warnings, `No bridge position was found for project node ${projectNode.document.id}.`);
  }

  if (projectNode.direction === "output") {
    const producers = slot ? projectOutputBindings.get(slot.name) ?? [] : [];

    // Output bridges point from the project pin back into the logic body through component_id/node_index pairs.
    if (producers.length === 0) {
      pushExportWarning(warnings, `Project output ${projectNode.document.id} is not driven by any sw-net output assignment.`);
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

  return bridgeState;
}

// Infer a bridge type code when the project-node definition does not pin one explicitly.
function inferBridgeType(
  direction: "input" | "output",
  signal: IrSignalKind,
): string {
  if (direction === "input") {
    if (signal === "boolean") {
      return "0";
    }

    if (signal === "number") {
      return "2";
    }

    if (signal === "composite") {
      return "4";
    }

    if (signal === "video") {
      return "6";
    }
  }

  if (signal === "boolean") {
    return "1";
  }

  if (signal === "number") {
    return "3";
  }

  if (signal === "composite") {
    return "5";
  }

  if (signal === "video") {
    return "7";
  }

  return "4";
}

// Map a DSL/component definition type back to the raw Stormworks component type code.
function resolveStormworksComponentType(
  typeId: string,
  definition: ComponentDefinition | undefined,
): string {
  if (definition) {
    return definition.stormworks.type;
  }

  const compatibleStormworksType = extractCompatibleStormworksType(typeId);

  if (compatibleStormworksType) {
    return compatibleStormworksType;
  }

  throw new Error(`Cannot map sw-net instance type ${typeId} back to a Stormworks component type.`);
}

// Find the property definition that should own one DSL attribute during XML export.
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

// Prefer the richest property mapping when multiple definitions share the same DSL key.
function scoreDslPropertyDefinition(propertyDefinition: NodePropertyDefinition): number {
  return (
    (propertyDefinition.writeTargets ? 4 : 0) +
    (propertyDefinition.dsl?.key ? 2 : 0) +
    (propertyDefinition.source ? 1 : 0) +
    (propertyDefinition.dsl?.emit === false ? 0 : 1)
  );
}

// Fall back to the import-side xmlPath when no explicit write target list was provided.
function createDefaultWriteTargets(propertyDefinition: NodePropertyDefinition): NodePropertyWriteTarget[] {
  return propertyDefinition.source
    ? [
        {
          xmlPath: propertyDefinition.source.xmlPath,
          valueType: propertyDefinition.valueType,
          itemList: propertyDefinition.source.itemList,
        },
      ]
    : [];
}

// Apply one property write target onto the mutable XML tree under construction.
function applyXmlWriteTarget(
  componentElement: StormworksXmlTreeElement,
  writeTarget: NodePropertyWriteTarget,
  value: IrScalarValue,
  warnings: Diagnostic[],
): void {
  const segments = writeTarget.xmlPath.split(".").filter((segment) => segment.length > 0);
  let current: StormworksXmlTreeElement = componentElement;

  // Write targets create nested XML objects on demand so one DSL property can fan back out to multiple paths.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (!segment) {
      continue;
    }

    if (segment.startsWith("@")) {
      current[`@_${segment.slice(1)}`] = formatXmlScalarValue(value, writeTarget.valueType);
      return;
    }

    if (writeTarget.itemList && index === segments.length - 1) {
      applyItemListWriteTarget(current, segment, value, warnings);
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

// Reconstruct a Selector-style <items><i l=".."><v text=".." value=".."/></i></items> subtree from the
// {l, value} JSON array produced by extractItemListValue; text and value are written back identically
// since this property collapses them into a single field (see issue #15's known-limitations note).
function applyItemListWriteTarget(
  current: StormworksXmlTreeElement,
  segment: string,
  value: IrScalarValue,
  warnings: Diagnostic[],
): void {
  if (typeof value !== "string") {
    pushExportWarning(warnings, `Expected a JSON string for item-list target ${segment}.`);
    return;
  }

  let items: unknown;

  try {
    items = JSON.parse(value);
  } catch {
    pushExportWarning(warnings, `Failed to parse JSON for item-list target ${segment}; left unset.`);
    return;
  }

  if (!Array.isArray(items)) {
    pushExportWarning(warnings, `Expected a JSON array for item-list target ${segment}; left unset.`);
    return;
  }

  current[segment] = {
    i: items.map((item) => {
      const record = item as { l?: unknown; value?: unknown };
      const itemValue = toXmlTreeScalar(record.value);

      return {
        "@_l": toXmlTreeScalar(record.l),
        v: {
          "@_text": itemValue,
          "@_value": itemValue,
        },
      };
    }),
  };
}

// Narrow an arbitrary JSON value down to the scalar shape the XML tree accepts.
function toXmlTreeScalar(value: unknown): StormworksXmlTreeScalar {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  return null;
}

// Map a DSL input key back to the XML-side in*/inc name expected by Stormworks.
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

// Map a DSL output key back to the optional XML node_index used by multi-output components.
function resolveXmlOutputNodeIndex(
  definition: ComponentDefinition | undefined,
  dslKey: string,
): number | undefined {
  if (!definition) {
    return undefined;
  }

  const outputDefinition = definition.ports.outputs.find((output) => output.key === dslKey);

  if (!outputDefinition) {
    return undefined;
  }

  return outputDefinition.stormworks?.nodeIndex;
}

// Reduce a parsed DSL expression to a scalar value when XML export can embed it directly.
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

// Build a stable lookup key for one resolved sw-net module.
function formatModuleKey(key: SwNetResolvedModuleKey): string {
  return `${key.documentPath}#${key.moduleId}`;
}

// Format a scalar value using the XML spellings Stormworks expects.
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

// Format numbers compactly while preserving integer-looking output.
function formatXmlNumber(value: number): string {
  return String(value);
}

// Reuse n123-style instance ids as preferred XML object ids when available.
function tryParseInstanceObjectId(instanceId: string): number | undefined {
  const match = /^n(\d+)$/.exec(instanceId);

  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Deep-clone a tree value so derived state sections do not alias canonical sections.
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

// Narrow a tree value into an object element before mutating it.
function asTreeElement(value: StormworksXmlTreeValue | undefined): StormworksXmlTreeElement {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as StormworksXmlTreeElement;
  }

  throw new Error("Expected an XML tree element.");
}
