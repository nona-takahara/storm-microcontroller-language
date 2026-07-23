// Assembles storm-mcl's structural gate definitions and hand-curated behavior notes into a
// single self-contained spec output, in both human-readable text and JSON-friendly shapes.
// Pure/browser-safe: no file-system access here (callers load the bundled JSON documents).
import type { IrScalarValue, IrSignalKind } from "../ir.js";
import type {
  ComponentBinding,
  ComponentDynamicInputsBinding,
  DefinitionValueType,
  NodePortDefinition,
  ProjectNodeBinding,
} from "../definitions/schema.js";
import type { NodeDefinitionRegistry } from "../definitions/loader.js";
import type {
  BehaviorNote,
  BehaviorNoteStatus,
  NodeBehaviorNotesDocument,
  StormworksSystemNotesDocument,
} from "../behavior-notes/schema.js";
import { TOOL_CONVENTIONS, type ToolConventionNote } from "./tool-conventions.js";

export interface GateSpecPort {
  key: string;
  signal: IrSignalKind;
  label?: string;
}

export interface GateSpecProperty {
  key: string;
  valueType: DefinitionValueType;
  required: boolean;
  default?: IrScalarValue;
  enumOptions?: string[];
}

// Components whose actual input port count is determined at instantiation time by a property
// value (e.g. COMPOSITE_WRITE_NUMBER's `in1`, `in2`, ... driven by its `count` property) don't
// list those ports under `ports.inputs` at all -- only the prefix/count/signal pattern is known
// statically. `exampleKeys` materializes one concrete instantiation (using the property's
// default count) so callers always see at least one realistic set of dynamic port names.
export interface GateSpecDynamicInputs {
  prefix: string;
  startIndex: number;
  countProperty: string;
  signal: IrSignalKind;
  exampleCount: number;
  exampleKeys: string[];
}

export interface GateSpec {
  id: string;
  displayName: string;
  category: string;
  stormworksBinding: string;
  inputs: GateSpecPort[];
  outputs: GateSpecPort[];
  dynamicInputs?: GateSpecDynamicInputs;
  properties: GateSpecProperty[];
  notes: BehaviorNote[];
  status: BehaviorNoteStatus;
  relatedIssues: number[];
  usageExample: string;
}

// Look up one gate/project-node definition by id and merge in its behavior notes, if any.
export function buildGateSpec(
  gateId: string,
  definitions: NodeDefinitionRegistry,
  notesDoc: NodeBehaviorNotesDocument,
): GateSpec | undefined {
  const definition = definitions.byId.get(gateId);

  if (!definition) {
    return undefined;
  }

  const stormworksBinding =
    definition.category === "project"
      ? formatProjectNodeBinding(definition.stormworks as ProjectNodeBinding)
      : formatComponentBinding(definition.stormworks as ComponentBinding);

  const properties: GateSpecProperty[] = (definition.properties ?? []).map((property) => ({
    key: property.key,
    valueType: property.valueType,
    required: property.required ?? false,
    default: definition.defaults?.[property.key],
    enumOptions: property.enum ? Object.keys(property.enum) : undefined,
  }));

  const behaviorEntry = notesDoc.entries[definition.id];
  const inputs = definition.ports.inputs.map(toGateSpecPort);
  const outputs = definition.ports.outputs.map(toGateSpecPort);

  const dynamicInputsBinding =
    definition.category !== "project" ? (definition.stormworks as ComponentBinding).dynamicInputs : undefined;
  const dynamicInputs = dynamicInputsBinding
    ? buildDynamicInputsSpec(dynamicInputsBinding, definition.defaults)
    : undefined;

  return {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    stormworksBinding,
    inputs,
    outputs,
    dynamicInputs,
    properties,
    notes: behaviorEntry?.notes ?? [],
    status: behaviorEntry?.status ?? "todo",
    relatedIssues: behaviorEntry?.relatedIssues ?? [],
    usageExample: buildUsageExample(
      definition.id,
      definition.category,
      definition.displayName,
      inputs,
      outputs,
      dynamicInputs,
      properties,
    ),
  };
}

// Materialize the prefix/count/signal pattern for a dynamic-input component into one concrete
// example (using the property's own default count, falling back to 1 if it has none).
function buildDynamicInputsSpec(
  binding: ComponentDynamicInputsBinding,
  defaults: Record<string, IrScalarValue> | undefined,
): GateSpecDynamicInputs {
  const startIndex = binding.startIndex ?? 1;
  const defaultCount = defaults?.[binding.countProperty];
  const exampleCount = typeof defaultCount === "number" && defaultCount >= 1 ? defaultCount : 1;
  const exampleKeys: string[] = [];

  for (let index = startIndex; index < startIndex + exampleCount; index += 1) {
    exampleKeys.push(`${binding.prefix}${index}`);
  }

  return {
    prefix: binding.prefix,
    startIndex,
    countProperty: binding.countProperty,
    signal: binding.signal ?? "unknown",
    exampleCount,
    exampleKeys,
  };
}

// Build a minimal, syntactically valid .sw-net snippet showing how to instantiate this gate.
// "project" category ids are project I/O pins (declared via `port in/out`, not `inst`); every
// other category is a logic component/gate (declared via `inst`).
function buildUsageExample(
  id: string,
  category: string,
  displayName: string,
  inputs: GateSpecPort[],
  outputs: GateSpecPort[],
  dynamicInputs: GateSpecDynamicInputs | undefined,
  properties: GateSpecProperty[],
): string {
  if (category === "project") {
    // Project pins have exactly one port total: an output means it's an external input into the
    // module (`port in`), an input means it's an external output out of the module (`port out`).
    const direction = outputs.length > 0 ? "in" : "out";
    const signal = (outputs[0] ?? inputs[0])?.signal ?? "unknown";
    return `port ${direction} "${displayName}" : ${signal}`;
  }

  const propertyAssignments = properties
    .filter((property) => property.required || property.default !== undefined)
    .map((property) => `${property.key}=${formatExamplePropertyValue(property)}`)
    .join(", ");
  const propertiesSuffix = propertyAssignments.length > 0 ? ` (${propertyAssignments})` : "";

  const staticInputAssignments = inputs.map((port) => `${port.key}=${toNetPlaceholder(port.key)}`);
  const dynamicInputAssignments = (dynamicInputs?.exampleKeys ?? []).map((key) => `${key}=${toNetPlaceholder(key)}`);
  const inputAssignments = [...staticInputAssignments, ...dynamicInputAssignments].join(", ");
  const outputAssignments = outputs.map((port) => `${port.key}=${toNetPlaceholder(port.key)}`).join(", ");
  const inputSegment = inputAssignments.length > 0 ? `${inputAssignments} ` : "";
  const wiringSuffix = `: ${inputSegment}-> ${outputAssignments}`;

  const primaryExample = `inst ${id} ${toInstanceNamePlaceholder(id)}${propertiesSuffix} ${wiringSuffix}`;

  // script_ref is .sw-net-only syntax sugar for `script` (see LUA's behavior notes) and never
  // appears in definitions.json's properties, so it can't surface via the generic loop above.
  if (id === "LUA") {
    const scriptRefExample = `inst ${id} ${toInstanceNamePlaceholder(id)} (script_ref="scripts/foo.lua") ${wiringSuffix}`;
    return [primaryExample, scriptRefExample].join("\n");
  }

  return primaryExample;
}

function formatExamplePropertyValue(property: GateSpecProperty): string {
  if (property.default !== undefined) {
    return property.valueType === "string" ? JSON.stringify(String(property.default)) : String(property.default);
  }

  if (property.enumOptions && property.enumOptions.length > 0) {
    return JSON.stringify(property.enumOptions[0]);
  }

  if (property.valueType === "string") {
    return '"..."';
  }

  return property.valueType === "boolean" ? "false" : "0";
}

function toNetPlaceholder(portKey: string): string {
  return `${toCamelCase(portKey)}Net`;
}

function toInstanceNamePlaceholder(id: string): string {
  return `${toCamelCase(id)}1`;
}

function toCamelCase(snakeOrLowerCaseKey: string): string {
  const [first, ...rest] = snakeOrLowerCaseKey.toLowerCase().split("_");
  return [first, ...rest.map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))].join("");
}

// Render one gate spec as self-contained human/AI-readable text.
export function formatGateSpecText(spec: GateSpec): string {
  const lines: string[] = [];

  lines.push(`${spec.id} (${spec.displayName})`);
  lines.push(`category: ${spec.category} / stormworks binding: ${spec.stormworksBinding}`);
  lines.push("");
  lines.push("Inputs:");
  lines.push(...formatPortLines(spec.inputs));

  if (spec.dynamicInputs) {
    lines.push(...formatDynamicInputsLines(spec.dynamicInputs));
  }

  lines.push("Outputs:");
  lines.push(...formatPortLines(spec.outputs));

  if (spec.properties.length > 0) {
    lines.push("");
    lines.push("Properties:");

    for (const property of spec.properties) {
      lines.push(formatPropertyLine(property));
    }
  }

  lines.push("");
  lines.push("Minimal .sw-net usage example:");

  for (const exampleLine of spec.usageExample.split("\n")) {
    lines.push(`  ${exampleLine}`);
  }

  lines.push("");
  lines.push("Known behavior notes:");

  if (spec.notes.length === 0) {
    lines.push("  No documented behavior notes for this gate yet. This does not mean it behaves");
    lines.push('  exactly as a "textbook" gate would -- it means nobody has recorded a note for it.');
    lines.push("  If precise behavior matters for your task, verify in-game rather than assuming.");
  } else {
    for (const note of spec.notes) {
      lines.push(formatNoteLine(note));
    }
  }

  if (spec.relatedIssues.length > 0) {
    lines.push("");
    lines.push(`Related issues: ${spec.relatedIssues.map((issue) => `#${issue}`).join(", ")}`);
  }

  return lines.join("\n");
}

export interface GateSpecSummary {
  id: string;
  displayName: string;
  category: string;
}

// List every queryable gate/project-node id, for `spec --list`.
export function listGateSpecSummaries(definitions: NodeDefinitionRegistry): GateSpecSummary[] {
  return [...definitions.nodes, ...definitions.components]
    .map((definition) => ({ id: definition.id, displayName: definition.displayName, category: definition.category }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

// Render the full id list grouped by category, mirroring README.md's category table.
export function formatGateSpecListText(summaries: GateSpecSummary[]): string {
  const byCategory = new Map<string, GateSpecSummary[]>();

  for (const summary of summaries) {
    const list = byCategory.get(summary.category) ?? [];
    list.push(summary);
    byCategory.set(summary.category, list);
  }

  const lines: string[] = [];
  const sortedCategories = [...byCategory.keys()].sort((left, right) => left.localeCompare(right));

  for (const category of sortedCategories) {
    lines.push(`${category}:`);

    for (const summary of byCategory.get(category)!) {
      lines.push(`  ${summary.id} (${summary.displayName})`);
    }

    lines.push("");
  }

  lines.push(`${summaries.length} gate definition(s) total. Run \`storm-mcl spec <ID>\` for details on any one.`);
  return lines.join("\n");
}

export interface SpecOverviewSystemTopic {
  id: string;
  title: string;
  notes: BehaviorNote[];
}

export interface SpecOverview {
  toolConventions: ToolConventionNote[];
  systemTopics: SpecOverviewSystemTopic[];
}

// Build the top-level overview shown by `spec` with no arguments.
export function buildSpecOverview(systemDoc: StormworksSystemNotesDocument): SpecOverview {
  return {
    toolConventions: TOOL_CONVENTIONS,
    systemTopics: Object.entries(systemDoc.entries).map(([id, topic]) => ({
      id,
      title: topic.title,
      notes: topic.notes,
    })),
  };
}

// Render the overview as self-contained text, ending with next-step command hints.
export function formatSpecOverviewText(overview: SpecOverview): string {
  const lines: string[] = [];

  lines.push("storm-mcl spec -- gate & tool behavior reference");
  lines.push("");
  lines.push("This command exists so AI agents and humans never need to read this repo's");
  lines.push('source code to answer "how does X actually behave" questions. Everything');
  lines.push("relevant is meant to be answerable from this command's output alone.");
  lines.push("");
  lines.push("== Tool conventions (storm-mcl's own non-obvious behavior) ==");

  for (const note of overview.toolConventions) {
    lines.push("");
    lines.push(`* ${note.topic}`);
    lines.push(`  ${note.text}`);
  }

  lines.push("");
  lines.push("== Stormworks system-wide facts ==");

  for (const topic of overview.systemTopics) {
    lines.push("");
    lines.push(`* ${topic.id} (${topic.title})`);

    if (topic.notes.length === 0) {
      lines.push("  No documented notes for this topic yet.");
    } else {
      for (const note of topic.notes) {
        lines.push(formatNoteLine(note));
      }
    }
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("  storm-mcl spec <definitionId>       -- full spec + behavior notes for one gate");
  lines.push("  storm-mcl spec --list               -- list every queryable gate ID by category");
  lines.push("  add --json to any of the above       -- machine-readable output");

  return lines.join("\n");
}

function toGateSpecPort(port: NodePortDefinition): GateSpecPort {
  return { key: port.key, signal: port.signal, label: port.label };
}

function formatProjectNodeBinding(binding: ProjectNodeBinding): string {
  const parts = [`type=${binding.type}`];

  if (binding.mode !== undefined) {
    parts.push(`mode=${binding.mode}`);
  }

  if (binding.bridgeType !== undefined) {
    parts.push(`bridgeType=${binding.bridgeType}`);
  }

  return parts.join(", ");
}

function formatComponentBinding(binding: ComponentBinding): string {
  const parts = [`type=${binding.type}`];

  if (binding.dynamicInputs) {
    parts.push(
      `dynamicInputs: prefix="${binding.dynamicInputs.prefix}", countProperty="${binding.dynamicInputs.countProperty}"`,
    );
  }

  return parts.join(", ");
}

function formatPortLines(ports: GateSpecPort[]): string[] {
  if (ports.length === 0) {
    return ["  (none)"];
  }

  return ports.map((port) => `  ${port.key}: ${port.signal}${port.label ? ` ("${port.label}")` : ""}`);
}

function formatDynamicInputsLines(dynamicInputs: GateSpecDynamicInputs): string[] {
  const lastExampleKey = dynamicInputs.exampleKeys[dynamicInputs.exampleKeys.length - 1] ?? `${dynamicInputs.prefix}${dynamicInputs.startIndex}`;

  return [
    `  ${dynamicInputs.prefix}${dynamicInputs.startIndex}..${lastExampleKey}: ${dynamicInputs.signal} (dynamic -- the actual count is set by the "${dynamicInputs.countProperty}" property; shown here with its default count of ${dynamicInputs.exampleCount})`,
  ];
}

function formatPropertyLine(property: GateSpecProperty): string {
  const parts = [`  ${property.key}: ${property.valueType}`, property.required ? "required" : "optional"];

  if (property.default !== undefined) {
    parts.push(`default=${JSON.stringify(property.default)}`);
  }

  if (property.enumOptions && property.enumOptions.length > 0) {
    parts.push(`enum=[${property.enumOptions.join(", ")}]`);
  }

  return parts.join(", ");
}

function formatNoteLine(note: BehaviorNote): string {
  const tag = [note.category, note.confidence].filter((value): value is string => !!value).join("/");
  const prefix = tag ? `  [${tag}] ` : "  - ";
  const sourceSuffix = note.source ? ` (source: ${note.source})` : "";
  return `${prefix}${note.text}${sourceSuffix}`;
}
