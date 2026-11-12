---
name: task-progress
description: Maintain evidence-backed checklist progress for implementation tasks in ordinary Codex chats, including scope changes and progress history.
---

Use task_progress_get to restore the current chat task. The tools resolve the trusted chat identity; never invent or pass a thread ID.

For actionable implementation work, initialize a title and stable objective/checklist IDs if no task exists. Add later requests to this chat’s task with task_progress_rescope. Questions and acknowledgements do not create checklist items.

Use the returned revision as expectedRevision and a unique requestId per logical mutation. Retry the same operation with its unchanged requestId; after a revision conflict read again before preparing a new mutation. Preserve existing IDs and confirmed evidence. Rescope includes all retained objectives; removed entries are retained as cancelled.

Update at meaningful milestones, scope changes, blockers and validation results. Completed items require concise evidence; distinguish reported from verified. Only actual test/build/readback results qualify as verified evidence. Do not infer progress from time, token use or activity. Added/reopened work may reduce completion.

The panel appears independently of this Skill. task_progress_history reads its history. Bind a discovered heartbeat candidate using task_progress_bind_heartbeat only when its project/session association is confirmed; this is read-only observation and does not start a timer or certify a new heartbeat. Native Goals use the separate goal-progress Skill.
