# Orchestrator Duties And Bug-Fix Delegation

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Orchestrator Does Not Fix Bugs By Hand

The orchestrator's job is dispatch, integration, centralized verification, and acceptance — not writing the
fix itself. **Any code/test/config fix, however small, is dispatched to a write-capable worker with an
explicit acceptance oracle.** "It's a one-liner" is not an exception — that class of fix is exactly what
this rule covers, precisely because its small size is what makes it tempting to hand-patch instead of
dispatching.

- **The orchestrator may only edit files that are pure orchestration artifacts**: handoff/plan/status docs
  it owns, and conflict-marker resolution during a rebase/merge it itself owns. It must not touch source,
  test, or config files to resolve a bug, however trivial the diff looks.
- **A finish/merge chain must be gated on the verification result — never `build; finish` unconditionally.**
  Run the acceptance oracle, check its actual exit code/result, and finish only on green.
- If the orchestrator notices a bug while reviewing or integrating a worker's output, the correct action is
  to dispatch a fix task, not to open the file and patch it directly, even when a worker dispatch feels like
  overkill for the size of the change.

See your project's tutorial for the incident that motivated this section.

## Orchestrator Duties

The bug-hand-patching ban, the symlink-prohibition, the light-self-check naming, and the per-host heavy
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
