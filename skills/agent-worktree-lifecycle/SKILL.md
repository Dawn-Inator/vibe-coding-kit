---
name: agent-worktree-lifecycle
description: Use before creating, editing, finishing, or cleaning managed agent worktrees. Skip read-only tasks and explicit requests to avoid Git writes.
---

# Agent Worktree Lifecycle

Agent-facing entry for projects that manage agent worktrees. The reusable runtime lives in the pinned kit
at `.vibe-coding/kit/src/worktrees/`; invoke its supported CLI through
`node .vibe-coding/kit/cli.mjs worktree ...`. The project owns its adapter, branches, identity, and release
rules. Detail and optional integration recipes are in `references/` (index at the bottom).

## When To Use

- Before any implementation that edits code, docs, tests, config or generated repo artifacts.
- When the user asks to continue a task, create a worktree, finish / submit / merge, clean up a managed
  worktree, or inspect leftover managed worktree state (`claude/*`, `codex/*`, or your project's prefixes).
- Skip for read-only analysis, status queries, and explicit instructions not to create a worktree, commit or merge.

## Red lines

- **Never switch branches, commit, merge or reset in the primary worktree** (the one a human works in). Agent work happens in a managed worktree.
- **Never run `git stash` in a managed worktree** (including `apply` / `pop` / `show`): `refs/stash` is one ref shared by every worktree. Save with `git diff > patch`, discard with `git restore`.
- **Never `rm -rf` a managed worktree**; finish it with the lifecycle CLI or use its `cleanup` command for eligible worktrees.
- **Never push a temporary agent branch**; `finish` pushes to the recorded base and removes the temporary branch.
- **Never resolve conflicts one-sidedly** (`-X theirs`, `-X ours`, `-s ours`) and never `git reset --hard origin/<base>` on a shared branch to "get clean". Abort and resolve by hand.
- **Do not leave finished work unlanded**: use `finish` according to the project's integration policy before reporting a task done.
- **Session closeout checks leftovers**: use `status`, then `cleanup --reclaim-stale --stale-days 14` to inspect candidates. Reclamation is a dry run unless `--apply` is supplied; apply it only when the project authorizes cleanup and the candidates are safe.
- Env-var escape hatches (`WTG_PRIMARY_LOCK_ALLOW`, `WTG_SYNC_PRIMARY_APPROVED_BY`, ...) are deliberate human/orchestrator decisions, never a reflex after a refusal. See `references/environment-variables.md`.

## Main path

```bash
git status --short --branch
node .vibe-coding/kit/cli.mjs worktree begin --name "<scope goal>" # prints the new worktree path
cd <printed path>                                 # edit only there
node .vibe-coding/kit/cli.mjs worktree finish --message "type(scope): summary"
node .vibe-coding/kit/cli.mjs worktree status
node .vibe-coding/kit/cli.mjs worktree cleanup
node .vibe-coding/kit/cli.mjs worktree sync-primary
```

When a `package.json` exists, the initializer adds `worktree:begin`, `worktree:end`, `worktree:status`,
`worktree:cleanup`, and `worktree:sync-primary` package-script aliases. It does not create aliases for the
other commands; use the direct Node invocation above or add project-owned wrappers. Review the project
configuration and adapter before enabling worktree operations.

## Project adapter hooks

The configured project adapter is a project-owned module with named lifecycle hooks; the generated empty
hook map is a valid no-op. Projects may opt into `afterCreate`, `beforeCandidate`, `verifyCandidate`,
`beforePush`, and `afterLand`. A thrown error, `false`, `{ ok: false }`, or `{ skip: true }` rejects that
hook. Failures before a push stop it; `verifyCandidate` and `beforePush` also reject changes to candidate
`HEAD`, working-tree status, or kit pin. `afterCreate` failure leaves the new worktree for inspection.
`afterLand` runs after a successful push, so its failure cannot undo the remote change; the local worktree
and branch are kept for inspection. Enable only the checks your project defines in its adapter module.

- `begin` (alias of `create`) makes a branch and worktree under the configured managed root and records guard
  metadata. Pass `--base <branch>` to choose a base explicitly. `--offline` skips the pre-branch fetch.
- A spawned sub-agent's worktree is created by the orchestrator with `--worker`; a worker never adds `--install` or installs dependencies on its own. A fresh worktree without `--install` has no dependencies; a missing-module error there is expected state, not a bug.
- **Branch-context rule**: `begin` defaults the base to the primary worktree's current branch; if that branch is not the one you intend to land on, pass `--base` explicitly instead of guessing, and read cross-session state from an explicit ref, not from primary's working tree (another session may have switched it).
- `finish` commits dirty changes, fetches the base, rebases (a branch carrying its own merge is merged instead), then pushes the worktree's own `HEAD` to its configured upstream. A rebase conflict aborts with nothing pushed; a push that never succeeds leaves the worktree intact, so re-run it. Primary is not advanced.
- The completion report cites the terminal output of the real `finish` run (command, exit status, pushed SHA, cleanup result). Guard metadata and thread IDs are attribution only, not proof of completion.
- `finish` may wait on its lock: run it detached according to the project's process policy and wait on the log event-driven. `cd` into your own worktree before finishing.

<!-- BEGIN: claude-only -->
Claude Code: start the project's configured finish command with the Bash tool's `run_in_background: true`, redirected to a log, and wait with one `Monitor` until-loop (or the completion notification).
<!-- END: claude-only -->

<!-- BEGIN: agent-only -->
Codex and other runtimes without `Monitor`: run the project's configured finish command detached, redirect output to a log, then poll the log in bounded bursts spaced a few minutes apart.
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
| Which direct CLI command does what | `references/command-reference.md` |
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
