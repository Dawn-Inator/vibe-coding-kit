# Task Progress 0.5.14

- Add an optional separately signed managed Codex launcher that starts the Helper and Codex with connection arguments; keep the Codex bundle untouched and derive the launcher name/icon from the detected vendor app.
- Add JSON status/install/remove launcher management and the explicit `--dock` replacement option. Preserve unrelated Dock entries and the current session; do not promise that macOS shows only one app icon or that direct launches of the original app are intercepted.
- Reuse an existing verified CDP connection. If Codex is already running without CDP, activation is the only immediate action; a later full cold launch through the managed launcher is needed. Never force-restart Codex or bootstrap CDP into an existing process.
- Disable the older persisted startup-recovery policy during Dock launcher configuration; it is no longer recommended as reliable automatic recovery.
- Keep Kit integration opt-in: an existing plugin is reused by ordinary Kit installation rather than silently upgraded, and launcher configuration requires the explicit opt-in supplied by the Kit worker.
- In interactive Kit setup, ask a separate default-No, one-click question before configuring Dock for a selected, already-installed launcher-capable helper; declining preserves plugin and project selection. Non-interactive saved/auto-detected preferences only reuse the installation.
- Remove the owned launcher and Dock entry before Helper uninstall. Block Helper removal if cleanup fails or a user-edited Dock entry must be retained; preserve legacy-helper uninstall behavior.
- Refresh cached project discovery against bounded directory and Markdown freshness before reuse, so new, modified or deleted Heartbeat files appear even if watcher delivery lags. Keep the fast path for ordinary new non-Markdown files.
- Wait for the native startup listener's readiness before treating the Helper as ready, instead of relying on the first responsive ping.

# Task Progress 0.5.13

- Update foreground startup classification using fresh PID/process identity, positive native `!finished` confirmation, no observed task activity, verified loopback CDP, and positive proof that the target PID owns no onscreen windows. A foreground process may still be preparing before finish and remain eligible when it owns no onscreen window. Any owned onscreen window or missing/unknown window-owner metadata fails closed. The check uses public CoreGraphics owner-PID metadata only, without screenshots or window titles.
- Retain default-off, next-launch-only opt-in behavior. If CDP cannot be verified, normal startup continues; there is no late autorestart, SIGSTOP or app-bundle edit. Clear the failure cooldown only after verified success; normal restarts under 60 seconds remain supported.

# Task Progress 0.5.12

- Add a persisted startup-recovery opt-in, disabled by default. Enabling it changes behavior for a later launch and does not restart the current Codex process.
- The initial replacement gate required both `!finished` and `!active`; 0.5.13 uses positive no-onscreen-window proof tied to the target PID when classifying foreground startup, alongside the native `!finished` check.
- Clear the failure cooldown only after verified success; normal Codex restarts within 60 seconds remain supported. No late autorestart, SIGSTOP or application-bundle edits are used.

# Task Progress 0.5.11

- For watched project Heartbeat discovery, skip invalidation only when bounded directory observations and source inode identities prove a content-only change to a current canonical regular non-Markdown file, including one not previously visited. Incomplete or overflowing observations, unknown filename/type, hard links, rename/delete, directories, symlinks, `.git` changes and explicit source invalidations still invalidate discovery.
- Keep the stable Helper executable and saved local signing choice introduced in 0.5.9; no TCC authorization is copied or assumed.

# Task Progress 0.5.10

- For a previously saved Heartbeat binding, validate that source with one targeted canonical Kit bound-source lookup while retaining path, hash, task-association and custom-inspector checks. New or unbound chats and forced-write discovery continue to use the full project scan; an incomplete scan is never treated as complete or as proof that no source exists.

# Task Progress 0.5.9

- Install the verified Helper as a real executable at the stable `install/bin/goal-progress` path while retaining versioned release assets. Updates copy atomically with rollback, and Doctor verifies the installed file instead of following a symlink. The stable launchd, MCP and Hook paths do not unload Codex.
- Keep the Helper's executable path stable across version updates while retaining versioned release assets. A transition to this path can still require user approval; no TCC grant is transferred or assumed, and later prompts are not ruled out.

# Task Progress 0.5.8

- Use the release-bundled Kit task and Heartbeat APIs by default instead of implicitly loading a personal Kit checkout. Explicit project Kit paths/pins and configured fallback paths remain supported; this changes API resolution only, not task or Heartbeat storage formats.

# Task Progress 0.5.7

- Restrict background startup recovery checks to Helper-owned recoverability hints. A hint only authorizes attempting recovery; after trusted chat identity is established, canonical task files are read and validated normally.
- Support local macOS release signing through `GOAL_PROGRESS_CODESIGN_IDENTITY` or a versioned `release-signing.json` configuration, with ad-hoc signing retained when no identity is configured.

# Task Progress 0.5.6

- Avoid redundant permission updates for private directories that already have the expected ownership and mode, preventing unnecessary filesystem watcher events; mismatched permissions are repaired and operating-system ownership checks remain enforced.

# Task Progress 0.5.5

- Keep the last valid same-scope project Heartbeat summary and history visible while refresh is pending; clear the view when a new scope has no verified snapshot.
- Share bounded Kit discovery across chat and project display while the recursive watcher is live; force fresh scans for writes and drop cached discovery when watcher protection is lost.

# Task Progress 0.5.4

- Reduce bounded Kit Heartbeat discovery work by memoizing the canonical root and Git-boundary checks within one scan; discard the memo between scans.
- Preserve the configured file/depth limits, nested-Git and symlink boundaries, and exact-thread association behavior.

# Task Progress 0.5.3

- Present Heartbeat history as grouped time cards with expandable records and a bounded preview of available raw fields; the source file retains the complete record.
- Keep summaries compact with collapsible diagnostics; retain pagination, host theme support and responsive layouts.
- Reuse project Heartbeat summary cache within its configured scope and 30-second TTL, and reuse in-flight reads per project; resolve `get` independently after related-task-source validation while project display loads in the background. Generation changes refresh without waiting for older requests, with two-second polling. The bound-source watcher invalidates that source's cache.
- Keep the capsule docked and centered, remove horizontal scrolling and dragging, ignore legacy floating preferences, and preserve keyboard focus without a black click outline.
- Order unfinished tasks by reverse original checklist-addition order at the top and completed tasks stably at the bottom; this changes presentation only, not records.
- Presentation-only update; existing tool inputs, storage formats and source-authority behavior remain compatible. The `get` output may include an optional `heartbeatPending` status.

# Task Progress 0.5.2

- Share the renderer bundle size budget between runtime validation and both build paths.
- Reject an oversized production bundle during build and test real generated artifacts through the runtime validator.
- Restore mounting of the capsule bundle, which exceeded the previous 200,000-byte runtime limit.

# Task Progress 0.5.1

- Recognize ordinary task and source-association history through Kit's read-only recovery API, including completed and legacy records.
- Reconnect startup recovery to a verified existing CDP process and reject stale process identity.
- Require explicit authorization before a startup handoff can terminate or relaunch Codex; automatic recovery reports unavailable CDP without restarting the application.

# Task Progress 0.5.0

- Replace the task card with a 44px frosted capsule and progress along its lower curved edge.
- Add separate 40px History and Heartbeat round buttons with mutually exclusive panels.
- Show real task → module → node hierarchy, per-module progress, node status and completion evidence.
- Preserve authoritative task/source selection, paginated task and heartbeat history, and read-only project observation.
- Support host light/dark themes, reduced motion, keyboard/focus return and constrained short-window panels.
- Retain draggable floating placement through display settings and version the renderer for hot replacement.

# Task Progress 0.4.4

- Align empty and existing chats to their measured main content viewport below the titlebar.
- Preserve composer-aligned horizontal bounds and restore layout padding across page transitions.

# Task Progress 0.4.3

- Use the pinned Kit storage contract to route ordinary task records into the trusted chat cwd .workspace.
- Migrate existing per-chat history and heartbeat observations without deleting originals.
- Isolate project/chat data, expose storage paths and report conflicting histories instead of overwriting.

# Task Progress 0.4.2

- Label completion as registered checklist scope, not the whole task.
- Observe current execution independently through App Server status and positive visible composer controls.
- Suppress numeric completion/full bars when a checked checklist is still executing, waiting or unknown.
- Keep historical counts intact and require remaining delivery work to stay in scope.

# Task Progress 0.4.1

- Dock at the top of chat and reserve layout space; floating placement remains optional.
- Bound large heartbeat responses and add paginated history with complete source counts.
- Replace versioned custom elements during live updates without restarting Codex.
- Derive objective display status from its effective checklist items.

# Task Progress 0.4.0

- Add ordinary-chat task tracking, equal checklist counting, evidence and progress regression history.
- Add always-on docked/floating panel with clickable objectives and task history.
- Add read-only canonical Kit heartbeat discovery, selection, inspection and history.
- Isolate application/plugin identity and local state from upstream Goal Progress.
- Preserve native Goal tracking and v1/v2 data reading; add revision-safe v3 ordinary task events.
- Refuse automatic source-runtime restarts; ship local build/manual install workflow.
- Keep the root source tree authoritative; generated plugin packaging includes its own runtime source.

Original upstream history follows.

# Changelog

## 0.3.12 - 2026-11-10

- Automatically reconnect and restore the progress bar after long sessions or system sleep.
- Clear outdated update prompts immediately after upgrading.
- Reclaim disk space from older versions during upgrades and reduce page and conversation overhead.

Existing goals, checklists, progress, and display preferences are preserved.

## 0.3.11 - 2026-11-09

- Compatible with the latest Codex Desktop update.
- Faster local status checks.

Existing goals, checklists, progress, and display preferences are preserved.

## 0.3.10 - 2026-10-13

- Restore the right progress when reopening chats or switching between windows.
- Keep progress working when your system timezone changes.
- Report missing progress correctly and complete local installation checks without waiting on unrelated plugin catalogs.

Your existing goals, checklists, progress and display preferences are preserved.

## 0.3.9 - 2026-09-27

- Keep Goal Progress working after recent Codex app updates.
- Restore progress more reliably when the Codex window takes longer to become ready.

## 0.3.8 - 2026-09-16

- Keep Goal Progress startup recovery working while the Xcode license remains pending.
- Read `arm64`, `x86_64`, and Universal architectures from the existing Mach-O file description.
- Report missing paths separately from specific validation failures for an existing Codex app.

## 0.3.7 - 2026-09-09

- Keep active work visible when another item in the same group is blocked, with consistent current and next-step guidance.
- Continue the existing checklist and confirmed results when a completed Goal is extended.

## 0.3.6 - 2026-09-07

- Make large sets of similar deliverables easier to follow in separate progress groups.
- Preserve existing checklists and confirmed progress when continuing work or changing scope.
- Save cancelled work correctly without counting it as completed.

## 0.3.5 - 2026-09-07

- Build the Helper locally after installing the source plugin; Node.js 22.12+ and pnpm 11 are required.
- Generate Contract IDs in the plugin instead of asking the model to invent them.
- Restore progress after normal Codex restarts through the source startup listener.
- Add source upgrade rollback, explicit uninstall, and marketplace scanner CI.

- Replace the large error card with a compact status line, retained progress, Retry, and Close.
- Keep task blockers separate from plugin failures, preserving the checklist and native paused state.
- Refresh the renderer after same-version reinstalls and keep floating status controls inside narrow windows.
- Build source and prebuilt packages from the same renderer revision and correct the nested prebuilt marketplace entry.
- Update MCP transitive dependencies to `fast-uri` 3.1.7 and `qs` 6.16.0; the production audit reports no known vulnerabilities.
- Rebuild the source plugin before assembling the macOS release, so `pnpm build:release:macos` works from a clean clone.

## 0.3.4 - 2026-09-02

- Added compatibility with the latest Codex and fixed the progress UI disappearing after updates.
- Fixed Goal Progress activation in existing tasks after plugin updates.
- Fixed stale version numbers after upgrades.

## 0.3.3

- Goal Progress now follows the Codex interface language and text direction automatically.

## 0.3.2

- Progress is calculated from a structured checklist that breaks the goal into weighted, measurable steps.

## 0.3.1

- Fix a startup fallback loop that could repeatedly open and close Codex.

## 0.3.0

- 🔌 **Start from the official Codex icon.** Goal Progress sets up the required CDP connection
  automatically. No extra command or manual setup is needed.
- 🔄 **Progress returns after a full quit.** Reopen an old task to restore its checklist, progress,
  Token count, and display settings. You do not need to be on a task with progress when you quit or
  start Codex.
- 🪟 **Multiple windows are now supported.** New windows, task links, and tasks opened in a new
  window connect automatically. Each window follows its own task. Switching or closing one window
  does not affect another.
- 🎉 **Update inside Codex.** Goal Progress checks for new versions automatically, and you can also
  check manually. Select **Update now** to download, verify, and install an update with real
  download progress.
- ⋯ **A new More menu.** The three-dot menu has **Version**, **Effects**, and **Display** sections.
  You can view the installed version, check for updates, open release notes, change animations, and
  choose a display position in one place.
- 🧩 **More reliable installs and updates.** Fixed early install failures and enabled the Hook
  required by the plugin. Interrupted downloads can be retried. Restarting no longer leaves updates
  stuck on **Restart required** because of recovery timing.
- 🛠️ **Cleaner code and better recovery.** Large files were split and repeated install, Doctor,
  and Verify code was reduced. Page reloads, task switches, and interrupted updates recover more
  reliably. Temporary files are removed after an update completes.
- 🤖 **A new cute robot logo.** Goal Progress now uses the new transparent robot icon.

## 0.2.2

- Support the latest Codex Goal row, sidebar task, and composer structure.
- Remove Goal Progress as soon as the native Goal completes instead of leaving a 100% card.
- Keep fixed progress at its verified native position during arbitrarily long composer input.
- Report component visibility from its real viewport and clipping intersections.
- Preserve the verified Goal identity through fallback so old progress cannot attach to a
  replacement Goal.
- Read Goal identity only from the stable objective text, excluding dynamic status and elapsed time.
- Follow the live native Goal left and right boundaries for fixed progress width.
- Remove stale Plugin cache versions after successful installs and upgrades.
- Keep active MCP sessions working across compatible updates without restarting Codex.

## 0.2.1

- Resolve the current Goal thread when a Hook session candidate is invalid or not loaded.
- Match Current, Paused, and Overall progress label weights to the live native Goal title.
- Follow task switches through page events instead of a permanent two-second Helper timer.
- Recover Renderer delivery immediately from WebSocket close events with bounded retries.
- Keep idle Goal Progress installations free of periodic visible-thread checks.

## 0.2.0

- Keep Goal Progress visible across Codex Desktop version changes.
- Select Native or managed fallback placement from the current Goal-row structure.
- Reuse one Host and one complete ViewModel while switching between display modes.
- Restore Goal Progress after returning to the task and after page lifecycle changes.
- Treat healthy fallback and retained states as valid Renderer delivery.
- Recover the latest Token and tracking state even when the Contract revision stays unchanged.
- Clean failed candidate injection and preserve the original native Host.

## 0.1.2

- Add a measured Goal-row Adapter for Codex Desktop `26.820.60940 (7119)`.
- Preserve fail-closed behavior for every unmeasured Codex Desktop version.

## 0.1.1

- One-line installation now follows `INSTALL_RESTART_REQUIRED`,
  `INSTALL_RESTART_PENDING`, and completed JSON protocol states.
- Reproducible SEA Helper builds no longer embed the local source or build path.
- Release assets include the matching Node.js license and generated production dependency notices.

## 0.1.0

- First public release.
- Deterministic checklist progress for native Codex Goals.
- Local Helper, MCP, Contract store, Core calculator, and isolated Renderer.
- Fixed and draggable floating layouts.
- Light, dark, accent, UI-size, and language adaptation.
- Verified one-line macOS installation with Release ZIP and SHA-256 assets.
- Reliable new-task identity recovery and transactional cross-version Plugin rollback.
- Plugin integrity anchored to the verified top-level Release manifest.
- Clear non-interactive installation errors and immediate restart failure handling.
