---
name: agent-orchestration-guardrails
description: Use before subagent dispatch or heavy commands to assign module delivery owners, verification lanes, independent acceptance, worker models, and host limits.
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

Ordinary tasks: the main agent may investigate, edit, and test directly. Delegate independent units only
when authorized and parallelism offers measurable wall-clock benefit; task size alone does not require it.
Give every in-flight writer exclusive ownership of its write scope.

For authorized parallel implementation, assign **module delivery owners**, not just exploration, editing,
or test-running steps. Each owner carries a bounded, independently acceptable function through requirements,
implementation, tests, fixes and resubmission. This applies from the first dispatch, not after two hours.
Explorers and reviewers support delivery; their reports do not replace an implementation owner.
Read [module delivery](references/module-delivery.md) before decomposing or dispatching implementation.
At intake, before each wave and when queues change, read [capacity balance](references/capacity-balance.md).
Adjust cross-module wiring, execution and acceptance effort from observed bottlenecks, not fixed agent counts;
preserve module ownership, independent review and all host/authorization limits.

**Threshold B:** when a single-agent autonomous session has run or is expected to run over two hours
(including overnight or unattended work), or has compacted its context at least once while implementation
work remains, the orchestrator switches to dispatch-only: delegate each
implementation write unit to a worker; retain decomposition, dispatch, integration, verification, and
acceptance. Orchestration artifacts and owned merge conflict resolution remain with the orchestrator.
Respect higher-priority delegation restrictions; if dispatch is unavailable, report the blocker instead
of silently self-implementing. This mode does not depend on heartbeat tooling being available or enabled.

### Dispatch Red Lines

- Every dispatch sets `model` explicitly (plus effort/context-carry on Codex), at **every** level of the
  chain; a worker that fans out lists each sub-agent and its model.
- Workers run only the checks authorized in their packet. Module tests, typechecks, builds or scoped
  integration/E2E need an exact command, prepared environment and a granted per-host resource slot when
  heavy; without a slot, queue a checkpoint. No unassigned full suites, installs, host-sync, shared-resource
  cleanup, another worktree's dependency symlinks, or whole-env/secret dumps. See
  [verification lanes](references/worker-selfcheck.md); never bypass an existing project guard.
- Workers never write into the human primary checkout; facts come from origin refs or their managed worktree.
- Default to one worker layer. A top orchestrator may explicitly authorize one nested worker layer for a bounded submodule when the runtime supports it and parallelism benefits the task. No deeper nesting or independent windows; see task-packet.
- On finish a worker stops every background shell/loop/watcher it started and attaches `ps` proof; a
  report without it is invalid.
- Quota is hard: ≥95% stop new dispatch, ≥97% stop all, merge, hand off. Prioritize extra review for money,
  security boundaries, never-run SQL and real-device behavior; every module still needs full criteria-based acceptance.

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

Loop: parallel module implementation → owner tests/fixes in authorized lanes → orchestrator independently
accepts each candidate → integrates and runs selected shared checks → returns failures to the same owners.
One private final per invocation can be a resumable checkpoint; it does not end module ownership.

## Coordinated Worker Protocol (frontier orchestrator + delegated workers)

Whichever platform and model you use as the top-level orchestrator, keep goal interpretation, dependency
ordering, conflict resolution, architecture forks, integration, and final semantic acceptance **in the
orchestrator**. When delegating, assign bounded execution to a write-tier worker (see Worker Model
Selection). Owners decide local implementation within approved contracts;
return cross-module architectural or authority changes to the top orchestrator.

After an implementation candidate is committed, and before final acceptance of a non-trivial integrated
multi-agent candidate, dispatch an **independent pre-review worker** (model per Worker Model Selection).
Give it `write_scope: none`, bind it to the exact candidate commit, name its oracle and negative
checks, and keep it separate from every implementation owner. It must not
edit, commit, merge, finish, push, deploy, invoke release/gate authority, or spawn another agent — it
returns a commit-bound [review verdict](references/review-verdict.md); the orchestrator combines that with
the approved goal and centralized validation for the final call. A changed candidate commit makes the
pre-review stale; redo it. Skip only for a bounded single-worker candidate with an exact oracle, and
record why.

The orchestrator reads verdicts, not raw diffs, except for risk classes and the other cases the verdict
page lists. Judgment-tier workers return judgment only, never repository writes.
Read [coordinated-worker-protocol](references/coordinated-worker-protocol.md) for the platform review
seats and acceptance split when they apply.

Before the first broad wave, dispatch one representative low-risk task as a health check: confirm one
private structured final, respected write scope and verification grants, usable evidence.
Nested delegation requires explicit top-level authorization and is limited to two worker layers; reviewers never delegate.

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
  Luna is for read-only exploration; Terra is the default executor for bounded write tasks, like Sonnet.
  Sol is for architecture/semantic decisions or independent review. An independent Terra pre-review
  must have a different implementation owner and isolated context; risk increases verification strength.
- Difficulty picks the tier; risk picks verification strength; "high-impact" alone never justifies a
  frontier tier. Mirror this floor into the always-loaded project file.

## Worker Prompt Requirements (checklist)

- Explorer: `write_scope: none`, no edits/commits/finish/publish/git writes.
- Module owner: implement/test/fix/resubmit until accepted or specifically blocked; do not stop at code written.
- Exact checks and resource grants only; missing deps are reported, not installed; pre-created worktree only.
- Temp files in the worker's own scratchpad subdirectory; checkpoint green units on its own branch.
  In a shared managed checkout, return the patch to the orchestrator for serial commits instead.
- Name the offload directory; commands >~2 min run detached; verify landed hashes by ancestor check.
- Exactly one private structured final; report blocked rather than message elsewhere.
- Return delegated-module failures to their owner; explicitly transfer ownership if necessary. In ordinary
  undelegated tasks the main agent may fix directly; threshold B remains dispatch-only. Gate finish on results.

## References Index

Read `references/<name>.md` only when the scenario applies: `heavy-processes` (limits, memory watch) ·
`quota-and-cadence` · `dispatch-decision` (modes, Codex limit recovery, spawned windows) ·
`coordinated-worker-protocol` · `task-packet` · `model-selection` · `worker-prompt` · `context-offloading`
· `ownership-and-recovery` · `worker-selfcheck` · `orchestrator-duties` · `module-delivery` ·
`review-verdict` (what reaches the orchestrator) · `rule-assumptions` (why each red line exists, when to
revisit it after a model generation change).
