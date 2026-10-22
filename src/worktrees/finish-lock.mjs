// worktree-guard/finish-lock.mjs
//
// File-system-only mutex + FIFO queue used to serialize concurrent
// "finish/push" operations against the same repository. No git dependency:
// every primitive here is a plain file under `stateDir` (normally
// `.git/worktree-guard-state`, see config.mjs `stateDir`).
//
// Two layers:
//   1. A single exclusive lock file (`finish.lock`), created with O_EXCL so
//      exactly one process can hold it at a time. A dead holder (verified via
//      `process.kill(pid, 0)` -> ESRCH) can be reclaimed; anything else
//      (including EPERM) is treated as "still alive" -- fail-safe, never
//      steal a lock we aren't sure is free.
//   2. An optional FIFO ticket queue (`finish.queue/`) for callers that want
//      to wait their turn instead of failing immediately when the lock is
//      held. Ticket file names are ISO-timestamp-prefixed so lexicographic
//      sort == enqueue order, with no extra coordination file needed.
//
// While the lock is HELD (not just while queued) the handle keeps three
// promises:
//   - a SIGINT/SIGTERM releases the lock and exits 130/143, so a killed finish
//     does not leave a lock behind for the next session to time out on;
//   - the lock file records who holds it and in which phase, so a waiter can
//     say "held by X, phase push, for 2m10s" instead of just "waiting";
//   - a hold budget (`queue.maxHoldMs`) that callers apply as a timeout to
//     each in-lock git call, so a hung network operation cannot park every
//     other session behind it indefinitely.
//
// Known limit: this toolkit runs git with spawnSync, which blocks the event
// loop, so a signal delivered to ONLY this process is handled between steps,
// not in the middle of one (a Ctrl-C reaches git too and ends the step at
// once). The hold budget bounds the worst case. Callers that add a slow step
// inside the lock should run it asynchronously or with a timeout of their own.
//
// Node built-ins only, zero third-party dependencies, ESM.

import {
  openSync,
  writeFileSync,
  closeSync,
  readFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * Path to the single exclusive finish-lock file.
 * @param {string} stateDir
 * @returns {string}
 */
export function finishLockPath(stateDir) {
  return join(stateDir, 'finish.lock');
}

/**
 * Whether a pid is still alive. Signal 0 only probes for existence, it never
 * actually delivers a signal.
 *
 * Fail-safe semantics are load-bearing here: only an explicit ESRCH means
 * "the process is confirmed gone, safe to reclaim its lock". Every other
 * outcome -- including EPERM (process exists but we can't signal it) --
 * must be treated as "still alive". Better to wait on a lock that might
 * belong to a dead process than to steal one that's actually still held.
 *
 * @param {number} pid
 * @returns {boolean}
 */
// eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
export function pidIsAlive(pid) {
  try {
    // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** Default upper bound on how long one finish may hold the lock. */
export const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000;

function writeNewLockFile(path, info) {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), ...info }, null, 2) + '\n'
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * Try to atomically create the finish-lock file. Never throws for "someone
 * else holds it" -- that's reported via the return value; it only throws for
 * unexpected fs errors.
 *
 * `info` (optional, e.g. `{ worktree }`) is recorded in the lock file next to
 * `pid` and `acquiredAt` so waiters can say who holds it. Readers must treat
 * every field except `pid` as optional: older lock files carry only
 * `{ pid, acquiredAt }`.
 *
 * @param {string} path
 * @param {{ worktree?: string, phase?: string }} [info]
 * @returns {{ acquired: boolean, holderPid?: number, reason?: string }}
 */
export function attemptAcquireFinishLockFile(path, info = {}) {
  try {
    writeNewLockFile(path, info);
    return { acquired: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    // Lock already exists. Read out the holder pid and decide whether it can
    // be reclaimed.
    let holderPid;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      holderPid = Number.isInteger(data.pid) && data.pid > 0 ? data.pid : undefined;
    } catch {
      // Can't parse a pid out of it -- treat conservatively as held-live,
      // don't attempt to reclaim.
    }

    // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
    if (holderPid !== undefined && !pidIsAlive(holderPid)) {
      try {
        unlinkSync(path);
        // Only retry the atomic create once; if another process wins the
        // race, report held-live rather than looping forever.
        writeNewLockFile(path, info);
        return { acquired: true };
      } catch (retryError) {
        if (retryError?.code === 'EEXIST') {
          return { acquired: false, holderPid: undefined, reason: 'held-live' };
        }
        throw retryError;
      }
    }

    return { acquired: false, holderPid, reason: 'held-live' };
  }
}

// ---------------------------------------------------------------------------
// Held-lock handle: signal safety, phase recording, hold budget
// ---------------------------------------------------------------------------

/**
 * Count down a hold budget. Pure and clock-injectable so tests need no sleeps.
 *
 * @param {number} maxHoldMs
 * @param {() => number} [now]
 * @returns {{ maxHoldMs: number, remainingMs: () => number, expired: () => boolean }}
 */
export function createHoldBudget(maxHoldMs, now = Date.now) {
  const startedAt = now();
  const remainingMs = () => Math.max(0, maxHoldMs - (now() - startedAt));
  return { maxHoldMs, remainingMs, expired: () => remainingMs() <= 0 };
}

/** Error raised when a finish exceeds its hold budget. The lock is released first. */
export class FinishLockHoldTimeoutError extends Error {
  constructor(maxHoldMs, during) {
    super(
      `finish lock hold limit of ${maxHoldMs}ms reached${during ? ` during \`${during}\`` : ''}; `
      + 'the lock was released so other sessions can proceed. Re-run finish; '
      + 'raise queue.maxHoldMs only if the step is legitimately slow.'
    );
    this.name = 'FinishLockHoldTimeoutError';
    this.code = 'FINISH_LOCK_HOLD_TIMEOUT';
  }
}

function lockOwnedByMe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * Wrap a freshly acquired lock file in a handle. Installs SIGINT/SIGTERM
 * handlers that stay in place until `release()`.
 *
 * @param {string} path lock file path
 * @param {{ maxHoldMs?: number, now?: () => number, exit?: (code: number) => void }} [options]
 *   `exit` is injectable for tests; defaults to process.exit.
 * @returns {{
 *   path: string,
 *   release: () => void,
 *   setPhase: (phase: string) => void,
 *   addCleanup: (fn: () => void) => void,
 *   remainingHoldMs: () => number,
 *   holdExpired: () => boolean,
 *   maxHoldMs: number,
 *   exitFromSignal: (signal: 'SIGINT'|'SIGTERM') => void,
 * }}
 */
export function createHeldLockHandle(path, options = {}) {
  return prepareHeldLockHandle(path, options).handle;
}

/**
 * Same as `createHeldLockHandle`, but callable BEFORE the lock file exists, so
 * the signal handlers are in place before the file becomes visible: a signal
 * that lands between "file published" and "handler installed" would otherwise
 * hit Node's default action and leave the file behind. `abandon()` drops the
 * handlers without touching the file (for an acquire that lost the race).
 */
function prepareHeldLockHandle(path, { maxHoldMs = DEFAULT_MAX_HOLD_MS, now = Date.now, exit = process.exit } = {}) {
  const budget = createHoldBudget(maxHoldMs, now);
  const cleanups = [];
  let released = false;

  const exitFromSignal = (signal) => {
    release();
    exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => exitFromSignal('SIGINT');
  const onSigterm = () => exitFromSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  function release() {
    if (released) return;
    released = true;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // A failing cleanup must not keep the lock held.
      }
    }
    // Only remove a lock that is still ours; if it was reclaimed after we
    // were judged dead, deleting it would free someone else's lock.
    if (!lockOwnedByMe(path)) return;
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function setPhase(phase) {
    if (released || !lockOwnedByMe(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ ...data, phase, phaseSince: new Date().toISOString() }, null, 2) + '\n'
      );
      renameSync(tmp, path); // atomic: the lock file never disappears or half-exists
    } catch {
      // Phase is diagnostics only; never fail a finish over it.
    }
  }

  const abandon = () => {
    released = true;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  const handle = {
    path,
    release,
    setPhase,
    addCleanup: (fn) => {
      cleanups.push(fn);
    },
    remainingHoldMs: budget.remainingMs,
    holdExpired: budget.expired,
    maxHoldMs,
    exitFromSignal,
  };
  return { handle, abandon };
}

function configuredMaxHoldMs(config, override) {
  const value = override ?? config?.queue?.maxHoldMs;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_HOLD_MS;
}

/**
 * Acquire the finish lock without queueing: succeeds immediately or throws
 * immediately (`--no-wait` semantics).
 *
 * @param {string} stateDir
 * @param {{ dryRun?: boolean, worktree?: string, config?: any, maxHoldMs?: number }} [options]
 * @returns {ReturnType<typeof createHeldLockHandle>}
 */
export function acquireFinishLock(stateDir, { dryRun, worktree, config, maxHoldMs } = {}) {
  const path = finishLockPath(stateDir);

  if (dryRun) {
    console.error(`[dry-run] would acquire finish lock at ${path}`);
    return {
      path,
      release: () => {},
      setPhase: () => {},
      addCleanup: () => {},
      remainingHoldMs: () => Infinity,
      holdExpired: () => false,
      maxHoldMs: Infinity,
      exitFromSignal: () => {},
    };
  }

  mkdirSync(stateDir, { recursive: true });
  // Handlers first, lock file second: no window where a visible lock has no
  // signal handler.
  const { handle, abandon } = prepareHeldLockHandle(path, {
    maxHoldMs: configuredMaxHoldMs(config, maxHoldMs),
  });
  let result;
  try {
    result = attemptAcquireFinishLockFile(path, { worktree });
  } catch (error) {
    abandon();
    throw error;
  }
  if (!result.acquired) {
    abandon(); // the lock is someone else's; never release() it from here
    throw new Error(`finish lock already exists at ${path}; another process is finishing`);
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Holder status (who holds the lock, doing what, for how long)
// ---------------------------------------------------------------------------

function readJsonBestEffort(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * "3m05s"-style duration. Whole seconds, never negative.
 * @param {number} ms
 * @returns {string}
 */
export function formatHoldDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * One line describing the current lock holder, or null when there is no
 * readable lock. Best-effort by construction: the holder can release between
 * our read and our print, so every missing or malformed piece degrades to
 * "unknown" (or null) and nothing here may block or fail a queued finish.
 *
 * Phase comes from the lock file; the heartbeat's phase file is the fallback
 * for a lock written by an older version.
 *
 * @param {string} stateDir
 * @param {{ now?: () => number }} [options]
 * @returns {string|null}
 */
export function describeFinishLockHolder(stateDir, { now = Date.now } = {}) {
  const lock = readJsonBestEffort(finishLockPath(stateDir));
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;

  const phase = lock.phase
    || readJsonBestEffort(join(stateDir, 'finish-heartbeat-phase.json'))?.phase
    || 'unknown';
  const acquiredMs = Date.parse(lock.acquiredAt);
  const held = Number.isFinite(acquiredMs) ? ` for ${formatHoldDuration(now() - acquiredMs)}` : '';
  return `finish lock held by ${lock.worktree || 'unknown'} (pid ${lock.pid}, phase ${phase})${held}`;
}

/**
 * Directory holding FIFO queue tickets.
 * @param {string} stateDir
 * @returns {string}
 */
export function finishQueueDir(stateDir) {
  return join(stateDir, 'finish.queue');
}

/**
 * Write a new queue ticket file. The filename is
 * `ticket-<iso-timestamp-with-":"-and-"."-replaced-by-"-">-<pid>-<random>.json`
 * so lexicographic sort of the directory listing is FIFO order -- no extra
 * counter or coordination file needed. Written with the same O_EXCL habit as
 * the lock file for consistency, even though the pid+random suffix makes a
 * real collision practically impossible.
 *
 * @param {string} queueDir
 * @param {{ pid: number, worktree?: string, enqueuedAt: string }} data
 * @returns {string} the ticket file's full path
 */
export function writeQueueTicketFile(queueDir, data) {
  mkdirSync(queueDir, { recursive: true });
  const tsSlug = data.enqueuedAt.replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  const filePath = join(queueDir, `ticket-${tsSlug}-${data.pid}-${suffix}.json`);

  const fd = openSync(filePath, 'wx');
  writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
  closeSync(fd);

  return filePath;
}

/**
 * List queue tickets belonging to processes that are still (confirmed or
 * presumed) alive, in FIFO order. As a side effect, deletes any ticket whose
 * pid is confirmed dead (ESRCH) -- so the queue self-cleans without a
 * separate cleanup command.
 *
 * @param {string} queueDir
 * @returns {Array<{ pid: number, worktree?: string, enqueuedAt: string, filePath: string }>}
 */
export function listLiveQueueTickets(queueDir) {
  if (!existsSync(queueDir)) return [];

  const files = readdirSync(queueDir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const live = [];
  for (const file of files) {
    const filePath = join(queueDir, file);
    let data;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      // Unreadable / mid-write (e.g. we raced a writer between openSync and
      // the write completing). Don't judge it either way -- skip silently.
      continue;
    }

    const pid = Number.isInteger(data.pid) && data.pid > 0 ? data.pid : undefined;
    // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
    if (pid !== undefined && !pidIsAlive(pid)) {
      try {
        unlinkSync(filePath);
      } catch {
        // Already gone (e.g. its own owner cleaned up concurrently).
      }
      continue;
    }

    live.push({ pid: data.pid, worktree: data.worktree, enqueuedAt: data.enqueuedAt, filePath });
  }

  return live;
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the finish lock, queueing (FIFO) and polling until it's this
 * process's turn or `timeoutMs` elapses. The only async function in this
 * module -- everything else is synchronous.
 *
 * @param {string} stateDir
 * @param {{ worktree?: string, timeoutMs?: number, pollMs?: number, config?: any }} [options]
 * @returns {Promise<ReturnType<typeof createHeldLockHandle>>}
 */
export async function acquireFinishLockQueued(
  stateDir,
  { worktree, timeoutMs, pollMs, config } = {}
) {
  const lockPath = finishLockPath(stateDir);
  const queueDir = finishQueueDir(stateDir);

  const effectivePollMs = pollMs ?? config?.queue?.pollIntervalMs ?? 7000;
  const effectiveTimeoutMs = timeoutMs ?? config?.queue?.defaultMaxWaitMs ?? 45 * 60 * 1000;
  const etaMinutesPerTurn = config?.queue?.etaMinutesPerTurn ?? 5;

  mkdirSync(queueDir, { recursive: true });

  // Handlers are installed BEFORE the ticket is published: a signal landing
  // between "ticket visible" and "handler installed" would hit Node's default
  // action (die from the signal, ticket left behind) instead of exiting 143/130.
  let ticketPath; // not set until the ticket is written; cleanup tolerates that
  let removed = false;

  const removeTicket = () => {
    if (removed) return;
    removed = true;
    if (ticketPath === undefined) return;
    try {
      unlinkSync(ticketPath);
    } catch {
      // Already gone.
    }
  };

  // No critical section is held while merely queued -- it's always safe to
  // drop the ticket and exit immediately on a termination signal.
  const onSignal = (signal) => {
    removeTicket();
    process.exit(signal === 'SIGINT' ? 130 : 143); // exit-drained-ok: signal exit, nothing written
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  const removeSignalHandlers = () => {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  };

  const startedAt = Date.now();

  try {
    ticketPath = writeQueueTicketFile(queueDir, {
      pid: process.pid,
      worktree,
      enqueuedAt: new Date().toISOString(),
    });

    for (;;) {
      let tickets = listLiveQueueTickets(queueDir);
      let myIndex = tickets.findIndex((ticket) => ticket.filePath === ticketPath);

      if (myIndex === -1) {
        // Shouldn't normally happen (our own ticket is always live), but
        // re-register defensively rather than spinning forever unqueued.
        ticketPath = writeQueueTicketFile(queueDir, {
          pid: process.pid,
          worktree,
          enqueuedAt: new Date().toISOString(),
        });
        removed = false;
        tickets = listLiveQueueTickets(queueDir);
        myIndex = tickets.findIndex((ticket) => ticket.filePath === ticketPath);
      }

      if (myIndex === 0) {
        const result = attemptAcquireFinishLockFile(lockPath, { worktree });
        if (result.acquired) {
          removeTicket();
          // Swap the waiting-phase handlers for held-phase ones. Both are
          // installed/removed synchronously, so there is no unhandled window.
          const handle = createHeldLockHandle(lockPath, { maxHoldMs: configuredMaxHoldMs(config) });
          removeSignalHandlers();
          return handle;
        }
        // Still held-live, possibly by a caller that acquired outside the
        // queue (--no-wait). Fall through and keep polling.
      }

      if (Date.now() - startedAt >= effectiveTimeoutMs) {
        throw new Error(
          `timed out after ${effectiveTimeoutMs}ms waiting for finish lock; ` +
            `was at position ${myIndex + 1} of ${tickets.length} in queue`
        );
      }

      console.error(
        `排在第 ${myIndex + 1} 位，前面 ${myIndex} 个，预计还要等 ~${Math.max(
          1,
          Math.round(myIndex * etaMinutesPerTurn)
        )} 分钟`
      );
      // The position line alone says nothing about how long the holder has
      // already been at it; name them.
      const holder = describeFinishLockHolder(stateDir);
      if (holder) console.error(`[worktree-guard] ${holder}`);

      await sleepAsync(effectivePollMs);
    }
  } finally {
    removeSignalHandlers();
    removeTicket();
  }
}

/**
 * Start an out-of-band heartbeat for a held finish lock. The rest of this
 * toolkit is synchronous/blocking (spawnSync everywhere), so a plain
 * setInterval in this process would never get a chance to fire while the
 * lock is held. Instead, spawn a small detached child process that polls a
 * phase file and prints status to stderr on its own schedule.
 *
 * The child is detached, so nothing reaps it when the finish process is SIGKILLed or
 * crashes before stop() runs — it would otherwise keep ticking for days. On every tick
 * it exits by itself when (a) its parent pid is gone (or it was re-parented), or (b)
 * the state dir no longer exists.
 *
 * @param {string} stateDir
 * @param {string} worktree
 * @param {any} config
 * @returns {{ pid: number | undefined, setPhase: (phase: string) => void, stop: () => void }}
 */
export function startFinishLockHeartbeat(stateDir, worktree, config) {
  mkdirSync(stateDir, { recursive: true });
  const phasePath = join(stateDir, 'finish-heartbeat-phase.json');
  const intervalMs = config?.queue?.heartbeatIntervalMs ?? 60000;
  const startedAt = Date.now();

  writeFileSync(
    phasePath,
    JSON.stringify({ phase: 'starting', since: new Date().toISOString() }, null, 2) + '\n'
  );

  const workerScript = `
    const fs = require('fs');
    const phasePath = ${JSON.stringify(phasePath)};
    const worktree = ${JSON.stringify(worktree)};
    const startedAt = ${JSON.stringify(startedAt)};
    const parentPid = ${JSON.stringify(process.pid)};
    const stateDir = ${JSON.stringify(stateDir)};
    function parentAlive() {
      try {
        process.kill(parentPid, 0);
        return process.ppid === parentPid;
      } catch (error) {
        return error.code === 'EPERM' && process.ppid === parentPid;
      }
    }
    setInterval(() => {
      if (!parentAlive() || !fs.existsSync(stateDir)) process.exit(0); // exit-drained-ok: stdio ignored
      let phase = 'unknown';
      try {
        const data = JSON.parse(fs.readFileSync(phasePath, 'utf8'));
        phase = data.phase || 'unknown';
      } catch {
        return;
      }
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      process.stderr.write('[worktree-guard] held by ' + worktree + ' for ' + elapsedSeconds + 's, phase=' + phase + '\\n');
    }, ${JSON.stringify(intervalMs)});
  `;

  const child = spawn(process.execPath, ['-e', workerScript], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return {
    pid: child.pid,
    setPhase(phase) {
      writeFileSync(
        phasePath,
        JSON.stringify({ phase, since: new Date().toISOString() }, null, 2) + '\n'
      );
    },
    stop() {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Already dead.
      }
      try {
        unlinkSync(phasePath);
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Release a previously-acquired finish lock handle.
 * @param {{ release: () => void }} handle
 */
export function releaseFinishLock(handle) {
  handle.release();
}
