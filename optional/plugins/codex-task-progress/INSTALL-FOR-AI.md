# Install the locally built Task Progress release

Build this component from `optional/plugins/codex-task-progress` in the Kit checkout. There is no configured automatic release update channel; update by rebuilding and installing from the trusted Kit checkout. Do not download an upstream Goal Progress release. Preserve MIT attribution. Never restart Codex without the user's explicit approval.

1. On Darwin arm64, run `corepack pnpm install --frozen-lockfile`, `corepack pnpm verify:public`, `corepack pnpm test`, and `corepack pnpm test:ui`.
2. Build with the pinned Node v24.19.0 binary as described in README (`GOAL_PROGRESS_NODE_BINARY=... corepack pnpm build:release:macos`).
3. Run `dist/release/macos-arm64/bin/goal-progress install --json`. If it returns `INSTALL_RESTART_REQUIRED`, present the built version and validation results and ask permission to restart. After approval, run the same command with `--restart-codex`. Follow `INSTALL_RESTART_PENDING` by rerunning install after the app returns.
4. Run the same binary with `doctor --json` and `verify --json`. Verify version 0.5.13 and record exact result codes. The independent application data name is CodexTaskProgress.
5. Reopen the affected chat or open a new chat to load new plugin tools. Use a verification chat whose task source is resolved; do not initialize a parallel checklist while its source is pending, stale or unavailable. Test a real ordinary task without creating a Goal: initialize → complete items → rescope to add work and observe regression → expand modules and nodes/evidence → reopen and verify persistence. Click the separate History and Heartbeat round buttons and verify real records and pagination. Project Heartbeat appears automatically when available, but only a related structured Kit ledger may replace the chat checklist; an unrelated project ledger must not become task authority. Check panel switching, Escape/focus return, light/dark themes, narrow/short windows and reduced motion.

Startup recovery is a separate persisted opt-in and is off by default. Use `dist/release/macos-arm64/bin/goal-progress startup-recovery --status --json` to inspect it, `--enable --json` to enable it for a later launch, or `--disable --json` to turn it off. Enabling does not restart the current Codex process. Recovery uses the existing native AppKit will/did launch notifications; replacement requires fresh PID/process identity, positive native `!finished` confirmation, no observed task activity, verified loopback CDP, and positive public CoreGraphics evidence that the target PID owns no onscreen windows. A foreground process may still be preparing before finish and remain eligible if it owns no onscreen window. Any owned onscreen window or missing/unknown owner metadata fails closed. The window check reads owner-PID metadata only, not screenshots or titles. Missing or late proof fails closed, and unavailable CDP falls back to normal startup. No delayed autorestart, SIGSTOP or app-bundle edits are used; failed recovery cooldown is cleared only after verified success, while normal restarts within 60 seconds remain supported.

## macOS signing and protected folders

For optional-component installs, Kit checks whether the plugin is already installed and reuses it without a signing prompt or reinstall. If it is missing and selected, an interactive Kit install asks once for explicit confirmation of an eligible local certificate. Non-interactive setup reports `setup-required` and gives the user the commands. `node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --check` lists signing status and candidates read-only. `node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --configure-signing --identity '<certificate fingerprint>'` requires explicit confirmation, validates the local certificate and persists only private signing configuration; it does not build, sign, install or restart Codex. Future local builds reuse the saved choice. Missing or ineligible certificates produce actionable guidance.

The local release builder accepts a signing identity from `GOAL_PROGRESS_CODESIGN_IDENTITY`, which overrides the configured identity, or from `release-signing.json` in the Task Progress application-support directory. The file uses `{ "schemaVersion": 1, "identity": "..." }`. `GOAL_PROGRESS_CODESIGN_CONFIG` may point to a specific absolute config path; an invalid explicit path or configured identity must fail closed rather than silently changing signing identity. Keep the identity value local; never commit it or place it in public documentation.

If no signing identity is configured, ad-hoc signing remains available and the build warns that macOS may prompt for permission again. Reusing a saved signing identity does not guarantee protected-folder consent will carry across updates: TCC may associate consent with the executable's physical version path, and inheritance across upgrades has not been verified. Apple Development signing is for local development only; it does not produce a Developer ID or publicly notarized release. The helper and listener identifiers are fixed as `com.codextaskprogress.helper` and `com.codextaskprogress.listener`.

On first access to a macOS-protected folder, the user must approve the system permission prompt. Do not automate permission grants, edit or reset the TCC database, or default to Full Disk Access. Never restart Codex without the user's explicit approval.

The installer retains release assets in `install/releases/<version>/` and atomically places the verified Helper at the real, non-symlink path `install/bin/goal-progress`, with a previous-file snapshot for rollback. launchd, MCP and new Hooks use this stable executable path; Doctor checks its hash. Existing versioned installs are supported. Moving an existing install to the stable path may trigger a macOS protected-folder prompt because TCC authorization is not transferred. Do not treat signing identity or path stability as proof that macOS will never prompt again.

## Storage-format changes

When an update changes task or heartbeat persistence, validate migration fixtures before installing it. Cover
legacy task events and snapshots, legacy heartbeat bindings/observations, and the previous workspace routing
index. Check that task revisions and all task/source-association records remain available, project heartbeat
wakes keep their original content and source line mapping, and the original legacy files remain unchanged.
Also cover repeated first access and a workspace move: routing must survive across cwd changes, while a prior
project's heartbeat binding must not follow the chat into another project. Create divergent old/new history
fixtures and confirm migration fails closed while preserving both copies. Do not describe migration as
validated from a build or install result alone; report fixture, integration, and actual installed-app evidence
separately when each has been collected. UI display and ordinary reads of an unrelated active project heartbeat
must remain read-only and retain a legacy source as one file. Test an explicit writer-owned cutover only after
quiescing the source and acquiring the Kit API's lock/version preconditions. Pass
`legacyWritersQuiescent: true` and a fresh `expectedContentHash` from `readHeartbeatLedgerPair({root, path})`.
The flag is the caller's assertion that raw legacy writers stay stopped throughout; the Kit lock only coordinates
Kit writers. Verify that a concurrent append/version change fails closed without losing either copy. For an
interrupted history-first transaction, obtain the raw hash with `readHeartbeatLedgerPairVersion` and validate
`recoverHeartbeatLedgerPair` against the backup plus previous/planned head. Helper-owned ordinary task and
routing records may use their separate first-access compatibility migration path.

Report code/build/test results, repository commit/push, installation, Doctor/Verify and actual UI tests separately. Never call an installation/connection check a successful visible ordinary-chat test.

For later hot updates, run install without `--restart-codex`. Verify the main app PID/start time is unchanged, the Helper executable and panel tag are current, and task state survives. Reopen chat sessions to load changed MCP catalogs; do not restart the application merely to update the panel.
