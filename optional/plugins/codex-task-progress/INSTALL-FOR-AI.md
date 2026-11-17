# Install Task Progress 0.12.2

In version 0.7.6, a known, verified chat and project scope can immediately show its last in-memory snapshot when returning to a window while canonical refresh runs in the background when due. A background error retains the last display without asserting it is current. Unsupported, untrusted, moved, or disabled contexts do not inherit another scope’s snapshot. The panel restores the selected task, History or Heartbeat tab and relevant expanded selections only for the matching context. Polling remains independent at five seconds; a five-second snapshot lease avoids duplicate work and pending reads retain fast follow-ups. Cold scopes without a snapshot still need an initial read, so no universal instant or one-second display is promised. Task models and writes continue to use canonical authority; no disk or browser storage is added.

This is a breaking native-only release. Install from the trusted Kit checkout; do not download an upstream Goal Progress release. Preserve upstream Git history, the MIT license and attribution. The CDP panel and custom Dock launcher have been retired. If an older installation is present, remove it safely using that installed version's own uninstall procedure first. The 0.6.0 installer detects legacy markers and stops before replacing files; do not force an overwrite or rebuild the retired launcher.

## Kit installation

Choose the optional `task-progress` category in Kit or use its documented optional-component command. Kit installs or reuses the native plugin and Helper. A fresh category selection needs no Dock/launcher prompt. Existing plugin installations are reused; Kit does not silently upgrade them. If an upgrade is needed, use the native component installer from this Kit checkout after handling any legacy installation.

The native panel requires a Codex Desktop host that supports MCP Apps and the optional `enable_mcp_apps` feature. Inspect the host setting with `codex features list` before installing. If it is disabled and the user chooses native MCP Apps, enable it explicitly, then retry installation:

```sh
codex features enable enable_mcp_apps
```

The installer does not toggle this host feature. If it is disabled or the CLI cannot confirm support, installation returns `NATIVE_MCP_SETUP_REQUIRED` with the next step. Reopen or start an ordinary chat when required by Codex, then confirm the panel and its data are actually visible. Tool registration, build success, `doctor`, and `verify` do not prove UI visibility. Unsupported hosts may not show the panel.

The supported request flow is MCP Apps resource → MCP stdio server → local Helper via the existing launchd service → canonical Kit task/Heartbeat/history records. The Helper applies the existing trusted thread identity and write-authority checks. It does not create or change a custom Goal UI. Existing native Goal model APIs, v1/v2 record formats, task formats, and Heartbeat formats remain compatible.

The Heartbeat panel reads producer-recorded orchestration snapshots: active child agents before audit and after
re-splitting/dispatch, and blocked tasks with known or unknown Owner intervention needs. A first session or
older wake without a snapshot shows unknown; the panel does not reconstruct historical activity. The ten audit
rows and full Items registry stay in the canonical ledger for audit. The supervising producer uses Kit's
heartbeat writer; installation and the read-only panel create no parallel records.

The signed production Helper embeds its matching panel asset, including when a chat retains an older launcher
root. Source runtime uses its pinned runtime assets; embedding is for the production SEA only. After upgrading,
if the native view looks stale, reopen the affected chat or switch to another chat and back to let the host
refresh its MCP catalog/resource. Closing and reopening the panel tab alone may not refresh it. Do not restart
Codex. Verify actual panel visibility and data independently of `doctor` or `verify`.

## Build and checks

For release development on Apple Silicon macOS, use Node >=22.12 and pnpm 11 from the component directory:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify:public
corepack pnpm test
corepack pnpm test:ui
GOAL_PROGRESS_NODE_BINARY=/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node corepack pnpm build:release:macos
```

The release is under `dist/release/macos-arm64`. Verify its version is `0.12.2`. Version 0.9.4 retains `task_progress_dashboard` and advertises the stable protocol address `ui://codex-task-progress/panel-v1.html`, independently of the plugin release version. It relies on the host’s package-revision cache dimension for updates. Published versioned URIs remain read-only aliases serving the current server’s embedded HTML; unknown future URIs are rejected. In actual 0.9.3 acceptance the host displayed “Couldn’t display” and “Try again”; The user confirmed that 0.9.4 restored the native page; actual current host visibility and data remain separate verification. If needed, a chat catalog refresh may be tried, but its effect has not been verified. Do not restart Codex. Keep build/check results, Helper health (`doctor --json`, `verify --json`), plugin registration, and actual native panel visibility/data as separate evidence.

## Signing and protected folders

Reuse the existing configured signing identity. For local readiness, inspect signing status and candidates read-only:

```sh
node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --check
```

When a signing choice is required, Kit asks for explicit consent in interactive setup; non-interactive setup reports the required action. A confirmed identity is stored only in private local configuration:

```sh
node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --configure-signing --identity '<certificate fingerprint>'
```

The release builder also accepts `GOAL_PROGRESS_CODESIGN_IDENTITY` or a private `release-signing.json` under application support (`{ "schemaVersion": 1, "identity": "..." }`). `GOAL_PROGRESS_CODESIGN_CONFIG` selects an explicit absolute config path; invalid explicit config fails closed. Keep identity values out of source and shared docs. Without a configured identity, ad-hoc signing may cause macOS to ask for protected-folder permission again. Apple Development signing is not Developer ID or public notarization. Never automate TCC grants, edit/reset the TCC database, or default to Full Disk Access.

The Helper is installed at the stable real path `install/bin/goal-progress`; versioned release assets are retained in `install/releases/<version>/`. Existing grants are not copied to a new executable path. A macOS permission prompt remains a user decision.

Version 0.7.9 streamlines routine source details beneath task modules and presents Project Heartbeat validation as a compact audit summary that surfaces real risks. Verify actual native panel behavior separately.

An optional standalone `task_root: <Items ID>` selects a tracking root and its linked descendants from the existing Items registry for task projection. Without the field, all Items remain in scope. Fenced examples are ignored; a ledger with only a fenced example still uses all Items. Invalid or empty active declarations, duplicate or conflicting declarations, and missing, non-tracking or cyclic roots fail closed. Producers derive the selected Items from their authoritative source in the same registry; do not hand-maintain separate business counts or create a second store.

Version 0.9.0 shows a frameless allocation ring for the recorded running-agent count against an explicit agent plan. The after-audit Heartbeat observation supplies the numerator and the before-to-after observation is supporting context; listed agents are not the denominator. A missing or unmatched plan or observation, zero denominator, or an over-plan count does not produce a misleading progress arc. Unknown values use a gray ring. This is a timestamped observation, not a live Desktop count. The native entry moves to `task_progress_dashboard`; `task_progress_panel` remains model-only and read-only for compatibility. Native rendering and migration must be verified in the host.

Version 0.9.2 aligns Archive header and row hover hit regions to consistent inset boundaries, with coherent spacing and corner radii. Long archive titles stay compact with an ellipsis while collapsed and show their full text with wrapping when expanded, while the date remains visible. Archive data and logic are unchanged. Verify this UI in the native host; release and build checks do not establish host acceptance.

The 0.12.1 candidate separates parent-chat activity observation from task-source availability, so a stale source does not hide verified agent activity. Task percentages still require a valid canonical source. Bounded streaming support for large ledger heads is intended to make them discoverable and readable without loading the whole head at once; real-data compatibility and native display require verification.

Version 0.12.2 presents each agent in a 56 px capsule with a single text line and a 2–3 px full-width progress strip. Known progress, including zero, is displayed; absent assignments are Unlinked, while linked assignments without progress are Unknown. Both remain neutral without a fabricated percentage. Progress continues to require trustworthy canonical assignment; a path-only match does not backfill it. Refreshing data cannot reload an older embedded view: closing and reopening the view or refreshing the chat catalog may be necessary. Do not restart Codex.

## Storage compatibility

The shared Kit reader supports explicitly selected Heartbeat ledgers and head/history pairs up to a combined 32 MiB; general discovery remains separately bounded. Explicit recovery validates the requested project ledger without relying on a broad scan. Kit owns the canonical writer and records. Installation and read-only panel access do not silently migrate a ledger: a live migration requires quiescent writers and preservation of history. Verify migration and native panel data independently.

Existing canonical task and Heartbeat formats remain in place. The History summary is bounded presentation data only: it keeps a 512 KiB input limit and 512 Unicode-character summaries with full Markdown paths, while Kit's complete records remain unchanged. Native Goal records remain readable under their original formats. Do not migrate, truncate or rewrite source records as part of UI summarization.

The plugin Helper opts ordinary local task writes into lifecycle management with `lifecycle: true`; Kit clients that omit the flag retain v3 behavior. Existing schema v3 events remain readable and unchanged. The internal closeout checkpoint is hidden from the task display, but completion requires explicit verified closeout evidence for branch, merge and push (or verified not-applicable outcomes), zero remaining work, and zero Owner actions. Checklist 100% alone never completes the task. Completed tasks that receive new scope start a fresh cycle via `task_progress_rescope` at the current revision; unchanged prior nodes are filtered from its denominator, and previous cycles appear through read-only paginated archive views derived from the existing history. Bound read-only Heartbeat sources have no formal cycle API, so completion/archive is unavailable for them. Native Goals are unaffected.

When changing storage in future versions, test old-format fixtures, repeated access, workspace moves and divergent histories. Divergent old/new data must fail closed with both copies preserved.
