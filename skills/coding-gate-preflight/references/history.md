# History

- 2026-10-21: retired the fixed "preflight card" and the "Lite card" (owner decision). Reason: in an A/B comparison, three agents that loaded this skill each read only the first third and none produced a card; the card was never persisted or checked. Original text of the removed sections follows.

## The preflight card

Don't write the card to a repo file by default — it lives in your plan, execution context, or final report only. Keep it to the fixed set of fields below; don't add more ad hoc sections when the full card applies. If your project defines additional "big cards" (business-boundary, data-architecture, API-contract, provider/integration, etc.), those only need to be expanded inline when their own trigger conditions are hit — a silent skip is fine when they aren't triggered; no need to write "not applicable" filler.

If the classifier returns `lite`, use the **Lite card** section instead and skip the rest of this list.

1. **Scope and maintainability/extensibility risk** — which files, modules, and user-visible behavior this change touches, and what it explicitly does not touch. Risk status must be one of `clear` / `needs-mitigation` / `blocked`, with the risk category, source of truth, and mitigation strategy stated. If this is a new or materially changed business capability, persistent store, worker, provider/integration, or admin module, or it crosses more than one business domain, expand your project's Business/Service Boundary card here (if you maintain one) — write out the owning context, the authoritative state and invariants, inputs/outputs, forbidden cross-domain reads/writes, and independent-failure behavior. Don't accept "we already import it" or "it's in the same transaction/session today" as proof two things belong in the same service — that's an argument from convenience, not ownership.
2. **Provider / integration / queue changes** (if applicable) — state the capability-neutral interface (port/DTO) your business logic depends on, where the vendor-specific implementation is allowed to live, whether there's a fake/conformance test, and why a single implementation doesn't yet need a runtime selector. If the plan lets business logic depend directly on a vendor name, SDK type, or raw wire payload, mark this `blocked`.
3. **Worktree / branch plan** — current branch or worktree, the target base branch (by your project's branching convention or explicit user instruction), the final merge/push target, and whether an isolated worktree is needed (see [`agent-worktree-lifecycle`](../../agent-worktree-lifecycle/SKILL.md) if this repo uses one). If the current branch doesn't match the target base, state the switch/sync path; if the target is unclear, mark this blocked.
4. **Subagent dispatch** — is this splittable across subagents? If so, how many, and what does each own? If not dispatching, state the specific reason (see [`agent-orchestration-guardrails`](../../agent-orchestration-guardrails/SKILL.md) if this repo has multi-agent conventions).
5. **Docs impact** — does this trigger updates to your docs tree, skill definitions, or any generated/mirrored artifact? If your project has deployment topology or infra-variable files that a docs page mirrors, check whether that mirror needs to stay in sync, and whether there's an automated drift check to run.
6. **API contract** — does this add or change a public endpoint, request/response shape, or status/error semantics? Does a generated API artifact (OpenAPI spec, generated client types, etc.) need to be regenerated?
7. **Schema / migration / data architecture** — does this touch a database schema, persistent table/view/queue/log/metric store, permissions policy, seed data, backfill, or a data-repair/production-apply step? If it introduces a new persistent store, this is where your project's Data Architecture card (if you maintain one) belongs — workload shape, capacity model, retention, and placement decision with a stated rationale.
8. **Test / spec plan** — what new or modified tests, specs, fixtures, or contract/governance checks does this need? For a bugfix specifically: write the gap analysis (why didn't an existing test or gate already catch this?), and cover **two layers**: (a) a local regression — a test that failed before the fix and passes after; (b) a same-class defense — could the same mistake recur in a different file, module, or call site, and would anything catch it? If the answer to (b) is no, either add a class-level guard (a structural assertion, a lint rule, an audit/governance check, a contract test) or explain concretely why this class of bug cannot recur elsewhere. **Filling in only the first layer, or leaving the second blank/dismissed without reasoning, makes this `blocked`.** Both layers are the default expectation — don't skip the second just because the user's request didn't mention testing.

   If your project reviews diffs for suspicious test changes, flag any assertion-polarity flip in this change set (an assertion that now checks the opposite of what it did — `throws` removed, `not.` added/removed, an expected boolean flipped, a test newly skipped/marked `only`) as its own explicit line: what it guarded before, what it guards now, and why the flip is correct. Don't let it get folded into a generic "updated tests" note.
9. **Verification plan** — which commands you'll run, in what order, and where each one will actually execute (locally vs. on a remote/CI runner), decided now rather than after something fails. See "Cost tiering for verification commands" below for how to organize this list. State this explicitly per command; don't defer the local-vs-remote decision to "if it's slow, I'll move it."

Risk-status definitions (used in item 1, and unchanged by the lite path):

- `clear` — scope, source of truth, and existing boundaries are clear; no added maintainability/extensibility risk.
- `needs-mitigation` — a risk is identified, but there's a concrete, verifiable mitigation this turn.
- `blocked` — any of: risk category, source of truth, or mitigation strategy is missing; the plan introduces an unexplained hardcoded value, duplicated state, a cross-layer bypass, or unreviewed public-interface expansion; a required "big card" (business boundary, data architecture, etc.) is missing a required field; an assertion-polarity flip exists without the explicit justification called for in item 8. Do not start writing code while the card is `blocked` — resolve it first by filling in the missing explanation or narrowing the design.

## Lite card (when the classifier returns `lite`)

When the classification is `lite`, the card shrinks to three items instead of the full list above:

1. **Scope and risk** (one line is enough): files/modules touched, plus a risk status — still one of `clear` / `needs-mitigation` / `blocked` (same definitions as above; the lite path doesn't relax them).
2. **Worktree target**: current branch, target base, and the command you'll use to create the working branch/worktree.
3. **Verification plan**: name the specific lightweight check commands you'll run (your project's fast lint/typecheck/test-select equivalents) — no need to walk through the full local-vs-remote routing logic below.

Any "big card" (business boundary, data architecture, API contract, provider/integration) that gets triggered anyway still must be expanded in full — don't try to cram it into the lite card's three lines; fall back to the full card instead.


## Original "Specialized entry points"

## Specialized entry points

If the preflight identifies one of these conditions, read the corresponding project-specific guidance first (if your project has it), then fold the conclusion back into the preflight card. These specialized guides are the source of truth for their area — this skill does not replace them:

- New business domain, worker, service, persistent projection, or cross-domain authoritative state — your project's business/service-boundary guidance, if any.
- New table, view, queue, audit/outbox/metric/log store, or a change to retention/placement — your project's data-architecture guidance, if any.
- Endpoint, DTO, status code, auth, or generated API artifact changes — your project's API-contract guidance, if any.
- Any schema migration, RLS/permissions change, seed, backfill, data repair, or destructive schema change — your project's migration guidance, if any.
- Bug fix / regression coverage / recurrence prevention — your project's bugfix-regression-testing guidance, if any.

This starter kit ships two closely related skills you can cross-reference directly:
- [`agent-worktree-lifecycle`](../../agent-worktree-lifecycle/SKILL.md) — for worktree creation, finishing, and cleanup.
- [`agent-orchestration-guardrails`](../../agent-orchestration-guardrails/SKILL.md) — for how to dispatch and coordinate multiple agents on a task.
