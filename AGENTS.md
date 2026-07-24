# AGENTS.md

Guidance for autonomous coding agents (e.g. Codex) working in this repository.

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

## Known environment caveat: git worktrees under a sandboxed shell

If you're working in a git worktree (not the repository's primary checkout), its real `.git`
metadata lives in the *main* repository's `.git/worktrees/<name>/` directory, outside the worktree
folder itself. Under a sandboxed shell, `git add`/`git commit` can fail with something like:

```
fatal: Unable to create '.../.git/worktrees/<name>/index.lock': Read-only file system
```

even after being granted write access to that path (e.g. via `--add-dir`) — this has been observed
to not reliably fix it in this environment (Windows drives mounted into WSL). If you hit this, do
not fight it further: leave your completed, validated changes uncommitted, list the exact files in
your response, and let the calling process commit them. This is a normal, expected handoff case,
not a failure on your part.
