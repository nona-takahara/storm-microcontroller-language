import { type NodeDefinitionRegistry } from "../definitions/loader.js";
import { type IrProgram } from "../ir.js";

export interface StormworksXmlExportOptions {
  definitions: NodeDefinitionRegistry;
  pretty?: boolean;
}

export interface StormworksXmlExporter {
  export(program: IrProgram, options: StormworksXmlExportOptions): string;
}

export class StubStormworksXmlExporter implements StormworksXmlExporter {
  export(_program: IrProgram, _options: StormworksXmlExportOptions): string {
    throw new Error("Stormworks XML export is intentionally not implemented in this skeleton.");
  }
}
