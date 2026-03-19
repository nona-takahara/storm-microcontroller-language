import { type NodeDefinitionRegistry } from "../definitions/loader.js";
import { importStormworksXml, type StormworksXmlImportResult } from "../importers/xml.js";
import {
  serializeStormworksSwNet,
  type SwNetSerializationArtifact,
  type SwNetSerializationOptions,
} from "../serializers/sw-net.js";

export interface ConvertStormworksXmlOptions {
  definitions: NodeDefinitionRegistry;
  sourceName?: string;
}

export interface ConvertStormworksXmlToSwNetResult {
  imported: StormworksXmlImportResult;
  serialized: SwNetSerializationArtifact;
}

export function convertStormworksXmlToSwNet(
  xmlText: string,
  options: ConvertStormworksXmlOptions,
  serializationOptions: Omit<SwNetSerializationOptions, "definitions"> = {},
): ConvertStormworksXmlToSwNetResult {
  const imported = importStormworksXml(xmlText, {
    definitions: options.definitions,
    sourceName: options.sourceName,
  });
  const serialized = serializeStormworksSwNet(imported.program, {
    definitions: options.definitions,
    ...serializationOptions,
  });

  return {
    imported,
    serialized,
  };
}
