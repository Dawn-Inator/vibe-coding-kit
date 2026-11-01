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

## Project routing

Use the project's actual selector, test and host policy. For guidance on configuring one, read
[routing examples](references/routing-examples.md). Respect an explicit developer instruction not to
run tests; report missing verification instead of claiming it passed.

## Report evidence

For visible frontend changes, save evidence (screenshots, recordings) with clear, descriptive names in a location your project agrees on. **If a UI test tool actually ran, the final report must embed the resulting evidence, not merely describe it or list file paths.** If evidence was not generated or cannot be displayed, say so explicitly as a gap — do not imply it exists.

Evidence like screenshots is supplementary, never a replacement for the actual assertions (unit/contract/integration tests) required when APIs, databases, permissions, queues, or state machines changed.

## Host boundary — fill in for your project

Keep light checks local by default. If your project has more than one place tests can run (a remote runner, a bigger machine, a CI-hosted lane), define your own rule for when a check nominates itself for that path, and require explicit approval before waking up any shared or costly remote pool — that approval requirement should not be silently bypassed just because the work is "objectively heavy."

Whatever mechanism carries a test command to a different host should change only *where* the command runs, never *what* it runs. Trust its exit code as authoritative, and treat a lost connection or a missing result as unknown, never as a pass. Do not silently fall back to running the same (expensive) thing locally just because the remote path was unavailable — surface that as a blocker instead.

## Don't poll a CI system in a loop

Do not loop `sleep` plus a status-check command waiting for a CI/CD workflow to finish — this is a common way to burn an entire command-timeout budget on nothing. If a CI result is genuinely needed before the next step, use a single blocking call that waits for the run to finish (most CI tools provide one, e.g. `gh run watch --exit-status <run-id>` for GitHub Actions) instead of a manual poll loop. Otherwise, don't wait at all: record the expected outcome in your commit message or task notes and let the result land asynchronously — check it the next time you naturally revisit the branch or PR.
