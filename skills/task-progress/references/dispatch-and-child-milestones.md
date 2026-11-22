# Dispatch and child milestones (task-progress reference)

- **Parent assignment.** Include the child progress instructions when dispatching. Immediately after dispatch
  returns, record the exact native child thread ID on the assigned ordinary objective or item through
  `TaskStore.rescope` using the current revision and retained scope (`agent: { threadId, path? }`).
  Omission preserves an existing assignment by item ID during an active-cycle rescope, including moves.
  `agent: null` clears it, and a new cycle does not inherit it. An item inherits its objective’s assignment
  unless it explicitly overrides or clears it. For a related read-only Kit Heartbeat, the authorized source
  writer uses `recordHeartbeatAgentAssignments` on canonical Items leaves with a fresh pair version. Follow
  “Recording agent assignments” in the [heartbeat writer contract](../../agent-task-supervision/references/ledger-api.md)
  for legacy rows, exact dispatch evidence, and ownership. Use the child thread ID from the actual native
  dispatch result or trusted native evidence tied to that exact dispatch. An owner name, path, blank legacy
  receipt, or similar-looking prior run cannot establish a match. Skip ambiguous and tracking-parent rows.
  Reassign or clear a link only on evidence. Keep unavailable IDs unknown.
- **Child execution.** In the child's own authenticated task context, use `TaskStore.getReadOnly` before work and
  register the actual assigned module milestones via `TaskStore.initialize` when absent. Resume an open
  scope or rescope an existing task when required. Use `TaskStore.update` to record completed milestones
  with evidence during execution and reconcile the checklist before the private final. Use the latest revision
  and retain the request ID when retrying the same mutation. Keep the journal in the child's trusted workspace
  through normal Kit APIs. If the Kit APIs or a trusted source are unavailable, report the gap in the private
  final. Do not copy the parent's task or Native Goal, impersonate another session, or write a parallel progress
  file. A parent cannot write the child's private task journal on its behalf.
- **Parent acceptance.** Assignment proves which unit the child owns. The child's checklist records execution
  in that module. The parent checks applicable acceptance, integration, and delivery evidence before marking
  the corresponding canonical parent leaf complete. A dispatch receipt, a complete child checklist, and a
  private final alone do not prove acceptance. Use the recorded assigned leaves for parent progress, and the
  child's own canonical checklist for child execution progress when the scope fence below is satisfied. Missing,
  heartbeat-bound, uncertain, or different-workspace child journals leave child execution progress unknown.

A recorded runtime observation applies to its timestamp. Direct runtime active flags take precedence, partial coverage gives a lower bound, and ratios require an exact current plan.

For the current-turn subagent view, use the normalized snapshot’s `taskCycleId`, `rootTurnId`, `rootTurnStartedAt` and `scopeBasis`. A `parent-root-turn` scope requires causally confirmed dispatch, continuation or subAgentActivity from the trusted parent’s latest root turn. Ordinary managed tasks remain fenced by the matching lifecycle ID and start time. For a read-only Kit-bound task without a lifecycle, a bounded canonical source path and verified latest root start provide the scope fence instead; do not invent a lifecycle or apply this fallback to ordinary tasks. Check direct `thread_spawn` evidence to exclude internal review and compaction threads. A missing required scope fence or records, incomplete summaries or unknown scope remain unknown; never substitute the parent chat’s full historical child inventory. Child `createdAt` and `updatedAt` do not establish dispatch, and `notLoaded` does not establish running. Do not present a Heartbeat allocation from before the current root turn as its current ratio. A later parent continuation invalidates the child’s earlier completion state. Show child progress only when the latest exact dispatch time is established and the child task cycle start or creation is no earlier than that dispatch; otherwise show unknown, never carry forward an old 100% or completed state. Use only a verified root start time for the plan ratio; if it cannot be established, the ratio is unknown. Cache and display must respect the same cycle and scope fences.
