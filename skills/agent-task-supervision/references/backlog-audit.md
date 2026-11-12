# Backlog audit

Run this procedure at every delivered heartbeat wake. Use the project adapter's configured discovery and
checker commands where available; command substitutions change invocation only. The categories and decisions
below remain required for every project.

When no timer delivered, use the [due probe](../SKILL.md#wake-mechanism) on each meaningful event. Run a full
audit on the first meaningful event at or after the configured interval from the last full audit, before
unrelated next-batch work. A probe result never schedules a wake; if no meaningful event arrives there is no
wall-clock guarantee. For this event-driven path or first audit after resume, render the canonical block with
`node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --template`. This is read-only and does not claim a
delivered wake. Fill its source and row-state tokens from checks actually performed; empty and done cells need
evidence, row 1 requires separate `(1a)` and `(1b)` states, and row 10 must cite the matrix or name unchecked
units. Append only after every placeholder is replaced, then run strict current validation.

## Sweep

Read and reconcile each of these ten sources, recording what was actually checked in the wake's `sources:`
line:

1. **Dispatches and worker health**: accepted receipts, active sessions/processes, terminal reports, and
   reports that have not been ingested. Acceptance is not execution. Mark active/final/landed only with
   separate evidence.
2. **Landings and handoffs**: project-relevant merge, push, or delivery evidence and any outstanding handoff.
3. **Worker reports**: every result or interim update since the last wake.
4. **Direction and drift**: the project's declared work matrix, or identify what remains unchecked.
5. **Current memory and resume context**: read on initial resume; thereafter record meaningful changes and
   unresolved handoff context. On Kit upgrade/resume, read the actual pinned managed-tree skill; distinguish
   installed, projected/generated, and actually read copies. A stale primary projection is not active policy.
6. **External backlog**: read the configured source and timestamp the read. If unavailable, record a specific
   blocker and an `owner` item for the missing access/decision.
7. **Worker health**: current evidence from host tools and expected duration; do not infer live activity from
   a row marked dispatched. For large histories, native probes must query exact canonical agent path prefixes,
   never partial name substrings. An available-agent/world-state catalog entry is not proof of a running worker;
   acceptance, final reports, and send-message events are not live counts.
8. **Registry integrity**: every task discovered by sweep belongs in `## Items`; resolve missing, duplicate,
   stale, or malformed rows.
9. **Independent work**: inspect each non-done Item for concrete, separable next actions and exact file
   ownership. Identify blockers that prevent only one unit versus the whole objective.
10. **Completion and boundaries**: verify reported completion against its terminal evidence and note relevant
    authorization boundaries; the heartbeat never supplies authorization.

Use the configured sweeper/checker as evidence, then reconcile its output manually into the registry. A probe
that is absent or unavailable is recorded as unchecked or blocked; it is not silently treated as complete.

`Sources` examples must keep every channel and mark each check as completed. Replace `<read-at>` with the
actual ISO timestamp when the external tracker was read:

`sources: WORKER-HEALTH(OK) reports(ok checked) memory/handoff(ok at resume) sweep(ok) drift-matrix(OK) landings(ok) external-backlog(ok <read-at>)`

If the tracker is inaccessible, state the concrete permission blocker and add an `owner` Item for that
decision. Replace `<permission>` with the specific missing access or approval:

`sources: WORKER-HEALTH(OK) reports(ok checked) memory/handoff(ok at resume) sweep(ok) drift-matrix(OK) landings(ok) external-backlog:tracker(BLOCKED <- <permission>)`

The blocked source token does not stand alone: the matching owner Item must identify the tracker access
blocker and its evidence. Do not use a placeholder timestamp or permission reason in a completed audit.

## Re-split and dispatch

For every current non-done Item, record a row in `### Decomposition` with its id, concrete next action,
disposition (`dispatched`, `continuing`, `blocked`, `owner`, or `deferred`), owner, and evidence. There is no
`ready` disposition at the end of a wake. Every unfinished disposition needs a concrete next step, owner, and
evidence-backed reason. `deferred` is first-class and unfinished: both its `## Items` status and Decomposition
disposition are `deferred`. It is inactive; it cannot hide a current writer or missing new-dispatch proof. Each
deferred Item still receives its own proof-backed re-split verdict. Split each free independent unit and dispatch
it during this wake when capacity exists. Use one clear owner per unit, name repository and worktree, and provide an exact JSON
array of relative file paths for the write set. Re-split after a worker goes stale, reports a blocker, or its
remaining work no longer matches the accepted task.

Every leaf dispatch gets an accepted receipt path in `dispatch_ref`. Validate that receipt has `tool`,
`event: "accepted"`, the owner-matching `agent_id`, and a returned task/session identifier that matches that
owner. The receipt shows request acceptance only. At later audits, separately establish whether the unit is
active, has a terminal report, and landed. Do not inflate active or landed counts from acceptance metadata.

For a true aggregate coordinator, the single `## Items` registry may append an optional `children` JSON array
after `dispatch_ref`. The parent uses `status: tracking`, a nonempty array of unique IDs of existing Items,
honest owner/repository/worktree metadata, `mode: read-only`, `write_set: []`, and empty or `-` `dispatch_ref`;
it has no worker acceptance receipt. Leaves use `status: dispatched`, accurate mode/exact write set, and a real
accepted dispatch receipt. Leaves may omit `children` or use `[]`. Reject self-links, cycles, and dangling IDs.
Parent rows remain unfinished until their own coordination acceptance criteria pass, even when every child is
done. Do not force a parent to spawn or count it active, claim acceptance/write authority, bypass leaf
delivery/receipts, or hide unknown legacy child state.

At the end of the decomposition section write `re-split: rows(...)` and `splittable: D/P`. The v2 `rows(...)`
group accepts three verdict classes: `split->dispatched <new unit>`, `cannot-split: <tagged proof>`, or a typed
`continuing` verdict: `active <source-ref>` or `private-final <source-ref>` for leaf work, and
`tracking <source-ref>` for a parent coordinator. Each assessed verdict is unique by exact stable Item ID or
dispatch reference; do not use variable prose as its key. A `split->dispatched` target must resolve uniquely to a
real `## Items` row with `status: dispatched` and a valid accepted receipt. Its stable `unitItemID`, dispatch
reference, or uniquely resolving owner may alias that same canonical unit; ambiguous/unmatched aliases or free text
are invalid and do not count toward `D`. The parent source cites current child-state evidence; the
parent remains a non-active tracker and does not need a dispatch receipt. A leaf reference must cite actual current probe/tool
output or private final, for example:
`continuing: active heartbeat-branches output line 4`; a tracking reference points to current child-state
evidence for that parent. Parent tracking is not active leaf work. Acceptance alone is not activity evidence. The
orchestrator resolves and cross-checks the reference against the original tool evidence; the checker validates
only the declared kind and nonempty reference and does not authenticate it. Do not create an activity-receipt
JSON registry. Use only IDs from real Items or wake cells. `D` counts distinct newly dispatched unit references,
not source rows: multiple source rows may point to one batch unit, which counts once in `D` (one dispatch among
two assessed verdicts is `1/2`, not `2/2`). `P` counts all unique valid assessed verdicts, including continuing
and deferred verdicts. If no additional split assessment is needed, `rows()` and `0/0` remain valid only when
Decomposition lists every unfinished Item and there are no deferred Items; each deferred Item requires its own
counted proof-backed verdict. Do not force a redispatch to fill the count. The wake contract marker controls
denominator semantics, not CLI mode: unmarked legacy 8/10
wakes keep the proof-only denominator; `heartbeat/v2` uses all valid assessed rows even under non-certifying
`--history`. Every blocker must name the concrete unavailable
resource, decision, or dependency and its owner. Never use subjective completion percentages.

For a `deferred` legacy Item whose audit evidence is irrecoverable, v2 may use
`cannot-split: audit-evidence-unrecoverable <audit-ref>` only; do not disguise lost history as `owner-gated` or
`same-file conflict`. `<audit-ref>` is a path relative to the ledger's
directory to that Item's full JSON audit record; use the existing reference mechanism, not a new registry. Record
all fields below, retaining the original row and goal (`originalGoal` equals current `item.item`):

```json
{
  "itemId": "<stable Item ID>",
  "originalGoal": "<current item.item>",
  "originalRowSha256": "<hash>",
  "checkedSources": [
    {"path": "<source>", "locator": "<locator/result>", "sha256": "<hash>"},
    {"path": "<source>", "result": "<locator/result>", "missing": true}
  ],
  "transitions": {
    "accepted": {"state": "unknown", "source": "<evidence>"},
    "privateFinal": {"state": "unknown", "source": "<evidence>"},
    "landed": {"state": "unknown", "source": "<evidence>"}
  },
  "missingFields": ["<nonempty list>"],
  "auditor": "<identity>",
  "checkedAt": "<ISO timestamp>",
  "historicalDispatchState": "unknown",
  "currentWriter": {"state": "unknown", "evidence": "<probe result>"}
}
```

Each `checkedSources` entry has `path`, `locator` or `result`, and exactly one of a `sha256` digest or explicit
`missing: true`. `missingFields` must be nonempty. Every transition is explicitly `known` or `unknown` with its
source. `currentWriter.state` may be
`inactive`, `unknown`, or `active`; never write `inactive` when evidence leaves it unknown. This irrecoverable
history verdict requires `currentWriter` to be inactive or unknown, never active. Unknown does not prove inactive;
resolve it from a native probe, and do not infer absence of a writer from this record.
Structural checks can verify fields and Item linkage, not truth, complete source discovery, or physical worker state;
the orchestrator must inspect original tool evidence. This record only explains missing historical evidence: keep
the Item and its concrete next step/owner unfinished. Count this verdict once in assessed `P`, never as done or `D`;
it does not replace a current accepted dispatch receipt or block separately authorized executable work.

On adoption or resume, reconcile each Item separately using its original goal/request/accepted receipt, private
final report, and landing evidence. State each missing transition as `unknown`; blank legacy metadata does not
prove completion. Legacy inactive or unverified records stay unfinished unless item-specific terminal/landing
evidence proves completion. Retain the original goal, history, and unknown provenance; do not mass-mark done or
recast uncertain legacy rows as `tracking`. Verified goal/oracle results plus terminal or landing evidence may
prove a legacy Item done without reconstructing historical agent identity; retain unknown provenance in its evidence.
Unfinished dispatched work still needs current native accepted metadata, and unknown work stays unfinished.
Do not bulk-mark old dispatched rows done, broaden a row beyond the accepted scope, or turn routine delegable
work into an owner decision. Keep operational status distinct from acceptance criteria.

## Check and preserve

Append the new heartbeat section and run the configured strict latest checker. The latest section must carry
`contract: heartbeat/v2`, all ten source categories, the Decomposition table and terminal split markers, plus
the current Items metadata. A failed check is not current certification: fix the new section and check again.
Legacy wake sections may remain readable for history, but cannot certify the current v2 format. Preserve all
prior wake bytes and append only.

Preserve historical wake bytes. A red current audit remains uncertified: append a corrective audit and claim
current certification only after the checker reports `certifiesCurrent: true`. A red audit never blocks
separately authorized business work or ending the session.

The audit is advisory. Report stale, blocked, unlanded, or inconsistent work with evidence. Do not kill or
restart workers, perform finishes or merges, archive sessions, clean branches/worktrees, or delete anything
under this shared policy. Any action must come from separately applicable project instructions and current
authorization.
