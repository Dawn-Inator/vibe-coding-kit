---
name: agent-task-supervision
description: Use when ≥3 agents are in flight AND expected total runtime is >2h, OR a single-agent autonomous session has run or is expected to run >2h (overnight, unattended) — registers a long-running, parallel-subagent-dispatch heartbeat (via whatever periodic/scheduled capability your AI tool provides — verified with a short delivery probe before it is trusted — plus the wake points every session already has for free: a subagent-completion notification, a new incoming message, dispatching a new subagent) that audits in-flight subagents for stuck/orphaned work and checks whether parallel dispatch is under-utilized. Below both thresholds, no cron, no heartbeat line. This is a self-administered heartbeat you run yourself, never a separate supervisor agent watching the others.
---

# Agent Task Parallel Heartbeat

This is an optional, intensive coordination recipe. The kit provides reusable supervision modules, but
`init` does not register heartbeat schedules, probes, ledgers, or the package scripts shown in older project
integrations. Apply this recipe only when the consuming project has opted into it and supplies the required
project-specific configuration and wake-up capability. Adapt its cadence and governance rules to that
project; they are not universal kit policy. Threshold B dispatch-only ownership is independent of this
optional heartbeat recipe; see agent-orchestration-guardrails.

A heartbeat for long multi-agent orchestration, run at each timer wake by the orchestrating session itself, never by a "supervisor" subagent.

## Workflow

**Register when either holds:** **A** ≥3 agents in flight AND expected runtime >2h; **B** one agent works autonomously and the session has run or will run >2h (overnight, unattended). "Expected >2h": user said overnight/unattended, backlog clearly >2h, or >2h since the first action.

**Developer task intake.** When supervision is active, record each new or materially changed actionable developer request in the session's existing `## Items` registry immediately upon receipt, before unrelated work or the next timer wake. Update the existing row for a correction or add a separate row for new work; preserve the request, scope and constraints, use an `owner:` source and the registry's allowed statuses, and keep already completed history accurate. A question, status request or simple acknowledgement is not a new task. After the write succeeds, tell the developer in that same turn that the task was added or updated in the heartbeat ledger; if the write fails, state that it was not recorded and why. Do not claim success before the write. Intake does not trigger a full heartbeat audit or grant permission for restricted actions. A consuming project may opt into this intake for shorter tasks without activating a timer.

**Wake point.** 1. Arm your tool's wake-up mechanism, default **20 min** announce mechanism, interval, next due time in one line.
2. First a one-shot delivery probe (1–3 min), then **yield** (end the turn); registered only when it arrives. Not within ~2x its delay: delete it, name the failure, try the next; none delivers → go event-anchored.
3. One-shot timers chain: each firing **re-arms first, then audits**; re-arm at any wake where none is armed.
4. The audit runs **only at the timer wake**. Other notifications and turns are handled for what they are (act on a landing, final report or blocker, ingest it and run the sweep that turn, else reply empty): no full audit, ledger section or status line. Event-anchored self-checks (≥1 interval apart) only without a timer.
5. A one-shot condition waiter (health check, deploy) is a separate chain; it never swallows the heartbeat's re-arm.

<!-- BEGIN: claude-only -->
Claude Code arms with one script, never a hand-typed timer:

- **Arm**: `node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --ledger .workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md` via `Bash` `run_in_background: true` (`--minutes N`; for N above ~25 also pass the Bash call a `timeout` (ms) longer than the interval, because the default 30-minute background limit kills the timer before it fires); it sleeps, prints the checklist, exits; its completion wakes you.
- **Wake output**: a ledger block plus a re-split prompt. **Probe first**: `node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --probe` (75 s).
- **Ledger gate**: each arming appends to `heartbeat.arms`; arming k+1 is refused (exit 3) unless the ledger holds ≥k-1 wake sections: append the missing one, run the `--latest` checker below, re-arm.
- Stop with `TaskStop` or do not re-arm; `Monitor` is not the heartbeat.
- **Child sessions** (claude-code-remote): record each `create_session` as an Items row owned by `session:<id>` and its outcome branch with `heartbeat-branches.mjs record --owner session:<id>`; at step 1b `get_session` each `poll` id (`list_events` with `kinds: ["result"]` for the final message); finished and verified on its base → `archive_session`, then `archived` in its row.
<!-- END: claude-only -->

**At every timer wake**, yourself, synchronously:

0. **Chain, quota, load.** One armed timer, else re-arm. Quota ≥ "stop new dispatch" → no new agents; ≥ "stop everything" → merge/handoff. Load >~2x cores → pause new *heavy*-process tasks, never agent dispatch. Any orchestrator-imposed throttle/freeze is an `## Items` row with `expires <ISO>` or `recheck: <condition>`, re-evaluated every wake.
1. **Audit in-flight subagents** for "waiting on a notification that never arrives". Flag, never terminate.
   - **Worker-health:** last notification an interim sentence and no live background children → STALLED, nudge now. Elapsed >2x expected, or the same step ≥3 times → circuit-breaker row.
   - **Stall detector:** `node .vibe-coding/kit/src/supervision/detect-announcement-stall.mjs "<notification text>"` on EACH worker notification of this window (exit 1 = next step announced without evidence).
   - Stale worktrees (`node .vibe-coding/kit/cli.mjs worktree status --stale`): nudge, or resume there if the worker is gone.
   - **1b. Child sessions and branches:** `node .vibe-coding/kit/src/supervision/heartbeat-branches.mjs check --ledger <ledger>` and the [closeout](references/branch-closeout.md): a finished child session is verified on its base (landed first if not), then archived; every `cleanable`/`gone` registered branch is cleaned with `clean --apply`; `land-pending` is landed, then cleaned. Every branch a dispatch creates is `record`ed into `branches.md` beside the ledger the turn it is created.
2. **Free/blocked backlog procedure (mandatory).** At each applicable wake, follow the complete [backlog audit](references/backlog-audit.md), including the ten-category sweep, registry, re-split, and ledger checks.
3. **Direction check** with your project's anti-tunnel-vision diagnostics: no hit → "direction fine"; hit → apply its remedy first (a full re-evaluation belongs to your architecture review). "Waiting for X" while `free` backlog exists is a hit: back to step 2.
4. **Overreach check:** under threshold B or another applicable dispatch-only policy, did the orchestrator implement a write unit itself instead of dispatching? If so state `direction: switch (orchestrator self-fix)`, stop and dispatch a worker. In every mode, separately flag a landing without its oracle passing; ordinary self-implementation alone is not an overreach.

**Status line.** Internal notifications (not the timer's fire) accumulate (zero tool calls), read together at the next wake. A worker's **interim notification** (still running; no landing, report or blocker) gets an **empty reply**. A human message is answered at once; one about progress or speed ("can this be split", "why still …") also re-runs the free/blocked procedure that turn and reports what it newly dispatched. Ledger (append-only) `.workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md`; each timer wake appends `----`, `## <ISO time> wake (10-row ledger)`, the `sources:` line and the table, and chat gets **exactly one** line `[heartbeat] in-flight N · xx% · splittable: D/P · blocked: <none|item>` (real numbers). A pass with a dispatch, landing, direction switch or overreach prints instead exactly: `audit HH:MM | <+dispatched X, landed Y, direction switch, overreach found> | splittable D/P | free F (<names, or "0, ten categories (1a/1b) swept">) | blocked: <item ← resource>, …`, only at the wake. Timestamps: copy from evidence (receipt, `HEARTBEAT due HH:MM:SS`), never `date`.

**Caps** (a not-yet-due step is `done — <last run's evidence and time>` or `deferred ← <window end> ETA <=20m`): verification ≤1/hour or per 3 landings; review once per feature plus one re-review; category 3 ≤hourly.

**Cleanup**: before the session ends stop re-arming and cancel every wake-up (timers, monitors, probes); no OS cron/launchd/daemon. Close out branches and child sessions first ([closeout](references/branch-closeout.md) "Session end").

## Report Boundary

Advisory only: no verdict, never blocks a finish, vetoes an exit or grants authority. **Flag, don't act:** for a stuck, orphaned or contradictory subagent the audit only reports; it never kills, restarts, runs finish/cleanup or deletes a worktree/branch. **Finished work is closed out, not flagged:** a unit with a verified terminal receipt is landed through the project's finish path, its child session archived and its registered branches cleaned, only via `heartbeat-branches.mjs clean --apply` and its gates ([closeout](references/branch-closeout.md)); unlanded work is never deleted. **Judge completion by the terminal receipt** (exit code, push/merge outcome, receipt path), not attribution metadata; without one: "not enough evidence".
