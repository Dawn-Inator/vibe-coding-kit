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
   a row marked dispatched.
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
disposition (`dispatched`, `continuing`, `blocked`, `owner`, or `done`), owner, and evidence. There is no
`ready` disposition at the end of a wake. Split each free independent unit and dispatch it during this wake
when capacity exists. Use one clear owner per unit, name repository and worktree, and provide an exact JSON
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
`tracking <source-ref>` for a parent coordinator. The parent source cites current child-state evidence; the
parent remains a non-active tracker and does not need a dispatch receipt. A leaf reference must cite actual current probe/tool
output or private final, for example:
`continuing: active heartbeat-branches output line 4`; a tracking reference points to current child-state
evidence for that parent. Parent tracking is not active leaf work. Acceptance alone is not activity evidence. The
orchestrator resolves and cross-checks the reference against the original tool evidence; the checker validates
only the declared kind and nonempty reference and does not authenticate it. Do not create an activity-receipt
JSON registry. Use only IDs from real Items or wake cells. `D` counts new dispatches; `P` counts all valid
assessed verdicts, including continuing. If no additional split assessment is needed, `rows()` and `0/0` remain
valid even with ongoing Items, provided Decomposition lists every unfinished Item; do not force a redispatch to
fill the count. The wake contract marker controls denominator semantics, not CLI mode: unmarked legacy 8/10
wakes keep the proof-only denominator; `heartbeat/v2` uses all valid assessed rows even under non-certifying
`--history`. Every blocker must name the concrete unavailable
resource, decision, or dependency and its owner. Never use subjective completion percentages.

On adoption or resume, reconcile each active Item separately using the original request/accepted receipt,
private final report, and landing evidence. State each missing transition as `unknown`; blank legacy metadata
does not prove completion. Do not bulk-mark old dispatched rows done, broaden a row beyond the accepted scope,
or turn routine delegable work into an owner decision. Keep operational status distinct from acceptance criteria.

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
