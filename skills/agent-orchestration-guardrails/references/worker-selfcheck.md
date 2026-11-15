# Worker verification lanes

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Cheap checks before every candidate

Resource limits do not exempt a worker from checking its own diff against the project's cheap,
script-based checks before reporting done — line/file-count budgets, forbidden-pattern scans, and similar
checks are usually pure file-system/text scripts with no installed dependencies. Skipping them moves the
failure from "caught now, in seconds" to "caught at batch end, as a rework round." If a batch goes through
multiple rework rounds purely for checks that run in low single-digit seconds, that's a sign the dispatch
prompt never named them — not that the worker was careless. Two budgets can also fight each other
(splitting a file to dodge a line-count ceiling can push a directory over its own file-count ceiling).

### What to check, generically

1. **File-size/line-count and file-count budgets**, if enforced — prefer a standalone no-dependency script
   over a fuller lint-backed variant. Read any "near-budget" warnings too.
2. **Forbidden-pattern scans in source**, if you have one — run against everything the gate scans,
   including colocated test fixtures.
3. **A syntax check on any file you hand-edited** — your language's cheapest "does this parse" check.
4. **A single new/changed unit-test file**, run directly with no browser/dev-server, as long as it imports
   nothing beyond standard library and repo-relative modules. Don't run the whole suite or a remote test
   command for one file.

A cheap check needs no installation, browser or server and finishes in low single-digit seconds. Name
the exact checks in the packet. Cheap checks alone do not establish functional acceptance.

## Controlled module verification

A module owner is responsible for the tests needed by its approved criteria, including scoped integration,
typechecking or build checks when required. Before authorizing execution, the orchestrator names:

- The exact command and module/test selection; a full module suite may be appropriate, a full repository
  suite is not automatically authorized by module ownership.
- The prepared worktree, host, dependencies, isolated database/resources if needed, and candidate inputs.
  Use the project test selector and existing isolation policy; do not install, create paid infrastructure
  or widen environment access under a verification grant.
- For heavy checks, the per-host limit, slot allocator and actual grant/lock, with command/owner, bounded
  duration, completion evidence and release/cleanup responsibility. Reuse the project's queue if present;
  otherwise the orchestrator serializes named grants and records them in existing task evidence. This
  policy does not itself implement a scheduler. A packet's permission is not an acquired slot.

Without a grant or compatible project guard, preserve a `queued-check` checkpoint with the exact pending
command, resource/queue owner and continuation. The orchestrator resumes the owner when capacity exists,
or arranges a permitted verifier and returns its results to that owner. Do not bypass hooks or call queue
time a code failure or dead worker. Continue independent work only outside the check's frozen inputs.

After the actual result, fix failures within scope and rerun affected checks. A nonzero result is failure;
a lost result or changed inputs are unknown/stale, not pass. Release the slot and stop owned test processes
before handing off. Follow the host's supported background/wait mechanism for long checks; no untracked
server, watcher or waiter may outlive a checkpoint. Never stop another session's processes.

`client-check` from an orchestrator-prepared `--with-deps=<client>` worktree is one supported lane, not
the only possible module test. Other named lanes must honor existing project guards. Selected shared or
repo-wide integration checks and final gates remain orchestrator-controlled after candidate integration;
the owner fixes its failures and the orchestrator independently accepts the resulting candidate.
