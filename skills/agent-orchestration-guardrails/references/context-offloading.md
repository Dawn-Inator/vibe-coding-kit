# Context Offloading

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

### Context Offloading

A worker's context window is working memory, not storage. Two things routinely blow it up: raw tool
output that the worker only needed a few lines of, and progress that exists nowhere but in the worker's
head — so when the context runs out or the process dies, a re-dispatch starts from zero. Keep both on
disk, in the agent's own workspace, and keep only pointers in context.

- **Offload large tool output.** Any output expected to exceed roughly 100 lines / 4k tokens — test and
  remote runs, builds, repo-wide searches, multi-file diffs or logs, fetched web pages, SQL/JSON dumps —
  is redirected to a file. Read back only anchored excerpts (the red-count anchors below, `tail -n`,
  `grep -n`), and keep a one-line index entry in context: path, what it is, the key numbers. Never read
  the whole file back in. Exception: code you are about to edit or review is read by exact line range.
- **Keep a unit canvas.** A write unit with several steps, or expected to run past ~30 minutes, maintains
  a canvas file: goal and acceptance oracle, step checklist with status, confirmed facts and decisions,
  the offload index, the latest commit SHA, the next step. Update it at step boundaries, not on every tool
  call. A plain Markdown checklist is enough; it must stay greppable.
- **Resume from the canvas.** A re-dispatch after a worker died or ran out of context points at the old
  canvas and says "continue from the canvas state" — it does not restate history and does not start over.
- **Dispatch pointers, not payloads.** The orchestrator passes plan, ledger, canvas and log paths plus
  finding IDs; it never pastes multi-KB logs or reports into a dispatch prompt.
- **Where the files live.** The orchestrator keeps its own canvas and raw output in its per-session
  directory in the project's session-scratch location. A worker writes its canvas and raw output to the
  scratch directory the orchestrator names in the dispatch packet — outside any worktree, so it survives
  both the worker dying and its worktree being removed on finish — and never into the session-scratch
  location itself. Others read them by path. A re-dispatch after a dead worker points at that same scratch
  directory; a fresh one has no canvas to resume from.

Further worker prompt requirements:

- **A worker's final report to the orchestrator is a summary, not the full artifact — the full artifact
  goes to a file, the report gives the path.** A multi-thousand-token report (an independent review, a
  device histogram dump, a file-by-file test list) that lands directly in the orchestrator's context gets
  re-read and re-paid-for on every subsequent turn of that session — with a hundred more wake cycles still
  to come, that is a hundred-times cost multiplier for information the orchestrator usually never needs in
  full. Write the complete report to the worker's task output file or scratchpad and return only: the
  verdict, the candidate SHA, the key numbers, any fork that needs an orchestrator decision, and the
  follow-up items — one line each. Cap the summary at roughly 40 lines. No information is lost — the full
  report still exists on disk at the given path — it just stops being paid for on every turn that doesn't
  need it; the orchestrator re-reads the path only when it actually needs the detail.
- State the worker's assigned model explicitly — never leave it unset.
- **Every dispatch prompt must forbid mid-task status messages** — the worker sends nothing while it works,
  only when blocked and the orchestrator must decide something. Progress goes into commit messages and the
  worker's own output, not chat. Pair with a ban on backgrounding a task the worker itself is supposed to
  complete synchronously.
- **A worker must never end its turn right after announcing a next action** ("Now let's implement the
  fix.", "Now let's update doc/…", "I'll check X next") — ending the turn stops the worker; nothing
  executes the announced step until the orchestrator notices the silence and nudges it, which can be a long
  wait. A worker's turn may end only with (a) its final report, (b) a genuine blocker report, or (c) an
  explicit wait on a background task it itself started, naming that task. (c) stays fully allowed and is
  not the same failure mode: a worker that starts a genuinely long-running background command (a worktree
  finish/merge, a remote/cloud preflight) and then ends its turn to be woken by that command's own
  notification is waiting correctly, not stalling — the distinguishing fact is whether a background child
  is actually running, not whether the turn ended. **(c) is allowed once per background task**: every
  ended turn sends the orchestrator an interim notification and wakes it, so when the worker is woken again
  by a non-terminal event of that same task (a monitor line, a progress echo), it keeps waiting in a chunked
  foreground poll until the task's terminal result instead of ending its turn again with another "still
  waiting" sentence. State this explicitly in every dispatch prompt; it is a
  distinct rule from "no mid-task status messages" above, since an announcement-then-stop is not a status
  message sent mid-task, it is the turn's own last action with nothing behind it.
- Name the light self-checks explicitly in the dispatch prompt (see below) — don't assume a worker already
  knows this section exists.
- **For a large rewrite/cleanup shard, require "commit once per file/unit as it turns green" plus an
  explicit hard time limit**, sized so the shard fits inside it. A retry that respawns "the same shard"
  after a dead worker carries forward what the dead worker actually committed, not a restart from zero.
- **A worker waiting on/polling a remote/long-running command must chunk the wait** — loop with a bounded
  segment (e.g. up to ~100s, check, sleep briefly, repeat), never one long-blocking call, which risks
  silent auto-backgrounding once it outlives the tool's foreground window. The same applies to a genuinely
  local long-running command (a worktree-finish/merge with its own queue/preflight): start it detached
  (log file, disowned), then poll the log the same bounded way.
- **A background-script liveness check must not self-match the checking shell** — use a form that carries
  the full command line, or the bracket trick (`[p]attern`), so the check itself doesn't match its own search string.
- **A gating condition given to a worker must anchor a single, unambiguous target event plus its expected
  value** — never a bare string an earlier or failed occurrence can also satisfy (e.g. "after the line
  marking retry attempt N, wait for `RESULT=0`", not a bare `DONE` substring).
- **A worker/review completion must not require an orchestrator reply.** The orchestrator accumulates
  completions and batches its response (see "Quota-Aware Wake And Review Cadence" above) — a dispatch
  prompt must never instruct a worker to wait for, or block on, acknowledgment from the orchestrator.
