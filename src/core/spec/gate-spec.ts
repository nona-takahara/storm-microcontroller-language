// Assembles storm-mcl's structural gate definitions and hand-curated behavior notes into a
// single self-contained spec output, in both human-readable text and JSON-friendly shapes.
// Pure/browser-safe: no file-system access here (callers load the bundled JSON documents).
import type { IrScalarValue, IrSignalKind } from "../ir.js";
import type {
  ComponentBinding,
  DefinitionValueType,
  NodePortDefinition,
  ProjectNodeBinding,
} from "../definitions/schema.js";
import type { NodeDefinitionRegistry } from "../definitions/loader.js";
import type {
  BehaviorNote,
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

export interface GateSpec {
  id: string;
  displayName: string;
  category: string;
  stormworksBinding: string;
  inputs: GateSpecPort[];
  outputs: GateSpecPort[];
  properties: GateSpecProperty[];
  notes: BehaviorNote[];
  relatedIssues: number[];
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

  return {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    stormworksBinding,
    inputs: definition.ports.inputs.map(toGateSpecPort),
    outputs: definition.ports.outputs.map(toGateSpecPort),
    properties,
    notes: behaviorEntry?.notes ?? [],
    relatedIssues: behaviorEntry?.relatedIssues ?? [],
  };
}

// Render one gate spec as self-contained human/AI-readable text.
export function formatGateSpecText(spec: GateSpec): string {
  const lines: string[] = [];

  lines.push(`${spec.id} (${spec.displayName})`);
  lines.push(`category: ${spec.category} / stormworks binding: ${spec.stormworksBinding}`);
  lines.push("");
  lines.push("Inputs:");
  lines.push(...formatPortLines(spec.inputs));
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
