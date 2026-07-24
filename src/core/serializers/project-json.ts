// Project-surface serializer that writes external pins and the entry submodule reference to JSON.
import { compareSwNetIdentifier } from "./sw-net-shared.js";
import { type IrProgram, type IrScalarValue, type IrSubmodule, type IrVector2 } from "../ir.js";
import { resolvePinNames } from "../shared/pin-naming.js";

export const STORMWORKS_PROJECT_JSON_FORMAT_VERSION = "stormworks-project-json-v11";

export interface ProjectJsonNodeDocument {
  id: string;
  type: string;
  label: string | null;
  description: string | null;
  // nodePosition is the Stormworks vehicle-space position of the external pin.
  nodePosition: IrVector2;
}

export interface ProjectJsonSubmoduleDocument {
  name: string;
  // relativePath points at the sw-net document that defines this submodule.
  relativePath: string;
}

export interface ProjectJsonDocument {
  formatVersion: typeof STORMWORKS_PROJECT_JSON_FORMAT_VERSION;
  sourceName?: string;
  name: string | null;
  description: string | null;
  width: number | null;
  length: number | null;
  // 16-row "#"/"." icon (see shared/microprocessor-icon.ts); null only when no microprocessor
  // metadata was present at all in the source.
  icon: string[] | null;
  // A project node's id doubles as the corresponding .sw-net module port's declared name (see
  // shared/pin-naming.ts), so connectivity is implicit and there is no separate links array.
  nodes: ProjectJsonNodeDocument[];
  // A project attaches to at most one submodule directly; deeper composition happens via `use`
  // statements inside that submodule's own .sw-net file.
  submodule: ProjectJsonSubmoduleDocument | null;
  warnings: string[];
}

// Build the project-surface document that pairs with sw-net and sw-mcl.
export function buildProjectJsonDocument(program: IrProgram): ProjectJsonDocument {
  // project.json only describes the project surface.
  // Internal logic and its layout are serialized separately into sw-net and sw-mcl.
  const projectNodes = program.nodes.filter((node) => node.layer === "project").sort(compareById);
  const pinNameByNodeId = resolvePinNames(projectNodes);

  // Keep only the project-visible slice of the IR so project.json stays small and editor-friendly.
  return {
    formatVersion: STORMWORKS_PROJECT_JSON_FORMAT_VERSION,
    sourceName: program.metadata.sourceName,
    name: asNullableString(program.metadata.microprocessor?.name),
    description: asNullableString(program.metadata.microprocessor?.description),
    width: asNullableNumber(program.metadata.microprocessor?.width),
    length: asNullableNumber(program.metadata.microprocessor?.length),
    icon: program.metadata.microprocessor?.icon ?? null,
    nodes: projectNodes.map((node) => ({
      id: pinNameByNodeId.get(node.id) ?? node.id,
      type: node.definitionId,
      label: asNullableString(node.properties.label),
      description: asNullableString(node.properties.description),
      nodePosition: node.position ?? { x: 0, y: 0 },
    })),
    submodule: buildSubmoduleDocument(program.submodules),
    warnings: program.metadata.warnings.map((warning) => warning.message),
  };
}

// Serialize the project-surface document to human-editable JSON text.
export function serializeProjectJson(program: IrProgram): string {
  return JSON.stringify(buildProjectJsonDocument(program), null, 2);
}

// Pick the single submodule directly attached to the project surface, if any.
function buildSubmoduleDocument(submodules: IrSubmodule[]): ProjectJsonSubmoduleDocument | null {
  const [first] = [...submodules].sort(compareById);

  if (!first) {
    return null;
  }

  return {
    name: first.name,
    relativePath: `${first.name}.sw-net`,
  };
}

// Normalize optional scalar values into nullable JSON strings.
function asNullableString(value: IrScalarValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

// Normalize optional numbers into nullable JSON numbers.
function asNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Sort id-bearing records by their exported identifier.
function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareIdentifier(left.id, right.id);
}

// Compare identifiers using the shared natural ordering helper.
function compareIdentifier(left: string, right: string): number {
  return compareSwNetIdentifier(left, right);
}
