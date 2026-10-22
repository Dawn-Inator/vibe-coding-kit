---
name: agent-orchestration-guardrails
description: Use before subagent dispatch or heavy commands to choose independent write scopes, worker models, platform contracts, and host limits.
---
# Agent Orchestration Guardrails

Read before launching parallel work or letting workers run local commands. This entry holds go/no-go rules
and red lines; `references/*.md` holds the full text per topic.

Keep the developer-selected model and effort; no startup routing card or switch wait is required.
**A "maximum effort" or "ultra"
setting is an effort selection only; it never grants delegation authority on its own.** Before every
dispatch decision read Core Rule, Orchestration Mode Selection and Worker Model Selection below.

## Core Rule

Maximize safe agent parallelism, but globally limit heavy processes **per host**. Read/grep/edit work is
cheap; tsc, dev servers, browser/e2e, builds, installs are heavy. Default until measured: at most 2 heavy
groups on a ≥10-core host, 1 on fewer; never throttle agent count "to save memory".

### When To Parallelize, When Not

Fan out only independent write units with a measurable wall-clock benefit; no parallel floor, and task size
alone is no reason. Dispatch is **required** when all four hold: expected >~15 min; root cause/next action
known (execution, not investigation); fits a self-contained task packet; write scope overlaps no in-flight
worker. Absorbing such a unit into the orchestrator's own turns is a guardrail violation. Do not fan out
open investigation or overlapping write sets; merge <~15 min packages that share a write set and blocking
dependency into one dispatch.

### Dispatch Red Lines

- Every dispatch sets `model` explicitly (plus effort/context-carry on Codex), at **every** level of the
  chain; a worker that fans out lists each sub-agent and its model.
- Workers never run package-level/full tests, tsc, build, e2e, dev server, browser suite, install or other
  heavy commands, locally or remotely — only the exact light check named in the packet; never host-sync
  commands, shared-resource cleanup, another worktree's dependency symlinks, or whole-env/secret dumps.
- Workers never write into the human primary checkout; facts come from origin refs or their managed worktree.
- Workers do not spawn agents or windows; out-of-scope findings go in the final handoff.
- On finish a worker stops every background shell/loop/watcher it started and attaches `ps` proof; a
  report without it is invalid.
- Quota is hard: ≥95% stop new dispatch, ≥97% stop all, merge, hand off. Reviews cover four categories only
  (money, security boundary, never-run SQL, real-device-only).

## Orchestration Mode Selection

Pick by **where results land**, not by task size; do not assume a mechanism from one platform exists on
another.

### Claude Code

- Workflow mechanism, where exposed: results return for synthesis; large fan-out.
- Per-turn Task/Agent dispatch: results return to the session; roughly 3-15 mid-size subtasks.
- An independent/spawned task window does NOT return results: only for high-risk refactors needing human
  supervision, opened by the orchestrator alone, with a hand-written guardrail header (it inherits nothing).

<!-- BEGIN: agent-only -->
### Codex

- `collaboration.spawn_agent` shares the current directory; it does not create an isolated worktree.
  Give each worker an explicit absolute managed worktree path, or disjoint file write sets in one managed
  checkout. In a shared managed checkout, only the orchestrator stages, commits and finishes; workers
  never race on the shared Git index or refs. Conversation/context isolation does not isolate files.
- Pass explicit `model`, `reasoning_effort`, and `fork_turns: "none"` when overriding model/effort with
  this tool; a full-history fork inherits the parent and rejects overrides. Other adapters use their own
  schema. Put no parent thread id or "send message to thread" instruction in a worker packet.
- A worker returns **exactly one** final structured handoff privately by completing its task; it never
  messages another task or shared UI. Liveness signals only prove the worker is alive; the worker's private
  final is the accepted result channel. A missing final, intermediate cross-task update or visible task
  message is blocked: never fall back to a user-visible handoff.
- Before taking over a stalled worker, check its process tree, own worktree commits and background work;
  a completed lifecycle signal alone is not proof of death. See
  [ownership and recovery](references/ownership-and-recovery.md) for the decision and recovery path.
- Disjoint areas, waves; limit recovery in `references/dispatch-decision.md`.
<!-- END: agent-only -->

Loop: parallel write (disjoint files, zero heavy processes) → orchestrator merges and verifies ONCE →
feed each worker back its own failures.

## Coordinated Worker Protocol (frontier orchestrator + delegated workers)

Whichever platform and model you use as the top-level orchestrator, keep goal interpretation, dependency
ordering, conflict resolution, architecture forks, integration, and final semantic acceptance **in the
orchestrator**. Delegate bounded execution to a mid-tier write-capable worker (Sonnet on Claude, Luna on
Codex); escalate to Opus / Terra only to discover or reconcile an uncertain subsystem boundary or for a
submodule-level architectural fix.

After an implementation candidate is committed, and before final acceptance of a non-trivial integrated
multi-agent candidate, dispatch an **independent pre-review worker** (Terra on Codex; Opus/Fable-tier on
Claude). Give it `write_scope: none`, bind it to the exact candidate commit, name its oracle and negative
checks, and keep it separate from every implementation owner. It must not
edit, commit, merge, finish, push, deploy, invoke release/gate authority, or spawn another agent — it
returns commit-bound findings and a fix/blocked recommendation; the orchestrator combines that with the
approved goal and centralized validation for the final call. A changed candidate commit makes the
pre-review stale; redo it. Skip only for a bounded single-worker candidate with an exact oracle, and
record why.

Claude workers: Haiku is read-only; Sonnet owns bounded writes. Opus/Fable return judgment only.
Read [coordinated-worker-protocol](references/coordinated-worker-protocol.md) for the platform review
seats and acceptance split when they apply.

Before the first broad wave, dispatch one representative low-risk task as a health check: confirm one
private structured final, respected write scope, no heavy processes, usable evidence.
Workers must not spawn additional agents or independent windows — the top orchestrator owns fan-out.

### Task Packet Reference

Name the target, writable files and absolute worktree, basis/oracle, candidate SHA, exact verification,
private final channel, requested/actual model and effort, attempt/escalation, and durable progress.
Missing runtime identity is "unknown", never inferred. Evidence is bound to a SHA; published is not
verified. Read [task-packet](references/task-packet.md) when preparing a dispatch.

## Worker Model Selection (No Same-Tier Default)

Every dispatch sets the model explicitly; never inherit the caller's tier. An independent pre-review
worker must use an explicit model, explicit effort, and a "do not carry the orchestrator's full context"
setting.

- **Claude**: Haiku read-only only; Sonnet for every write-capable task, even "high-risk" ones once
  design/root cause is known. Opus only for (a) review/falsification, (b) root-cause investigation, (c)
  security-boundary design decisions; write `opus because (a|b|c): <reason>` first, else Sonnet.
- **Codex**: pass model, effort and fork setting together; never mix an override with a full-history fork.
  Luna is the default executor when objective, writable scope, and an acceptance oracle are all
  explicit, even across multiple files; Terra is the fallback for discovering/reconciling subsystem
  boundaries or a submodule-level architectural fix; Sol is for a genuine architecture/semantic fork or an
  independent final review. A "max reasoning" toggle on Luna adds depth; it does not turn Luna into Terra
  or Sol.
- Difficulty picks the tier; risk picks verification strength; "high-impact" alone never justifies a
  frontier tier. Mirror this floor into the always-loaded project file.

## Worker Prompt Requirements (checklist)

- Explorer: `write_scope: none`, no edits/commits/finish/publish/git writes.
- No heavy commands; missing deps are reported, not installed; pre-created worktree only.
- Temp files in the worker's own scratchpad subdirectory; checkpoint green units on its own branch.
  In a shared managed checkout, return the patch to the orchestrator for serial commits instead.
- Name the offload directory; commands >~2 min run detached; verify landed hashes by ancestor check.
- Exactly one private structured final; report blocked rather than message elsewhere.
- Orchestrator never hand-patches bugs: dispatch a fixer with an oracle, gate finish on it.

## References Index

Read `references/<name>.md` only when the scenario applies: `heavy-processes` (limits, memory watch) ·
`quota-and-cadence` · `dispatch-decision` (modes, Codex limit recovery, spawned windows) ·
`coordinated-worker-protocol` · `task-packet` · `model-selection` · `worker-prompt` · `context-offloading`
· `ownership-and-recovery` · `worker-selfcheck` · `orchestrator-duties`.
