---
name: bugfix-regression-tests
description: Use proactively when fixing a bug, a tracked "needs fix" item from an external bug tracker, or any repair that must not recur. Triggers include fix a bug, add automated test, add regression test, write back a bug-tracker status change, and any repair claimed as closed. Do not treat device smoke, manual click-through, or screenshots as a substitute for automated tests.
---

# Bugfix regression tests

This skill is the AI trigger for automated anti-regression on every bugfix. Keep the exact decision table
and any project-specific skip rules in your own testing-workflow Doc (a reasonable name is
`doc/testing-workflow.md`, §Bugfix anti-regression closure) — do not copy that table into this Skill file;
this Skill only owns the rule and the checklist below.

## Why this is a hard rule, not a suggestion

A bug that has been fixed and *looks* fixed is not the same claim as a bug that has automated regression
coverage. Real-device smoke testing, a manual click-through, a screenshot, or a green deployment check all
answer the same narrow question: "does this look correct right now, on this one device, in this one
session?" None of them answer the question that actually matters for closing a bug: "will the next unrelated
change silently reintroduce this?" Only an automated check that fails on the old broken behavior and passes
on the fixed behavior — and that stays in the suite after this session ends — can answer that. Treat manual
verification as a nice-to-have piece of extra evidence for a fix, never as a replacement for the automated
layer below. This holds regardless of how confident the manual verification looked, how small the fix was,
or whether the person who found the bug only asked for a fix and did not explicitly ask for tests: they
asked for the bug fixed, and "fixed" implicitly means "and it won't just come back."

## Required reads

1. This skill first.
2. Your project's testing-workflow Doc, §Bugfix anti-regression closure (or equivalent), including
   whatever standing decision your project has recorded about "bugfix must ship with automated tests" —
   if your project has not written that decision down yet, this Skill's rule below is the decision until
   you do.
3. Your project's pre-implementation checklist/preflight convention (if you have one) for wherever it
   tracks "test script / spec" as a required field — an empty second layer (see Checklist below) should
   block that field, not pass it silently.
4. If the intake is an exact row from an external bug-tracking document (a wiki page, a spreadsheet, a
   project-management board), also read whatever project-specific workflow skill/doc governs safe
   read/write access to that tracker, if you have one — this starter kit ships one worked example,
   [`feishu-bugfix-workflow`](../feishu-bugfix-workflow/SKILL.md), for a Feishu Wiki/Base-sourced intake.

Related entry points that must not skip this skill: any test-routing convention you use to decide "what
should I test and where" (a "which tests to run" skill/doc), any plan-authoring convention, and any other
agent-configuration file that describes a parallel-dev workflow. If your project has several of these
entry-point docs, make sure this rule is written into all of them — a rule that lives in only one
entry-point doc is a rule that some sessions will simply never see, because they open a different
entry point first, and this is exactly the kind of gap that later needs to be re-discovered the hard way.
Consider adding a machine-checkable consistency check (a script that greps every "how do I decide what to
test" doc/skill for a reference to this skill's name, and fails if one is missing) rather than relying on
memory to keep every entry point in sync by hand.

## Checklist

Before claiming a bugfix is closed, name exact files for both layers:

1. **Local regression (本处回归)** — a unit test, integration test, contract check, or governance/lint
   check that fails on the escaped path before the fix and passes after.
2. **Class-level guard (同类防线)** — answer "if the same mistake lands in another file or call site, do
   current tests catch it?" If no, add a class-level pin (structural assert, audit table, lint rule,
   contract test) or record why this class of mistake cannot recur elsewhere.

   Layer 2 also protects the **test architecture itself**: a layer-1 test that touches real user or
   host state (the developer's home directory, global git config, a real network service), a guard
   test that is not selected when the data it guards changes, or a repo-wide shell/test footgun pinned
   only in one file, is itself an escape. Pin the class, not the instance.

If your project has a small-task exemption list for its pre-implementation checklist (a fixed set of
criteria that together mark a change as trivial enough to skip the full process), layer 2 may be satisfied
with **one local-regression spec + one sentence explaining why this class of mistake cannot recur
elsewhere**, without a full class-level gate — but only when every criterion on that exemption list is
actually met at once, and only as a scoping refinement, never as an exemption from answering layer 2 at
all. Writing "not needed" with no reason still fails and should block the same way an empty answer would.
Outside that narrow exemption, layer 2 follows the standard above: an unblockable recurrence needs a real
class-level gate.

Default to focused unit/integration tests or source-audit gates that run in seconds, not full end-to-end
browser automation across every supported device. Device smoke, screenshots, and a green deployment check
are extra evidence when the situation calls for them; they are not automated regression and do not count
toward either layer above.

Keep the automated-test step itself narrow and fast: run only the new or changed tests for this fix, not
a full suite, unless your project's test-routing convention says otherwise for this class of change.

## External bug-tracker writeback

If your project tracks bugs in an external system (a wiki page, spreadsheet, or project-management board)
and an AI session is expected to update status there, treat read and write very differently:

- **Reading** the tracker to find the next item to fix is safe and does not need special authorization.
- **Writing** back a status change (e.g. "needs fix" → "fixed, awaiting verification") should only happen
  once both regression layers above are satisfied, and only within whatever status-transition scope you
  have been explicitly authorized to use. Do not assume you have blanket permission to bulk-edit tracker
  rows just because you were asked to fix one bug from that tracker — restrict writes to the specific
  row(s) the fix addresses, and use the narrowest status transition that's actually true (do not mark
  something "verified"/"done" if only the automated layers, and not manual verification, are complete —
  say what actually happened).

## Stop

- Do not report the bug closed, fixed, or "tests not needed because nobody explicitly asked for them."
- Do not write back a "fixed" status to an external tracker if either regression layer is missing.
- If your pre-implementation checklist has a "test script / spec" field, mark it blocked when layer 2 is
  empty or answered with "not needed" and no reason.
- If automation is genuinely impossible for this specific case, record the evidence gathered, the residual
  risk, and a concrete follow-up to add coverage later — but still do not claim closed regression coverage.
