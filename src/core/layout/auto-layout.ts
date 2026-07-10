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
  // Half-width of the target output area, centered on the origin (so the layout is meant to land
  // within [-maxExtent, +maxExtent] on each axis). Stormworks' in-game microcontroller logic canvas
  // is only comfortably reachable/editable within roughly this range of its origin; ELK's layered
  // algorithm otherwise grows one axis unboundedly with graph size. See computeSwNetModuleLayout's
  // post-layout fit step.
  maxExtent?: number;
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
// Default half-width of the fit target: roughly ±32 around the origin (see AutoLayoutOptions.maxExtent).
const DEFAULT_MAX_EXTENT = 32;
const PORT_NODE_SIZE = 0.25;
const INSTANCE_NODE_WIDTH = 1.0;
const INSTANCE_NODE_ROW_HEIGHT = 0.25;
const INSTANCE_NODE_MIN_HEIGHT = 0.5;

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
  const structure = buildElkGraphStructure(portSlots, module.statements, netProducers, warnings, options.submoduleFootprints);

  const elk = new ElkConstructor();
  const maxExtent = options.maxExtent ?? DEFAULT_MAX_EXTENT;

  // Try the plain (unwrapped) layout first: wrapping's own row-to-row spacing comes out several
  // times larger than our calibrated grid regardless of which spacing option we pin (an ELK
  // wrapping quirk — see buildElkGraph), so it's only worth paying for graphs that actually need
  // wrapping to fit ±maxExtent. Most modules don't.
  let rawPositionById = collectPositions(await elk.layout(buildElkGraph(structure, options, false)));

  if (exceedsExtent(rawPositionById, maxExtent)) {
    rawPositionById = collectPositions(await elk.layout(buildElkGraph(structure, options, true)));
  }

  // Fill mode keeps every existing entry verbatim (see the ports/instances mapping below) and only
  // writes computed positions for genuinely missing ones, so re-centering/scaling the *computed*
  // frame here would detach newly-filled entries from the untouched existing ones instead of fitting
  // the module as a whole. Only safe to apply when there's no existing frame to clash with: a full
  // "force" regeneration, or a fill on a module that has no existing positions at all yet.
  if (options.mode === "force" || !hasAnyExistingPositions(options.existing)) {
    fitPositionsWithinExtent(rawPositionById, maxExtent, warnings);
  } else {
    warnIfBoundingBoxExceedsExtent(rawPositionById, maxExtent, warnings);
  }

  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
  const positionById = new Map<string, IrVector2>();

  for (const [id, position] of rawPositionById) {
    positionById.set(id, snapVector(position, gridSize));
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

// Estimate an inst/use statement's node height in .sw-mcl grid units from its pin count, calibrated
// against real Stormworks block measurements (see the scale-constants comment above): half a grid
// cell minimum, growing by one row per pin beyond the block's built-in first row.
function estimateInstanceHeight(statement: SwNetStatement): number {
  const pinCount = Math.max(statement.inputs.length, statement.outputs.length);
  return Math.max(INSTANCE_NODE_MIN_HEIGHT, (pinCount + 1) * INSTANCE_NODE_ROW_HEIGHT);
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

    const nested = nestedFootprints.get(statement.instanceId);
    // instance.position is an anchor, not the content's top-left, whenever the statement is
    // itself a real-layout `use`: the anchor-correction step in computeSwNetModuleLayout writes
    // `anchor = elkPos - nested.origin`, so the real content starts at `anchor + nested.origin`.
    const offsetX = nested?.originX ?? 0;
    const offsetY = nested?.originY ?? 0;

    expand(
      instance.position.x + offsetX,
      instance.position.y + offsetY,
      nested?.width ?? INSTANCE_NODE_WIDTH,
      nested?.height ?? estimateInstanceHeight(statement),
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

interface ElkGraphStructure {
  children: ElkNode[];
  edges: ElkExtendedEdge[];
}

// Build the ELK input graph's nodes/edges: port slots pinned to the first/last rank, instances as
// ordinary layered nodes. Structure only — computeSwNetModuleLayout may lay this out twice (see
// buildElkGraph below), and unknown-net/unknown-port warnings must only be emitted once regardless.
function buildElkGraphStructure(
  portSlots: PortSlot[],
  statements: SwNetStatement[],
  netProducers: Map<string, NetProducer>,
  warnings: string[],
  submoduleFootprints: Map<string, ModuleFootprint> | undefined,
): ElkGraphStructure {
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
    const footprint = submoduleFootprints?.get(statement.instanceId);

    children.push({
      id: INSTANCE_NODE_ID_PREFIX + statement.instanceId,
      width: footprint?.width ?? INSTANCE_NODE_WIDTH,
      height: footprint?.height ?? estimateInstanceHeight(statement),
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

  return { children, edges };
}

// Wrap a graph structure with per-pass layout options. `wrapping` toggles the aspect-ratio/wrapping
// options (see the comment below); computeSwNetModuleLayout only turns it on for a second pass when
// a first, unwrapped pass actually needs it, since wrapping's own row-to-row spacing is
// disproportionately large next to our calibrated 0.25 grid and isn't worth paying for graphs that
// fit without it. Clones each node/edge so a second pass doesn't inherit x/y/routing that ELK wrote
// onto the first pass's objects in place.
function buildElkGraph(structure: ElkGraphStructure, options: AutoLayoutOptions, wrapping: boolean): ElkNode {
  const direction = options.direction ?? "RIGHT";
  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const layerSpacing = options.layerSpacing ?? DEFAULT_LAYER_SPACING;

  const layoutOptions: Record<string, string> = {
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
  };

  if (wrapping) {
    // Without wrapping, a long chain of instances grows the layer axis unboundedly with graph
    // size. Wrapping folds long chains back on themselves toward a roughly square bounding box.
    // ELK treats each wrapped chunk like a separate weakly-connected component and packs them
    // using elk.spacing.componentComponent, and spaces wrapped edges via
    // elk.layered.wrapping.additionalEdgeSpacing — both default to a pixel-diagram scale (~20),
    // which (unpinned) blew up a 300-node chain from width 375/height 0 to width 14/height 587 in
    // testing. Pinning both to our calibrated grid scale shrinks that blowup a lot, but the gap
    // between wrapped rows still comes out several times larger than nodeSpacing regardless (an
    // ELK wrapping quirk we haven't found a spacing option to fully tame) — which is why this is
    // only turned on for graphs that actually need it, rather than unconditionally.
    layoutOptions["elk.aspectRatio"] = "1.0";
    layoutOptions["elk.layered.wrapping.strategy"] = "MULTI_EDGE";
    layoutOptions["elk.spacing.componentComponent"] = String(nodeSpacing);
    layoutOptions["elk.layered.wrapping.additionalEdgeSpacing"] = String(nodeSpacing);
  }

  return {
    id: "root",
    layoutOptions,
    children: structure.children.map((child) => ({ ...child })),
    edges: structure.edges.map((edge) => ({ ...edge })),
  };
}

// Whether any port/instance in this fill-mode layout already has a real, preserved position —
// i.e. whether there's an established coordinate frame that a global re-center/rescale could
// detach newly-computed positions from. See the guard in computeSwNetModuleLayout.
function hasAnyExistingPositions(existing: AutoLayoutExistingPositions | undefined): boolean {
  return existing !== undefined && (existing.ports.size > 0 || existing.instances.size > 0);
}

// Collect one ELK layout result's computed positions, keyed by node id.
function collectPositions(laidOut: ElkNode): Map<string, IrVector2> {
  const positionById = new Map<string, IrVector2>();

  for (const child of laidOut.children ?? []) {
    positionById.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  return positionById;
}

// Whether a layout's bounding box already exceeds [-maxExtent, +maxExtent] on either axis, used to
// decide whether the unwrapped ELK pass needs a second, wrapped pass at all.
function exceedsExtent(positionById: Map<string, IrVector2>, maxExtent: number): boolean {
  const box = computeBoundingBox(positionById);

  if (!box) {
    return false;
  }

  const targetSpan = maxExtent * 2;
  return box.maxX - box.minX > targetSpan || box.maxY - box.minY > targetSpan;
}

function computeBoundingBox(
  positionById: Map<string, IrVector2>,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (positionById.size === 0) {
    return undefined;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const position of positionById.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }

  return { minX, minY, maxX, maxY };
}

// A fill-mode layout with existing entries can't safely be re-centered/rescaled (see the guard in
// computeSwNetModuleLayout), but the module may still end up bigger than maxExtent once the
// genuinely-missing entries this call computed are combined with the preserved existing ones. Warn
// instead of silently leaving the module oversized.
function warnIfBoundingBoxExceedsExtent(
  positionById: Map<string, IrVector2>,
  maxExtent: number,
  warnings: string[],
): void {
  const box = computeBoundingBox(positionById);

  if (!box || maxExtent <= 0) {
    return;
  }

  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const targetSpan = maxExtent * 2;

  if (width > targetSpan || height > targetSpan) {
    warnings.push(
      `Newly computed positions span ${width.toFixed(2)}x${height.toFixed(2)}, exceeding the ±${maxExtent} target ` +
        `area; left unscaled because this module keeps existing hand-placed positions, and rescaling only the new ` +
        `ones would detach them from the preserved layout. Re-run with --force/--regenerate to fully regenerate ` +
        `within ±${maxExtent}.`,
    );
  }
}

// Re-center a freshly computed layout on the origin and, if its bounding box still exceeds
// [-maxExtent, +maxExtent] on either axis, scale that axis down (independently, since this is a
// schematic grid layout rather than a proportionally-drawn diagram) so it fits. This is a
// best-effort safety net on top of buildElkGraph's aspect-ratio wrapping: wrapping keeps a long
// chain from widening (or a tall stack of layers from heightening) unboundedly by folding it toward
// a square, but it only cuts along the layering axis — it can't help a graph that's wide because a
// single layer has many parallel nodes, and even squared, a large enough graph can still exceed
// maxExtent. Heavy compression from this fallback can visually overlap densely-packed nodes, hence
// the warning below. Only safe to call when there's no existing frame to detach from — see the
// guard in computeSwNetModuleLayout. Mutates `positionById` in place.
function fitPositionsWithinExtent(positionById: Map<string, IrVector2>, maxExtent: number, warnings: string[]): void {
  const box = computeBoundingBox(positionById);

  if (!box || maxExtent <= 0) {
    return;
  }

  const { minX, minY, maxX, maxY } = box;
  const width = maxX - minX;
  const height = maxY - minY;
  const targetSpan = maxExtent * 2;
  const scaleX = width > targetSpan ? targetSpan / width : 1;
  const scaleY = height > targetSpan ? targetSpan / height : 1;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  if (scaleX === 1 && scaleY === 1 && centerX === 0 && centerY === 0) {
    return;
  }

  for (const [id, position] of positionById) {
    positionById.set(id, {
      x: (position.x - centerX) * scaleX,
      y: (position.y - centerY) * scaleY,
    });
  }

  if (scaleX < 1 || scaleY < 1) {
    warnings.push(
      `Computed layout bounding box (${width.toFixed(2)}x${height.toFixed(2)}) exceeded the ±${maxExtent} target ` +
        `area; scaled down (x${scaleX.toFixed(3)}, y${scaleY.toFixed(3)}) to fit, which may compress spacing.`,
    );
  }
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
