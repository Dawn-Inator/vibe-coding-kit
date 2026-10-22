# AI commit identity

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## AI Commit Identity

Every commit `worktree:end`/`worktree:begin` produces is authored as a single,
configured, non-human identity (e.g. `AI Bot <ai-bot@example.com>` — configure
your own in the worktree-guard config), never your local git config. This is enforced in
three layers so that neither a stray local override nor a hand-typed commit inside a
managed worktree can accidentally land as a real person or as an unrelated fixture
identity:

1. **Worktree-level default identity injection.** `worktree:begin`/`create` sets
   `--worktree`-scoped `user.name`/`user.email` (never the shared repo config) to the
   configured AI identity inside the new worktree only. Primary's own identity is never
   touched by this step.
2. **Reauthoring after rebase.** `worktree:end`/`finish` rebases (or, for a branch
   carrying a merge, merge-preserves — see Finish Work) the worktree's branch
   onto the fetched base before pushing. Immediately before push, any commit on that
   branch that is not already authored under the configured AI identity — including one
   a worker typed by hand with `git commit` — is reauthored to it, so the identity
   guarantee holds even when a commit didn't go through the guard's own commit step.
3. **Fail-closed detection of human/fixture identities.** Before `begin`/`end`, the
   guard checks the **shared** repo config (`.git/config`, not `--worktree`-scoped) for
   any local `user.name`/`user.email` override — because a plain (non-`--worktree`)
   `git config user.*` run inside *any* worktree writes into that one shared file,
   silently overwriting what every other worktree of the repo sees, primary included.
   If the shared config carries such an override — a known human name, a known test
   fixture identity, or even the AI identity itself set the wrong way — `begin`/`end`
   refuse rather than silently honoring or overwriting it. Configure the set of
   known human/fixture identity shapes this should catch for your own project.
