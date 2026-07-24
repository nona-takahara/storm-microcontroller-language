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
pnpm cli compare-dsl <a> <b> [--module-a <id>] [--module-b <id>] [--json]
pnpm cli layout-dsl <project.json> [--module <id>] [--all-submodules] [--force] [--dry-run] [--grid-size <n>]
pnpm cli spec [<definitionId>] [--list] [--json]   # gate/tool behavior reference, see below
```

## MCP server

```bash
pnpm mcp          # run the stdio MCP server directly via tsx
storm-mcl-mcp    # installed/built package binary
```

The MCP server exposes `xml_to_dsl`, `dsl_to_xml`, `check_dsl`, `typecheck_dsl`, `compare_dsl`, `layout_dsl`, and `spec`. The `spec` tool intentionally mirrors `storm-mcl spec` because its overview, gate list, and per-gate behavior notes are optimized for AI-agent reference workflows. Keep MCP-facing descriptions and result text in English for global client compatibility.

`compare-dsl`/`compare_dsl` uses port-key-strict matching. As an intentional v1 limitation, re-serializing a commutative gate with its inputs swapped (for example AND, OR, or ADD) is reported as different even though the circuit is semantically equivalent.

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
`definitions.json` only covers structure (ports/properties/XML mapping); it says nothing about *actual* in-game behavior. These two hand-curated JSON files hold that knowledge: `node-behavior-notes.json` has per-gate notes keyed by `definitionId` (each with `category`/`confidence`/`source`, confidence being `"verified" | "inferred" | "unconfirmed"`), `stormworks-system-notes.json` has platform-wide notes not tied to one gate (tick rate, execution order, composite channel layout, etc.). Both are parsed by `src/core/behavior-notes/schema.ts` and loaded via `src/infra/fs/bundled-behavior-notes-loader.ts` (same bundling pattern as `bundled-definitions-loader.ts` — copied to `dist/` by `scripts/copy-definitions.mjs`). `src/core/spec/gate-spec.ts` merges definitions + behavior notes + a hardcoded `src/core/spec/tool-conventions.ts` list (this tool's own non-obvious conventions, e.g. `.sw-net` quoting rules) into the `storm-mcl spec` CLI command's output. Notes are written in English and edited directly in the two JSON files; each note's `confidence` carries any uncertainty, so note text itself should stay assertive rather than hedged. Content is scoped to what an AI given only the DSL (not the game) could otherwise misread — not general trivia. About 32 of 66 gates currently have empty `notes` (textbook-obvious gates, the `PROPERTY_*` widgets, and the project I/O pins) — this is an intentional, current gap, and `spec` reports it honestly rather than staying silent.

**Public API split:**
- `src/index.ts` — browser-safe, pure logic only (no Node.js I/O)
- `src/node.ts` — re-exports `index.ts` + `src/infra/fs/` helpers (file I/O, path resolution)
- `src/cli/main.ts` — CLI entry, imports only from `node.ts`

## Delegating to Codex (`codex exec`)

Delegation to Codex is **off by default** in this repository. Claude implements code directly, as it always has. Claude may proactively suggest delegating a suitable task to Codex at any point, but must not actually invoke `codex exec` unless the user has explicitly authorized/declared Codex delegation for the current session — there's no fixed trigger phrase; an explicit go-ahead from the user in that session is what matters.

This repo is WSL/`pnpm`-canonical (see `AGENTS.md`), so there's no host-switching wrapper script to route through, unlike repos in this workspace that split a Windows-only toolchain from WSL.

Once delegation is authorized for the session, invoke Codex as:

```bash
codex exec -s workspace-write -C "$(pwd)" "<task instructions>"
```

- `-s workspace-write` allows file edits but disables network access by default. Tasks that need registry access (e.g. `pnpm add`, `pnpm install`) should instead add `-c sandbox_workspace_write.network_access=true`, which grants network access while keeping every other `workspace-write` restriction (filesystem scope, etc.) in place. Prefer this over escalating to `-s danger-full-access` (which drops sandboxing entirely) — only reach for that if something *other* than network access is the actual blocker. Call out either escalation explicitly rather than doing it silently. (Without this, Codex has been observed improvising unsafe workarounds instead of asking — e.g. splicing dependency files from an unrelated sibling repo to fake a missing install. `AGENTS.md`'s handoff protocol is meant to prevent that; granting network access up front avoids needing it for this specific case.)
- `-C` pins the working root to this repository.
- If invoking Codex from within a git worktree (not this repo's primary checkout): `git commit` inside Codex's sandbox reliably fails there (`.git/worktrees/<name>/index.lock`: read-only filesystem), even when the main repo's `.git` directory is added via `--add-dir` — that has not fixed it in this environment (Windows drives mounted into WSL). Don't spend time working around this; expect Codex to hand off validated-but-uncommitted work per `AGENTS.md`, and commit it yourself after reviewing each session's diff.

Codex's own conventions live in `AGENTS.md`. Review every Codex diff against it before accepting, checking in particular:
- `pnpm check` passes
- the IR/pipeline layering (Importer → IR → Serializers/Parsers → Exporters) wasn't bypassed
- `src/definitions.json`'s schema version wasn't touched without cause
- behavior-notes conventions (English text, `confidence` field) were respected
- scope wasn't expanded beyond what was asked
