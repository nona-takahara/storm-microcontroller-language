// Public, browser-safe API for viewing one sw-net module as a position-resolved, net-resolved node
// graph, without flattening into any `use`-referenced submodule (see issue #53). This is
// deliberately a single-module view: `use` statements become one opaque IrNode each (layer "use"),
// distinct from resolving the full cross-module graph the XML exporter builds internally
// (src/core/exporters/xml-tree.ts's flattenModule). No elkjs dependency, so this stays reachable
// from the "." browser-safe entry point (see src/index.ts).
import { createWarningDiagnostic, type Diagnostic, type StormworksLibraryResult } from "./diagnostics.js";
import { type IrLink, type IrNode, type IrPortEndpoint, type IrSignalKind, type IrVector2 } from "./ir.js";
import { type SwNetAssignment, type SwNetModule, type SwNetPort, type SwNetStatement } from "./parsers/sw-net.js";
import { type StormworksSwMclDocument, type SwMclPortDocument } from "./serializers/sw-mcl.js";
import { formatPortNameKey, formatPortOccurrenceKey } from "./serializers/sw-net-shared.js";
import { resolveModuleInstancePositions, resolveStatementTypeName } from "./shared/module-net-graph.js";
import {
  buildModulePortNameSets,
  resolveStringPortDirection,
  type ModulePortNameSets,
} from "./shared/module-port-directions.js";
import { indexNetProducers } from "./shared/producer-index.js";

export interface SwNetModuleGraph {
  moduleId: string;
  nodes: IrNode[];
  links: IrLink[];
}

// Resolve one sw-net module's own inst/use/port declarations into a position-resolved,
// net-resolved node graph. `swMcl` is expected to be the module's own paired layout document (or
// null when none exists yet -- a perfectly normal, expected input, not an edge case); passing a
// mismatched module's sw-mcl produces meaningless positions, the same way the XML exporter would.
export function resolveSwNetModuleGraph(
  module: SwNetModule,
  swMcl: StormworksSwMclDocument | null,
): StormworksLibraryResult<SwNetModuleGraph> {
  const diagnostics: Diagnostic[] = [];
  const modulePorts = buildModulePortNameSets(module.ports);
  const { positionByInstanceId, mismatchedInstanceIds } = resolveModuleInstancePositions(module, swMcl);

  for (const instanceId of mismatchedInstanceIds) {
    diagnostics.push(
      createWarningDiagnostic(
        "INSTANCE_LAYOUT_ID_MISMATCH",
        `sw-mcl has no instance layout entry matching sw-net instanceId "${instanceId}". If this instance was renamed in .sw-net, its .sw-mcl entry needs the same id.`,
        "module-net-view",
        undefined,
        instanceId,
      ),
    );
  }

  const { nodes: portNodes, nodeIdByNameKey: portNodeIdByNameKey } = buildPortNodes(module.ports, swMcl);
  const instanceNodes = module.statements.map((statement) => buildInstanceNode(statement, positionByInstanceId));

  const netProducers = indexNetProducers(
    module.statements,
    (statement) => statement,
    (statement, outputKey): IrPortEndpoint => ({ nodeId: statement.instanceId, portKey: outputKey }),
    (netName) => {
      diagnostics.push(
        createWarningDiagnostic(
          "DUPLICATE_NET_PRODUCER",
          `Multiple instance outputs drive net ${netName}; using the first producer.`,
          "module-net-view",
        ),
      );
    },
  );

  const links: IrLink[] = [];
  let nextLinkId = 0;

  for (const statement of module.statements) {
    for (const input of statement.inputs) {
      const source = resolveInputSource(statement, input, netProducers, modulePorts, portNodeIdByNameKey, diagnostics);

      if (source) {
        links.push({
          id: `link:${nextLinkId++}`,
          from: source,
          to: { nodeId: statement.instanceId, portKey: input.key },
        });
      }
    }

    for (const output of statement.outputs) {
      const target = resolveOutputTarget(statement, output, modulePorts, portNodeIdByNameKey, diagnostics);

      if (target) {
        links.push({
          id: `link:${nextLinkId++}`,
          from: { nodeId: statement.instanceId, portKey: output.key },
          to: target,
        });
      }
    }
  }

  return {
    value: {
      moduleId: module.id,
      nodes: [...portNodes, ...instanceNodes],
      links,
    },
    diagnostics,
  };
}

// One inst/use statement becomes one node: "logic" for inst (typeId is already the DSL-facing
// definitionId, no XML type-number translation needed), "use" for an unflattened submodule
// reference (see the IrNodeLayer comment in ir.ts for why this isn't "submodule").
function buildInstanceNode(statement: SwNetStatement, positionByInstanceId: Map<string, IrVector2>): IrNode {
  return {
    id: statement.instanceId,
    layer: statement.kind === "inst" ? "logic" : "use",
    definitionId: resolveStatementTypeName(statement),
    position: positionByInstanceId.get(statement.instanceId),
    properties: {},
  };
}

// One node per declared module port occurrence, mirroring importers/xml.ts's
// synthesizeSubmodulePorts shape (layer "submodule" = a module boundary pin) minus XML-specific
// fields. Also returns a name-direction -> node id index so quoted-string port references can be
// linked without re-deriving occurrence numbering.
function buildPortNodes(
  ports: SwNetPort[],
  swMcl: StormworksSwMclDocument | null,
): { nodes: IrNode[]; nodeIdByNameKey: Map<string, string> } {
  const swMclPortByOccurrenceKey = new Map<string, SwMclPortDocument>(
    (swMcl?.ports ?? []).map((port) => [formatPortOccurrenceKey(port.direction, port.name, port.occurrence), port] as const),
  );
  const occurrenceByNameKey = new Map<string, number>();
  const nodeIdByNameKey = new Map<string, string>();
  const nodes: IrNode[] = [];

  for (const port of ports) {
    const nameKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByNameKey.get(nameKey) ?? 0) + 1;
    occurrenceByNameKey.set(nameKey, occurrence);

    const occurrenceKey = formatPortOccurrenceKey(port.direction, port.name, occurrence);
    const nodeId = `port:${occurrenceKey}`;

    // Wiring resolves ports by name+direction only (matching resolveStringPortDirection's semantics,
    // which cannot distinguish occurrences either); the first-declared occurrence wins ties.
    if (!nodeIdByNameKey.has(nameKey)) {
      nodeIdByNameKey.set(nameKey, nodeId);
    }

    nodes.push({
      id: nodeId,
      layer: "submodule",
      definitionId: formatSyntheticPortDefinitionId(port.direction, port.signal),
      position: swMclPortByOccurrenceKey.get(occurrenceKey)?.position,
      properties: {
        name: port.name,
        direction: port.direction,
        signal: port.signal,
      },
    });
  }

  return { nodes, nodeIdByNameKey };
}

function formatSyntheticPortDefinitionId(direction: "in" | "out", signal: IrSignalKind): string {
  return `SUBMODULE_PORT:${direction}:${signal}`;
}

// Resolve one input assignment's wiring source: an identifier looks up the module's own net-producer
// index (never a port, per this tool's documented quoting convention -- src/core/spec/tool-conventions.ts);
// a quoted string looks up one of the module's own declared ports; a literal (number/boolean/null)
// carries no wiring and resolves to nothing.
function resolveInputSource(
  statement: SwNetStatement,
  assignment: SwNetAssignment,
  netProducers: Map<string, IrPortEndpoint>,
  modulePorts: ModulePortNameSets,
  portNodeIdByNameKey: Map<string, string>,
  diagnostics: Diagnostic[],
): IrPortEndpoint | undefined {
  if (assignment.value.kind === "identifier") {
    const producer = netProducers.get(assignment.value.value);

    if (!producer) {
      diagnostics.push(
        createWarningDiagnostic(
          "UNRESOLVED_NET_REFERENCE",
          `Input "${assignment.key}" on "${statement.instanceId}" references unknown net "${assignment.value.value}".`,
          "module-net-view",
          undefined,
          statement.instanceId,
        ),
      );
    }

    return producer;
  }

  if (assignment.value.kind === "string") {
    const portDirection = resolveStringPortDirection(assignment.value.value, "in", modulePorts);

    if (!portDirection) {
      diagnostics.push(
        createWarningDiagnostic(
          "UNRESOLVED_PORT_REFERENCE",
          `Input "${assignment.key}" on "${statement.instanceId}" references unknown module input port "${assignment.value.value}".`,
          "module-net-view",
          undefined,
          statement.instanceId,
        ),
      );

      return undefined;
    }

    const nodeId = portNodeIdByNameKey.get(formatPortNameKey(portDirection, assignment.value.value));

    return nodeId ? { nodeId, portKey: "value" } : undefined;
  }

  // Literal constants (number/boolean/null) are embedded values, not wiring.
  return undefined;
}

// Resolve one output assignment's wiring target: only a quoted string naming one of the module's own
// declared output ports resolves to anything (an output may only ever drive a declared output port,
// per resolveStringPortDirection's asymmetric rule); identifiers and literals never target a port.
function resolveOutputTarget(
  statement: SwNetStatement,
  assignment: SwNetAssignment,
  modulePorts: ModulePortNameSets,
  portNodeIdByNameKey: Map<string, string>,
  diagnostics: Diagnostic[],
): IrPortEndpoint | undefined {
  if (assignment.value.kind !== "string") {
    return undefined;
  }

  const portDirection = resolveStringPortDirection(assignment.value.value, "out", modulePorts);

  if (portDirection !== "out") {
    diagnostics.push(
      createWarningDiagnostic(
        "UNRESOLVED_PORT_REFERENCE",
        `Output "${assignment.key}" on "${statement.instanceId}" references unknown module output port "${assignment.value.value}".`,
        "module-net-view",
        undefined,
        statement.instanceId,
      ),
    );

    return undefined;
  }

  const nodeId = portNodeIdByNameKey.get(formatPortNameKey("out", assignment.value.value));

  return nodeId ? { nodeId, portKey: "value" } : undefined;
}
