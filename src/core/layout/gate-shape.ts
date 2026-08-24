// Reusable gate geometry shared by layout and straight-wire readability work. Coordinates are
// local to the gate's top-left corner and follow storm-mcl-studio's fixed 0.25-row side handles.
import { findCompatibleComponentDefinition, type NodeDefinitionRegistry } from "../definitions/loader.js";
import { type NodePortActivationCondition } from "../definitions/schema.js";
import { type SwNetAssignment, type SwNetStatement } from "../parsers/sw-net.js";

export const GATE_WIDTH = 1;
export const GATE_PORT_ROW_HEIGHT = 0.25;
export const GATE_MIN_HEIGHT = 0.5;

export interface GatePortShape {
  key: string;
  direction: "input" | "output";
  index: number;
  position: { x: number; y: number };
}

export interface GateShape {
  width: number;
  height: number;
  inputs: GatePortShape[];
  outputs: GatePortShape[];
}

export function computeGateShape(statement: SwNetStatement, definitions: NodeDefinitionRegistry): GateShape {
  const inputKeys = effectivePortKeys(statement, "input", definitions);
  const outputKeys = effectivePortKeys(statement, "output", definitions);
  const height = Math.max(GATE_MIN_HEIGHT, (Math.max(inputKeys.length, outputKeys.length) + 1) * GATE_PORT_ROW_HEIGHT);

  return {
    width: GATE_WIDTH,
    height,
    inputs: placePorts(inputKeys, "input", 0),
    outputs: placePorts(outputKeys, "output", GATE_WIDTH),
  };
}

function effectivePortKeys(
  statement: SwNetStatement,
  direction: "input" | "output",
  definitions: NodeDefinitionRegistry,
): string[] {
  const connected = direction === "input" ? statement.inputs : statement.outputs;

  if (statement.kind !== "inst") {
    return uniqueKeys([], connected);
  }

  const definition = findCompatibleComponentDefinition(definitions, statement.typeId);
  if (!definition) {
    return uniqueKeys([], connected);
  }

  const declared = direction === "input"
    ? definition.ports.inputs.filter((port) => isPortActive(port.activeWhen, statement.attributes)).map((port) => port.key)
    : definition.ports.outputs.filter((port) => isPortActive(port.activeWhen, statement.attributes)).map((port) => port.key);

  return uniqueKeys(declared, connected);
}

function isPortActive(
  condition: NodePortActivationCondition | undefined,
  attributes: SwNetAssignment[],
): boolean {
  if (!condition) {
    return true;
  }

  const attribute = attributes.find(({ key }) => key === condition.property);
  return attribute !== undefined && attribute.value.value === condition.equals;
}

function uniqueKeys(declared: string[], connected: SwNetAssignment[]): string[] {
  return [...new Set([...declared, ...connected.map(({ key }) => key)])];
}

function placePorts(
  keys: string[],
  direction: "input" | "output",
  x: number,
): GatePortShape[] {
  return keys.map((key, index) => ({
    key,
    direction,
    index,
    position: { x, y: (index + 1) * GATE_PORT_ROW_HEIGHT },
  }));
}
