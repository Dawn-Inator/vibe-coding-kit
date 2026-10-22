# Git safety mechanisms: stash guard, primary lock, write guard

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Git Safety Mechanisms

`worktree:begin`/`create` installs a per-worktree git `reference-transaction` hook
(`git config --worktree core.hooksPath` pointed at a directory under
`.git/worktrees/<n>/` — never the shared repo config, never inside the working tree
itself). A `reference-transaction` hook fires for every ref update git performs and can
reject the transaction before it completes; every other hook (a pre-commit or
commit-msg hook your project already has) is forwarded through unchanged, not shadowed.
This one hook does two independent jobs.

### Stash guard

`refs/stash` is one ref shared by **every** worktree of a single repository's `.git`.
Running `git stash` in one worktree and `git stash pop` in another is a well-known way
to silently drop or overwrite a different worktree's or a different agent session's
shelved changes — there is no per-worktree stash. Because a dispatch instruction cannot
stop a worker's shell from simply running the command, the hook enforces this at the
git level instead of relying on prose: any ref update inside a managed worktree that
touches `refs/stash` — `push`, `drop`, `store`, `clear`, and the final drop-half of
`pop` — is aborted with `fatal: ref updates aborted by hook`.

Important nuance, confirmed against real git behavior: there is no `pre-stash` hook, and
a shell alias cannot shadow the `stash` builtin, so this can only ever gate the
**ref-update** step, not the command itself. That means `git stash apply` — and
therefore the *merge* half of `git stash pop` — is **never** blocked, because `apply`'s
working-tree merge makes no update to `refs/stash` at all. Only `push`/`drop`/`store`/
`clear` and `pop`'s final drop are actually gated. Treat `apply`/`pop`/`show` as
forbidden in practice inside a managed worktree even though the hook can't stop them —
the only safe read-only ways to inspect the shared stash from inside one are
`git stash list` and `git log -g --format='%H %gs' refs/stash`, neither of which
touches the working tree.

If you hit the blocked message, recover your own changes without stashing:

```bash
git diff > /tmp/patch.diff      # save
git restore <path>              # or: git checkout -- <path>
git apply /tmp/patch.diff       # bring it back later
```

This is a guard against the accidental case, not a sandbox: `git -c core.hooksPath=
stash` still bypasses it, the same as bypassing any other git hook. It also does not
interfere with tooling that legitimately uses a short-lived internal stash of its own
(e.g. a lint-staged partial-commit backup) — such tools should export
`WTG_STASH_GUARD_ALLOW=1` before invoking the real git hook; the reference-transaction
hook trusts that env var. A worker's own interactive `git stash` never has it set.

`pnpm worktree:guard -- stash-audit` (run from inside a worktree) is the fallback
detector for a worktree created before this hook existed, or a deliberate bypass: it
flags any dangling stash-shaped commit object naming a branch other than the current
one, and prints the exact `git stash apply <sha>` recovery command.
`pnpm worktree:guard -- stash-guard` reports whether the hook is currently installed and
intact (read-only, safe anytime); `pnpm worktree:guard -- stash-guard repair`
(re)installs it — idempotent, safe to run as a periodic health check. Both refuse (with
an explanation, not an error) on the primary worktree or a non-managed worktree — the
guard is never installed there by design.

### Primary-worktree lock

The same hook can also install on the **primary** worktree itself
(`pnpm worktree:guard -- primary-lock`; `worktree:begin`/`create` re-installs/repairs it
best-effort every time it touches primary). Installed there, it aborts any ref change —
`checkout`/`switch`/`commit`/`reset`/`merge`/`rebase`, anything that moves `HEAD`,
`refs/heads/*`, or the checkout/rebase bookkeeping refs (`ORIG_HEAD`, `MERGE_HEAD`,
`REBASE_HEAD`, etc.) — whenever the calling process is identified as agent-driven. Two
independent signals decide that:

1. `WTG_WORKTREE_ROLE=worker` is set in the calling process's environment (set
   automatically inside any worktree created with `--worker`).
2. The calling process's own ancestry (walking a small number of parent processes)
   names a known AI coding-agent CLI — this catches an agent session that `cd`s directly
   into the primary worktree's path instead of going through a worker worktree, which
   would otherwise dodge signal 1 entirely.

A plain human shell, IDE, or GUI git client is unaffected either way. Every attempted
ref change on primary — allowed or blocked — is appended to a forensic audit log
(`primary-audit`, readable with `pnpm worktree:guard -- primary-audit`) with a
timestamp, the ref, old→new value, the parent-process chain, and the decision.

Two escape valves exist, both audited, both meant for a human or an orchestrator, never
for a worker deciding on its own that the lock is inconvenient:

- `WTG_PRIMARY_LOCK_BYPASS` — an internal token the guard's own git calls set
  automatically (e.g. inside `sync-primary`'s fetch/merge) once they've already passed
  the script's own safety checks. Not meant to be set by hand.
- `WTG_PRIMARY_LOCK_ALLOW=1 <command>` — the explicit human/orchestrator escape hatch
  for a legitimate one-off git operation on primary run outside the guard script (most
  commonly: restoring a diverted primary back onto its intended branch). This should
  only be set as a deliberate, named decision — never reflexively, just because the tool
  refused a command.

**An agent session's own `git checkout`/`commit`/`reset`/`merge`/`rebase` run directly
against the primary worktree is itself an incident**, whether or not the hook happens to
block it technically. Any AI session — regardless of platform — should treat "switch
branches / commit / merge on the primary worktree" as off-limits, full stop, and use
`worktree:begin`/`worktree:end` for everything that needs a branch.

### Optional: primary write guard

The git-level hooks above only see ref changes, so they cannot stop an agent from
*editing files* in the primary checkout. An optional Claude Code `PreToolUse` hook
(`primary-write-guard-hook.mjs`, wired through `claude-settings-snippet.json`; see
INSTALL) closes that gap: it denies `Edit`/`Write`/`NotebookEdit`/`MultiEdit` whose target
resolves inside the primary checkout. Paths inside any other registered worktree are
never treated as primary, and `primaryWriteGuard.allowPrefixes` (default `.workspace/`)
names the primary-relative scratch areas that stay writable. It fails open on any parse
or resolution error. **Bash writes (`>`, `sed -i`, `tee`) are not inspected** — Bash
stays governed by this skill's rules and the git-level hooks. Treat it as an early,
cheap deny that complements the ref-level lock, not a sandbox.
