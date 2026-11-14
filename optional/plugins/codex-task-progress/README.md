# Codex Task Progress

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), preserving its Git history, MIT license and original attribution. Upstream base: `cdb6d9d` (0.3.12). Version 0.5.7 adds bounded startup recovery checks and configurable local macOS release signing. This is not an official Codex extension API.

The 44px capsule stays docked and centered at the top of the chat, reserves layout space, and shows progress along its lower curved edge. Click it to expand the real task's modules (`objectives`), then click a module to inspect its nodes (`items`), statuses and evidence. Each module has its own progress bar. Clicking a module does not add a black outline, while keyboard focus remains available. The two 40px round buttons open task History and the project's read-only Heartbeat; only one panel opens at a time. History and Heartbeat records retain their paginated data sources. Unfinished tasks appear in reverse original checklist-addition order at the top; completed tasks remain in stable order at the bottom. These display choices do not rewrite records. The panel does not allow horizontal scrolling or dragging; any saved floating-placement preference from an older version is ignored. Existing native Goal tracking remains available through its separate Skill and original v1/v2 store; ordinary tasks use an independent v3 event store and never create a Goal.

The interface follows the host's light/dark theme and reduced-motion preference. Panels support keyboard navigation, Escape and focus return, with internal scrolling and a viewport-constrained layout for short windows. Node progress uses recorded state and evidence, without invented fractional percentages. Existing tool inputs, storage formats and source-authority behavior remain compatible; the `get` output may include an optional `heartbeatPending` status.

Heartbeat history is arranged in grouped time cards. Expand a record to inspect a bounded preview of available raw fields; the source file retains the complete record. Compact, collapsible diagnostic disclosures keep the summary readable. History and Heartbeat views retain pagination, host theme support and responsive layouts. This is a presentation update and does not change task or Heartbeat storage or source authority.

Project Heartbeat summary cache is reused within its configured scope for 30 seconds after refresh completes, and in-flight reads are reused per project. `task_progress_get` returns the task result independently after validating any related task source; the project Heartbeat view loads in the background. A source-generation change starts a refresh without waiting for older requests, and polling runs every two seconds. The watcher for a bound source invalidates that source's cache.

While the same-scope project Heartbeat refresh is pending, the panel keeps its last valid summary and history visible with a pending notice; manual refresh remains available. The old summary is marked non-certifying until refreshed. A new scope with no verified snapshot clears the old view, and the frontend does not maintain a separate source-authority cache.

Kit's `WorkspaceTaskStorage` owns the `HeartbeatDiscoveryIndex` shared across chat services and project display. The index reuses bounded discovery by canonical project and scan scope only while its recursive watcher is live. Writes can force a fresh scan; watcher errors/closure or unsupported recursive watching drop protected discovery and fall back to a fresh scan. Automatic discovery skips `.tmp`; explicit `.tmp` sources are read fresh. Candidate selection uses canonical summary parsing, with full audit only on the selected candidate. File/depth limits, nested-Git and symlink boundaries, and exact-thread association are preserved. Normalization and CPU guarding remain call-local; shared cache state does not guarantee zero I/O.

Cold source validation can still take seconds.

Version 0.5.6 avoids redundant permission updates when private directories already have the expected ownership and mode, reducing unnecessary filesystem watcher events. Mismatched permissions are repaired, and operating-system ownership checks remain enforced.

At background startup, recovery eligibility checks inspect only Helper-owned recoverability hints. A hint does not provide task contents or authority: after a trusted chat identity is established, normal recovery reads and validates that chat's canonical task files through Kit. It does not scan arbitrary workspaces or use a hint as a substitute for file validation.

Bounded Kit Heartbeat discovery memoizes the canonical project root and Git-boundary checks for one scan, then discards that memo before the next scan. Configured file/depth limits, nested-Git and symlink boundaries, and exact-thread association behavior are preserved.

Progress counts non-cancelled required checklist leaves equally. A completed item needs evidence labelled `reported` or `verified`. Time, token use and activity do not count as completion. An idle chat has no invented percentage. SessionStart supplies a short instruction for the current model to maintain task records; semantic updates still depend on that model calling the tools at meaningful milestones. The panel automatically shows the current project's Heartbeat separately from chat task progress. Only a structured Kit record related to the current task may project into the checklist as a read-only source; the project view alone never creates or replaces a chat checklist.

## Development

Requires Apple Silicon macOS, Codex Desktop, Node >=22.12 and pnpm 11. Use `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify:public` and `corepack pnpm test`. Browser tests: `corepack pnpm test:ui`.

`corepack pnpm build` builds source code, renderer and the source plugin. Generated plugin output is `plugins/codex-task-progress`. The repository has one authoritative source tree; the plugin build copies it into the generated package's `runtime/source`.

To build a self-contained macOS release, obtain Node v24.19.0 darwin-arm64 from nodejs.org, verify its archive against SHASUMS256.txt, and run:

```sh
GOAL_PROGRESS_NODE_BINARY=/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node corepack pnpm build:release:macos
```

Kit reuses an existing Task Progress installation without asking about signing or reinstalling. When a selected component is missing, interactive Kit setup asks once for explicit confirmation of an eligible local certificate; non-interactive setup returns an actionable setup-required result. `install-from-kit.mjs --check` lists status and candidates read-only. `install-from-kit.mjs --configure-signing --identity '<certificate fingerprint>'` validates and persists a choice privately only; future builds reuse it. This does not guarantee macOS protected-folder consent will carry across updates: TCC may associate consent with the executable's physical version path, and inheritance across upgrades has not been verified. This setup does not build, sign, install, restart Codex, create certificates, export private keys or grant privacy permissions.

Local release signing accepts an identity through `GOAL_PROGRESS_CODESIGN_IDENTITY` or a `release-signing.json` configuration (`schemaVersion: 1`, `identity`) under the Task Progress application-support directory. Set `GOAL_PROGRESS_CODESIGN_CONFIG` to choose an explicit absolute configuration path. Do not put signing identities in source or shared docs. If no identity is configured, the local build remains ad-hoc signed and warns that macOS may request permission again. An Apple Development signature is for local development; it is not a Developer ID or publicly notarized release. Helper and listener identifiers remain fixed as `com.codextaskprogress.helper` and `com.codextaskprogress.listener`.

The release is `dist/release/macos-arm64`; see [installation instructions](INSTALL-FOR-AI.md). Updates are manual: rebuild and install from the Kit checkout. No automatic release channel is configured. No credentials are embedded in the plugin.

## Heartbeats

The panel resolves the current project's Heartbeat automatically when available. Click its round button to inspect the source path, status, audit details and read-only access. It does not ask the user to select a ledger. Project Heartbeat display is separate from chat task authority: only a structured Kit record related to the current task may become `taskSource` and replace the chat checklist. An unrelated project ledger remains a project view and does not overwrite local task progress. If an existing ordinary task history is valid, no source is bound, and the current candidate scan reports zero associations, an incomplete discovery scan does not suppress that local checklist. A new chat without task events stays pending until discovery is complete; an existing binding, including a stale one, does not trigger fallback, and multiple associated candidates stay pending. The `get` request returns after related task-source validation while the project Heartbeat display loads in the background. Per-project cache and in-flight work are reused; generation changes trigger refreshes without waiting for older requests, and the view polls every two seconds. The Heartbeat summary stays concise, with full diagnostics in bounded, collapsible details. When a related task source is active, History reads that bound task's recorded ledger wakes through the Kit reader; migrated pairs report the physical head or history source for each wake, while a legacy single-file ledger points to that original file. Reading never initiates a cutover, creates a second timeline or writes back to the ledger. The project Heartbeat panel may display a different source from the task's bound ledger.

It reads the Kit checkout’s canonical `inspectHeartbeatLedger`, project source, audit cadence and task projection APIs from the same Kit checkout. Missing required Kit helpers fail visibly instead of falling back to plugin-owned parsing or policy. Current certification, audit success and historical readability are distinct. An unavailable project source shows an honest empty/error state; a stale related task source blocks writes to parallel local task history. A bound-source watcher invalidates that source's cache. Project summary reads are reused within their configured scope for 30 seconds; same-project in-flight reads are shared, with a two-second view poll and generation-based refresh. Observation never schedules a heartbeat, updates the ledger, or counts plugin liveness as an audit.

Optional project `.codex-task-progress.json`:

```json
{"heartbeat":{"ledgerPath":".workspace/session/heartbeat.md","kitPath":".vibe-coding/kit","cadenceMinutes":20}}
```

An explicit `nextWakeAt` ISO timestamp is also supported. No cadence is inferred when absent. Ordinary task data and heartbeat observations live under the trusted chat cwd `.workspace/codex-task-progress/`. The executable, socket, logs, native Goal legacy state and preferences remain in application support/private plugin data. No project ledger or personal task history belongs in Git.

## Interfaces

`task_progress_get`, `task_progress_initialize`, `task_progress_update`, `task_progress_rescope`, `task_progress_history`, `task_progress_heartbeat_history`, `task_progress_bind_heartbeat`. Identity is derived from trusted Codex metadata/signed Hook context; callers do not supply a thread ID. Local writes require `expectedRevision`, stable `requestId`, and a reason. A related read-only Kit task source rejects initialize/update/rescope with `TASK_SOURCE_READ_ONLY`; history reports source metadata and no fabricated local events. `task_progress_bind_heartbeat` remains available for compatibility and recovery of existing bindings, but is not part of normal project source selection. Conflicting revisions fail, exact retries are idempotent, and reusing a request ID with a different payload fails.

History is newest-first, paginated with an opaque revision cursor. The same Kit checkout stores task events and source associations in each chat's durable Markdown `taskhistory.md`; `heartbeat.md` is a readable current-state projection. Cancelling or removing scope retains the old entries and evidence in history. The panel verifies the visible thread again before delivering asynchronous results.

## Compatibility and removal

The renderer uses a loopback CDP connection and verified local app/process identity, like upstream. Codex upgrades may change its DOM; run Doctor and Verify after updates and distinguish connection checks from visible UI testing. Plugin hooks never silently restart Codex. If CDP is unavailable, installation reports that a confirmed restart is required.

To remove a release installation while preserving history, run the installed `bin/goal-progress uninstall --json --keep-history`. Native Goals and chat history remain separate. Original Goal record schemas stay readable; the derivative does not automatically import another plugin's private data directory.

## Hot updates

Once the verified CDP connection is established, build a new release and run `./install.sh` without `--restart-codex`. The installer switches the local release and restarts only the Helper; the browser reconnects and replaces the versioned Task panel in place. Main Codex PID/start time should remain unchanged. If CDP needs rebuilding, this command reports that requirement instead of silently restarting Codex.

Startup recovery also recognizes ordinary task history and source associations through Kit's read-only workspace API, including completed tasks and legacy records. When a verified CDP process is available, the Helper reconnects and restores the visible chat's panel. Automatic recovery never authorizes stopping or relaunching Codex. A running process without CDP reports `*_PENDING_CDP_UNAVAILABLE`; retrying record reads cannot create a debugging port in that process.

For an existing installation, `goal-progress upgrade --json` can update the Helper and packaged plugin while CDP is unavailable. Its `connectionRebuildPending` result means the software was updated but the top panel is still unavailable. Check Doctor and the actual visible panel separately; a completed upgrade is not evidence of restored display.

Backend and panel changes are live after reconnect. A changed MCP tool catalog or Skill/Hook session context needs reopening the affected chat; this is separate from restarting the application. Heartbeat panel data is bounded; use its paginated history or `task_progress_heartbeat_history` to browse earlier audits. Counts describe the complete source, while displayed text is summarized with source line references.

## Completion semantics

The header counts **registered checklist items**, not total task scope. Current execution is observed separately from trusted App Server status or positive visible composer Stop/Send controls. A complete checklist with ongoing, waiting or unknown execution never shows a numeric 100% header or full progress bar. Idle means the chat is not running, not that all requested work was delivered. The legacy stored phase describes only the checklist; MCP responses declare `completionBasis: registered-checklist`. Missing scope remains a limitation of model-maintained lists and must be registered before new work starts.

## Project workspace storage

The trusted Codex chat working directory determines the task workspace; neither the Helper process directory nor
the shell's last `cd` is used. The shared Kit `resolveTaskProgressStorage({cwd})` contract defines
`<cwd>/.workspace/codex-task-progress` for durable project task records and
`<cwd>/.tmp/codex-task-progress` for reconstructable caches. The plugin uses the same checkout’s canonical schemas, task store, source relations, heartbeat-pair API and workspace router. Release builds bundle the Kit source from the recorded Git HEAD for a self-contained runtime; the checkout remains authoritative.

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

Task Progress can be disabled per trusted project with `.vibe-coding/project.config.json` containing `"optional": { "task-progress": false }`. Existing task and association history is retained; projects without the setting keep their prior behavior.
