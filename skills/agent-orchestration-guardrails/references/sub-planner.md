# Sub-Planners For Large Fan-Outs

Read when more than about six module owners would be active at once under one orchestrator, or when the
orchestrator's acceptance queue stays the limiting stage. Status: trial. The sizing values below are
starting points to calibrate with [capacity balance](capacity-balance.md) trials, not measured defaults.

## What a sub-planner is

A sub-planner owns one domain subtree: a coherent area with its own contracts, such as a ledger domain or
a client domain. It is a persistent planning and acceptance seat for that subtree.

- It decomposes the subtree into modules, writes their packets, and decides accept, return-for-fix or
  blocked for routine modules from the owner's final and the [review verdict](review-verdict.md).
- It never writes code and holds no merge, finish, push, deploy or gate authority.
- It escalates to the top orchestrator: every flagged risk class, any change to a cross-domain contract or
  shared file, architecture forks, and anything another subtree must also decide. A subtree needing
  another subtree's change asks the top orchestrator, never that subtree.
- The top orchestrator keeps goal interpretation, cross-domain contracts, final acceptance of each subtree
  candidate and of every escalated module, integration and landing.

Depth stays at two worker layers: top orchestrator, sub-planner, module owners. A sub-planner cannot create
another sub-planner, and reviewers never delegate. Dispatch it with the `sub-planner` role on Claude
Code ([runtime enforcement](runtime-enforcement.md)) and a packet with `role: "sub-planner"`.

## Two runtime modes

- **Nested dispatch available and authorized** (`nestedDispatch: true` in its packet): the sub-planner
  dispatches its own module owners and reviewers, reports every child identity and model, and returns a
  subtree summary.
- **No nested dispatch** (the default, and the only mode for the `sub-planner` role, which has no
  dispatch tool): the sub-planner returns packets; the top orchestrator dispatches them unchanged and
  routes each owner final and verdict back to the sub-planner by file path. Workers write their finals and
  evidence to the offload directory, so the top orchestrator forwards paths, not contents.

## Sizing

Count concurrently active module owners. Explorers and reviewers are support and do not count. Two limits
apply together: each sub-planner directs three to six active owners, and the top orchestrator's direct
reports (sub-planners plus owners it directs itself) stay at six or fewer.

| Active module owners | Sub-planners | The top orchestrator directs |
| --- | --- | --- |
| 1 to 6 | None | Every module directly |
| 7 to 12 | 2 to 3 | The sub-planners, a cross-domain contract owner and a cross-module wiring owner |
| 13 to 24 | 3 to 4 | The same |
| 25 or more | Do not add more | Split the work into separate batches or runs instead |

Within a range, the number of natural domains decides. A domain with fewer than three modules joins an
adjacent subtree or stays with the top orchestrator. Never split a domain to reach a count. Host
heavy-process limits are unchanged: more agents are not more host capacity.

## Worked example

A loyalty-points feature with 12 modules and three domains:

- Top orchestrator directs five: a contract owner for the points API and points event schemas, a wiring
  owner for startup composition, and three sub-planners.
- Sub-planner A, ledger domain: ledger storage and migration, earning rules, redemption API, risk limits.
- Sub-planner B, client domain: app points page, redemption flow, admin console, deep links and routing.
- Sub-planner C, events and operations: points-changed events, push notifications, analytics events,
  operations reports.

Wave 0 freezes the cross-domain contracts through the contract owner. Wave 1 runs the three subtrees in
parallel. Sub-planners accept routine modules such as analytics events and report pages from verdicts.
Ledger, migration and redemption touch money and migrations: they are escalated, get an additional
reviewer from a different model family where available, and reach the top orchestrator verbatim. When the
client domain needs a new redemption field, B escalates; the contract owner changes the contract and A
follows. The top orchestrator's context holds three subtree summaries and a few escalations instead of
twelve diffs.

With five modules the same feature needs no sub-planner.

## Trial and evidence

Run the first use as a bounded trial on a real task with at least eight modules. Record for the trial and
for the most comparable earlier run: the top orchestrator's acceptance queue age, escalation count, repair
rounds per module, modules accepted on first submission, and modules returned after a sub-planner
accepted them. Keep, adjust or drop the sizing values from that evidence, and record the result in
[rule assumptions](rule-assumptions.md).
