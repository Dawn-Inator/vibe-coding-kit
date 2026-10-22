# Optional: per-developer personal mirror branches

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### Optional: per-developer personal mirror branches

This whole skill isolates AI *sessions* from each other — it says nothing about isolating
one human's work-in-progress from another's. If more than one person pushes to the same
shared branch (`develop`, `staging`, ...), consider adopting a **personal mirror branch**
per person (e.g. `<name>/develop`), so each person's day-to-day work lands on their own
branch first, and syncing into the shared branch is a separate, deliberate action they
trigger themselves — not something a solo project needs, but worth knowing before you
assume "everyone just pushes to `develop`" scales past one person.

If your project adopts this pattern, resolve `--base` from **what the primary worktree is
currently checked out to**, not a hardcoded assumption:

| Primary is currently on | `--base` for a new worktree | `finish` target |
| --- | --- | --- |
| A shared branch (e.g. `develop`) | That shared branch, with `--allow-shared-base` | Same shared branch |
| A personal mirror branch (e.g. `<name>/develop`) | That personal branch | Same personal branch |

Syncing a personal branch's accumulated work into the shared branch is a distinct, manual
step the person themselves decides to trigger — never fold it into an ordinary `finish`,
since only that person can judge whether their current work is actually ready for others
to see. See [tutorial/04-gate-and-release/personal-branches.md](../../../tutorial/04-gate-and-release/personal-branches.md)
for the full reasoning.
