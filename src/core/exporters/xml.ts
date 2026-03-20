import { XMLBuilder } from "fast-xml-parser";

import {
  buildStormworksXmlTree,
  type BuildStormworksXmlTreeInput,
  type BuildStormworksXmlTreeOptions,
  type BuildStormworksXmlTreeResult,
  type StormworksXmlTreeDocument,
} from "./xml-tree.js";

export interface SerializeStormworksXmlTreeOptions {
  pretty?: boolean;
  indentBy?: string;
  includeDeclaration?: boolean;
  declarationVersion?: string;
  declarationEncoding?: string;
  suppressEmptyNode?: boolean;
  newlineAtEnd?: boolean;
}

export interface BuildStormworksXmlOptions
  extends BuildStormworksXmlTreeOptions,
    SerializeStormworksXmlTreeOptions {}

export interface BuildStormworksXmlResult extends BuildStormworksXmlTreeResult {
  xml: string;
}

export function buildStormworksXml(
  input: BuildStormworksXmlTreeInput,
  options: BuildStormworksXmlOptions,
): BuildStormworksXmlResult {
  const treeResult = buildStormworksXmlTree(input, options);

  return {
    ...treeResult,
    xml: serializeStormworksXmlTree(treeResult.tree, options),
  };
}

export function serializeStormworksXmlTree(
  tree: StormworksXmlTreeDocument,
  options: SerializeStormworksXmlTreeOptions = {},
): string {
  const includeDeclaration = options.includeDeclaration ?? true;
  const pretty = options.pretty ?? true;
  const declarationVersion = options.declarationVersion ?? "1.0";
  const declarationEncoding = options.declarationEncoding ?? "UTF-8";
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: pretty,
    indentBy: options.indentBy ?? "\t",
    suppressEmptyNode: options.suppressEmptyNode ?? true,
  });
  const rootDocument = includeDeclaration
    ? {
        "?xml": {
          "@_version": declarationVersion,
          "@_encoding": declarationEncoding,
        },
        ...tree,
      }
    : tree;
  const xml = builder.build(rootDocument);

  return (options.newlineAtEnd ?? true) ? `${xml}\n` : xml;
}
