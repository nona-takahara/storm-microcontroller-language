// Shared position-resolution bookkeeping for one sw-net module's own inst/use instances.
// Both the XML exporter (src/core/exporters/xml-tree.ts) and the module-scoped public view
// (src/core/module-net-view.ts) look up unanchored per-instance positions from the same
// swMcl.instances-keyed-by-id map, and both need to know which sw-net instanceId values have no
// matching sw-mcl entry so a stale/renamed .sw-mcl can be reported precisely instead of silently.
import { type IrVector2 } from "../ir.js";
import { type SwNetModule } from "../parsers/sw-net.js";
import { type StormworksSwMclDocument } from "../serializers/sw-mcl.js";

export interface ModuleInstancePositions {
  positionByInstanceId: Map<string, IrVector2>;
  // instanceIds declared in module.statements but absent from swMcl.instances. Always empty when
  // swMcl is null: "no data" is not a mismatch.
  mismatchedInstanceIds: string[];
}

export function resolveModuleInstancePositions(
  module: SwNetModule,
  swMcl: StormworksSwMclDocument | null,
): ModuleInstancePositions {
  if (!swMcl) {
    return { positionByInstanceId: new Map(), mismatchedInstanceIds: [] };
  }

  const positionByInstanceId = new Map(swMcl.instances.map((instance) => [instance.id, instance.position] as const));
  const mismatchedInstanceIds = module.statements
    .map((statement) => statement.instanceId)
    .filter((instanceId) => !positionByInstanceId.has(instanceId));

  return { positionByInstanceId, mismatchedInstanceIds };
}
