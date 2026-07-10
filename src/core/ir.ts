// Shared intermediate representation used to decouple XML parsing from DSL/project serialization and export.
import { type Diagnostic } from "./diagnostics.js";
export type IrScalarValue = boolean | number | string | null;

export type IrSignalKind = "number" | "boolean" | "composite" | "video" | "audio" | "execute" | "unknown";
export type IrNodeLayer = "project" | "submodule" | "logic";

export interface IrVector2 {
  x: number;
  y: number;
}

export interface IrPortEndpoint {
  nodeId: string;
  portKey: string;
}

export interface IrNode {
  id: string;
  layer: IrNodeLayer;
  definitionId: string;
  position?: IrVector2;
  properties: Record<string, IrScalarValue>;
  source?: IrSourceRef;
  // Raw-XML/cross-reference bookkeeping populated by the importer, not user-editable gate properties.
  objectId?: string;
  stormworksType?: string;
  componentId?: string;
  projectNodeId?: string;
}

export interface IrLink {
  id: string;
  from: IrPortEndpoint;
  to: IrPortEndpoint;
  source?: IrSourceRef;
}

export interface IrSourceRef {
  format: "stormworks-xml" | "sw-net" | "unknown";
  path?: string;
}

export interface IrProgramMetadata {
  sourceFormat: "stormworks-xml" | "sw-net" | "unknown";
  sourceName?: string;
  microprocessor?: IrMicroprocessorMetadata;
  warnings: Diagnostic[];
}

export interface IrMicroprocessorMetadata {
  name?: string;
  description?: string;
  width?: number;
  length?: number;
}

export interface IrSubmodule {
  id: string;
  name: string;
  portNodeIds: string[];
  logicNodeIds: string[];
  source?: IrSourceRef;
}

export interface IrProgram {
  nodes: IrNode[];
  links: IrLink[];
  submodules: IrSubmodule[];
  metadata: IrProgramMetadata;
}

// Create an empty IR program with normalized metadata defaults.
export function createEmptyIrProgram(metadata?: Partial<IrProgramMetadata>): IrProgram {
  return {
    nodes: [],
    links: [],
    submodules: [],
    metadata: {
      sourceFormat: metadata?.sourceFormat ?? "unknown",
      sourceName: metadata?.sourceName,
      microprocessor: metadata?.microprocessor ? { ...metadata.microprocessor } : undefined,
      warnings: metadata?.warnings ?? [],
    },
  };
}
