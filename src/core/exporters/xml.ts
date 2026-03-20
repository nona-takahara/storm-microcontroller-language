// Final XML string exporter that writes the reconstructed XML tree with fast-xml-parser's builder.
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

// Rebuild the XML tree and immediately serialize it to an XML string.
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

// Serialize a reconstructed XML tree object into a Stormworks-compatible XML string.
export function serializeStormworksXmlTree(
  tree: StormworksXmlTreeDocument,
  options: SerializeStormworksXmlTreeOptions = {},
): string {
  const includeDeclaration = options.includeDeclaration ?? true;
  const pretty = options.pretty ?? true;
  const declarationVersion = options.declarationVersion ?? "1.0";
  const declarationEncoding = options.declarationEncoding ?? "UTF-8";
  // fast-xml-parser is intentionally configured to preserve raw attribute names and compact empty nodes.
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

  // Declaration handling is kept outside the tree builder so tree reconstruction stays format-agnostic.
  const xml = builder.build(rootDocument);

  return (options.newlineAtEnd ?? true) ? `${xml}\n` : xml;
}
