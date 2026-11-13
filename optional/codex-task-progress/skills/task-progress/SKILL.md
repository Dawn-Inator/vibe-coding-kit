---
name: task-progress
description: Maintain evidence-backed checklist progress for implementation tasks in ordinary Codex chats, including scope changes and progress history.
---

Use task_progress_get to restore the current chat task. The tools resolve the trusted chat identity; never invent or pass a thread ID.

For actionable implementation work, initialize a title and stable objective/checklist IDs with task_progress_initialize when no related Kit task source or local task exists. Add later requests with task_progress_rescope only for a local task. Questions and acknowledgements do not create checklist items.

The panel displays the current project's Heartbeat automatically when available. That project view does not by itself become the chat's task checklist. Only treat `taskSource` as task authority when it identifies a related current-task Kit record. For such a source, treat its rows and statuses as authoritative, update the original record through the normal project workflow, and do not create a parallel checklist. If it is stale or unavailable, leave task progress unresolved until the source can be read again. Otherwise the Helper-owned `task_progress_*` records are authoritative. The packaged [Kit task progress guidance](references/kit-task-progress.md) defines the shared status and completion semantics.

Do not ask the user to select a project Heartbeat ledger. Project display and chat task association are resolved by the runtime from the current project and structured Kit records. A project source without a confirmed current-task relationship must not overwrite chat task progress.

Use the returned revision as expectedRevision and a unique requestId per logical mutation. Retry the same operation with its unchanged requestId; after a revision conflict read again before preparing a new mutation. Preserve existing IDs and confirmed evidence. Rescope includes all retained objectives; removed entries are retained as cancelled.

The panel appears independently of this Skill. `task_progress_history` reads chat task history. `task_progress_bind_heartbeat` remains available for compatibility and recovery of existing bindings; it is not part of normal project source selection. Heartbeat observation is read-only and does not start a timer or certify a new heartbeat. Native Goals use the separate goal-progress Skill.
