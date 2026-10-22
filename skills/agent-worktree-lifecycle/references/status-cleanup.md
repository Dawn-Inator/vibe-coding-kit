# Status and cleanup, reclaiming stale worktrees

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Status And Cleanup

```bash
pnpm worktree:status
pnpm worktree:status -- --stale
pnpm worktree:status -- --stale --stale-minutes 20
pnpm worktree:status -- --json
pnpm worktree:cleanup
```

`worktree:status` lists every managed worktree with its branch and current state — plain
`status` prints, per worktree, `dirty=<N> files`, `last-activity=<age>`, and
`last-commit-age=<age>`, plus a `STALE-UNCOMMITTED` marker on any worktree that has
uncommitted changes sitting past the staleness threshold (default 20 minutes, override
with `--stale-minutes <N>`). `--stale` filters the listing down to only the flagged
worktrees, which is the quick way to answer "is anything sitting abandoned with
uncommitted work right now" without reading every row. `--json` emits the same data as a
single machine-readable object instead of the formatted table, for a heartbeat or
supervision script that wants to parse it rather than eyeball it.

Plain `worktree:cleanup` removes managed worktrees a finished session marked
`lifecycle=merged` (`git worktree remove`, never forced) — it is **not** a dry run.
It skips any such worktree with real activity (reflog entry or working-tree file) inside the active-recent
window (`reclaim.activeRecentHours`), printing `cleanup-skipped:<path> (active-recent: …)`;
pass `--allow-recent` to override. A normal `worktree:end` removes its own worktree, so
plain cleanup rarely has anything to do.

### Reclaiming abandoned worktrees: `--reclaim-stale`

A session that crashed or switched away leaves a registered worktree that no `end` will
ever finish. Reclaim them explicitly:

```bash
pnpm worktree:cleanup -- --reclaim-stale --stale-days 14            # dry run, lists candidates
pnpm worktree:cleanup -- --reclaim-stale --stale-days 14 --apply    # remove them
```

- `--stale-days <n>` is required on every run (no config can supply an implicit age);
  `--apply` is required to remove anything.
- A worktree is reclaimed only if **all** of these hold, and every blocking reason is
  printed as `reclaim-blocked:<path> (<reasons>) -- left on disk`: it sits under a managed
  worktree root (`--worktree-root <dir>`, the value `begin` got, or the tool's default
  home); it is neither primary nor the caller's own; its branch has a managed prefix (or
  is detached) with `managed=true` metadata and a branch-name base; it is clean including
  untracked files; it has been idle at least `<n>` days; no **real activity** falls inside
  `reclaim.activeRecentHours` (the **active-recent floor**, override with `--allow-recent`).
  Real activity is the last HEAD or branch reflog entry (a commit, checkout, reset or
  rebase) or a working-tree file mtime. Admin-dir, `index`, `HEAD`, `FETCH_HEAD`,
  `ORIG_HEAD` and `config.worktree` mtimes do **not** count: read-only commands such as
  `git status` and `git fetch` touch them, and counting them once made every landed, clean
  worktree look freshly modified so nothing was ever reclaimable; no process has it as cwd and no live finish-queue ticket names it;
  and its `HEAD` has **landed** on one deterministic base ref (`<remote>/<base>` if it
  exists, else the local base).
- **Landed** means ancestry first, then `git patch-id --stable` equivalence: every commit
  unique to `HEAD` must have its patch-id among the commits that landed on the base
  (this recognizes cherry-picked and rebased work; a branch squashed into one commit
  counts when the net diff matches). A merge commit unique to `HEAD` blocks. The output
  names unmatched commits. `--no-patch-id` restricts the check to ancestry. Patch-id
  matching can take minutes on a large or force-pushed base, so one pass spends at most
  `reclaim.patchIdBudgetSeconds` (default 120) on it; after that, worktrees only patch-id
  could prove landed are kept and the run says to rerun.
- A live `finish.lock` never makes the run skip (back-to-back finishes would starve
  cleanup forever). The dry run classifies anyway and says its verdict is advisory.
  `--apply` queues for `finish.lock` through the same FIFO tickets a finish uses and
  removes only while holding it. Under the lock it re-checks only the cheap facts that can
  change after classification (the tip did not move, the tree is still clean, no live
  finish ticket names it) and skips anything that changed as
  `reclaim-skipped-under-lock:<path> (<reason>)`. It holds the lock at most
  `reclaim.lockHoldSeconds` (default 20) per turn, then releases it and queues again, so a
  long reclaim never blocks a waiting finish for minutes.
- Apply uses plain `git worktree remove` (never `--force`) and deletes the local branch
  only when it has a managed prefix and landing was verified. Before removing, it gives
  `u+rwx` back to read-only directories **inside that one candidate** (a killed test run
  can leave 0555 trees behind); it never follows symlinks or touches another uid's
  directories. Exit is non-zero if anything was blocked or failed.

**Cleanup is an orchestrator/main-session action, not a worker action.** It sweeps
shared worktree state across every managed worktree, not just the caller's own, and
cannot by itself distinguish an idle worktree from another session's active one beyond
the active-recent floor. Confirm with `worktree:status` first, or check with the team,
before running it (or `--reclaim-stale --apply`) while other sessions might be active.

Never remove a git worktree with `rm -rf`. Use `pnpm worktree:end`/`worktree:finish` for
a worktree you're done with, or `pnpm worktree:cleanup` for ones already finished
(`--reclaim-stale` for abandoned ones); use plain `git worktree remove <path>` only for a
manual, non-guard-managed worktree.
