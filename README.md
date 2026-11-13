# Codex Task Progress

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), preserving its Git history, MIT license and original attribution. Upstream base: `cdb6d9d` (0.3.12). Task Progress 0.4.4 adds ordinary-chat tracking; it is not an official Codex extension API.

The compact panel appears at the top of the chat and reserves layout space instead of covering messages. Click the total to expand objectives, checklist items and evidence; use History to inspect progress and scope changes. New work can lower the percentage. Floating placement is draggable. Existing native Goal tracking remains available through its separate Skill and original v1/v2 store; ordinary tasks use an independent v3 event store and never create a Goal.

Progress counts non-cancelled required checklist leaves equally. A completed item needs evidence labelled `reported` or `verified`. Time, token use and activity do not count as completion. An idle chat has no invented percentage. SessionStart supplies a short instruction for the current model to maintain task records; semantic updates still depend on that model calling the tools at meaningful milestones. The panel automatically shows the current project's Heartbeat separately from chat task progress. Only a structured Kit record related to the current task may project into the checklist as a read-only source; the project view alone never creates or replaces a chat checklist.

## Development

Requires Apple Silicon macOS, Codex Desktop, Node >=22.12 and pnpm 11. Use `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify:public` and `corepack pnpm test`. Browser tests: `corepack pnpm test:ui`.

`corepack pnpm build` builds source code, renderer and the source plugin. Generated plugin output is `plugins/codex-task-progress`. The repository has one authoritative source tree; the plugin build copies it into the generated package's `runtime/source`.

To build a self-contained macOS release, obtain Node v24.19.0 darwin-arm64 from nodejs.org, verify its archive against SHASUMS256.txt, and run:

```sh
GOAL_PROGRESS_NODE_BINARY=/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node corepack pnpm build:release:macos
```

The release is `dist/release/macos-arm64`; see [installation instructions](INSTALL-FOR-AI.md). First version uses manual rebuild/install updates from this private repository. No credentials are embedded in the plugin.

## Heartbeats

The panel displays the current project's Heartbeat automatically when available, including its source path, status, audit details and read-only access. It does not ask the user to select a ledger. Project Heartbeat display is separate from chat task authority: only a structured Kit record related to the current task may become `taskSource` and replace the chat checklist. An unrelated project ledger remains a project view and does not overwrite local task progress. If an existing ordinary task history is valid, no source is bound, and the current candidate scan reports zero associations, an incomplete discovery scan does not suppress that local checklist. A new chat without task events stays pending until discovery is complete; an existing binding, including a stale one, does not trigger fallback, and multiple associated candidates stay pending. The Heartbeat summary stays concise, with full diagnostics in bounded, collapsible details. When a related task source is active, History reads that bound task's recorded ledger wakes through the Kit reader; migrated pairs report the physical head or history source for each wake, while a legacy single-file ledger points to that original file. Reading never initiates a cutover, creates a second timeline or writes back to the ledger. The project Heartbeat card may display a different source from the task's bound ledger.

It reads the Kit's canonical `inspectHeartbeatLedger`, project source, audit cadence and task projection APIs from the pinned Kit. Missing required Kit helpers fail visibly instead of falling back to plugin-owned parsing or policy. Current certification, audit success and historical readability are distinct. An unavailable project source shows an honest empty/error state; a stale related task source blocks writes to parallel local task history. File watching invalidates a 30-second read cache. Observation never schedules a heartbeat, updates the ledger, or counts plugin liveness as an audit.

Optional project `.codex-task-progress.json`:

```json
{"heartbeat":{"ledgerPath":".workspace/session/heartbeat.md","kitPath":".vibe-coding/kit","cadenceMinutes":20}}
```

An explicit `nextWakeAt` ISO timestamp is also supported. No cadence is inferred when absent. Ordinary task data and heartbeat observations live under the trusted chat cwd `.workspace/codex-task-progress/`. The executable, socket, logs, native Goal legacy state and preferences remain in application support/private plugin data. No project ledger or personal task history belongs in Git.

## Interfaces

`task_progress_get`, `task_progress_initialize`, `task_progress_update`, `task_progress_rescope`, `task_progress_history`, `task_progress_heartbeat_history`, `task_progress_bind_heartbeat`. Identity is derived from trusted Codex metadata/signed Hook context; callers do not supply a thread ID. Local writes require `expectedRevision`, stable `requestId`, and a reason. A related read-only Kit task source rejects initialize/update/rescope with `TASK_SOURCE_READ_ONLY`; history reports source metadata and no fabricated local events. `task_progress_bind_heartbeat` remains available for compatibility and recovery of existing bindings, but is not part of normal project source selection. Conflicting revisions fail, exact retries are idempotent, and reusing a request ID with a different payload fails.

History is newest-first, paginated with an opaque revision cursor. The pinned Kit stores task events and source associations in each chat's durable Markdown `taskhistory.md`; `heartbeat.md` is a readable current-state projection. Cancelling or removing scope retains the old entries and evidence in history. The panel verifies the visible thread again before delivering asynchronous results.

## Compatibility and removal

The renderer uses a loopback CDP connection and verified local app/process identity, like upstream. Codex upgrades may change its DOM; run Doctor and Verify after updates and distinguish connection checks from visible UI testing. Plugin hooks never silently restart Codex. If CDP is unavailable, installation reports that a confirmed restart is required.

To remove a release installation while preserving history, run the installed `bin/goal-progress uninstall --json --keep-history`. Native Goals and chat history remain separate. Original Goal record schemas stay readable; the derivative does not automatically import another plugin's private data directory.

## Hot updates

Once the verified CDP connection is established, build a new release and run `./install.sh` without `--restart-codex`. The installer switches the local release and restarts only the Helper; the browser reconnects and replaces the versioned Task panel in place. Main Codex PID/start time should remain unchanged. If CDP needs rebuilding, this command reports that requirement instead of silently restarting Codex.

Backend and panel changes are live after reconnect. A changed MCP tool catalog or Skill/Hook session context needs reopening the affected chat; this is separate from restarting the application. Heartbeat panel data is bounded; use its paginated history or `task_progress_heartbeat_history` to browse earlier audits. Counts describe the complete source, while displayed text is summarized with source line references.

## Completion semantics

The header counts **registered checklist items**, not total task scope. Current execution is observed separately from trusted App Server status or positive visible composer Stop/Send controls. A complete checklist with ongoing, waiting or unknown execution never shows a numeric 100% header or full progress bar. Idle means the chat is not running, not that all requested work was delivered. The legacy stored phase describes only the checklist; MCP responses declare `completionBasis: registered-checklist`. Missing scope remains a limitation of model-maintained lists and must be registered before new work starts.

## Project workspace storage

The trusted Codex chat working directory determines the task workspace; neither the Helper process directory nor
the shell's last `cd` is used. The shared Kit `resolveTaskProgressStorage({cwd})` contract defines
`<cwd>/.workspace/codex-task-progress` for durable project task records and
`<cwd>/.tmp/codex-task-progress` for reconstructable caches. The plugin pins Kit as a Git package dependency and
adapts its canonical schemas, task store, source relations, heartbeat-pair API and workspace router; it does not
maintain a copied Kit runtime.

Ordinary task history is stored per thread at `tasks/v3/<thread-sha256>/taskhistory.md`; `heartbeat.md` is a
readable projection of the latest task state, not an event log. The Markdown history holds structured task events,
source bindings and the legacy-binding migration marker. It is the persistent task authority. A project's own
Heartbeat ledger is separately stored as `heartbeat.md` plus a same-directory `taskhistory.md` containing the
complete wake history. For a custom head such as `release.md`, the companion is `release.taskhistory.md`.
Project history rows keep their actual source paths and lines in Kit inspection reports. The plugin uses Kit's
read-only API for display; it does not write to or migrate a project ledger during observation. A legacy source
remains a single file, and its wake paths refer to that file, until a writer explicitly takes ownership after
quiescence. Only that writer's explicit, locked and version-checked cutover may create the companion pair. A
concurrent append, mismatched version or conflict must fail closed with both copies preserved.

For a deliberate cutover, the writer first reads the current pair version and passes it with its ownership
assertion:

```js
const observed = readHeartbeatLedgerPair({ root, path });
migrateHeartbeatLedgerPair({
  root,
  path,
  legacyWritersQuiescent: true,
  expectedContentHash: observed.contentHash,
});
```

`legacyWritersQuiescent` asserts that all raw legacy writers stay stopped for the entire operation; the Kit's
cross-process lock coordinates Kit writers only. Each later write uses a newly read `contentHash`. If a
history-first write is interrupted, read the raw version with `readHeartbeatLedgerPairVersion` and pass that
hash plus the same ownership assertion to `recoverHeartbeatLedgerPair`. Recovery verifies its backup and
planned/previous head; do not repair partial files manually.

Kit `WorkspaceTaskStorage` owns routing from the authenticated current cwd and stores durable helper routing
history in its app root at `task-routing/heartbeat.md` and `task-routing/taskhistory.md`. This routing history is
not a rebuildable cache and is not the task history for a project. The previous `workspace-storage-index.json`
remains a read-only migration source. A cwd move preserves task history and routing while deliberately excluding
the previous project's source association. Workspace task directories self-ignore Git.

Legacy task `events.jsonl`/`snapshot.json`, heartbeat binding JSON, derived heartbeat-observation JSONL, and the
workspace index are read only for migration/compatibility; they are not new write targets. Helper-owned ordinary
task/history/source-relation/workspace-index compatibility migration may run on first access. An unrelated active
project heartbeat is different: it remains a legacy single file until its writer explicitly quiesces and owns a
locked/version-checked cutover. Old files remain as backups. A conflicting task history or invalid migration
source fails closed and preserves both copies rather than silently choosing a version. The cache under
`.tmp/codex-task-progress/<thread-sha256>/` can be rebuilt or deleted
without losing task events, source relations, workspace routing or project heartbeat history. If the trusted
workspace is unavailable or unwritable, the plugin reports an error rather than redirecting state globally.
`task_progress_get` exposes the resolved storage paths for inspection.

The installed executable, local socket, Helper logs, native Goal legacy state and UI preferences remain in
application support. They are separate from project task history and project Heartbeat records.
