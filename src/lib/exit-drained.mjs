// Exit a CLI without truncating its stdout/stderr.
//
// `process.stdout.write()` is asynchronous when stdout is a pipe (spawnSync, CI capture, `| jq`).
// Calling `process.exit()` right after it tears the process down with the tail of the output still
// queued — a JSON document gets cut mid-way and the caller sees "unparseable output".
// `exitDrained(code)` waits for BOTH streams to flush, then exits with the code, so it keeps
// `process.exit()`'s "end the process even if handles linger" behaviour. It is NOT terminating: use it
// as the LAST statement of an entry point (`main().then(exitDrained)`), and `return` after it anywhere
// else. A helper that wraps it and whose callers keep running after `await` must use
// `return exitDrainedHalt(code)` instead, which never settles.

/** @param {number|undefined} code */
export function exitDrained(code) {
  const exitCode = typeof code === 'number' ? code : 0;
  process.exitCode = exitCode;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(exitCode); // exit-drained-ok: both streams just flushed
  };
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.write('', done);
    } catch {
      done(); // stream already destroyed (EPIPE reader gone): nothing left to flush
    }
  }
}

/**
 * `exitDrained` for an async helper whose callers `await` it and continue: the returned promise NEVER
 * settles, so nothing after the call runs while the streams flush; the process exits from the flush callback.
 * @param {number|undefined} code
 * @returns {Promise<never>}
 */
export function exitDrainedHalt(code) {
  exitDrained(code);
  return new Promise(() => {});
}
