// Reusable gate geometry shared by layout and straight-wire readability work. Coordinates are
// local to the gate's top-left corner. The first connection starts 1.5 grid rows down, while gate
// height is the longer connection column's row count plus a fixed 0.25 units, with a 0.5 minimum.
import { findCompatibleComponentDefinition, type NodeDefinitionRegistry } from "../definitions/loader.js";
import { type NodePortActivationCondition } from "../definitions/schema.js";
import { type SwNetAssignment, type SwNetStatement } from "../parsers/sw-net.js";

export const GATE_WIDTH = 1;
export const GATE_PORT_ROW_HEIGHT = 0.25;
export const GATE_MIN_HEIGHT = 0.5;
export const GATE_HEIGHT_PADDING = 0.25;
export const GATE_FIRST_PORT_OFFSET = 1.5 * GATE_PORT_ROW_HEIGHT;

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
  const height = Math.max(
    GATE_MIN_HEIGHT,
    Math.max(inputKeys.length, outputKeys.length) * GATE_PORT_ROW_HEIGHT + GATE_HEIGHT_PADDING,
  );

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
    ? definition.ports.inputs.filter((port) => isPortActive(port.activeWhen, statement.attributes, definition.defaults)).map((port) => port.key)
    : definition.ports.outputs.filter((port) => isPortActive(port.activeWhen, statement.attributes, definition.defaults)).map((port) => port.key);

  if (direction === "input" && definition.category === "composite-write" && definition.stormworks.dynamicInputs) {
    return compositeWriteInputKeys(declared, connected, statement.attributes, definition.defaults, definition.stormworks.dynamicInputs);
  }

  return uniqueKeys(declared, connected);
}

function isPortActive(
  condition: NodePortActivationCondition | undefined,
  attributes: SwNetAssignment[],
  defaults: Record<string, string | number | boolean | null> | undefined,
): boolean {
  if (!condition) {
    return true;
  }

  return propertyValue(condition.property, attributes, defaults) === condition.equals;
}

function compositeWriteInputKeys(
  staticKeys: string[],
  connected: SwNetAssignment[],
  attributes: SwNetAssignment[],
  defaults: Record<string, string | number | boolean | null> | undefined,
  dynamicInputs: { prefix: string; countProperty: string; startIndex?: number },
): string[] {
  const startIndex = dynamicInputs.startIndex ?? 1;
  const count = propertyValue(dynamicInputs.countProperty, attributes, defaults);
  const generatedDynamicKeys = typeof count === "number" && Number.isInteger(count) && count >= 0
    ? Array.from({ length: count }, (_, offset) => `${dynamicInputs.prefix}${startIndex + offset}`)
    : [];
  const connectedDynamicKeys = connected
    .map(({ key }) => key)
    .filter((key) => dynamicInputIndex(key, dynamicInputs.prefix, startIndex) !== undefined);
  const dynamicKeys = [...new Set([...generatedDynamicKeys, ...connectedDynamicKeys])]
    .sort((left, right) => dynamicInputIndex(left, dynamicInputs.prefix, startIndex)! - dynamicInputIndex(right, dynamicInputs.prefix, startIndex)!);
  const compositeKeys = staticKeys.filter((key) => key === "inc");
  const trailingKeys = staticKeys.filter((key) => key !== "inc");

  return uniqueKeys([...compositeKeys, ...dynamicKeys, ...trailingKeys], connected);
}

function dynamicInputIndex(key: string, prefix: string, startIndex: number): number | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const index = Number(key.slice(prefix.length));
  return Number.isInteger(index) && index >= startIndex ? index : undefined;
}

function propertyValue(
  key: string,
  attributes: SwNetAssignment[],
  defaults: Record<string, string | number | boolean | null> | undefined,
): string | number | boolean | null | undefined {
  const attribute = attributes.find((candidate) => candidate.key === key);
  return attribute ? attribute.value.value : defaults?.[key];
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
    position: { x, y: GATE_FIRST_PORT_OFFSET + index * GATE_PORT_ROW_HEIGHT },
  }));
}
