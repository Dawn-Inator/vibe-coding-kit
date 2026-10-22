# Worker Prompt Requirements And Dispatch Prompt Checklist

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Worker Prompt Requirements

When delegating implementation or workflow worker tasks, explicitly say:

- For a read-only explorer, set `write_scope: none` and prohibit edits, patch application, commits, finish,
  and publishing. A discovered needed change returns as evidence; the orchestrator creates a new
  write-capable task for it.
- **A read-only explorer in a shared/primary worktree must not run any git command that writes the working
  tree, index, or refs** (`checkout`, `reset` in any mode, `stash`, `switch`, `merge`, `pull`, `clean`) —
  `write_scope: none` means no edits *and* no git write commands. `stash` is doubly dangerous in a shared
  worktree since the stash ref is typically shared across every worktree of a repo. Read another commit's
  file with `git show <sha>:<path>`; diff refs directly — never check out a shared worktree.
- No package-level/full test, type-checking, build, e2e, dev server, browser suite, install, or other heavy
  command — locally or via a remote runner. Workers run only the exact focused light check named in their
  task packet.
- Give write-capable workers only a pre-created worker worktree path; workers must not create their own
  worktree with an install flag — missing dependencies are reported, not repaired by installing.
  **Pre-create the worker's worktree with the per-client dependency lane** (`agent-worktree-lifecycle`'s
  `--with-deps=<client>`/`=all` plus a `client-check` command): `--worker --with-deps=<client>`, and name
  the exact verification command in its packet — e.g. `pnpm worktree:client-check -- --app <client> <the
  files you touched>` and `pnpm worktree:client-check -- --app <client> --typecheck` — rather than leaving
  the worker to guess whether it may run its own install/test/typecheck commands. That named command is the
  one sanctioned exception to the heavy-process ban below, not a general license to run other heavy commands.
- **Every worker writes its own temp files (commit messages, logs, monitor output) under its own
  scratchpad subdirectory named after its task/worktree slug — never a bare generic filename at the
  scratchpad root** (`commit-msg.txt`, `worktree-end.log`). Concurrent sibling workers sharing one
  scratchpad root will otherwise collide on the same filename and interleave each other's output. See
  your project's tutorial/incident log for the incident this responds to.
- **Facts a worker reports must come from origin refs or the worker's own worktree, never from the
  primary/shared checkout's working tree** — a primary checkout can be arbitrarily stale relative to
  `origin/<branch>`, and reading facts from it produces wrong premises even when the read itself is
  read-only and otherwise safe.
- **A worker in a worktree with no dependency cache must never symlink in another worktree's dependency
  directory** — a plain symlink can follow through an already-symlinked target and plant a corrupted nested
  entry inside a shared worktree's real dependency tree. Prefer light self-checks needing no installed
  packages, or report the gap. If explicitly authorized to borrow dependencies, use a guarded hardlink copy
  (only if the target doesn't already exist) and self-check the copy before trusting it — an interrupted
  copy, or a virtual environment with baked-in path pins, can look present but be wrong; rebuild such
  environments from scratch instead of copying. Before trusting any non-diff-scoped gate failure
  (repo-wide lint/dead-code count, a global ratchet, an identity-fixture scan), reproduce it on a clean
  checkout of the target branch first — half-copied or foreign-pointing dependency trees produce reds
  unrelated to the actual diff.
- **A worker/subagent must never run shared-resource cleanup commands** (aggressive worktree pruning, a
  package-manager/container-runtime global prune) — such a sweep can't tell an idle worktree from another
  session's active one. Report "short by how much, blocked on what" instead.
- Read/grep/import-target inspection and small file-local checks only; do not revert other workers'
  changes; report changed files and any verification skipped because of the heavy-process guardrail.
- For an isolated-agent-spawn-style worker: one final structured handoff privately to the orchestrator, no
  message to any other task/UI, no intermediate updates; a liveness signal is lifecycle-only; report
  blocked rather than substitute a visible task message if the private final can't be delivered.

## Dispatch Prompt Checklist

The following are worth restating explicitly in every non-trivial dispatch prompt, not something a worker
is expected to already know from having read this skill once.

- **The orchestrator does not hand-patch bugs found during dispatch review, however small** — even a
  discovered one-line fix gets its own worker dispatch with an explicit acceptance oracle (see
  "Orchestrator Does Not Fix Bugs By Hand" below). A finish/merge step that follows must be gated on that
  oracle's actual result, never chained unconditionally.

- **Name the canvas path and the offload directory in every non-trivial dispatch prompt** (see "Context
  Offloading" above), and on a re-dispatch after a dead worker, the same scratch directory plus "read the canvas
  first, then continue".

### Forbidden-tools line every dispatch prompt should carry

State explicitly, in one line, that the worker must never call: a background-task monitor tool it isn't
meant to use; a backgrounding flag on a command it's supposed to run synchronously; a shared-ref stash
command in a managed worktree; an unsupervised spawn/independent-window mechanism or ad-hoc tracking-item
creation (see "Worker channel for out-of-scope findings" above); any command that kills or otherwise
interferes with another session's process; any command that would print raw environment variables or
secrets to output/logs; and any project-specific "skip this safety gate" escape hatch without an explicit,
recorded approval from a human.

- **Workers must never dump a container's or process's whole environment** — `docker exec … env`,
  `printenv`, `docker inspect` env sections, `/proc/*/environ` — even to debug a config problem. Read a
  single key at a time instead (e.g. `docker exec … printenv SOME_KEY`, or `jq -r '.someKey'` on a secrets
  file). A worker leaked two tokens into its own transcript this way by dumping a full container
  environment to find one value.

- **A command that may run past ~2 minutes** (a worktree finish/merge, a remote test run, a full cloud
  suite, a production build) must be started detached and polled, never a single blocking foreground call.
  A remote command with its own internal retry logic should not additionally be wrapped in an outer
  timeout — poll its log the detached way instead. **Polling itself is a round-trip, not a free check** —
  see "Quota-Aware Wake And Review Cadence" above: put the wait/poll loop inside the same backgrounded
  script rather than polling from the caller's own turns, so the whole thing produces one notification when
  it's actually done, not one notification per poll attempt.
- **Commit titles/body lines stay under a fixed, agreed length** (e.g. 100 characters); say so explicitly
  when handing a worker a message file.
- **Hash verification for a landed change must use an ancestor check** (`git merge-base --is-ancestor <sha>
  <branch>`), never a plain hash/prefix compare against a branch tip — a rebase changes the hash while
  carrying the same content forward.
- **Every remote/worktree invocation must put a directory change on the SAME line as the command it
  gates** — many tool runners reset working directory between calls.
- **A shell-variable-driven step must set the variable and invoke the command in the SAME call** — the same
  "state resets between calls" trap; a later call's use of the variable silently evaluates to empty.
- **Before manually re-running a fix-up/regeneration step after a gate failure, check whether your
  project's tooling already auto-detects and retries that failure class** — a manual fix either duplicates
  work the tooling already did, or regenerates against the wrong scope. Fall back to manual only when the
  automatic attempt itself reports failure, or the failure set mixes in a check outside its scope.

### Shared test-host dispatch discipline

If your project has a dedicated remote/cloud test host, restate its lane discipline in every dispatch
prompt: separate "heavy" (frozen-candidate-only, never two at once) and "light" (worker self-verification)
lanes, one remote session per worker at a time, production-like build mode for any UI/locator/shared-asset
change, every test referencing a touched shared asset run remotely (not only the one originally red), and
count in-flight remote-type workers before dispatching a wave that adds another. See your project's
tutorial for the full checklist and the rationale behind each point.

### Red-count discipline: only count real failure line shapes

Pick a small, fixed set of line shapes that genuinely mean "this failed" (a test-runner's own not-ok
marker, a `FAILED ` line, a summary line with non-zero exit) and use only that anchor set — a loose
substring match like grep for "FAIL"/"not ok" everywhere will count a project's own failure-detection
self-test fixtures (deliberately shaped like real failures) as regressions. Classify by which lane/subtest
owns the line first.
