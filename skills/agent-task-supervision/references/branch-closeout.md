# Branch and session audit

Use the configured branch/session probe, when the project provides one, at each heartbeat wake. A probe is a
read-only source of evidence; its command string may vary by project. Record every branch or child session
created by a dispatch, along with its owner, associated Item, target repository, and worktree in the project
registry. If a worker creates another branch, record it when its report is ingested.

For every registered branch or session, report the observed state with its source and timestamp. Distinguish
active, terminal, landed, and unresolved work. A terminal worker report is not proof that the work landed;
verify against the project's target ref using its established evidence. If a branch/session probe is not
configured or cannot run, say so in the ledger and leave status unknown. Never infer safety from a missing
branch or session.

This reference defines an audit only. It does not grant permission to finish or merge work, archive sessions,
clean worktrees or branches, or delete refs. It does not grant kill/restart authority or create a finish veto.
Use separately applicable repository procedures and current authorization for any state-changing operation.
An incomplete closeout remains an evidence-backed Item or final-report note; it does not prevent the user or
orchestrator from ending the session.
