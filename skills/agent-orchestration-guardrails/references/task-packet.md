# Task Packet Reference

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

### Task Packet Reference

A task packet is the minimum contract the orchestrator builds *before* dispatching a worker; the worker's
final handoff reports back using the same fields. The packet can live in the dispatch prompt itself, a
scheduler entry, or a handoff message — the fields below must never be left to be inferred from
surrounding conversation:

| Field | The task packet must state | The worker's final must report |
| --- | --- | --- |
| Target & boundary | The result to achieve, the scope explicitly *not* to touch, the sole file owner; a pre-review task additionally states its independent-review status, a `write_scope: none` restriction, and which authorities it is forbidden from exercising | Whether the actual change stayed inside that boundary; escalate an out-of-scope need rather than silently expanding it |
| Basis & oracle | Known facts, unverified assumptions, the success/failure oracle, the evidence tier required | Actual observations, command/artifact results, unverified items and remaining risk |
| Candidate | Base ref/SHA, target branch, the expected candidate SHA and when it goes stale | This run's commit SHA, its parent/base, and whether the candidate is still the target tip |
| Verification & closeout | Which light/heavy checks are allowed, who owns guard/gate/finish authority, whether there's an in-flight lock/SHA already being verified | Which checks actually ran and their results; final guard/gate/finish state; release/readback evidence where applicable |
| Status & handoff | The conditions for each terminal status (e.g. fix-needed / verified / blocked) and who owns the next step | Current status, next step, what authority or evidence is needed from whom |
| Execution identity | The requested model/effort, and the actual model/effort resolved after the current adapter validates it | The actual model/effort the run used, from a real runtime receipt — write "unknown" when the host doesn't expose this |
| Attempt & escalation | The attempt number, the one same-tier retry this attempt is allowed, the conditions for escalating effort/model, and a ban on a worker recursively spawning its own sub-workers | The actual attempt number, the failure category if any, which escalation (if any) was already used, and a recommended next owner/tier |
| Progress durability | **Mandatory in every write-capable dispatch prompt**: "commit to your own worktree branch each time a verifiable unit turns green (no push, no finish until the end)" | Which sub-steps were actually committed as they landed, with commit SHAs |

In a shared managed checkout, workers must not stage or commit concurrently: the orchestrator alone
checkpoints the disjoint patches serially. The packet explicitly names that exception and commit owner;
otherwise each write-capable worker has its own branch/worktree as the table requires.

This "Progress durability" field is what makes a worker's real progress recoverable from `git log` if the
orchestrating session itself dies or restarts mid-flight — see "Orchestrator Process-Exit Recovery For
In-Flight Workers" below for the full recovery procedure. On a new/restarted session, before re-dispatching
anything, run your worktree tool's status command and inspect each managed worktree's `git log` — continue
from committed work instead of re-dispatching from zero.

File ownership inside a task packet is a *write-isolation* boundary, not a transfer of business authority
— a worker must not revert, overwrite, or clean up another worker's changes; report a shared boundary,
misassignment, or moved base to the orchestrator rather than resolving it unilaterally.

**Evidence freshness**: the SHA a worker's evidence is bound to matters more than the fact evidence exists.
Old evidence does not automatically carry over after a commit/rebase/finish/target-branch advance — a
result not tied to a specific SHA is a clue, not verification. "Published" (committed/finished/
pushed/merged/deployed visibly) is not "verified" — verified additionally requires the acceptance oracle to
have actually run against that exact SHA and recorded a result. An HTTP 200, a CLI message, a reachable
URL, or "a prior release record exists" cannot alone prove acceptance.

Keep `guard` (may a boundary be entered/exited — no correctness claim), `gate` (does one SHA satisfy a
defined check set — not a release readback), and `finish` (merges/cleans up/pushes — doesn't turn an unrun
check into a passed one) conceptually separate; never let a worker report blur them into "everything is
done." A worker may only report the actual output of the authority it actually holds.

Workers must not spawn additional agents or independent windows — the top orchestrator owns fan-out. If the
platform can't mechanically prevent re-delegation, state the prohibition in every worker prompt and treat a
recursive spawn as a failed health check.
