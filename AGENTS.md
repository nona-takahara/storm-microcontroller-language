# AGENTS.md

Guidance for AI agents working directly with the user in this repository. This is the canonical repository instruction file; tool-specific instruction files should import it rather than duplicate it.

## Working with the user

- Treat the user as the decision-maker and collaborate with them directly. Do not assume a Claude-to-Codex role split, an external orchestrator, or a `codex exec` handoff workflow.
- For implementation requests, inspect the relevant code, make reasonable in-scope decisions, implement, validate, and report the result. Ask the user when a missing choice would materially change the outcome or expand the requested scope.
- For investigation, design, review, or planning requests, keep implementation separate unless the user also asks for changes. Share intermediate findings when they help the user steer an important decision.
- Preserve unrelated user changes in the working tree. Do not commit, push, open a pull request, or otherwise publish changes unless the user explicitly asks.

## Environment

- This repository's Node/pnpm/TypeScript toolchain is **WSL/pnpm-canonical**. There is no Windows-side toolchain or host-switching wrapper. Run `pnpm build`, `pnpm check`, `pnpm cli`, and `pnpm mcp` directly from the WSL shell.
- Do not start long-running or interactive processes such as development servers or watchers unless explicitly asked.
- Adding a dependency (`pnpm add` or similar) requires npm-registry network access. If the current environment does not permit it, report the blocker instead of borrowing dependencies or generated files from another project, hand-editing `pnpm-lock.yaml`, or weakening the sandbox without the user's approval.
- In a git worktree, sandbox restrictions can make the main repository's `.git/worktrees/<name>/` metadata read-only. If `git add` or `git commit` fails for that reason, leave the validated changes uncommitted and report the exact files; do not fight the restriction with destructive or out-of-repository workarounds.

## Commands

```bash
pnpm build          # tsc compile + copy bundled JSON assets to dist/
pnpm check          # type-check only (no emit)
pnpm test           # Vitest suite
pnpm cli <args>     # run the CLI directly via tsx (no build required)
```

### CLI usage

```bash
pnpm cli xml2dsl <input.xml> --out-dir <output-dir>   # Stormworks XML -> project.json + sw-net + sw-mcl
pnpm cli dsl2xml <project.json> --out <output.xml>    # project.json + sw-net + sw-mcl -> XML
pnpm cli check-dsl <project.json>
pnpm cli typecheck-dsl <project.json>
pnpm cli compare-dsl <a> <b> [--module-a <id>] [--module-b <id>] [--json]
pnpm cli layout-dsl <project.json> [--module <id>] [--all-submodules] [--force] [--dry-run] [--grid-size <n>]
pnpm cli spec [<definitionId>] [--list] [--json]
```

## Validation before finishing

- `pnpm check` (`tsc --noEmit`) must pass for code changes.
- Most of the repository has no automated test suite. Exercise the relevant `pnpm cli <subcommand>` against a real or sample project when behavior changes.
- Vitest covers comparison logic and cross-cutting behavior such as localization. Run `pnpm test` when those areas change.
- For documentation-only changes, inspect the rendered source/diff and verify internal references and commands; code validation is not required unless the documentation change depends on current runtime behavior.
- If validation cannot run, state what was not run and why. Do not imply that an unrun check passed.

## MCP server

```bash
pnpm mcp          # run the stdio MCP server directly via tsx
storm-mcl-mcp     # installed/built package binary
```

The MCP server exposes `xml_to_dsl`, `dsl_to_xml`, `check_dsl`, `typecheck_dsl`, `compare_dsl`, `layout_dsl`, and `spec`. The `spec` tool mirrors `storm-mcl spec`; its overview, gate list, and per-gate behavior notes are designed for AI-agent reference workflows. Keep MCP-facing descriptions and result text in English for global client compatibility.

`compare-dsl`/`compare_dsl` uses port-key-strict matching. As an intentional v1 limitation, a commutative gate whose inputs have been swapped (for example AND, OR, or ADD) is reported as different even though the circuit is semantically equivalent.

## Architecture

The tool converts Stormworks microcontroller save files (XML) to and from a human-editable DSL format.

### Intermediate Representation

All formats pass through `IrProgram` in `src/core/ir.ts` (nodes, links, submodules, and metadata). This keeps importers decoupled from serializers and exporters.

| Layer | Direction | Entry point |
|---|---|---|
| Importer | XML -> IR | `src/core/importers/xml.ts` |
| Serializers | IR -> DSL files | `src/core/serializers/sw-net.ts` (orchestrates the others) |
| Parsers | DSL files -> IR | `src/core/parsers/sw-net.ts`, `sw-mcl.ts`, `project-json.ts` |
| Exporters | IR -> XML | `src/core/exporters/xml.ts` |

Do not bypass this pipeline when adding format behavior. Put conversion logic in the layer that owns it.

### Project source and DSL formats

`StormworksProjectSource` in `src/core/project-source.ts` aggregates all DSL documents for a project directory. `resolveProjectSource` links `.sw-net` imports across files; `src/core/resolvers/sw-net.ts` resolves `use` statements to module definitions.

- `.sw-net` is the graph DSL. It declares modules with typed ports, instantiates nodes with `inst`, wires them using `->`, and composes submodules with `use`.
- `.sw-mcl` stores module-internal port and instance positions for one `.sw-net` module. It does not need to be hand-authored. `dsl2xml`/`dsl_to_xml` runs the same ELK auto-layout used by `layout-dsl` over every reachable module in fill mode: existing positions remain unchanged and only missing positions are computed. This pass is in memory and tags synthesized data with `swMclOrigin: "computed"`; it never writes `.sw-mcl`. Persisting layout requires an explicit `layout-dsl`/`layout_dsl` call. The exporter's shared-anchor or omitted-`<pos>` degradation is reserved for modules outside layout v1's scope (issue #7) or auto-layout failures.
- `project.json` stores metadata and project-surface layout for external pins and submodule anchors. Lua scripts referenced by `script_ref` live in separate `.lua` files.

### Node definitions and behavior knowledge

`src/definitions.json` is the source of truth for gate structure: Stormworks XML `type` numbers, DSL `definitionId`s, port signals, and property XML paths. `scripts/copy-definitions.mjs` copies it to `dist/` at build time. Its schema version is enforced by `NODE_DEFINITIONS_SCHEMA_VERSION`; do not edit or bump it without a task-specific reason. `definitions/sample/` is intentionally empty for historical reasons. Unknown XML types pass through as `LOGIC_COMPONENT:<type>` with a warning.

Runtime behavior belongs in `src/node-behavior-notes.json` and `src/stormworks-system-notes.json`, not in `definitions.json`. The former contains per-gate notes keyed by `definitionId`; the latter contains platform-wide facts such as tick rate, execution order, and composite channel layout. Both are parsed under `src/core/behavior-notes/`, loaded through `src/infra/fs/`, and copied to `dist/` as bundled assets.

`src/core/spec/gate-spec.ts` combines definitions, behavior notes, and `src/core/spec/tool-conventions.ts` into the `spec` CLI/MCP output. Notes are written in assertive English. Their `confidence` field (`verified`, `inferred`, or `unconfirmed`) carries uncertainty, so do not hedge the note text. Include only behavior an agent given the DSL but not the game could otherwise misread; empty notes for textbook-obvious gates and project I/O are intentional.

### Public API split

- `src/index.ts` is browser-safe and contains pure logic only; it must not depend on Node.js I/O.
- `src/node.ts` re-exports `index.ts` plus `src/infra/fs/` helpers.
- `src/cli/main.ts` is the CLI entry point and imports only from `node.ts`.

## Tech stack

TypeScript (ESM, Node >=18), `elkjs` for auto-layout, `fast-xml-parser`, `intl-messageformat`, `@modelcontextprotocol/sdk`, `tsx` for direct execution, and Vitest.

## Scope and file discipline

- Implement only what the user asked for. Do not add unrelated refactors, speculative abstractions, or cleanup that does not contribute to the requested result.
- Prefer a coherent completed structure over the smallest textual diff when the task genuinely requires broader changes, but explain the scope and preserve unrelated work.
- Do not modify `CLAUDE.md`, `AGENTS.md`, `README.md`, `README-ja.md`, `GUIDE-ja.md`, or dependency/script entries in `package.json` unless the user explicitly requests it. If one appears necessary, discuss it with the user instead of changing it incidentally.
- Do not edit generated files by hand when a repository command is responsible for generating them.

## External blockers

When a permission, network, tool, or environment problem prevents progress, exhaust safe in-repository diagnostics, then stop and explain:

- what outcome you were trying to reach,
- the exact blocker and relevant error,
- what you already checked or attempted,
- the state of any uncommitted changes, and
- the smallest user action or permission change that would unblock the work.

Do not route around the blocker by touching files outside this repository, borrowing another project's `node_modules` or lockfile, aggressively deleting files, or leaving the repository in an inconsistent state. Genuine implementation decisions remain the agent's responsibility; use this blocker protocol only for constraints that cannot be resolved within the authorized scope.
