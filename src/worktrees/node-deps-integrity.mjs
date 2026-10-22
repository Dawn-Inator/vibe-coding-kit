// worktree-guard/node-deps-integrity.mjs
//
// A worktree's installed dependencies must match THAT worktree's lockfile, not
// whatever another checkout happened to have installed when this one was made.
//
// The failure this closes: a new worktree is cut from a base whose lockfile moved
// on, or a finish rebase pulls in a lockfile change, and the dependency directory
// silently stays at the old versions. Tests then run against the wrong
// dependencies and pass or fail for the wrong reason.
//
// Design:
//   - The fingerprint is the sha256 of the lockfile, recorded in a stamp file
//     ONLY by this module, after a successful install. Checking is one file read,
//     one hash and one tiny file read.
//   - Stamp equal to the lockfile hash: `fresh`. Missing or different: run the
//     configured install command in the worktree, re-hash the lockfile (an install
//     must not rewrite it; if it did, fail), then write the stamp.
//   - Fail closed: no usable install command, a failing install, or a lockfile
//     that changed during the install all return `failed` with the exact repair
//     command. Callers (begin, finish) refuse to continue.
//   - The stamp is replaced by write-temp + rename, never written in place: the
//     old stamp may be a hardlink shared with another checkout, and an in-place
//     write would corrupt that checkout's stamp too.
//   - Feature OFF when `nodeDeps.lockfile` is empty (the default).
//
// Node built-ins only, zero third-party dependencies, ESM.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_NODE_DEPS_STAMP_FILE = 'node_modules/.worktree-guard-lockfile-stamp';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// null means "cannot prove freshness"; every caller treats that as stale, which
// can only make the check more cautious.
function readFileOrNull(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The effective settings, with every key falling back to its default at the
 * point of use (a config override replaces a whole top-level key).
 *
 * @param {object} config
 * @returns {{lockfile: string, stampFile: string, installCommand: string}}
 */
export function resolveNodeDepsSettings(config) {
  const nodeDeps = config?.nodeDeps ?? {};
  return {
    lockfile: String(nodeDeps.lockfile ?? '').trim(),
    stampFile: String(nodeDeps.stampFile ?? '').trim() || DEFAULT_NODE_DEPS_STAMP_FILE,
    installCommand: String(nodeDeps.installCommand ?? '').trim() || String(config?.postCreateInstallCommand ?? '').trim(),
  };
}

function insideRoot(root, relativePath) {
  if (isAbsolute(relativePath)) return null;
  const full = resolve(root, relativePath);
  const rel = relative(resolve(root), full);
  return rel === '' || rel.startsWith('..') ? null : full;
}

export function lockfileSha(worktreeRoot, lockfile) {
  const full = insideRoot(worktreeRoot, lockfile);
  const buffer = full ? readFileOrNull(full) : null;
  return buffer ? sha256(buffer) : null;
}

export function readNodeDepsStamp(worktreeRoot, stampFile) {
  const full = insideRoot(worktreeRoot, stampFile);
  const buffer = full ? readFileOrNull(full) : null;
  if (!buffer) return null;
  const text = buffer.toString('utf8').trim();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

/** Atomic replace (write a temp file, then rename over the stamp). */
export function writeNodeDepsStamp(worktreeRoot, stampFile, sha) {
  const target = insideRoot(worktreeRoot, stampFile);
  if (!target) throw new Error(`nodeDeps.stampFile "${stampFile}" must be a path inside the worktree`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${sha}\n`);
  renameSync(tmp, target);
}

/**
 * Read-only freshness verdict. `fresh` only with positive evidence (the stamp
 * equals the lockfile hash).
 *
 * @param {{worktreeRoot: string, config: object}} input
 * @returns {{status: 'off'|'fresh'|'stale', reason: string, lockfileSha: string|null}}
 */
export function checkNodeDeps({ worktreeRoot, config }) {
  const { lockfile, stampFile } = resolveNodeDepsSettings(config);
  if (!lockfile) return { status: 'off', reason: 'nodeDeps.lockfile is empty', lockfileSha: null };
  const sha = lockfileSha(worktreeRoot, lockfile);
  if (!sha) return { status: 'off', reason: `lockfile ${lockfile} not found in this worktree`, lockfileSha: null };
  const stamp = readNodeDepsStamp(worktreeRoot, stampFile);
  if (stamp === sha) return { status: 'fresh', reason: 'stamp-match', lockfileSha: sha };
  return { status: 'stale', reason: stamp === null ? 'stamp-missing' : 'stamp-mismatch', lockfileSha: sha };
}

function tail(text, lines = 15) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

/**
 * Make the installed dependencies match the lockfile.
 *
 * Modes:
 *   - `install` (default): repair a stale worktree by running the install command.
 *   - `check`: never install; a stale worktree is reported as `status: 'stale'`
 *     together with the repair command (used for worker worktrees, which must not
 *     start installers).
 * `provisionIfMissing: false` leaves a worktree whose stamp directory does not
 * exist at all (dependencies were never provisioned here) alone, status `off`.
 *
 * Logs exactly one `[worktree-guard] phase=deps-integrity status=<s> ms=<n>` line.
 * Never throws for an expected failure; returns `{ status: 'failed', message }`.
 *
 * @param {{
 *   worktreeRoot: string, config: object, mode?: 'install'|'check', provisionIfMissing?: boolean,
 *   log?: (line: string) => void, spawn?: typeof spawnSync, env?: NodeJS.ProcessEnv, now?: () => number,
 * }} options
 * @returns {{status: 'off'|'fresh'|'installed'|'stale'|'failed', reason: string, ms: number,
 *   message?: string, repairCommand?: string}}
 */
export function ensureNodeDepsMatchLockfile({
  worktreeRoot,
  config,
  mode = 'install',
  provisionIfMissing = true,
  log = (line) => console.log(line),
  spawn = spawnSync,
  env = process.env,
  now = Date.now,
}) {
  const startedAt = now();
  const settings = resolveNodeDepsSettings(config);
  const done = (status, reason, extra = {}) => {
    const ms = now() - startedAt;
    log(`[worktree-guard] phase=deps-integrity status=${status} ms=${ms}`);
    return { status, reason, ms, ...extra };
  };

  const verdict = checkNodeDeps({ worktreeRoot, config });
  if (verdict.status === 'off') return done('off', verdict.reason);
  if (verdict.status === 'fresh') return done('fresh', verdict.reason);

  const stampFull = insideRoot(worktreeRoot, settings.stampFile);
  if (!provisionIfMissing && stampFull && !existsSync(dirname(stampFull))) {
    return done('off', 'dependencies were never provisioned in this worktree');
  }

  const repairCommand = settings.installCommand
    ? `cd "${worktreeRoot}" && ${settings.installCommand}   (or: worktree-guard deps-sync, run inside that worktree)`
    : `install the dependencies in "${worktreeRoot}", then run: worktree-guard deps-sync`;

  if (mode === 'check') {
    log(
      `[worktree-guard] WARN: installed dependencies do not match ${settings.lockfile} (${verdict.reason}); `
      + `this role never installs. Repair: ${repairCommand}`,
    );
    return done('stale', verdict.reason, { repairCommand });
  }

  const failure = (reason, detail, output = '') => {
    const message =
      `deps-integrity: ${detail} in ${worktreeRoot}. Installed dependencies do NOT match ${settings.lockfile}; `
      + `do not trust test results here. Repair: ${repairCommand}`
      + (output ? `\n--- install output (tail) ---\n${tail(output)}` : '');
    return done('failed', reason, { message, repairCommand });
  };

  if (!settings.installCommand) {
    return failure(
      'no-install-command',
      `dependencies are stale (${verdict.reason}) and no install command is configured `
      + '(set nodeDeps.installCommand or postCreateInstallCommand)',
    );
  }

  log(`[worktree-guard] deps-integrity: dependencies do not match ${settings.lockfile} (${verdict.reason}); running: ${settings.installCommand}`);
  // No TTY on stdin: an installer must never block on an interactive prompt.
  const result = spawn(settings.installCommand, {
    cwd: worktreeRoot,
    shell: true,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || result.status !== 0) {
    return failure(
      'install-failed',
      `the install command failed (exit ${result.status ?? 'n/a'}${result.error ? `, ${result.error.message}` : ''})`,
      output,
    );
  }
  if (lockfileSha(worktreeRoot, settings.lockfile) !== verdict.lockfileSha) {
    return failure('lockfile-modified', `the install command modified ${settings.lockfile} (it must not)`, output);
  }
  try {
    writeNodeDepsStamp(worktreeRoot, settings.stampFile, verdict.lockfileSha);
  } catch (error) {
    return failure('stamp-write-failed', `could not write the lockfile stamp (${error.message})`);
  }
  return done('installed', verdict.reason);
}
