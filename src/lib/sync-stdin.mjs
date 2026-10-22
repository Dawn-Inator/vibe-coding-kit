// Synchronous stdin reader that survives non-blocking fd 0.
//
// Root cause it fixes: touching `process.stdin` (even just `.isTTY`) makes Node wrap fd 0 in a
// stream handle and flip the underlying pipe to O_NONBLOCK. A following `readFileSync(0)` then
// throws EAGAIN whenever the writer has not produced data yet (Claude hook payload pipes), and
// callers that swallowed the error silently lost the payload. The same EAGAIN happens when the
// parent hands us an already non-blocking pipe.
//
// Contract: never touches `process.stdin`; TTY / closed fd / unusable fd return '' instantly;
// regular files and /dev/null are read directly; pipes and sockets are read with a bounded wait
// that retries on EAGAIN until EOF or `timeoutMs` (Infinity = wait for EOF like a blocking read).
//
// Hook payloads are the classic victim: a Claude Code hook reads its JSON input from stdin, and a
// silently dropped payload makes the hook decide on an empty input.
import { createReadStream, fstatSync, lstatSync, readSync } from 'node:fs';
import { parse } from 'node:path';
import { isatty } from 'node:tty';

export const DEFAULT_SYNC_STDIN_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 10;
const CHUNK_BYTES = 64 * 1024;

// Node (22.x, measured 22.23.3) keeps ONE shared stat buffer for fstat/lstat/stat. fs.realpathSync -- which the CJS
// loader runs on every require() -- reads the mode of "the last stat" when it skips a path prefix it already knows is
// a real directory, and BREAKS OUT of the walk when that stale mode is a FIFO or socket. After fstat(0) on a pipe the
// buffer still says FIFO, so the next require() of a pnpm-symlinked package (node_modules/@scope/pkg -> .pnpm/...)
// returns the unresolved symlink path: the package then looks for its own dependencies next to the symlink and dies
// with `Cannot find module ...`.
// A stat of a plain directory overwrites the buffer, so the loader never sees the FIFO.
export function resetSharedStatBuffer(lstat = lstatSync) {
  try {
    lstat(parse(process.cwd()).root || '/');
  } catch {
    // best effort: an unreadable root cannot make the buffer worse
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readStdinSync({
  fd = 0,
  timeoutMs = DEFAULT_SYNC_STDIN_TIMEOUT_MS,
  encoding = 'utf8',
  deps = {},
} = {}) {
  const fstat = deps.fstat ?? fstatSync;
  const read = deps.read ?? readSync;
  const tty = deps.isatty ?? isatty;
  const sleep = deps.sleep ?? sleepMs;
  const now = deps.now ?? Date.now;

  try {
    if (tty(fd)) return '';
    const stat = fstat(fd);
    if (!stat.isFIFO() && !stat.isSocket() && !stat.isFile() && !stat.isCharacterDevice()) return '';
  } catch {
    return '';
  } finally {
    resetSharedStatBuffer(deps.lstat);
  }

  const deadline = now() + timeoutMs;
  const chunks = [];
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (;;) {
    let bytes;
    try {
      bytes = read(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === 'EAGAIN') {
        if (now() >= deadline) break;
        sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (error?.code === 'EOF') break;
      break; // unreadable fd: return what was collected (callers treat '' as "no payload")
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString(encoding);
}

/**
 * Read a late-arriving stdin payload without blocking the JavaScript event loop.
 * On Windows, anonymous pipes do not provide the same synchronous EAGAIN/read
 * behavior as Unix pipes, so callers that must wait for a writer should use this
 * stream-based form. `readStdinSync` remains useful for already-available input
 * and injected synchronous readers.
 */
export function readStdin({ fd = 0, timeoutMs = DEFAULT_SYNC_STDIN_TIMEOUT_MS, encoding = 'utf8', deps = {} } = {}) {
  const fstat = deps.fstat ?? fstatSync;
  const tty = deps.isatty ?? isatty;
  try {
    if (tty(fd)) return Promise.resolve('');
    const stat = fstat(fd);
    // Windows anonymous pipes can have an fstat mode that does not identify
    // them as any of the POSIX file types above. For fd 0, the live stdin
    // stream is the authoritative reader; a successful fstat is enough to
    // distinguish it from a closed descriptor. Keep the stricter type gate
    // for caller-supplied descriptors, where we cannot assume process.stdin.
    if (fd !== 0 && !stat.isFIFO() && !stat.isSocket() && !stat.isFile() && !stat.isCharacterDevice()) return Promise.resolve('');
  } catch {
    return Promise.resolve('');
  } finally {
    resetSharedStatBuffer(deps.lstat);
  }

  const input = fd === 0 ? process.stdin : createReadStream(null, { fd, autoClose: false });
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      if (fd !== 0) input.destroy();
      else input.pause();
      resolve(Buffer.concat(chunks).toString(encoding));
    };
    const onData = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => finish();
    const onError = () => finish();
    const timer = Number.isFinite(timeoutMs) ? setTimeout(finish, Math.max(0, timeoutMs)) : null;
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}
