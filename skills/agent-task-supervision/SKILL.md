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

Use a host-supported periodic capability at a default 20-minute cadence. Send a short delivery probe (1–3
minutes), yield, and trust it only after the probe arrives. If it fails, record that and use meaningful events
as the fallback; do not claim a timer, daemon, hook, or app automation will wake the session unless one
actually delivered. No event means no guaranteed wall-clock wake.

When no timer delivered, run the read-only Kit due probe on every meaningful human request, resume, private
worker final, landing, or newly surfaced blocker. The first such event at or after 20 minutes from the last
full audit is due: re-arm if a timer is available, then run a full audit before starting unrelated next-batch
work. Earlier events get their normal event handling and do not count as a full audit. Do not wait for another
event once an event is due. Interim worker notifications are not meaningful events unless they surface a
blocker or new evidence. The CLI probe is `node .vibe-coding/kit/src/supervision/heartbeat-audit-due-cli.mjs
<ledger> [--minutes 20 --json]`; its JSON `due` field is authoritative. It schedules nothing and grants no
hook or wake capability.

The configured adapter may provide project-specific command strings for `arm`, `due`, `check`, `sweep`,
`inflight`, and `branches`; invocation overrides must not alter audit obligations. The Kit arm template accepts
`--commands '<JSON object>'`; values can use `{ledger}`, `{minutes}`, or `{interval}` placeholders.

At every delivered timer wake, re-arm first, then audit. The timer firing leads to a fresh audit. On other turns,
handle the event and run relevant discovery; if the due probe says a meaningful event is due, complete the full
audit before unrelated next-batch work. Do not describe event handling as a full audit unless the full checklist
and ledger append were completed. A separate one-shot waiter does not replace or swallow the recurring heartbeat.

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
   not a signal. On initial resume or a Kit upgrade, read the skill from the session's actual pinned managed
   tree. Distinguish installed, projected/generated, and actually read copies; a stale primary projection is
   not evidence of the active policy.
6. Record actual countable progress and blockers. Do not use subjective percentages. A ratio is acceptable
   only when both counts and the counted scope are stated.

## Ledger contract

Keep the ten existing category rows and their `sources:` evidence line. Each new wake section must use the
existing `## <ISO time> wake (10-row ledger)` heading plus a standalone `contract: heartbeat/v2` line; retain
older wake bytes as historical records. Do not rewrite the file. The current `## Items` table keeps its
existing `id | source | item | status | evidence` fields and adds, in order,
`owner | repository | worktree | mode | write_set | dispatch_ref`.

Each dispatched row must identify `mode` as `write` or `read-only`, an explicit repository and worktree, and
`write_set` as a JSON array of exact relative file paths. Do not use directory-wide paths or globs; a literal
placeholder such as `[id]` is allowed when it is the actual filename. `dispatch_ref` points to an accepted
receipt JSON containing `tool`, `event: "accepted"`, `agent_id` matching the row owner, and one returned
`task_name`, `agent_id`, `session_id`, or `id` matching that owner. The receipt proves only that the request
was accepted; it does not prove that work is active, complete, or landed. Record each later state transition
with its own evidence. The orchestrator must provide the same receipt for its own dispatches.

Every new wake includes a `### Decomposition` table with columns `item | next_step | disposition | owner |
evidence`. List every current non-done Item. Allowed dispositions are `dispatched`, `continuing`, `blocked`,
`owner`, and `done`; there is no `ready` disposition at the end of an audit. If there are no Items to assess,
end with `re-split: rows()` and `splittable: 0/0`. Add the current row details to `rows(...)` as needed;
do not leave an unassessed item implicit. `splittable: D/P` is newly dispatched independent units over **all
valid rows assessed in this v2 wake**, including rows already dispatched or not newly split. State assessed row
ids and evidence. Historical wake denominators retain their old meaning; do not rewrite them or apply that old
denominator rule to v2.

Use the canonical [ledger API and CLI modes](references/ledger-api.md). Run strict current mode after appending
the wake. A missing v2 marker or incomplete current format fails current certification. Historical inspection
and Items inventory are useful read modes, but neither can certify a current v2 audit.

For adoption or resume, reconcile each active Item against its original request/dispatch, private final, and
landing evidence. Use `known` or `unknown` explicitly for missing transitions; blank historical owner metadata
is unknown, not proof of completion. Do not bulk-mark dispatched rows done, relabel routine delegable work as
an owner decision, or broaden a dispatched unit beyond its accepted scope. Actual status (accepted, active,
final, landed, blocked) is separate from acceptance criteria. Preserve every old wake byte. If a new audit is
red, append a corrective audit and claim current certification only when the checker returns
`certifiesCurrent: true`; a red audit never blocks separately authorized business work or session finish.

## Reporting and end of session

Use one concise status line at the timer wake with evidence-backed counts for active, dispatched, landed,
splittable, and blocked work. Expand only to explain an anomaly or required owner decision. Do not report a
changing subjective completion percentage.

Before ending recurring supervision, stop re-arming and cancel the timer/probe using the host's supported
controls. Report remaining active work and its evidence. This policy is advisory: it is not a finish gate,
does not grant permissions, and cannot block a task or session from ending.
