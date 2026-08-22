// Module-split engine (issue #64): given an explicit set of inst/use instanceIds inside one sw-net
// module, mechanically extracts them into a brand-new module and rewrites only the wiring that
// crosses the new boundary. This is deliberately narrower than the sync engine: there is no node
// correspondence search here, just "these exact instanceIds move, everything else stays untouched."
//
// The key semantic fact this engine leans on: a local net name (an unquoted identifier) and a
// module's own declared port (a quoted string) are different namespaces (see
// src/core/parsers/sw-net.ts and module-net-view.ts's resolveInputSource/resolveOutputTarget). Once a
// statement moves into the new module, any local net it shares with a statement that stays behind can
// no longer be reached by that identifier -- the identifier's producer and consumer no longer live in
// the same module. So every touch on a boundary-crossing net, moved or not, is rewritten from
// `identifier(name)` to `string(name)`: the moved side now reads/writes its own declared port, and the
// statements left behind keep referencing the same bare name, now forwarded through the new `use`.
import { findCompatibleComponentDefinition, type NodeDefinitionRegistry } from "../definitions/loader.js";
import { createErrorDiagnostic, type Diagnostic, type StormworksLibraryResult } from "../diagnostics.js";
import { type IrSignalKind } from "../ir.js";
import {
  createSwNetElementRemovalEdit,
  createSwNetStatementInsertionEdit,
  type SwNetSourceDocument,
  type SwNetTextEdit,
} from "../parsers/sw-net-source.js";
import {
  type SwNetAssignment,
  type SwNetExpression,
  type SwNetModule,
  type SwNetPort,
  type SwNetStatement,
  type SwNetUseStatement,
} from "../parsers/sw-net.js";
import { resolveInstPortSignal } from "../project-source.js";
import { serializeSwNetStatement } from "../serializers/sw-net-document.js";
import { buildModulePortNameSets, type ModulePortNameSets } from "../shared/module-port-directions.js";
import { reserveUniqueName } from "../shared/name-reservation.js";
import { type SplitModuleNewModule, type SplitModulePlan } from "./types.js";

export interface BuildSplitModulePlanOptions {
  definitions: NodeDefinitionRegistry;
  /** The lossless-parsed source document that owns `moduleId` (used for exact-text edits). */
  source: SwNetSourceDocument;
  moduleId: string;
  /** instanceIds of the inst/use statements to move into the new module. */
  gateInstanceIds: string[];
  newModuleId: string;
  /** instanceId for the `use` statement that replaces the extracted statements. Defaults to
   * `newModuleId`, deduped against the module's remaining instanceIds; an explicitly provided id that
   * collides is a hard error instead of being silently renamed. */
  newInstanceId?: string;
  /** Import alias the ORIGINAL document will use to reach the new module (caller reserves this). */
  newImportAlias: string;
}

type NetRole = "producer" | "consumer";

interface NetTouch {
  instanceId: string;
  role: NetRole;
  portKey: string;
}

// Resolve one assignment's net identity, matching the exporter's/validator's flattening semantics
// exactly (see project-source.ts's netKeyForAssignment, which this mirrors without its diagnostics
// side-channel -- a malformed source is not this engine's concern to newly detect).
function resolveNetKey(
  value: SwNetExpression,
  usageDirection: "in" | "out",
  modulePorts: ModulePortNameSets,
): string | undefined {
  if (value.kind === "identifier") {
    return `local:${value.value}`;
  }

  if (value.kind !== "string") {
    return undefined;
  }

  const portName = value.value;

  if (modulePorts[usageDirection].has(portName)) {
    return `boundary:${usageDirection}:${portName}`;
  }

  if (usageDirection === "in" && modulePorts.out.has(portName)) {
    return `boundary:out:${portName}`;
  }

  return `boundary:${usageDirection}:${portName}`;
}

// Extract a module's `end` list of gate ids, its statements/ports, and validate the request shape
// before doing any real work.
export function buildSplitModulePlan(options: BuildSplitModulePlanOptions): StormworksLibraryResult<SplitModulePlan> {
  const diagnostics: Diagnostic[] = [];
  const module = options.source.ast.modules.find((candidate) => candidate.id === options.moduleId);

  if (!module) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_MODULE_NOT_FOUND",
        `Module ${options.moduleId} was not found.`,
        "split",
        undefined,
        options.moduleId,
        { messageId: "split.moduleNotFound", messageArgs: { moduleId: options.moduleId } },
      ),
    );
    return { diagnostics };
  }

  const gateInstanceIds = [...new Set(options.gateInstanceIds)];

  if (gateInstanceIds.length === 0) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_EMPTY_SELECTION",
        "No gate instance ids were provided to split.",
        "split",
        undefined,
        options.moduleId,
        { messageId: "split.emptySelection", messageArgs: {} },
      ),
    );
    return { diagnostics };
  }

  const statementById = new Map(module.statements.map((statement) => [statement.instanceId, statement] as const));
  const missingIds = gateInstanceIds.filter((id) => !statementById.has(id));

  for (const missingId of missingIds) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_GATE_NOT_FOUND",
        `Instance ${missingId} was not found in module ${options.moduleId}.`,
        "split",
        undefined,
        missingId,
        { messageId: "split.gateNotFound", messageArgs: { instanceId: missingId, moduleId: options.moduleId } },
      ),
    );
  }

  if (missingIds.length > 0) {
    return { diagnostics };
  }

  const gateIdSet = new Set(gateInstanceIds);
  const remainingStatements = module.statements.filter((statement) => !gateIdSet.has(statement.instanceId));
  const remainingInstanceIds = new Set(remainingStatements.map((statement) => statement.instanceId));

  if (options.newInstanceId !== undefined && remainingInstanceIds.has(options.newInstanceId)) {
    diagnostics.push(
      createErrorDiagnostic(
        "SPLIT_INSTANCE_ID_CONFLICT",
        `Instance id ${options.newInstanceId} is already used in module ${options.moduleId}.`,
        "split",
        undefined,
        options.newInstanceId,
        {
          messageId: "split.instanceIdConflict",
          messageArgs: { instanceId: options.newInstanceId, moduleId: options.moduleId },
        },
      ),
    );
    return { diagnostics };
  }

  // No explicit id: pick one deterministically instead of erroring on a name the user never chose.
  const newInstanceId = options.newInstanceId ?? reserveUniqueName(options.newModuleId, new Set(remainingInstanceIds));

  const modulePorts = buildModulePortNameSets(module.ports);
  const touchesByLocalNet = collectLocalNetTouches(module);
  const crossingLocalNetDirections = resolveCrossingLocalNets(touchesByLocalNet, gateIdSet);

  const reservedNames: Record<"in" | "out", Set<string>> = { in: new Set(), out: new Set() };
  const portNameByNetKey = new Map<string, string>();
  const newPorts: SwNetPort[] = [];
  const useInputs: SwNetAssignment[] = [];
  const useOutputs: SwNetAssignment[] = [];

  const resolveCrossingPortName = (
    netKey: string,
    direction: "in" | "out",
    bareName: string,
    signal: IrSignalKind,
    outerExpression: SwNetExpression,
  ): string => {
    const existing = portNameByNetKey.get(netKey);

    if (existing) {
      return existing;
    }

    const reservedName = reserveUniqueName(bareName, reservedNames[direction]);
    portNameByNetKey.set(netKey, reservedName);
    newPorts.push({ direction, name: reservedName, signal });
    const useAssignment: SwNetAssignment = { key: reservedName, value: outerExpression };

    if (direction === "in") {
      useInputs.push(useAssignment);
    } else {
      useOutputs.push(useAssignment);
    }

    return reservedName;
  };

  // Rewrite one extracted statement's assignment if (and only if) it touches a boundary-crossing net;
  // every other assignment (fully-internal nets, constant literals, unrelated ports) is returned as-is.
  const rewriteAssignment = (
    assignment: SwNetAssignment,
    usageDirection: "in" | "out",
  ): SwNetAssignment => {
    const netKey = resolveNetKey(assignment.value, usageDirection, modulePorts);

    if (!netKey) {
      return assignment;
    }

    if (netKey.startsWith("local:")) {
      const direction = crossingLocalNetDirections.get(netKey);

      if (!direction) {
        return assignment;
      }

      const bareName = netKey.slice("local:".length);
      const signal = resolveLocalNetSignal(
        options.definitions,
        touchesByLocalNet.get(netKey) ?? [],
        gateIdSet,
        statementById,
        direction,
      );
      const portName = resolveCrossingPortName(netKey, direction, bareName, signal, {
        kind: "identifier",
        value: bareName,
      });
      return { key: assignment.key, value: { kind: "string", value: portName } };
    }

    // netKey is a "boundary:<direction>:<name>" reference to this module's own declared port -- always
    // a crossing net, since the module's own port declaration is never part of the extracted set.
    const [, direction, ...nameParts] = netKey.split(":");
    const bareName = nameParts.join(":");
    const signal = module.ports.find((port) => port.direction === direction && port.name === bareName)?.signal ?? "unknown";
    const portName = resolveCrossingPortName(netKey, direction as "in" | "out", bareName, signal, {
      kind: "string",
      value: bareName,
    });
    return { key: assignment.key, value: { kind: "string", value: portName } };
  };

  const orderedGateStatements = module.statements.filter((statement) => gateIdSet.has(statement.instanceId));
  const newStatements: SwNetStatement[] = orderedGateStatements.map((statement) => ({
    ...statement,
    inputs: statement.inputs.map((assignment) => rewriteAssignment(assignment, "in")),
    outputs: statement.outputs.map((assignment) => rewriteAssignment(assignment, "out")),
  }));

  const sourceEdits: SwNetTextEdit[] = orderedGateStatements.map((statement) =>
    createSwNetElementRemovalEdit(options.source, statement),
  );

  const useStatement: SwNetUseStatement = {
    kind: "use",
    moduleRef: { kind: "imported", alias: options.newImportAlias, moduleId: options.newModuleId },
    instanceId: newInstanceId,
    inputs: useInputs,
    outputs: useOutputs,
  };

  sourceEdits.push(createSwNetStatementInsertionEdit(options.source, module, serializeSwNetStatement(useStatement)));

  const newModule: SplitModuleNewModule = {
    id: options.newModuleId,
    ports: newPorts,
    statements: newStatements,
  };

  return {
    value: {
      sourceEdits,
      newModule,
      movedInstanceIds: orderedGateStatements.map((statement) => statement.instanceId),
    },
    diagnostics,
  };
}

// Group every input/output touch on a "local:<name>" net across the WHOLE module (not just the
// extracted statements) -- deciding whether a net is crossing requires seeing both sides.
function collectLocalNetTouches(module: SwNetModule): Map<string, NetTouch[]> {
  const modulePorts = buildModulePortNameSets(module.ports);
  const touches = new Map<string, NetTouch[]>();

  const addTouch = (value: SwNetExpression, usageDirection: "in" | "out", instanceId: string, role: NetRole, portKey: string) => {
    const netKey = resolveNetKey(value, usageDirection, modulePorts);

    if (!netKey?.startsWith("local:")) {
      return;
    }

    const existing = touches.get(netKey);
    const touch: NetTouch = { instanceId, role, portKey };

    if (existing) {
      existing.push(touch);
    } else {
      touches.set(netKey, [touch]);
    }
  };

  for (const statement of module.statements) {
    for (const input of statement.inputs) {
      addTouch(input.value, "in", statement.instanceId, "consumer", input.key);
    }

    for (const output of statement.outputs) {
      addTouch(output.value, "out", statement.instanceId, "producer", output.key);
    }
  }

  return touches;
}

// A local net is boundary-crossing exactly when it has at least one touch inside the extracted set and
// at least one outside it. Direction follows whichever side actually produces the value: if the
// extracted side contains the producer, the new module must expose it as an "out" port; otherwise the
// extracted side is purely reading a value produced elsewhere, so it needs an "in" port.
function resolveCrossingLocalNets(
  touchesByNet: Map<string, NetTouch[]>,
  gateIdSet: Set<string>,
): Map<string, "in" | "out"> {
  const directions = new Map<string, "in" | "out">();

  for (const [netKey, touches] of touchesByNet) {
    const insideTouches = touches.filter((touch) => gateIdSet.has(touch.instanceId));
    const outsideTouches = touches.filter((touch) => !gateIdSet.has(touch.instanceId));

    if (insideTouches.length === 0 || outsideTouches.length === 0) {
      continue;
    }

    const direction = insideTouches.some((touch) => touch.role === "producer") ? "out" : "in";
    directions.set(netKey, direction);
  }

  return directions;
}

// Resolve the signal kind to declare on a new port backed by a local net: pick whichever extracted
// touch actually defines the port's role (the producer for an "out" port, any consumer for an "in"
// port) and resolve its signal from the component definitions. `use`-sourced touches (a moved
// submodule call producing/consuming the net) fall back to "unknown" -- resolving a use statement's
// target port signal can require loading another file, and an internal `use` boundary port's signal is
// never used for anything but the advisory NET_SIGNAL_MISMATCH check (see project-source.ts), so this
// is a safe, deliberate simplification rather than a gap.
function resolveLocalNetSignal(
  definitions: NodeDefinitionRegistry,
  touches: NetTouch[],
  gateIdSet: Set<string>,
  statementById: Map<string, SwNetStatement>,
  direction: "in" | "out",
): IrSignalKind {
  const insideTouches = touches.filter((touch) => gateIdSet.has(touch.instanceId));
  const wantedRole: NetRole = direction === "out" ? "producer" : "consumer";
  const candidate = insideTouches.find((touch) => touch.role === wantedRole);

  if (!candidate) {
    return "unknown";
  }

  const statement = statementById.get(candidate.instanceId);

  if (!statement || statement.kind !== "inst") {
    return "unknown";
  }

  const definition = findCompatibleComponentDefinition(definitions, statement.typeId);
  return resolveInstPortSignal(definition, statement, candidate.portKey, wantedRole === "producer" ? "output" : "input");
}
