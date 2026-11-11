---
name: agent-task-supervision
description: Use for long-running autonomous or multi-agent work that needs a recurring coordination audit, and whenever an active heartbeat ledger must be maintained.
---

# Agent task supervision

This shared policy coordinates work; it does not grant authority. It does not authorize restricted actions,
finish or merge work, archive sessions, delete branches or worktrees, kill or restart workers, or veto a
session finish. A project adapter may expose read-only probes and project-approved command strings. Those
commands change how a probe is invoked, never what the audit must cover or what the orchestrator is allowed
to do. Follow the repository and current-turn authorization rules for every action.

## When to activate

Register a heartbeat if either condition holds: (A) at least three agents are active and expected work exceeds
two hours, or (B) one agent is working autonomously and the session has run or is expected to run over two
hours, including overnight or unattended work. A project may opt into task intake for shorter tasks without
arming a timer. Do not create cron, launchd, daemon, or a separate supervisor agent.

## Developer request intake

When supervision is active, record each actionable developer request or material change in the session's
existing `## Items` registry immediately on receipt, before unrelated work or the next timer wake. Update a row
for a correction; add a row for distinct work. Preserve request scope, constraints, and completion evidence.
Do not turn a question, status request, or acknowledgement into a task. After the write succeeds, tell the
developer in that turn that the item was added or updated; if it fails, say so and why. This bookkeeping does
not grant permission for restricted actions.

## Wake mechanism

Use the host's supported periodic/scheduled capability at a default 20-minute cadence. First send a short
delivery probe (1–3 minutes), yield, and trust the mechanism only after the probe arrives. If it does not arrive
within about twice its delay, remove that probe, record the failure, and try an available fallback. If no timer
delivers, use event-anchored self-checks at least one interval apart. The configured adapter may provide
project-specific command strings for `arm`, `check`, `sweep`, `inflight`, and `branches`; it must not alter
these audit obligations. The Kit arm template accepts a `--commands '<JSON object>'` option for those keys;
values are command strings and can use `{ledger}`, `{minutes}`, or `{interval}` placeholders. A project may
replace invocation strings, but cannot remove or weaken a shared audit step.

At every delivered timer wake, re-arm first, then audit. The timer firing is a wake and must lead to a fresh
audit. Other turns and notifications are handled for their event: ingest a worker result, landing, or blocker
and run relevant discovery immediately; otherwise respond normally without pretending a full heartbeat ran.
A worker's interim notification that it is still running needs no substantive reply. A separate one-shot waiter
does not replace or swallow the recurring heartbeat.

## Required audit

At every timer wake, the orchestrator itself must:

1. Confirm one heartbeat is armed, and check host load or quota only against thresholds configured for the
   project. Do not invent thresholds.
2. Count actual active workers using the configured in-flight probe, not ledger row count. Review every worker
   event since the prior wake. Distinguish a request accepted by a tool from work that is active, a terminal
   report, and work landed on its target. A worker that reported interim progress but has no live child or
   session is stale: record the evidence and re-split or report a blocker. A delay beyond twice the expected
   duration or repeating the same step three times is a circuit-breaker signal to record and escalate.
3. Run configured discovery and branch/session probes. Ingest each newly found task in `## Items` and check
   each listed owner against current evidence. Probes are evidence sources only. Do not kill, restart, finish,
   merge, archive, clean, or delete based on this shared policy.
4. Audit the complete backlog with the [backlog audit](references/backlog-audit.md). Decompose every current
   non-done item into a concrete next step. If the active worker count is below the free independent work units,
   dispatch the free units during this wake; do not wait to be asked. Give each unit a clear owner, repository,
   worktree, mode, and exact relative file write set. Re-split idle, stale, or newly blocked work when its
   current decomposition no longer holds.
5. Check direction against known project signals and record the evidence. An unsubstantiated impression is
   not a signal.
6. Record actual countable progress and blockers. Do not use subjective percentages. A ratio is acceptable
   only when both counts and the counted scope are stated.

## Ledger contract

Keep the ten existing category rows and their `sources:` evidence line. Each new wake section must use the
latest heading marker `contract: heartbeat/v2`; retain older wake bytes as historical records. Do not rewrite
the file. The current `## Items` table keeps its existing `id | source | item | status | evidence` fields and
adds, in order, `owner | repository | worktree | mode | write_set | dispatch_ref`.

Each dispatched row must identify `mode` as `write` or `read-only`, an explicit repository and worktree, and
`write_set` as a JSON array of exact relative file paths. Do not use directory-wide paths or globs; a literal
placeholder such as `[id]` is allowed when it is the actual filename. `dispatch_ref` points to an accepted
receipt JSON containing `tool`, `event: "accepted"`, `agent_id` matching the row owner, and one returned
`task_name`, `agent_id`, `session_id`, or `id` matching that owner. The receipt proves only that the request
was accepted; it does not prove that work is active, complete, or landed. Record each later state transition
with its own evidence. The orchestrator must provide the same receipt for its own dispatches.

Every new wake includes a `### Decomposition` table with columns `item | next_step | disposition | owner |
evidence`. List every current non-done Item. Allowed dispositions are `dispatched`, `continuing`, `blocked`,
`owner`, and `done`; there is no `ready` disposition at the end of an audit. End with `re-split: rows()`
and `splittable: 0/0`, including when no blockers remain. Add the current row details to `rows(...)` as needed;
do not leave an unassessed item implicit. `splittable: D/P` is a count of newly dispatched independent units
over rows assessed for splitting, with the denominator and evidence defined in that wake.

Run the configured strict latest checker after appending the wake. A missing v2 marker or incomplete current
format fails current certification. A legacy inspection mode may still read historic sections, but must never
certify them as a current v2 audit.

## Reporting and end of session

Use one concise status line at the timer wake with evidence-backed counts for active, dispatched, landed,
splittable, and blocked work. Expand only to explain an anomaly or required owner decision. Do not report a
changing subjective completion percentage.

Before ending recurring supervision, stop re-arming and cancel the timer/probe using the host's supported
controls. Report remaining active work and its evidence. This policy is advisory: it is not a finish gate,
does not grant permissions, and cannot block a task or session from ending.
