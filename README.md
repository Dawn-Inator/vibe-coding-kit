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

The panel displays the current project's Heartbeat automatically when available, including its source path, status, audit details and read-only access. It does not ask the user to select a ledger. Project Heartbeat display is separate from chat task authority: only a structured Kit record related to the current task may become `taskSource` and replace the chat checklist. An unrelated project ledger remains a project view and does not overwrite local task progress.

It reads the Kit's canonical `inspectHeartbeatLedger`, project source, audit cadence and task projection APIs from the pinned Kit. Missing required Kit helpers fail visibly instead of falling back to plugin-owned parsing or policy. Current certification, audit success and historical readability are distinct. An unavailable project source shows an honest empty/error state; a stale related task source blocks writes to parallel local task history. File watching invalidates a 30-second read cache. Observation never schedules a heartbeat, updates the ledger, or counts plugin liveness as an audit.

Optional project `.codex-task-progress.json`:

```json
{"heartbeat":{"ledgerPath":".workspace/session/heartbeat.md","kitPath":".vibe-coding/kit","cadenceMinutes":20}}
```

An explicit `nextWakeAt` ISO timestamp is also supported. No cadence is inferred when absent. Ordinary task data and heartbeat observations live under the trusted chat cwd `.workspace/codex-task-progress/`. The executable, socket, logs, native Goal legacy state and preferences remain in application support/private plugin data. No project ledger or personal task history belongs in Git.

## Interfaces

`task_progress_get`, `task_progress_initialize`, `task_progress_update`, `task_progress_rescope`, `task_progress_history`, `task_progress_heartbeat_history`, `task_progress_bind_heartbeat`. Identity is derived from trusted Codex metadata/signed Hook context; callers do not supply a thread ID. Local writes require `expectedRevision`, stable `requestId`, and a reason. A related read-only Kit task source rejects initialize/update/rescope with `TASK_SOURCE_READ_ONLY`; history reports source metadata and no fabricated local events. `task_progress_bind_heartbeat` remains available for compatibility and recovery of existing bindings, but is not part of normal project source selection. Conflicting revisions fail, exact retries are idempotent, and reusing a request ID with a different payload fails.

History is newest-first, paginated with an opaque revision cursor. JSONL events are authoritative; snapshots can be rebuilt. Cancelling or removing scope retains the old entries and evidence in history. The panel verifies the visible thread again before delivering asynchronous results.

## Compatibility and removal

The renderer uses a loopback CDP connection and verified local app/process identity, like upstream. Codex upgrades may change its DOM; run Doctor and Verify after updates and distinguish connection checks from visible UI testing. Plugin hooks never silently restart Codex. If CDP is unavailable, installation reports that a confirmed restart is required.

To remove a release installation while preserving history, run the installed `bin/goal-progress uninstall --json --keep-history`. Native Goals and chat history remain separate. Original Goal record schemas stay readable; the derivative does not automatically import another plugin's private data directory.

## Hot updates

Once the verified CDP connection is established, build a new release and run `./install.sh` without `--restart-codex`. The installer switches the local release and restarts only the Helper; the browser reconnects and replaces the versioned Task panel in place. Main Codex PID/start time should remain unchanged. If CDP needs rebuilding, this command reports that requirement instead of silently restarting Codex.

Backend and panel changes are live after reconnect. A changed MCP tool catalog or Skill/Hook session context needs reopening the affected chat; this is separate from restarting the application. Heartbeat panel data is bounded; use its paginated history or `task_progress_heartbeat_history` to browse earlier audits. Counts describe the complete source, while displayed text is summarized with source line references.

## Completion semantics

The header counts **registered checklist items**, not total task scope. Current execution is observed separately from trusted App Server status or positive visible composer Stop/Send controls. A complete checklist with ongoing, waiting or unknown execution never shows a numeric 100% header or full progress bar. Idle means the chat is not running, not that all requested work was delivered. The legacy stored phase describes only the checklist; MCP responses declare `completionBasis: registered-checklist`. Missing scope remains a limitation of model-maintained lists and must be registered before new work starts.

## Project workspace storage (0.4.3)

Ordinary task history is routed using the trusted Codex chat working directory, not the Helper's process directory or the shell's last `cd`. The shared Kit `resolveTaskProgressStorage({cwd})` contract defines `<cwd>/.workspace/codex-task-progress`. The plugin pins Kit as a Git package dependency and bundles its canonical task schemas, progress rules and store; it does not maintain a copied Kit runtime.

Task records remain `tasks/v3/<thread-sha256>/{events.jsonl,snapshot.json}` under that root. Heartbeat bindings and derived observations are isolated per chat under `sessions/<thread-sha256>/heartbeat`. Original project heartbeat ledgers are read-only and remain at their source paths. Runtime records self-ignore Git.

On first access, the Helper copies only this chat's previous app-support records, preserves revisions/history and leaves original files intact. Existing workspace history is never overwritten or silently merged with divergent data. A global path-only index remembers the workspace binding so changing a trusted chat cwd can preserve its latest history. If the workspace is unavailable or unwritable, the plugin reports an error instead of silently reverting to global task storage. `task_progress_get` exposes the resolved storage paths for inspection.

The installed executable, local socket, Helper logs, native Goal legacy state and UI preferences remain in application support. They are separate from ordinary task records and project heartbeat observations.
