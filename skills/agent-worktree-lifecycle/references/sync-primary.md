# Sync Primary and idle self-authorization

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Sync Primary

Because default `finish` never advances primary's local base branch, primary falls
behind `origin/<branch>` as other tasks finish directly. `sync-primary` is the only
thing meant to catch it back up — run explicitly from the primary worktree, whenever you
actually need primary's checkout to reflect the latest merged work:

```bash
node .vibe-coding/kit/cli.mjs worktree sync-primary
node .vibe-coding/kit/cli.mjs worktree sync-primary --dry-run
```

It fetches the primary branch's upstream and fast-forwards (`git merge --ff-only`)
primary onto it. Two hard rules, by design:

- **Refuses outright — never stashes — if primary is dirty.** It prints the dirty files
  and stops; commit, stash manually and consciously, or discard first.
- **Never force-updates.** If the fast-forward isn't possible (primary has local commits
  not on the remote, or history diverged), it refuses and reports the failure instead of
  resetting or rebasing primary.
- Must be run from the primary worktree; refuses from anywhere else.
- **A worker must never run this.** It fails closed whenever the invocation looks like a
  worker context — cwd nested under a managed worktree, `WTG_WORKTREE_ROLE=worker` set,
  or (independent of both) the caller being AI-parented (a *top-level* AI-parented session
  may still self-authorize when the repository is idle, see below; a worker never can).
  AI-parented means either signal:
  an AI-CLI **environment marker** (the union of every `tools[*].detectEnv` list, which
  survives any number of wrapper processes) or an **ancestor-process walk of 8 levels**
  naming an AI coding-agent CLI. Together they also catch a worker that `cd`s directly
  into primary's own path to dodge the first two checks. The audit reason records which
  signal fired (`ai-parent=env:<NAME>`, `ancestry`, or `no`). A worker cannot self-approve
  past this; only an orchestrator/human shell exporting
  `WTG_SYNC_PRIMARY_APPROVED_BY=<identity>` overrides it, and every attempt — refused or
  allowed — is written to the same audit log the primary-lock hook uses. Every dispatch
  instruction for a worker should say outright: do not run `node .vibe-coding/kit/cli.mjs worktree sync-primary`.

### Idle self-authorization (default on)

An AI session that is blocked on a human-only environment variable is a design defect: the
orchestrator should not have to stop and ask. So a **top-level** AI-parented caller (not a
worker) that has no approval variable runs an idle scan, and `sync-primary` proceeds only
when nothing else is active. Decision order:

1. `WTG_SYNC_PRIMARY_APPROVED_BY` set: allowed, scan not run (audit `allowed-override`).
2. Worker context (cwd in a managed worktree, or `WTG_WORKTREE_ROLE=worker`): refused outright,
   idle or not, and the scan is never consulted (audit `refused`).
3. Top-level AI-parented caller: scan runs; idle => allowed, busy => refused.
4. Not AI-parented (a human shell): not gated, scan not run.

What the scan checks (every check must be quiet; counts, paths, pids and process names are
printed, never secrets):

- `finish.lock` is not held by a live pid, and `finish.queue` has no live tickets.
- No other AI-tool process (`aiCliExecutableNames`, plus script runtimes launched from an AI
  tool's directory) has its cwd inside the primary checkout or any linked worktree. The
  caller's own process tree (itself and its ancestors) is excluded; a sibling session is not.
- No linked worktree has uncommitted changes (untracked files included) or a commit newer than
  `syncPrimary.idleMinutes`.

The kit keeps no session registry, so there is no "another live session registration" check;
add one if your project has such a registry. The scan **fails closed**: any error while probing
(missing `lsof`, unreadable lock file, git failure, process listing failure, an AI process
whose cwd cannot be read) counts as busy, with the reason named. The worktree probe is the
slow one and is skipped once an earlier check has already found the repository busy.

Audit log (`<git-common-dir>/<primaryAuditLogFilename>`, one JSON object per line) records
`result` as `allowed-ai-idle`, `refused-busy`, `refused` or `allowed-override`, next to
`decision` (`allowed`/`blocked`) and a `reason`.

Turn it off with `{ "syncPrimary": { "idleSelfAuthorize": false } }` in the config override
file: such a caller is then refused and a human must set the approval variable. `idleMinutes`
(default 10) tunes the recent-commit window; set either key alone and the other keeps its
default.
