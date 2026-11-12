# 0.4.0 validation status

Validated locally on Apple Silicon macOS:

- `corepack pnpm verify:public`: lint, TypeScript, code/renderer/plugin build, plugin contracts and release hygiene passed.
- `corepack pnpm test`: 26 passing tests covering Hook/MCP, real Helper/socket integration, task events/revision/idempotency/recovery and heartbeat inspection/discovery.
- `corepack pnpm test:ui`: 7 passing browser checks (including parent test), running real Chrome against an isolated DOM fixture. Covers ordinary empty state, expandable objectives/evidence, scope regression/history pagination, docking/floating, Goal coexistence, heartbeat states, narrow viewport and delayed-response isolation.
- Built the self-contained arm64 macOS release with Node v24.19.0, whose archive was checked against Node's SHASUMS256.txt. Archive packaging completed.
- Read a real project heartbeat ledger through the canonical Kit API and adapter: 12 Items, 0 wakes. Current certification remained false; no wake timestamp was invented. Source content hash was unchanged.

## Local installation gate

The built 0.4.0 installer returned `INSTALL_RESTART_REQUIRED`, with `changed:false`, `cdpReady:false` and `restartScheduled:false`. Doctor returned `DOCTOR_NOT_INSTALLED`; Verify returned `VERIFY_NOT_INSTALLED`.

No Codex restart was performed. The current app must be restarted with the user's explicit approval before installation can finish. Actual ordinary-chat display, live MCP tool loading, multi-window behavior and reopening inside Codex remain pending. Browser fixture tests are not evidence that the live Codex interface has been tested.

After approval, follow INSTALL-FOR-AI.md, rerun installation/Doctor/Verify and complete the real ordinary-chat lifecycle plus heartbeat UI acceptance. Update this record with the observed results.
