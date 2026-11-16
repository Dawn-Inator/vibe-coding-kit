# Module delivery ownership

Read when decomposing implementation or returning a candidate for repair. This contract applies to
authorized delegation; it does not require extra agents for a small task or grant deployment authority.

## Decompose by an acceptance outcome

Assign one persistent delivery owner to a bounded function that can be accepted independently, for example
"authenticated order lookup with pagination, storage wiring, error paths and tests". Include the actual
layers and internal composition needed by the approved goal. A source file, an investigation, or a test run
can be a supporting task, but is not a replacement for the function's delivery owner. Do not manufacture
tiny tasks to keep agent counts high or give one worker an entire inseparable program.

Identify contracts and shared file owners before fan-out. Prefer separate managed worktrees when candidates
need independent validation. A shared managed checkout still needs exact disjoint write sets, one Git owner,
and stable validation inputs. Contract/generated/shared bootstrap files have one explicit owner; a module
owner coordinates required changes through that owner instead of editing across the boundary. Re-scope or
serialize when no independent write/acceptance boundary exists.

Owners may choose local design and test cases within approved requirements and contracts. Cross-module
contracts, architectural boundaries, missing product decisions and additional authority go to the
orchestrator. A missing internally owned adapter, consumer, store or startup binding is remaining development:
name its owner and interface, arrange the dependency through the orchestrator, and continue independent work.
Do not call it an unavailable external input or replace it with a passing stub. A real external blocker names
the unavailable input/resource, evidence, responsible party and the work it actually prevents.

## Persistent owner, bounded invocations

Put this obligation in every implementation packet:

> You own this module through requirements coverage, implementation, authorized tests, fixes and
> resubmission. Continue until it is ready for independent acceptance or a concrete blocker prevents further
> work. Returned findings remain yours to fix. Code written, one passing test, and an invocation's final
> report do not mean the module is accepted. Preserve a resumable checkpoint when this invocation must end.

The owner derives positive, negative and recovery cases from the approved acceptance criteria, implements
the function, runs the authorized checks, fixes failures and repeats affected checks. It submits a candidate
only when the agreed criteria have evidence. Missing checks remain explicitly unverified. Do not expand the
goal or loop indefinitely: repeated identical failures or no new evidence trigger the existing escalation
policy and a diagnosis/re-split, not another unchanged retry.

Keep one final private handoff per invocation using the host's result channel. It states one outcome:

- **Candidate**: ready for the orchestrator's independent acceptance; not self-accepted.
- **Checkpoint**: unfinished, including a resource queue wait; preserve the exact continuation and next owner.
- **Blocked**: identify the concrete dependency, decision or authority and what can still proceed.

These are handoff outcomes, not new heartbeat Item statuses. A native `completed` event ends that invocation,
not the module obligation. The orchestrator consumes its private result and resumes the same owner through
the host's follow-up mechanism for queued checks or repairs; do not require a worker to block awaiting an
acknowledgement. If unavailable, recover the recorded checkpoint into a replacement owner after checking
liveness and write ownership. Record an explicit transfer rather than creating an unrelated bug-fix task
with lost context. No checkpoint may leave an untracked background process or resource slot behind.

## Durable record and independent acceptance

Reuse the task packet/checkpoint linked from the existing registry's evidence; do not create another registry
or a timer for each worker. Keep: stable module ID and approved criteria, delivery owner/runtime identity,
worktree/write set, candidate commit (or exact content snapshot before a serial commit), phase, last meaningful
evidence, next action, dependency/queue owner, test results and acceptance decision. Record phases such as
`implementing`, `testing`, `fixing`, `queued-check`, `awaiting-acceptance`, `accepted`, or `blocked` in that
record; keep them separate from operational Item status. Do not infer them for legacy records.

On every candidate return, the orchestrator:

1. Matches the result to the approved criteria and exact candidate, inspects the diff and real dependency
   wiring, and examines evidence for success, failure and recovery behavior. Independent review may supply
   evidence; it cannot make the final acceptance decision.
2. Runs or delegates the necessary independent checks against that candidate, including critical paths not
   established by the owner's evidence. Select scope by impact; avoid rerunning unchanged owner checks
   without an independence or integration reason. A candidate change makes affected evidence stale; bind
   final acceptance to the actual integrated commit and its required checks.
3. Records accept, return-for-fix, or blocked with reasons. Return findings and their oracle to the same
   delivery owner, which fixes and resubmits. Do not silently turn the orchestrator into that module's fixer.
4. Integrates accepted candidates through project lifecycle/gates and verifies target-branch landing. Keep
   owner self-verification, orchestrator acceptance and landed/pushed state distinct. Acceptance never
   implies deployment or a check that did not run.

Handle a private candidate final promptly; it need not wait for the next heartbeat. When acceptance or test
queues accumulate, prioritize draining them and completing current modules before opening more work.
Concurrency follows independent work, host capacity and acceptance capacity, not a target agent count.
Use [capacity balance](capacity-balance.md) to adjust wiring, execution and acceptance effort from the
observed limiting stage, retaining module owners and comparing the effect at the next review point.
