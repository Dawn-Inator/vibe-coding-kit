# Backlog audit

Run this procedure at every delivered heartbeat wake. Use the project adapter's configured discovery and
checker commands where available; command substitutions change invocation only. The categories and decisions
below remain required for every project.

When no timer delivered, use the [due probe](../SKILL.md#wake-mechanism) on each meaningful event. Run a full
audit on the first meaningful event at or after the configured interval from the last full audit, before
unrelated next-batch work. A probe result never schedules a wake; if no meaningful event arrives there is no
wall-clock guarantee.

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

Every dispatch gets an accepted receipt path in `dispatch_ref`. Validate that receipt has `tool`,
`event: "accepted"`, the owner-matching `agent_id`, and a returned task/session identifier that matches that
owner. The receipt shows request acceptance only. At later audits, separately establish whether the unit is
active, has a terminal report, and landed. Do not inflate active or landed counts from acceptance metadata.

At the end of the decomposition section write `re-split: rows(...)` and `splittable: D/P`. The v2 `rows(...)`
group accepts three verdicts: `split->dispatched <new unit>`, `cannot-split: <tagged proof>`, or
`continuing: <current activity/private-final evidence>` for an already dispatched unit. Use only IDs from real
Items or wake cells. `D` counts new dispatches; `P` counts all valid assessed verdicts, including `continuing`.
For example, with one already-dispatched item continuing and one new dispatch, use
`rows(<existing-item-id>: continuing: <active session evidence>; <blocked-row-id>: split->dispatched <new unit>)`
and `splittable: 1/2`; replace placeholders with actual IDs and evidence. If no additional split assessment is
needed, `rows()` and `0/0` remain valid even with ongoing Items, provided Decomposition lists every unfinished
Item; do not force a redispatch to fill the count. Do not use historical denominators for v2. Every blocker must
name the concrete unavailable resource, decision, or dependency and its owner. Never use subjective completion
percentages.

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
