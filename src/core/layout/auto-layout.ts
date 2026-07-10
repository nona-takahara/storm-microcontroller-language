// Pure ELK-based auto-layout for one sw-net module's ports and instances.
// Deliberately not re-exported from src/index.ts: elkjs's Node entry point isn't guaranteed to bundle
// cleanly for browser targets (see repository issue #7), so this stays a CLI-only capability for now.
import ElkConstructorDefault, { type ELK as ElkInstance, type ElkExtendedEdge, type ElkNode } from "elkjs";

import { type IrVector2 } from "../ir.js";
import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import { type SwMclInstanceDocument, type SwMclPortDocument } from "../serializers/sw-mcl.js";
import { formatPortNameKey, formatPortOccurrenceKey } from "../serializers/sw-net-shared.js";
import { registerFirstProducer } from "../shared/producer-index.js";

export interface AutoLayoutExistingPositions {
  ports: Map<string, IrVector2>;
  instances: Map<string, IrVector2>;
}

export interface AutoLayoutOptions {
  mode: "fill" | "force";
  // Ignored entirely when mode is "force".
  existing?: AutoLayoutExistingPositions;
  direction?: "RIGHT" | "DOWN";
  nodeSpacing?: number;
  layerSpacing?: number;
  gridSize?: number;
}

export interface AutoLayoutResult {
  ports: SwMclPortDocument[];
  instances: SwMclInstanceDocument[];
  warnings: string[];
}

interface PortSlot {
  key: string;
  name: string;
  direction: "in" | "out";
  occurrence: number;
}

interface NetProducer {
  instanceId: string;
}

// Placeholder scale constants: no real .sw-mcl fixtures exist yet to calibrate against Stormworks'
// own logic-canvas grid, so these are a best-effort starting point pending visual validation.
const DEFAULT_NODE_SPACING = 1.5;
const DEFAULT_LAYER_SPACING = 3;
const DEFAULT_GRID_SIZE = 0.5;
const PORT_NODE_SIZE = 0.4;
const INSTANCE_NODE_WIDTH = 1.2;
const INSTANCE_NODE_ROW_HEIGHT = 0.6;

const PORT_NODE_ID_PREFIX = "p$";
const INSTANCE_NODE_ID_PREFIX = "n$";

// elkjs's CJS build type-checks as a non-constructable namespace under NodeNext + esModuleInterop;
// the runtime default import is a plain class (module.exports = ELKNode), so cast through unknown to
// restore the constructor type instead of changing the (correct) runtime import.
const ElkConstructor = ElkConstructorDefault as unknown as new () => ElkInstance;

// Compute layout positions for every port and instance of one sw-net module using ELK's layered algorithm.
export async function computeSwNetModuleLayout(
  module: SwNetModule,
  options: AutoLayoutOptions,
): Promise<AutoLayoutResult> {
  const warnings: string[] = [];
  const portSlots = buildPortSlots(module);
  const netProducers = buildNetProducerIndex(module.statements, warnings);
  const graph = buildElkGraph(portSlots, module.statements, netProducers, options, warnings);

  const elk = new ElkConstructor();
  const laidOut = await elk.layout(graph);

  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
  const positionById = new Map<string, IrVector2>();

  for (const child of laidOut.children ?? []) {
    positionById.set(child.id, snapVector({ x: child.x ?? 0, y: child.y ?? 0 }, gridSize));
  }

  const ports: SwMclPortDocument[] = portSlots.map((slot) => {
    const computed = positionById.get(PORT_NODE_ID_PREFIX + slot.key) ?? { x: 0, y: 0 };
    const existing = options.mode === "fill" ? options.existing?.ports.get(slot.key) : undefined;

    return {
      name: slot.name,
      direction: slot.direction,
      occurrence: slot.occurrence,
      position: existing ?? computed,
    };
  });

  const instances: SwMclInstanceDocument[] = module.statements.map((statement) => {
    const computed = positionById.get(INSTANCE_NODE_ID_PREFIX + statement.instanceId) ?? { x: 0, y: 0 };
    const existing = options.mode === "fill" ? options.existing?.instances.get(statement.instanceId) : undefined;

    return {
      id: statement.instanceId,
      type: resolveInstanceTypeName(statement),
      position: existing ?? computed,
    };
  });

  return { ports, instances, warnings };
}

// Enumerate module boundary ports with the same occurrence-numbering scheme the XML exporter uses.
function buildPortSlots(module: SwNetModule): PortSlot[] {
  const occurrenceByKey = new Map<string, number>();

  return module.ports.map((port) => {
    const nameKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrenceByKey.get(nameKey) ?? 0) + 1;
    occurrenceByKey.set(nameKey, occurrence);

    return {
      key: formatPortOccurrenceKey(port.direction, port.name, occurrence),
      name: port.name,
      direction: port.direction,
      occurrence,
    };
  });
}

// Resolve the sw-mcl-facing type label for one instance/use statement.
function resolveInstanceTypeName(statement: SwNetStatement): string {
  if (statement.kind === "inst") {
    return statement.typeId;
  }

  return statement.moduleRef.kind === "local"
    ? statement.moduleRef.moduleId
    : `${statement.moduleRef.alias}.${statement.moduleRef.moduleId}`;
}

// Index which instance produces each internal net name, mirroring the XML exporter's first-producer-wins rule.
function buildNetProducerIndex(statements: SwNetStatement[], warnings: string[]): Map<string, NetProducer> {
  const producers = new Map<string, NetProducer>();

  for (const statement of statements) {
    for (const output of statement.outputs) {
      if (output.value.kind !== "identifier") {
        continue;
      }

      registerFirstProducer(producers, output.value.value, { instanceId: statement.instanceId }, (netName) => {
        warnings.push(`Multiple instance outputs drive net ${netName}; using the first producer for layout.`);
      });
    }
  }

  return producers;
}

// Group port slots by semantic name for occurrence-insensitive string-binding lookups (matches the XML exporter's approximation).
function groupPortSlotsByName(portSlots: PortSlot[], direction: "in" | "out"): Map<string, PortSlot[]> {
  const map = new Map<string, PortSlot[]>();

  for (const slot of portSlots) {
    if (slot.direction !== direction) {
      continue;
    }

    const list = map.get(slot.name);

    if (list) {
      list.push(slot);
      continue;
    }

    map.set(slot.name, [slot]);
  }

  return map;
}

// Build the ELK input graph: port slots pinned to the first/last rank, instances as ordinary layered nodes.
function buildElkGraph(
  portSlots: PortSlot[],
  statements: SwNetStatement[],
  netProducers: Map<string, NetProducer>,
  options: AutoLayoutOptions,
  warnings: string[],
): ElkNode {
  const direction = options.direction ?? "RIGHT";
  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const layerSpacing = options.layerSpacing ?? DEFAULT_LAYER_SPACING;
  const inPortSlotsByName = groupPortSlotsByName(portSlots, "in");
  const outPortSlotsByName = groupPortSlotsByName(portSlots, "out");

  const children: ElkNode[] = portSlots.map((slot) => ({
    id: PORT_NODE_ID_PREFIX + slot.key,
    width: PORT_NODE_SIZE,
    height: PORT_NODE_SIZE,
    layoutOptions: {
      "elk.layered.layering.layerConstraint": slot.direction === "in" ? "FIRST_SEPARATE" : "LAST_SEPARATE",
    },
  }));

  for (const statement of statements) {
    const rowCount = Math.max(1, statement.inputs.length, statement.outputs.length);

    children.push({
      id: INSTANCE_NODE_ID_PREFIX + statement.instanceId,
      width: INSTANCE_NODE_WIDTH,
      height: rowCount * INSTANCE_NODE_ROW_HEIGHT,
    });
  }

  const edges: ElkExtendedEdge[] = [];
  let edgeIndex = 0;
  const nextEdgeId = () => `e${edgeIndex++}`;

  for (const statement of statements) {
    const targetId = INSTANCE_NODE_ID_PREFIX + statement.instanceId;

    for (const input of statement.inputs) {
      if (input.value.kind === "identifier") {
        const producer = netProducers.get(input.value.value);

        if (!producer) {
          warnings.push(
            `Input ${input.key} on ${statement.instanceId} references unknown net ${input.value.value}; skipped for layout.`,
          );
          continue;
        }

        edges.push({
          id: nextEdgeId(),
          sources: [INSTANCE_NODE_ID_PREFIX + producer.instanceId],
          targets: [targetId],
        });
        continue;
      }

      if (input.value.kind === "string") {
        const slots = inPortSlotsByName.get(input.value.value) ?? [];

        if (slots.length === 0) {
          warnings.push(
            `Input ${input.key} on ${statement.instanceId} references unknown module input port ${input.value.value}; skipped for layout.`,
          );
        }

        for (const slot of slots) {
          edges.push({
            id: nextEdgeId(),
            sources: [PORT_NODE_ID_PREFIX + slot.key],
            targets: [targetId],
          });
        }
      }
    }

    for (const output of statement.outputs) {
      if (output.value.kind !== "string") {
        continue;
      }

      const slots = outPortSlotsByName.get(output.value.value) ?? [];

      if (slots.length === 0) {
        warnings.push(
          `Output ${output.key} on ${statement.instanceId} references unknown module output port ${output.value.value}; skipped for layout.`,
        );
      }

      for (const slot of slots) {
        edges.push({
          id: nextEdgeId(),
          sources: [targetId],
          targets: [PORT_NODE_ID_PREFIX + slot.key],
        });
      }
    }
  }

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
    },
    children,
    edges,
  };
}

// Snap one computed coordinate to the requested grid unit; a non-positive grid size disables snapping.
function snapVector(vector: IrVector2, gridSize: number): IrVector2 {
  if (gridSize <= 0) {
    return vector;
  }

  return {
    x: Math.round(vector.x / gridSize) * gridSize,
    y: Math.round(vector.y / gridSize) * gridSize,
  };
}
