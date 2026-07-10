// Definitions schema parser that validates the external node-definition JSON used by import/export.
import type { IrScalarValue, IrSignalKind } from "../ir.js";
import {
  expectArrayWith,
  expectBooleanWith,
  expectFiniteNumberWith,
  expectIntegerWith,
  expectRecordWith,
  expectStringWith,
} from "../shared/json-schema-helpers.js";

export const NODE_DEFINITIONS_SCHEMA_VERSION = "10";

export type DefinitionValueType = "boolean" | "number" | "string";

export interface NodeDefinitionsDocument {
  schemaVersion: string;
  nodes: ProjectNodeDefinition[];
  components: ComponentDefinition[];
}

export interface DefinitionBase {
  id: string;
  displayName: string;
  category: string;
  ports: NodePortCollection;
  properties?: NodePropertyDefinition[];
  defaults?: Record<string, IrScalarValue>;
}

export interface ProjectNodeDefinition extends DefinitionBase {
  stormworks: ProjectNodeBinding;
}

export interface ComponentDefinition extends DefinitionBase {
  stormworks: ComponentBinding;
}

export interface ProjectNodeBinding {
  type: string;
  mode?: string;
  bridgeType?: string;
}

export interface ComponentBinding {
  type: string;
  dynamicInputs?: ComponentDynamicInputsBinding;
}

export interface ComponentDynamicInputsBinding {
  prefix: string;
  countProperty: string;
  startIndex?: number;
  signal?: IrSignalKind;
}

export interface NodePortCollection {
  inputs: NodePortDefinition[];
  outputs: NodePortDefinition[];
}

export interface NodePortDefinition {
  key: string;
  signal: IrSignalKind;
  label?: string;
  stormworks?: NodePortStormworksBinding;
}

export interface NodePropertyDefinition {
  key: string;
  valueType: DefinitionValueType;
  required?: boolean;
  source?: NodePropertySource;
  dsl?: NodePropertyDslBinding;
  writeTargets?: NodePropertyWriteTarget[];
  enum?: Record<string, number>;
  xmlDelta?: number;
  xmlDeltaExcept?: number;
}

export interface NodePropertySource {
  xmlPath: string;
  itemList?: boolean;
}

export interface NodePortStormworksBinding {
  xmlKey?: string;
  nodeIndex?: number;
}

export interface NodePropertyDslBinding {
  key?: string;
  emit?: boolean;
  valueType?: DefinitionValueType;
}

export interface NodePropertyWriteTarget {
  xmlPath: string;
  valueType?: DefinitionValueType;
  itemList?: boolean;
}

// Error type that keeps precise schema paths for invalid definitions documents.
export class NodeDefinitionsSchemaError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "NodeDefinitionsSchemaError";
  }
}

// Parse and validate the complete external definitions document.
export function parseNodeDefinitionsDocument(input: unknown): NodeDefinitionsDocument {
  const root = expectRecord(input, "$");
  const schemaVersion = expectString(root.schemaVersion, "$.schemaVersion");
  const nodes = expectArray(root.nodes, "$.nodes").map((value, index) =>
    parseProjectNodeDefinition(value, `$.nodes[${index}]`),
  );
  const components = expectArray(root.components, "$.components").map((value, index) =>
    parseComponentDefinition(value, `$.components[${index}]`),
  );

  return {
    schemaVersion,
    nodes,
    components,
  };
}

// Parse one project-node definition entry.
function parseProjectNodeDefinition(input: unknown, path: string): ProjectNodeDefinition {
  const base = parseDefinitionBase(input, path);
  const record = expectRecord(input, path);

  return {
    ...base,
    stormworks: parseProjectNodeBinding(record.stormworks, `${path}.stormworks`),
  };
}

// Parse one logic-component definition entry.
function parseComponentDefinition(input: unknown, path: string): ComponentDefinition {
  const base = parseDefinitionBase(input, path);
  const record = expectRecord(input, path);

  return {
    ...base,
    stormworks: parseComponentBinding(record.stormworks, `${path}.stormworks`),
  };
}

// Parse the shared definition fields used by both project nodes and logic components.
function parseDefinitionBase(input: unknown, path: string): DefinitionBase {
  const record = expectRecord(input, path);
  const propertiesValue = record.properties;
  const defaultsValue = record.defaults;

  return {
    id: expectString(record.id, `${path}.id`),
    displayName: expectString(record.displayName, `${path}.displayName`),
    category: expectString(record.category, `${path}.category`),
    ports: parseNodePortCollection(record.ports, `${path}.ports`),
    properties:
      propertiesValue === undefined
        ? undefined
        : expectArray(propertiesValue, `${path}.properties`).map((value, index) =>
            parseNodePropertyDefinition(value, `${path}.properties[${index}]`),
          ),
    defaults:
      defaultsValue === undefined ? undefined : parseScalarRecord(defaultsValue, `${path}.defaults`),
  };
}

// Parse the Stormworks binding block for one project-node definition.
function parseProjectNodeBinding(input: unknown, path: string): ProjectNodeBinding {
  const record = expectRecord(input, path);

  return {
    type: expectString(record.type, `${path}.type`),
    mode: record.mode === undefined ? undefined : expectString(record.mode, `${path}.mode`),
    bridgeType:
      record.bridgeType === undefined ? undefined : expectString(record.bridgeType, `${path}.bridgeType`),
  };
}

// Parse the Stormworks binding block for one logic-component definition.
function parseComponentBinding(input: unknown, path: string): ComponentBinding {
  const record = expectRecord(input, path);

  return {
    type: expectString(record.type, `${path}.type`),
    dynamicInputs:
      record.dynamicInputs === undefined
        ? undefined
        : parseComponentDynamicInputsBinding(record.dynamicInputs, `${path}.dynamicInputs`),
  };
}

// Parse the dynamic-input description used by components such as composite writers.
function parseComponentDynamicInputsBinding(
  input: unknown,
  path: string,
): ComponentDynamicInputsBinding {
  const record = expectRecord(input, path);

  return {
    prefix: expectString(record.prefix, `${path}.prefix`),
    countProperty: expectString(record.countProperty, `${path}.countProperty`),
    startIndex:
      record.startIndex === undefined ? undefined : expectInteger(record.startIndex, `${path}.startIndex`),
    signal: record.signal === undefined ? undefined : parseSignalKind(record.signal, `${path}.signal`),
  };
}

// Parse the input/output port lists shared by all definitions.
function parseNodePortCollection(input: unknown, path: string): NodePortCollection {
  const record = expectRecord(input, path);

  return {
    inputs: expectArray(record.inputs, `${path}.inputs`).map((value, index) =>
      parseNodePortDefinition(value, `${path}.inputs[${index}]`),
    ),
    outputs: expectArray(record.outputs, `${path}.outputs`).map((value, index) =>
      parseNodePortDefinition(value, `${path}.outputs[${index}]`),
    ),
  };
}

// Parse one port definition, including optional Stormworks-side aliases.
function parseNodePortDefinition(input: unknown, path: string): NodePortDefinition {
  const record = expectRecord(input, path);

  return {
    key: expectString(record.key, `${path}.key`),
    signal: parseSignalKind(record.signal, `${path}.signal`),
    label: record.label === undefined ? undefined : expectString(record.label, `${path}.label`),
    stormworks:
      record.stormworks === undefined
        ? undefined
        : parseNodePortStormworksBinding(record.stormworks, `${path}.stormworks`),
  };
}

// Parse one property definition, including DSL aliases and XML write targets.
function parseNodePropertyDefinition(input: unknown, path: string): NodePropertyDefinition {
  const record = expectRecord(input, path);

  return {
    key: expectString(record.key, `${path}.key`),
    valueType: parseDefinitionValueType(record.valueType, `${path}.valueType`),
    required:
      record.required === undefined ? undefined : expectBoolean(record.required, `${path}.required`),
    source: record.source === undefined ? undefined : parseNodePropertySource(record.source, `${path}.source`),
    dsl: record.dsl === undefined ? undefined : parseNodePropertyDslBinding(record.dsl, `${path}.dsl`),
    writeTargets:
      record.writeTargets === undefined
        ? undefined
        : expectArray(record.writeTargets, `${path}.writeTargets`).map((value, index) =>
            parseNodePropertyWriteTarget(value, `${path}.writeTargets[${index}]`),
          ),
    enum: record.enum === undefined ? undefined : parseEnumMapping(record.enum, `${path}.enum`),
    xmlDelta: record.xmlDelta === undefined ? undefined : expectNumber(record.xmlDelta, `${path}.xmlDelta`),
    xmlDeltaExcept:
      record.xmlDeltaExcept === undefined ? undefined : expectNumber(record.xmlDeltaExcept, `${path}.xmlDeltaExcept`),
  };
}

// Parse the XML source path for one property definition.
function parseNodePropertySource(input: unknown, path: string): NodePropertySource {
  const record = expectRecord(input, path);

  return {
    xmlPath: expectString(record.xmlPath, `${path}.xmlPath`),
    itemList: record.itemList === undefined ? undefined : expectBoolean(record.itemList, `${path}.itemList`),
  };
}

// Parse the Stormworks-side port binding used to map DSL ports back to XML names or node_index values.
function parseNodePortStormworksBinding(input: unknown, path: string): NodePortStormworksBinding {
  const record = expectRecord(input, path);

  return {
    xmlKey: record.xmlKey === undefined ? undefined : expectString(record.xmlKey, `${path}.xmlKey`),
    nodeIndex:
      record.nodeIndex === undefined ? undefined : expectInteger(record.nodeIndex, `${path}.nodeIndex`),
  };
}

// Parse the DSL-side property binding used to rename or hide properties in sw-net.
function parseNodePropertyDslBinding(input: unknown, path: string): NodePropertyDslBinding {
  const record = expectRecord(input, path);

  return {
    key: record.key === undefined ? undefined : expectString(record.key, `${path}.key`),
    emit: record.emit === undefined ? undefined : expectBoolean(record.emit, `${path}.emit`),
    valueType:
      record.valueType === undefined ? undefined : parseDefinitionValueType(record.valueType, `${path}.valueType`),
  };
}

// Parse one XML write target used when lowering DSL properties back into XML attributes or elements.
function parseNodePropertyWriteTarget(input: unknown, path: string): NodePropertyWriteTarget {
  const record = expectRecord(input, path);

  return {
    xmlPath: expectString(record.xmlPath, `${path}.xmlPath`),
    valueType:
      record.valueType === undefined ? undefined : parseDefinitionValueType(record.valueType, `${path}.valueType`),
    itemList: record.itemList === undefined ? undefined : expectBoolean(record.itemList, `${path}.itemList`),
  };
}

// Parse a scalar default-value record.
function parseScalarRecord(input: unknown, path: string): Record<string, IrScalarValue> {
  const record = expectRecord(input, path);
  const parsed: Record<string, IrScalarValue> = {};

  for (const [key, value] of Object.entries(record)) {
    parsed[key] = parseScalarValue(value, `${path}.${key}`);
  }

  return parsed;
}

// Parse one scalar value allowed in defaults and property payloads.
function parseScalarValue(input: unknown, path: string): IrScalarValue {
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean" || input === null) {
    return input;
  }

  throw new NodeDefinitionsSchemaError("Expected a scalar value", path);
}

// Validate one property value-type tag from the schema document.
function parseDefinitionValueType(input: unknown, path: string): DefinitionValueType {
  const value = expectString(input, path);

  if (value === "boolean" || value === "number" || value === "string") {
    return value;
  }

  throw new NodeDefinitionsSchemaError("Expected one of boolean | number | string", path);
}

// Validate one signal-kind tag from the schema document.
function parseSignalKind(input: unknown, path: string): IrSignalKind {
  const value = expectString(input, path);

  if (
    value === "number" ||
    value === "boolean" ||
    value === "composite" ||
    value === "video" ||
    value === "audio" ||
    value === "execute" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new NodeDefinitionsSchemaError(
    "Expected one of number | boolean | composite | video | execute | unknown",
    path,
  );
}

// Schema-specific wrappers preserve the wording already exposed in validation errors,
// while the actual guard logic is shared with the other JSON parsers.
const expectRecord = (input: unknown, path: string) =>
  expectRecordWith(input, path, NodeDefinitionsSchemaError, "Expected an object");
const expectArray = (input: unknown, path: string) =>
  expectArrayWith(input, path, NodeDefinitionsSchemaError, "Expected an array");
const expectString = (input: unknown, path: string) =>
  expectStringWith(input, path, NodeDefinitionsSchemaError, "Expected a string");
const expectBoolean = (input: unknown, path: string) =>
  expectBooleanWith(input, path, NodeDefinitionsSchemaError, "Expected a boolean");
const expectInteger = (input: unknown, path: string) =>
  expectIntegerWith(input, path, NodeDefinitionsSchemaError, "Expected an integer");
const expectNumber = (input: unknown, path: string) =>
  expectFiniteNumberWith(input, path, NodeDefinitionsSchemaError, "Expected a number");

function parseEnumMapping(input: unknown, path: string): Record<string, number> {
  const record = expectRecord(input, path);
  const result: Record<string, number> = {};

  for (const [key, value] of Object.entries(record)) {
    result[key] = expectInteger(value, `${path}.${key}`);
  }

  return result;
}
