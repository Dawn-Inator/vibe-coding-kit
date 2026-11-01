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
