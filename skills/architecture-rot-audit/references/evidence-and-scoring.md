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
