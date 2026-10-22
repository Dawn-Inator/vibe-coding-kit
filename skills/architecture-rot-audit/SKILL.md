---
name: architecture-rot-audit
description: Periodic whole-repository architecture-rot review — parallel multi-dimension evidence gathering, adversarial verification, per-dimension scoring, and a phased remediation plan. Use for "review the architecture," "how healthy is this codebase," "tech-debt inventory," "score the project," "remediation roadmap," a periodic health check, or any request to assess cleanliness, maintainability, production-readiness, or scalability across the whole repository. Do not use it for reviewing a single diff, reading one file, or live incident troubleshooting.
---

# Architecture Rot Audit

Machine-enforced gates (lint, CI, tests) cannot substitute for a cross-cutting, reviewable
architecture audit: a guard that is declared but never wired up, a service split that exists
only in source layout, a generated artifact that has drifted from its source of truth, a
structural capacity limit, or observability that cannot detect its own failure. This skill is
read-only assessment — it is not a code review, not incident response, not an implementation
task, and not a substitute for release verification. It may report a gap; it may never repair
one. A repair is a separate task with its own worktree, authority, and validation plan.

## 1. Freeze the audit intake (mandatory, before anything else)

Before reading the repository, dispatching any worker, or connecting to any environment, create
and freeze this round's intake. No field may be missing, and once frozen it does not get quietly
widened mid-audit:

```text
sourceRef:
sourceScope:
scoreBaseline:
moduleScope:
liveAllowlist:
liveDenylist:
liveMode:
secretOutput:
```

- **`sourceRef`** — the exact commit, branch, or working-tree state the audit is anchored to.
- **`sourceScope`** — `git-object-only` (inspect only files reachable from the resolved commit;
  never let generated, modified, ignored, or untracked files influence a finding — this is the
  default for a reproducible, ref-scoped audit) or `working-tree` (the live filesystem is
  evidence; separate committed evidence from local modifications/untracked files, and label a
  finding caused solely by local residue as working-tree-only unless it also reproduces from the
  declared object).
- **`scoreBaseline`** — what maturity stage the evidence is judged against. Default to a strict
  "can this safely carry production workload" baseline even for an early-stage project, unless
  the requester explicitly picks a different calibration — a small, deliberate development-stage
  shortcut is not automatically a defect just because it is smaller or less redundant than an
  enterprise pattern.
- **`moduleScope`** — the coverage manifest: every in-scope module/area marked `covered` (with
  cited evidence), `excluded` (with a requester-approved reason), or `evidence-gap` (cannot be
  inspected — absence of access is not a pass). Start from your project's actual top-level
  boundaries (e.g. mobile client / web client / admin surface / shared packages / backend
  services / CI-CD / any explicitly authorized live environment) and keep every row visible in
  the final report; a row may never silently disappear.
- **`liveAllowlist`** — exact environment, service, and read-only-operation triples that may be
  inspected live this round.
- **`liveDenylist`** — environments, resources, and operations that must never be touched.
- **`liveMode`** — `static-only` or `allowlisted-read-only`. Nothing else.
- **`secretOutput`** — must specify redacted-metadata-only output (path, variable/key name,
  material type, presence state, redacted error class); raw secret values, tokens, connection
  strings, or reversible encodings (base64/hex of the actual secret) are never acceptable output,
  regardless of this field's value.

### The denylist is an absolute boundary

`liveDenylist` cannot be bypassed by asking again, by a later confirmation, by an alias, an
indirect path, a proxy, copied/mirrored data, or the argument that a particular action is "just
read-only." Any resource not explicitly named on `liveAllowlist` defaults to `static-only`: no
network calls, cloud API calls, SSH sessions, database connections, or console operations against
it — full stop, independent of how confident anyone is that the action would be harmless. If the
live scope genuinely needs to change, stop and open a new audit with a newly frozen intake before
collecting any further evidence; never widen the current one in place.

## 2. Evidence and scoring

Label every finding, strength, score, and recommendation with one of three evidence states, and
never let a lower state masquerade as a higher one:

- **`confirmed`** — directly observed from the declared source object, from approved read-only
  live evidence, or from a command actually run during this audit.
- **`likely`** — a bounded inference from cited evidence, with the missing proof and the
  alternative explanation named.
- **`speculative`** — a hypothesis only; it can never change a score or a priority and belongs
  solely in the evidence-gap section of the report.

Static evidence establishes repository intent and wiring — not runtime execution, reachability,
throughput, permissions, or freshness. When no live read-only evidence is authorized, say
`static-only` plainly; never let a healthy-looking configuration read as a claim that the deployed
system is healthy. For any "this is unreferenced/unused" claim, record the search method and its
blind spots (dynamic imports, string-built paths, runtime registration, generated code, reflection)
— a missing text-search hit is not proof of absence.

Score each dimension on overall health, not on a raw defect count. A representative calibration
(adapt the wording, keep the shape):

| Score | Meaning |
| --- | --- |
| 9-10 | Mature production practice, durable and verified controls. |
| 7-8 | Production-usable; debt is bounded, understood, and controllable. |
| 5-6 | Operationally viable but structural risk is material. |
| 3-4 | Structural weaknesses are likely to cause production harm. |
| 0-2 | Systemic breakdown; ordinary change or operation is unsafe. |

Every dimension row in the report needs: a `score` or `no-score`, evidence coverage (`high` /
`medium` / `low`) with which module rows it covers, confidence (`high` / `medium` / `low`) with
why, and strengths/findings/evidence-gaps kept in separate lists. Use `no-score` when coverage is
too thin, the audit lacks authority to assess that dimension, or two mutually exclusive readings
of the evidence remain unresolved — never average a `no-score` into an overall number, and never
publish an overall score while any critical in-scope dimension carries one.

**Score each round independently.** Derive this round's score from this round's evidence alone.
Do not read, quote, or anchor on an earlier audit's score before forming a new one, do not adjust
a previous number toward this round's finding count, and do not pull a score back toward an
earlier value just because the gap looks too large to defend on its own. A score that differs
sharply from a prior audit is not itself an error and needs no reconciliation against that older
number. An earlier report may still be mined for *leads* — areas worth re-examining — but a lead
must be re-evidenced this round before it can affect anything; a lead is not itself evidence.

Before finalizing, a designated verifier tries to disprove every high-impact finding, defaulting
to the hypothesis that it is wrong: check the cited path, look for a same-class counterexample,
test the stated boundary, and record one of `confirmed` / `refined` / `downgraded` / `refuted` /
`unverified`, with corrected severity where applicable. If the core evidence cannot decide between
incompatible readings, mark that dimension `no-score` and escalate the ambiguity instead of
presenting both conclusions as settled.

## 3. Roles, parallelism, and boundaries

- The orchestrator splits the audit into non-overlapping, read-only responsibility areas
  (dimensions, or module families within a dimension) and dispatches workers in parallel where the
  work is genuinely independent.
- **Each worker reviews only its own assigned dimension**, returns reproducible evidence and its
  own attempted self-refutation of its strongest candidate finding, and must not modify the
  repository or start a heavy process (build, full test suite, long-running server) to produce
  evidence.
- **Cross-dimension synthesis, score calibration, adversarial verification, and the final report
  belong to the orchestrator alone** — a single-dimension worker never tries to reconcile its
  findings against another dimension's, and never performs a live operation on its own.
- **Any live operation — even a read-only one — is performed by the orchestrator only**, and only
  when both `liveMode=allowlisted-read-only` and the specific target sits on `liveAllowlist`. A
  worker that believes it needs live access stops and reports the need instead of reaching for it.
- Before proposing any finding, scan your project's current governance sources (its top-level
  agent-instructions file, decision docs, and any "rejected suggestion" records) for prior owner
  decisions and explicit non-goals. Build a do-not-recommend list from what you find and carry it
  into the report; a discovered candidate that conflicts with a recorded decision gets withdrawn
  or reframed as a factual boundary, never reintroduced as a fresh recommendation. Verify a
  decision's stated preconditions still hold before treating it as a blanket exemption — if the
  decision and current evidence genuinely conflict, report the conflict with both citations and
  ask the owner to resolve it rather than silently choosing a side.

## 4. Stop conditions and required report structure

Stop the current path — do not self-expand scope to work around it — and report the blocker plus
what authorization would resolve it whenever you hit any of:

- a write operation would be required to continue;
- an evidence conflict that cannot be adjudicated from what is available;
- anything on `liveDenylist`;
- live access that was not actually authorized;
- secret material or secret risk;
- legal or compliance text;
- a decision that belongs to the project owner, not the audit.

When a dimension's necessary evidence source is unavailable, stop that dimension specifically with
an `evidence-gap` label rather than guessing or skipping it silently.

The final report must include, at minimum:

1. the frozen intake record, resolved source ref/scope, and the module coverage manifest;
2. a one-sentence conclusion, or an explicit statement that evidence is insufficient for one;
3. a per-dimension table: score/no-score, evidence coverage, confidence, strengths, findings,
   evidence gaps;
4. systemic themes that connect findings across more than one dimension;
5. prioritized findings with verification state (`confirmed`/`refined`/`downgraded`/`refuted`/
   `unverified`) and reproducible evidence for each;
6. a phased remediation plan, clearly separated from the audit findings themselves (the audit
   observes; it does not decide the fix);
7. owner-decision withdrawals and any candidate finding that was proposed and then retracted, with
   why;
8. static-only and live-evidence limitations, listing every module row that was not fully covered.

Never describe static evidence as proof of live/production health, and never let a candidate
finding survive into the final report without a stated evidence label.

## 5. Keeping this skill and its self-check in sync

If your project builds a fill-in-the-blanks audit brief template (recommended once this skill sees
repeated use, so every audit produces a comparably structured report) alongside a small script that
validates the *template's own* field contract — i.e. it checks that the blank template still
contains every required heading and `{{placeholder}}` token, not that a filled-in brief still has
placeholders in it — keep the two in lock-step: whenever you add, rename, or remove a template
field, update that script's required-headings/required-tokens list in the same change. A checker
like this only ever knows the field list you told it about; it will not notice a silently deleted
field on its own; and it should refuse to run against a *filled-in* brief (which correctly has no
placeholders left) with a clear "you're pointing this at the wrong file" message rather than a wall
of misleading "missing field" errors.

After changing this skill's intake fields, scoring calibration, evidence rules, live-access rules,
or report structure, validate the revision before trusting it for a real audit: run it against two
or three fresh sessions that see only the skill and a realistic audit request (not your intended
findings or diagnosis), and require each to report back whether it froze the intake, scanned for
owner decisions, hit any denylist boundary as a hard stop rather than a suggestion, and what was
unclear or missing. A `no`, a skipped owner-decision scan, or any session that treats a denied live
target as reachable means revise the skill before relying on it again.

After editing this file, sync the generated per-tool projections and confirm they match:

```bash
pnpm skills:sync
pnpm check:skills
```
