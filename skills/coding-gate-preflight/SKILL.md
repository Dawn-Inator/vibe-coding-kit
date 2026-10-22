---
name: coding-gate-preflight
description: Use before implementation to classify the actual Git scope and choose verification. Bugfixes require a local regression and class-level prevention.
---

# coding-gate-preflight: pre-coding gate check

## When to use this

Before any non-read-only implementation task (including before Plan Mode moves into execution): code, docs, tests, config, generated artifacts. Skip it for pure read-only analysis, status queries, log reading, or when the user explicitly skips the preflight. If the user scopes the writable area, the preflight covers only that scope.

This skill is not the test gate. The preflight lives in your plan, execution context, or final report — never a repo file, and there is no fixed-field card (retired; see [references/history.md](references/history.md)).

**Bugfixes: read your project's bugfix/regression-testing guidance first, if it exists.** Two layers are required: (a) a local regression that fails before the fix and passes after; (b) a same-class defense (structural assertion, lint rule, governance check, contract test), or a concrete reason the class cannot recur. Only (a) makes the work `blocked`. Report an assertion-polarity flip (`throws` removed, `not.` added/removed, expected boolean flipped, new `skip`/`only`) as its own line: what it guarded, what it guards now, why the flip is correct.

## Lite / full classification

The kit includes a conservative, full-only classifier at `.vibe-coding/kit/src/contracts/cli.mjs`. Run it directly with `node .vibe-coding/kit/src/contracts/cli.mjs [--base <base-ref> [--head <head-ref>]]`; without refs it reports staged, unstaged, and untracked files. Its JSON reports `head: null` and `headState: "unborn"` for a genuine unborn symbolic branch. Malformed or detached invalid `HEAD` fails closed. Explicit refs compare committed trees and do not include uncommitted changes. The tool emits JSON and does not estimate changed-line counts. `init` does not create a preflight package script or project preflight adapter. Treat the classifier output as information until the project wires it into a complete, validated preflight process. A project may claim a narrower tier such as `lite` only after supplying and validating its own complete project-aware classifier; a heuristic or the kit's full-only result cannot claim it. Missing classifier, incomplete evidence, invalid refs, or a result outside the project's declared tiers must not be treated as a pass.

At the start state: classifier result, scope and what you won't touch, risk status (`clear` / `needs-mitigation` / `blocked`, with source of truth and mitigation), target base and worktree command (see [`agent-worktree-lifecycle`](../agent-worktree-lifecycle/SKILL.md)), and verification commands. `lite` needs one line; `full` also walks the trigger conditions. Dispatching subagents: [`agent-orchestration-guardrails`](../agent-orchestration-guardrails/SKILL.md).

## Verification command tiers

Fill in your project's command names.

- **Tier 0, cheap, select by impact and run locally**: choose affected static checks, focused tests or knowledge-artifact checks according to the actual inputs; do not require all three for a local wording edit. Instruction changes affecting commands, permissions or release behavior still need the relevant contracts.
- **Tier 1, triggered**: full local check for the layer touched, static-contract check after an API change, pre-merge/"promote" check. Route local vs. remote by script weight (read the body) and local headroom; state it per command up front.
- **Tier 2, never by default**: full e2e, whole-repo tests, nightly/release gate, full browser acceptance. Only on request, in a release flow, or when assessed risk requires it.

Large-blast-radius triggers (more than one deployable service, schema migration, payment/webhook ownership, deploy readback) send already-selected commands to a remote/CI runner; if none is reachable, report a blocker instead of silently running locally. This changes where, never scope.

## Trigger conditions

- Business/service boundary (new capability, table/queue/worker/provider/admin module, projection, or multi-domain change): expand your boundary card; "same import/transaction today" is not proof of ownership.
- Provider/integration: a capability-neutral port/DTO, vendor code in an allowed directory, a fake/conformance test; business logic naming a vendor SDK is `blocked`.
- New persistent store: workload, capacity, retention, placement rationale.
- API contract: regenerate artifacts, run static-contract checks.
- Schema/migration: use your migration convention, never ad hoc SQL against a live environment.
- Deployment topology: sync mirrored docs/admin pages, run the drift check.
- Frontend/backend surface: pick the local gate; record test changes apart from the command list.
- Docs ownership: update docs; if unclear, run the docs-impact checker.
- Skill/config changes: run sync/regeneration and drift checks unless the user says not to; report an unsynced state.
- New quality gate: classify it (advisory vs. hard-blocking) before adding.

## Wrap-up

Compare the real diff with the plan (`git diff -- . ':!node_modules'`, `git status --short`). The final report covers, even with no impact (say why): docs impact; API contract; schema/migration; tests (bugfix: gap analysis plus both layers reported separately, and say so if one is missing); verification (commands run, local vs. remote, and any downgrade from the plan).
