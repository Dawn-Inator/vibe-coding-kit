# Install the locally built Task Progress release

Build this private derivative from `optional/plugins/codex-task-progress` in the trusted Kit checkout. There is no configured automatic release update channel; update by rebuilding and installing from that checkout. Do not download an upstream Goal Progress release. Preserve upstream Git history, MIT attribution and license. The managed launcher is separate from Codex and does not modify its app bundle.

## Build and install

On supported Apple Silicon macOS, use the pinned Node v24.19.0 binary and the component's pnpm toolchain:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify:public
corepack pnpm test
corepack pnpm test:ui
GOAL_PROGRESS_NODE_BINARY=/absolute/path/to/node-v24.19.0-darwin-arm64/bin/node corepack pnpm build:release:macos
```

The release is under `dist/release/macos-arm64`. Verify release version `0.5.14`. For a launcher-first setup, run `dist/release/macos-arm64/bin/goal-progress install --defer-connection --json`; this prepares the Helper and plugin without requiring CDP so the managed launcher can be configured. The ordinary `install --json` path never restarts Codex automatically, but it may return `INSTALL_RESTART_REQUIRED` when the existing connection cannot be established. Do not interpret its success as a guarantee that no connection setup remains.

After a successful install, use `doctor --json` and `verify --json`, and keep their results distinct from CDP and visible panel checks. If a legacy install requires a Codex restart to create CDP, never restart it automatically; report the reason and ask before restarting. The independent application data name is `CodexTaskProgress`.

For an existing Codex process without CDP, installation or launcher use can only activate that process. Establishing CDP requires a later full cold launch through the managed launcher. `goal-progress launch --json` starts the Helper and Codex with the configured connection arguments without restarting an existing app. When verified CDP is already present, hot updates reconnect the Helper and replace the panel in place; Codex itself is not restarted.

## Managed launcher and Kit integration

Inspect, install or remove the separate launcher using `goal-progress launcher --status --json`, `goal-progress launcher --install --json`, or `goal-progress launcher --remove --json`. The launcher has its own bundle identifier; its displayed name and icon derive from the detected Codex vendor app. It preserves the actual Codex app, and direct launches of that app remain normal. macOS may display both app icons; do not promise that every Finder or app-originated launch is intercepted.

Dock replacement is opt-in. Run `goal-progress launcher --install --dock --json` only when explicitly choosing it as the Dock entry. This setup preserves unrelated Dock entries and the current session, and disables the legacy startup auto-observer. The older default-off startup-recovery policy was not reliable and is no longer recommended. The launcher never force-restarts an existing Codex process or bootstraps CDP into an already running process.

On launcher-capable releases, uninstall first removes the owned managed launcher and its Dock entry. If Dock cleanup fails, or a user-edited Dock entry must be retained, Helper removal is blocked so that entry cannot become a broken launcher. Older helpers without managed-launcher support keep their legacy uninstall behavior.

Kit's fresh `task-progress` selection uses the deferred-connection install flow to prepare the launcher. During an interactive install or category wizard, a selected category with an already-installed launcher-capable helper but no launcher configuration triggers a separate purpose-level, default-No, one-click Dock consent prompt; declining leaves the plugin and project selection unchanged. This is separate from signing consent. For an already installed plugin, `--optional task-progress=on` directly requests launcher setup. Non-interactive saved or auto-detected preferences only reuse the existing installation, while unrelated explicit category updates do not prompt. An older helper that lacks launcher support returns setup-required; Kit does not silently upgrade an existing plugin.

## Ordinary-task and UI verification

Reopen the affected chat or open a new chat to load changed plugin tools. Use a verification chat whose task source is resolved; do not initialize a parallel checklist while its source is pending, stale or unavailable. Test an ordinary task without creating a native Goal: initialize, complete items, rescope to add work and observe the progress regression, expand modules and nodes/evidence, then reopen and verify persistence. Check the History and Heartbeat controls, actual records and pagination, panel switching, Escape/focus return, light/dark themes, narrow and short windows, and reduced motion.

Project Heartbeat appears automatically when available, but only a related structured Kit ledger may replace the chat checklist; an unrelated project ledger must not become task authority. Report build, test, connection, visible UI and install results separately. An install or Doctor result alone does not prove the panel is visible.

## Signing and protected folders

Kit reuses an existing Task Progress installation without asking about signing, rebuilding or reinstalling it. For a missing component, interactive setup asks for explicit confirmation of an eligible local certificate. Non-interactive setup reports `setup-required` and gives the commands. Inspect status and candidates read-only with:

```sh
node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --check
```

To validate and persist a chosen fingerprint in the private local signing configuration:

```sh
node .vibe-coding/kit/optional/plugins/codex-task-progress/scripts/install-from-kit.mjs --configure-signing --identity '<certificate fingerprint>'
```

This changes only private signing configuration; it does not build, sign, install or restart Codex. The local release builder accepts `GOAL_PROGRESS_CODESIGN_IDENTITY`, which overrides the saved identity, or a `release-signing.json` file under the Task Progress application-support directory. That file uses `{ "schemaVersion": 1, "identity": "..." }`. `GOAL_PROGRESS_CODESIGN_CONFIG` may select an explicit absolute path; invalid explicit configuration fails closed. Keep identity values out of source control and public documentation.

Without a configured identity, ad-hoc signing remains available and macOS may prompt for permission again. Apple Development signing is for local development, not Developer ID or public notarization. The Helper and listener identifiers are `com.codextaskprogress.helper` and `com.codextaskprogress.listener`. First access to a protected folder requires user approval. TCC permission is not transferred when the Helper path changes, and future prompts are not ruled out. Never automate permission grants, edit or reset the TCC database, or default to Full Disk Access.

The installer retains versioned assets in `install/releases/<version>/` and atomically installs the verified Helper at the real `install/bin/goal-progress` path. launchd, MCP and new Hooks use that stable path; Doctor checks its hash. Existing version-specific installs are supported, but moving to the stable path may require protected-folder approval.

## Storage-format changes

When an update changes task or Heartbeat persistence, validate migration fixtures before installation. Cover legacy task events and snapshots, legacy Heartbeat bindings/observations and the previous workspace routing index. Verify task revisions and task/source associations remain available, project Heartbeat wakes retain their content and source line mapping, and original legacy files remain unchanged. Cover repeated first access and a workspace move: routing must survive cwd changes, while a prior project's Heartbeat binding must not follow the chat to another project. Divergent old/new history must fail closed while preserving both copies.

Keep display and ordinary reads of an unrelated active project Heartbeat read-only and retain legacy single-file ledgers as single files. Test an explicit writer-owned cutover only after quiescing the source and obtaining Kit's lock/version preconditions. Pass `legacyWritersQuiescent: true` and a fresh `expectedContentHash` from `readHeartbeatLedgerPair({root, path})`. The flag asserts raw legacy writers stay stopped throughout; the Kit lock coordinates Kit writers only. Verify a concurrent append/version change fails closed without losing either copy. For an interrupted history-first transaction, obtain the raw hash with `readHeartbeatLedgerPairVersion` and validate `recoverHeartbeatLedgerPair` against the backup plus previous/planned head. Helper-owned ordinary task and routing records may use their separate first-access compatibility migration.

For hot updates, install without a Codex restart when verified CDP is available. Verify the main app PID/start time remains unchanged, the Helper executable and panel tag are current, and task state survives. Reopen chat sessions to load changed MCP catalogs. Report code/build/test results, install, Doctor/Verify, CDP and actual visible-app evidence separately.
