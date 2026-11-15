# Codex Task Progress

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), retaining its Git history, MIT license and upstream attribution. Version 0.6.0 is a breaking native-only release: the supported interface is the read-only MCP App; the CDP injected panel, custom Dock launcher and commands for managing them have been retired. A legacy installation must be removed safely with its old installer before installing this version. The new installer detects legacy markers and stops instead of overwriting the old installation.

## Native panel

The native MCP App uses the Codex Desktop MCP Apps entrypoint and the optional `enable_mcp_apps` feature. Kit installs or reuses the plugin and its Helper without asking about a Dock entry. Check `codex features list` before installation. If the feature is disabled and the user chooses to use native MCP Apps, enable it explicitly with `codex features enable enable_mcp_apps`; the installer never changes host feature settings and returns `NATIVE_MCP_SETUP_REQUIRED` when native MCP support is unavailable or disabled. Reopen or start a chat as required by Codex, then verify the panel in an ordinary chat. Plugin registration, a successful build, and Helper health do not prove that the host displays the UI. Visibility is host-dependent and is not guaranteed on unsupported hosts.

The native App resolves the supported host's current thread identity on each request, then reads only that user's matching, non-subagent, non-ephemeral task, History and project Heartbeat records through the local Helper and canonical Kit APIs. Task writes remain protected by Hook and turn proof. Existing native Codex Goal model APIs, record formats and compatibility are retained; the plugin does not create Goals or provide a custom Goal UI.

Task data follows the Kit canonical records. The native panel shows the registered checklist, recorded status and evidence, paginated History, and a read-only project Heartbeat view. Heartbeat remains observational and does not schedule or write to a ledger. The History panel uses a bounded summary projection (at most 512 KiB source input and 512 Unicode characters per summary) and keeps the full canonical Markdown path available; the underlying Kit records are not truncated or rewritten.

## Installation and validation

Use the [AI installation guide](INSTALL-FOR-AI.md). The plugin requires Apple Silicon macOS, Codex Desktop with MCP Apps support, Node.js 22.12+, and pnpm 11 for development/building. Local release signing reuses the existing configured identity; signing does not grant TCC permissions or self-authorize protected folders.

Keep these evidence separate: package/build checks, Helper `doctor` and `verify`, plugin registration, and actual native UI visibility/data in a supported host. A host feature change may require a new chat or reopening a chat. Do not infer UI visibility from command success.

## Data and compatibility

The local Helper is supervised by the existing launchd service. MCP requests flow through the stdio server to Helper, which reads/writes canonical Kit records according to each operation's authority. Kit's optional `task-progress` category installs or reuses the native plugin; no separate launcher or Dock choice exists.

Existing task and Heartbeat formats remain compatible. Existing native Goal APIs and original v1/v2 Goal records remain readable. Existing History source data is retained; the concise display summary is a bounded projection only. Preserve the derivative's upstream Git history, license, and attribution when redistributing it.

See [architecture](docs/ARCHITECTURE.md), [permissions](docs/PERMISSIONS.md), [validation evidence](docs/VALIDATION.md), and the [changelog](CHANGELOG.md).
