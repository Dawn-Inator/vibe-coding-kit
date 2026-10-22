---
name: test-gate-router
description: Use when choosing which verification commands/tests to run for a change, and whether the chosen command should run on your local machine or be routed somewhere else (a remote runner, a bigger box, a CI-hosted lane). Covers selector-first validation — decide *what* to test from the changed surface before deciding *where* to run it. If your project has a dedicated bugfix-regression skill/process, use it first for bug fixes: choosing a test command never permits skipping required regression coverage.
---

# Test Gate Router

This skill is a template. The two decisions it describes — what to test, and where to run it — are universal, but the actual commands, cost tiers, and hosts are project-specific and you must fill them in for your own repo (see the "fill in for your project" sections below). If your project has canonical docs describing its own test/gate contract, read those first and treat this file as the decision framework layered on top of them.

## The two decisions, and why they're kept separate

Every verification step really answers two independent questions:

1. **Scope** — *what* should run, given the files that changed?
2. **Host** — *where* should the chosen command actually execute (this machine right now, vs. a remote or bigger runner)?

Keep these separate, and optimize each independently. A change that picks the right scope but runs it on the wrong host (e.g. a heavy suite hogging a laptop that's also running a dev server) and a change that picks the right host but the wrong scope (e.g. running a full suite remotely when a focused test would have caught the same bug for a fraction of the cost) are two different failure modes. Bundling both decisions into one step means a fix to one silently breaks the other. A bigger or faster runner being available never justifies expanding scope; scope being expensive never justifies silently narrowing it below what it calls for by pretending the host decision is a scope decision.

## Choose scope before host

1. For a bug fix, first use your project's bugfix-regression skill or process, if it has one. Bug fixes typically need two layers of coverage: a regression test for the exact reported case, and a broader test that would catch the same class of bug elsewhere in the codebase. Choosing *which* command to run never permits skipping either layer.
2. Inspect the changed surface and run your project's test selector, if you have one — a tool or lookup table that maps a set of changed files to the minimal sufficient set of tests. This can be as simple as a path-prefix-to-test-directory mapping, or as elaborate as a dependency-graph walk; either is fine as long as it is deterministic and driven by the changed surface rather than "run everything to be safe."
3. Once scope is decided, decide the host. A simple rule works for most projects (e.g. "commands under N minutes with no special hardware requirement run locally; anything heavier, or anything that would compete with other local work in flight, is a candidate for a remote/other-host runner"). Scope answers **what** runs; command weight and current local headroom answer **where** it runs. A faster or larger runner never expands scope.
4. Run product-level checks (integration tests, end-to-end flows, contract tests) only when their product surface actually changed. A docs-only, skill-only, or governance-only change should use whatever light checks apply to that layer, not a full product test suite.

## Routine defaults — fill in for your project

The bullets below are the *shape* of a defaults table, not its content. Replace them with your own project's mapping from change type to required checks:

- Backend-only business/service/model change → run the selector's focused unit/contract coverage for that layer. Add focused tests whenever business logic, persistence, authorization, or an API contract changes.
- Visible frontend change → run the focused UI/E2E flow for the changed surface and save evidence (e.g. screenshots) under a consistent, clearly named location.
- Frontend/backend integration change → run the focused end-to-end flow; only add backend tests too when the change includes backend business logic, persistence, authorization, or contract behavior — a UI-wiring-only change doesn't automatically earn duplicate backend tests.
- API/schema/type-contract changes → regenerate any generated artifacts (API specs, generated client types, etc.) and run the relevant static-contract checks.
- Database/migration changes → follow your project's migration process and its associated checks; do not treat hand-run raw SQL as an ordinary test path.
- Tooling/automation/script changes → run the selector-owned focused checks for the affected script(s). Escalate to a broader/full check only for an unowned or cross-cutting surface, an explicit request for full validation, or when your own gate rules require it.

To make this real, your project needs to define, concretely:

1. **A selector** that maps changed files to the tests that must run. Start with a simple table (path prefix → test target) and grow it as the codebase does.
2. **Cost-tiered command sets** — at minimum: a cheap set that runs by default, a medium-cost set gated on some trigger (e.g. "only if this subsystem changed"), and an expensive set (full suite, full end-to-end) that only runs on an explicit request for full validation, never by default.
3. **A local-vs-elsewhere rule**, if your project has more than one place tests can run — typically driven by how heavy the chosen command is and how much local headroom (CPU/memory, an already-running dev server) is currently available.

Once the selector exists, make it fail closed rather than quietly widen:

- Give each mapping a kind: **exact** (bound to specific inputs), **bounded-class** (a declared
  invariant or budget limits what it covers), or **aggregate** (a broad lane, allowed only with a
  reviewed waiver). A changed file with no mapping (a gap), a mapping that silently falls back to a
  whole directory or sibling package (coarse), or unreadable selector metadata is a failure to fix,
  never a reason to run "something nearby."
- Keep changes focused by default; app-wide coverage or a shared aggregate lane is an explicit,
  named choice, not an automatic fallback.
- When a check compares against a base, the tree under test is always the candidate tip you are
  about to ship; the base ref is only the baseline for diffs and receipts and must resolve to the
  branch you are landing on. Never test the base and call it the candidate.

Make your default, everyday commands selector-first (they consult the selector rather than always running the full suite), and reserve any "run everything" command for an explicit trigger — a developer literally asking for full/pre-release validation, or a rule in your own gate contract that requires it.

For routine day-to-day work, keep checks local, focused, and serial by default. A routine "deploy to a dev environment" or "commit this" action should not silently imply a full cloud gate, a full end-to-end suite, device automation, or waking up a remote pool of test machines.

## Report evidence

For visible frontend changes, save evidence (screenshots, recordings) with clear, descriptive names in a location your project agrees on. **If a UI test tool actually ran, the final report must embed the resulting evidence, not merely describe it or list file paths.** If evidence was not generated or cannot be displayed, say so explicitly as a gap — do not imply it exists.

Evidence like screenshots is supplementary, never a replacement for the actual assertions (unit/contract/integration tests) required when APIs, databases, permissions, queues, or state machines changed.

## Host boundary — fill in for your project

Keep light checks local by default. If your project has more than one place tests can run (a remote runner, a bigger machine, a CI-hosted lane), define your own rule for when a check nominates itself for that path, and require explicit approval before waking up any shared or costly remote pool — that approval requirement should not be silently bypassed just because the work is "objectively heavy."

Whatever mechanism carries a test command to a different host should change only *where* the command runs, never *what* it runs. Trust its exit code as authoritative, and treat a lost connection or a missing result as unknown, never as a pass. Do not silently fall back to running the same (expensive) thing locally just because the remote path was unavailable — surface that as a blocker instead.

## Always add these when applicable — fill in for your project

If your project has lightweight, fast, structural checks that should run whenever certain kinds of files change — for example, syncing generated skill/doc indexes, or checking for stray whitespace before a commit — list them here as an explicit checklist so they aren't forgotten. Example shape:

```bash
your-skill-sync-check      # run when a skill/agent-instruction source file changed
your-docs-index-check      # run when docs, skills, or their generated indexes changed
git diff --check           # catch whitespace errors before committing
```

Keep pure knowledge edits to relevant sync, structure, reference, command-validity and diff checks. Do not add wording assertions or selector mappings merely for prose edits; classify command/permission/release changes by their behavior. Once relevant checks pass with no unresolved risk, repeat or expand only when effective inputs change, a check fails or a concrete new concern arises. Exact-SHA release evidence keeps its own binding requirements.

Do not substitute a broad gate for the changed-surface selector described above. Serialize test runs only for real shared-resource, dependency or release-state contention.

## Don't poll a CI system in a loop

Do not loop `sleep` plus a status-check command waiting for a CI/CD workflow to finish — this is a common way to burn an entire command-timeout budget on nothing. If a CI result is genuinely needed before the next step, use a single blocking call that waits for the run to finish (most CI tools provide one, e.g. `gh run watch --exit-status <run-id>` for GitHub Actions) instead of a manual poll loop. Otherwise, don't wait at all: record the expected outcome in your commit message or task notes and let the result land asynchronously — check it the next time you naturally revisit the branch or PR.
