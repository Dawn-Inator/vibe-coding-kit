// Shared temp-directory lifecycle for node:test fixtures.
//
// Root cause this exists to fix: dozens of *.test.mjs files call
// `mkdtempSync(join(tmpdir(), '<prefix>-'))` directly inside a small per-file helper
// (e.g. `fixtureRoot()`), then never remove the directory — not on the happy path, not
// on a thrown assertion, not on process kill. Repeated over many local/CI test runs
// this silently accumulates thousands of leftover directories under `$TMPDIR`.
//
// Every mkdtemp fixture used by a node:test spec should go through this module instead
// of calling `mkdtempSync` directly, so cleanup happens on all three paths a bare
// `mkdtempSync` call misses:
//   1. success path      — the file's `after(cleanupTempDirs)` hook runs.
//   2. failure path       — node:test still runs `after()` hooks when a test throws;
//                           `after()` is registered once per file, independent of which
//                           individual `test()` block failed.
//   3. signal/kill path  — `process.on('exit'|'SIGINT'|'SIGTERM', …)` is installed the
//                           first time a directory is registered, so a directory created
//                           right before the process is killed (timeout, Ctrl-C, OOM)
//                           still gets swept on the way out.
//
// Node's `node --test` isolates each test *file* into its own child process by default
// (no `--experimental-test-isolation=none` is used anywhere in this repo's runners), so
// the module-level `registry` below is safely scoped to one spec file's lifetime — it is
// never shared across concurrently running files.
//
// Escape hatch: set VIBE_CODING_KIT_KEEP_TEMP=1 to skip deletion and print the retained paths
// instead, for post-mortem inspection of a failing fixture.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registry = new Set();
let hooksInstalled = false;

function keepTemp() {
  return process.env.VIBE_CODING_KIT_KEEP_TEMP === '1';
}

function removeOne(directory) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best-effort: cleanup must never throw out of an exit/signal handler, and a
    // directory that is already gone (double cleanup) or transiently locked is not
    // worth failing the process over.
  }
}

function installExitHooksOnce() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once('exit', () => {
    cleanupTempDirs();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanupTempDirs();
      process.exit(signal === 'SIGINT' ? 130 : 143); // exit-drained-ok: signal exit, nothing written
    });
  }
}

/**
 * Register an already-created directory for cleanup and install the process-level
 * safety-net hooks (idempotent). Returns the same path for chaining.
 */
export function registerTempDir(directory) {
  registry.add(directory);
  installExitHooksOnce();
  return directory;
}

/**
 * mkdtempSync + registerTempDir in one call. This is the replacement for the
 * `fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'))` pattern duplicated across the
 * fixture-root helpers this module exists to retire.
 */
export function mkdtempTracked(prefix, baseDir = tmpdir()) {
  const directory = mkdtempSync(join(baseDir, prefix));
  return registerTempDir(directory);
}

/**
 * Remove every currently-registered temp directory and clear the registry. Safe to call
 * more than once (a no-op once the registry is empty) and safe to call from an
 * exit/signal handler. Pass VIBE_CODING_KIT_KEEP_TEMP=1 in the environment to keep the
 * directories on disk and print their paths instead of deleting them.
 */
export function cleanupTempDirs() {
  if (registry.size === 0) return;
  if (keepTemp()) {
    const kept = [...registry];
    registry.clear();
    process.stderr.write(
      `VIBE_CODING_KIT_KEEP_TEMP=1: keeping ${kept.length} temp dir(s) instead of deleting:\n${kept
        .map((directory) => `  ${directory}`)
        .join('\n')}\n`,
    );
    return;
  }
  const pending = [...registry];
  registry.clear();
  for (const directory of pending) removeOne(directory);
}
