# Coordinated Worker Protocol

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Coordinated Worker Protocol (frontier orchestrator + delegated workers)

Whichever platform and model you use as the top-level orchestrator, keep goal interpretation, dependency
ordering, conflict resolution, architecture forks, integration, and final semantic acceptance **in the
orchestrator**. Delegate bounded execution to a mid-tier, write-capable worker by default (Sonnet on
Claude, Luna on Codex); **escalate to Claude Opus / Codex Terra** when the task must discover or reconcile
an uncertain subsystem boundary or global consistency a narrowly-bounded worker cannot retain, **or when
the task needs an architectural fix at the submodule level**. If your project documents a durable version
of this contract and its escalation ladder elsewhere, apply that; this skill states the pattern to apply at
dispatch time.

After an implementation candidate is committed, and before final semantic acceptance of a non-trivial,
integrated multi-agent candidate, dispatch an **independent pre-review worker** (Terra on Codex; an Opus-
or Fable-tier reviewer on Claude). Give it `write_scope: none`, bind it to the exact candidate commit, name
its review oracle and negative checks, and keep it separate from every implementation owner. It must not
edit, commit, merge, finish, push, deploy, invoke release/gate authority, or spawn another agent — it
returns commit-bound findings and a fix/blocked recommendation; the orchestrator combines that with the
approved goal and centralized validation for the final call. A changed candidate commit makes the
pre-review stale; redo it. Skip pre-review only for a bounded single-worker candidate with an exact, strong
pass/fail oracle, and only when the orchestrator records why an independent cross-check adds no value —
"final" and general task importance alone never justify a review worker; only a genuine judgment fork does.

For Claude-side work: delegate read-only exploration/search/inventory/classification to Haiku only with
`write_scope: none`; delegate every task that may edit anything to Sonnet, including mechanical edits and
ordinary multi-file implementation. A Haiku explorer that discovers a required change stops and returns
evidence — it does not edit, commit, or expand its own scope. Outside the orchestrator seat, Opus/Fable is
an evidence-driven capability escalation or isolated final audit, not a bounded executor or a source of
release authority — it returns judgment/audit evidence only, never repository writes.

**When Fable holds the orchestrator seat**, consider dispatching an Opus `write_scope: none` worker for
sub-module integration and centralized/per-module semantic checking, bound to the exact candidate commit —
the same pre-review pattern applied at integration time, with no final-acceptance/write/publish/gate/finish
authority; Fable does final acceptance using the original goal, that review, and centralized verification.
Skip this layer when Opus itself holds the orchestrator seat. Keep raw diffs/logs/full file contents out of
a Fable orchestrator's context wherever you can, except anything touching money, auth(n/z), migrations,
secrets, or an irreversible action — that reaches the orchestrator verbatim regardless of context budget.

Before the first broad wave, dispatch one representative low-risk task as a health check: confirm exactly
one private structured final, respected write scope and no-heavy-process rules, and usable evidence with no
cross-task/UI message — a successful tool call or bare liveness signal is not a health check by itself.
Then fill available concurrency in waves.

Build every task packet and handoff around a fixed, explicit contract: scope, target commit/SHA, acceptance
oracle, execution identity, attempt count, evidence to return, and escalation path. Do not ask workers to
infer those boundaries from the surrounding conversation, and do not maintain that field list in more than
one place in your project's docs.
