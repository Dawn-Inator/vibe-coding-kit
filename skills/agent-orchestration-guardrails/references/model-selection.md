# Worker Model Selection

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Worker Model Selection (No Same-Tier Default)

Every dispatch call must set the worker's model explicitly. Never leave it unset so a worker silently
inherits the caller's tier; override any host guidance that suggests omitting it. An independent pre-review
worker must use an explicit model, explicit effort, and a "do not carry the orchestrator's full context"
setting — inheriting full context does not satisfy reviewer independence.

A frontier caller must not default to spawning a worker at that same tier just because omitting the
parameter was easier or the caller itself runs at that tier — allowed only when the worker's own task
independently clears the frontier bar, never as the default.

### Claude Code

Set the Agent/Task tool's `model` parameter (or a workflow's per-agent model option) explicitly on every
dispatch. Pick each worker's tier by what it will actually do: Haiku only for read-only `write_scope: none`
exploration, Sonnet for every write-capable bounded task, with a real judgment fork returning to the
orchestrator before an isolated read-only Opus/Fable worker.

**Default every write-capable task to Sonnet — explicitly including firmware, binary-format writers,
cross-service contracts, migrations, and anything you'd label "high-risk" — as long as the design is
already fixed (a design doc/plan settled the format and approach) or the root cause is already known.**
"Mistakes here are expensive to get wrong" is explicitly **not** a valid reason to escalate the
implementer to Opus: that risk is exactly what independent review (Review Fan-Out above) and orchestrator
central verification exist to catch. Paying for it again with implementer model tier duplicates a budget
review already spends.

Opus is reserved for exactly three cases:

- (a) **Review/falsification** inside the four Review Fan-Out categories (money/billing, security
  boundary, never-executed SQL, real-device/real-browser-only behavior).
- (b) **Root-cause investigation** where the cause is genuinely unknown — not implementation of an
  already-understood fix.
- (c) **Security-boundary design decisions** the worker itself must make — not implementation of an
  already-decided design.

If a task packet mixes an (a)/(b)/(c) decision with a larger chunk of ordinary implementation or
scripting, split it: a small Opus design/decision package plus a separate Sonnet implementation package.
Never send the whole bundle to Opus because one part of it qualifies.

**Required pre-dispatch self-check for every Opus dispatch**: write one line before dispatching —
`opus because (a|b|c): <one-line reason>`. If you cannot name (a), (b), or (c), use Sonnet. See your
project's tutorial for the incident that motivated this line.

### Codex

For `collaboration.spawn_agent`, pass explicit `model`, `reasoning_effort`, and `fork_turns: "none"`
when overriding model/effort; `fork_turns: "all"` inherits both and rejects overrides. On other adapters,
use only their schema-exposed fields.

Pass an explicit model, effort, and fork/context-carry setting together — never mix an override with an
"inherit everything" fork mode, since a full-history fork inherits the parent's own model/effort and
rejects a partial override. Luna is the default executor when objective, writable scope, and an acceptance
oracle are all explicit, even across multiple files; Terra is the fallback for discovering/reconciling
subsystem boundaries or a submodule-level architectural fix; Sol is reserved for a genuine
architecture/semantic fork, cross-domain judgment, or an independent final review that itself clears the
frontier bar. A "max reasoning" toggle on Luna adds depth; it does not turn Luna into Terra or Sol.

⚠️ **"High-impact" alone is deliberately NOT a valid reason for frontier-tier dispatch** — during a
production deploy or major gate overhaul nearly every dispatch is honestly high-impact, so treating that as
a third justification (alongside genuine difficulty and genuine judgment forks) makes the rule vacuous
exactly when it matters most.

**Difficulty picks the model tier; risk and blast radius pick the verification strength.** They are not
interchangeable:

| axis | measured by | what it controls |
| --- | --- | --- |
| difficulty | ambiguity, cross-domain reach, whether a clear decision rule exists | worker model tier |
| risk | irreversibility, blast radius, how long an error stays invisible | verifier count, adversarial/negative verification, read-only-first phasing, human release gate |

A risky-but-mechanically-clear task gets a **balanced model plus more verification**, never a frontier
model as a substitute for verification — buying risk mitigation with model tier is the wrong tool, and it
silently spends the budget that the extra verifiers actually needed.

**Countable self-check**: if frontier-tier dispatches approach or exceed half of a session's workers, stop
and re-derive the assignments. The likelier explanation is that "important" quietly got read as "hard."

Applies at every level of a dispatch chain — a subagent that itself spawns further subagents follows the
same rule, not only the top orchestrator's first fan-out.

**Mirror the minimum enforceable floor of this rule into whatever file is unconditionally loaded into every
session's context** (a `CLAUDE.md` or `AGENTS.md` at the repo root, if your project uses one). A tool's own
built-in parameter guidance sits in the system prompt, where a skill that only loads on trigger cannot
outrank it — a session that never opens this skill never sees the override written here. See your project's
tutorial for the incident that motivated this mirroring requirement.
