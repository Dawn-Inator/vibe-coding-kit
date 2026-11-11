import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { inspectHeartbeatLedger } from '../../src/supervision/heartbeat-ledger-api.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'src', 'supervision', 'check-heartbeat-ledger.mjs');
const NOW = new Date('2026-01-01T10:30:00Z');
const NOW_TEXT = NOW.toISOString();
const REPORT_KEYS = ['schemaVersion', 'mode', 'contract', 'certifiesCurrent', 'passed', 'wakeCount', 'itemCount', 'wakes', 'items', 'tables', 'findings'];
const CLI_REPORT_KEYS = [...REPORT_KEYS, 'path'];

function currentLedger({ marker = true, omitRow = null } = {}) {
  const rows = CATEGORIES.map((category, index) => {
    const number = index + 1;
    if (number === omitRow) return null;
    const state = number === 1
      ? '(1a) done -- `goal checked`; (1b) done -- `backlog checked`'
      : number === 10
        ? 'done -- `check --matrix stage-x-unit` current'
        : `done -- \`audit row ${number}\``;
    return `| ${number} | ${category} | ${state} |`;
  }).filter(Boolean);
  return [
    '----',
    '## 2026-01-01T10:20Z wake (10-row ledger)',
    ...(marker ? ['contract: heartbeat/v2'] : []),
    'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T10:10Z) worker-health(✓)',
    '',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...rows,
    '',
    're-split: rows()',
    'splittable: 0/0',
    '',
    '### Decomposition',
    '| item | next_step | disposition | owner | evidence |',
    '| --- | --- | --- | --- | --- |',
    '',
    '## Items',
    '',
    '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
  ].join('\n');
}

const OLD8_CATEGORIES = [
  'review', 'history/handoff', 'tooling fixes', 'release prep',
  'worker follow-ups', 'centralized verification', 'session hygiene', 'per-stage drift',
];

function historicalLedger(count) {
  const categories = count === 8 ? OLD8_CATEGORIES : CATEGORIES;
  const rows = categories.map((category, index) => {
    const number = index + 1;
    const state = number === 1 && count === 10
      ? '(1a) done -- `goal checked`; (1b) done -- `backlog checked`'
      : number === count
        ? `empty -- \`git log stage-${count}..tip\` = 0; checked against deployable-unit matrix`
        : `empty -- \`git status row-${number}\` = clean`;
    return `| ${number} | ${category} | ${state} |`;
  });
  return [
    `## 2026-01-01T10:00Z wake (${count}-row ledger)`,
    'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T09:50Z) worker-health(✓)',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function writeLedger(text) {
  const cwd = mkdtempTracked('heartbeat-ledger-api-');
  const ledgerPath = join(cwd, '.workspace', 'task', 'demo', 'heartbeat.md');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, text);
  return { cwd, ledgerPath };
}

function runCli(ledgerPath, ...flags) {
  return spawnSync(process.execPath, [CLI, ledgerPath, ...flags, '--now', NOW_TEXT, '--json'], { encoding: 'utf8' });
}

test('current API returns a strict heartbeat/v2 report and CLI JSON has the same schema/severities', () => {
  const { ledgerPath } = writeLedger(currentLedger());
  const report = inspectHeartbeatLedger(currentLedger(), { mode: 'current', latest: true, now: NOW, ledgerPath });
  const cli = runCli(ledgerPath);

  assert.deepEqual(Object.keys(report).sort(), [...REPORT_KEYS].sort());
  assert.deepEqual(Object.keys(JSON.parse(cli.stdout)).sort(), [...CLI_REPORT_KEYS].sort());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, 'current');
  assert.equal(report.contract, 'heartbeat/v2');
  assert.equal(report.certifiesCurrent, true);
  assert.equal(report.passed, true);
  assert.equal(report.wakeCount, 1);
  assert.equal(report.itemCount, 0);
  assert.equal(report.tables.length, 1);
  assert.deepEqual(report.findings, []);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).findings.map((finding) => finding.severity), report.findings.map((finding) => finding.severity));
});

test('malformed current ledger is red and never certifies current work', () => {
  const text = currentLedger({ marker: false, omitRow: 8 });
  const { ledgerPath } = writeLedger(text);
  const report = inspectHeartbeatLedger(text, { mode: 'current', now: NOW, ledgerPath });
  const cli = runCli(ledgerPath);

  assert.deepEqual(Object.keys(report).sort(), [...REPORT_KEYS].sort());
  assert.deepEqual(Object.keys(JSON.parse(cli.stdout)).sort(), [...CLI_REPORT_KEYS].sort());
  assert.equal(report.mode, 'current');
  assert.equal(report.passed, false);
  assert.equal(report.certifiesCurrent, false);
  assert.ok(report.findings.some((finding) => finding.rule === 'v2-contract-missing'));
  assert.ok(report.findings.some((finding) => finding.severity === 'error'));
  assert.ok(report.findings.every((finding) => ['error', 'advisory'].includes(finding.severity)));
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).findings.map((finding) => finding.severity), report.findings.map((finding) => finding.severity));
});

test('valid OLD8 and ten-row ledgers pass history validation without certifying current work', () => {
  for (const count of [8, 10]) {
    const report = inspectHeartbeatLedger(historicalLedger(count), { mode: 'history', latest: false, now: NOW });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.mode, 'history');
    assert.equal(report.contract, null);
    assert.equal(report.passed, true, `${count}-row historical ledger should pass`);
    assert.equal(report.certifiesCurrent, false);
    assert.equal(report.wakeCount, 1);
    assert.deepEqual(Object.keys(report).sort(), [...REPORT_KEYS].sort());
    assert.equal(report.findings.length, 0);
  }
});

test('items inventory can pass but never certifies an audit', () => {
  const text = [
    '## Items',
    '',
    '| id | source | item | status | evidence |',
    '| --- | --- | --- | --- | --- |',
    '| I1 | report:w1 | verify implementation | done | `review report` confirms the result |',
    '',
  ].join('\n');
  const report = inspectHeartbeatLedger(text, { mode: 'items', now: NOW });

  assert.equal(report.mode, 'items');
  assert.equal(report.contract, null);
  assert.equal(report.passed, true);
  assert.equal(report.certifiesCurrent, false);
  assert.equal(report.wakeCount, 0);
  assert.equal(report.itemCount, 1);
  assert.equal(report.tables.length, 1);
  assert.deepEqual(Object.keys(report).sort(), [...REPORT_KEYS].sort());
});

test('unknown inspection mode and invalid time reject instead of falling through to a checker', () => {
  assert.throws(() => inspectHeartbeatLedger('', { mode: 'audit' }), /mode/i);
  assert.throws(() => inspectHeartbeatLedger(currentLedger(), { now: new Date('invalid') }), /now|date/i);
});

test('CLI history modes stay non-certifying and default current mode rejects OLD8', () => {
  const legacy = historicalLedger(8);
  const { ledgerPath } = writeLedger(legacy);
  const history = runCli(ledgerPath, '--history', '--latest');
  const legacyAlias = runCli(ledgerPath, '--latest', '--legacy');
  const strictDefault = runCli(ledgerPath);
  const ambiguous = runCli(ledgerPath, '--history', '--items');

  for (const result of [history, legacyAlias]) {
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(report.mode, 'history');
    assert.equal(report.passed, true);
    assert.equal(report.certifiesCurrent, false);
    assert.ok(!/check-heartbeat-ledger: OK/.test(result.stdout), 'history inspection must not print an audit-pass line');
  }
  const strictReport = JSON.parse(strictDefault.stdout);
  assert.equal(strictDefault.status, 1, strictDefault.stdout + strictDefault.stderr);
  assert.equal(strictReport.mode, 'current');
  assert.equal(strictReport.certifiesCurrent, false);
  assert.notEqual(ambiguous.status, 0, 'history and item inventory flags are ambiguous together');
  assert.match(ambiguous.stderr, /usage|mode|cannot|incompatible/i);
});
