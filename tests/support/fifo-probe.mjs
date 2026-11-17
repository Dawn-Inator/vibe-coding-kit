import { spawnSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';

// Real-FIFO helpers for the posix-routed end-to-end tests. A reader that wrongly opens a FIFO in blocking mode
// would hang forever, so the probe always runs in a child process under a bounded timeout: a hang becomes a
// timed-out (killed) child instead of a hung test run.
export const PROBE_TIMEOUT_MS = 15000;

export function makeFifo(path) {
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr || made.error}`);
}

// Keep a writer-less FIFO from reporting EOF-style behavior: holds the pipe open read/write, non-blocking, so the
// scenario "a writer exists but never writes" is exercised as well as "no writer at all".
export function holdFifoOpen(path) {
  const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  return () => closeSync(fd);
}

export function runProbe(source, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  return { ...result, elapsedMs: Date.now() - started, timedOut: result.error?.code === 'ETIMEDOUT' };
}
