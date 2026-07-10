// Pure ELK-based auto-layout for one sw-net module's ports and instances.
// Deliberately not re-exported from src/index.ts: elkjs's Node entry point isn't guaranteed to bundle
// cleanly for browser targets (see repository issue #7), so this stays a CLI-only capability for now.
import ElkConstructorDefault, { type ELK as ElkInstance, type ElkExtendedEdge, type ElkNode } from "elkjs";

import { type IrVector2 } from "../ir.js";
import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import {
  type StormworksSwMclDocument,
  type SwMclInstanceDocument,
  type SwMclPortDocument,
} from "../serializers/sw-mcl.js";
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
  // Real footprints for `use` statements whose target module already has its own layout, keyed
  // by this module's use-statement instanceId. See computeModuleFootprint.
  submoduleFootprints?: Map<string, ModuleFootprint>;
}

export interface ModuleFootprint {
  width: number;
  height: number;
  // Top-left corner of the computed bounding box, in the child module's own .sw-mcl coordinate
  // frame (that frame's origin is arbitrary, e.g. hand-authored or xml2dsl-derived layouts often
  // don't start at (0,0)). Used to correct the anchor written for the owning `use` instance so
  // the child's real content lands inside the box ELK reserved for it instead of drifting by
  // this offset — see the anchor-correction step in computeSwNetModuleLayout.
  originX: number;
  originY: number;
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

// Scale constants calibrated against a real Stormworks project export (CHUSO1800_Traction.xml,
// analyzed during issue #7): every in-game logic-canvas position is a multiple of 0.25 (the
// engine's own grid unit), with a 1.25 modal column-to-column pitch and a 0.25 modal row-to-row
// pitch. ELK's spacing options are node-edge-to-node-edge gaps, not center-to-center pitch, so
// each gap here is (observed pitch − node size): 1.25 − 1.0 = 0.25 for layers, and the grid unit
// itself for rows/ports, keeping every "gap" constant at one grid cell.
const DEFAULT_NODE_SPACING = 0.25;
const DEFAULT_LAYER_SPACING = 0.25;
const DEFAULT_GRID_SIZE = 0.25;
const PORT_NODE_SIZE = 0.25;
const INSTANCE_NODE_WIDTH = 1.0;
const INSTANCE_NODE_ROW_HEIGHT = 0.25;

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
    const footprint = options.submoduleFootprints?.get(statement.instanceId);
    // A `use` instance sized to its target's real footprint reserves an ELK box at `computed`,
    // but the exporter later composes the target's real content as anchor + childLocalPosition.
    // Since the child's own bounding box starts at {originX, originY} (not {0, 0}), the anchor
    // must be shifted back by that offset so the child's real content lands inside the reserved
    // box instead of drifting past it and overlapping siblings.
    const anchored = footprint ? { x: computed.x - footprint.originX, y: computed.y - footprint.originY } : computed;

    return {
      id: statement.instanceId,
      type: resolveInstanceTypeName(statement),
      position: existing ?? anchored,
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

// Compute the bounding box of a module that already has a real .sw-mcl layout, so a `use`
// statement referencing it from another module can be sized to its real footprint instead of a
// generic placeholder box. Ports/instances without a matching swMcl entry are skipped rather than
// defaulted to {0, 0} (which could badly skew the box); returns undefined when nothing in the
// module could be measured at all, which callers should treat exactly like "no layout".
export function computeModuleFootprint(
  module: SwNetModule,
  swMcl: StormworksSwMclDocument,
  nestedFootprints: Map<string, ModuleFootprint>,
): ModuleFootprint | undefined {
  const swMclPortByKey = new Map(
    swMcl.ports.map((port) => [formatPortOccurrenceKey(port.direction, port.name, port.occurrence), port] as const),
  );
  const swMclInstanceById = new Map(swMcl.instances.map((instance) => [instance.id, instance] as const));

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const expand = (x: number, y: number, width: number, height: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };

  for (const slot of buildPortSlots(module)) {
    const port = swMclPortByKey.get(slot.key);

    if (port) {
      expand(port.position.x, port.position.y, PORT_NODE_SIZE, PORT_NODE_SIZE);
    }
  }

  for (const statement of module.statements) {
    const instance = swMclInstanceById.get(statement.instanceId);

    if (!instance) {
      continue;
    }

    const rowCount = Math.max(1, statement.inputs.length, statement.outputs.length);
    const nested = nestedFootprints.get(statement.instanceId);

    expand(
      instance.position.x,
      instance.position.y,
      nested?.width ?? INSTANCE_NODE_WIDTH,
      nested?.height ?? rowCount * INSTANCE_NODE_ROW_HEIGHT,
    );
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return undefined;
  }

  return { width: maxX - minX, height: maxY - minY, originX: minX, originY: minY };
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
    const footprint = options.submoduleFootprints?.get(statement.instanceId);

    children.push({
      id: INSTANCE_NODE_ID_PREFIX + statement.instanceId,
      width: footprint?.width ?? INSTANCE_NODE_WIDTH,
      height: footprint?.height ?? rowCount * INSTANCE_NODE_ROW_HEIGHT,
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
      // ELK's edge-routing spacing options default to values tuned for pixel-scale diagrams
      // (roughly 10-20x our calibrated 0.25-1.0 grid), which dominates node/layer spacing on any
      // graph with many edges unless pinned to the same scale explicitly.
      "elk.spacing.edgeNode": String(nodeSpacing),
      "elk.spacing.edgeEdge": String(nodeSpacing),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(layerSpacing),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(layerSpacing),
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
