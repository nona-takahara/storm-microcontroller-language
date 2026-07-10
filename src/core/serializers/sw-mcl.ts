// sw-mcl serializer that writes one module-local layout document paired 1:1 with a sw-net document.
import { type IrNode, type IrProgram, type IrSubmodule, type IrVector2 } from "../ir.js";
import {
  compareSwNetIdentifier,
  getSwNetInstanceName,
  getSwNetInstanceTypeName,
} from "./sw-net-shared.js";

export const STORMWORKS_SW_MCL_FILE_EXTENSION = ".sw-mcl";
export const STORMWORKS_SW_MCL_FORMAT_VERSION = "stormworks-sw-mcl-v1";

export interface SwMclPortDocument {
  name: string;
  direction: "in" | "out";
  occurrence: number;
  position: IrVector2;
}

export interface SwMclInstanceDocument {
  id: string;
  type: string;
  position: IrVector2;
}

export interface BuildStormworksSwMclOptions {
  moduleId?: string;
}

export interface StormworksSwMclDocument {
  formatVersion: typeof STORMWORKS_SW_MCL_FORMAT_VERSION;
  sourceName?: string;
  moduleId: string;
  // sw-mcl is 1:1 with a sw-net document and stores only module-internal layout.
  ports: SwMclPortDocument[];
  instances: SwMclInstanceDocument[];
  warnings: string[];
}

// Build the module-local layout document that pairs 1:1 with one sw-net document.
export function buildStormworksSwMclDocument(
  program: IrProgram,
  options: BuildStormworksSwMclOptions = {},
): StormworksSwMclDocument {
  // Generated layouts use module-local coordinates.
  // The module anchor itself lives in project.json.
  const nodeById = new Map(program.nodes.map((node) => [node.id, node] as const));
  const submodule = selectSwMclSubmodule(program, options.moduleId);
  const moduleId = submodule?.name ?? options.moduleId ?? "main";

  return {
    formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
    sourceName: program.metadata.sourceName,
    moduleId,
    ports: submodule ? buildSwMclPorts(submodule, nodeById) : [],
    instances: submodule ? buildSwMclInstances(submodule, nodeById) : buildFallbackSwMclInstances(program),
    warnings: program.metadata.warnings.map((warning) => warning.message),
  };
}

// Serialize the module-local layout document to JSON text.
export function serializeStormworksSwMcl(
  program: IrProgram,
  options: BuildStormworksSwMclOptions = {},
): string {
  return JSON.stringify(buildStormworksSwMclDocument(program, options), null, 2);
}

// Build the exported module-port layout, tracking repeated names by occurrence number.
function buildSwMclPorts(
  submodule: IrSubmodule,
  nodeById: Map<string, IrNode>,
): SwMclPortDocument[] {
  const occurrenceByKey = new Map<string, number>();
  const ports: SwMclPortDocument[] = [];

  for (const portNodeId of submodule.portNodeIds) {
    const node = nodeById.get(portNodeId);

    if (!node?.position) {
      continue;
    }

    const direction = String(node.properties.direction ?? "output") === "input" ? "in" : "out";
    const name = String(node.properties.name ?? node.properties.label ?? node.id);
    const occurrenceKey = `${direction}:${name}`;
    const occurrence = (occurrenceByKey.get(occurrenceKey) ?? 0) + 1;
    occurrenceByKey.set(occurrenceKey, occurrence);

    ports.push({
      name,
      direction,
      occurrence,
      position: node.position,
    });
  }

  return ports.sort(comparePorts);
}

// Build the exported logic-instance layout using the same ids and type names as sw-net.
function buildSwMclInstances(
  submodule: IrSubmodule,
  nodeById: Map<string, IrNode>,
): SwMclInstanceDocument[] {
  const instances: SwMclInstanceDocument[] = [];

  for (const logicNodeId of submodule.logicNodeIds) {
    const node = nodeById.get(logicNodeId);

    if (!node?.position) {
      continue;
    }

    instances.push({
      id: getSwNetInstanceName(node),
      type: getSwNetInstanceTypeName(node),
      position: node.position,
    });
  }

  return instances.sort(compareById);
}

// Fall back to raw logic-node positions when the IR does not expose an explicit submodule.
function buildFallbackSwMclInstances(program: IrProgram): SwMclInstanceDocument[] {
  return program.nodes
    .filter((node) => node.layer === "logic" && node.position !== undefined)
    .map((node) => ({
      id: getSwNetInstanceName(node),
      type: getSwNetInstanceTypeName(node),
      position: node.position as IrVector2,
    }))
    .sort(compareById);
}

// Pick the submodule whose inner layout should be written into this sw-mcl document.
function selectSwMclSubmodule(
  program: IrProgram,
  requestedModuleId: string | undefined,
): IrSubmodule | undefined {
  if (requestedModuleId) {
    const selected =
      program.submodules.find((submodule) => submodule.name === requestedModuleId) ??
      program.submodules.find((submodule) => submodule.id === requestedModuleId);

    if (!selected) {
      throw new Error(`Could not find submodule ${requestedModuleId} for sw-mcl serialization.`);
    }

    return selected;
  }

  return (
    program.submodules.find((submodule) => submodule.name === "main") ??
    (program.submodules.length === 1 ? program.submodules[0] : undefined)
  );
}

// Sort ports in a stable DSL-facing order so generated layout files stay diff-friendly.
function comparePorts(left: SwMclPortDocument, right: SwMclPortDocument): number {
  const directionComparison = compareSwNetIdentifier(left.direction, right.direction);

  if (directionComparison !== 0) {
    return directionComparison;
  }

  const nameComparison = compareSwNetIdentifier(left.name, right.name);

  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.occurrence - right.occurrence;
}

// Sort instance-like records by identifier using the shared sw-net ordering rules.
function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareSwNetIdentifier(left.id, right.id);
}
