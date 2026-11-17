// platform-gate: posix-only
// Real mkfifo end-to-end proof that bounded task-record reads never block on a FIFO. The injected-open variant
// lives in subagent-progress.test.mjs; this file is routed to POSIX hosts by its name.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { holdFifoOpen, makeFifo, PROBE_TIMEOUT_MS, runProbe } from '../support/fifo-probe.mjs';

const MODULE_URL = new URL('../../src/tasks/markdown-records.mjs', import.meta.url).href;
const PROBE = `
import { readBoundedText } from ${JSON.stringify(MODULE_URL)};
try { await readBoundedText(process.argv[1], 100); console.log('READ-OK'); }
catch (error) { console.log('REJECTED:' + error.message); }
`;

function assertRejectedWithoutBlocking(result) {
  assert.equal(result.timedOut, false, 'opening and reading a FIFO must not block');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^REJECTED:.*not a regular file/im);
  assert.ok(result.elapsedMs < PROBE_TIMEOUT_MS, `rejected within the bound (${result.elapsedMs}ms)`);
}

test('bounded read rejects a FIFO with no writer without blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-real-fifo-'));
  try {
    const path = join(root, 'pipe');
    makeFifo(path);
    assertRejectedWithoutBlocking(runProbe(PROBE, [path]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded read rejects a FIFO held open by a silent writer without blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-real-fifo-'));
  try {
    const path = join(root, 'pipe');
    makeFifo(path);
    const release = holdFifoOpen(path);
    try { assertRejectedWithoutBlocking(runProbe(PROBE, [path])); }
    finally { release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
