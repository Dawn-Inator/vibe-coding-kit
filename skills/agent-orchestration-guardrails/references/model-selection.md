# Worker Model Selection

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Tier map

This table is the single place outside the SKILL.md digest that maps tiers to model names. Other references
name the tier. The Claude role definitions in `templates/claude-agents/` pin these models, and a kit test
fails when a role's model drifts from this table. When a model generation changes, update this table, the
digest and the role definitions together, then revisit the rules in [rule assumptions](rule-assumptions.md).

| Tier | Claude | Codex | Used for |
| --- | --- | --- | --- |
| Read-only | Haiku | Luna | Exploration, search, inventory and classification with `write_scope: none` |
| Write | Sonnet | Terra | Every write-capable bounded task, including wiring, mechanical edits and high-risk work whose design or root cause is settled |
| Review | Sonnet | Terra | Independent pre-review and review/falsification ([review verdicts](review-verdict.md)): fresh, isolated context, and never the implementation owner |
| Planning | Opus (sub-planner role only) | Sol (planner only) | Decomposition, planning, acceptance decisions and judgment forks (unknown root cause, security-boundary design); returns judgment and plans, never repository writes |

Only the `sub-planner` role may run on Opus (Sol on Codex). Every executor (module-owner, wiring and
implementation workers), reviewer and verifier runs on Sonnet (Terra); explorers run on Haiku (Luna).

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
exploration; Sonnet for every write-capable bounded task and for every independent reviewer or verifier;
Opus only for the `sub-planner` role.

**Default every write-capable task to Sonnet — explicitly including firmware, binary-format writers,
cross-service contracts, migrations, and anything you'd label "high-risk" — as long as the design is
already fixed or the root cause is already known.** "Mistakes here are expensive to get wrong" is
explicitly **not** a valid reason to escalate the implementer to Opus: independent Sonnet review (Review
Fan-Out above) and orchestrator central verification exist to catch that risk.

Opus is reserved for the sub-planner, in these cases:

- (a) **Decomposition, planning and acceptance decisions** for a domain subtree.
- (b) **Root-cause investigation** where the cause is genuinely unknown: the sub-planner returns the
  diagnosis and decision, and a Sonnet worker implements the fix.
- (c) **Security-boundary design decisions**: the sub-planner returns the decision, and a Sonnet worker
  implements it.

Review and falsification (money/billing, security boundary, never-executed SQL, real-device/real-browser-only
behavior) are done by Sonnet reviewers in fresh, isolated context who are not the implementation owner;
a judgment fork they surface returns to the sub-planner. The dispatch guard rule `opus-sub-planner-only`
blocks any Opus dispatch whose `subagent_type` is not `sub-planner`.

If a task packet mixes a judgment decision with ordinary implementation or scripting, split it: a small
sub-planner (Opus) decision package plus a separate Sonnet implementation package.

**Required pre-dispatch self-check for every Opus dispatch**: write one line before dispatching —
`opus because sub-planner: <one-line reason>`. If the worker is not the sub-planner role, use Sonnet (or
Haiku for read-only). See your project's tutorial for the incident that motivated this line.

### Codex

For `collaboration.spawn_agent`, pass explicit `model`, `reasoning_effort`, and `fork_turns: "none"`
when overriding model/effort; `fork_turns: "all"` inherits both and rejects overrides. On other adapters,
use only their schema-exposed fields.

Pass an explicit model, effort, and fork/context-carry setting together — never mix an override with an
"inherit everything" fork mode, since a full-history fork inherits the parent's own model/effort and
rejects a partial override. Luna handles read-only exploration with `write_scope: none`; Terra executes
bounded code, docs, tests and configuration changes, like Sonnet. Sol is for planners only (architecture and
semantic decisions, returned as judgment). Review uses Terra with isolated context, and its pre-review must
be independent of the implementation owner.

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

## Cloud / remote sessions

Creating a cloud or remote session (for example Claude Code Remote `create_session`) is a dispatch and
follows the same rules. An omitted model inherits the coordinator's tier: one orchestration that left it
unset started 27 sessions on Opus and exhausted the 5-hour quota in 30 minutes.

- Pass `model` explicitly on every session create; never inherit the coordinator's tier.
- Sessions default to Sonnet. Only a session acting as a sub-planner may use Opus, with at most 2 such
  sessions at once.
- In a consuming project's `.claude/settings.json`, the dispatch guard matcher should be `Agent|Task|mcp__claude-code-remote__create_session`; it then denies a create without `model`, and Opus without a `sub-planner` tag.
- At most 10 sessions run concurrently by default; a project may lower this in its always-loaded file.
- Inside each session, at most 4 workers run concurrently, and each worker sets its model explicitly.
- The task packet for a child session states the model its own sub-agent dispatches must use and the
  concurrency caps above.
- Quota protection: on a 5-hour or weekly quota warning, pause new fan-out and close out the work already
  open before starting more.
