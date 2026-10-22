# Command reference

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Command Reference

All commands are exposed as `pnpm worktree:*` scripts wrapping one CLI
(`node engineering/automation/agent-worktrees/cli.mjs`):

| Script | CLI subcommand | Purpose |
| --- | --- | --- |
| `pnpm worktree:begin` | `create` | Create a new managed worktree + branch |
| `pnpm worktree:end` | `finish` | Commit, land, and clean up a managed worktree |
| `pnpm worktree:sync-primary` | `sync-primary` | Fast-forward the primary worktree to match its remote |
| `pnpm worktree:status -- [--stale] [--stale-minutes <N>] [--json]` | `status` | List managed worktrees and their state, optionally filtered to stale-uncommitted ones |
| `pnpm worktree:cleanup` | `cleanup` | Remove finished (`lifecycle=merged`) worktrees; `-- --reclaim-stale --stale-days <n>` reclaims abandoned ones (dry run unless `--apply`) |
| `pnpm worktree:deps-sync` | `deps-sync` | Make the current worktree's installed dependencies match its lockfile (needs `nodeDeps` config) |
| `pnpm worktree:client-check -- --app <client> [--typecheck] [files...]` | `client-check` | Run one registered client's test (or `--typecheck`) command against specific files, host-slot-locked (needs that client's deps already installed via `--with-deps`) |
| `pnpm worktree:guard -- stash-audit` | `stash-audit` | Read-only scan for dangling/dropped stash content |
| `pnpm worktree:guard -- stash-guard [status\|repair]` | `stash-guard` | Check or (re)install the stash-block hook on an existing worktree |
| `pnpm worktree:guard -- primary-lock` | `primary-lock` | (Re)install the primary-worktree write lock hook |
| `pnpm worktree:guard -- primary-audit` | `primary-audit` | Read the primary-worktree ref-change audit log |

`pnpm worktree:guard` with no further subcommand is the raw CLI entry point; the other
`worktree:*` scripts are just aliases for specific subcommands (`begin`/`create` and
`end`/`finish` are literal aliases of each other, not separate implementations).
