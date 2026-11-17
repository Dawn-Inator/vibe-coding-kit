// platform-gate: posix-only
// Real mkfifo end-to-end proof that bounded heartbeat reads never block on a FIFO companion. The injected-fd variant
// lives in heartbeat-ledger-files.test.mjs; this file is routed to POSIX hosts by its name.
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { heartbeatLedgerPairPaths } from '../../src/supervision/heartbeat-ledger-files.mjs';
import { holdFifoOpen, makeFifo, PROBE_TIMEOUT_MS, runProbe } from '../support/fifo-probe.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const MODULE_URL = new URL('../../src/supervision/heartbeat-ledger-files.mjs', import.meta.url).href;
const PROBE = `
import { readHeartbeatLedgerPair } from ${JSON.stringify(MODULE_URL)};
const [dir, path] = process.argv.slice(1);
try { readHeartbeatLedgerPair({ root: dir, path, maxBytes: 1024 }); console.log('READ-OK'); }
catch (error) { console.log('REJECTED:' + error.message); }
`;

function fixture() {
  const dir = realpathSync(mkdtempTracked('heartbeat-fifo-'));
  const path = join(dir, 'heartbeat.md');
  writeFileSync(path, '## 2026-01-01T10:00Z wake (10-row ledger)\nsources: x(ok)\n');
  const companion = heartbeatLedgerPairPaths(path).historyPath;
  makeFifo(companion);
  return { dir, path };
}

function assertRejectedWithoutBlocking(result) {
  assert.equal(result.timedOut, false, 'opening and reading a FIFO companion must not block');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^REJECTED:.*(regular file|not a file)/im);
  assert.ok(result.elapsedMs < PROBE_TIMEOUT_MS, `rejected within the bound (${result.elapsedMs}ms)`);
}

test('a FIFO companion with no writer is rejected without blocking', () => {
  const { dir, path } = fixture();
  assertRejectedWithoutBlocking(runProbe(PROBE, [dir, path]));
});

test('a FIFO companion held open by a silent writer is rejected without blocking', () => {
  const { dir, path } = fixture();
  const release = holdFifoOpen(heartbeatLedgerPairPaths(path).historyPath);
  try { assertRejectedWithoutBlocking(runProbe(PROBE, [dir, path])); }
  finally { release(); }
});
