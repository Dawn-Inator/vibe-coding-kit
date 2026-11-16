# Balance wiring, execution and acceptance

Use at intake, before a new wave, on a material dependency/queue change, and in a full heartbeat audit.
The orchestrator makes the allocation decision; this guidance grants no extra agents, write access,
worktrees, host slots or final-acceptance authority. Honor explicit user staffing constraints first.

## Define the work before the ratio

- **Module execution**: the persistent owner implements requirements, local wiring, tests and repairs
  through resubmission. Do not move all module-internal composition into an integration service desk.
- **Cross-module wiring**: implement agreed adapters, shared contracts, startup composition or candidate
  integration across owners. Assign exact independent boundaries and one owner for each shared file or
  generated surface. Wiring is implementation work; choose its model by difficulty, not its role label.
- **Acceptance capacity**: independent review and verification assistance, plus orchestrator decision time.
  An author cannot independently review its own change, and helpers do not acquire final acceptance authority.

Describe planned allocation separately from actual activity. For a staffing ratio, count each worker once
by its primary assignment for the observation window; list secondary duties and their estimated effort
separately. Exclude the orchestrator and report acceptance helpers separately from wiring:execution. An
inactive owner still owns its module but is not an active worker. Do not equate staffing with token spend,
elapsed work, or measured effectiveness; describe uncertainty when mixed duties make a ratio misleading.

For an integration-heavy closeout with no project measurements, wiring:execution around **1:3** is a
starting hypothesis; a demonstrated internal-wiring bottleneck may justify **1:2**, while stable interfaces
and independent delivery may allow **1:4–1:5**. Reserve acceptance capacity separately. These are examples,
not quotas, proven optima or reasons to create work. Small tasks may combine duties; independent acceptance
must still satisfy project rules. User-specified owner counts cannot silently be reduced to fit an example.

## Observe the limiting stage

Reuse the existing task packets/checkpoints and audit evidence. Record the observation window and scope,
planned/observed roles, distinct waiting module/candidate IDs, dependency or queue owner, wait start/age
when known, arrivals and completed work, and available write/host/review capacity. Group waits on the same
dependency so repeated messages about one shared file do not look like many independent bottlenecks.
Missing baselines or queue timestamps are unknown; do not invent a trend or extrapolate from headcount.

| Evidence of a bottleneck | Allocation decision |
| --- | --- |
| Multiple modules wait on the same missing internal adapter, contract or startup binding | Prioritize that wiring owner; allocate bounded support only where writes and validation inputs can be separated. Preserve each module's delivery owner and continue its independent work. |
| All helpers need the same shared file, generator window or mutable candidate | Keep one owner, agree the interface, serialize or split the actual boundary. Extra writers do not increase this stage's capacity. |
| Evidence-backed candidates accumulate awaiting independent acceptance | Prioritize independent review/verification and main's decision time; defer new work feeding that queue. Keep reviewers independent; return repairs to the module owner. |
| Required checks mostly wait on occupied host slots | Improve selection, deduplicate checks or schedule stable snapshots through the approved lane. Extra agents are not host capacity; never raise limits or use a new remote pool under this rule. |
| Modules remain in implementation/rework while wiring and acceptance have room | Allocate available effort to their execution/fix loops; do not add coordinators to an empty queue. |
| An actual external input or authority is absent | Record the responsible party and affected scope. More internal staffing cannot supply it; progress independent work without inventing an external blocker for unfinished internal code. |

## Change, then check the effect

1. Compare current evidence with the preceding comparable audit/window when available. A practical signal
   is the same limiting stage across two audits, or an actionable critical dependency observed now; do not
   delay a candidate, defect or urgent blocker merely to fill two observations.
2. Pick one bounded allocation change that attacks the limiting stage, with an expected observable effect
   and next review point. Prefer an available helper, the next free assignment, or a dependency-first wave.
   Keep module owners responsible through acceptance. Any ownership transfer needs the normal liveness,
   write-set and handoff checks; do not abandon modules or silently cancel active assignments to hit a ratio.
3. Record the evidence, before/after allocation, selected action or reason to hold, responsible owner and
   review point in an existing linked checkpoint. Track planned and actual counts separately. When an
   explicit agent plan changes, advance its existing plan revision and use real dispatch receipts; an
   allocation proposal or changed role label alone proves neither dispatch nor activity.
4. At the next comparable window, check whether the targeted dependency cleared or queue age/backlog fell,
   and report newly accepted modules and landings separately for the same scope and interval. Account for
   arrivals, candidate size and host downtime; a smaller queue alone does not establish higher throughput.
   Keep, revise or revert the allocation from that evidence. Avoid oscillating on one notification or
   repeatedly adding workers when the first change did not remove the shared constraint.

If a binding user staffing rule, missing authority or lack of independent scope prevents reallocation,
record that constraint and what can still proceed. A current maximum is not a utilization target, and a
minimum owner requirement does not imply every owner is currently running. Keep heartbeat status enums,
source-of-truth records and certification unchanged; this is a decision policy, not an automated scheduler.
