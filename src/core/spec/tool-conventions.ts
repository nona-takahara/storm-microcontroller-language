// Curated, hand-written list of this tool's own non-obvious conventions — the kind of
// tacit knowledge a DSL author or AI agent would otherwise only find by reading the
// parser/serializer source directly. Surfaced by `storm-mcl spec` with no arguments.
// Keep entries short, concrete, and about surprising behavior — not general syntax
// already documented in README.md.

export interface ToolConventionNote {
  topic: string;
  text: string;
}

export const TOOL_CONVENTIONS: ToolConventionNote[] = [
  {
    topic: "quoted strings vs. bare identifiers in .sw-net wiring",
    text:
      'A quoted string ("Port Name") in a wiring expression means "reference this module\'s own declared port name." A bare identifier (net1) means "an internal net local to this module." Mixing these up is NOT a parse error — it silently produces an unresolved-reference warning and a dropped connection, not the wiring you intended.',
  },
  {
    topic: "whitespace, comments, and import ordering in .sw-net",
    text:
      "Whitespace, indentation, and line breaks are purely cosmetic and never semantically significant — a statement may be split across many lines or packed onto one. `#` starts a line comment, valid at line-start or line-end. Every `import` statement must appear before any `module` declaration in the file; an import placed after a module is a hard parse error.",
  },
  {
    topic: "omitted properties are not filled with defaults.json",
    text:
      "If you omit a property entirely from an `inst (...)` line, storm-mcl does NOT fill in definitions.json's documented default when exporting to XML — the attribute is simply absent from the XML, and it is Stormworks itself (not this tool) that decides what an absent attribute means at load time. Do not assume the tool silently applies a definition's `defaults`.",
  },
  {
    topic: "which default-valued properties get omitted from exported XML",
    text:
      "If you explicitly write a property whose value equals its declared default, storm-mcl normally still emits it to XML as-is. Two known exceptions omit a matching-default value instead: (a) xmlDelta-encoded properties (e.g. composite channel/offset encodings), and (b) empty-string defaults. Separately and unconditionally, a numeric `@value` mirror attribute is dropped whenever the value is exactly 0, regardless of that property's own default.",
  },
  {
    topic: ".sw-mcl (layout file) is optional, and 1 file = 1 module",
    text:
      "A missing .sw-mcl for a non-entry (imported/used) module is not an error — its instances degrade to a single shared anchor position with one warning. A .sw-mcl that exists but is missing an individual instance's entry instead warns per-instance. One .sw-mcl file can only describe layout for exactly one .sw-net module, even if that .sw-net file legally declares several.",
  },
  {
    topic: "import path and module-resolution rules",
    text:
      "Import paths must be relative (start with ./ or ../) and end in .sw-net. Duplicate module IDs/aliases and `use` cycles are hard errors, not warnings — check-dsl/typecheck-dsl will refuse to proceed past them.",
  },
];
