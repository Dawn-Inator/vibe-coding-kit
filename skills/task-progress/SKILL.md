---
name: task-progress
description: Maintain evidence-backed checklist progress for implementation tasks in ordinary Codex chats, including scope changes and progress history.
---

Use task_progress_get to restore the current chat task. The tools resolve the trusted chat identity; never invent or pass a thread ID.

For actionable implementation work, initialize a title and stable objective/checklist IDs with task_progress_initialize when no authoritative source task is bound. Add later requests with task_progress_rescope only for a local task. Questions and acknowledgements do not create checklist items.

When `task_progress_get` returns a `taskSource` with a path, the displayed task is a read-only projection of that Kit heartbeat ledger. Treat its rows and source statuses as authoritative, update the original ledger through the normal project workflow, and do not initialize, update, or rescope a parallel checklist. If the source is stale or unavailable, keep the task unresolved until it can be read again or the user intentionally unbinds it. The local task history remains dormant while bound and is restored after unbinding. Otherwise the Helper-owned `task_progress_*` records are authoritative. The packaged [Kit task progress guidance](references/kit-task-progress.md) defines the shared status and completion semantics.

If multiple associated heartbeat ledgers are found or discovery is truncated, wait for explicit selection through `task_progress_bind_heartbeat`; do not fall back to a second local checklist. Unrelated candidates with no confirmed chat association do not override local task records.

Use the returned revision as expectedRevision and a unique requestId per logical mutation. Retry the same operation with its unchanged requestId; after a revision conflict read again before preparing a new mutation. Preserve existing IDs and confirmed evidence. Rescope includes all retained objectives; removed entries are retained as cancelled.

The panel appears independently of this Skill. task_progress_history reads its history. Bind a discovered heartbeat candidate using task_progress_bind_heartbeat only when its project/session association is confirmed; this is read-only observation and does not start a timer or certify a new heartbeat. Native Goals use the separate goal-progress Skill.
