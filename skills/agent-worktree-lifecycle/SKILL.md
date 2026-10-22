---
name: agent-worktree-lifecycle
description: Use before creating, editing, finishing, or cleaning managed agent worktrees. Skip read-only tasks and explicit requests to avoid Git writes.
---

# Agent Worktree Lifecycle

Agent-facing entry for this repository's agent worktree lifecycle. The mechanics live in
`engineering/automation/agent-worktrees/`; read the script for exact behavior, and expect it to print the
repair command when it refuses. Detail, rationale and runbooks are in `references/` (index at the bottom).

## When To Use

- Before any implementation that edits code, docs, tests, config or generated repo artifacts.
- When the user asks to continue a task, create a worktree, finish / submit / merge, clean up a managed
  worktree, or inspect leftover managed worktree state (`claude/*`, `codex/*`, or your project's prefixes).
- Skip for read-only analysis, status queries, and explicit instructions not to create a worktree, commit or merge.

## Red lines

- **Never switch branches, commit, merge or reset in the primary worktree** (the one a human works in). Agent work happens in a managed worktree.
- **Never run `git stash` in a managed worktree** (including `apply` / `pop` / `show`): `refs/stash` is one ref shared by every worktree. Save with `git diff > patch`, discard with `git restore`.
- **Never `rm -rf` a worktree**; remove it with `pnpm worktree:cleanup` or let `worktree:end` do it.
- **Never push the temporary `claude/*` / `codex/*` branch**; `worktree:end` pushes only its recorded base and deletes the temp branch.
- **Never resolve conflicts one-sidedly** (`-X theirs`, `-X ours`, `-s ours`) and never `git reset --hard origin/<base>` on a shared branch to "get clean". Abort and resolve by hand.
- **Do not leave finished work unlanded**: commit and `worktree:end` before reporting a task done; "kept local waiting for validation" is not a terminal state.
- **Session closeout reclaims leftovers**: `pnpm worktree:status`, then `pnpm worktree:cleanup -- --reclaim-stale --stale-days 14` (dry run), then `--apply` once nobody else is active.
- Env-var escape hatches (`WTG_PRIMARY_LOCK_ALLOW`, `WTG_SYNC_PRIMARY_APPROVED_BY`, ...) are deliberate human/orchestrator decisions, never a reflex after a refusal. See `references/environment-variables.md`.

## Main path

```bash
git status --short --branch
pnpm worktree:begin -- --name "<scope goal>"     # fork from freshly fetched upstream; prints the path
cd <printed path>                                 # edit only there
pnpm worktree:end -- --message "type(scope): summary"   # alias of worktree:finish: commit, rebase, push, clean up
pnpm worktree:status                              # list managed worktrees, age, stale-uncommitted markers
pnpm worktree:cleanup                             # removes lifecycle=merged worktrees (not a dry run); -- --reclaim-stale for abandoned ones
pnpm worktree:sync-primary                        # only thing allowed to advance primary's local base branch
```

- `worktree:begin` (alias of `create`) makes `<agent-prefix>/<slug>` under the tool's managed root and records guard
  metadata. Same slug gets `-2`, `-3`. Pass `--base <branch>` when primary is on a shared branch, plus
  `--allow-shared-base` when forking from a branch your team pushes to directly. `--offline` skips the pre-branch fetch.
- A spawned sub-agent's worktree is created by the orchestrator with `--worker`; a worker never adds `--install` or installs dependencies on its own. A fresh worktree without `--install` has no dependencies; a missing-module error there is expected state, not a bug.
- **Branch-context rule**: `begin` defaults the base to the primary worktree's current branch; if that branch is not the one you intend to land on, pass `--base` explicitly instead of guessing, and read cross-session state from an explicit ref, not from primary's working tree (another session may have switched it).
- `worktree:end` commits dirty changes, fetches the base, rebases (a branch carrying its own merge is merged instead), then pushes the worktree's own `HEAD` to `origin/<base>`. A rebase conflict aborts with nothing pushed; a push that never succeeds leaves the worktree intact, so re-run it. Primary is not touched.
- The completion report cites the terminal output of the real `worktree:end` run (command, exit status, pushed SHA, cleanup result). Guard metadata and thread IDs are attribution only, not proof of completion.
- `worktree:end` can queue behind `finish.lock`: run it detached and wait on the log event-driven; do not block a foreground call or hand-roll `sleep` loops. `cd` into your own worktree before finishing.

<!-- BEGIN: claude-only -->
Claude Code: start `worktree:end` with the Bash tool's `run_in_background: true`, redirected to a log, and wait with one `Monitor` until-loop (or the completion notification). A dispatched worker uses `nohup ... & disown` plus one foreground `Monitor` instead.
<!-- END: claude-only -->

<!-- BEGIN: agent-only -->
Codex and other runtimes without `Monitor`: `nohup pnpm worktree:end -- ... > log 2>&1 & disown`, then poll the log in bounded bursts spaced a few minutes apart.
<!-- END: agent-only -->

## Worker takeover

Before takeover, check the worker process tree, background tasks, and its own worktree commits. A lifecycle
`completed` signal or silence is not proof of death. If liveness is unknown, resume or nudge its owner; do
not reuse its writable tree. Once the owner is confirmed gone, create a fresh managed worktree and
cherry-pick recoverable commits. Follow [recovery-notes](references/recovery-notes.md).

## When something goes wrong

| Symptom | Read |
| --- | --- |
| Why worktrees at all | `references/why-worktrees.md` |
| Which `pnpm worktree:*` script does what | `references/command-reference.md` |
| `begin` flags, stale base, `--worker`, `--install`, `--with-deps` | `references/begin-flags.md`, `references/dependency-stamp.md` |
| Personal mirror branches | `references/personal-mirror-branches.md` |
| stash blocked by hook, primary lock, write guard | `references/safety-mechanisms.md` |
| Commit identity rejected | `references/ai-identity.md` |
| Finish semantics, merge-preserving finish, what to report | `references/finish-work.md` |
| Finish queue stuck / dead lock holder | `references/finish-lock-queue.md` |
| Transient fetch/push failures | `references/transient-retry.md` |
| Mass-deletion guard refused the finish | `references/mass-deletion-guard.md` |
| One-sided conflict flags refused | `references/no-one-side-resolution.md` |
| Primary behind origin, `sync-primary` refused | `references/sync-primary.md` |
| Stale or abandoned worktrees, `--reclaim-stale` | `references/status-cleanup.md` |
| What an env var does and who may set it | `references/environment-variables.md` |
| Stalled worker, takeover, rebase recovery | `references/recovery-notes.md` |
