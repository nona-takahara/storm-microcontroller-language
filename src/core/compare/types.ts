import { type Diagnostic } from "../diagnostics.js";
import { type IrLink, type IrNode, type IrScalarValue, type IrSignalKind } from "../ir.js";

export type NetworkComparisonVerdict = "equivalent" | "different" | "indeterminate";

export interface ComparablePortIdentity {
  direction: "in" | "out";
  name: string;
  signal: IrSignalKind;
  occurrence: number;
}

/**
 * Comparison-facing node shape. Source ids are retained for correspondence output, but are never
 * used as structural identity. Properties omitted by `resolveSwNetModuleGraph` are kept separately
 * so callers can distinguish attributes from literal input assignments.
 */
export interface ComparableNode {
  node: IrNode;
  port?: ComparablePortIdentity;
  attributes: Record<string, IrScalarValue>;
  literalInputs: Record<string, IrScalarValue>;
}

export interface ComparableModuleGraph {
  moduleId: string;
  nodes: ComparableNode[];
  links: IrLink[];
}

export interface MatchedNodePair {
  a: ComparableNode;
  b: ComparableNode;
}

export type NetworkDifference =
  | { kind: "unmatched-node"; side: "a" | "b"; node: ComparableNode }
  | { kind: "unmatched-link"; side: "a" | "b"; link: IrLink }
  | { kind: "input-mismatch"; nodeA: ComparableNode; nodeB: ComparableNode; portKey: string }
  | {
      kind: "property-value-mismatch";
      nodeA: ComparableNode;
      nodeB: ComparableNode;
      source: "attribute" | "literalInput";
      key: string;
      valueA?: IrScalarValue;
      valueB?: IrScalarValue;
    };

export interface NetworkComparisonResult {
  verdict: NetworkComparisonVerdict;
  matchedPairs: MatchedNodePair[];
  unmatchedInA: ComparableNode[];
  unmatchedInB: ComparableNode[];
  differences: NetworkDifference[];
  reason?: string;
  diagnostics: Diagnostic[];
}

export interface ProvenancePath {
  moduleId: string;
  instanceIds: string[];
}

export interface ProjectComparisonResult extends NetworkComparisonResult {
  moduleResults: ModuleComparisonEntry[];
  unmatchedModulesInA: string[];
  unmatchedModulesInB: string[];
}

export interface ModuleComparisonEntry {
  moduleKeyA: string;
  moduleKeyB: string;
  result: NetworkComparisonResult;
}
