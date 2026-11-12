import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	appendHeartbeatWake,
	heartbeatLedgerPairPaths,
	inspectHeartbeatLedgerPair,
	migrateHeartbeatLedgerPair,
	readHeartbeatLedgerPair,
	writeHeartbeatLedgerPair,
} from '../../src/supervision/heartbeat-ledger-files.mjs';
import { discoverHeartbeatLedgers } from '../../src/tasks/heartbeat-task-source.mjs';
import { readProjectHeartbeat } from '../../src/tasks/project-heartbeat.mjs';
import { atomicWriteFileSync } from '../../src/tasks/task-io.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const wake = (time, extra = '') => `## ${time} wake (10-row ledger)\nsources: x(ok)\n${extra}`;
const root = () => mkdtempTracked('heartbeat-pair-');
const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '../../src/supervision/check-heartbeat-ledger.mjs');
const DUE = join(HERE, '../../src/supervision/heartbeat-audit-due-cli.mjs');

test('migration preserves every original byte in immutable backup and retains wake count/order', () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	const legacy = `# handoff notes\nprelude stays\n\n${wake('2026-01-01T10:00Z')}\n----\n${wake('2026-01-01T11:00Z')}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | active | done | receipt |\n`;
	writeFileSync(path, legacy);
	const first = migrateHeartbeatLedgerPair({ root: dir, path });
	assert.equal(readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, 'utf8'), legacy);
	assert.equal(first.isLegacy, false);
	assert.equal((first.fullText.match(/wake \(10-row ledger\)/g) ?? []).length, 2);
	assert.deepEqual(migrateHeartbeatLedgerPair({ root: dir, path }), first);
	assert.equal(readFileSync(path, 'utf8').includes('prelude stays'), true);
	assert.equal(readFileSync(path, 'utf8').includes('| I1 |'), true);
});

test('migration preserves head permissions, restricts new archive files, and failed atomic publish leaves old bytes', () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	writeFileSync(path, wake('2026-01-01T10:00Z'));
	chmodSync(path, 0o640);
	const paths = heartbeatLedgerPairPaths(path);
	migrateHeartbeatLedgerPair({ root: dir, path });
	assert.equal(statSync(path).mode & 0o777, 0o640);
	assert.equal(statSync(paths.legacyBackupPath).mode & 0o777, 0o600);
	assert.equal(statSync(paths.historyPath).mode & 0o777, 0o600);
	const before = readFileSync(path, 'utf8');
	assert.throws(() => atomicWriteFileSync(path, 'partial replacement', { mode: 0o640, beforeRename() { throw new Error('injected publish failure'); } }), /injected publish failure/);
	assert.equal(readFileSync(path, 'utf8'), before);
	assert.equal(statSync(path).mode & 0o777, 0o640);
});

test('same-folder custom heads receive isolated companion histories', () => {
	const dir = root();
	const a = join(dir, 'A.md');
	const b = join(dir, 'B.md');
	writeFileSync(a, wake('2026-01-01T10:00Z'));
	writeFileSync(b, wake('2026-01-01T11:00Z'));
	const first = migrateHeartbeatLedgerPair({ root: dir, path: a });
	const second = migrateHeartbeatLedgerPair({ root: dir, path: b });
	assert.equal(first.historyPath, join(realpathSync(dir), 'A.taskhistory.md'));
	assert.equal(second.historyPath, join(realpathSync(dir), 'B.taskhistory.md'));
	assert.notEqual(first.historyPath, second.historyPath);
});

test('identical legitimate wakes remain distinct and writer keeps all history plus current Items', () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	const repeated = wake('2026-01-01T10:00Z');
	writeFileSync(path, `${repeated}\n----\n${repeated}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n`);
	let pair = migrateHeartbeatLedgerPair({ root: dir, path });
	assert.equal((pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length, 2);
	pair = appendHeartbeatWake({ root: dir, path, wakeText: wake('2026-01-01T12:00Z') });
	assert.equal((pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length, 3);
	assert.match(pair.headText, /\| I1 \|/);
	assert.equal(inspectHeartbeatLedgerPair(pair, { mode: 'items' }).itemCount, 1);
	const rewritten = writeHeartbeatLedgerPair({ root: dir, path, text: `${wake('2026-01-01T13:00Z')}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I2 | report:r2 | next | done | receipt |\n` });
	assert.equal((rewritten.fullText.match(/wake \(10-row ledger\)/g) ?? []).length, 4);
	assert.equal(inspectHeartbeatLedgerPair(rewritten, { mode: 'items' }).items[0].id, 'I2');
});

test('missing, unrelated, corrupt, and interrupted companions never return empty history', () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	writeFileSync(path, wake('2026-01-01T10:00Z'));
	assert.equal(readHeartbeatLedgerPair({ root: dir, path }).isLegacy, true);
	const paths = heartbeatLedgerPairPaths(path);
	writeFileSync(paths.historyPath, 'unrelated');
	assert.throws(() => readHeartbeatLedgerPair({ root: dir, path }), /format|unrelated/i);
	assert.throws(() => migrateHeartbeatLedgerPair({ root: dir, path }), /overwrite|unrelated/i);
	const canonicalPath = realpathSync(path);
	writeFileSync(paths.historyPath, `<!-- heartbeat-history:v1 source=${encodeURIComponent(canonicalPath)} -->\n${readFileSync(path, 'utf8')}`);
	assert.throws(() => readHeartbeatLedgerPair({ root: dir, path }), /backup|incomplete/i);
	assert.throws(() => migrateHeartbeatLedgerPair({ root: dir, path }), /backup|incomplete/i);
	// Restore the history-first crash window to the documented recovery condition.
	writeFileSync(paths.legacyBackupPath, readFileSync(path, 'utf8'));
	const recovered = migrateHeartbeatLedgerPair({ root: dir, path });
	assert.equal(recovered.isLegacy, false);
	assert.ok(recovered.fullText.includes('2026-01-01T10:00Z'));
	unlinkSync(paths.historyPath);
	assert.throws(() => readHeartbeatLedgerPair({ root: dir, path }), /missing history companion/i);
	assert.throws(() => migrateHeartbeatLedgerPair({ root: dir, path }), /missing history companion/i);
});

test('history changes invalidate project heartbeat hash and discovery excludes companions', async () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	writeFileSync(path, wake('2026-01-01T10:00Z'));
	const legacyView = await readProjectHeartbeat({ root: dir, ledgerPath: path, now: new Date('2026-01-01T12:00Z') });
	const pair = migrateHeartbeatLedgerPair({ root: dir, path });
	const view = await readProjectHeartbeat({ root: dir, ledgerPath: path, now: new Date('2026-01-01T12:00Z') });
	assert.equal(view.source.historyPath, pair.historyPath);
	assert.notEqual(view.source.contentHash, legacyView.source.contentHash);
	assert.equal(view.source.history.wakes[0].sourcePath, pair.historyPath);
	writeFileSync(`${path}.tmp-partial`, wake('2026-01-01T11:00Z'));
	const discovered = await discoverHeartbeatLedgers({ root: dir });
	assert.deepEqual(discovered.map((entry) => entry.path), [realpathSync(path)]);
	assert.equal(existsSync(pair.historyPath), true);
});

test('legacy manual appends remain logically visible exactly once after a pair exists', () => {
	const dir = root();
	const path = join(dir, 'heartbeat.md');
	const repeatedWake = wake('2026-01-01T10:00Z', '| 1 | goal-derived remaining work | (1a) done -- `x`; (1b) done -- `y` |\n');
	writeFileSync(path, `${repeatedWake}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n`);
	migrateHeartbeatLedgerPair({ root: dir, path });
	const oldHead = readFileSync(path, 'utf8');
	writeFileSync(path, `${oldHead}\n----\n${repeatedWake}`);
	const pair = readHeartbeatLedgerPair({ root: dir, path });
	assert.equal((pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length, 2);
	const report = inspectHeartbeatLedgerPair(pair, { mode: 'history', latest: false });
	assert.equal(report.wakes.length, 2);
	assert.deepEqual(report.wakes.map((entry) => entry.sourcePath), [heartbeatLedgerPairPaths(realpathSync(path)).historyPath, realpathSync(path)]);
	assert.deepEqual(report.wakes.map((entry) => entry.rows[0].sourcePath), [heartbeatLedgerPairPaths(realpathSync(path)).historyPath, realpathSync(path)]);
	assert.deepEqual(report.wakes.map((entry) => entry.line), report.wakes.map((entry) => entry.sourceLine));
	assert.deepEqual(report.wakes.map((entry) => entry.rows[0].line), report.wakes.map((entry) => entry.rows[0].sourceLine));
});

test('paired CLIs accept an absolute historical path outside cwd and canonical aliases', () => {
	const dir = root();
	const cwd = root();
	const path = join(dir, 'custom.md');
	writeFileSync(path, `${wake('2026-01-01T10:00Z')}\n${wake('2026-01-01T11:00Z')}`);
	const legacyCheck = spawnSync(process.execPath, [CHECKER, path, '--history', '--json'], { cwd, encoding: 'utf8' });
	assert.equal(legacyCheck.status, 1, legacyCheck.stderr);
	assert.doesNotMatch(legacyCheck.stderr, /outside|cannot read/i);
	migrateHeartbeatLedgerPair({ root: dir, path });
	const checked = spawnSync(process.execPath, [CHECKER, path, '--history', '--json'], { cwd, encoding: 'utf8' });
	assert.equal(checked.status, 1, checked.stderr);
	const checkedJson = JSON.parse(checked.stdout);
	assert.ok(checkedJson.wakes.some((entry) => entry.sourcePath.endsWith('custom.taskhistory.md')));
	const due = spawnSync(process.execPath, [DUE, path, '--now', '2026-01-01T12:00:00Z', '--json'], { cwd, encoding: 'utf8' });
	assert.equal(due.status, 0, due.stderr);
	assert.match(due.stdout, /"due":/);
});
