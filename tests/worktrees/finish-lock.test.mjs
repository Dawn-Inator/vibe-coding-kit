// worktree-guard/finish-lock.test.mjs
//
// Coverage for finish-lock.mjs: the file-system mutex + FIFO queue used to
// serialize concurrent finish/push operations. Run with:
//   node --test finish-lock.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  finishLockPath,
  attemptAcquireFinishLockFile,
  acquireFinishLock,
  finishQueueDir,
  writeQueueTicketFile,
  listLiveQueueTickets,
  acquireFinishLockQueued,
  startFinishLockHeartbeat,
  releaseFinishLock,
  pidIsAlive,
  createHoldBudget,
  createHeldLockHandle,
  FinishLockHoldTimeoutError,
  FinishLockCancelledError,
  DEFAULT_MAX_HOLD_MS,
  describeFinishLockHolder,
  formatHoldDuration,
} from '../../src/worktrees/finish-lock.mjs';

const moduleUrl = pathToFileURL(fileURLToPath(new URL('../../src/worktrees/finish-lock.mjs', import.meta.url))).href;
const interruptionName = (signal) => process.platform === 'win32' ? `explicit ${signal} cancellation` : signal;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mkTempStateDir() {
  return mkdtempSync(join(tmpdir(), 'wtg-finish-lock-'));
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error('waitFor: condition not met within timeout');
    }
    await sleep(intervalMs);
  }
}

// Spawns a child and hard-kills it, returning a pid confirmed dead through the
// same OS process probe used by lock/ticket recovery on POSIX and Windows.
async function spawnExitedChildPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  // Small settle delay to reduce (already unlikely) pid-reuse flakiness.
  await sleep(20);
  return pid;
}

function writeQueuedChildScript(dir) {
  const scriptPath = join(dir, 'queued-child.mjs');
  const code = `
import { acquireFinishLockQueued, releaseFinishLock } from ${JSON.stringify(moduleUrl)};

const [, , stateDir, worktree, timeoutMsRaw, pollMsRaw] = process.argv;
const timeoutMs = Number(timeoutMsRaw) || undefined;
const pollMs = Number(pollMsRaw) || undefined;
const controller = new AbortController();
process.on('message', (message) => {
  if (message?.type === 'cancel') controller.abort();
});
const config = {
  queue: {
    pollIntervalMs: pollMs || 50,
    defaultMaxWaitMs: timeoutMs || 30000,
    etaMinutesPerTurn: 1,
  },
};

acquireFinishLockQueued(stateDir, { worktree, timeoutMs, pollMs, config, signal: controller.signal })
  .then((handle) => {
    console.log('ACQUIRED');
    releaseFinishLock(handle);
    process.exit(0);
  })
  .catch((err) => {
    if (err?.code === 'FINISH_LOCK_CANCELLED') {
      process.exitCode = 143;
      if (process.connected) process.disconnect();
      return;
    }
    console.error('ERROR ' + err.message);
    if (process.connected) process.disconnect();
    process.exit(1);
  });
`;
  writeFileSync(scriptPath, code);
  return scriptPath;
}

// --- 1. Two racing acquire attempts: exactly one wins -----------------

test('attemptAcquireFinishLockFile: exactly one of two racing in-process attempts succeeds', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = finishLockPath(stateDir);

    const first = attemptAcquireFinishLockFile(lockPath);
    const second = attemptAcquireFinishLockFile(lockPath);

    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'held-live');
    assert.equal(second.holderPid, process.pid);

    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(content.pid, process.pid);
    assert.equal(typeof content.acquiredAt, 'string');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('attemptAcquireFinishLockFile: exactly one of two separate OS processes wins the race', async () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = finishLockPath(stateDir);
    const scriptPath = join(stateDir, 'racer.mjs');
    // Each racer prints its answer and then STAYS ALIVE until killed. If the
    // winner exited right after acquiring, the loser could see a dead holder pid,
    // legitimately reclaim the lock, and also report "acquired" -- a race in the
    // test, not in the lock.
    writeFileSync(
      scriptPath,
      `
import { attemptAcquireFinishLockFile } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(attemptAcquireFinishLockFile(process.argv[2])) + '\\n');
setInterval(() => {}, 1000);
`
    );

    const racers = [];
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath, lockPath]);
        racers.push(child);
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('\n')) resolve(out.trim());
        });
      });

    const [outA, outB] = await Promise.all([run(), run()]);
    for (const racer of racers) racer.kill('SIGKILL');
    const resultA = JSON.parse(outA);
    const resultB = JSON.parse(outB);
    const acquiredCount = [resultA, resultB].filter((r) => r.acquired).length;

    assert.equal(acquiredCount, 1, 'exactly one racer should acquire the lock');

    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.ok(Number.isInteger(content.pid));
    assert.equal(typeof content.acquiredAt, 'string');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 2. Dead holder (kill -9) is reclaimed -----------------------------

test('a lock held by a killed (SIGKILL) process is reclaimed by the next attempt', async () => {
  const stateDir = mkTempStateDir();
  let child;
  try {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = finishLockPath(stateDir);

    child = spawn(process.execPath, [
      '-e',
      `
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        setInterval(() => {}, 1000);
      `,
    ]);

    await waitFor(() => existsSync(lockPath));
    const holderPid = child.pid;
    assert.equal(pidIsAlive(holderPid), true, 'holder should be alive before being killed');

    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    child = undefined;

    assert.equal(pidIsAlive(holderPid), false, 'pidIsAlive must report ESRCH-dead holder as dead');

    const result = attemptAcquireFinishLockFile(lockPath);
    assert.equal(result.acquired, true, 'dead holder lock must be reclaimable');

    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(content.pid, process.pid);
  } finally {
    if (child) child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 3. pidIsAlive fail-safe: only ESRCH means dead --------------------

test('pidIsAlive: only ESRCH is treated as dead, everything else (e.g. EPERM) is treated as alive', () => {
  const originalKill = process.kill;
  try {
    process.kill = () => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    };
    assert.equal(pidIsAlive(123456), true, 'EPERM must be treated as still alive (fail-safe)');

    process.kill = () => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    };
    assert.equal(pidIsAlive(123456), false, 'ESRCH must be treated as confirmed dead');

    process.kill = () => {
      throw new Error('some other unexpected error with no code');
    };
    assert.equal(pidIsAlive(123456), true, 'an error with no code must default to alive');
  } finally {
    process.kill = originalKill;
  }
});

// --- 4. Three queued callers acquire strictly FIFO ---------------------

test('acquireFinishLockQueued: three concurrent callers acquire the lock in strict FIFO order', async () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const order = [];
    const config = { queue: { pollIntervalMs: 20, defaultMaxWaitMs: 5000, etaMinutesPerTurn: 1 } };

    async function runWorker(label) {
      const handle = await acquireFinishLockQueued(stateDir, { worktree: label, config });
      order.push(label);
      // Hold briefly so an out-of-order acquire would be observable.
      await sleep(30);
      releaseFinishLock(handle);
    }

    const p1 = runWorker('a');
    await sleep(10); // stagger enqueue timestamps so FIFO order is unambiguous
    const p2 = runWorker('b');
    await sleep(10);
    const p3 = runWorker('c');

    await Promise.all([p1, p2, p3]);

    assert.deepEqual(order, ['a', 'b', 'c']);
    // Queue and lock must both be fully drained afterwards.
    assert.deepEqual(listLiveQueueTickets(finishQueueDir(stateDir)), []);
    assert.equal(existsSync(finishLockPath(stateDir)), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 5. SIGTERM while only queued cleans up the ticket ------------------

test(`acquireFinishLockQueued: ${interruptionName('SIGTERM')} while queued removes the ticket file and exits 143`, async () => {
  const stateDir = mkTempStateDir();
  let heldLock;
  let child;
  try {
    mkdirSync(stateDir, { recursive: true });
    // Hold the actual lock from this process so the child is forced to queue.
    heldLock = acquireFinishLock(stateDir);

    const scriptPath = writeQueuedChildScript(stateDir);
    child = spawn(process.execPath, [scriptPath, stateDir, 'queued-then-killed', '30000', '50'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const queueDir = finishQueueDir(stateDir);
    await waitFor(() => listLiveQueueTickets(queueDir).length === 1);

    if (process.platform === 'win32') child.send({ type: 'cancel', signal: 'SIGTERM' });
    else child.kill('SIGTERM');
    const [code] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    child = undefined;

    assert.equal(code, 143, 'SIGTERM handler must exit with code 143');
    assert.deepEqual(
      readdirSync(queueDir).filter((f) => f.endsWith('.json')),
      [],
      'ticket file must be removed on SIGTERM'
    );
  } finally {
    if (child) child.kill('SIGKILL');
    if (heldLock) releaseFinishLock(heldLock);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 5b. Signal handlers are installed before the ticket / lock is visible ---
//
// A signal that arrives after the file is visible but before a handler exists
// kills the process with Node's default action (exit status null, file left
// behind). That window is only reachable from outside the process, so rather
// than racing a signal we observe the ordering itself: the child wraps
// fs.openSync and records how many SIGTERM/SIGINT listeners exist at the exact
// moment the exclusive-create ("wx") of the ticket / lock file happens.

function writeListenerOrderChildScript(dir, body) {
  const scriptPath = join(dir, 'listener-order-child.mjs');
  const code = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const observedRelativePath = ${observedRelativePath.toString()};
const seen = [];
const realOpenSync = fs.openSync;
fs.openSync = function (path, flags, ...rest) {
  if (flags === 'wx') {
    seen.push({
      file: observedRelativePath(path),
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    });
  }
  return realOpenSync.call(this, path, flags, ...rest);
};
syncBuiltinESMExports(); // make the wrapper visible to the module's named import

const mod = await import(${JSON.stringify(moduleUrl)});
const [, , stateDir] = process.argv;
${body}
console.log('SEEN ' + JSON.stringify(seen));
process.exit(0);
`;
  writeFileSync(scriptPath, code);
  return scriptPath;
}

function observedRelativePath(value) {
  return String(value).split(/[\\/]/u).slice(-2).join('/');
}

async function runListenerOrderChild(stateDir, body) {
  const scriptPath = writeListenerOrderChildScript(stateDir, body);
  const child = spawn(process.execPath, [scriptPath, stateDir]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  assert.equal(code, 0, `child failed: ${stderr}`);
  const line = stdout.split('\n').find((l) => l.startsWith('SEEN '));
  assert.ok(line, `child did not report: ${stdout}`);
  return JSON.parse(line.slice('SEEN '.length));
}

test('acquireFinishLockQueued: SIGTERM/SIGINT handlers already exist when the ticket file is created', async () => {
  assert.equal(observedRelativePath('C:\\temp\\finish.queue\\ticket.json'), 'finish.queue/ticket.json');
  const stateDir = mkTempStateDir();
  try {
    const seen = await runListenerOrderChild(
      stateDir,
      `
const handle = await mod.acquireFinishLockQueued(stateDir, {
  worktree: 'order', timeoutMs: 5000, pollMs: 20,
  config: { queue: { pollIntervalMs: 20, defaultMaxWaitMs: 5000, etaMinutesPerTurn: 1 } },
});
mod.releaseFinishLock(handle);
`
    );
    const ticket = seen.find((entry) => entry.file.startsWith('finish.queue/'));
    assert.ok(ticket, `no ticket creation observed: ${JSON.stringify(seen)}`);
    assert.ok(ticket.sigterm >= 1, 'SIGTERM handler must exist before the ticket becomes visible');
    assert.ok(ticket.sigint >= 1, 'SIGINT handler must exist before the ticket becomes visible');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('acquireFinishLock: SIGTERM/SIGINT handlers already exist when the lock file is created', async () => {
  const stateDir = mkTempStateDir();
  try {
    const seen = await runListenerOrderChild(
      stateDir,
      `
const handle = mod.acquireFinishLock(stateDir, { worktree: 'order' });
mod.releaseFinishLock(handle);
`
    );
    const lock = seen.find((entry) => entry.file.endsWith('finish.lock'));
    assert.ok(lock, `no lock creation observed: ${JSON.stringify(seen)}`);
    assert.ok(lock.sigterm >= 1, 'SIGTERM handler must exist before the lock becomes visible');
    assert.ok(lock.sigint >= 1, 'SIGINT handler must exist before the lock becomes visible');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('acquireFinishLock: a refused acquire leaves no signal handlers and does not release the holder', () => {
  const stateDir = mkTempStateDir();
  let held;
  try {
    held = acquireFinishLock(stateDir);
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    assert.throws(() => acquireFinishLock(stateDir), /already exists/);
    assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before);
    assert.equal(existsSync(finishLockPath(stateDir)), true, 'the holder\'s lock must survive a refused acquire');
  } finally {
    if (held) releaseFinishLock(held);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an explicit AbortSignal releases a held lock and runs registered cleanup without process signals', () => {
  const stateDir = mkTempStateDir();
  const controller = new AbortController();
  const marker = join(stateDir, 'cancel-cleanup-ran');
  try {
    const handle = acquireFinishLock(stateDir, { signal: controller.signal });
    handle.addCleanup(() => writeFileSync(marker, 'cleaned'));
    assert.equal(existsSync(finishLockPath(stateDir)), true);
    controller.abort();
    assert.equal(existsSync(finishLockPath(stateDir)), false);
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned');
    handle.release();
    assert.equal(existsSync(finishLockPath(stateDir)), false, 'cancellation and release remain idempotent');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an explicit AbortSignal while queued removes its ticket and rejects with a typed cancellation', async () => {
  const stateDir = mkTempStateDir();
  let held;
  try {
    held = acquireFinishLock(stateDir);
    const controller = new AbortController();
    const queued = acquireFinishLockQueued(stateDir, {
      worktree: 'cancel-while-queued',
      pollMs: 5000,
      config: { queue: { pollIntervalMs: 5000 } },
      signal: controller.signal,
    });
    const queueDir = finishQueueDir(stateDir);
    await waitFor(() => listLiveQueueTickets(queueDir).some((ticket) => ticket.worktree === 'cancel-while-queued'));
    controller.abort();
    await assert.rejects(queued, (error) => error instanceof FinishLockCancelledError && error.code === 'FINISH_LOCK_CANCELLED');
    assert.deepEqual(listLiveQueueTickets(queueDir), []);
    assert.equal(existsSync(finishLockPath(stateDir)), true, 'cancelling a waiter never releases another process lock');
  } finally {
    if (held) releaseFinishLock(held);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 6. Timeout reports queue position and cleans up the ticket --------

test('acquireFinishLockQueued: times out with position info in the error and removes its ticket', async () => {
  const stateDir = mkTempStateDir();
  let heldLock;
  let child;
  try {
    mkdirSync(stateDir, { recursive: true });
    heldLock = acquireFinishLock(stateDir); // never released during this test -> child can't win

    const scriptPath = writeQueuedChildScript(stateDir);
    child = spawn(process.execPath, [scriptPath, stateDir, 'times-out', '200', '30']);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const [code] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    child = undefined;

    assert.equal(code, 1, 'timeout must exit non-zero');
    assert.match(stderr, /ERROR/);
    assert.match(stderr, /position 1 of 1/, 'timeout error must report queue position');

    const queueDir = finishQueueDir(stateDir);
    assert.deepEqual(
      readdirSync(queueDir).filter((f) => f.endsWith('.json')),
      [],
      'ticket file must be removed after timeout'
    );
  } finally {
    if (child) child.kill('SIGKILL');
    if (heldLock) releaseFinishLock(heldLock);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 7. listLiveQueueTickets self-cleans dead tickets -------------------

test('listLiveQueueTickets: reclaims a hard-killed holder ticket and keeps live ones in FIFO order', async () => {
  const stateDir = mkTempStateDir();
  try {
    const queueDir = finishQueueDir(stateDir);
    mkdirSync(queueDir, { recursive: true });

    const deadPid = await spawnExitedChildPid();

    writeQueueTicketFile(queueDir, {
      pid: process.pid,
      worktree: 'alive-1',
      enqueuedAt: new Date().toISOString(),
    });
    await sleep(5);
    const deadTicketPath = writeQueueTicketFile(queueDir, {
      pid: deadPid,
      worktree: 'dead',
      enqueuedAt: new Date().toISOString(),
    });
    await sleep(5);
    writeQueueTicketFile(queueDir, {
      pid: process.pid,
      worktree: 'alive-2',
      enqueuedAt: new Date().toISOString(),
    });

    assert.equal(existsSync(deadTicketPath), true, 'sanity: dead ticket exists before listing');

    const live = listLiveQueueTickets(queueDir);

    assert.deepEqual(
      live.map((t) => t.worktree),
      ['alive-1', 'alive-2']
    );
    assert.equal(existsSync(deadTicketPath), false, 'dead ticket must be deleted as a side effect');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('listLiveQueueTickets: returns an empty array for a queue dir that does not exist', () => {
  const stateDir = mkTempStateDir();
  try {
    const queueDir = finishQueueDir(stateDir); // never created
    assert.deepEqual(listLiveQueueTickets(queueDir), []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 8. Heartbeat: phase file updates, stop() cleans up -----------------

test('startFinishLockHeartbeat: setPhase updates the phase file, stop() removes it and the child exits', async () => {
  const stateDir = mkTempStateDir();
  let heartbeat;
  try {
    mkdirSync(stateDir, { recursive: true });
    const config = { queue: { heartbeatIntervalMs: 50 } };

    heartbeat = startFinishLockHeartbeat(stateDir, 'test-worktree', config);
    const phasePath = join(stateDir, 'finish-heartbeat-phase.json');

    await waitFor(() => existsSync(phasePath));
    let phase = JSON.parse(readFileSync(phasePath, 'utf8'));
    assert.equal(phase.phase, 'starting');

    heartbeat.setPhase('committing');
    phase = JSON.parse(readFileSync(phasePath, 'utf8'));
    assert.equal(phase.phase, 'committing');

    heartbeat.setPhase('pushing');
    phase = JSON.parse(readFileSync(phasePath, 'utf8'));
    assert.equal(phase.phase, 'pushing');

    heartbeat.stop();
    heartbeat = undefined;

    assert.equal(existsSync(phasePath), false, 'phase file must be removed after stop()');
  } finally {
    if (heartbeat) heartbeat.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A zombie (exited but not yet reaped by whatever adopted it) still answers kill(pid, 0),
// so treat state Z in /proc as dead where /proc exists.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}

test('startFinishLockHeartbeat: the ticker exits by itself once its finish process is SIGKILLed', async () => {
  const stateDir = mkTempStateDir();
  const scratch = mkdtempSync(join(tmpdir(), 'finish-heartbeat-orphan-'));
  let parent;
  let tickerPid;
  try {
    mkdirSync(stateDir, { recursive: true });
    const pidFile = join(scratch, 'ticker.pid');
    const scriptPath = join(scratch, 'finish-parent.mjs');
    writeFileSync(
      scriptPath,
      `
import { writeFileSync } from 'node:fs';
import { startFinishLockHeartbeat } from ${JSON.stringify(moduleUrl)};
const heartbeat = startFinishLockHeartbeat(process.argv[2], 'orphan-test', { queue: { heartbeatIntervalMs: 50 } });
writeFileSync(process.argv[3], String(heartbeat.pid));
setInterval(() => {}, 1000);
`
    );
    parent = spawn(process.execPath, [scriptPath, stateDir, pidFile], { stdio: 'ignore' });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    tickerPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pidAlive(tickerPid), 'ticker must be running while its parent is alive');

    parent.kill('SIGKILL'); // stop() never runs, exactly like a crashed finish
    await waitFor(() => !pidAlive(tickerPid), { timeoutMs: 5000 });
    assert.equal(pidAlive(tickerPid), false, 'orphaned ticker must exit on its own');
  } finally {
    if (parent && parent.exitCode === null) parent.kill('SIGKILL');
    if (tickerPid && pidAlive(tickerPid)) process.kill(tickerPid, 'SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('startFinishLockHeartbeat: the ticker exits by itself once its state dir is gone', async () => {
  const stateDir = mkTempStateDir();
  let heartbeat;
  try {
    mkdirSync(stateDir, { recursive: true });
    heartbeat = startFinishLockHeartbeat(stateDir, 'state-dir-test', { queue: { heartbeatIntervalMs: 50 } });
    const { pid } = heartbeat;
    assert.ok(pid && pidAlive(pid));

    rmSync(stateDir, { recursive: true, force: true });
    await waitFor(() => !pidAlive(pid), { timeoutMs: 5000 });
    assert.equal(pidAlive(pid), false, 'ticker must exit once the state dir is removed');
  } finally {
    if (heartbeat) heartbeat.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 9. Signals while the lock is HELD release it ------------------------

function writeHolderChildScript(dir) {
  const scriptPath = join(dir, 'holder-child.mjs');
  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'node:fs';
import { acquireFinishLock, acquireFinishLockQueued } from ${JSON.stringify(moduleUrl)};

const [, , stateDir, mode, cleanupMarker] = process.argv;
const controller = new AbortController();
let handle;
let ticker;
let cancelExitCode = 143;
process.on('message', (message) => {
  if (message?.type !== 'cancel') return;
  controller.abort();
  cancelExitCode = message.signal === 'SIGINT' ? 130 : 143;
  process.exitCode = cancelExitCode;
  if (ticker) clearInterval(ticker);
  if (process.connected) process.disconnect();
});
try {
  handle = mode === 'queued'
    ? await acquireFinishLockQueued(stateDir, { worktree: 'held-child', config: { queue: { pollIntervalMs: 20 } }, signal: controller.signal })
    : acquireFinishLock(stateDir, { worktree: 'held-child', signal: controller.signal });
} catch (error) {
  if (error?.code !== 'FINISH_LOCK_CANCELLED') throw error;
  process.exitCode = cancelExitCode;
  if (process.connected) process.disconnect();
}
if (handle) {
  if (cleanupMarker) handle.addCleanup(() => writeFileSync(cleanupMarker, 'cleaned'));
  handle.setPhase('push');
  process.stdout.write('HELD\\n');
  ticker = setInterval(() => {}, 1000); // keep the event loop turning so handlers can run
}
`
  );
  return scriptPath;
}

async function runHolderUntilSignal(signal, mode, { withCleanupMarker = false, useCancellation = process.platform === 'win32' } = {}) {
  const stateDir = mkTempStateDir();
  let child;
  try {
    mkdirSync(stateDir, { recursive: true });
    const marker = join(stateDir, 'cleanup-ran');
    const scriptPath = writeHolderChildScript(stateDir);
    child = spawn(process.execPath, [scriptPath, stateDir, mode, ...(withCleanupMarker ? [marker] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    await waitFor(() => stdout.includes('HELD'), { timeoutMs: 5000 });

    const lockPath = finishLockPath(stateDir);
    assert.equal(existsSync(lockPath), true, 'child must be holding the lock before the signal');
    const heldContent = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(heldContent.pid, child.pid);

    if (useCancellation || process.platform === 'win32') child.send({ type: 'cancel', signal });
    else child.kill(signal);
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    child = undefined;
    return {
      code,
      lockExists: existsSync(lockPath),
      tickets: existsSync(finishQueueDir(stateDir))
        ? readdirSync(finishQueueDir(stateDir)).filter((f) => f.endsWith('.json'))
        : [],
      cleanupRan: existsSync(marker),
    };
  } finally {
    if (child) child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test(`a process HOLDING the lock (no-wait path) releases it on ${interruptionName('SIGTERM')} and exits 143`, async () => {
  // Regression: only the waiting phase used to handle signals, so a finish killed
  // while holding left finish.lock behind until the next session reclaimed it.
  const result = await runHolderUntilSignal('SIGTERM', 'direct');
  assert.equal(result.code, 143);
  assert.equal(result.lockExists, false, 'SIGTERM while held must leave no lock file');
});

test(`a process HOLDING the lock (no-wait path) releases it on ${interruptionName('SIGINT')} and exits 130`, async () => {
  const result = await runHolderUntilSignal('SIGINT', 'direct');
  assert.equal(result.code, 130);
  assert.equal(result.lockExists, false);
});

test(`a process that acquired through the QUEUE also releases lock and ticket on ${interruptionName('SIGTERM')} while held`, async () => {
  const result = await runHolderUntilSignal('SIGTERM', 'queued');
  assert.equal(result.code, 143);
  assert.equal(result.lockExists, false);
  assert.deepEqual(result.tickets, []);
});

test(`cleanups registered on the handle also run when ${interruptionName('SIGTERM')} releases the lock`, async () => {
  const result = await runHolderUntilSignal('SIGTERM', 'direct', { withCleanupMarker: true });
  assert.equal(result.code, 143);
  assert.equal(result.cleanupRan, true);
});

test('explicit IPC cancellation releases direct and queued held-lock resources', async () => {
  const direct = await runHolderUntilSignal('SIGTERM', 'direct', { withCleanupMarker: true, useCancellation: true });
  assert.equal(direct.code, 143);
  assert.equal(direct.lockExists, false);
  assert.equal(direct.cleanupRan, true);

  const queued = await runHolderUntilSignal('SIGINT', 'queued', { useCancellation: true });
  assert.equal(queued.code, 130);
  assert.equal(queued.lockExists, false);
  assert.deepEqual(queued.tickets, []);
});

function writeSignalDrainChildScript(dir) {
  const scriptPath = join(dir, 'signal-drain-child.mjs');
  writeFileSync(scriptPath, `
import { existsSync } from 'node:fs';
import { acquireFinishLockQueued } from ${JSON.stringify(moduleUrl)};

const [, , stateDir, mode] = process.argv;
const lockPath = ${JSON.stringify(finishLockPath('__STATE_DIR__'))}.replace('__STATE_DIR__', stateDir);
let continueDrain;
const drain = new Promise((resolve) => { continueDrain = resolve; });
let handle;
process.on('message', (message) => {
  if (message?.type === 'signal') {
    void handle.exitFromSignal('SIGTERM');
    handle.release(); // model a caller finally block racing the async drain
  }
  if (message?.type === 'continue') continueDrain();
});
handle = await acquireFinishLockQueued(stateDir, {
  worktree: 'slow-drain',
  config: { queue: { pollIntervalMs: 10 } },
  beforeSignalReleaseTimeoutMs: mode === 'timeout' ? 60 : 5000,
  beforeSignalRelease: async () => {
    process.stdout.write('DRAIN_START ' + existsSync(lockPath) + '\\n');
    if (mode === 'failure') throw new Error('drain refused');
    if (mode === 'timeout') await new Promise(() => {});
    else await drain;
  },
});
process.stdout.write('HELD\\n');
setInterval(() => {}, 1000);
`);
  return scriptPath;
}

async function runSignalDrainScenario(mode) {
  const stateDir = mkTempStateDir();
  let child;
  try {
    const scriptPath = writeSignalDrainChildScript(stateDir);
    child = spawn(process.execPath, [scriptPath, stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const childExit = new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitFor(() => stdout.includes('HELD'), { timeoutMs: 5000 });
    child.send({ type: 'signal' });
    await waitFor(() => stdout.includes('DRAIN_START'), { timeoutMs: 5000 });
    assert.match(stdout, /DRAIN_START true/u, 'lock must remain held while the callback is running');
    if (mode === 'success') child.send({ type: 'continue' });
    const code = await childExit;
    child = undefined;
    let directReacquireError = '';
    let queuedReacquireError = '';
    if (code === 1) {
      try {
        acquireFinishLock(stateDir, { worktree: 'retry-direct' });
      } catch (error) {
        directReacquireError = error.message;
      }
      try {
        await acquireFinishLockQueued(stateDir, {
          worktree: 'retry-queued',
          timeoutMs: 1000,
          pollMs: 10,
        });
      } catch (error) {
        queuedReacquireError = error.message;
      }
    }
    return {
      code,
      lockExists: existsSync(finishLockPath(stateDir)),
      lockData: existsSync(finishLockPath(stateDir)) ? JSON.parse(readFileSync(finishLockPath(stateDir), 'utf8')) : null,
      directReacquireError,
      queuedReacquireError,
      stdout,
      stderr,
    };
  } finally {
    if (child) child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('held-lock signal waits for async cleanup before releasing the lock and exiting', async () => {
  const result = await runSignalDrainScenario('success');
  assert.equal(result.code, 143);
  assert.equal(result.lockExists, false);
  assert.match(result.stdout, /DRAIN_START true/u);
});

test('held-lock signal fails closed when async cleanup rejects or times out', async () => {
  for (const mode of ['failure', 'timeout']) {
    const result = await runSignalDrainScenario(mode);
    assert.equal(result.code, 1, `${mode}: cleanup failure must exit unsuccessfully`);
    assert.equal(result.lockExists, true, `${mode}: the lock must remain as a recovery barrier`);
    assert.equal(result.lockData.recoveryRequired, true, `${mode}: recovery state must survive holder exit`);
    assert.match(result.directReacquireError, /explicit recovery/u);
    assert.match(result.queuedReacquireError, /explicit recovery/u);
    assert.match(result.stderr, mode === 'failure' ? /drain refused/u : /timed out/u);
  }
});

test('release(): removes the signal handlers it installed, is idempotent, and tolerates a vanished lock file', () => {
  const stateDir = mkTempStateDir();
  try {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const handle = acquireFinishLock(stateDir);
    assert.equal(process.listenerCount('SIGINT'), before[0] + 1);
    assert.equal(process.listenerCount('SIGTERM'), before[1] + 1);

    rmSync(finishLockPath(stateDir), { force: true }); // someone cleaned it up already
    handle.release();
    handle.release();
    assert.equal(process.listenerCount('SIGINT'), before[0]);
    assert.equal(process.listenerCount('SIGTERM'), before[1]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('release() never deletes a lock that now belongs to another live process', async () => {
  const stateDir = mkTempStateDir();
  try {
    const handle = acquireFinishLock(stateDir);
    // Simulate: we were wrongly judged dead and another process took over.
    const lockPath = finishLockPath(stateDir);
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, acquiredAt: new Date().toISOString() }));
    handle.release();
    assert.equal(existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.ppid);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('exitFromSignal: releases first, then exits 130 for SIGINT and 143 for SIGTERM', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = finishLockPath(stateDir);
    const exits = [];
    for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      assert.equal(attemptAcquireFinishLockFile(path).acquired, true);
      const handle = createHeldLockHandle(path, { exit: (code) => exits.push([code, existsSync(path)]) });
      handle.exitFromSignal(signal);
      assert.deepEqual(exits.at(-1), [expected, false], 'lock must already be gone when exit is called');
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- 10. Hold budget -----------------------------------------------------

test('createHoldBudget: counts down against an injected clock and never goes negative', () => {
  let t = 1_000;
  const budget = createHoldBudget(5_000, () => t);
  assert.equal(budget.remainingMs(), 5_000);
  assert.equal(budget.expired(), false);
  t += 4_999;
  assert.equal(budget.remainingMs(), 1);
  assert.equal(budget.expired(), false);
  t += 1;
  assert.equal(budget.expired(), true);
  t += 100_000;
  assert.equal(budget.remainingMs(), 0);
});

test('the handle exposes the hold budget; default is 10 minutes and config.queue.maxHoldMs overrides it', () => {
  const stateDir = mkTempStateDir();
  try {
    assert.equal(DEFAULT_MAX_HOLD_MS, 10 * 60 * 1000);
    const dflt = acquireFinishLock(stateDir);
    assert.equal(dflt.maxHoldMs, DEFAULT_MAX_HOLD_MS);
    assert.ok(dflt.remainingHoldMs() > DEFAULT_MAX_HOLD_MS - 5_000);
    dflt.release();

    const custom = acquireFinishLock(stateDir, { config: { queue: { maxHoldMs: 1234 } } });
    assert.equal(custom.maxHoldMs, 1234);
    custom.release();

    // A partial `queue` override (no maxHoldMs) or nonsense falls back to the default.
    const partial = acquireFinishLock(stateDir, { config: { queue: { pollIntervalMs: 5 } } });
    assert.equal(partial.maxHoldMs, DEFAULT_MAX_HOLD_MS);
    partial.release();
    const bad = acquireFinishLock(stateDir, { config: { queue: { maxHoldMs: -5 } } });
    assert.equal(bad.maxHoldMs, DEFAULT_MAX_HOLD_MS);
    bad.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('holdExpired() flips once the budget is spent (injected clock)', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = finishLockPath(stateDir);
    attemptAcquireFinishLockFile(path);
    let t = 0;
    const handle = createHeldLockHandle(path, { maxHoldMs: 100, now: () => t });
    assert.equal(handle.holdExpired(), false);
    t = 100;
    assert.equal(handle.holdExpired(), true);
    assert.equal(handle.remainingHoldMs(), 0);
    handle.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('FinishLockHoldTimeoutError names the limit, the step, and says the lock was released', () => {
  const error = new FinishLockHoldTimeoutError(600000, 'git fetch origin');
  assert.equal(error.code, 'FINISH_LOCK_HOLD_TIMEOUT');
  assert.match(error.message, /600000ms/);
  assert.match(error.message, /git fetch origin/);
  assert.match(error.message, /lock was released/);
});

// --- 11. Lock file records holder + phase; holder status line ------------

test('the lock file records the worktree and (after setPhase) the phase, keeping pid and acquiredAt', () => {
  const stateDir = mkTempStateDir();
  try {
    const handle = acquireFinishLock(stateDir, { worktree: 'claude/feature-x' });
    const path = finishLockPath(stateDir);
    let data = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.equal(data.worktree, 'claude/feature-x');
    assert.equal(typeof data.acquiredAt, 'string');
    assert.equal(data.phase, undefined);

    handle.setPhase('rebase');
    data = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(data.phase, 'rebase');
    assert.equal(data.worktree, 'claude/feature-x');
    assert.equal(data.pid, process.pid);
    assert.equal(typeof data.phaseSince, 'string');
    assert.equal(readdirSync(stateDir).some((f) => f.endsWith('.tmp')), false, 'no temp file left behind');
    handle.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('backward compatible: attemptAcquireFinishLockFile(path) still writes just { pid, acquiredAt }', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = finishLockPath(stateDir);
    attemptAcquireFinishLockFile(path);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['acquiredAt', 'pid']);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('formatHoldDuration: seconds, minutes+seconds, hours+minutes; never negative', () => {
  assert.equal(formatHoldDuration(-5), '0s');
  assert.equal(formatHoldDuration(42_000), '42s');
  assert.equal(formatHoldDuration(185_000), '3m05s');
  assert.equal(formatHoldDuration(3_720_000), '1h02m');
});

test('describeFinishLockHolder: names worktree, pid, phase and age', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    const acquiredAt = new Date(1_000_000).toISOString();
    writeFileSync(
      finishLockPath(stateDir),
      JSON.stringify({ pid: 4242, acquiredAt, worktree: 'claude/feature-x', phase: 'push' })
    );
    assert.equal(
      describeFinishLockHolder(stateDir, { now: () => 1_000_000 + 130_000 }),
      'finish lock held by claude/feature-x (pid 4242, phase push) for 2m10s'
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('describeFinishLockHolder: an older lock (pid + acquiredAt only) degrades to unknown, using the heartbeat phase file if present', () => {
  const stateDir = mkTempStateDir();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      finishLockPath(stateDir),
      JSON.stringify({ pid: 7, acquiredAt: new Date(0).toISOString() })
    );
    assert.equal(
      describeFinishLockHolder(stateDir, { now: () => 5_000 }),
      'finish lock held by unknown (pid 7, phase unknown) for 5s'
    );
    writeFileSync(join(stateDir, 'finish-heartbeat-phase.json'), JSON.stringify({ phase: 'rebase' }));
    assert.match(describeFinishLockHolder(stateDir, { now: () => 5_000 }), /phase rebase\)/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('describeFinishLockHolder: no lock, an unreadable lock, or one without a pid all give null (never throw)', () => {
  const stateDir = mkTempStateDir();
  try {
    assert.equal(describeFinishLockHolder(stateDir), null);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(finishLockPath(stateDir), '{not json');
    assert.equal(describeFinishLockHolder(stateDir), null);
    writeFileSync(finishLockPath(stateDir), JSON.stringify({ acquiredAt: 'x' }));
    assert.equal(describeFinishLockHolder(stateDir), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('acquireFinishLockQueued: while waiting it prints who holds the lock, in which phase, and for how long', async () => {
  const stateDir = mkTempStateDir();
  let held;
  const originalError = console.error;
  const lines = [];
  try {
    held = acquireFinishLock(stateDir, { worktree: 'claude/slow-one' });
    held.setPhase('push');
    console.error = (...args) => lines.push(args.map(String).join(' '));
    await assert.rejects(
      acquireFinishLockQueued(stateDir, {
        worktree: 'claude/impatient',
        timeoutMs: 120,
        pollMs: 20,
        config: { queue: { etaMinutesPerTurn: 1 } },
      }),
      /timed out/
    );
  } finally {
    console.error = originalError;
    if (held) held.release();
    rmSync(stateDir, { recursive: true, force: true });
  }
  const holderLine = lines.find((l) => l.includes('finish lock held by'));
  assert.ok(holderLine, `expected a holder line, got: ${JSON.stringify(lines)}`);
  assert.match(holderLine, /^\[worktree-guard\] finish lock held by claude\/slow-one \(pid \d+, phase push\) for \d+s$/);
});
