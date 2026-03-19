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

export interface SwMclModuleDocument {
  id: string;
  ports: SwMclPortDocument[];
  instances: SwMclInstanceDocument[];
}

export interface StormworksSwMclDocument {
  formatVersion: typeof STORMWORKS_SW_MCL_FORMAT_VERSION;
  sourceName?: string;
  modules: SwMclModuleDocument[];
  warnings: string[];
}

export function buildStormworksSwMclDocument(program: IrProgram): StormworksSwMclDocument {
  const nodeById = new Map(program.nodes.map((node) => [node.id, node] as const));

  return {
    formatVersion: STORMWORKS_SW_MCL_FORMAT_VERSION,
    sourceName: program.metadata.sourceName,
    modules: program.submodules
      .slice()
      .sort(compareById)
      .map((submodule) => buildSwMclModuleDocument(submodule, nodeById)),
    warnings: [...program.metadata.warnings],
  };
}

export function serializeStormworksSwMcl(program: IrProgram): string {
  return JSON.stringify(buildStormworksSwMclDocument(program), null, 2);
}

function buildSwMclModuleDocument(
  submodule: IrSubmodule,
  nodeById: Map<string, IrNode>,
): SwMclModuleDocument {
  return {
    id: submodule.name,
    ports: buildSwMclPorts(submodule, nodeById),
    instances: buildSwMclInstances(submodule, nodeById),
  };
}

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

function compareById<T extends { id: string }>(left: T, right: T): number {
  return compareSwNetIdentifier(left.id, right.id);
}
