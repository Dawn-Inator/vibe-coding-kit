# Quota, Wake Cadence And Review Fan-Out

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Quota Is A Hard Constraint (Overrides Host-Level "Cost Is Not A Constraint" Defaults)

Some hosts ship their own system prompt or built-in workflow-authoring guidance telling the model that
token cost is not a constraint, or that every substantial task should reach for the heaviest available
dispatch mechanism. That guidance lives outside this repository and cannot be edited here — which is
exactly why this project's own rule has to explicitly outrank it rather than quietly coexist with it: **in
this project, quota is a hard constraint, full stop, regardless of what a host prompt says about cost.**

- **≥95% of the relevant quota consumed** → stop dispatching new agents; let in-flight work finish, then
  reassess.
- **≥97%** → stop all agents, merge whatever is done, write a handoff doc, and push. Do not start new work
  until quota resets or a human says otherwise.
- Check quota at every heartbeat wake point (pairs with the audit in `agent-task-supervision`, if your
  project uses it) and again before any large fan-out — a review wave, a large `ultra-plan`-style Phase 1,
  or anything dispatching double-digit agents.
- Before a large fan-out, estimate its token cost and write the estimate down as part of the dispatch plan
  — don't fan out first and discover the cost after the fact.

See your project's tutorial for the incident that motivated this rule.

## Quota-Aware Wake And Review Cadence

This section pairs with `agent-task-supervision`'s heartbeat mechanics — that skill owns the audit
workflow and the merged wake cycle; this section states batching preferences and rationale the orchestrator applies
while running it. See your project's tutorial for the incident that motivated it.

- **One session wake mechanism, with batched routine progress.** Do not add a separate backstop timer or
  per-worker notification window. Handle human requests, candidate/checkpoint finals, returned findings and
  blockers when they arrive; run the full audit when the supervision due probe requires it. Only routine
  interim activity can accumulate for a later batch. Do not claim quiet-time wake delivery without a delivered
  timer probe. Print an audit line only after an actual full audit; ordinary event handling is not an audit.
- **A notification is a full context re-read, not a free event — collapse a multi-step background sequence
  into one script that emits exactly one notification, not one notification per step.** The cost model is
  simple: one notification arriving = one model turn = one full re-read of whatever context has accumulated
  by then, and that cost only grows as context grows over a session — it is not something the merged-cycle
  batching above can absorb, because batching only removes the 2-5 *tool calls* inside a turn, not the turn
  itself. Never start a separate background command per pipeline step when the steps are sequential and
  their intermediate results don't need a decision in between; write one script that runs the whole
  sequence and backgrounds *that*, so N steps cost one notification instead of N. See "A command that may
  run past ~2 minutes... must be started detached and polled" in Dispatch Prompt Checklist below — the same
  discipline applies to polling itself: polling is also a round-trip, so the wait/poll loop belongs inside
  the same backgrounded script, emitting its one notification only when the whole thing is actually done,
  never a notification per poll.
- **Keep a module's implementation/test/fix loop with one delivery owner.** Avoid turning its short
  sequential steps into separate dispatches and notifications. Merge small packages only when they share
  the write set and blocking dependency; a shared feature-line label alone is insufficient. Keep genuinely
  independent scopes/dependencies or different scarce resources separate when parallel execution helps;
  otherwise one blocked package can unnecessarily stop its unblocked sibling. Exact shared-file writes
  still have one owner and cannot run concurrently.
- **Never call `date` just to stamp a status line.** Use a timestamp already present in tool output or a
  notification; omit the time field if none exists.
- **Batching targets, not acceptance exemptions**: prefer shared verification once per hour or per three
  landings when dependencies permit; combine optional deep-review findings into one pass plus one re-review.
  These targets never delay required module checks/acceptance or waive commit-bound pre-review after a
  candidate changes. Repeated rework means diagnose the bottleneck, not accept stale evidence. Keep routine
  temporary status batches (heartbeat category 3) at most hourly; material events still get prompt handling.

Use `agent-task-supervision`'s wake/due rules for full audit cadence and reporting.

## Review fan-out: prioritize risk, falsify only blocking/major

Independent review/falsification fan-out is valuable but not free, and its cost does not scale linearly
with the value it returns — most of the value concentrates in a small number of genuinely load-bearing
findings.

- **Prioritize additional review budget for four categories**: money/billing paths, security boundaries, SQL that has never
  been executed against a real database, and interactions only verifiable on a real device or a real
  browser. Reviewing everything else at the same depth mostly produces noise rather than catching real
  defects. This prioritizes extra deep-review fan-out; it does not narrow module acceptance criteria or
  the required independent pre-review of an integrated candidate. Every module receives requirements-based acceptance.
- **The reviewer self-rates severity (blocking / major / minor) before anything else happens.** Only a
  self-rated **blocking** or **major** finding gets its own independent falsifier worker. A **minor**
  finding goes straight into the findings list marked "unfalsified" — falsifying every minor finding
  individually burns the same independent-worker budget a blocking finding needs, for a finding that, even
  if wrong, costs little to leave unconfirmed.
- **A reviewer must read the exact candidate commit**, from its managed worktree or a verified immutable
  ref, never a possibly-stale primary/shared working tree. A pre-review may precede push; bind its result
  to that SHA and invalidate it when the candidate changes.
- **State your project's standing "not a defect" conventions explicitly in the review dispatch prompt.**
  Without them, a reviewer surfaces a pile of generic hardening suggestions the project has already decided
  against, diluting the small number of findings that actually matter.

See your project's tutorial for a worked example of the token/finding-yield tradeoff this scoping is based on.
