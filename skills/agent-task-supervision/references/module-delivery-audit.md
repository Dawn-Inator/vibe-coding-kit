# Audit module delivery loops

Use with the complete backlog audit when implementation is delegated. This is a coordination audit, not
a new gate, scheduler or permission source. The orchestration skill's
[module delivery contract](../../agent-orchestration-guardrails/references/module-delivery.md) defines the
owner's implementation/test/fix loop and the orchestrator's independent acceptance.

## Inspect the existing record

For each unfinished module, follow `evidence` to its current packet/checkpoint. Check the approved criteria,
persistent delivery owner, current worktree/write ownership, exact candidate, current phase, last meaningful
evidence and next action. Check dependency/queue ownership, actual tests and the orchestrator's acceptance
decision. Report missing evidence as unknown and arrange reconciliation; do not infer it from an old status
or manufacture a second registry. Aggregate `tracking` parents retain their read-only coordination role;
link actual implementation leaves instead of inventing parent activity or dispatch receipts.

Use the phase to choose the next action, with original evidence:

| Observed condition | Audit action and responsible party |
| --- | --- |
| Implementing/testing without a requirements-based test plan or real wiring | Delivery owner completes the missing scope; a file edit or passing stub is not a candidate |
| A module check failed | Resume the same delivery owner to diagnose, fix and rerun affected checks; retain the failure oracle |
| Internal adapter/contract/startup binding is missing | Orchestrator coordinates its named owner and interface; retain it as development work and continue independent work |
| A required heavy check is queued | Check the exact command, queue/resource owner, source snapshot and continuation; orchestrator grants capacity or arranges a permitted verifier when available |
| A candidate awaits acceptance | Orchestrator independently checks criteria, diff, actual wiring and critical success/failure/recovery paths against the exact candidate; record accept/return/blocked |
| Acceptance returned findings | Original delivery owner fixes and resubmits; do not count the module done or silently leave repairs to main |
| Accepted but not landed | Orchestrator uses the authorized lifecycle/gates and verifies the target branch; acceptance alone is not landing |
| Repeated identical failure or no new meaningful evidence | Diagnose dependency, resource or decomposition bottleneck and escalate/re-split as needed; no blind retry or churn of owners |
| External input/authority is genuinely unavailable | Record the concrete resource/decision, evidence, responsible party, affected scope and independent work that remains possible |

A private final can be a resumable checkpoint. The native invocation may be complete while module work is
unfinished; no live child then means inactive, not accepted or dead. A documented resource wait needs no
live background process. Confirm it with current queue/owner evidence and resume through the host's follow-up
mechanism; check liveness and write ownership before any replacement. A mere promise of future action without
a checkpoint, next owner or actual work is a stall. A candidate final or returned finding is handled promptly
as an event; the full ten-row audit need not run on every such event unless due.

## Capacity and backlog decisions

Before opening another module, inspect pending candidate acceptance and queued checks. If those queues are
the bottleneck, spend available coordination/verification capacity draining them and resuming current owners.
Do not chase a target active-agent count or split implementation/testing/fixing into unrelated seats that
discard the module owner. New independent modules may proceed when their work and acceptance capacity exist;
do not pause unrelated development just because one queue is blocked.

Keep existing Item IDs, statuses, receipts, Decomposition syntax and `heartbeat/v2` certification unchanged.
For an inactive leaf with a queue or candidate final, cite its real private-final/checkpoint in the existing
`continuing: private-final <source-ref>` verdict; use `continuing: active` only with current activity evidence.
If the next action is blocked, owner-gated or deferred, use the corresponding existing disposition and its
required proof. Do not put phase names such as `queued-check` or `awaiting-acceptance` into those enums.
Record same-owner continuation and any actual replacement dispatch under the normal receipt rules.

Report self-verification, awaiting acceptance, accepted and landed counts separately for the stated module
scope. Keep operational active/dispatched counts as observations. Neither an accepted dispatch, native final,
completed child list, nor a structurally valid heartbeat certifies a module's business acceptance.
Maintain this in one session ledger and linked packets; no per-worker heartbeat or extra supervisor agent.
