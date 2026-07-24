# AGENTS.md

Conventions for whoever runs as the implementer under `codex exec` in this repository. Role split and the `codex exec` invocation pattern live in `CLAUDE.md` (Claude's side) — this file only covers implementer-facing conventions and isn't duplicated there.

## Environment (most important)

- This repo's toolchain (Node/pnpm/TypeScript) is **WSL/pnpm-canonical**. There is no Windows-side toolchain to consider and no host-switching wrapper script — run `pnpm build` / `pnpm check` / `pnpm cli` / `pnpm mcp` directly from the WSL shell.
- Don't start long-running or interactive processes (dev servers, watchers) unless explicitly asked to.
- Adding a dependency (`pnpm add` or similar) needs npm-registry network access. If the sandbox is `workspace-write` with no network access, stop and report this back to the requester rather than trying to work around it or escalate the sandbox yourself — see "When you hit an external blocker" below for the general version of this rule. (In practice, the calling process may instead grant network access to an already-`workspace-write` sandbox via `-c sandbox_workspace_write.network_access=true`, which is more scoped than escalating to `-s danger-full-access` — but that's the caller's decision to make, not something to request or assume.)
- If you're working in a git worktree (not the repository's primary checkout), see the git-worktree caveat under "When you hit an external blocker" below — `git commit` can fail there in ways that look like a permissions bug but are actually a known environment limitation.

## When you hit an external blocker, hand off — don't improvise a workaround

If you hit something outside your control — a tool/permission problem, a sandbox or network
restriction, an environment inconsistency, a genuine ambiguity in your instructions you can't
reasonably resolve yourself — do **not** improvise a workaround that:

- touches any file or directory outside this repository (e.g. borrowing files, lockfiles, or
  `node_modules` from an unrelated sibling project to work around a missing dependency),
- hand-edits generated files such as `pnpm-lock.yaml` instead of regenerating them properly,
- deletes things aggressively to route around a permissions error, or
- otherwise leaves the repository in a hacky or inconsistent state to make a symptom go away.

Instead: leave the repository in its last clean, working state (or clearly describe exactly what's
uncommitted and why), write a short **HANDOFF** section at the end of your response explaining
precisely what you were trying to do, what went wrong, what you already tried, and what you think
the calling process should do about it — then stop. Someone (human or the orchestrating process)
will read the handoff, fix the underlying issue or make the judgment call, and resume you with more
specific instructions.

This rule is about genuine external blockers only. It does **not** apply to implementation
judgment calls that are explicitly delegated to you (algorithm choice, file layout, internal
architecture, etc. — see the task's own instructions for what's delegated) — keep deciding those
yourself and moving forward.

### Known environment caveat: git worktrees under a sandboxed shell

If you're working in a git worktree, its real `.git` metadata lives in the *main* repository's
`.git/worktrees/<name>/` directory, outside the worktree folder itself. Under a sandboxed shell,
`git add`/`git commit` can fail with something like:

```
fatal: Unable to create '.../.git/worktrees/<name>/index.lock': Read-only file system
```

even after being granted write access to that path (e.g. via `--add-dir`) — this has been observed
to not reliably fix it in this environment (Windows drives mounted into WSL). If you hit this, do
not fight it further: leave your completed, validated changes uncommitted, list the exact files in
your response, and let the calling process commit them. This is a normal, expected handoff case,
not a failure on your part.

## Validation gate before finishing a task

- `pnpm check` (`tsc --noEmit`) must pass.
- Most of this repo has no test suite, and `pnpm cli <subcommand>` against a real or sample project is the primary way to validate behavior there — exercise the relevant subcommand(s) for whatever changed. `src/core/compare/` is an exception: it has a scoped Vitest setup (`pnpm test`), added deliberately because that code's correctness (graph matching, bounded search, flattening) isn't reliably checkable by eyeballing CLI output — if you touch that directory, its tests must pass too.

## Tech stack

TypeScript (ESM, Node ≥18), `elkjs` (auto-layout), `fast-xml-parser`, `@modelcontextprotocol/sdk`, `tsx` for direct execution without a build step. `vitest` is a devDependency scoped to `src/core/compare/`.

## Architecture

See `CLAUDE.md`'s Architecture section for the IR pipeline, importer/serializer/parser/exporter layers, `src/definitions.json`, and the behavior-notes knowledge base — read it before touching those areas rather than re-deriving the design from the code alone.

## Scope discipline

Implement only what was asked. No unrequested refactors, new features, or speculative abstractions. Once the stated completion condition is met, stop — don't keep polishing or expanding scope.

## Files not to touch without explicit instruction

`CLAUDE.md`, `AGENTS.md`, `README.md`, `README-ja.md`, `GUIDE-ja.md`, and `package.json` dependency/script changes. If you believe one of these needs to change, say so in your handoff/diff message and leave the decision to the requester.

## Schema/versioned files

- `src/definitions.json` has an enforced `NODE_DEFINITIONS_SCHEMA_VERSION` — don't bump or edit it without a reason tied to the task.
- `src/node-behavior-notes.json` and `src/stormworks-system-notes.json` notes are written in assertive English (uncertainty is carried by the `confidence` field, not hedged wording) — keep new notes consistent with that convention.
