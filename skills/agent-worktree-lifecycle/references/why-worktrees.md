# Why isolate agent work in worktrees

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Why isolate agent work in worktrees

An AI coding agent editing files directly in the repository's one checked-out working
tree (the "primary worktree") is dangerous the moment more than one agent, or one agent
and one human, might touch the repo at the same time: a `git checkout` from one session
changes what every other session sees on disk, a `git stash` from one session can
silently swallow another session's shelved changes (because `git stash` is backed by a
single ref shared across every worktree of one repository), and a half-finished edit from
one task can get committed by another task's cleanup step.

A **git worktree** is a second working directory backed by the same `.git` object
database — a full separate checkout on its own branch, isolated at the filesystem level,
but still sharing history, remotes, and a handful of repo-wide refs (`refs/stash` chief
among them) with every other worktree of the same repo. Giving each agent task its own
worktree means:

- Concurrent tasks never collide on file contents — each has its own working directory.
- The primary worktree (the one a human normally works in) stays untouched by agent
  tasks by default — no surprise branch switches, no surprise stashes.
- A task's work is disposable until it is deliberately finished: if a task goes wrong,
  its worktree can be discarded without touching anything else.
- Commits made by an agent can be tagged with a distinct identity, so they're never
  mistaken for — or accidentally committed as — a real person.

The public worktree CLI (invoked through `node .vibe-coding/kit/cli.mjs worktree ...`) automates
creating, finishing, and cleaning up these task-scoped worktrees, and installs git-level
guardrails so that the isolation these worktrees are supposed to provide can't be
accidentally defeated by an ordinary git command run in the wrong place.
