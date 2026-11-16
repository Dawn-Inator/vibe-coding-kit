# Codex Task Progress

In version 0.7.6, a known, verified chat and project scope can immediately show its last in-memory snapshot when returning to a window while canonical refresh runs in the background when due. A background error retains the last display without asserting it is current. Unsupported, untrusted, moved, or disabled contexts do not inherit another scope’s snapshot. The panel restores the selected task, History or Heartbeat tab and relevant expanded selections only for the matching context. Polling remains independent at five seconds; a five-second snapshot lease avoids duplicate work and pending reads retain fast follow-ups. Cold scopes without a snapshot still need an initial read, so no universal instant or one-second display is promised. Task models and writes continue to use canonical authority; no disk or browser storage is added.

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), retaining its Git history, MIT license and upstream attribution. Current release: 0.7.9. Version 0.6.0 introduced the breaking native-only interface: the supported UI is the read-only MCP App; the CDP injected panel, custom Dock launcher and commands for managing them are retired. A legacy installation must be removed safely with its old installer before installing this version. The installer detects legacy markers and stops instead of overwriting the old installation.

Version 0.7.7 advertises the stable `ui://codex-task-progress/panel-v1.html` resource URI across patch releases. A strict read-only template also accepts compatible previously shipped semver panel aliases from 0.5.16 through the server release, serving that server’s matching panel HTML. This stable address lets a new catalog reach a compatible older live MCP server, but that server can still serve its own older embedded asset; it does not guarantee a hot reload. Check the rendered element’s `data-task-progress-version` to identify the actual frontend. If necessary, reenter the chat or switch away and back to refresh the host catalog; closing the panel tab alone may not suffice. Do not restart Codex. Actual native host visibility and data require separate verification.

Version 0.7.8 supports explicitly selected Heartbeat ledgers and head/history pairs up to a combined 32 MiB through the shared Kit reader. General discovery remains separately bounded; explicit recovery validates the requested project ledger without depending on a broad scan. Kit owns the canonical writer and records; the panel remains read-only. Migrating a live ledger requires quiescent writers and preservation of its history; installation and panel reads do not silently migrate it. Actual migration and native panel data must be verified separately.

Version 0.7.9 streamlines routine source details beneath task modules and presents Project Heartbeat validation as a compact audit summary that surfaces real risks. Verify the actual native panel and its data separately.

An optional standalone `task_root: <Items ID>` selects a tracking root and its linked descendants from the existing Items registry for task projection. Without the field, all Items remain in scope. Fenced examples are ignored; a ledger with only a fenced example still uses all Items. Invalid or empty active declarations, duplicate or conflicting declarations, and missing, non-tracking or cyclic roots fail closed. Producers derive the selected Items from their authoritative source in the same registry; do not hand-maintain separate business counts or create a second store.

## Unreleased local candidate

The local unreleased candidate defaults to Subagents; Registered tasks remains available and retains the full parent goal denominator. The top count and per-agent progress come from the Kit normalized snapshot. A recorded Heartbeat count is shown with its observation time only when its source is related to the current chat; it is not a live count. A separate app-server cannot establish which Desktop agents are running in real time. An individual child’s canonical checklist can supply its progress; missing, bound, uncertain or different-cwd data stays unknown rather than becoming 0% or 100%. No additional state store is created. The panel uses available height, scrolls the middle list and keeps its footer at the bottom. A local standalone fixture preview exists; it is not production data.

## Native panel

The native MCP App uses the Codex Desktop MCP Apps entrypoint and the optional `enable_mcp_apps` feature. Kit installs or reuses the plugin and its Helper without asking about a Dock entry. Check `codex features list` before installation. If the feature is disabled and the user chooses to use native MCP Apps, enable it explicitly with `codex features enable enable_mcp_apps`; the installer never changes host feature settings and returns `NATIVE_MCP_SETUP_REQUIRED` when native MCP support is unavailable or disabled. Reopen or start a chat as required by Codex, then verify the panel in an ordinary chat. Plugin registration, a successful build, and Helper health do not prove that the host displays the UI. Visibility is host-dependent and is not guaranteed on unsupported hosts.

The native App resolves the supported host's current thread identity on each request, then reads only that user's matching, non-subagent, non-ephemeral task, History and project Heartbeat records through the local Helper and canonical Kit APIs. Task writes remain protected by Hook and turn proof. Existing native Codex Goal model APIs, record formats and compatibility are retained; the plugin does not create Goals or provide a custom Goal UI.

Task data follows the Kit canonical records. The native panel shows the registered checklist, recorded status and evidence, paginated History, and a read-only project Heartbeat view. Heartbeat remains observational and does not schedule or write to a ledger. The History panel uses a bounded summary projection (at most 512 KiB source input and 512 Unicode characters per summary) and keeps the full canonical Markdown path available; the underlying Kit records are not truncated or rewritten.

The Heartbeat view shows recorded active child-agent counts before the audit and after re-splitting/dispatch,
with observation times and evidence, and audited blocked tasks with known or unknown Owner intervention needs.
These are snapshots, not live counts. The ten audit categories and full Items registry remain in the canonical
ledger for audit rather than the main view. A first session or older wake without producer-supplied snapshots
shows unknown; it cannot reconstruct past activity. The supervising producer records snapshots through the Kit
heartbeat writer, and the plugin only reads them.

In 0.6.6, the project Heartbeat summary uses two outlined white timecards. The left card contains the latest
recorded date; the next-time card shows the actual time or “Not recorded” when the value is unknown. The
cards have no filename footer or shared gray background and adapt to the host theme, RTL direction, and narrow
panels.

The 0.6.5 signed production Helper uses its embedded matching panel asset even when an older chat launcher
root remains in use. The source runtime continues to use its pinned runtime assets; embedding applies to the
production SEA. If the native panel appears stale after an update, use the chat refresh guidance above;
closing and reopening the panel tab alone may not refresh the host. Do not restart Codex. Verify actual panel
visibility and data separately from Helper health.

## Installation and validation

Use the [AI installation guide](INSTALL-FOR-AI.md). The plugin requires Apple Silicon macOS, Codex Desktop with MCP Apps support, Node.js 22.12+, and pnpm 11 for development/building. Local release signing reuses the existing configured identity; signing does not grant TCC permissions or self-authorize protected folders.

Keep these evidence separate: package/build checks, Helper `doctor` and `verify`, plugin registration, and actual native UI visibility/data in a supported host. A host feature change may require a new chat or reopening a chat. Do not infer UI visibility from command success.

## Task lifecycle

The plugin Helper opts ordinary local task writes into lifecycle semantics with `lifecycle: true`; other
Kit clients can leave the API opt-in disabled for v3 compatibility. Existing schema v3 histories remain
readable and are preserved; a read-only `task_progress_get` never invents a closed state for an older task.
A managed task has one explicit closeout checkpoint: complete it only after required
branch work, merge, and push are physically done or verified not applicable, with verified references,
zero remaining work, and zero Owner actions. Checklist rows at 100% do not close the task, and there is no
human Finish button. A separate execution status continues to describe whether work is active or unknown.

After a completed task receives new scope, use `task_progress_rescope` with its current revision to begin a
fresh cycle. Mid-cycle rescope includes all retained objectives and keeps removed rows as cancelled. A new
cycle after completion starts with the newly scoped denominator; the earlier cycle is retained as a read-only
archive derived from task history. `task_progress_archive` reads bounded pages of archive summaries and
details; archive cycles load on demand, and current subtasks remain a separate view. No raw history is
rewritten and no separate archive store is created. Bound read-only Heartbeat sources have no formal cycle
API, so lifecycle completion and archives are unavailable for them rather than inferred or backed by a
dormant local task. Native Goals remain unchanged.

## Data and compatibility

The local Helper is supervised by the existing launchd service. MCP requests flow through the stdio server to Helper, which reads/writes canonical Kit records according to each operation's authority. Kit's optional `task-progress` category installs or reuses the native plugin; no separate launcher or Dock choice exists.

Existing task and Heartbeat formats remain compatible. Existing schema v3 task events remain readable and are preserved; opt-in lifecycle events use schema v4 in the existing task journal. Archive summaries and details are read-only views derived from that history, not another store. Existing native Goal APIs and original v1/v2 Goal records remain readable. Existing History source data is retained; the concise display summary is a bounded projection only. Preserve the derivative's upstream Git history, license, and attribution when redistributing it.

See [architecture](docs/ARCHITECTURE.md), [permissions](docs/PERMISSIONS.md), [validation evidence](docs/VALIDATION.md), and the [changelog](CHANGELOG.md).
