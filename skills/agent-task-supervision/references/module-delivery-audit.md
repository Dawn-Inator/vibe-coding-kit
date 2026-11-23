# Audit module delivery loops

Use with the complete backlog audit when implementation is delegated. This is a coordination audit, not
a new gate, scheduler or permission source. The orchestration skill's
[module delivery contract](../../agent-orchestration-guardrails/references/module-delivery.md) defines the
owner's implementation/test/fix loop and the orchestrator's independent acceptance.

## Inspect the existing record

For each unfinished module, follow `evidence` to its current packet/checkpoint. Check the approved criteria,
persistent delivery owner, current worktree/write ownership, exact candidate, current phase, last meaningful
evidence and next action. Check dependency/queue ownership, actual tests and the acceptance decision with
its intake case; in a subtree, also the sub-planner that owns routine acceptance and every escalation it
raised. Report missing evidence as unknown and arrange reconciliation; do not infer it from an old status
or manufacture a second registry. Aggregate `tracking` parents retain their read-only coordination role;
link actual implementation leaves instead of inventing parent activity or dispatch receipts.

Use the phase to choose the next action, with original evidence:

| Observed condition | Audit action and responsible party |
| --- | --- |
| Implementing/testing without a requirements-based test plan or real wiring | Delivery owner completes the missing scope; a file edit or passing stub is not a candidate |
| A module check failed | Resume the same delivery owner to diagnose, fix and rerun affected checks; retain the failure oracle |
| Internal adapter/contract/startup binding is missing | Orchestrator coordinates its named owner and interface; retain it as development work and continue independent work |
| A required heavy check is queued | Check the exact command, queue/resource owner, source snapshot and continuation; orchestrator grants capacity or arranges a permitted verifier when available |
| A candidate awaits acceptance | Orchestrator, or for a routine module in a subtree its sub-planner, matches the owner's final and the [review verdict](../../agent-orchestration-guardrails/references/review-verdict.md) to the criteria, actual wiring and critical success/failure/recovery paths of the exact candidate, opening the diff in that page's cases; record accept/return/blocked and the intake case |
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

Apply the orchestration skill's [capacity balance policy](../../agent-orchestration-guardrails/references/capacity-balance.md)
at each full audit and material bottleneck event. That reference owns role definitions, trial allocation,
evidence and reallocation rules; do not turn them into fixed staffing requirements in this audit.

Before opening another module, inspect pending candidate acceptance and queued checks. If those queues are
the bottleneck, spend available coordination/verification capacity draining them and resuming current owners.
Do not chase a target active-agent count or split implementation/testing/fixing into unrelated seats that
discard the module owner. New independent modules may proceed when their work and acceptance capacity exist;
do not pause unrelated development just because one queue is blocked.

Read the previous allocation decision from the existing linked checkpoint. For the same scope/window,
record distinct waiting modules/candidates and their shared dependency or queue owner, known wait age,
planned role allocation versus actual activity, arrivals, newly accepted modules and landings separately.
Do not count repeated reports on one dependency as independent queues or infer live workers from roles.
If evidence is missing, record unknown rather than a made-up trend. Check whether the last adjustment
cleared its targeted dependency or reduced its queue and whether arrivals/host availability changed.
For a candidate spanning owners, check its named integration lead and the early assembly evidence in the
[candidate integration contract](../../agent-orchestration-guardrails/references/module-delivery.md#candidate-integration-lead).
Return omissions to the responsible owner and check the repair, rather than adding more execution agents
merely because a candidate has not landed.

Record a bounded change or an evidence-backed hold, responsible owner, expected effect and next review
point in that same checkpoint. Changing a ratio never changes module acceptance, owner responsibility,
write isolation, user staffing constraints or resource limits. If an explicit agent plan changes, update
its existing revision using the normal writer workflow; only actual probes/receipts establish activity.
The audit recommends and records coordination; it never kills, replaces or redispatches workers under
its own authority. Do not create another registry, timer, status enum or certification field for ratios.

## Readiness and rework

In the existing linked checkpoint, distinguish resource queue waits, internal interface/dependency waits,
test adaptation, contract/generated drift, missing architecture registration, target-branch integration
and independent acceptance backlog when evidence supports them. These are diagnostic descriptions, not
new ledger statuses or mandatory tags. Cite the failed check or returned finding, affected candidate,
responsible owner and next action; retain unknown when the cause or elapsed time is not established.
One zero-queue receipt does not establish that resources were available throughout the delivery cycle.

Review complete-function acceptance and landing, first-pass outcomes, and repair rounds/reasons over a
stated comparable scope and window. For first-pass outcomes, count each distinct delivery candidate's
first submission once: report accepted on first decision, returned on first decision and still unresolved
separately. A resubmitted commit stays with the same candidate lineage and does not reset its first pass.
If reporting a first-pass rate, give its numerator and denominator of decided first submissions, and also
show unresolved submissions; unknown history cannot be reconstructed from a current PASS. Record changed
scope or batch boundaries so they cannot manufacture an improvement. Count repair/resubmission rounds
from returned findings, not repeated unchanged checks or progress messages.

Compare the targeted return reasons and repair rounds after a readiness or staffing adjustment, accounting
for arrivals, candidate size and host availability. Fewer omissions may support keeping that change;
agent counts, component test passes or one favorable window alone do not prove faster complete delivery.
Do not delay repairs or acceptance to collect metrics, or add a registry or hard gate for this audit.

## Preserve the ledger contract

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
