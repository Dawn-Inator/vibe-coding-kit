# General recovery notes

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## General Recovery Notes

- If the rebase during `finish` conflicts, finish has already aborted it and printed the
  conflicting files; rebase manually in the worktree, resolve, and re-run `end`. A
  merge-preserving finish that conflicts restores `HEAD` and prints its own manual recipe.
  Never reach for `git reset --hard origin/<base>` on a shared branch to
  "get back to clean." A hard reset silently discards any local-only commits with no
  confirmation and no dry-run; if you've done this by accident, `git reflog <branch>`
  usually still has the pre-reset tip until garbage collection runs.
- If you suspect a worker session has stalled (not actually dead), check for a live
  process and check the worktree's own `git log` for newer commits before assuming it's
  safe to take over — a worker that merely looks idle from the outside may still be
  working. If it really is dead, prefer creating a fresh worktree and cherry-picking the
  stalled branch's commits over resuming edits inside a worktree whose owning session
  might wake back up and race you.

Read [ownership-and-recovery](../../agent-orchestration-guardrails/references/ownership-and-recovery.md)
for the shared-directory boundary and the complete liveness-before-takeover decision. A lifecycle
`completed` signal, including one announcing a background wait, does not establish that its writers exited.
