# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # tsc compile + copy definitions to dist/
pnpm check          # type-check only (no emit)
pnpm cli <args>     # run CLI directly via tsx (no build required)
```

There are no tests. The primary way to validate behavior is `pnpm cli`.

## CLI usage

```bash
pnpm cli xml2dsl <input.xml> --out-dir <output-dir>   # Stormworks XML → project.json + sw-net + sw-mcl
pnpm cli dsl2xml <project.json> --out <output.xml>    # project.json + sw-net + sw-mcl → XML
pnpm cli import-xml <input.xml> --out-dir <output-dir>
pnpm cli check-dsl <project.json>
pnpm cli typecheck-dsl <project.json>
```

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
| Pipeline | XML → sw-net (one call) | `src/core/pipeline/convert.ts` |

**Project source** — `src/core/project-source.ts`  
`StormworksProjectSource` is the aggregate of all DSL documents for a project directory. `resolveProjectSource` links `sw-net` imports across files. The `src/core/resolvers/sw-net.ts` resolves `use` statements to the correct module definitions.

**DSL formats:**
- `.sw-net` — graph DSL: declares modules with typed ports, instantiates nodes (`inst`), wires them with `->` assignments, and composes submodules with `use`
- `.sw-mcl` — Lua script attachments for logic nodes
- `project.json` — metadata + layout (node positions)

**Node definitions** — `src/core/definitions/`  
A JSON schema (`definitions/sample/`) maps Stormworks node types to IR `definitionId`s, including port signals and property types. The bundled definitions are embedded at build time via `scripts/copy-definitions.mjs`. Schema version is enforced (`NODE_DEFINITIONS_SCHEMA_VERSION = "9"`).

**Public API split:**
- `src/index.ts` — browser-safe, pure logic only (no Node.js I/O)
- `src/node.ts` — re-exports `index.ts` + `src/infra/fs/` helpers (file I/O, path resolution)
- `src/cli/main.ts` — CLI entry, imports only from `node.ts`
