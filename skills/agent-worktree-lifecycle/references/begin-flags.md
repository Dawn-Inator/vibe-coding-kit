# Begin: flags, base resolution, worker rules

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Begin Work

From the local primary worktree, before editing files, run:

```bash
git status --short --branch
pnpm worktree:begin -- --name "<scope goal>"
```

`worktree:begin` creates a new Git worktree under this tool's managed-worktrees root
(e.g. `~/.agent-client-a/worktrees/` for one agent client, `~/.agent-client-b/worktrees/` for another —
whichever your tool uses), creates a branch named `<agent-prefix>/<slug>` derived from
the current tool and your `--name`, and records guard metadata used later by `finish`.

Before branching, `create`/`begin` fetches the base branch's configured remote upstream
and bases the new worktree on that freshly-fetched remote-tracking ref, not on whatever
the local branch happens to point at — a local `develop` that is hundreds of commits
behind `origin/develop` is a common and easy-to-miss source of a worktree that silently
forks from a stale tip. A fetch failure is loud (the command throws) rather than quietly
falling back, unless you pass `--offline`, in which case it logs a warning and bases the
worktree on the local branch as-is, accepting it may be stale — use `--offline` only when
you know you're deliberately working without network access.

Key flags:

- `--name "<scope goal>"` — required. Used to derive the branch slug.
- `--base <branch>` — pick the branch to fork from. Defaults to the primary worktree's
  current branch. If primary is on a shared branch (see below), pass this explicitly.
- `--allow-shared-base` — required in addition to `--base` when creating from a shared
  branch your team pushes directly to (e.g. `main`/`develop`), so that basing a
  throwaway task branch off a shared branch is always a deliberate choice, not an
  accident.
- `--offline` — skip the pre-branch fetch described above and base directly on the
  local branch, with a warning that it may be stale relative to the remote.
- `--worker` — marks the new worktree as belonging to a spawned sub-agent rather than
  the top-level orchestrating session. This sets `WTG_WORKTREE_ROLE=worker` inside that
  worktree's own git config, which the primary-worktree lock and `sync-primary` both
  check (see below) — a worker worktree can never be used to write to the primary
  worktree, by design.
- `--install` — after checkout, run the project's own dependency-install command. This
  is a single configurable shell command (`postCreateInstallCommand` in the
  worktree-guard config, empty by default) — the kit itself has no opinion on npm vs
  pnpm vs uv vs anything else; fill in your project's own install command there. Without
  `--install`, a freshly created worktree has no installed dependencies at all — a
  missing-module error in a brand-new worktree is expected environment state, not a bug.
- `--with-deps[=<client>|all]` — the one sanctioned dependency step for a **worker**
  worktree in a project with more than one independently-testable client/app (e.g. a web
  client and an admin client with their own `package.json` and test suite). It runs each
  selected client's `installCommand` from `config.clients` (a bare `--with-deps` installs
  only `config.defaultClient`; `--with-deps=<client>` installs one named client;
  `--with-deps=all` installs every registered client). `config.clients` is a documented
  placeholder in the shipped config — a single-app project can leave it as a no-op or
  delete the example entry; a multi-client project registers one entry per client
  (`installCommand`/`testCommand`/`typecheckCommand`) instead of hardcoding client names
  into the CLI. Refused together with `--install`.

After `--with-deps=<client>`, the worker's only sanctioned heavy command for that client
is `pnpm worktree:client-check -- --app <client> [--typecheck] <files...>`, which runs
that client's registered `testCommand` (or `typecheckCommand` with `--typecheck`) against
the given files. It refuses a client not registered in `config.clients` and a worktree
whose deps for that client were never installed — a worktree missing a client's deps is
recreated by the orchestrator with `--with-deps=<client>` (or `=all`), never repaired by
a manual install. Anything heavier (full suites, builds, dev servers, other packages)
stays with the orchestrator; see `agent-orchestration-guardrails` for the exact lane
rules governing what a worker may and may not run.

Rules:

- Creating from a shared branch (`main`, `develop`, or equivalent) always requires
  `--allow-shared-base`.
- If the same slug is already in use, the CLI allocates `<prefix>/<slug>-2`,
  `<prefix>/<slug>-3`, and so on rather than colliding.
- Move into the path printed by `worktree:begin` before editing files. Do not keep
  editing in the primary worktree once a task worktree exists for that task.
- If the user later says to continue a task after its worktree was already cleaned up,
  create a fresh worktree. Do not try to resurrect a deleted one.
- Dependencies are handled by two explicit mechanisms and nothing implicit: `--install`
  (runs `postCreateInstallCommand`) and, when `nodeDeps.lockfile` is configured, the
  dependency-stamp check below. There is no virtualenv sync and no borrowing of another
  worktree's `node_modules` — if a worktree needs more than one shell command to get
  ready, wire that into your own install command or run it by hand after `begin`.
