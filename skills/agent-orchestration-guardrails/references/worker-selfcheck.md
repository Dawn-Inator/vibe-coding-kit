# Worker Light Self-Check Before Handoff

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Worker Light Self-Check Before Handoff

The heavy-process ban doesn't exempt a worker from checking its own diff against the project's cheap,
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

A check is worker-safe when it never starts a type-checker/browser/dev-server, needs no package install (or
only stdlib/repo-relative imports for a single test file), and finishes in low single-digit seconds.
Anything heavier stays with the orchestrator at batch end — **except** the one named `client-check`
command from a worktree the orchestrator created with `--with-deps=<client>` (see "Worker Prompt
Requirements" above), which is a required self-check, not a violation, precisely because it is the
narrow, pre-authorized lane, not a worker's own judgment call to run a heavier command.
