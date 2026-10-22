---
name: agent-task-supervision
description: Use when ≥3 agents are in flight AND expected total runtime is >2h, OR a single-agent autonomous session has run or is expected to run >2h (overnight, unattended) — registers a long-running, parallel-subagent-dispatch heartbeat (via whatever periodic/scheduled capability your AI tool provides — verified with a short delivery probe before it is trusted — plus the wake points every session already has for free: a subagent-completion notification, a new incoming message, dispatching a new subagent) that audits in-flight subagents for stuck/orphaned work and checks whether parallel dispatch is under-utilized. Below both thresholds, no cron, no heartbeat line. This is a self-administered heartbeat you run yourself, never a separate supervisor agent watching the others.
---

# Agent Task Parallel Heartbeat

A heartbeat for long multi-agent orchestration, run at each timer wake by the orchestrating session itself, never by a "supervisor" subagent.

## Workflow

**Register when either holds:** **A** ≥3 agents in flight AND expected runtime >2h; **B** one agent works autonomously and the session has run or will run >2h (overnight, unattended). "Expected >2h": user said overnight/unattended, backlog clearly >2h, or >2h since the first action.

**Wake point.** 1. Arm your tool's wake-up mechanism, default **20 min** announce mechanism, interval, next due time in one line.
2. First a one-shot delivery probe (1–3 min), then **yield** (end the turn); registered only when it arrives. Not within ~2x its delay: delete it, name the failure, try the next; none delivers → go event-anchored.
3. One-shot timers chain: each firing **re-arms first, then audits**; re-arm at any wake where none is armed.
4. The audit runs **only at the timer wake**. Other notifications and turns are handled for what they are (act on a landing, final report or blocker, ingest it and run the sweep that turn, else reply empty): no full audit, ledger section or status line. Event-anchored self-checks (≥1 interval apart) only without a timer.
5. A one-shot condition waiter (health check, deploy) is a separate chain; it never swallows the heartbeat's re-arm.

<!-- BEGIN: claude-only -->
Claude Code arms with one script, never a hand-typed timer:

- **Arm**: `pnpm heartbeat:arm -- --ledger .workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md` via `Bash` `run_in_background: true` (`--minutes N`); it sleeps, prints the checklist, exits; its completion wakes you.
- **Wake output**: a ledger block plus a re-split prompt. **Probe first**: `pnpm heartbeat:arm -- --probe` (75 s).
- **Ledger gate**: each arming appends to `heartbeat.arms`; arming k+1 is refused (exit 3) unless the ledger holds ≥k-1 wake sections: append the missing one, run the `--latest` checker below, re-arm.
- Stop with `TaskStop` or do not re-arm; `Monitor` is not the heartbeat.
<!-- END: claude-only -->

**At every timer wake**, yourself, synchronously:

0. **Chain, quota, load.** One armed timer, else re-arm. Quota ≥ "stop new dispatch" → no new agents; ≥ "stop everything" → merge/handoff. Load >~2x cores → pause new *heavy*-process tasks, never agent dispatch. Any orchestrator-imposed throttle/freeze is an `## Items` row with `expires <ISO>` or `recheck: <condition>`, re-evaluated every wake.
1. **Audit in-flight subagents** for "waiting on a notification that never arrives". Flag, never terminate.
   - **Worker-health:** last notification an interim sentence and no live background children → STALLED, nudge now. Elapsed >2x expected, or the same step ≥3 times → circuit-breaker row.
   - **Stall detector:** `pnpm heartbeat:check-stall -- "<notification text>"` on EACH worker notification of this window (exit 1 = next step announced without evidence).
   - Stale worktrees (`pnpm worktree:status -- --stale`): nudge, or resume there if the worker is gone.
2. **Free/blocked backlog procedure (mandatory).**
   - `free` = deliverable now; write set overlaps no in-flight worker or free item. `blocked` = `<item> ← blocked because <resource> is required for <first step>`, only if no deliverable line is possible without it; `<resource>` is a named **exclusive** resource (a ref that must not move, a lock, a scarce machine, `<path> write set held by <worker>`) plus a reason; "in flight" or "one batch/more complete later" means free. Landing-stage resources (preflight slots, finish lock, another landing in flight or queued, host load) never block implementation (only the landing waits): the item is `free`. A `write set` conflict names the overlapping FILES; an item overlapping only a branch, or waiting on another unit's unlanded output, bases on it and lands after. A `blocked` row naming a unit/SHA the registry shows done, or unchanged >24h, is stale: re-verify it now. One agent per free item. On every landing re-scan blocked items and dispatch what it freed. **FAIL**: an undispatched free item, or a bare free/blocked count.
   - **Ten-category sweep, item or "none" each:**
     1. **Goal-derived remaining work**, two answers: **(1a)** critical-path next step(s) toward the plan/gate/owner objective, named even if blocked; **(1b)** off-critical-path goal work (result gaps, coverage, anything needed before "complete"), answered independently. `free 0` needs both; in-flight ≤2 AND 1a blocked → enumerate 1b first or FAIL. Answer 1b from a maintained remaining-work list (`.todolist/`), struck on landing.
     2. read-only review of commits since the last review.
     3. temporary status updates for landed facts, in `.workspace/` never `doc/`, ≤hourly.
     4. long-lived knowledge artifacts (Skill/Doc/History/memory) owed; a fact fitting 3 and 4 goes under both.
     5. tooling/test fixes for defects this session, incl. the orchestrator's workarounds.
     6. release/deploy prep needing no scarce resource.
     7. follow-ups from finished workers.
     8. centralized verification not yet run on the tip.
     9. session hygiene: leftover worktrees (dry-run cleanup, never inline `--apply`), background shells/watchers, owed history.
     10. deployable-unit drift: per target stage, each unit's running SHA/version vs target, a line per unit behind; cite a check against your stage x unit matrix or name the units unchecked.
   - **`sources:` line every wake** (missing = FAIL): `sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ <timestamp>|blocked ← <reason>) worker-health(✓)`. An external backlog (bug tracker, issue queue) is read at start and every ≤6h; if inaccessible mark the token `blocked ← <reason>` AND open an `owner ←` item.
   - **Mechanical discovery sweep, required on every wake that is not an interim notification** (timer, landing, report, blocker, human message). Each wake, run `pnpm heartbeat:sweep`; every row in its `free-candidates:` list is not blocked, so ingest and dispatch it that same turn, and take the status line's `in-flight / free-undispatched / blocked` numbers from its last line rather than from memory. Pass `-- --ledger <ledger>` (read-only, offline: `git fetch` first; exit 1 = candidates); a candidate is an `## Items` row dispatched or reclassified with proof that turn, never "next wake" (Audit FAIL). It also covers landings (2), reclaimable worktrees (9), registry hygiene, probes; walk the other categories citing each query.
   - **Categories 2 and 8:** never defer for "more commits/workers to land" (reviews bind to existing SHAs, verification to the tip); batch only for a named input due ≤20 min (`deferred ← <input> ETA <=20m`). A category-2 review of a checker/guard/gate landing runs that checker in strict mode on the landed tip; its `done` row cites the backticked command, not a bare SHA.
   - **Dispositions:** every review finding, coverage gap, file:line, "out of scope" caveat in a worker report, below-target result or missing evidence gets its own line: `dispatched (<worker>)` / `declined: <reason>` / `blocked ← <resource>`.
   - **Ten-row ledger every wake**, never abbreviated ("same as before"); every `free 0` restates all ten. Row 1 is `(1a) <state>; (1b) <state>`. Every other row and each part of row 1 is exactly one of: `in-flight <agent/unit>` · `dispatched <unit>` · `blocked ← <named exclusive resource>` · `deferred ← <input> ETA <=20m` · `empty — <concrete query/evidence run this tick>` · `done — <backticked command/output or SHA>` · `unchanged — \`<command rerun this wake>\``. `unchanged` is for rows 2–9 unchanged since the previous wake, never on the first wake, for a row `deferred` last wake, row 1 or row 10.
   - **Re-split: the default answer is yes.** Every wake, find the split: each `blocked ←` / `deferred ←` table row and `blocked ←` `## Items` row gets a verdict in `re-split: … rows(<id>: split→dispatched <unit>; <id>: cannot-split: <proof>)` (ids `r1b`, `r7`, `I12`). A proof is one tag: `needs-landed: production effect` · `branch-unstable: <branch> rewritten in the last 60 min` · `owner-gated` · `same-file conflict: <path>`; another unit's unlanded branch/output alone is no block (base on it, land after it). Write `splittable: <dispatched-this-wake>/<rows-with-proof>` in the wake and status line. Two idle (1b) wakes running also need `prep-ahead(<items | none — reason>) lessons(…) audit(…)`; a `none` cites a check run THIS wake, is rejected while any open row lacks a proof, and the same `none — …` three wakes running is red. Why: a checker's open question gets answered for the checker; this presupposes yes and demands item proof, as the Owner's direct question does.

     `deferred`'s `<input>` is the artifact this very item consumes, never a borrowed trigger; the same input deferred two consecutive wakes becomes `dispatched` or `blocked ←`. Split composite items: a part with inputs on hand is its own `dispatched` row. `empty` names its query (`git log <last-reviewed>..origin/main` for 2; deployed SHA vs branch tip for 10; `git worktree list` for 9). "Checked worker logs/branch tips" is no evidence. "Nothing to dispatch" without all 10 rows = FAIL.
   - **Ledger checker before ending the tick:** `pnpm check:heartbeat-ledger -- <ledger> --latest`; clear every red row (heading, `sources:`, ten rows once each, allowed states, `empty`/`done` with a backticked command or SHA, `blocked ←` naming a first-step resource, strict `deferred ←`, no repeated deferred input, no freeze without expiry). Never rewrite old wake sections; an unwired checker is category 5.
   - **A shared-branch landing auto-opens two rows** next wake: category 2 (review of that range) and category 10 (drift of the affected stage).
   - **Item registry:** one `## Items` table (`id | source | item | status | evidence`) in the session file, updated every wake; append rows inside the table (rows outside are `item-outside-table`). Status is exactly `ready` / `dispatched <agent-or-unit>` / `done` (evidence in the evidence column) / `blocked ← <exclusive resource>` / `owner ← <hard category: irreversible / security boundary / significant cost / owner decision> + <standing authorization checked and why it does not cover this item>` (a covering authorization makes it `ready`/`dispatched`). Source is `memory:`/`handoff:`/`report:`/`landing:`/`owner:`/`sweep:`/`audit:`/`goal:` + ref. Ingest a worker's final report the turn it arrives (each follow-up/not-done is a row) and every memory/handoff open-item list at start, resume or compaction. **End every wake with zero `ready` rows.**
   - **Replay counter:** each full-chain publish/deploy/migration dispatch item carries `replays:<unit>=<N>` (stable slug), +1 per re-dispatch, never reset; N ≥3 fails without a done/dispatched `audit:<unit>` (or `report:<itemId>` root-cause audit), as does any decrease.
   - **Registry checker every wake:** `pnpm check:heartbeat-ledger -- <ledger> --items` (ready count, stray/duplicate rows, `owner ←` proof, `done` evidence, replays, stale/landing-stage `blocked ←`, freezes).
3. **Direction check** with your project's anti-tunnel-vision diagnostics: no hit → "direction fine"; hit → apply its remedy first (a full re-evaluation belongs to your architecture review). "Waiting for X" while `free` backlog exists is a hit: back to step 2.
4. **Overreach check:** did the orchestrator edit source/test/config itself instead of dispatching, or land a change without its oracle passing, since the last heartbeat? If so state `direction: switch (orchestrator self-fix)`, stop, dispatch a worker.

**Status line.** Internal notifications (not the timer's fire) accumulate (zero tool calls), read together at the next wake. A worker's **interim notification** (still running; no landing, report or blocker) gets an **empty reply**. A human message is answered at once; one about progress or speed ("can this be split", "why still …") also re-runs the free/blocked procedure that turn and reports what it newly dispatched. Ledger (append-only) `.workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md`; each timer wake appends `----`, `## <ISO time> wake (10-row ledger)`, the `sources:` line and the table, and chat gets **exactly one** line `[heartbeat] in-flight N · xx% · splittable: D/P · blocked: <none|item>` (real numbers). A pass with a dispatch, landing, direction switch or overreach prints instead exactly: `audit HH:MM | <+dispatched X, landed Y, direction switch, overreach found> | splittable D/P | free F (<names, or "0, ten categories (1a/1b) swept">) | blocked: <item ← resource>, …`, only at the wake. Timestamps: copy from evidence (receipt, `HEARTBEAT due HH:MM:SS`), never `date`.

**Caps** (a not-yet-due step is `done — <last run's evidence and time>` or `deferred ← <window end> ETA <=20m`): verification ≤1/hour or per 3 landings; review once per feature plus one re-review; category 3 ≤hourly.

**RESUME/handoff** (`.workspace/`, never `doc/`) at ~40% context, owner leaving, before compaction: per agent worktree, deliverable, blocked items, next step.

**Cleanup**: before the session ends stop re-arming and cancel every wake-up (timers, monitors, probes); no OS cron/launchd/daemon.

## Report Boundary

Advisory only: no verdict, never blocks a finish, vetoes an exit or grants authority. **Flag, don't act:** for a stuck, orphaned or contradictory subagent the audit only reports; it never kills, restarts, runs finish/cleanup or deletes a worktree/branch. **Judge completion by the terminal receipt** (exit code, push/merge outcome, receipt path), not attribution metadata; without one: "not enough evidence".
