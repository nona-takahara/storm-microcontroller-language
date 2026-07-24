// Shared pin-naming/dedup used by project.json, .sw-net, and .sw-mcl serializers.
// project.json's node ids double as .sw-net module port names (see serializers/project-json.ts,
// serializers/sw-net.ts, and serializers/sw-mcl.ts), so all three must compute the exact same
// deduped name for the same project-layer pin -- this is the single place that happens.
import { type IrNode } from "../ir.js";
import { compareSwNetIdentifier, tryParseSwNetTrailingNumber } from "../serializers/sw-net-shared.js";

// Assign each project-layer pin a unique, deterministic exported name, suffixing repeats of the same
// base name with _2, _3, ... in a stable order.
export function resolvePinNames(projectNodes: readonly IrNode[]): Map<string, string> {
  const sorted = [...projectNodes].sort((left, right) => compareSwNetIdentifier(left.id, right.id));
  const counts = new Map<string, number>();
  const nameByNodeId = new Map<string, string>();

  for (const node of sorted) {
    const baseName = choosePinBaseName(node);
    const nextCount = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, nextCount);
    nameByNodeId.set(node.id, nextCount === 1 ? baseName : `${baseName}_${nextCount}`);
  }

  return nameByNodeId;
}

// Resolve a submodule-layer port node's DSL-facing name, matching whatever project.json exported
// for the project pin it was synthesized from.
export function resolvePortNodeName(node: IrNode, pinNameByProjectNodeId: Map<string, string>): string {
  const projectNodeId = node.projectNodeId;
  const resolved = projectNodeId ? pinNameByProjectNodeId.get(projectNodeId) : undefined;

  return resolved ?? String(node.properties.name ?? node.properties.label ?? node.id);
}

// Prefer a human-readable name/label before falling back to numeric suffixes.
function choosePinBaseName(node: IrNode): string {
  const preferred =
    (typeof node.properties.name === "string" && node.properties.name.length > 0
      ? node.properties.name
      : undefined) ??
    (typeof node.properties.label === "string" && node.properties.label.length > 0
      ? node.properties.label
      : undefined);

  if (preferred) {
    return preferred;
  }

  const trailingId = tryParseSwNetTrailingNumber(node.id);
  return trailingId !== undefined ? `node_${trailingId}` : node.id;
}
