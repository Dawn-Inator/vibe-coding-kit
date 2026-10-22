# Finish-lock queue

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### Finish-lock queue

`worktree:end`/`finish` serializes the fetch → integrate → push sequence through a
`finish.lock` file so two concurrent finishes never corrupt each other's rebase. This
lock has the following properties worth knowing:

- **Dead-holder reclaim.** The lock file records the holding process's pid. A finish
  that died mid-run (killed, crashed, OOM) leaves a lock file whose pid is no longer
  alive; the next finish checks liveness (`process.kill(pid, 0)`) and automatically
  takes over a stale lock, logging that it did so — a crashed finish never blocks every
  future finish forever.
- **FIFO queue, not instant refusal.** A live-held lock does not immediately refuse the
  new finish. Instead the new call registers a ticket (one file per waiter, named so
  that lexicographic sort gives arrival order with no shared counter needed) and blocks
  until it is both head-of-queue and able to take the lock, printing a periodic status
  line (queue position and estimated wait, followed by the holder line below) so a long
  wait is visible rather than silent. `--wait-timeout-min` (default a reasonable number of minutes)
  bounds this; past it, finish gives up with a clear error instead of queueing forever.
  `--no-wait` restores plain instant-refusal behavior for callers that specifically want
  fail-fast-and-retry.
- **Heartbeat and holder line.** While the lock is held, a small background process
  prints a periodic `held by <worktree> for Ns, phase=<...>` line. Waiters also print
  `finish lock held by <worktree> (pid <pid>, phase <phase>) for <duration>`, with the
  phase one of `fetch`, `rebase`, `push`, `cleanup` (read from the lock file, which also
  records `worktree` and `phase`), so a waiter sees what the holder is doing instead of
  guessing whether it is stuck.
- **Signal release.** `SIGINT`/`SIGTERM` while holding releases the lock, stops the
  heartbeat, and exits 130/143; the release is idempotent and never deletes a lock owned
  by another pid. git runs synchronously, so a signal sent only to the node process is
  handled between steps, not mid-command (a terminal Ctrl-C also reaches git itself).
- **Hold timeout.** `queue.maxHoldMs` bounds how long finish may keep the lock. Each
  in-lock fetch/rebase/push gets the *remaining* budget as a hard timeout; once it is
  spent the next step refuses to start, an interrupted rebase is aborted, the lock is
  released, and finish fails saying the hold limit was reached. Raise `maxHoldMs` only for
  steps that are legitimately slow.
- **Extension point for long in-lock checks.** The kit does not kill a long gate running
  inside the lock and re-queue with the original arrival stamp. A project that runs a long
  check inside the lock should run it asynchronously or with its own timeout, or add that
  mechanism; otherwise run long checks before `worktree:end`, outside the lock.
