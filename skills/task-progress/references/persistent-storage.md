## Persistent Markdown storage

The Kit owns durable task state and source associations. Ordinary task events, explicit or automatic heartbeat
bindings, and the binding-migration marker are records in the per-chat `taskhistory.md`; `heartbeat.md` is the
readable projection of the latest task state. The helper serializes writers for a storage root. Treat the
history as the canonical record and the head as a projection, never append prior task events manually to the
head.

Use the same task APIs and journal format for a child's actual module milestones. Resolve storage from the
child session's trusted thread and working directory. The parent owns its canonical assignment and acceptance
records; the child's authenticated session owns its module journal. The panel reads child execution progress
only when the child journal belongs to the in-scope dispatch under the shared task progress skill's scope rules.

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
resolution rather than choosing one silently. See the [task storage guide](../../../tutorial/03-agent-orchestration/task-progress-storage.md) and the
[heartbeat ledger API reference](../../agent-task-supervision/references/ledger-api.md) for file layout,
migration functions, and the compatibility contract.
