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

## 0.4.2 correction: checklist completion is not total task completion

The user observed a 100% header while work continued. The prior acceptance list covered only two registered items and was marked complete before delivery closeout. That display was misleading; the earlier 100% must not be interpreted as objective completion of all requested work. The current record retains its history and adds the missing correction/delivery steps.

0.4.2 labels registered checklist counts explicitly and observes execution separately. Complete checklists with working, waiting or unknown execution have no numeric completion header or filled progressbar. Idle is an execution observation, not a delivery claim. MCP results declare `completionBasis: registered-checklist`; the legacy persisted phase remains checklist-only for compatibility.

The independent App Server can return notLoaded for a chat executing in the desktop application. That maps to unknown. Positive visible Stop/Send composer controls provide a conservative local observation without inferring idleness from missing controls. Unknown labels/states stay unknown. The actual current chat was observed as working from its Stop control. First task reads remain unconfirmed until a response arrives; no invented0/0 is shown while reading or unavailable.

Validation: 32 core/interface tests and13 browser checks cover complete lists with active runtime at unchanged revision, working/waiting/unknown/idle, positive and hidden controls, runtime changes before a slow network response, and first-read uncertainty. A bridge regression verifies a hot update installs its request binding before the new panel's initial read, avoiding a retired-binding timeout.

Counts remain dependent on model-maintained scope registration. This correction does not claim to estimate unknown remaining work. Hook and Skill guidance now explicitly retain testing, packaging, install, commit/push and final verification until performed.

Final0.4.2 delivery checks passed: INSTALL_OK, DOCTOR_OK and VERIFY_OK. The current visible chat reports working from codex-ui while retaining its persisted checklist revision, with explicit registered scope. The main app PID1265/start time remained unchanged across the hot update. Delivery steps were retained as pending until packaging, installation, commit/push and final verification occurred.

## 0.4.3 workspace storage

Kit's pure path contract is pinned at31c647ec63e462bc367a48932c01736a35e2e795 and imported as a Git package, with no copied runtime source. Kit syntax checks passed; its4 manifest-registered tests/CI were not run under that repository's explicit-test policy. Plugin validation exercised the canonical contract in migration/integration tests.

The plugin's43 core/interface checks and13 browser checks passed, as did lint, typecheck, builds, source runtime bundle, plugin/release checks, install, Doctor and Verify. Ordinary task records now resolve from verified chat cwd to `.workspace/codex-task-progress`; system runtime files remain separate.

Live migration of this chat preserved all10 events at revision10 byte-for-byte (SHA256 match), left the original app-support log unchanged and created private mode600 target files. A later task update advanced only the workspace copy to revision11 while the old log's SHA256 remained unchanged. The actual panel reconnected at0.4.3 without restarting Codex's main process. Initial project filesystem opening was delayed, then migration and requests recovered; no data was dropped or silently redirected globally.

Tests cover existing target conflicts, exact history preservation, per-project/chat isolation, trusted cwd spoof rejection, heartbeat binding filtering, idempotence, unavailable paths and cwd moves. Moving a chat cwd carries task history but not the previous project's heartbeat binding/cache. Empty reads do not create a workspace; confirmed records/mutations create a self-ignored private directory. The global index contains paths only.
