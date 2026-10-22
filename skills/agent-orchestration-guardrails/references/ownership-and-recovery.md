# Cross-Session Ownership And Process-Exit Recovery

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Shared directory is not an isolated worktree

`collaboration.spawn_agent` shares cwd; it does not provision a Git worktree. Before any writable dispatch,
record each worker's absolute checkout and exact owned files in the task packet. Either use separate
pre-created managed worktrees, or disjoint file write sets in a managed checkout. A reference/fork/context
option isolates conversation state only. In a shared managed checkout the orchestrator alone stages,
commits, rebases and finishes; workers return disjoint patches and never mutate the common Git index or
refs. Use independent worktrees when workers need their own commits. Neither arrangement grants permission to revert other workers,
write into primary, finish their tree, or clean shared resources.

## Check liveness before takeover

A missing message, silence, or `completed` activity flag is not proof the worker is dead. A final saying
"waiting for background/Monitor notification" can still have a live child finishing the operation.

1. Inspect the worker's process tree and outstanding background tasks using the current host's supported
   lifecycle tools. Read its own worktree `git status` and `git log`, not primary's working tree.
2. If the worker or its children are alive, or liveness is unknown, nudge/resume that owner. Do not edit,
   remove, finish or reassign its write set while it can still be writing.
3. Only after the owner and its writers are confirmed gone, create a fresh managed worktree and
   cherry-pick the recoverable commits; inspect uncommitted changes without overwriting the old tree.
   Re-run the acceptance oracle on the recovered candidate SHA. A stale result is not fresh evidence.

## Cross-Session / Cross-Platform Ownership

If more than one AI session or platform can operate on the same shared environment, branch, or
machine/identity chain, environment and branch ownership should be single-assignee, not advisory — record
a clear table somewhere always-loaded and treat it the same way as any other project hard rule. This is
distinct from the single-worktree rules above: those guard one AI's own worktree boundary; this guards the
boundary **between two AI sessions/platforms** operating on the same host, branch, or identity chain at
once.

- **Before touching a resource assigned to another session/platform**: don't. Not even when it looks
  stalled, silent, or wrong.
- **Blocked because the needed resource is in the other session's domain → hand off evidence, never take
  over.** A handoff packet should name: the relevant commit/candidate identifier, the receipt/evidence of
  what was observed, where the full log lives, and the state/phase observed. Leave it for the owning
  session or the human to act on.
- **One operator per machine/identity chain at a time.** Stop and hand off instead of racing a concurrent
  operational command against the same resource.
- **Only an explicit statement from the human overseeing the work changes the assignment.** "The other
  session looks quiet" or "it's probably done" are not evidence of a handoff — silence is not a signal.

See your project's tutorial for the incident that motivated this section.

## Orchestrator Process-Exit Recovery For In-Flight Workers

A worktree-lifecycle skill's liveness-check procedure, if your project has one, judges whether a *worker*
is actually dead before another session takes over its worktree. It does not by itself cover the case
where the **orchestrating process itself** exits or restarts mid-session while workers are still in
flight — a worker-liveness check alone gives a restarted session no way to even find the worker to judge:
you cannot check whether something is alive if you no longer know it exists. See your project's tutorial
for the incident that motivated this section.

Recovery needs a trail on **both** sides, not only the worker's:

1. **Workers commit at every deliverable sub-step, not only at the end** — the same discipline "For any
   large rewrite/cleanup shard, require commit once per file as it turns green" already asks for, generalized
   to every dispatched worker. A dead worker's real progress must be recoverable from `git log` on its own
   worktree even when the worker's own process is gone.
2. **The orchestrator keeps a running registry of in-flight workers** — reuse whatever transient/backlog
   tracking convention your project already has (do not invent a second storage location); one line per
   worker naming its worktree path and expected deliverable, updated as workers are dispatched and land.
3. **On restart, check that registry entry-by-entry against each worktree's actual `git log`/state**
   before deciding to resume, re-dispatch, or take over — the same judgment a liveness check already
   applies to a single worker, extended to "the orchestrator resuming from its own restart must re-derive
   its worker roster from disk, not from memory it no longer has."

See your project's tutorial for the incident that motivated this section.
