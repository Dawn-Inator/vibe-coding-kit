# Install the locally built Task Progress release

Build this component from `optional/plugins/codex-task-progress` in the Kit checkout. There is no configured automatic release update channel; update by rebuilding and installing from the trusted Kit checkout. Do not download an upstream Goal Progress release. Preserve MIT attribution. Never restart Codex without the user's explicit approval.

1. On Darwin arm64, run `corepack pnpm install --frozen-lockfile`, `corepack pnpm verify:public`, `corepack pnpm test`, and `corepack pnpm test:ui`.
2. Build with the pinned Node v24.19.0 binary as described in README (`GOAL_PROGRESS_NODE_BINARY=... corepack pnpm build:release:macos`).
3. Run `dist/release/macos-arm64/bin/goal-progress install --json`. If it returns `INSTALL_RESTART_REQUIRED`, present the built version and validation results and ask permission to restart. After approval, run the same command with `--restart-codex`. Follow `INSTALL_RESTART_PENDING` by rerunning install after the app returns.
4. Run the same binary with `doctor --json` and `verify --json`. Verify version 0.5.1 and record exact result codes. The independent application data name is CodexTaskProgress.
5. Reopen the affected chat or open a new chat to load new plugin tools. Use a verification chat whose task source is resolved; do not initialize a parallel checklist while its source is pending, stale or unavailable. Test a real ordinary task without creating a Goal: initialize → complete items → rescope to add work and observe regression → expand modules and nodes/evidence → reopen and verify persistence. Click the separate History and Heartbeat round buttons and verify real records and pagination. Project Heartbeat appears automatically when available, but only a related structured Kit ledger may replace the chat checklist; an unrelated project ledger must not become task authority. Check panel switching, Escape/focus return, light/dark themes, narrow/short windows and reduced motion.

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
