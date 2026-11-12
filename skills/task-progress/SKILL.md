---
name: task-progress
description: Use when registering a task, reading a heartbeat-backed task view, or reporting task completion.
---

# Shared task progress

Use the shared Kit task contract and store for ordinary short tasks; a heartbeat ledger is optional and should not be created just to show progress. Give task entries stable IDs and retain their history and evidence when scope changes. Reopen or add remaining verification, packaging, commit, or push work before reporting the registered checklist complete when those steps are part of the request.

When an existing heartbeat ledger is bound to the task, or one candidate is uniquely associated with it, use that ledger as the displayed task source. Automatic association requires one exact standalone `thread:`, `thread_id:`, or `threadId:` metadata field outside fenced examples; prose mentions and conflicting IDs do not bind a source. Claim a unique or absent source only after a complete discovery report; bounded or unreadable scans leave source selection uncertain and need an explicit binding or an uncertainty report. Keep any existing ordinary task record dormant while the heartbeat source is bound. The task projection consumer must not write or move the source ledger through task mutations; the project's existing ledger workflow remains responsible for maintaining it.

Keep row IDs, titles, raw statuses, and reported evidence tied to the source. Unknown statuses remain incomplete. Completion requires evidence from the source; an inventory or its percentage alone never certifies the whole delivery. Preserve invalid IDs, duplicate IDs, parser errors, and unsafe or missing child links as visible errors or source risks. For a valid tracking parent, count its linked children as progress leaves without counting the parent twice. `reported` evidence records a claim; `verified` requires an actual check against the relevant oracle. Never infer task progress from elapsed time, token use, or activity alone.

Report completion from recorded task state and evidence. Use the applicable project planning guidance when a plan is needed; this skill does not add a separate planning or heartbeat policy.
