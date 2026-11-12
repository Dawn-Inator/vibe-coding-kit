# Codex Task Progress

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), preserving its Git history, MIT license and original attribution. Upstream base: `cdb6d9d` (0.3.12). Task Progress 0.4.0 adds ordinary-chat tracking; it is not an official Codex extension API.

The compact panel appears above the composer for ordinary chats. Click the total to expand objectives, checklist items and evidence; use History to inspect progress and scope changes. New work can lower the percentage. Floating placement is draggable. Existing native Goal tracking remains available through its separate Skill and original v1/v2 store; ordinary tasks use an independent v3 event store and never create a Goal.

Progress counts non-cancelled required checklist leaves equally. A completed item needs evidence labelled `reported` or `verified`. Time, token use and activity do not count as completion. An idle chat has no invented percentage. SessionStart supplies a short instruction for the current model to maintain task records; semantic updates still depend on that model calling the tools at meaningful milestones.

## Development

Requires Apple Silicon macOS, Codex Desktop, Node >=22.12 and pnpm 11. Use `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify:public` and `corepack pnpm test`. Browser tests: `corepack pnpm test:ui`.

`corepack pnpm build` builds source code, renderer and the source plugin. Generated plugin output is `plugins/codex-task-progress`. The repository has one authoritative source tree; the plugin build copies it into the generated package's `runtime/source`.

To build a self-contained macOS release, obtain Node v24.19.0 darwin-arm64 from nodejs.org, verify its archive against SHASUMS256.txt, and run:

```sh
GOAL_PROGRESS_NODE_BINARY=/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node corepack pnpm build:release:macos
```

The release is `dist/release/macos-arm64`; see [installation instructions](INSTALL-FOR-AI.md). First version uses manual rebuild/install updates from this private repository. No credentials are embedded in the plugin.

## Heartbeats

The heartbeat module stays hidden until an associated ledger is discovered. Discovery searches the current project with bounded depth, skipping dependency/build folders. Exact thread association may bind automatically; other candidates require selection. Unbinding persists an opt-out.

It reads the Kit's canonical `inspectHeartbeatLedger` API from the project submodule or configured Kit path, rather than implementing another parser. Current certification, audit success and historical readability are distinct. A missing Kit shows a read error; deleting a bound ledger retains the previous view marked stale. File watching invalidates a 30-second read cache. Observation never schedules a heartbeat, updates the ledger, or counts plugin liveness as an audit.

Optional project `.codex-task-progress.json`:

```json
{"heartbeat":{"ledgerPath":".workspace/session/heartbeat.md","kitPath":".vibe-coding/kit","cadenceMinutes":20}}
```

An explicit `nextWakeAt` ISO timestamp is also supported. No cadence is inferred when absent. Local task data, heartbeat bindings and observations live under `~/Library/Application Support/CodexTaskProgress/` for release installs. Source installs use private plugin data. No project ledger or personal task history belongs in Git.

## Interfaces

`task_progress_get`, `task_progress_initialize`, `task_progress_update`, `task_progress_rescope`, `task_progress_history`, `task_progress_bind_heartbeat`. Identity is derived from trusted Codex metadata/signed Hook context; callers do not supply a thread ID. Writes require `expectedRevision`, stable `requestId`, and a reason. Conflicting revisions fail, exact retries are idempotent, and reusing a request ID with a different payload fails.

History is newest-first, paginated with an opaque revision cursor. JSONL events are authoritative; snapshots can be rebuilt. Cancelling or removing scope retains the old entries and evidence in history. The panel verifies the visible thread again before delivering asynchronous results.

## Compatibility and removal

The renderer uses a loopback CDP connection and verified local app/process identity, like upstream. Codex upgrades may change its DOM; run Doctor and Verify after updates and distinguish connection checks from visible UI testing. Plugin hooks never silently restart Codex. If CDP is unavailable, installation reports that a confirmed restart is required.

To remove a release installation while preserving history, run the installed `bin/goal-progress uninstall --json --keep-history`. Native Goals and chat history remain separate. Original Goal record schemas stay readable; the derivative does not automatically import another plugin's private data directory.
