# Install Task Progress 0.7.4

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

The release is under `dist/release/macos-arm64`. Verify its version is `0.7.4`. The native UI resource URI is versioned from the release version constant. The signed production Helper retains its embedded matching panel asset, including when a chat uses an older launcher root; the source runtime continues to use its pinned runtime assets. The strict read-only resource template accepts compatible older Heartbeat panel addresses from 0.5.16 through the current release and resolves them to the current embedded HTML; only the current release URI is advertised. If the host still shows the old registered resource or stale layout, reopen the affected chat or switch away to another chat and return so the host can refresh its MCP catalog/resource. Closing and reopening the panel tab alone may not refresh it. Do not restart Codex. Keep build/check results, Helper health (`doctor --json`, `verify --json`), plugin registration, and actual native panel visibility/data as separate evidence. Actual native host compatibility still needs verification.

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

## Storage compatibility

Existing canonical task and Heartbeat formats remain in place. The History summary is bounded presentation data only: it keeps a 512 KiB input limit and 512 Unicode-character summaries with full Markdown paths, while Kit's complete records remain unchanged. Native Goal records remain readable under their original formats. Do not migrate, truncate or rewrite source records as part of UI summarization.

The plugin Helper opts ordinary local task writes into lifecycle management with `lifecycle: true`; Kit clients that omit the flag retain v3 behavior. Existing schema v3 events remain readable and unchanged. The visible progress includes one closeout checkpoint, but completion requires explicit verified closeout evidence for branch, merge and push (or verified not-applicable outcomes), zero remaining work, and zero Owner actions. Checklist 100% alone never completes the task. Completed tasks that receive new scope start a fresh cycle via `task_progress_rescope` at the current revision; unchanged prior nodes are filtered from its denominator, and previous cycles appear through read-only paginated archive views derived from the existing history. Bound read-only Heartbeat sources have no formal cycle API, so completion/archive is unavailable for them. Native Goals are unaffected.

When changing storage in future versions, test old-format fixtures, repeated access, workspace moves and divergent histories. Divergent old/new data must fail closed with both copies preserved.
