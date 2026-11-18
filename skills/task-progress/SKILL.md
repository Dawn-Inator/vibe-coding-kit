---
name: task-progress
description: Use for actionable work in parent and child sessions, when reading a heartbeat-backed task view, and before reporting completion.
---

# Shared task progress

For actionable work, read the current task before execution. Register the actual scope when the task has no
related source or ordinary record, then persist material milestones and their evidence during execution and
reconcile them before the final response. Update at real checkpoints such as implementing a change, running
its verification, or identifying a blocker. Leave unverified work open and record the blocker or next step
when known. Derive progress from the recorded checklist and evidence. A question or acknowledgement alone
needs no checklist.

Use the shared Kit task contract and store for ordinary short tasks; a heartbeat ledger is optional and should not be created just to show progress. A project heartbeat display can automatically show the configured or latest recorded source for the trusted current project, independently of chat task selection. It reports recorded history, not live activity, and does not replace an unrelated chat task record. Give task entries stable IDs and retain their history and evidence when scope changes. Reopen or add remaining verification, packaging, commit, or push work before reporting the registered checklist complete when those steps are part of the request.

When an existing heartbeat ledger is bound to the task, or one candidate is uniquely associated with it, use that ledger as the displayed task source. Automatic association requires one exact standalone `thread:`, `thread_id:`, or `threadId:` metadata field outside fenced examples; prose mentions and conflicting IDs do not bind a source. Claim a unique or absent source only after a complete discovery report; bounded or unreadable scans leave source selection uncertain and need an explicit binding or an uncertainty report. Keep any existing ordinary task record dormant while the heartbeat source is bound. The task projection consumer must not write or move the source ledger through task mutations; the project's existing ledger workflow remains responsible for maintaining it.

An optional standalone `task_root: <Items ID>` selects a tracking root and its linked descendants from the existing Items registry for task projection. Without the field, all Items remain in scope. Fenced examples are ignored; a ledger with only a fenced example still uses all Items. Invalid or empty active declarations, duplicate or conflicting declarations, and missing, non-tracking or cyclic roots fail closed. Producers derive the selected Items from their authoritative source in the same registry; do not hand-maintain separate business counts or create a second store.

Keep row IDs, titles, raw statuses, and reported evidence tied to the source. Unknown statuses remain incomplete. Completion requires evidence from the source; an inventory or its percentage alone never certifies the whole delivery. Preserve invalid IDs, duplicate IDs, parser errors, and unsafe or missing child links as visible errors or source risks. For a valid tracking parent, count its linked children as progress leaves without counting the parent twice. `reported` evidence records a claim; `verified` requires an actual check against the relevant oracle. Never infer task progress from elapsed time, token use, or activity alone.

## Dispatch and child milestones

- **Parent assignment.** Include the child progress instructions when dispatching. Immediately after dispatch
  returns, record the exact native child thread ID on the assigned ordinary objective or item through
  `task_progress_rescope` using the current revision and retained scope (`agent: { threadId, path? }`).
  Omission preserves an existing assignment by item ID during an active-cycle rescope, including moves.
  `agent: null` clears it, and a new cycle does not inherit it. An item inherits its objective’s assignment
  unless it explicitly overrides or clears it. For a related read-only Kit Heartbeat, the authorized source
  writer uses `recordHeartbeatAgentAssignments` on canonical Items leaves with a fresh pair version. Follow
  “Recording agent assignments” in the [heartbeat writer contract](../agent-task-supervision/references/ledger-api.md)
  for legacy rows, exact dispatch evidence, and ownership. Use the child thread ID from the actual native
  dispatch result or trusted native evidence tied to that exact dispatch. An owner name, path, blank legacy
  receipt, or similar-looking prior run cannot establish a match. Skip ambiguous and tracking-parent rows.
  Reassign or clear a link only on evidence. Keep unavailable IDs unknown.
- **Child execution.** In the child's own authenticated task context, use `task_progress_get` before work and
  register the actual assigned module milestones via `task_progress_initialize` when absent. Resume an open
  scope or rescope an existing task when required. Use `task_progress_update` to record completed milestones
  with evidence during execution and reconcile the checklist before the private final. Use the latest revision
  and retain the request ID when retrying the same mutation. Keep the journal in the child's trusted workspace
  through normal Kit APIs. If the tools or a trusted source are unavailable, report the gap in the private
  final. Do not copy the parent's task or Native Goal, impersonate another session, or write a parallel progress
  file. A parent cannot write the child's private task journal on its behalf.
- **Parent acceptance.** Assignment proves which unit the child owns. The child's checklist records execution
  in that module. The parent checks applicable acceptance, integration, and delivery evidence before marking
  the corresponding canonical parent leaf complete. A dispatch receipt, a complete child checklist, and a
  private final alone do not prove acceptance. Use the recorded assigned leaves for parent progress, and the
  child's own canonical checklist for child execution progress when the scope fence below is satisfied. Missing,
  heartbeat-bound, uncertain, or different-workspace child journals leave child execution progress unknown.

A recorded runtime observation applies to its timestamp. Direct runtime active flags take precedence, partial coverage gives a lower bound, and ratios require an exact current plan.

For the current-turn subagent view, use the normalized snapshot’s `taskCycleId`, `rootTurnId`, `rootTurnStartedAt` and `scopeBasis`. A `parent-root-turn` scope requires causally confirmed dispatch, continuation or subAgentActivity from the trusted parent’s latest root turn. Ordinary managed tasks remain fenced by the matching lifecycle ID and start time. For a read-only Kit-bound task without a lifecycle, a bounded canonical source path and verified latest root start provide the scope fence instead; do not invent a lifecycle or apply this fallback to ordinary tasks. Check direct `thread_spawn` evidence to exclude internal review and compaction threads. A missing required scope fence or records, incomplete summaries or unknown scope remain unknown; never substitute the parent chat’s full historical child inventory. Child `createdAt` and `updatedAt` do not establish dispatch, and `notLoaded` does not establish running. Do not present a Heartbeat allocation from before the current root turn as its current ratio. A later parent continuation invalidates the child’s earlier completion state. Show child progress only when the latest exact dispatch time is established and the child task cycle start or creation is no earlier than that dispatch; otherwise show unknown, never carry forward an old 100% or completed state. Use only a verified root start time for the plan ratio; if it cannot be established, the ratio is unknown. Cache and display must respect the same cycle and scope fences.

Report completion from recorded task state and evidence. Use the applicable project planning guidance when a plan is needed; this skill does not add a separate planning or heartbeat policy.

## Helper-managed task lifecycle

Lifecycle v4 is explicit at the Kit API boundary: callers opt in with `lifecycle: true` on initialize, update, or rescope. The plugin Helper sets this flag for ordinary local task writes. Existing schema v3 task events remain readable and unchanged. A read-only `task_progress_get` must not synthesize a closed lifecycle for a v3 task or a Heartbeat source; an old v3 `phase: completed` is not proof of delivery.

Keep one visible closeout checkpoint in addition to the registered required checklist leaves. A checklist at 100% is not task completion; do not cap progress at 99% to imitate a finish action. The checkpoint closes only through explicit `task_progress_complete` with verified evidence for each of branch, merge, and push marked done or verified not applicable, `remainingWork: 0`, `ownerActions: 0`, and verified audit evidence. Verify the physical required branch work and remote state, including the pushed remote SHA, before completing. If a required branch finish, merge, or push is incomplete, any Owner action remains, or any registered objective or item remains open, keep the lifecycle open; optional work must be completed or cancelled through an approved scope change. Never report complete merely because checklist items are all marked complete. There is no human Finish button. Keep execution status such as working or unknown separate from task closure; a recorded closed lifecycle remains at 100% even if execution telemetry is unavailable.

After true completion, new work starts a fresh lifecycle using `task_progress_rescope` with the latest revision; scope only the new work rather than carrying completed nodes forward. If a caller resubmits old scope, Kit drops exactly unchanged objectives and items and retains only genuinely changed or new work; do not copy completed old children into a changed objective. Reject a new cycle with no new work. A mid-task rescope retains all still-relevant objectives and marks removed nodes cancelled; additions or cancellations may change the denominator and lower progress within that cycle. The prior completed cycle remains available as a read-only archive derived from the event history; never rewrite raw history or create another archive store. `task_progress_archive` returns bounded pages of cycle summaries or cycle details. In the panel, keep current subtasks separate from archived cycles, with archive cycles collapsed by default and details loaded on demand.

Lifecycle semantics apply to schema v4 managed task records opted in with `lifecycle: true`. Bound read-only Heartbeat sources have no formal cycle API; report lifecycle completion and archive as unavailable rather than infer a cycle or fall back to a dormant local task. Native Goals are separate and unchanged.

For an agent allocation view, producers may register an explicit agent plan in the same Kit Heartbeat orchestration wake as the actual observed counts. Match the plan to the trusted parent thread and any managed task cycle, and use the recorded after-audit count against that plan; missing or mismatched evidence, a zero denominator, or an over-plan count must not become a fabricated ratio. This adds no parallel store or timer.

The Heartbeat view presents the recorded orchestration snapshot: actual active child agents before the audit
and after re-splitting/dispatch, plus audited blocked tasks and whether Owner intervention is known to be
needed. It is a timestamped observation, not a live count. The full ten audit rows and Items registry remain
in the canonical ledger for audit; they are not the main view or a source for inferred snapshot values. Older
wakes without snapshots display unknown. Producers capture the snapshot under `agent-task-supervision` and
write it through the Kit heartbeat writer; the plugin keeps no parallel record.

## Persistent Markdown storage

Read [persistent storage details](references/persistent-storage.md) before touching `taskhistory.md`, `heartbeat.md`, ledger head/history migration or recovery, workspace task-storage routing, or legacy JSONL compatibility. The Kit owns durable task state; `taskhistory.md` is canonical and `heartbeat.md` is a projection, so never append task events to the head by hand.
