# AGENTS.md

Project-specific guidance for working on storm-microcontroller-language. Keep machine-specific tool paths and personal workflow preferences in an untracked `AGENTS.override.md` instead.

## Commands

Use the pnpm version declared by `packageManager` in `package.json`.

```bash
pnpm build          # tsc compile + copy bundled JSON assets to dist/
pnpm check          # type-check only (no emit)
pnpm test           # full Vitest suite (release validation)
pnpm test:smoke     # PR-gating CLI round-trip smoke test
pnpm test:area <paths...> # tests under the changed areas, e.g. src/core/sync src/infra/fs/synchronization-runner.test.ts
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

- `pnpm test:smoke` is the required pull-request gate. It starts the real CLI entry point and exercises the parameterized English/Japanese DSL -> XML -> DSL synchronization round trip, including implicit layout and quoted bindings.
- For code changes, run `pnpm check` and only the tests relevant to the changed area before opening the pull request. Use `pnpm test:area` with one or more paths, for example `pnpm test:area src/core/compare` or `pnpm test:area src/core/sync src/infra/fs/synchronization-runner.test.ts`.
- Record the exact local commands and their result summaries in the pull request. Add a focused CLI exercise when behavior is not adequately represented by the selected automated tests.
- The complete `pnpm test` suite and `pnpm build` run in GitHub Actions when a GitHub Release is created. Running the full suite for every pull request is not required.
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

- Do not modify `CLAUDE.md`, `AGENTS.md`, `README.md`, `README-ja.md`, `GUIDE-ja.md`, or dependency/script entries in `package.json` unless the user explicitly requests it. If one appears necessary, discuss it with the user instead of changing it incidentally.
- Do not edit generated files by hand when a repository command is responsible for generating them.
