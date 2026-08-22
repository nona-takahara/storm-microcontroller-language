// Shared types for the module-split engine (issue #64): mechanically extracting a chosen set of
// inst/use statements out of one sw-net module into a brand-new module, rewriting only the
// boundary-crossing wiring so every untouched statement's text is left byte-for-byte alone.
import { type SwNetPort, type SwNetStatement } from "../parsers/sw-net.js";
import { type SwNetTextEdit } from "../parsers/sw-net-source.js";

// The extracted module's full declaration, ready to serialize into a brand-new document alongside
// whatever imports its own moved `use` statements still need.
export interface SplitModuleNewModule {
  id: string;
  ports: SwNetPort[];
  statements: SwNetStatement[];
}

export interface SplitModulePlan {
  // Edits against the ORIGINAL document's exact source text: removing every extracted statement and
  // inserting the single `use` statement that replaces them.
  sourceEdits: SwNetTextEdit[];
  newModule: SplitModuleNewModule;
  // instanceIds moved into newModule, in their original module's declaration order -- callers use this
  // to carry the matching .sw-mcl instance-position entries over to the new module's own layout file.
  movedInstanceIds: string[];
}
