import { type IrVector2 } from "../ir.js";
import { type NodeDefinitionRegistry } from "../definitions/loader.js";
import { type SwNetModule, type SwNetStatement } from "../parsers/sw-net.js";
import { formatPortNameKey, formatPortOccurrenceKey } from "../serializers/sw-net-shared.js";
import { indexNetProducers } from "../shared/producer-index.js";
import {
  computeGateShape,
  GATE_FIRST_PORT_OFFSET,
  GATE_MIN_HEIGHT,
  GATE_WIDTH,
  type GateShape,
} from "./gate-shape.js";

export interface StraightWireLayout {
  ports: Map<string, IrVector2>;
  instances: Map<string, IrVector2>;
}

export interface StraightWireReadabilityWeights {
  crossing: number;
  shallowCrossing: number;
  gateIntersection: number;
  gateProximity: number;
  wireLength: number;
  diagonalLength: number;
  area: number;
}

// Kept together and exported deliberately: these are policy, not geometry, and representative
// circuits can tune them without introducing another approximation of Stormworks' gate shapes.
export const DEFAULT_STRAIGHT_WIRE_READABILITY_WEIGHTS: StraightWireReadabilityWeights = {
  crossing: 20,
  shallowCrossing: 12,
  gateIntersection: 30,
  gateProximity: 4,
  wireLength: 0.05,
  diagonalLength: 0.1,
  area: 0.002,
};

export interface StraightWireReadabilityBreakdown {
  crossings: number;
  shallowCrossings: number;
  gateIntersections: number;
  gateProximities: number;
  wireLength: number;
  diagonalLength: number;
  area: number;
}

export interface StraightWireReadabilityResult {
  score: number;
  breakdown: StraightWireReadabilityBreakdown;
  wires: StraightWireSegment[];
}

export interface StraightWireSegment {
  source: IrVector2;
  target: IrVector2;
  sourceOwner: string;
  targetOwner: string;
}

export interface ImproveStraightWireLayoutOptions {
  gridSize: number;
  maxIterations?: number;
  maxCandidateEvaluations?: number;
  weights?: StraightWireReadabilityWeights;
}

interface PlacedGate {
  id: string;
  position: IrVector2;
  shape: GateShape;
}

interface PlacedRect {
  id: string;
  position: IrVector2;
  width: number;
  height: number;
}

interface Producer {
  instanceId: string;
  outputKey: string;
}

const PROXIMITY_MARGIN = 0.125;
const EPSILON = 1e-9;
const DEFAULT_MAX_CANDIDATE_EVALUATIONS = 512;
const BOUNDARY_PORT_HEIGHT = GATE_MIN_HEIGHT;

/** Reconstruct and score the straight segments Stormworks renders between exact gate ports. */
export function evaluateStraightWireReadability(
  module: SwNetModule,
  layout: StraightWireLayout,
  definitions: NodeDefinitionRegistry,
  weights: StraightWireReadabilityWeights = DEFAULT_STRAIGHT_WIRE_READABILITY_WEIGHTS,
): StraightWireReadabilityResult {
  const gates = placeGates(module.statements, layout.instances, definitions);
  const boundaryGates = placeBoundaryGates(layout.ports);
  const obstacles: PlacedRect[] = [
    ...[...gates.values()].map((gate) => ({
      id: gate.id,
      position: gate.position,
      width: gate.shape.width,
      height: gate.shape.height,
    })),
    ...boundaryGates,
  ];
  const wires = reconstructStraightWires(module, layout, gates);
  const breakdown: StraightWireReadabilityBreakdown = {
    crossings: 0,
    shallowCrossings: 0,
    gateIntersections: 0,
    gateProximities: 0,
    wireLength: 0,
    diagonalLength: 0,
    area: layoutArea(obstacles),
  };

  for (const wire of wires) {
    const dx = wire.target.x - wire.source.x;
    const dy = wire.target.y - wire.source.y;
    breakdown.wireLength += Math.hypot(dx, dy);
    breakdown.diagonalLength += Math.min(Math.abs(dx), Math.abs(dy));

    for (const gate of obstacles) {
      if (gate.id === wire.sourceOwner || gate.id === wire.targetOwner) continue;
      if (segmentIntersectsRect(wire, gate, 0)) {
        breakdown.gateIntersections += 1;
      } else if (segmentIntersectsRect(wire, gate, PROXIMITY_MARGIN)) {
        breakdown.gateProximities += 1;
      }
    }
  }

  for (let leftIndex = 0; leftIndex < wires.length; leftIndex += 1) {
    const left = wires[leftIndex];
    if (!left) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < wires.length; rightIndex += 1) {
      const right = wires[rightIndex];
      if (!right || shareEndpoint(left, right)) continue;
      const sine = properIntersectionSine(left, right);
      if (sine === undefined) continue;
      breakdown.crossings += 1;
      // A small sine means a shallow angle whose two wires are difficult to follow. This continuous
      // term distinguishes equal crossing counts without inventing a fragile angle threshold.
      breakdown.shallowCrossings += 1 - sine;
    }
  }

  return {
    score:
      breakdown.crossings * weights.crossing +
      breakdown.shallowCrossings * weights.shallowCrossing +
      breakdown.gateIntersections * weights.gateIntersection +
      breakdown.gateProximities * weights.gateProximity +
      breakdown.wireLength * weights.wireLength +
      breakdown.diagonalLength * weights.diagonalLength +
      breakdown.area * weights.area,
    breakdown,
    wires,
  };
}

/** Deterministic bounded hill-climb over adjacent gates in one fixed ELK rank. */
export function improveStraightWireLayout(
  module: SwNetModule,
  layout: StraightWireLayout,
  definitions: NodeDefinitionRegistry,
  options: ImproveStraightWireLayoutOptions,
): StraightWireLayout {
  const instances = new Map([...layout.instances].map(([id, position]) => [id, { ...position }]));
  const result = { ports: layout.ports, instances };
  const movableIds = new Set(module.statements.filter((statement) => statement.kind === "inst").map(({ instanceId }) => instanceId));
  const defaultLimit = Math.min(64, Math.max(1, movableIds.size * movableIds.size));
  const maxIterations = Math.max(0, Math.floor(options.maxIterations ?? defaultLimit));
  const maxCandidateEvaluations = Math.max(
    0,
    Math.floor(options.maxCandidateEvaluations ?? DEFAULT_MAX_CANDIDATE_EVALUATIONS),
  );
  let candidateEvaluations = 0;
  let currentScore = evaluateStraightWireReadability(module, result, definitions, options.weights).score;

  for (
    let iteration = 0;
    iteration < maxIterations && candidateEvaluations < maxCandidateEvaluations;
    iteration += 1
  ) {
    let best: { firstId: string; secondId: string; score: number } | undefined;
    const ranks = groupRankIds(instances, movableIds, options.gridSize);

    for (const ids of ranks) {
      for (let index = 0; index + 1 < ids.length; index += 1) {
        const firstId = ids[index];
        const secondId = ids[index + 1];
        if (!firstId || !secondId) continue;
        swapY(instances, firstId, secondId);

        if (!rankOverlaps(module, ids, instances, definitions)) {
          candidateEvaluations += 1;
          const score = evaluateStraightWireReadability(module, result, definitions, options.weights).score;
          if (score < currentScore - EPSILON && (!best || score < best.score - EPSILON)) {
            best = { firstId, secondId, score };
          }
        }

        swapY(instances, firstId, secondId);
        if (candidateEvaluations >= maxCandidateEvaluations) break;
      }
      if (candidateEvaluations >= maxCandidateEvaluations) break;
    }

    if (!best) break;
    swapY(instances, best.firstId, best.secondId);
    currentScore = best.score;
  }

  return result;
}

function placeGates(
  statements: SwNetStatement[],
  positions: Map<string, IrVector2>,
  definitions: NodeDefinitionRegistry,
): Map<string, PlacedGate> {
  const gates = new Map<string, PlacedGate>();
  for (const statement of statements) {
    if (statement.kind !== "inst") continue;
    const position = positions.get(statement.instanceId);
    if (position) gates.set(statement.instanceId, { id: statement.instanceId, position, shape: computeGateShape(statement, definitions) });
  }
  return gates;
}

function placeBoundaryGates(ports: Map<string, IrVector2>): PlacedRect[] {
  return [...ports].map(([key, position]) => ({
    id: `port:${key}`,
    position,
    width: GATE_WIDTH,
    height: BOUNDARY_PORT_HEIGHT,
  }));
}

function reconstructStraightWires(
  module: SwNetModule,
  layout: StraightWireLayout,
  gates: Map<string, PlacedGate>,
): StraightWireSegment[] {
  const producers = indexNetProducers<SwNetStatement, Producer>(
    module.statements,
    (statement) => statement,
    (statement, outputKey) => ({ instanceId: statement.instanceId, outputKey }),
    () => undefined,
  );
  const portKeysByName = new Map<string, string[]>();
  const occurrences = new Map<string, number>();
  for (const port of module.ports) {
    const nameKey = formatPortNameKey(port.direction, port.name);
    const occurrence = (occurrences.get(nameKey) ?? 0) + 1;
    occurrences.set(nameKey, occurrence);
    const key = formatPortOccurrenceKey(port.direction, port.name, occurrence);
    const list = portKeysByName.get(nameKey) ?? [];
    list.push(key);
    portKeysByName.set(nameKey, list);
  }

  const wires: StraightWireSegment[] = [];
  for (const statement of module.statements) {
    const targetGate = gates.get(statement.instanceId);
    if (!targetGate) continue;
    for (const input of statement.inputs) {
      const target = absoluteGatePort(targetGate, "input", input.key);
      if (!target) continue;
      if (input.value.kind === "identifier") {
        const producer = producers.get(input.value.value);
        const sourceGate = producer ? gates.get(producer.instanceId) : undefined;
        const source = producer && sourceGate ? absoluteGatePort(sourceGate, "output", producer.outputKey) : undefined;
        if (producer && source) wires.push({ source, target, sourceOwner: producer.instanceId, targetOwner: statement.instanceId });
      } else if (input.value.kind === "string") {
        for (const key of portKeysByName.get(formatPortNameKey("in", input.value.value)) ?? []) {
          const position = layout.ports.get(key);
          if (position) {
            wires.push({
              source: boundaryPortPoint(position, "in"),
              target,
              sourceOwner: `port:${key}`,
              targetOwner: statement.instanceId,
            });
          }
        }
      }
    }
    for (const output of statement.outputs) {
      if (output.value.kind !== "string") continue;
      const source = absoluteGatePort(targetGate, "output", output.key);
      if (!source) continue;
      for (const key of portKeysByName.get(formatPortNameKey("out", output.value.value)) ?? []) {
        const position = layout.ports.get(key);
        if (position) {
          wires.push({
            source,
            target: boundaryPortPoint(position, "out"),
            sourceOwner: statement.instanceId,
            targetOwner: `port:${key}`,
          });
        }
      }
    }
  }
  return wires;
}

function boundaryPortPoint(position: IrVector2, direction: "in" | "out"): IrVector2 {
  return {
    x: position.x + (direction === "in" ? GATE_WIDTH : 0),
    y: position.y + GATE_FIRST_PORT_OFFSET,
  };
}

function absoluteGatePort(gate: PlacedGate, direction: "input" | "output", key: string): IrVector2 | undefined {
  const port = gate.shape[direction === "input" ? "inputs" : "outputs"].find((candidate) => candidate.key === key);
  return port ? { x: gate.position.x + port.position.x, y: gate.position.y + port.position.y } : undefined;
}

function properIntersectionSine(left: StraightWireSegment, right: StraightWireSegment): number | undefined {
  const leftVector = { x: left.target.x - left.source.x, y: left.target.y - left.source.y };
  const rightVector = { x: right.target.x - right.source.x, y: right.target.y - right.source.y };
  const denominator = Math.hypot(leftVector.x, leftVector.y) * Math.hypot(rightVector.x, rightVector.y);
  if (denominator <= EPSILON) return undefined;
  const cross = crossProduct(leftVector, rightVector);
  if (Math.abs(cross) <= EPSILON) return undefined;
  const offset = { x: right.source.x - left.source.x, y: right.source.y - left.source.y };
  const leftParameter = crossProduct(offset, rightVector) / cross;
  const rightParameter = crossProduct(offset, leftVector) / cross;
  if (leftParameter <= EPSILON || leftParameter >= 1 - EPSILON || rightParameter <= EPSILON || rightParameter >= 1 - EPSILON) return undefined;
  return Math.abs(cross) / denominator;
}

function segmentIntersectsRect(wire: StraightWireSegment, gate: PlacedRect, margin: number): boolean {
  const minX = gate.position.x - margin;
  const minY = gate.position.y - margin;
  const maxX = gate.position.x + gate.width + margin;
  const maxY = gate.position.y + gate.height + margin;
  let lower = 0;
  let upper = 1;
  const dx = wire.target.x - wire.source.x;
  const dy = wire.target.y - wire.source.y;
  for (const [p, q] of [[-dx, wire.source.x - minX], [dx, maxX - wire.source.x], [-dy, wire.source.y - minY], [dy, maxY - wire.source.y]] as const) {
    if (Math.abs(p) <= EPSILON) {
      if (q < 0) return false;
    } else {
      const ratio = q / p;
      if (p < 0) lower = Math.max(lower, ratio);
      else upper = Math.min(upper, ratio);
      if (lower > upper) return false;
    }
  }
  return true;
}

function shareEndpoint(left: StraightWireSegment, right: StraightWireSegment): boolean {
  return samePoint(left.source, right.source) || samePoint(left.source, right.target) || samePoint(left.target, right.source) || samePoint(left.target, right.target);
}

function samePoint(left: IrVector2, right: IrVector2): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function crossProduct(left: IrVector2, right: IrVector2): number {
  return left.x * right.y - left.y * right.x;
}

function layoutArea(boxes: PlacedRect[]): number {
  if (boxes.length === 0) return 0;
  const minX = Math.min(...boxes.map(({ position }) => position.x));
  const minY = Math.min(...boxes.map(({ position }) => position.y));
  const maxX = Math.max(...boxes.map(({ position, width }) => position.x + width));
  const maxY = Math.max(...boxes.map(({ position, height }) => position.y + height));
  return (maxX - minX) * (maxY - minY);
}

function groupRankIds(positions: Map<string, IrVector2>, movableIds: Set<string>, gridSize: number): string[][] {
  const byRank = new Map<number, string[]>();
  const quantum = gridSize > 0 ? gridSize : 1e-6;
  for (const [id, position] of positions) {
    if (!movableIds.has(id)) continue;
    const rank = Math.round(position.x / quantum);
    const ids = byRank.get(rank) ?? [];
    ids.push(id);
    byRank.set(rank, ids);
  }
  return [...byRank.entries()].sort(([left], [right]) => left - right).map(([, ids]) => ids.sort((left, right) => {
    const delta = (positions.get(left)?.y ?? 0) - (positions.get(right)?.y ?? 0);
    return delta || left.localeCompare(right);
  }));
}

function swapY(positions: Map<string, IrVector2>, firstId: string, secondId: string): void {
  const first = positions.get(firstId);
  const second = positions.get(secondId);
  if (!first || !second) return;
  positions.set(firstId, { x: first.x, y: second.y });
  positions.set(secondId, { x: second.x, y: first.y });
}

function rankOverlaps(module: SwNetModule, ids: string[], positions: Map<string, IrVector2>, definitions: NodeDefinitionRegistry): boolean {
  const statementById = new Map(module.statements.map((statement) => [statement.instanceId, statement]));
  const intervals = ids.map((id) => {
    const statement = statementById.get(id);
    const position = positions.get(id);
    return statement && position ? { min: position.y, max: position.y + computeGateShape(statement, definitions).height } : undefined;
  }).filter((interval): interval is { min: number; max: number } => interval !== undefined).sort((left, right) => left.min - right.min);
  return intervals.some((interval, index) => index > 0 && interval.min < (intervals[index - 1]?.max ?? interval.min) - EPSILON);
}
