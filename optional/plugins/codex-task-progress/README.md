# Codex Task Progress

In version 0.7.6, a known, verified chat and project scope can immediately show its last in-memory snapshot when returning to a window while canonical refresh runs in the background when due. A background error retains the last display without asserting it is current. Unsupported, untrusted, moved, or disabled contexts do not inherit another scope’s snapshot. The panel restores the selected task, History or Heartbeat tab and relevant expanded selections only for the matching context. Polling remains independent at five seconds; a five-second snapshot lease avoids duplicate work and pending reads retain fast follow-ups. Cold scopes without a snapshot still need an initial read, so no universal instant or one-second display is promised. Task models and writes continue to use canonical authority; no disk or browser storage is added.

Private derivative of [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress), retaining its Git history, MIT license and upstream attribution. Current release: 0.12.9. Version 0.6.0 introduced the breaking native-only interface: the supported UI is the read-only MCP App; the CDP injected panel, custom Dock launcher and commands for managing them are retired. A legacy installation must be removed safely with its old installer before installing this version. The installer detects legacy markers and stops instead of overwriting the old installation.

Version 0.9.4 retains `task_progress_dashboard` and advertises the stable protocol address `ui://codex-task-progress/panel-v1.html`, independently of the plugin release version. It relies on the host’s package-revision cache dimension for updates. Published versioned URIs remain read-only aliases serving the current server’s embedded HTML; unknown future URIs are rejected. In actual 0.9.3 acceptance the host displayed “Couldn’t display” and “Try again”; The user confirmed that 0.9.4 restored the native page, Archive worked and the historical 100-agent list was absent. Do not assume every open tab refreshes automatically. Do not restart Codex.

The earlier bounded full-ledger path uses a 32 MiB combined limit for explicitly selected head/history pairs; general discovery has separate bounds. Explicit recovery validates the requested project ledger without depending on a broad scan. Kit owns the canonical writer and records; the panel remains read-only. Migrating a live ledger requires quiescent writers and preservation of history; installation and reads do not silently migrate it.

Version 0.7.9 streamlines routine source details beneath task modules and presents Project Heartbeat validation as a compact audit summary that surfaces real risks. Verify the actual native panel and its data separately.

An optional standalone `task_root: <Items ID>` selects a tracking root and its linked descendants from the existing Items registry for task projection. Without the field, all Items remain in scope. Fenced examples are ignored; a ledger with only a fenced example still uses all Items. Invalid or empty active declarations, duplicate or conflicting declarations, and missing, non-tracking or cyclic roots fail closed. Producers derive the selected Items from their authoritative source in the same registry; do not hand-maintain separate business counts or create a second store.

Version 0.8.2 presented Running and List metrics without large card frames; 0.12.4 no longer displays the headline count. The rings mark counts and do not represent task completion percentages. Unknown values show a gray ring and —. Heartbeat time metrics have no percentage. The new appearance awaits native host verification.

Version 0.9.0 showed a frameless allocation ring for a recorded running-agent count against an explicit agent plan; 0.12.4 no longer shows that headline aggregate. The after-audit Heartbeat observation supplies the numerator and the before-to-after observation is supporting context; listed agents are not the denominator. A missing or unmatched plan or observation, zero denominator, or an over-plan count does not produce a misleading progress arc. Unknown values use a gray ring. This is a timestamped observation, not a live Desktop count. The native entry moves to `task_progress_dashboard`; `task_progress_panel` remains model-only and read-only for compatibility.

During a pending Heartbeat refresh, retain an already verified ready allocation only while its parent and task cycle match. Missing records, terminal errors or mismatches remain unknown.

Version 0.9.2 aligns Archive header and row hover hit regions to consistent inset boundaries, with coherent spacing and corner radii. Long archive titles stay compact with an ellipsis while collapsed and show their full text with wrapping when expanded, while the date remains visible. Archive data and logic are unchanged.

Version 0.9.3 updates Archive loading, grouped hierarchy states and focus treatment. Subagent results use causally scoped dispatch evidence instead of treating the parent chat’s historical child inventory as the current turn. Missing cycle or records, or an incomplete summary, remains unknown rather than falling back to historical inventory. A later continuation invalidates an earlier completed state; child progress requires a verified latest dispatch and a child task cycle started or created no earlier than that dispatch. Otherwise it remains unknown. A plan ratio also remains unknown without a verified root start time. This does not establish a live running count. Actual native host acceptance failed with “Couldn’t display” and “Try again”.

Version 0.9.5 removes the visible Validation notice card and its count from the Heartbeat view. Records and validation remain intact. The user confirmed the native 0.9.5 view removed the card while Heartbeat time and history remained visible.

Version 0.9.6 uses the Kit’s read-only bounded display reader for current Items, the latest wake and paginated history. For paired ledgers it verifies history and backup integrity in chunks without imposing the full-audit reader’s combined 32 MiB limit on the whole history. The head, individual records and pages remain bounded, as does a legacy single-file head. Integrity verification is not a current business audit; display reads report audit as not performed. Any display index is reconstructible in-memory state, and canonical records remain unchanged.

Version 0.9.7 supports current-turn agent views for read-only Kit-bound sources without a managed task lifecycle by fencing the canonical source path and verified latest root start. Ordinary managed task cycle rules remain unchanged. The adapter uses official summary turns and deferred paginated `thread/items/list` metadata with wrapper timestamps, without falling back to the parent’s full historical child inventory. A `notLoaded` child is not evidence of live activity; missing orchestration or an agent plan leaves the planned allocation unknown. The registered-task projection treats `-` on a non-tracking row as empty and accepts valid shared-child DAGs while retaining genuine invalid-link risks. The bounded metadata window is not shown as a Subagents list. Native host acceptance remains separate.

Version 0.9.8 aligns current-agent observation across both authenticated GET paths using the same scope-gated background observer. The full-authorization model GET continues to read canonical task data with its existing security checks. No new authorization flag or state store is introduced. The previous 0.9.7 user reload still showed agents as not ready despite the updated UI; 0.9.8 native acceptance remains to be verified.

Version 0.10.0 can associate existing canonical task leaves with an agent using an explicit assignment, and derives module progress from those leaves. Runtime activity is a recorded observation, not a guarantee of a live process; partial member coverage yields a lower bound, while unknown remains unknown. A ratio requires an exact current plan denominator. Assignment and agent progress do not complete the parent task. Existing source records remain authoritative; no copied checklist or new store is created.

For ordinary managed tasks, after dispatch use the returned native agent thread ID in the existing `task_progress_rescope` objective or item as `agent: { threadId, path? }`, using the current revision and retained scope. Omitting an assignment during an active-cycle rescope preserves it for the same item ID, including a move; explicit `agent: null` clears it. A new cycle does not inherit earlier assignments. An objective assignment is inherited unless an item overrides or clears it. For a read-only Kit Heartbeat source, its writer may maintain `agent_thread_id` or an exact unique owner path in the existing Items workflow; the panel never writes the source. Missing evidence remains unknown and is not backfilled.

Version 0.11.0 adds bounded incremental catalog coverage and tri-state root exclusion for agent observations. Its earlier compact observed count is no longer displayed as a headline in 0.12.4. A single assigned item retains its honest progress state, and finer-grained child progress is reused only from fresh canonical child data. These are recorded observations and canonical projections, not guarantees of live process state. A public latest child turn can provide a `codex-turn` basis for a recorded completed, failed or interrupted state only when identity, root, working directory and parent match and the terminal time is not earlier than the latest parent interaction. An in-progress turn is not proof of a live process. Counts describe timestamped recorded coverage; incomplete coverage remains unknown. A single-item assignment shows its responsibility and state, not a fabricated fine-grained development percentage.

Version 0.12.0 follows active agent work across user turns in the same parent chat without presenting the entire historical terminal inventory as active cards. For the same trusted chat, source and cycle, a pending push or older push missing fields retains the trusted list while requesting fresh GET data. A missing interaction timestamp can permit a fresh observation but not cache reuse. The underlying snapshot can record a count for a bounded observation; this is not the current Desktop count or a headline aggregate. Without an established plan, no denominator is invented; a single task does not gain a fabricated fine-grained percentage. Agent capsules use a fixed-height single line to retain their intended shape. In parent-thread mode, activity in the current main chat spans parent user turns, but progress is associated only when the canonical current task explicitly names the agent threadId. A path is used only to check consistency and uniqueness; a same-named path alone does not establish an assignment. Unassigned progress remains unknown. Existing strict-root and shared APIs retain their previous path matching behavior. Reusing a child’s finer checklist still requires an exact dispatch fence.

The 0.12.1 candidate separates parent-chat activity observation from task-source availability, so a stale source does not hide verified agent activity. Task percentages still require a valid canonical source. Bounded streaming support for large ledger heads is intended to make them discoverable and readable without loading the whole head at once; real-data compatibility and native display require verification.

Version 0.12.2 presents each agent in a 56 px capsule with a single text line and a 2–3 px full-width progress strip. Known progress, including zero, is displayed; absent assignments are Unlinked, while linked assignments without progress are Unknown. Both remain neutral without a fabricated percentage. Progress continues to require trustworthy canonical assignment; a path-only match does not backfill it. Refreshing data cannot reload an older embedded view: closing and reopening the view or refreshing the chat catalog may be necessary. Do not restart Codex.

The 0.12.3 candidate scopes presentation generations and disabled-context cleanup to the affected trusted context. Activity or disabled polling in another chat should not invalidate that context’s retained subagent presentation; revocation still clears the affected scope. Actual native acceptance remains to be verified.

Version 0.12.7 can display evidence-backed progress from an otherwise valid bound Kit ledger when some status-only labels are unrecognized; those leaves remain pending. Strict audit and other integrity safeguards are unchanged.

Version 0.12.6 uses one larger bounded scan to confirm zero association when default discovery is budget-limited and the relation remains unresolved. This wider pass does not bind a source; normal and explicit binding retain their existing safeguards. Relation decisions use the full report before candidate display is compacted. Unresolved discovery is presented neutrally, while actual source failures remain errors.

Version 0.12.5 directs the parent to record returned native agent thread IDs on assigned canonical leaves through the existing task workflow. Subagents can display a verified, timestamped agent observation from the bound task ledger independently of the project Heartbeat view; the two may select different ledgers. Missing assignments and observations remain unknown, and no live Desktop count is inferred. Ordinary tasks use the existing Kit assignment workflow.

Version 0.12.4 replaces the unofficial headline aggregate with a compact notice that the live count is unavailable. Desktop builds its own current-chat roster and counts eligible non-done entries, which can include waiting agents; the MCP Apps interface does not provide that roster or count. Native count parity therefore cannot be established through this interface. Agent details and trustworthy assigned progress remain available, and Heartbeat is explicitly historical.

## Version 0.8.0

Version 0.8.0 defaults to Subagents; Registered tasks remains available and retains the full parent goal denominator. Per-agent progress comes from the Kit normalized snapshot; the former top count is no longer displayed in 0.12.4. A recorded Heartbeat count is shown with its observation time only when its source is related to the current chat; it is not a live count. A separate app-server cannot establish which Desktop agents are running in real time. An individual child’s canonical checklist can supply its progress; missing, bound, uncertain or different-cwd data stays unknown (—) rather than becoming 0% or 100%. No additional state store is created. The panel uses available height, scrolls the middle list and keeps its footer at the bottom. The internal closeout checkpoint is hidden from the task display, while its completion requirements remain unchanged. Load more and Archive use consistent controls. A local standalone fixture preview exists; it is not production data.

## Native panel

The native MCP App uses the Codex Desktop MCP Apps entrypoint and the optional `enable_mcp_apps` feature. Kit installs or reuses the plugin and its Helper without asking about a Dock entry. Check `codex features list` before installation. If the feature is disabled and the user chooses to use native MCP Apps, enable it explicitly with `codex features enable enable_mcp_apps`; the installer never changes host feature settings and returns `NATIVE_MCP_SETUP_REQUIRED` when native MCP support is unavailable or disabled. Reopen or start a chat as required by Codex, then verify the panel in an ordinary chat. Plugin registration, a successful build, and Helper health do not prove that the host displays the UI. Visibility is host-dependent and is not guaranteed on unsupported hosts.

The native App resolves the supported host's current thread identity on each request, then reads only that user's matching, non-subagent, non-ephemeral task, History and project Heartbeat records through the local Helper and canonical Kit APIs. Task writes remain protected by Hook and turn proof. Existing native Codex Goal model APIs, record formats and compatibility are retained; the plugin does not create Goals or provide a custom Goal UI.

Task data follows the Kit canonical records. The native panel shows the registered checklist, recorded status and evidence, paginated History, and a read-only project Heartbeat view. Heartbeat remains observational and does not schedule or write to a ledger. The History panel uses a bounded summary projection (at most 512 KiB source input and 512 Unicode characters per summary) and keeps the full canonical Markdown path available; the underlying Kit records are not truncated or rewritten.

The Heartbeat view shows recorded active child-agent counts before the audit and after re-splitting/dispatch,
with observation times and evidence, and audited blocked tasks with known or unknown Owner intervention needs.
These are snapshots, not live counts. The ten audit categories and full Items registry remain in the canonical
ledger for audit rather than the main view. A first session or older wake without producer-supplied snapshots
shows unknown; it cannot reconstruct past activity. The supervising producer records snapshots through the Kit
heartbeat writer, and the plugin only reads them.

In 0.6.6, the project Heartbeat summary uses two outlined white timecards. The left card contains the latest
recorded date; the next-time card shows the actual time or “Not recorded” when the value is unknown. The
cards have no filename footer or shared gray background and adapt to the host theme, RTL direction, and narrow
panels.

The 0.6.5 signed production Helper uses its embedded matching panel asset even when an older chat launcher
root remains in use. The source runtime continues to use its pinned runtime assets; embedding applies to the
production SEA. If the native panel appears stale after an update, use the chat refresh guidance above;
closing and reopening the panel tab alone may not refresh the host. Do not restart Codex. Verify actual panel
visibility and data separately from Helper health.

## Installation and validation

Use the [AI installation guide](INSTALL-FOR-AI.md). The plugin requires Apple Silicon macOS, Codex Desktop with MCP Apps support, Node.js 22.12+, and pnpm 11 for development/building. Local release signing reuses the existing configured identity; signing does not grant TCC permissions or self-authorize protected folders.

Keep these evidence separate: package/build checks, Helper `doctor` and `verify`, plugin registration, and actual native UI visibility/data in a supported host. A host feature change may require a new chat or reopening a chat. Do not infer UI visibility from command success.

## Task lifecycle

The plugin Helper opts ordinary local task writes into lifecycle semantics with `lifecycle: true`; other
Kit clients can leave the API opt-in disabled for v3 compatibility. Existing schema v3 histories remain
readable and are preserved; a read-only `task_progress_get` never invents a closed state for an older task.
A managed task has one explicit closeout checkpoint: complete it only after required
branch work, merge, and push are physically done or verified not applicable, with verified references,
zero remaining work, and zero Owner actions. Checklist rows at 100% do not close the task, and there is no
human Finish button. A separate execution status continues to describe whether work is active or unknown.

After a completed task receives new scope, use `task_progress_rescope` with its current revision to begin a
fresh cycle. Mid-cycle rescope includes all retained objectives and keeps removed rows as cancelled. A new
cycle after completion starts with the newly scoped denominator; the earlier cycle is retained as a read-only
archive derived from task history. `task_progress_archive` reads bounded pages of archive summaries and
details; archive cycles load on demand, and current subtasks remain a separate view. No raw history is
rewritten and no separate archive store is created. Bound read-only Heartbeat sources have no formal cycle
API, so lifecycle completion and archives are unavailable for them rather than inferred or backed by a
dormant local task. Native Goals remain unchanged.

## Data and compatibility

The local Helper is supervised by the existing launchd service. MCP requests flow through the stdio server to Helper, which reads/writes canonical Kit records according to each operation's authority. Kit's optional `task-progress` category installs or reuses the native plugin; no separate launcher or Dock choice exists.

Existing task and Heartbeat formats remain compatible. Existing schema v3 task events remain readable and are preserved; opt-in lifecycle events use schema v4 in the existing task journal. Archive summaries and details are read-only views derived from that history, not another store. Existing native Goal APIs and original v1/v2 Goal records remain readable. Existing History source data is retained; the concise display summary is a bounded projection only. Preserve the derivative's upstream Git history, license, and attribution when redistributing it.

See [architecture](docs/ARCHITECTURE.md), [permissions](docs/PERMISSIONS.md), [validation evidence](docs/VALIDATION.md), and the [changelog](CHANGELOG.md).
