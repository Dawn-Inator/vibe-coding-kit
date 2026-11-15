---
name: task-progress
description: Use when registering a task, reading a heartbeat-backed task view, or reporting task completion.
---

# Shared task progress

Use the shared Kit task contract and store for ordinary short tasks; a heartbeat ledger is optional and should not be created just to show progress. A project heartbeat display can automatically show the configured or latest recorded source for the trusted current project, independently of chat task selection. It reports recorded history, not live activity, and does not replace an unrelated chat task record. Give task entries stable IDs and retain their history and evidence when scope changes. Reopen or add remaining verification, packaging, commit, or push work before reporting the registered checklist complete when those steps are part of the request.

When an existing heartbeat ledger is bound to the task, or one candidate is uniquely associated with it, use that ledger as the displayed task source. Automatic association requires one exact standalone `thread:`, `thread_id:`, or `threadId:` metadata field outside fenced examples; prose mentions and conflicting IDs do not bind a source. Claim a unique or absent source only after a complete discovery report; bounded or unreadable scans leave source selection uncertain and need an explicit binding or an uncertainty report. Keep any existing ordinary task record dormant while the heartbeat source is bound. The task projection consumer must not write or move the source ledger through task mutations; the project's existing ledger workflow remains responsible for maintaining it.

Keep row IDs, titles, raw statuses, and reported evidence tied to the source. Unknown statuses remain incomplete. Completion requires evidence from the source; an inventory or its percentage alone never certifies the whole delivery. Preserve invalid IDs, duplicate IDs, parser errors, and unsafe or missing child links as visible errors or source risks. For a valid tracking parent, count its linked children as progress leaves without counting the parent twice. `reported` evidence records a claim; `verified` requires an actual check against the relevant oracle. Never infer task progress from elapsed time, token use, or activity alone.

Report completion from recorded task state and evidence. Use the applicable project planning guidance when a plan is needed; this skill does not add a separate planning or heartbeat policy.

## Helper-managed task lifecycle

Lifecycle v4 is explicit at the Kit API boundary: callers opt in with `lifecycle: true` on initialize, update, or rescope. The plugin Helper sets this flag for ordinary local task writes. Existing schema v3 task events remain readable and unchanged. A read-only `task_progress_get` must not synthesize a closed lifecycle for a v3 task or a Heartbeat source; an old v3 `phase: completed` is not proof of delivery.

Keep one visible closeout checkpoint in addition to the registered required checklist leaves. A checklist at 100% is not task completion; do not cap progress at 99% to imitate a finish action. The checkpoint closes only through explicit `task_progress_complete` with verified evidence for each of branch, merge, and push marked done or verified not applicable, `remainingWork: 0`, `ownerActions: 0`, and verified audit evidence. Verify the physical required branch work and remote state, including the pushed remote SHA, before completing. If a required branch finish, merge, or push is incomplete, any Owner action remains, or any registered objective or item remains open, keep the lifecycle open; optional work must be completed or cancelled through an approved scope change. Never report complete merely because checklist items are all marked complete. There is no human Finish button. Keep execution status such as working or unknown separate from task closure; a recorded closed lifecycle remains at 100% even if execution telemetry is unavailable.

After true completion, new work starts a fresh lifecycle using `task_progress_rescope` with the latest revision; scope only the new work rather than carrying completed nodes forward. If a caller resubmits old scope, Kit drops exactly unchanged objectives and items and retains only genuinely changed or new work; do not copy completed old children into a changed objective. Reject a new cycle with no new work. A mid-task rescope retains all still-relevant objectives and marks removed nodes cancelled; additions or cancellations may change the denominator and lower progress within that cycle. The prior completed cycle remains available as a read-only archive derived from the event history; never rewrite raw history or create another archive store. `task_progress_archive` returns bounded pages of cycle summaries or cycle details. In the panel, keep current subtasks separate from archived cycles, with archive cycles collapsed by default and details loaded on demand.

Lifecycle semantics apply to schema v4 managed task records opted in with `lifecycle: true`. Bound read-only Heartbeat sources have no formal cycle API; report lifecycle completion and archive as unavailable rather than infer a cycle or fall back to a dormant local task. Native Goals are separate and unchanged.

The Heartbeat view presents the recorded orchestration snapshot: actual active child agents before the audit
and after re-splitting/dispatch, plus audited blocked tasks and whether Owner intervention is known to be
needed. It is a timestamped observation, not a live count. The full ten audit rows and Items registry remain
in the canonical ledger for audit; they are not the main view or a source for inferred snapshot values. Older
wakes without snapshots display unknown. Producers capture the snapshot under `agent-task-supervision` and
write it through the Kit heartbeat writer; the plugin keeps no parallel record.

## Persistent Markdown storage

The Kit owns durable task state and source associations. Ordinary task events, explicit or automatic heartbeat
bindings, and the binding-migration marker are records in the per-chat `taskhistory.md`; `heartbeat.md` is the
readable projection of the latest task state. The helper serializes writers for a storage root. Treat the
history as the canonical record and the head as a projection, never append prior task events manually to the
head.

Project heartbeat ledgers use the same head/history split after a writer-owned cutover: `heartbeat.md` contains
the current readable head and `taskhistory.md` contains the complete wake history plus its source marker.
Display/read APIs are read-only and must not auto-migrate an unrelated active heartbeat. Until an authorized
writer explicitly takes ownership after quiescence, legacy sources stay single-file and their physical history
source is that head file. `readProjectHeartbeat` is always read-only; its deprecated `migrate` option is ignored.
Read through Kit's pair API so migrated wake rows retain their physical source path and line. A cutover uses the
Kit migration API only after the caller has stopped legacy writers for the complete
transaction and passes `legacyWritersQuiescent: true` plus a fresh `expectedContentHash` from
`readHeartbeatLedgerPair({root, path})`. The flag records the caller's actual ownership; the Kit lock only
coordinates Kit writers, not raw legacy appends. Version mismatches fail closed. If a pair publication is
interrupted, read its raw version with `readHeartbeatLedgerPairVersion` and use
`recoverHeartbeatLedgerPair` to verify the backup and planned/previous head; never repair it manually. It
preserves the original bytes, archives prior wakes, and keeps the latest state in the head. Use Kit's writer
API for new wakes so the archive and head stay synchronized.

For trusted chat cwd routing, use Kit's `WorkspaceTaskStorage` adapter. Per-project task records live under
`.workspace/codex-task-progress/tasks/v3/<thread-sha256>/`; reconstructable caches live under
`.tmp/codex-task-progress/<thread-sha256>/`. App-root routing history is durable state, not a cache. Deleting
the cache must not remove task history, source relations, or workspace routing. A workspace move carries
ordinary task history and routing, but does not import the previous project's source association.

Legacy JSONL task events, snapshots, and workspace routing indexes are compatibility inputs only. Preserve
the old files as backups; if the old and Markdown histories conflict, fail closed and keep both copies for
resolution rather than choosing one silently. See the [storage API reference](references/ledger-api.md) for
file layout, migration functions, and the compatibility contract.
