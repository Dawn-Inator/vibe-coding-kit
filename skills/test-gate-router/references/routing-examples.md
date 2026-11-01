## Routine defaults — fill in for your project

The bullets below are the *shape* of a defaults table, not its content. Replace them with your own project's mapping from change type to required checks:

- Backend-only business/service/model change → run the selector's focused unit/contract coverage for that layer. Add focused tests whenever business logic, persistence, authorization, or an API contract changes.
- Visible frontend change → run the focused UI/E2E flow for the changed surface and save evidence (e.g. screenshots) under a consistent, clearly named location.
- Frontend/backend integration change → run the focused end-to-end flow; only add backend tests too when the change includes backend business logic, persistence, authorization, or contract behavior — a UI-wiring-only change doesn't automatically earn duplicate backend tests.
- API/schema/type-contract changes → regenerate any generated artifacts (API specs, generated client types, etc.) and run the relevant static-contract checks.
- Database/migration changes → follow your project's migration process and its associated checks; do not treat hand-run raw SQL as an ordinary test path.
- Tooling/automation/script changes → run the selector-owned focused checks for the affected script(s). Escalate to a broader/full check only for an unowned or cross-cutting surface, an explicit request for full validation, or when your own gate rules require it.

To make this real, your project needs to define, concretely:

1. **A selector** that maps changed files to the tests that must run. Start with a simple table (path prefix → test target) and grow it as the codebase does.
2. **Cost-tiered command sets** — at minimum: a cheap set that runs by default, a medium-cost set gated on some trigger (e.g. "only if this subsystem changed"), and an expensive set (full suite, full end-to-end) that only runs on an explicit request for full validation, never by default.
3. **A local-vs-elsewhere rule**, if your project has more than one place tests can run — typically driven by how heavy the chosen command is and how much local headroom (CPU/memory, an already-running dev server) is currently available.

Once the selector exists, make it fail closed rather than quietly widen:

- Give each mapping a kind: **exact** (bound to specific inputs), **bounded-class** (a declared
  invariant or budget limits what it covers), or **aggregate** (a broad lane, allowed only with a
  reviewed waiver). A changed file with no mapping (a gap), a mapping that silently falls back to a
  whole directory or sibling package (coarse), or unreadable selector metadata is a failure to fix,
  never a reason to run "something nearby."
- Keep changes focused by default; app-wide coverage or a shared aggregate lane is an explicit,
  named choice, not an automatic fallback.
- When a check compares against a base, the tree under test is always the candidate tip you are
  about to ship; the base ref is only the baseline for diffs and receipts and must resolve to the
  branch you are landing on. Never test the base and call it the candidate.

Make your default, everyday commands selector-first (they consult the selector rather than always running the full suite), and reserve any "run everything" command for an explicit trigger — a developer literally asking for full/pre-release validation, or a rule in your own gate contract that requires it.

For routine day-to-day work, keep checks local, focused, and serial by default. A routine "deploy to a dev environment" or "commit this" action should not silently imply a full cloud gate, a full end-to-end suite, device automation, or waking up a remote pool of test machines.

## Always add these when applicable — fill in for your project

If your project has lightweight, fast, structural checks that should run whenever certain kinds of files change — for example, syncing generated skill/doc indexes, or checking for stray whitespace before a commit — list them here as an explicit checklist so they aren't forgotten. Example shape:

```bash
your-skill-sync-check      # run when a skill/agent-instruction source file changed
your-docs-index-check      # run when docs, skills, or their generated indexes changed
git diff --check           # catch whitespace errors before committing
```

Keep pure knowledge edits to relevant sync, structure, reference, command-validity and diff checks. Do not add wording assertions or selector mappings merely for prose edits; classify command/permission/release changes by their behavior. Once relevant checks pass with no unresolved risk, repeat or expand only when effective inputs change, a check fails or a concrete new concern arises. Exact-SHA release evidence keeps its own binding requirements.

Do not substitute a broad gate for the changed-surface selector described above. Serialize test runs only for real shared-resource, dependency or release-state contention.
