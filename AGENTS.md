# AGENTS.md

Conventions for whoever runs as the implementer under `codex exec` in this repository. Role split and the `codex exec` invocation pattern live in `CLAUDE.md` (Claude's side) — this file only covers implementer-facing conventions and isn't duplicated there.

## Environment (most important)

- This repo's toolchain (Node/pnpm/TypeScript) is **WSL/pnpm-canonical**. There is no Windows-side toolchain to consider and no host-switching wrapper script — run `pnpm build` / `pnpm check` / `pnpm cli` / `pnpm mcp` directly from the WSL shell.
- Don't start long-running or interactive processes (dev servers, watchers) unless explicitly asked to.
- Adding a dependency (`pnpm add` or similar) needs npm-registry network access. If the sandbox is `workspace-write` (no network), stop and report this back to the requester rather than trying to work around it or escalate the sandbox yourself.

## Validation gate before finishing a task

- `pnpm check` (`tsc --noEmit`) must pass.
- There is no test suite and no lint/formatter configured in this repo. `pnpm cli <subcommand>` against a real or sample project is the primary way to validate behavior — exercise the relevant subcommand(s) for whatever changed.

## Tech stack

TypeScript (ESM, Node ≥18), `elkjs` (auto-layout), `fast-xml-parser`, `@modelcontextprotocol/sdk`, `tsx` for direct execution without a build step.

## Architecture

See `CLAUDE.md`'s Architecture section for the IR pipeline, importer/serializer/parser/exporter layers, `src/definitions.json`, and the behavior-notes knowledge base — read it before touching those areas rather than re-deriving the design from the code alone.

## Scope discipline

Implement only what was asked. No unrequested refactors, new features, or speculative abstractions. Once the stated completion condition is met, stop — don't keep polishing or expanding scope.

## Files not to touch without explicit instruction

`CLAUDE.md`, `AGENTS.md`, `README.md`, `README-ja.md`, `GUIDE-ja.md`, and `package.json` dependency/script changes. If you believe one of these needs to change, say so in your handoff/diff message and leave the decision to the requester.

## Schema/versioned files

- `src/definitions.json` has an enforced `NODE_DEFINITIONS_SCHEMA_VERSION` — don't bump or edit it without a reason tied to the task.
- `src/node-behavior-notes.json` and `src/stormworks-system-notes.json` notes are written in assertive English (uncertainty is carried by the `confidence` field, not hedged wording) — keep new notes consistent with that convention.
