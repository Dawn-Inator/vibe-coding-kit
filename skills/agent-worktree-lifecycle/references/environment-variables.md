# Environment variables

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Environment Variables

| Variable | Purpose | Who should set it |
| --- | --- | --- |
| `WTG_STASH_GUARD_ALLOW` | Lets a legitimate tool's own short-lived internal stash bypass the stash-block hook | Exported automatically by trusted tooling around its own internal stash use — never by a worker's interactive shell |
| `WTG_PRIMARY_LOCK_BYPASS` | Internal token the guard's own git calls set once they've already passed its safety checks | Set automatically by the guard CLI itself — not meant for manual use |
| `WTG_PRIMARY_LOCK_ALLOW` | Escape hatch to run a git command directly against the primary worktree despite the lock | An explicit human/orchestrator decision only, never a worker's own judgment call — typically used to restore a diverted primary back onto its intended branch |
| `WTG_WORKTREE_ROLE` | Marks the current worktree as belonging to a spawned worker | Set automatically by `worktree:begin --worker`; do not set by hand to work around a guard check |
| `WTG_CONFIG_PATH` | Path to a JSON file whose top-level keys override the shipped config (a key replaces the default as a whole) | Project setup or tests; not a runtime guard bypass |
| `WTG_SYNC_PRIMARY_APPROVED_BY` | Approves a worker-context (or agent-ancestry) invocation of `sync-primary`, skipping the idle scan | An explicit human/orchestrator decision only, made in their own shell for that specific invocation — never exported by the invocation it's approving. A top-level AI session that finds the repository idle does not need it (see Idle self-authorization) |

None of these should be set reflexively because a command refused you. Each one is a
deliberate, named, human-or-orchestrator decision for one specific action — not a
generic "try again with the guard disabled" switch.
