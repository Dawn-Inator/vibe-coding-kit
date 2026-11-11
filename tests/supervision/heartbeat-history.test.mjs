import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CATEGORIES, checkItems, checkLedger, parseWakes } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { checkHeartbeatV2 } from '../../src/supervision/heartbeat-ledger-v2.mjs';

const errorsOf = (findings) => findings.filter((finding) => finding.severity !== 'advisory');
const rulesOf = (findings) => errorsOf(findings).map((finding) => finding.rule);

const LEGACY_CATEGORIES = [
  'review',
  'history/handoff',
  'tooling fixes',
  'release prep',
  'worker follow-ups',
  'centralized verification',
  'session hygiene',
  'per-stage drift',
];

function oldEightWake(time, overrides = {}) {
  const defaults = {
    1: 'empty — `git log a..b` = 0',
    2: 'empty — `find handoffs` = none',
    3: 'empty — `git status --short` = clean',
    4: 'empty — `git log release..HEAD` = 0',
    5: 'empty — `worker report scan` = none',
    6: 'empty — `gate status` = idle',
    7: 'empty — `git worktree list` = 3 entries, all in use',
    8: 'empty — `git log dev..prod` = 0',
    ...overrides,
  };
  const rows = LEGACY_CATEGORIES.map((category, index) => {
    const number = index + 1;
    return `| ${number} | ${category} | ${defaults[number]} |`;
  });
  return [
    `## ${time} wake (8-row ledger)`,
    '| # | category | state |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function tenRowWake(time, overrides = {}, marker = 'contract: heartbeat/v2') {
  const rows = CATEGORIES.map((category, index) => {
    const number = index + 1;
    const defaultState = number === 1
      ? '(1a) done — `goal audit`; (1b) done — `backlog audit`'
      : number === 10
        ? 'done — `check --matrix deployable-units` current'
        : `done — \`audit row ${number}\``;
    return `| ${number} | ${category} | ${overrides[number] ?? defaultState} |`;
  });
  return [
    `## ${time} wake (10-row ledger)`,
    ...(marker ? [marker] : []),
    'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓) external-backlog(✓ 2026-01-01T10:00Z) worker-health(✓)',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...rows,
    're-split: rows()',
    'splittable: 0/0',
    '',
  ].join('\n');
}

function v2ItemsTable() {
  return [
    '## Items',
    '',
    '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
  ].join('\n');
}

function ownerRegistryRow(status) {
  return [
    '## Items',
    '',
    '| id | source | item | status | evidence |',
    '| --- | --- | --- | --- | --- |',
    `| I5 | owner:2026-09-20-decision | rotate a service credential | ${status} | - |`,
    '',
  ].join('\n');
}

test('historical OLD8 incident keeps all six wakes and its deferred-syntax regression', () => {
  const incident = Array.from({ length: 6 }, (_, index) => {
    const minute = String(index * 15).padStart(2, '0');
    return oldEightWake(`2026-09-23T02:${minute}Z`, {
      2: 'deferred to unrelated staging landing',
      4: 'deferred to dev health readback',
    });
  }).join('\n');

  const wakes = parseWakes(incident);
  assert.equal(wakes.length, 6, 'the full historical incident window remains parseable');
  assert.deepEqual(wakes.map((wake) => wake.layout.count), Array(6).fill(8));
  assert.ok(rulesOf(checkLedger(incident)).includes('deferred-syntax'));
});

test('OLD8 parser retains strict deferred syntax and repeat detection', () => {
  const first = oldEightWake('2026-09-24T11:30Z', { 2: 'deferred ← staging result ETA <=20m' });
  const second = oldEightWake('2026-09-24T11:45Z', { 2: 'deferred ← staging result ETA <=20m' });
  const findings = checkLedger(`${first}\n${second}`);

  assert.ok(rulesOf(findings).includes('deferred-repeat'));
  assert.ok(!rulesOf(findings).includes('deferred-syntax'));
});

test('OLD8 rows preserve their historical count and session-hygiene evidence', () => {
  const text = oldEightWake('2026-09-24T10:00Z');
  const wake = parseWakes(text)[0];

  assert.equal(wake.layout.count, 8);
  assert.equal(wake.rows.length, 8);
  assert.equal(rulesOf(checkLedger(text)).includes('row-count'), false);
  assert.equal(wake.layout.driftRow, 8);
  assert.equal(wake.rows[6].category, 'session hygiene');
  assert.match(wake.rows[6].state, /`git worktree list`/);
});

test('mixed OLD8 and 10-row history keeps each wake own numbering and drift row', () => {
  const old = oldEightWake('2026-09-24T10:00Z');
  const current = tenRowWake('2026-09-24T10:15Z');
  const wakes = parseWakes(`${old}\n${current}`);

  assert.deepEqual(wakes.map((wake) => wake.layout.count), [8, 10]);
  assert.deepEqual(wakes.map((wake) => wake.layout.driftRow), [8, 10]);
  assert.equal(wakes[0].rows.length, 8);
  assert.equal(wakes[0].rows[0].category, 'review');
  assert.equal(wakes[1].rows.length, 10);
  assert.equal(wakes[1].rows[1].category, CATEGORIES[1]);
});

test('current heartbeat/v2 certification rejects OLD8 history and a missing v2 marker', () => {
  const legacy = oldEightWake('2026-09-24T10:00Z');
  const legacyFindings = checkHeartbeatV2(`${legacy}\n${v2ItemsTable()}`);
  assert.ok(errorsOf(legacyFindings).length > 0, 'a historical 8-row ledger cannot certify a current wake');

  const unmarked = tenRowWake('2026-09-24T10:15Z', {}, '');
  const missingMarkerFindings = checkHeartbeatV2(`${unmarked}\n${v2ItemsTable()}`);
  assert.ok(rulesOf(missingMarkerFindings).includes('v2-contract-missing'));
});

test('review of a checker, guard, or gate landing requires a command, not a bare SHA', () => {
  const oldBareSha = oldEightWake('2026-09-24T10:00Z', {
    1: 'done — reviewed checker guard landing d8589bfe24',
  });
  const oldWithCommand = oldEightWake('2026-09-24T10:00Z', {
    1: 'done — `pnpm check:heartbeat --strict` clean on d8589bfe24 (guard landing)',
  });
  const currentBareSha = tenRowWake('2026-09-24T10:15Z', {
    2: 'done — reviewed gate landing d8589bfe24',
  });
  const currentWithCommand = tenRowWake('2026-09-24T10:15Z', {
    2: 'done — `pnpm check:heartbeat --strict` clean on d8589bfe24 (gate landing)',
  });

  assert.ok(rulesOf(checkLedger(oldBareSha)).includes('review-checker-landing-needs-command'));
  assert.ok(!rulesOf(checkLedger(oldWithCommand)).includes('review-checker-landing-needs-command'));
  assert.ok(rulesOf(checkLedger(currentBareSha)).includes('review-checker-landing-needs-command'));
  assert.ok(!rulesOf(checkLedger(currentWithCommand)).includes('review-checker-landing-needs-command'));
});

test('owner registry accepts the historical English form and an equivalent Chinese authorization proof', () => {
  // Keep the exact punctuation and proof shape from the LingoFly I5 fixture / integration oracle.
  const english = ownerRegistryRow('owner ← significant cost; checked prior-authorization.md, credential rotation is outside its scope');
  const chinese = ownerRegistryRow('owner ← 显著成本；已核对既定授权清单，本次凭证轮换不在其范围内');

  assert.deepEqual(rulesOf(checkItems(english)), []);
  assert.deepEqual(rulesOf(checkItems(chinese)), []);
});

test('owner registry distinguishes a missing hard category from a missing authorization note', () => {
  const noCategory = ownerRegistryRow('owner ← 已核对既定授权清单，但本次凭证轮换不在其范围内');
  const noAuthorizationNote = ownerRegistryRow('owner ← 安全边界');

  assert.ok(rulesOf(checkItems(noCategory)).includes('item-owner-category'));
  assert.ok(rulesOf(checkItems(noAuthorizationNote)).includes('item-owner-authorization-note'));
});
