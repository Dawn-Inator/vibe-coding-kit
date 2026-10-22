# Dispatch Required, Orchestration Modes, Spawned Windows

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

### When Dispatch Is Required, Not Optional

The Core Rule above lists what does *not* by itself justify fan-out. The converse also holds, and is not
discretionary: dispatch is **required** when all four hold —

1. the unit is expected to take more than ~15 minutes;
2. the root cause or next action is already identified — the unit is execution, not open investigation;
3. it can be written as a self-contained task packet without the orchestrator staying in the loop; and
4. its write scope does not overlap any other in-flight worker's.

When all four hold and the orchestrator does the work itself anyway, that is a **guardrail violation**, not
a judgment call — name it as such rather than as a style preference. This is the mirror image of "task size
alone is not a reason to delegate": that line stops an orchestrator from over-dispatching busywork, this one
stops it from quietly absorbing real, independently-dispatchable work into its own turns instead of fanning
it out — see your project's tutorial for the incident this responds to.

## Orchestration Mode Selection

Pick by **where results land**, not by task size. Do not assume a mechanism from one platform exists on
another.

### Claude Code

- **A dynamic multi-step workflow mechanism, where exposed** — results return to the orchestrator for
  synthesis and centralized verification. Use for large review/research/design or implementation fan-out.
- **Per-turn Task/Agent dispatch** — results return into the current session context. Use for roughly
  3-15 mid-size subtasks. **Out-of-scope drive-by findings (stale docs, dead code, missing coverage) belong
  here too**: run them in the background where exposed rather than opening a separate unsupervised task for
  them. Ask the developer first only when the finding touches legal/compliance text, a decision that is
  explicitly outside the agent's authority, or an irreversible action.
- **An independent/spawned task window, where exposed** — a separate session whose results do NOT return
  automatically to the current context. Reserve it for high-risk refactors that need human supervision —
  not as a generic way to offload minor findings, since nobody is watching it synthesize or verify its own
  output.

If your platform's own generic guidance nudges toward defaulting to that independent/spawned mechanism for
any out-of-scope finding, override it: for a finding a worker can fix on its own, route it back through the
orchestrator's normal dispatch instead of a fire-and-forget unsupervised window.

**No unsupervised spawn for out-of-scope findings.** A worker (including a nested subagent) that notices an
out-of-scope bug or debt item reports it in its own final handoff — the problem, a `file:line` pointer, a
one-line fix — and lets the orchestrator decide whether to dispatch a fixer or queue it. A worker must not
spawn its own unsupervised task window or open a tracking item on its own initiative; if a normal
write-capable worker could fix it, report it — only a genuinely high-risk refactor needing real-time human
supervision is worth an unsupervised window, and that call belongs to the orchestrator alone.

### Codex

- Use the platform's private-result agent dispatch primitive. On `collaboration.spawn_agent`, cwd is
  shared: explicitly assign disjoint writable files or pre-created managed worktrees; spawning alone
  does not isolate the filesystem. Do **not** put a parent thread/session identifier or a "send message to thread"
  instruction in a worker's task packet.
- A Codex-style worker returns **exactly one** final structured handoff privately to its orchestrator by
  completing its assigned task. It must never send a message to any other task or a shared UI/thread.
  Lifecycle signals (activity/liveness pings, wait-for-completion primitives) only establish that the
  worker is alive; the worker's private final is the only accepted result channel. A missing final
  delivery, any intermediate cross-task update, or any visible task message should be treated as blocked —
  never fall back to a user-visible handoff to route around it.
- Give each agent a disjoint responsibility area; collect its private final handoff, then synthesize and
  centrally verify from the orchestrator. When work exceeds current concurrency, dispatch in waves and wait
  only for lifecycle completion before assigning the next wave — never treat a lifecycle/liveness signal
  itself as a result.

<!-- BEGIN: agent-only -->
#### Optional example: recovering from a Codex harness concurrency limit

If a project's authorized parallel dispatch is blocked by `agent thread limit reached` or an explicitly
reported harness concurrency cap, first check the current Codex documentation and the user's local
configuration policy. Where the user authorizes changing that setting and the current host supports it,
the relevant configuration may look like:

```toml
[agents]
max_concurrent_threads_per_session = 99
```

Update an existing `[agents]` table rather than adding a duplicate; preserve unrelated settings and
remove a conflicting legacy `agents.max_threads` alias only if current documentation confirms that
behavior. This local setting is distinct from the API request field `max_concurrent_subagents`.

Verify the saved value and effective harness slots before retrying the blocked dispatch. An existing
session may retain its old limit: use a supported reload when available, otherwise report that a new
session or app restart is needed; do not claim success from a file edit alone or repeatedly retry an
unchanged cap. Resume only the authorized, useful parallel work; 99 is capacity, not a target agent count.
Quota rules and per-host heavy-process limits still apply.
<!-- END: agent-only -->

Implementation fan-out follows the canonical loop: **parallel write (workers only read/grep/edit, disjoint
responsibility areas, zero heavy processes) → orchestrator merges and runs the full verification ONCE,
ideally on a dedicated test host → feed each worker back its own failures to fix**, iterate to green.
Verification belongs in the orchestrator, not in every worker. Parallel responsibility areas must touch
disjoint files; overlapping work is serialized or merged into one worker. Remote execution also does not
widen what gets run — scope should stay driven by whatever change-selection convention your test tooling
uses, not a default full-suite run.

## Independent/Spawned Windows Do Not Inherit Context

Applies only where an independent/spawned task-window mechanism is exposed and results do not
automatically return to the orchestrator. If your platform has no such mechanism, use result-returning
waves of the isolated-agent-spawn primitive instead.

An independent/spawned window is effectively its own session — it inherits only what the caller
hand-writes into its prompt. Project hard rules (heavy-process limits, environment boundaries, secret
redaction, worktree finish conventions) and standing decisions do NOT propagate automatically, and a single
level of spawning already loses them. **Blindness costs more than noise** — a spawned window can attempt
something the project already decided against, simply because it was never told, laundering a forbidden
action through a session that genuinely doesn't know better.

- A managed/spawned window must not spawn further independent windows — parallelize inside it via a
  workflow mechanism or per-turn dispatch instead. The right to fork a fan-out stays with the top
  orchestrator.
- If a window truly must spawn one more level, its prompt must carry an explicit guardrail header: the
  heavy-process limit, the ban on self-running heavy processes (local or remote), environment boundaries,
  secrets always redacted, the finish/merge convention, and "do not re-spawn."
- Periodically check for "blind" windows and inject missing guardrail context by message rather than
  killing outright, unless the host is at a resource-exhaustion edge.
