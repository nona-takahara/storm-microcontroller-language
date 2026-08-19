import { type IrScalarValue, type IrVector2 } from "../ir.js";
import { type ProjectJsonDocument } from "../serializers/project-json.js";
import { type StormworksSwMclDocument } from "../serializers/sw-mcl.js";
import { type SwNetTextEdit } from "../parsers/sw-net-source.js";

export type SynchronizationChangeKind = "added" | "removed" | "updated" | "rewired";

export interface SynchronizationNodeRef {
  nodeId: string;
  definitionId: string;
  documentPath?: string;
  moduleId?: string;
  instanceId?: string;
  usePath?: string[];
}

export interface SynchronizationChange {
  kind: SynchronizationChangeKind;
  existing?: SynchronizationNodeRef;
  incoming?: SynchronizationNodeRef;
  propertyChanges?: Record<string, { before?: IrScalarValue; after?: IrScalarValue }>;
}

export type SynchronizationConflictKind =
  | "module-boundary"
  | "shared-module-divergence"
  | "ambiguous-correspondence"
  | "ambiguous-placement"
  | "layout-projection";

export interface SynchronizationImpact {
  documentPath?: string;
  moduleId?: string;
  instanceId?: string;
  usePath?: string[];
}

export interface SynchronizationManualSuggestion {
  kind: "add-module-port" | "add-pin-assignment" | "add-use-binding" | "duplicate-module" | "update-shared-module" | "review-candidates";
  description: string;
  impacts: SynchronizationImpact[];
  details?: Record<string, string | string[]>;
}

export interface SynchronizationConflict {
  kind: SynchronizationConflictKind;
  reason: string;
  impacts: SynchronizationImpact[];
  suggestions: SynchronizationManualSuggestion[];
}

export interface SynchronizationWarning {
  kind: "layout-overwrite" | "layout-projection";
  reason: string;
  impacts: SynchronizationImpact[];
  selectedPosition?: IrVector2;
}

export interface SynchronizationSourceEditPlan {
  documentPath: string;
  edits: SwNetTextEdit[];
}

export interface SynchronizationLuaPlan {
  create: Record<string, string>;
  update: Record<string, string>;
  remove: string[];
}

export interface SynchronizationLayoutUpdate {
  documentPath: string;
  swMcl: StormworksSwMclDocument;
}

export interface SynchronizationSummary {
  added: number;
  removed: number;
  updated: number;
  rewired: number;
  conflicts: number;
}

export interface SynchronizationPlan {
  applicable: boolean;
  changes: SynchronizationChange[];
  conflicts: SynchronizationConflict[];
  warnings: SynchronizationWarning[];
  sourceEdits: SynchronizationSourceEditPlan[];
  project: ProjectJsonDocument;
  layouts: SynchronizationLayoutUpdate[];
  lua: SynchronizationLuaPlan;
  summary: SynchronizationSummary;
  proposedPositions: Record<string, IrVector2>;
}
