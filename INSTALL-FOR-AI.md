# Install the locally built Task Progress release

This private derivative must be built from this repository. Do not download an upstream Goal Progress release. Preserve MIT attribution. Never restart Codex without the user's explicit approval.

1. On Darwin arm64, run `corepack pnpm install --frozen-lockfile`, `corepack pnpm verify:public`, `corepack pnpm test`, and `corepack pnpm test:ui`.
2. Build with the pinned Node v24.19.0 binary as described in README (`GOAL_PROGRESS_NODE_BINARY=... corepack pnpm build:release:macos`).
3. Run `dist/release/macos-arm64/bin/goal-progress install --json`. If it returns `INSTALL_RESTART_REQUIRED`, present the built version and validation results and ask permission to restart. After approval, run the same command with `--restart-codex`. Follow `INSTALL_RESTART_PENDING` by rerunning install after the app returns.
4. Run the same binary with `doctor --json` and `verify --json`. Verify version 0.4.1 and record exact result codes. The independent application data name is CodexTaskProgress.
5. Reopen the affected chat or open a new chat to load new plugin tools. Test a real ordinary task without creating a Goal: initialize → complete items → rescope to add work and observe regression → expand evidence/history → reopen and verify persistence. Bind a confirmed project Kit ledger and observe its module; unrelated chats should have no heartbeat module.

Report code/build/test results, repository commit/push, installation, Doctor/Verify and actual UI tests separately. Never call an installation/connection check a successful visible ordinary-chat test.

For later hot updates, run install without `--restart-codex`. Verify the main app PID/start time is unchanged, the Helper executable and panel tag are current, and task state survives. Reopen chat sessions to load changed MCP catalogs; do not restart the application merely to update the panel.
