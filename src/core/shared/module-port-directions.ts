// Shared port-name/direction bookkeeping for one sw-net module's own declared ports.
// A module may legally (if unusually) declare the same name in both directions, so lookups stay
// direction-keyed rather than collapsing to a single name -> direction map, which would silently let
// one direction's declaration shadow the other's. Both the exporter (src/core/exporters/xml-tree.ts)
// and the DSL validator (src/core/project-source.ts) resolve a module's own quoted port
// self-references through this same shape so their notion of "which port does this name mean" cannot
// drift apart.
import { type SwNetPort } from "../parsers/sw-net.js";

export interface ModulePortNameSets {
  in: ReadonlySet<string>;
  out: ReadonlySet<string>;
}

export function buildModulePortNameSets(ports: SwNetPort[]): ModulePortNameSets {
  return {
    in: new Set(ports.filter((port) => port.direction === "in").map((port) => port.name)),
    out: new Set(ports.filter((port) => port.direction === "out").map((port) => port.name)),
  };
}
