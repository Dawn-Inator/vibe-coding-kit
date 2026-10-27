# Working in this repository

- **Commit straight to `main`.** AI agents push their changes directly to `main`; do not create feature,
  `candidate/*`, `diagnostic/*` or `review/*` branches, and do not open pull requests for your own changes.
- Before pushing, run the tests your change touches (`node --test <files>`) and, for non-trivial changes,
  the full manifest with `npm test`. A push to `main` must not knowingly turn CI red; if it does, fix it on
  `main` right away.
- New test files must be listed in `tests/manifest.json`.
- CI after every push to `main`:
  - `CI` (`.github/workflows/ci.yml`): full test manifest on Ubuntu, macOS and Windows, Node 20 and 22.
  - `Windows system diagnostic` (`.github/workflows/windows-system-diagnostic.yml`): Windows-only checks
    (native process safety, Git hook environment, packaged installer, CLI process-tree cleanup). Need it
    without a code change? Start it manually with "Run workflow" (`workflow_dispatch`). Never push a
    throwaway branch just to get a CI run.
