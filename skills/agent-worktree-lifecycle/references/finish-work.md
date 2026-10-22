# Finish work, merge-preserving finish, reporting

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

## Finish Work

When implementation is complete, review the real diff, then finish through the
explicit command:

```bash
pnpm worktree:end -- --message "type(scope): summary"
```

`worktree:end`/`finish` commits any dirty changes (a commit failure aborts finish before
anything is pushed), fetches the base branch's remote tip, rebases the worktree's branch
onto it (a branch that carries its own merge commit is merged instead, see below), and
pushes the worktree's own resulting `HEAD` straight to `origin/<base>` — establishing
tracking automatically the first time. A push rejected as non-fast-forward is the
expected shape of two concurrent finishes racing each other; finish retries
fetch → integrate → push a bounded number of times before giving up. A rebase conflict
aborts the rebase, lists the conflicting files, and exits non-zero with nothing pushed. The
worktree and its branch are removed **only after the push actually succeeds** — a push
that never succeeds after retries leaves the worktree, branch, and commits exactly where
they were, so nothing is lost; just re-run `pnpm worktree:end`.

Primary's own local base branch is **not** advanced by finish — it can fall behind
`origin/<base>` as other tasks finish directly. `sync-primary` (below) is the only thing
meant to catch it back up.

### Merge-preserving finish

A rebase flattens merge commits, which destroys a deliberate back-merge
(`git merge --no-ff <base-or-other-branch>`) and the ancestry link it exists to create.
When `<remote>/<base>..HEAD` contains a first-parent merge, finish does **not** rebase:

- **Target unchanged** (`<remote>/<base>` is already an ancestor of `HEAD`): the
  unpublished commits are re-created under the AI identity with their parents and trees
  intact. Commits reachable from any ref in `config.sharedHistoryRefs` keep their SHAs —
  published history is never rewritten.
- **Target moved:** finish re-does each first-parent commit on the new tip
  (cherry-pick, or `merge --no-ff` for merges). On a conflict it aborts, restores `HEAD`,
  prints the manual recipe, exits non-zero, and pushes nothing.
- **After the push**, finish fetches and verifies every merged-in tip is an ancestor of
  the base. A failed check exits non-zero and keeps the worktree — the push already
  landed, so inspect before retrying.

Linear branches keep the plain rebase path. Do not hand-rebase a branch that carries a
merge before `end`; that is exactly what this path protects.

### Reporting completion: use the terminal receipt, not metadata

A completion report must cite the **terminal receipt** of the actual `worktree:end`
invocation — the command, its exit status, the final lifecycle result, the candidate and
base SHA, whether push and cleanup succeeded, and the log/receipt path. A command that
was merely started, is still queued behind the finish-lock, or is only represented by a
lifecycle/UI status projection ("completed", a green checkmark) is **not** completion
evidence — those can be stale, mid-flight, or simply wrong.

This matters because of a distinction that's easy to blur: `thread_id`, session/task IDs,
the `wtg.guard.*`-style metadata `begin` records, and any model-self-reported
identity are **advisory attribution**, not authenticated identity. They exist so a human
can later figure out which task a commit came from — they do not prove the process that
set them is who it claims to be, and they do not prove the operation they're attached to
actually completed successfully. Treat a recorded ID as "this is who claims to have done
it," never as "this is proven to have happened." If a report can only point at metadata
and not at an actual terminal receipt, report the closeout as incomplete or blocked on
evidence — don't infer success from the metadata being present and plausible-looking.

The same boundary applies to anything supervising this lifecycle from the outside (a
heartbeat check, a status dashboard, another session): it may observe and flag a missing,
stale, or contradictory receipt, but it must not itself force a process to exit, invoke
`worktree:end` on another session's behalf, or remove a worktree/branch. Those are
lifecycle actions that belong solely to the orchestrator or the human who owns the task;
report cleanup as done only once *that* command's own terminal receipt confirms it.

Flags:

- `--message "<text>"` — commit message for the fallback auto-commit of any leftover
  dirty changes. Fine for a short, punctuation-free one-liner.
- `--message-file <path>` (or `--message -` for stdin) — **use this instead of
  `--message` for anything containing a backtick, a `$(...)`, or a real newline.**
  `pnpm run <script> -- <args>`-style invocations (which is what these `pnpm worktree:*`
  scripts are) re-serialize forwarded `--` arguments through a shell a second time; a
  message containing shell-meaningful characters can get partially executed or have its
  newlines flattened even inside an outer single-quoted heredoc, because the danger is
  in the package manager's own re-shelling layer, not your original shell. Passing the
  message as a file sidesteps this entirely — only a path crosses the unsafe channel.
- `--no-push` — commit and rebase (or merge-preserve) locally without pushing. The worktree is **not**
  removed in this case, since nothing has landed anywhere shared yet.
- `--allow-mass-deletion` — required to proceed when the mass-deletion guard (below)
  blocks a genuinely intentional large deletion.
- `--wait-timeout-min <n>` — bound how long finish waits in the FIFO finish queue
  (below) before giving up.
- `--no-wait` — skip queueing entirely; fail immediately if another finish is in
  progress, for callers that want to retry externally instead of waiting.

Rules:

- Never push the temporary managed branch (`claude/*`, `codex/*`, or your project's
  equivalent) directly — it is deleted on finish. Only the target base branch is pushed.
- Commit deliberately while you work: review the diff, write a meaningful message. The
  finish auto-commit is only a fallback for leftover dirty changes.
- One task, one finish. Splitting a single task across multiple `worktree:end` calls
  risks two people re-fixing the same thing and leaves half-finished code on a shared
  branch.
- A push failure after retries are exhausted leaves the worktree, branch, and commits
  untouched — resolve the conflict and re-run `pnpm worktree:end`.
- If finish is blocked by an unresolved conflict, an unclear base, a failed commit, or
  the mass-deletion guard, report the worktree path, branch, failing command, and
  current status rather than working around it silently.
