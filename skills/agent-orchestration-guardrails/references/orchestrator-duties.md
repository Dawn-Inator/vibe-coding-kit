# Orchestrator Duties And Bug-Fix Delegation

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Bug-Fix Ownership

A single-agent orchestrator may implement a fix directly with an explicit acceptance oracle. In a project-mandated dispatch-only mode, assign fixes to a write-capable worker.

- In dispatch-only mode, the orchestrator limits its own edits to permitted orchestration artifacts and integration.
- **A finish/merge chain must be gated on the verification result — never `build; finish` unconditionally.**
  Run the acceptance oracle, check its actual exit code/result, and finish only on green.
- Apply the active mode and higher-priority delegation instructions to issues found during review.

See your project's tutorial for the incident that motivated this section.

## Orchestrator Duties

The active bug-fix ownership rule, the symlink-prohibition, the light-self-check naming, and the per-host heavy
process limit are stated in full above (see "Orchestrator Does Not Fix Bugs By Hand", "Worker Prompt
Requirements", "Worker Light Self-Check Before Handoff", and "Core Rule") — restate all of them in every
dispatch prompt rather than assuming a worker already knows them. Additional orchestrator-only duties:

- Pre-create and mark worker worktrees, pass exact paths, and keep dependency preparation plus batch
  verification in the top session. Treat a worker's direct heavy shell command as a guardrail violation
  even when the command happens to succeed.
- For long-running commands, redirect output directly to a log file; avoid shell pipelines that can
  silently block progress.
- **A background task's completion notification is not itself the exit code — treat its reported status as
  a claim, and verify it against the log file the command was told to write to.** Read the log's own exit
  indication at least once per command class before trusting that class of notification going forward.
- **A worker notification that is only an announcement, with no background child actually running for that
  worker, is a stall — nudge it immediately in the same wake, not on a later pass.** Distinguish this from
  a worker that correctly ended its turn to wait on a real backgrounded command it started (a worktree
  finish/merge, a remote preflight): that case has a live/queued background child and must be left alone to
  be woken by its own notification. An announcement with no such child behind it never resolves on its own.
  If your project has a mechanical announcement-pattern checker, run the worker's notification text through
  it as a cheap second line before deciding — a heuristic text match is not a substitute for actually
  checking whether a background child is running, but it catches the common phrasing fast and costs one
  local, dependency-free call. See your project's tutorial/incident record for why prose alone did not
  reliably stop this pattern.
- For very large workflows, create batch-level checkpoints before starting the next batch.
- **Before a repo-wide scan, name the subtree the governing gate actually judges and scan only that** — do
  not default to the repo root. Most repositories carry real, large, gitignored build-product trees that a
  naive full-repo scan will walk into and stall or time out on, none of which is source the scan needs to
  see.
- **A worker's finish/merge push can be rejected by a pre-push hook that re-runs the same preflight gate**,
  independently of the worker's own per-worktree preflight — expected, not a new failure class to route
  around. Treat it exactly like any other red preflight: fix the reported checks and re-run the normal
  finish command, never a hook-skipping flag or an unapproved environment override.

## Related

Cross-reference this skill with whatever your project already has for:

- A memory/incident-log doc or tutorial for agent orchestration, if you keep one — this skill states the
  durable rule; a log/tutorial is where the specific incidents that justified each rule live.
- A remote/cloud test-runner skill, if you have a dedicated test host.
- A test-scope-selection skill, if your project has change-driven test selection instead of always running
  the full suite.
- A worktree lifecycle skill, if your project manages agent worktrees with a dedicated tool.
- A model/effort-routing skill, if your project has a separate, fuller routing matrix beyond the rules
  restated here.
