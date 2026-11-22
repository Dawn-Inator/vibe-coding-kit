---
name: agent-task-supervision
description: Use for long-running autonomous or multi-agent work to audit module delivery loops, worker health, pending acceptance and backlog, and whenever an active heartbeat ledger must be maintained.
---

# Agent task supervision

This policy coordinates work, not authority: no permission to finish/merge, archive, delete, kill/restart,
or veto a session finish. Adapters may expose read-only probes and approved commands; overrides change neither audit duties nor authorization.

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
hook or wake capability. To prepare an event audit without arming a timer, render the canonical read-only
block with `node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --template`. It prints a template only; it
does not claim a delivered wake or write files. Fill every source and state from checks actually performed,
prepare the completed block in memory, and publish it through the Kit heartbeat pair writer, which checks
format before writing. Then reread the pair and run strict current validation. Never append unfilled
placeholders or claim unchecked work as complete.

The configured adapter may provide project-specific command strings for `arm`, `due`, `check`, `sweep`,
`inflight`, and `branches`; invocation overrides must not alter audit obligations. The Kit arm template accepts
`--commands '<JSON object>'`; values can use `{ledger}`, `{minutes}`, or `{interval}` placeholders.

At a delivered timer wake, re-arm before a fresh audit. Other meaningful events run discovery and the due
probe; if due, finish the full checklist and ledger write before unrelated next-batch work. Event handling
alone is not a full audit, and a one-shot waiter never replaces the recurring heartbeat.

## Required audit

At every timer wake, the orchestrator itself must:

1. Confirm one heartbeat is armed, and check host load or quota only against thresholds configured for the
   project. Do not invent thresholds.
2. Count actual active workers using the configured in-flight probe, not ledger row count. Review every worker
   event since the prior wake. Distinguish a request accepted by a tool from work that is active, a terminal
   report, and work landed on its target. A report with no live child/session needs reconciliation: a durable
   queued-check or awaiting-acceptance checkpoint is unfinished and inactive, not proof of death. An unsupported
   announcement is stale; resume its owner or record a blocker. For native probes over large histories,
   query exact canonical agent path prefixes; partial name matches are not identity. Presence in an available-agent
   or world-state catalog is not live activity evidence. Accepted receipts, final reports, and send-message events
   are not live counts. A delay beyond twice the expected
   duration or repeating the same step three times is a circuit-breaker signal to record and escalate.
3. Run configured discovery and branch/session probes. Ingest each newly found task in `## Items` and check
   each listed owner against current evidence. Probes are evidence sources only. Do not kill, restart, finish,
   merge, archive, clean, or delete based on this shared policy.
4. Audit the complete backlog with the [backlog audit](references/backlog-audit.md) and
   [module delivery audit](references/module-delivery-audit.md). Decompose every non-done item into a concrete
   next step; delegated implementation units need persistent module owners through tests, fixes and acceptance.
   Balance wiring, execution and acceptance from queue evidence; review the previous adjustment's effect.
   Dispatch free independent units when authorized and execution plus acceptance capacity exists;
   do not wait to be asked. Name repository, worktree, mode and exact relative write set. Re-split only when
   the current boundary no longer holds; a new wake does not itself require replacing an owner.
5. Check direction against known project signals and record the evidence. An unsubstantiated impression is
   not a signal. On initial resume or a Kit upgrade, read the skill from the session's actual pinned managed
   tree. Distinguish installed, projected/generated, and actually read copies; a stale primary projection is
   not evidence of the active policy.
6. Record actual countable progress and blockers, including modules self-verified, awaiting acceptance,
   accepted and landed separately. Active agent count is capacity evidence, not delivery progress. Do not use
   subjective percentages. A ratio needs both counts and the counted scope.

Candidate finals and returned findings get immediate normal event handling; do not delay acceptance or
same-owner repair until a timer. A full audit still follows the due-probe cadence. Keep one session ledger
and wake mechanism; child modules do not each create a heartbeat, timer or parallel task registry.

## Orchestration snapshot

For every v2 wake, follow [snapshot recording](references/ledger-api.md#recording-orchestration-snapshots) and the linked writer contract.

## Ledger contract

Keep the ten existing category rows and their `sources:` evidence line. Each new wake section must use the
existing `## <ISO time> wake (10-row ledger)` heading plus a standalone `contract: heartbeat/v2` line; retain
older wake bytes as historical records. Do not rewrite the file. The current `## Items` table keeps its
existing `id | source | item | status | evidence` fields and adds, in order,
`owner | repository | worktree | mode | write_set | dispatch_ref`.

Parents are read-only `tracking` coordinators with unique existing child links and no worker receipt;
leaves need real owner-matching accepted receipts and exact write scopes. Children finishing does not
complete a parent, and receipts do not prove activity, acceptance or landing. Read the
[parent/leaf contract](references/backlog-audit.md#parent-and-leaf-roles) before writing those rows.

Keep module delivery phase, candidate, check/queue evidence and acceptance decision in the existing task
packet/checkpoint linked from `evidence`. These are distinct from Items status and Decomposition disposition;
do not introduce new status tokens or rewrite legacy records to infer missing phases. This adds no ledger
schema or certification claim; the orchestrator checks the underlying evidence.

Every wake includes a `### Decomposition` table (`item | next_step | disposition | owner | evidence`) for
all non-done Items. Use `dispatched`, `continuing`, `blocked`, `owner`, `deferred`, or `done`, never `ready`.
Each unfinished row needs a concrete next step, owner and evidence-backed reason. `deferred` is inactive,
also `deferred` in Items, and needs its own proof-backed re-split verdict; it cannot hide a writer or missing receipt.

Before preparing the wake, read the [backlog audit](references/backlog-audit.md) for typed `rows(...)`
verdicts, receipt resolution and legacy evidence recovery. End with `re-split: rows(...)` and `splittable: D/P`:
`D` counts distinct newly dispatched canonical units; `P` counts unique assessed Item/dispatch verdicts,
including continuing and deferred. Free text is not a dispatch. With no new split assessment, write
`re-split: rows()` and `splittable: 0/0` only when Decomposition covers all unfinished Items and none is deferred.
The wake marker selects denominator semantics: v2 counts all valid assessed rows even under `--history`;
unmarked legacy wakes retain their proof-only denominator. Preserve historical bytes; never redispatch for a count.

Use the canonical [ledger API and CLI modes](references/ledger-api.md). For new ledger reads and writes use
the Kit heartbeat pair API. Build a new ledger in memory and call `createHeartbeatLedgerPair`; never write a
raw seed file and then migrate it. For an existing pair, read its fresh version and use
`writeHeartbeatLedgerPair`, `appendHeartbeatWake`, or `recordHeartbeatAgentAssignments`. These writers validate
the final candidate before publishing; `HEARTBEAT_LEDGER_INVALID` with `findings` means correct the candidate
and retry through the writer, preserving the existing head, history and backup. Do not bypass a rejection with
direct file writes. Optional `inspectHeartbeatLedger(..., { mode: 'format' })` checks a candidate in memory;
it does not certify an audit. Literal `unknown` preserves unfinished work; it does not authorize `ready` or
invent a dispatch. Migration and recovery preserve existing historical bytes and are not generation paths.
After writing, reread the pair and run strict current mode. A missing v2 marker or incomplete current format
fails current certification. Historical inspection, format checks and Items inventory cannot certify a current
v2 audit.

For adoption or resume, reconcile Items individually against original goals, dispatches, finals, and landings.
Missing transitions are `unknown`, not done. Legacy inactive/unverified work stays unfinished absent item-specific
terminal evidence; preserve its goal, history, and provenance. Never mass-mark it done or disguise it as `tracking`.
An irrecoverable-history proof does not replace a new dispatch receipt or block authorized next work. See
[backlog audit](references/backlog-audit.md). Preserve old wake bytes; status is separate from acceptance criteria.
If a new audit is
red, append a corrective audit and claim current certification only when the checker returns
`certifiesCurrent: true`; a red audit never blocks separately authorized business work or session finish.

## Reporting and end of session

Use one concise status line at the timer wake with evidence-backed counts for active, dispatched, landed,
splittable, and blocked work. Expand only to explain an anomaly or required owner decision. Do not report a
changing subjective completion percentage.

Before ending recurring supervision, stop re-arming and cancel the timer/probe using the host's supported
controls. Report remaining active work and its evidence. This policy is advisory: it is not a finish gate,
does not grant permissions, and cannot block a task or session from ending.
