# Working in this repository

- **Commit straight to `main`.** AI agents push their changes directly to `main`; do not create feature,
  `candidate/*`, `diagnostic/*` or `review/*` branches, and do not open pull requests for your own changes.
- **Finish on the remote by default.** Unless the user asks to keep work local or use another branch, complete
  the work by integrating with the latest `origin/main` and pushing the final commit to `origin/main` before
  reporting completion. Verify the remote contains the commit; if a conflict, authorization or required check
  blocks landing, preserve the work and report the blocker. Never force-push or deploy as part of this default.
- Tests run only when the developer explicitly requests them. Pushes and pull requests do not start tests;
  explain unverified changes when reporting them. Do not dispatch workflows without a developer request.
- New test files must be listed in `tests/manifest.json`.
- Developer-requested CI, both workflows are manual dispatch only:
  - `CI` (`.github/workflows/ci.yml`): full test manifest on Ubuntu, macOS and Windows, Node 20 and 22.
  - `Windows system diagnostic` (`.github/workflows/windows-system-diagnostic.yml`): Windows-only checks
    (native process safety, Git hook environment, packaged installer, CLI process-tree cleanup). Need it
    without a code change? Start it manually with "Run workflow" (`workflow_dispatch`). Never push a
    throwaway branch just to get a CI run.
