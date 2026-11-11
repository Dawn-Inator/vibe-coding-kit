# Heartbeat ledger format and API

New audits use `heartbeat/v2`. Preserve every existing wake byte; append a new wake with the historical
`## <ISO time> wake (10-row ledger)` heading, then a standalone `contract: heartbeat/v2` line. Keep the ten
category rows and `sources:` line. The v2 wake adds a `### Decomposition` table and standalone `re-split:
rows(...)` and `splittable: D/P` lines. The `## Items` registry keeps its original five columns, then adds
`owner | repository | worktree | mode | write_set | dispatch_ref`. The [backlog audit](backlog-audit.md)
defines the required row content and evidence.

Older 8/10 wake records remain readable for historical inspection. Reading one successfully does not make it
a current audit. Do not migrate or rewrite old wake sections merely to satisfy current certification; only
active Items and the first newly appended wake use the current contract.

## One normalized report

Consumers that need a report should call the canonical Kit API:

```js
import { inspectHeartbeatLedger } from './src/supervision/heartbeat-ledger-api.mjs';

const report = inspectHeartbeatLedger(markdown, {
  mode: 'current',
  latest: true,
  ledgerPath: '/path/to/heartbeat.md',
});
```

The result has `schemaVersion: 1`, `mode`, `contract`, `certifiesCurrent`, `passed`, `wakeCount`, `itemCount`,
`wakes`, `items`, `tables`, and normalized `findings` (`severity` is `error` or `advisory`). Modes are:

- `current`: strictly audits the latest `heartbeat/v2` wake and the current Items registry.
- `history`: reads the legacy wake history, optionally limited with `latest: true`; it is always
  non-certifying.
- `items`: inventories/checks the Items registry without certifying a current wake.

`passed` means this selected mode produced no error findings. It does **not** mean the call certifies current
heartbeat state. Check `certifiesCurrent`, which is true only for a clean `current` report. Neither a history
read nor an Items inventory is current certification. The API's `wakes`, `items`, and `tables` expose parsed
records alongside findings so callers do not need to invoke separate low-level parser functions.

Keep `check-heartbeat-ledger.mjs` parser and validator functions as Kit internals or backward-compatible
exports. New Kit consumers should use `inspectHeartbeatLedger`; do not build a local array-return alias,
checker wrapper, or duplicate policy guard. A consuming project should provide a thin adapter that re-exports
the canonical API and any native helpers it needs. This keeps one report schema and one source of current
format validation.

## CLI modes

The checker CLI defaults to strict current mode. Use `--latest` for the same current audit explicitly:

```sh
node .vibe-coding/kit/src/supervision/check-heartbeat-ledger.mjs <ledger> --json
node .vibe-coding/kit/src/supervision/check-heartbeat-ledger.mjs <ledger> --latest --json
```

For a legacy read, choose `--history`; add `--latest` to inspect only its latest historical wake. History mode
always exits nonzero and is marked non-certifying, even if the old data is readable without findings. `--latest
--legacy` remains a deprecated compatibility alias for `--history --latest` and also exits nonzero. Use
`--items --json` for an Items-only inventory; it does not certify a heartbeat. JSON output uses the same
normalized report shape as the API, with `certifiesCurrent: false` for every historical or inventory-only
mode.

## Evidence and authority

Dispatch acceptance proves only that a dispatch request was accepted. It is not evidence that work is active,
has a private final report, or has landed. Record and audit those states separately. A current-format
certification only describes the checked ledger content; it grants no permission, deployment authority,
merge/finish permission, cleanup authority, or veto over ending work. Project authorization rules still
govern every action.
