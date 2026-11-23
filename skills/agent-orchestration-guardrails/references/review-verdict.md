# Review Verdicts And Orchestrator Intake

Read when dispatching an independent reviewer, or when deciding what reaches the orchestrator's context on a
candidate return. The orchestrator keeps final acceptance authority; this page changes what it reads, not
who decides.

## Why the orchestrator reads verdicts, not diffs

The orchestrator's context holds the goal, contracts, dependency order and every open decision. Raw diffs,
logs and full files for each candidate fill it with low-level detail and crowd those out, and one session's
acceptance throughput becomes the limit of the whole run. An orchestrator that does not implement, and that
reads structured conclusions instead of artifacts, keeps its context for decisions.

## Verdict format

An independent reviewer returns its final as a verdict summary. The full review, diff excerpts and logs go
to the offload path named in its packet ([context offloading](context-offloading.md)).

| Field | Content |
| --- | --- |
| Module and candidate | Stable module ID, exact candidate SHA and base; the verdict is stale once the candidate moves |
| Recommendation | `accept`, `return-for-fix` or `blocked`; a recommendation, never the acceptance decision |
| Findings | Each with severity, `file:line`, the violated criterion and a one-line fix direction |
| Risk classes | Every class the change touches: money/billing, auth(n/z), migrations/schema, secrets, irreversible actions, cross-module contract or shared-file changes; `none` only after checking each |
| Coverage | What was examined and what was not (files, paths, criteria), and why |
| Confidence | `high`, `medium` or `low`, with the reason for anything below `high` |
| Evidence path | Offload path of the full review and its supporting excerpts |
| Reviewer identity | Requested and actual model/effort, and whether its context was isolated from every owner and from the orchestrator |

A verdict that misses a field, is bound to no SHA, or leaves risk classes unchecked is incomplete: treat it
as no review and return it to the reviewer.

## What reaches the orchestrator

By default the orchestrator reads the verdict summary, the owner's structured final and its own records,
not raw diffs, logs or full file contents. It opens the evidence path or the diff itself when any of these
applies:

1. A risk class other than `none` is flagged. Material touching money, auth(n/z), migrations, secrets or an
   irreversible action reaches the orchestrator verbatim regardless of context budget.
2. The verdict and the owner's evidence disagree, or confidence is below `high`.
3. A cross-module contract, shared file or architecture boundary changed.
4. Sampling: at least one routine candidate in every five accepted on verdicts alone. This is a starting
   value; adjust it from findings that surface after acceptance.
5. The orchestrator itself authored integration or merge-resolution changes in the candidate.

Record which case applied, or that none did, with the acceptance decision. Skipping the diff never skips the
decision: the orchestrator still matches the verdict and owner evidence to the approved criteria and the
exact candidate, and records accept, return-for-fix or blocked.

A candidate with no verdict, the recorded skip case for a bounded single-worker candidate, is reviewed by
the orchestrator directly. When several candidates are in flight, prefer dispatching a reviewer over that.

## Review seats

A reviewer is read-only (`write_scope: none`), separate from every implementation owner, bound to one SHA,
and cannot edit, commit, merge, finish, push, deploy, invoke gate or release authority, or spawn agents.
Context isolation is required. A reviewer from a different model family than the owner is preferred when
the runtime offers one, for example a Codex reviewer for a Claude-authored candidate, because reviewers that
share the author's model tend to share its blind spots. Findings return to the same delivery owner through
the orchestrator; the reviewer never hands fixes to the owner directly.
