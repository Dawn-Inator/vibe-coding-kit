# Heartbeat ledger format and API

New audits use `heartbeat/v2`. Preserve every existing wake byte; append a new wake with the historical
`## <ISO time> wake (10-row ledger)` heading, then a standalone `contract: heartbeat/v2` line. Keep the ten
category rows and `sources:` line. The v2 wake adds a `### Decomposition` table and standalone `re-split:
rows(...)` and `splittable: D/P` lines. The `## Items` registry keeps its original five columns, then adds
`owner | repository | worktree | mode | write_set | dispatch_ref`. The [backlog audit](backlog-audit.md)
defines the required row content and evidence.

The optional `children` column is only for parent coordination. A parent row is `status: tracking` with a
nonempty array of unique existing Item IDs, read-only metadata (`write_set: []`), and no accepted dispatch receipt
(`dispatch_ref` empty or `-`). It is not an active worker. A leaf row is `status: dispatched` and requires its
real accepted receipt and accurate write scope. Keep both roles in the same Items registry.

Older 8/10 wake records remain readable for historical inspection. Reading one successfully does not make it
a current audit. Do not migrate or rewrite old wake sections merely to satisfy current certification; only
active Items and the first newly appended wake use the current contract.

On adoption or resume, reconcile every active Item individually against its raw accepted dispatch, private
final report, and landing evidence. Record transitions that cannot be established as `unknown`; blank owner
metadata in legacy rows is not completion evidence. Never bulk-mark historical dispatched rows done, expand
their accepted scope, or reclassify ordinary delegable work as an owner-domain decision. Keep actual status
(accepted, active, final, landed, blocked) separate from acceptance criteria.

In v2, each assessed row uses one of three verdict classes: `split->dispatched <new unit>`,
`cannot-split: <tagged proof>`, or a typed `continuing` verdict: `active <source-ref>` or
`private-final <source-ref>` for a leaf, and `tracking <source-ref>` for a parent coordinator. Parent tracking
cites current child-state evidence and is not active leaf work. Use non-placeholder references to current raw
probe/tool results or private finals. Leaf acceptance alone is not activity evidence. The orchestrator resolves
and cross-checks references against original tool evidence; the checker validates only verdict kind and nonempty
reference, not authenticity. Do not create separate child or activity-receipt registries. IDs must be real Item
or wake-cell IDs. `D` counts new dispatches; `P` counts all valid assessed rows, including parent tracking. When no
additional split assessment is needed, `rows()` and `0/0` remain valid if Decomposition lists every unfinished
Item; do not force redispatch. A wake's contract marker, not the CLI read mode, selects denominator semantics:
unmarked legacy 8/10 wakes keep the proof-only denominator, while `heartbeat/v2` uses all valid assessed rows
even under non-certifying `--history`. Do not rewrite historical wakes. If the latest current audit is red,
append a corrective audit and claim
certification only when the normalized report has `certifiesCurrent: true`. A red audit does not block separately
authorized business work or ending the session.

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

## Audit due probe

For event-anchored cadence checks, use the read-only helper from the canonical API:

```js
import { heartbeatAuditDue } from './src/supervision/heartbeat-ledger-api.mjs';

const result = heartbeatAuditDue(markdown, {
  now: new Date(),
  intervalMinutes: 20,
});
```

The normalized result includes `due`, `lastAuditAt`, `nextDueAt`, `reason`, `intervalMinutes`, and
`schemaVersion`; `line` identifies the source wake when available. The CLI is:

```sh
node .vibe-coding/kit/src/supervision/heartbeat-audit-due-cli.mjs <ledger> [--minutes 20 --json]
```

Use `--json` and its `due` field; both valid `due: true` and `due: false` results exit zero. Invalid arguments,
invalid values, or unreadable ledgers exit nonzero. `--now <ISO>` is available for deterministic inspection.
The latest complete ten-row wake sets cadence even if its v2 audit is red; this records an audit attempt and
does not certify the ledger. A newer partial wake does not reset cadence. The probe schedules nothing and
grants no timer, hook, or other wake capability.

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
