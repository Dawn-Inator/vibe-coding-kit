# 0.4.1 validation status

Validated locally on Apple Silicon macOS on 2026-11-11 (America/New_York).

## Automated checks

- `corepack pnpm verify:public`: lint, TypeScript, code/renderer/plugin build, plugin contracts and release hygiene passed.
- `corepack pnpm test`: 27 passing checks of Hook/MCP, real Helper/socket integration, revision/idempotency/recovery and heartbeat discovery/projection/pagination.
- `corepack pnpm test:ui`: 10 passing browser checks (including parent test), running Chrome against a fixture. Includes reserved top layout, floating/restoration, objective status aggregation, narrow viewport, versioned hot reinjection, large heartbeat paging and delayed cross-chat responses.
- Built self-contained arm64 release with Node v24.19.0, archive verified against Node's SHASUMS256.txt.

## Installation and actual Codex UI

- Initial setup required the user-approved restart to establish loopback CDP. Version 0.4.0 then returned INSTALL_OK, DOCTOR_OK and VERIFY_OK.
- Updated to 0.4.1 and refreshed it using `install --json` without a restart flag. INSTALL_OK, DOCTOR_OK and VERIFY_OK passed. The main Codex process retained PID 1265 and its 19:24:32 local start time across the updates; only the Helper restarted. Active panel tags changed to the 0.4.1 versioned component in place.
- Tested the installed MCP executable against the live current ordinary chat identity, confirmed its native Goal was null, initialized a task, completed it to 100%, then added scope and observed 50%. Expanded actual evidence and history in the app; the scope event showed 100% → 50% with its reason.
- Task revision 3 survived hot updates and switching to a project chat and back. Completion of the live acceptance item was then recorded with evidence.
- Actual top docking reserved space: panel bottom was 244.77 px and the conversation content began at 252.77 px. The original padding is restored in float mode or when the host is removed.
- Switched to an existing project chat with an automatically associated real ledger containing 301 wakes and 784 Items. Its bounded view was about 26 KiB. Loaded first five historical wakes and then five more through the actual panel, with nextCursor and no error. Restored the original chat afterward. No project ledger content was written.

## Remaining limits

A modified MCP catalog/Skill/Hook session context needs reopening affected chat sessions; the installer reports `codexSessionReconnectRequired:true`. The current agent's built-in deferred tool catalog was not forcibly replaced mid-turn; the protocol acceptance used the installed MCP executable with the actual live chat/turn identity. This limitation does not prevent live Helper/renderer updates.

Native multi-window behavior has browser identity/isolation regression coverage, but a second actual desktop window was not opened during this validation. Doctor's inherited Goal display diagnostics may say unverified when no native Goal is configured; ordinary task visibility was independently observed through its live panel diagnostics and screenshots.
