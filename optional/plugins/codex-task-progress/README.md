# Codex Task Progress

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), retaining its Git history, MIT license and upstream attribution. Current release: 0.6.5. Version 0.6.0 introduced the breaking native-only interface: the supported UI is the read-only MCP App; the CDP injected panel, custom Dock launcher and commands for managing them are retired. A legacy installation must be removed safely with its old installer before installing this version. The installer detects legacy markers and stops instead of overwriting the old installation.

Version 0.6.2 fixes host reuse of stale native panel HTML by assigning each immutable MCP UI resource a versioned URI from the release version constant. If a host still has the old UI tab registered, close and reopen the Task Progress tab to load the new resource. Do not restart Codex. This cache fix changes no authentication, task authority, canonical data format or Kit API.

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

In 0.6.5, the signed production Helper uses its embedded matching panel asset even when an older chat launcher
root remains in use. The source runtime continues to use its pinned runtime assets; embedding applies to the
production SEA. After upgrading, close and reopen the Task Progress tab to load the new panel; do not restart
Codex. Verify actual panel visibility and data separately from Helper health.

## Installation and validation

Use the [AI installation guide](INSTALL-FOR-AI.md). The plugin requires Apple Silicon macOS, Codex Desktop with MCP Apps support, Node.js 22.12+, and pnpm 11 for development/building. Local release signing reuses the existing configured identity; signing does not grant TCC permissions or self-authorize protected folders.

Keep these evidence separate: package/build checks, Helper `doctor` and `verify`, plugin registration, and actual native UI visibility/data in a supported host. A host feature change may require a new chat or reopening a chat. Do not infer UI visibility from command success.

## Data and compatibility

The local Helper is supervised by the existing launchd service. MCP requests flow through the stdio server to Helper, which reads/writes canonical Kit records according to each operation's authority. Kit's optional `task-progress` category installs or reuses the native plugin; no separate launcher or Dock choice exists.

Existing task and Heartbeat formats remain compatible. Existing native Goal APIs and original v1/v2 Goal records remain readable. Existing History source data is retained; the concise display summary is a bounded projection only. Preserve the derivative's upstream Git history, license, and attribution when redistributing it.

See [architecture](docs/ARCHITECTURE.md), [permissions](docs/PERMISSIONS.md), [validation evidence](docs/VALIDATION.md), and the [changelog](CHANGELOG.md).
