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

Read [dispatch and child milestones](references/dispatch-and-child-milestones.md) when dispatching a child, running as a child, accepting child work, or reporting subagent or agent-allocation progress. Parent assignment, child execution, parent acceptance, and the current-turn scope fences live there. Assignment, a dispatch receipt, or a complete child checklist alone never proves acceptance, and old child completion is never carried forward.

Report completion from recorded task state and evidence. Use the applicable project planning guidance when a plan is needed; this skill does not add a separate planning or heartbeat policy.

## Helper-managed task lifecycle

Read [task lifecycle](references/lifecycle.md) before opting into `lifecycle: true`, closing a task, rescoping after completion, reading cycle archives, or reporting the Heartbeat orchestration snapshot. Keep one closeout checkpoint; checklist 100% is not completion, and only `task_progress_complete` with verified branch, merge, push and audit evidence closes a lifecycle.

## Persistent Markdown storage

Read [persistent storage details](references/persistent-storage.md) before touching `taskhistory.md`, `heartbeat.md`, ledger head/history migration or recovery, workspace task-storage routing, or legacy JSONL compatibility. The Kit owns durable task state; `taskhistory.md` is canonical and `heartbeat.md` is a projection, so never append task events to the head by hand.
