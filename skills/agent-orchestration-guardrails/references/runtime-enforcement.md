# Runtime Enforcement: Roles, Dispatch Guard, Handoff Contracts

Read when setting up a project for delegated work, when dispatching on Claude Code, or when a dispatch is
denied by the dispatch guard. Rules that live only in prose depend on the orchestrator restating them in
every packet and on each worker reading them; the mechanisms here carry the fixed parts instead, so a
packet states only task-specific values.

## Claude role definitions

The kit ships Claude Code role definitions in `templates/claude-agents/`. The project's `skills sync`
writes them to `.claude/agents/` with a generated marker, and `skills check` reports drift. They follow
the orchestration skill: excluding `agent-orchestration-guardrails` in `project.config.json` removes them.
A project file without the marker is never overwritten, even when it shares a kit role's name; it is reported as a
conflict. Under the `local` mirror policy the generated files are git-ignored like the skill mirrors.

| Role | Tier | Tools | What the allowlist guarantees |
| --- | --- | --- | --- |
| `explorer` | Read-only | Read, Grep, Glob | Cannot edit, run shell commands or dispatch |
| `module-owner` | Write | Read, Grep, Glob, Edit, Write, Bash | Cannot dispatch, so it cannot add an agent layer |
| `reviewer` | Judgment | Read, Grep, Glob | Cannot edit, run shell commands or dispatch; read-only by construction |
| `sub-planner` | Judgment | Read, Grep, Glob | Plans and decides only; never writes code or dispatches |

Each role pins its model from the [tier map](model-selection.md#tier-map), and its body carries the fixed
worker rules from [worker prompt](worker-prompt.md). Dispatch with `subagent_type` set to the role and a
packet that follows the [task packet](task-packet.md) contract; do not restate the role's fixed rules.

The read-only roles have no shell. Before dispatching a reviewer, the orchestrator exports what it must
read (the candidate diff against its base, relevant logs) into the reviewer's offload directory and names
those files in the packet. If a host has no Grep or Glob tool, a project can add Bash to its own copy of a
read-only role under a different name; that copy is read-only by instruction, not by construction.

## Dispatch guard

`src/orchestration/dispatch-guard-hook.mjs` is a Claude Code PreToolUse hook on `Agent|Task`, wired by
`templates/claude-settings-snippet.json`. Merge that snippet into the project's `.claude/settings.json`
with the other kit guards.

| Rule | Denies |
| --- | --- |
| `explicit-model` | A dispatch with no `model`, unless its `subagent_type` names a role definition in the project's or the user's `.claude/agents/` that pins a model other than `inherit` |
| `fork-dispatch` | A `fork` dispatch, which always runs on the caller's model with its full context and so can neither set a worker model nor serve as an isolated reviewer |

Configure it under `dispatchGuard` in the project's worktree configuration: `disabledRules` switches a rule
off, and `hints` appends project text (for example the project's own tier map) to a deny message. The guard
fails open on unreadable input or configuration. It does not see Codex dispatches or agents started inside
workflow scripts; for those, setting the model explicitly remains a written rule.

## Handoff contracts

`schemas/task-packet.schema.json`, `schemas/worker-handoff.schema.json` and
`schemas/review-verdict.schema.json` document the three structured documents that cross the
orchestrator/worker boundary. `src/orchestration/handoff-contract.mjs` validates them without third-party
dependencies:

```
node .vibe-coding/kit/src/orchestration/handoff-contract.mjs <packet|handoff|verdict> <file.json>
```

It prints `valid` or one problem per line and exits non-zero when invalid. Treat an invalid handoff as
`blocked` and an invalid verdict as no review. The validator also enforces the role rules: read-only roles
have `writeScope: "none"`, a module owner names an absolute worktree, a heavy check names its granted slot,
a module-owner handoff carries `ps` proof, a handoff never claims acceptance, and a verdict's reviewer
context is isolated. Its `intakeDecision` export applies the [review verdict](review-verdict.md) intake
rules and reports whether the orchestrator must open the diff and whether material must reach it verbatim.
