---
name: task-progress
description: Maintain evidence-backed task progress for actionable work in Codex parent and child sessions, including scope changes, assignments, and progress history.
---

Use task_progress_get to restore the current chat task. The tools resolve the trusted chat identity; never invent or pass a thread ID.

For actionable work, initialize a title and stable objective/checklist IDs with `task_progress_initialize` when no related Kit task source or local task exists. Record real milestones and evidence during execution using `task_progress_update` or the related source's normal workflow, and reconcile the recorded state before the final response. The Helper opts ordinary local task writes into lifecycle tracking automatically. After a task is completed, use the current revision with `task_progress_rescope` to start a new scope. Questions and acknowledgements do not create checklist items.

The panel displays the current project's Heartbeat automatically when available. That project view does not by itself become the chat's task checklist. Only treat `taskSource` as task authority when it identifies a related current-task Kit record. For such a source, treat its rows and statuses as authoritative, update the original record through the normal project workflow, and do not create a parallel checklist. If it is stale or unavailable, leave task progress unresolved until the source can be read again. Otherwise the Helper-owned `task_progress_*` records are authoritative. The [bundled Kit guidance](references/kit-task-progress.md) defines lifecycle, completion evidence, and archive semantics.

Do not ask the user to select a project Heartbeat ledger. Project display and chat task association are resolved by the runtime from the current project and structured Kit records. A project source without a confirmed current-task relationship must not overwrite chat task progress.

When delegating, tell the child to maintain its module checklist, then apply the Kit assignment and acceptance workflow. Record the exact returned native child thread ID on the assigned canonical leaves immediately after dispatch. Keep missing IDs unknown. In a child session, use the ordinary task tools in your own authenticated context for your assigned module. Register its actual milestones, record evidence as they are reached, and reconcile before the private final. Parent acceptance requires a separate evidence check before the parent marks the unit complete.

Use the returned revision as expectedRevision and a unique requestId per logical mutation. Retry the same operation with its unchanged requestId; after a revision conflict read again before preparing a new mutation. Preserve existing IDs and confirmed evidence. Rescope includes all retained objectives; removed entries are retained as cancelled.

The panel appears independently of this Skill. `task_progress_history` reads chat task history. `task_progress_bind_heartbeat` remains available for compatibility and recovery of existing bindings; it is not part of normal project source selection. Heartbeat observation is read-only and does not start a timer or certify a new heartbeat. Native Goals use the separate goal-progress Skill.
