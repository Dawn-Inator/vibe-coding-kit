import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, registerTempDir } from '../support/temp-dirs.mjs';
import { heartbeatAuditDue, inspectHeartbeatLedger } from '../../src/supervision/heartbeat-ledger-api.mjs';

after(cleanupTempDirs);

const CLI = fileURLToPath(new URL('../../src/supervision/heartbeat-audit-due-cli.mjs', import.meta.url));
const NOW = new Date('2026-01-01T10:30:00.000Z');

function fullWake(heading = '2026-01-01T10:10Z', { contract = false } = {}) {
  return [
    `## ${heading} wake (10-row ledger)`,
    ...(contract ? ['contract: heartbeat/v2'] : []),
    '| # | category | state |',
    '| --- | --- | --- |',
    ...Array.from({ length: 10 }, (_, index) => `| ${index + 1} | category ${index + 1} | done -- \`audit ${index + 1}\` |`),
    '',
  ].join('\n');
}

function partialWake(heading = '2026-01-01T10:29Z') {
  return [
    `## ${heading} wake (10-row ledger)`,
    '| # | category | state |',
    '| --- | --- | --- |',
    '| 1 | category 1 | done -- `partial` |',
    '| 2 | category 2 | done -- `partial` |',
    '',
  ].join('\n');
}

function fixture(text) {
  const dir = registerTempDir(mkdtempSync(join(tmpdir(), 'heartbeat-audit-due-')));
  const path = join(dir, 'heartbeat.md');
  writeFileSync(path, text);
  return { dir, path, original: readFileSync(path, 'utf8') };
}

function runCli(path, ...args) {
  return spawnSync(process.execPath, [CLI, path, ...args], { encoding: 'utf8' });
}

test('cadence is due at exactly 20 minutes, but not just before; long gaps remain due', () => {
  const ledger = fullWake();
  assert.equal(heartbeatAuditDue(ledger, { now: new Date('2026-01-01T10:29:59.999Z') }).due, false);
  assert.deepEqual(heartbeatAuditDue(ledger, { now: NOW }), {
    schemaVersion: 1,
    intervalMinutes: 20,
    due: true,
    lastAuditAt: '2026-01-01T10:10:00.000Z',
    nextDueAt: '2026-01-01T10:30:00.000Z',
    reason: 'interval-elapsed',
    line: 1,
  });
  assert.equal(heartbeatAuditDue(ledger, { now: new Date('2026-01-01T15:00:00Z') }).due, true);
});

test('legacy full ten-row wake counts as cadence attempt without certifying v2 metadata', () => {
  const report = heartbeatAuditDue(fullWake('2026-01-01T10:20Z'), { now: NOW });
  assert.equal(report.due, false);
  assert.equal(report.reason, 'interval-not-elapsed');
});

test('full ten-row detection accepts reordered unique rows and reports the real heading line', () => {
  const lines = fullWake().trimEnd().split('\n');
  const header = lines.slice(0, 3);
  const body = lines.slice(3).reverse();
  const report = heartbeatAuditDue(`preface\nsecond line\n${[...header, ...body].join('\n')}`, { now: NOW });
  assert.equal(report.due, true);
  assert.equal(report.line, 3);

  const duplicateRows = [...body];
  duplicateRows[9] = duplicateRows[8];
  const incomplete = heartbeatAuditDue(`## 2026-01-01T10:10Z wake (10-row ledger)\n| # | category | state |\n| --- | --- | --- |\n${duplicateRows.join('\n')}`, { now: NOW });
  assert.equal(incomplete.reason, 'no-full-ten-row-audit');
});

test('v2 metadata red on a full wake counts as an attempted audit', () => {
  const ledger = fullWake('2026-01-01T10:20Z', { contract: false });
  assert.equal(inspectHeartbeatLedger(ledger, { now: NOW }).certifiesCurrent, false);
  const report = heartbeatAuditDue(ledger, { now: NOW });
  assert.equal(report.due, false);
  assert.equal(report.lastAuditAt, '2026-01-01T10:20:00.000Z');
});

test('no full wake is due, and a newer partial wake does not reset cadence', () => {
  assert.equal(heartbeatAuditDue('no wake here', { now: NOW }).reason, 'no-full-ten-row-audit');
  const report = heartbeatAuditDue(`${fullWake()}\n${partialWake()}`, { now: NOW });
  assert.equal(report.due, true);
  assert.equal(report.lastAuditAt, '2026-01-01T10:10:00.000Z');
});

test('invalid and future full-wake timestamps fail closed with explicit reasons', () => {
  const invalid = heartbeatAuditDue(fullWake('not-a-time'), { now: NOW });
  assert.equal(invalid.due, true);
  assert.equal(invalid.reason, 'invalid-audit-timestamp');
  const future = heartbeatAuditDue(fullWake('2026-01-01T10:31Z'), { now: NOW });
  assert.equal(future.due, true);
  assert.equal(future.reason, 'future-audit-timestamp');
  assert.equal(future.lastAuditAt, '2026-01-01T10:31:00.000Z');
});

test('strict calendar validation rejects rollover dates and accepts leap days and offsets', () => {
  for (const heading of [
    '2026-02-30T10:20Z',
    '2026-04-31T10:20Z',
    '2026-01-01T10:20+oops',
    '2026-01-01T10:20Zjunk',
    '2026-01-01T10:20Zsuffix',
  ]) {
    const report = heartbeatAuditDue(fullWake(heading), { now: new Date('2026-05-02T10:30:00Z') });
    assert.equal(report.due, true);
    assert.equal(report.reason, 'invalid-audit-timestamp');
  }

  const leapDay = heartbeatAuditDue(fullWake('2024-02-29T10:20Z'), { now: new Date('2024-02-29T10:40:00Z') });
  assert.equal(leapDay.reason, 'interval-elapsed');
  assert.equal(leapDay.lastAuditAt, '2024-02-29T10:20:00.000Z');

  const offset = heartbeatAuditDue(fullWake('2026-01-01T05:20-05:00'), { now: new Date('2026-01-01T10:40:00Z') });
  assert.equal(offset.reason, 'interval-elapsed');
  assert.equal(offset.lastAuditAt, '2026-01-01T10:20:00.000Z');

  const compactOffset = heartbeatAuditDue(fullWake('2026-01-01T15:20+0530'), { now: new Date('2026-01-01T10:40:00Z') });
  assert.equal(compactOffset.lastAuditAt, '2026-01-01T09:50:00.000Z');

  const legacyZoneLess = heartbeatAuditDue(fullWake('2026-01-01T10:20'), { now: new Date('2026-01-01T10:40:00Z') });
  assert.equal(legacyZoneLess.lastAuditAt, '2026-01-01T10:20:00.000Z');
});

test('millisecond and fractional-offset wake timestamps use the strict ISO value as cadence time', () => {
  const producedTimestamp = new Date('2026-11-12T00:00:00.123Z').toISOString();
  const fromProducer = heartbeatAuditDue(fullWake(producedTimestamp), {
    now: new Date('2026-11-12T00:20:00.123Z'),
  });
  assert.equal(fromProducer.due, true);
  assert.equal(fromProducer.lastAuditAt, '2026-11-12T00:00:00.123Z');

  const fractionalOffset = heartbeatAuditDue(fullWake('2026-11-12T08:00:00.456+08:00'), {
    now: new Date('2026-11-12T00:20:00.456Z'),
  });
  assert.equal(fractionalOffset.due, true);
  assert.equal(fractionalOffset.lastAuditAt, '2026-11-12T00:00:00.456Z');

  const microseconds = heartbeatAuditDue(fullWake('2026-11-12T00:00:00.123456Z'), {
    now: new Date('2026-11-12T00:20:00.123Z'),
  });
  assert.equal(microseconds.due, true);
  assert.equal(microseconds.lastAuditAt, '2026-11-12T00:00:00.123Z');
});

test('invalid now and interval values throw', () => {
  assert.throws(() => heartbeatAuditDue('', { now: '2026-01-01T10:30Z' }), /now must be a valid Date/);
  assert.throws(() => heartbeatAuditDue('', { now: new Date(Number.NaN) }), /now must be a valid Date/);
  for (const intervalMinutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '20']) {
    assert.throws(() => heartbeatAuditDue('', { intervalMinutes }), /intervalMinutes/);
  }
});

test('CLI JSON matches API and neither path mutates the ledger fixture', () => {
  const { path, original } = fixture(`${fullWake()}\n${partialWake()}`);
  const expected = heartbeatAuditDue(original, { now: NOW, intervalMinutes: 20 });
  const cli = runCli(path, '--now', NOW.toISOString(), '--minutes', '20', '--json');
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(heartbeatAuditDue(original, { now: NOW }).due, true);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('CLI valid due and not-due decisions both exit zero; invalid args and IO fail', () => {
  const recent = fixture(fullWake('2026-01-01T10:20Z'));
  const old = fixture(fullWake('2026-01-01T10:00Z'));
  assert.equal(runCli(recent.path, '--now', NOW.toISOString()).status, 0);
  assert.equal(runCli(old.path, '--now', NOW.toISOString()).status, 0);
  assert.notEqual(runCli(recent.path, '--minutes', '0').status, 0);
  assert.notEqual(runCli(recent.path, '--now', '2026-02-30T10:30:00Z').status, 0);
  assert.notEqual(runCli(join(recent.dir, 'missing.md')).status, 0);
});
