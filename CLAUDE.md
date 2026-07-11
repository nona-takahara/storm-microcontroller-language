# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # tsc compile + copy bundled JSON assets (definitions.json, node-behavior-notes.json, stormworks-system-notes.json) to dist/
pnpm check          # type-check only (no emit)
pnpm cli <args>     # run CLI directly via tsx (no build required)
```

There are no tests. The primary way to validate behavior is `pnpm cli`.

## CLI usage

```bash
pnpm cli xml2dsl <input.xml> --out-dir <output-dir>   # Stormworks XML → project.json + sw-net + sw-mcl
pnpm cli dsl2xml <project.json> --out <output.xml>    # project.json + sw-net + sw-mcl → XML
pnpm cli check-dsl <project.json>
pnpm cli typecheck-dsl <project.json>
pnpm cli layout-dsl <project.json> [--module <id>] [--all-submodules] [--force] [--dry-run] [--grid-size <n>]
pnpm cli spec [<definitionId>] [--list] [--json]   # gate/tool behavior reference, see below
```

## MCP server

```bash
pnpm mcp          # run the stdio MCP server directly via tsx
storm-mcl-mcp    # installed/built package binary
```

The MCP server exposes `xml_to_dsl`, `dsl_to_xml`, `check_dsl`, `typecheck_dsl`, and `spec`. The `spec` tool intentionally mirrors `storm-mcl spec` because its overview, gate list, and per-gate behavior notes are optimized for AI-agent reference workflows. Keep MCP-facing descriptions and result text in English for global client compatibility.

## Architecture

The tool converts Stormworks microcontroller save files (XML) to/from a human-editable DSL format.

**Intermediate Representation (IR)** — `src/core/ir.ts`  
All formats pass through `IrProgram` (nodes + links + submodules + metadata). This decouples importers from serializers.

**Pipeline layers:**

| Layer | Direction | Entry point |
|---|---|---|
| Importer | XML → IR | `src/core/importers/xml.ts` |
| Serializers | IR → DSL files | `src/core/serializers/sw-net.ts` (orchestrates others) |
| Parsers | DSL files → IR | `src/core/parsers/sw-net.ts`, `sw-mcl.ts`, `project-json.ts` |
| Exporters | IR → XML | `src/core/exporters/xml.ts` |

**Project source** — `src/core/project-source.ts`  
`StormworksProjectSource` is the aggregate of all DSL documents for a project directory. `resolveProjectSource` links `sw-net` imports across files. The `src/core/resolvers/sw-net.ts` resolves `use` statements to the correct module definitions.

**DSL formats:**
- `.sw-net` — graph DSL: declares modules with typed ports, instantiates nodes (`inst`), wires them with `->` assignments, and composes submodules with `use`
- `.sw-mcl` — module-internal layout: port and instance positions for one `.sw-net` module (1:1 with a single module). Not required to hand-author — `dsl2xml`/`dsl_to_xml` implicitly runs the same ELK auto-layout as `pnpm cli layout-dsl` (`computeProjectLayoutOverrides`, `src/infra/fs/layout-dsl-runner.ts`) over every module reachable from `project.json` before exporting, in "fill" mode (existing positions are kept as-is; only genuinely missing ports/instances are computed), so a missing or incomplete `.sw-mcl` self-heals instead of falling through to the exporter's cruder shared-anchor/omitted-`<pos>` degradation in `src/core/exporters/xml-tree.ts`. That degradation (and its warnings) is now only reached for modules `layout-dsl`'s v1 scope excludes (issue #7) or where auto-layout itself fails. This implicit pass is purely in-memory (`applyLayoutOverride`/`applyProjectSourceLayoutOverrides`/`createLayoutOverridingDocumentLoader`, tagging synthesized data with `swMclOrigin: "computed"`) — it never writes `.sw-mcl` to disk, so dsl2xml/dsl_to_xml stays a read-only conversion from the project directory's point of view. Persisting a layout back to `.sw-mcl` always requires an explicit `layout-dsl`/`layout_dsl` call.
- `project.json` — metadata + project-surface layout (external pin/submodule anchor positions); Lua scripts referenced by `script_ref` live in separate `.lua` files

**Node definitions** — `src/definitions.json`  
The single source of truth for all gate definitions. Maps Stormworks XML `type` numbers to DSL `definitionId`s, including port signals and property XML paths. `scripts/copy-definitions.mjs` copies this file to `dist/` at build time. Schema version is enforced (`NODE_DEFINITIONS_SCHEMA_VERSION = "10"`). `definitions/sample/` is intentionally empty (the directory exists for historical reasons).

Gate coverage as of the current definitions: all known boolean logic, arithmetic, comparison, control (PID/timer/counter), composite signal, property, debug, and Lua gates are defined. Unknown XML types pass through as `LOGIC_COMPONENT:<type>` with a warning.

**Behavior-notes knowledge base & `spec` command** — `src/node-behavior-notes.json`, `src/stormworks-system-notes.json`  
`definitions.json` only covers structure (ports/properties/XML mapping); it says nothing about *actual* in-game behavior. These two hand-curated JSON files hold that knowledge: `node-behavior-notes.json` has per-gate notes keyed by `definitionId` (each with `category`/`confidence`/`source`, confidence being `"verified" | "inferred" | "unconfirmed"`), `stormworks-system-notes.json` has platform-wide notes not tied to one gate (tick rate, execution order, composite channel layout, etc.). Both are parsed by `src/core/behavior-notes/schema.ts` and loaded via `src/infra/fs/bundled-behavior-notes-loader.ts` (same bundling pattern as `bundled-definitions-loader.ts` — copied to `dist/` by `scripts/copy-definitions.mjs`). `src/core/spec/gate-spec.ts` merges definitions + behavior notes + a hardcoded `src/core/spec/tool-conventions.ts` list (this tool's own non-obvious conventions, e.g. `.sw-net` quoting rules) into the `storm-mcl spec` CLI command's output. Notes are written in English and edited directly in the two JSON files; each note's `confidence` carries any uncertainty, so note text itself should stay assertive rather than hedged. Content is scoped to what an AI given only the DSL (not the game) could otherwise misread — not general trivia. About 30 of 66 gates currently have empty `notes` (textbook-obvious gates, the `PROPERTY_*` widgets, and the project I/O pins) — this is an intentional, current gap, and `spec` reports it honestly rather than staying silent.

**Public API split:**
- `src/index.ts` — browser-safe, pure logic only (no Node.js I/O)
- `src/node.ts` — re-exports `index.ts` + `src/infra/fs/` helpers (file I/O, path resolution)
- `src/cli/main.ts` — CLI entry, imports only from `node.ts`
