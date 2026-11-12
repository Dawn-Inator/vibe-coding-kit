# Task Progress permissions

This derivative uses the upstream local architecture: private Unix socket, a loopback CDP connection owned by the verified Codex process, a launchd Helper, local plugin hooks, and Codex App Server reads for trusted chat identity and native Goals. It does not modify Codex application files or signatures.

Release data is under `~/Library/Application Support/CodexTaskProgress`, with launchd label `com.codextaskprogress.helper`. Source-plugin builds use private plugin data. Ordinary task events and snapshots are stored separately from upstream native Goal records. Model evidence is marked reported or verified; these records stay local.

The heartbeat adapter reads only discovered project ledgers and the canonical Kit inspection API. Selected paths, cached views and observed hashes are stored in private application data. It never edits ledger content or creates heartbeat schedules.

Installation can require restarting Codex to establish CDP. The installer reports this requirement; the source bootstrap refuses to restart automatically. Ask before using `--restart-codex`.

See [installation and removal](../INSTALL-FOR-AI.md) and [README](../README.md). To uninstall a release while preserving task/history data, use the installed `bin/goal-progress uninstall --json --keep-history`. Native Codex Goals and chats are separate from this plugin's data.

From0.4.3, ordinary task events/snapshots and per-chat heartbeat bindings/observations are written under the verified chat cwd `.workspace/codex-task-progress/`. Paths come from the canonical pinned Kit contract. Migration copies only the current chat, preserves old app-support files and refuses to overwrite divergent workspace history. Private runtime output ignores Git; original heartbeat ledgers remain read-only. A path-only global index supports trusted cwd changes.
