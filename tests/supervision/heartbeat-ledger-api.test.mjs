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

test('orchestration metadata keeps observed zero distinct from unknown and rejects invalid and duplicate lines', async () => {
  const { parseWakes, checkLedger } = await import('../../src/supervision/check-heartbeat-ledger.mjs');
  const { projectHeartbeatOrchestration } = await import('../../src/supervision/heartbeat-ledger-api.mjs');
  const heading = '## 2026-01-01T10:00Z wake (10-row ledger)\n';
  const snapshot = { scope: 'task', before: { activeAgents: 0, observedAt: '2026-01-01T10:00:00Z', evidence: 'agents:receipt' }, after: null, blockedTasks: [], blockersEvidence: 'audit:receipt' };
  const line = `orchestration: ${JSON.stringify(snapshot)}\n`;
  assert.deepEqual(parseWakes(heading + line)[0].orchestration, snapshot);
  assert.equal(projectHeartbeatOrchestration(snapshot).requiresOwner, false);
  assert.equal(parseWakes(heading)[0].orchestration, null);
  assert.equal(projectHeartbeatOrchestration(null), null);
  for (const bad of [heading + line + line, heading + 'orchestration: {bad}\n', heading + `orchestration: ${JSON.stringify({ ...snapshot, before: { ...snapshot.before, evidence: '' } })}\n`]) {
    assert.equal(parseWakes(bad)[0].orchestration, null);
    assert.ok(checkLedger(bad).some((finding) => finding.rule === 'orchestration-metadata'));
  }
  const tasks = Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: 'task', reason: 'waiting', requiresOwner: i === 24 ? true : false }));
  const projection = projectHeartbeatOrchestration({ ...snapshot, blockedTasks: tasks });
  assert.equal(projection.blockedTasks.length, 20);
  assert.equal(projection.blockedTasks[0].id, '24');
  assert.equal(tasks[0].id, '0');
  assert.equal(projection.blockedTaskCount, 25);
  assert.equal(projection.ownerInterventionCount, 1);
  assert.equal(projection.requiresOwner, true);
  assert.equal(projection.truncated, true);
  assert.equal(projectHeartbeatOrchestration({ ...snapshot, blockedTasks: [{ ...tasks[0], requiresOwner: null }] }).requiresOwner, null);
  assert.equal(projectHeartbeatOrchestration({ ...snapshot, blockedTasks: null }).blockedTaskCount, null);
  assert.throws(() => projectHeartbeatOrchestration({ ...snapshot, blockedTasks: [tasks[0], tasks[0]] }));
  assert.throws(() => projectHeartbeatOrchestration({ ...snapshot, blockedTasks: [], blockersEvidence: null }));
  assert.throws(() => projectHeartbeatOrchestration({ ...snapshot, after: { ...snapshot.before, observedAt: '2025-12-31T23:59:59Z' } }));
  assert.equal(projectHeartbeatOrchestration({ ...snapshot, after: { ...snapshot.before, observedAt: '2026-01-01T10:00:00Z' } }).after.activeAgents, 0);
  const ordered = projectHeartbeatOrchestration({ ...snapshot, blockedTasks: [tasks[0], { ...tasks[1], requiresOwner: null }, tasks[24], { ...tasks[2], requiresOwner: null }] });
  assert.deepEqual(ordered.blockedTasks.map((task) => task.id), ['24', '1', '2', '0']);
  assert.throws(() => projectHeartbeatOrchestration({ ...snapshot, blockedTasks: Array.from({ length: 130 }, (_, i) => ({ id: String(i), title: '字'.repeat(500), reason: '字'.repeat(500), requiresOwner: false })) }));
});


test('orchestration JSON rejects duplicate keys at every nesting level', async () => {
  const { parseWakes } = await import('../../src/supervision/check-heartbeat-ledger.mjs');
  const prefix = '## 2026-01-01T10:00Z wake (10-row ledger)\norchestration: ';
  const base = '{"scope":"task","before":null,"after":null,"blockedTasks":null,"blockersEvidence":null}';
  const repeated = [
    base.replace('"blockedTasks":null', '"blockedTasks":null,"blockedTasks":[]'),
    base.replace('"blockedTasks":null', '"blockedTasks":null,"blocked\\u0054asks":[]'),
    base.replace('"blockedTasks":null', '"blockedTasks":[{"id":"1","title":"t","reason":"r","requiresOwner":true,"requiresOwner":false}]').replace('"blockersEvidence":null', '"blockersEvidence":"receipt"'),
    base.replace('"before":null', '"before":{"activeAgents":0,"activeAgents":1,"observedAt":"2026-01-01T10:00:00Z","evidence":"receipt"}'),
  ];
  for (const raw of repeated) {
    const wake = parseWakes(prefix + raw)[0];
    assert.equal(wake.orchestration, null);
    assert.equal(wake.orchestrationError, 'invalid orchestration metadata');
  }
  const valid = base.replace('"before":null,"after":null', '"before":{"activeAgents":0,"observedAt":"2026-01-01T10:00:00Z","evidence":"a"},"after":{"activeAgents":1,"observedAt":"2026-01-01T10:01:00Z","evidence":"b"}');
  assert.equal(parseWakes(prefix + valid)[0].orchestration.after.activeAgents, 1);
});
