---
name: task-progress
description: Use when registering a task, reading a heartbeat-backed task view, or reporting task completion.
---

# Shared task progress

Use the shared Kit task contract and store for ordinary short tasks; a heartbeat ledger is optional and should not be created just to show progress. A project heartbeat display can automatically show the configured or latest recorded source for the trusted current project, independently of chat task selection. It reports recorded history, not live activity, and does not replace an unrelated chat task record. Give task entries stable IDs and retain their history and evidence when scope changes. Reopen or add remaining verification, packaging, commit, or push work before reporting the registered checklist complete when those steps are part of the request.

When an existing heartbeat ledger is bound to the task, or one candidate is uniquely associated with it, use that ledger as the displayed task source. Automatic association requires one exact standalone `thread:`, `thread_id:`, or `threadId:` metadata field outside fenced examples; prose mentions and conflicting IDs do not bind a source. Claim a unique or absent source only after a complete discovery report; bounded or unreadable scans leave source selection uncertain and need an explicit binding or an uncertainty report. Keep any existing ordinary task record dormant while the heartbeat source is bound. The task projection consumer must not write or move the source ledger through task mutations; the project's existing ledger workflow remains responsible for maintaining it.

Keep row IDs, titles, raw statuses, and reported evidence tied to the source. Unknown statuses remain incomplete. Completion requires evidence from the source; an inventory or its percentage alone never certifies the whole delivery. Preserve invalid IDs, duplicate IDs, parser errors, and unsafe or missing child links as visible errors or source risks. For a valid tracking parent, count its linked children as progress leaves without counting the parent twice. `reported` evidence records a claim; `verified` requires an actual check against the relevant oracle. Never infer task progress from elapsed time, token use, or activity alone.

Report completion from recorded task state and evidence. Use the applicable project planning guidance when a plan is needed; this skill does not add a separate planning or heartbeat policy.

## Persistent Markdown storage

The Kit owns durable task state and source associations. Ordinary task events, explicit or automatic heartbeat
bindings, and the binding-migration marker are records in the per-chat `taskhistory.md`; `heartbeat.md` is the
readable projection of the latest task state. The helper serializes writers for a storage root. Treat the
history as the canonical record and the head as a projection, never append prior task events manually to the
head.

Project heartbeat ledgers use the same head/history split: `heartbeat.md` contains the current readable head
and `taskhistory.md` contains the complete wake history plus its source marker. Read through Kit's pair API
so archived wake rows retain their physical source path and line. Migrate only through the explicit Kit
migration API; it preserves the original bytes in `heartbeat.md.legacy`, archives earlier wakes, and keeps the
latest state in the head. Use Kit's writer API for new wakes so the archive and head stay synchronized.

For trusted chat cwd routing, use Kit's `WorkspaceTaskStorage` adapter. Per-project task records live under
`.workspace/codex-task-progress/tasks/v3/<thread-sha256>/`; reconstructable caches live under
`.tmp/codex-task-progress/<thread-sha256>/`. App-root routing history is durable state, not a cache. Deleting
the cache must not remove task history, source relations, or workspace routing. A workspace move carries
ordinary task history and routing, but does not import the previous project's source association.

Legacy JSONL task events, snapshots, and workspace routing indexes are compatibility inputs only. Preserve
the old files as backups; if the old and Markdown histories conflict, fail closed and keep both copies for
resolution rather than choosing one silently. See the [storage API reference](references/ledger-api.md) for
file layout, migration functions, and the compatibility contract.
