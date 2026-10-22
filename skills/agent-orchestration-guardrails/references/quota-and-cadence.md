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
workflow and the merged wake cycle; this section states the caps and rationale the orchestrator applies
while running it. See your project's tutorial for the incident that motivated it.

- **One merged wake cycle handles both jobs — don't run a separate always-fire backstop timer and a
  separate notification-batching window.** Every dispatch/landing/background-shell notification since the
  last cycle is accumulated with zero tool calls; the cycle itself (see `agent-task-supervision`'s wake
  registration) both guarantees a check-in during a quiet stretch and processes whatever accumulated,
  combining the resulting dispatches into a single tool batch. **An `audit` line is never printed
  synchronously at the moment of a dispatch or a landing — it is printed only at the next merged wake cycle
  pass, and only when that pass actually has something to report** (a new dispatch, a landing/finish, a
  direction switch, an overreach finding since the last printed line); a pass with nothing new to report
  prints nothing. **A new message from the human is never accumulated into this cycle** — it is answered
  immediately, on its own turn, regardless of where the cycle currently stands.
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
- **Worker dispatch has a granularity floor — don't split what could be one notification into several.**
  A day with 80 worker landings is 80 wake-and-re-read cycles regardless of how cheap the merged-cycle
  batching makes any single one of them. Small packages with non-overlapping write sets but the same
  feature line must be merged into one dispatch, not fanned out separately — a concrete floor: **if a
  package's expected runtime is under ~15 minutes AND it shares a feature line or write set with another
  pending package, merge them into one dispatch rather than dispatching separately.** The one exception is
  when the packages genuinely need to run in parallel to occupy different scarce resources (a physical
  board, a phone, a server) at the same time — that parallelism has its own payoff independent of
  notification count. **The floor merges only items that share both the write set and the same blocking
  dependency** — sharing a feature line alone is not enough. Items on one feature line with different
  dependencies (a different host, a different upstream deploy, a different scarce resource) stay separate
  dispatches even when small, so an unblocked item is never folded into a package whose tightest sibling
  dependency then blocks all of it. See project incident record for a worked counter-example.
- **Never call `date` just to stamp a status line.** Use a timestamp already present in tool output or a
  notification; omit the time field if none exists.
- **Cadence caps**: centralized verification at most once per hour or once per 3 landings; opus/independent
  review once per feature line plus one re-review (accumulate later minor findings into that re-review);
  temporary status batches (heartbeat category 3) at most hourly.

See `agent-task-supervision`'s "Measured timestamps," "Status line," and "Cadence caps" sections for the
full mechanics these caps apply to.

## Review Fan-Out: Scope Reviews To Four Categories, Falsify Only Blocking/Major

Independent review/falsification fan-out is valuable but not free, and its cost does not scale linearly
with the value it returns — most of the value concentrates in a small number of genuinely load-bearing
findings.

- **Scope review budget to four categories**: money/billing paths, security boundaries, SQL that has never
  been executed against a real database, and interactions only verifiable on a real device or a real
  browser. Reviewing everything else at the same depth mostly produces noise rather than catching real
  defects.
- **The reviewer self-rates severity (blocking / major / minor) before anything else happens.** Only a
  self-rated **blocking** or **major** finding gets its own independent falsifier worker. A **minor**
  finding goes straight into the findings list marked "unfalsified" — falsifying every minor finding
  individually burns the same independent-worker budget a blocking finding needs, for a finding that, even
  if wrong, costs little to leave unconfirmed.
- **A reviewer must read the pushed candidate** (`origin/<branch>` or the equivalent up-to-date ref), never
  a possibly-stale primary/shared worktree — a stale read can report a false failure that doesn't exist on
  the real candidate, wasting a round of investigation chasing a phantom.
- **State your project's standing "not a defect" conventions explicitly in the review dispatch prompt.**
  Without them, a reviewer surfaces a pile of generic hardening suggestions the project has already decided
  against, diluting the small number of findings that actually matter.

See your project's tutorial for a worked example of the token/finding-yield tradeoff this scoping is based on.
