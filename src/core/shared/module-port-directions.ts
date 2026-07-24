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

// Decide which of the module's own declared ports a quoted string reference means, or undefined if
// the reference doesn't resolve to any usable port declaration. A reference that matches a port
// declared in the local usage direction is unambiguous and always wins, even if the same name is
// also declared in the other direction — this is what makes an ambiguous same-named in/out pair
// resolve predictably instead of silently picking whichever declaration happened to be registered
// last. A *read* (direction "in") may also resolve against the module's own output port: this is the
// intended way to reuse a value the module already exposes as one of its outputs, not a workaround —
// an output can have any number of readers, inside the module or out. A *write* (direction "out")
// may only ever target a declared output port: an input port's one and only producer is the caller,
// so nothing inside the module is allowed to also drive it.
export function resolveStringPortDirection(
  portName: string,
  usageDirection: "in" | "out",
  modulePorts: ModulePortNameSets,
): "in" | "out" | undefined {
  if (modulePorts[usageDirection].has(portName)) {
    return usageDirection;
  }

  if (usageDirection === "in" && modulePorts.out.has(portName)) {
    return "out";
  }

  return undefined;
}
