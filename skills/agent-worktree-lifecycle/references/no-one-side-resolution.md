# No one-side conflict resolution

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### No one-side conflict resolution (`-X theirs` / `-X ours` / `-s ours`)

`-X theirs`, `-X ours` and `-s ours` make git pick a side for every conflicting hunk with
nobody looking, so a land "succeeds" while silently reverting someone else's change. The
shared `git()` wrapper (`worktree-core.mjs`) and the reauthor rebase (`git-identity.mjs`)
refuse any `rebase` / `merge` / `cherry-pick` / `pull` / `revert` carrying a strategy option,
including one that arrives through an operator value such as a base ref of `-Xtheirs`
(`forbid-auto-resolve-strategy.mjs`). On a conflict, abort and resolve it by hand; never
work around the refusal.
