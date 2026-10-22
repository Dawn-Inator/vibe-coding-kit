// worktree-guard/worktree-core.mjs
//
// Core business logic for the worktree-guard toolkit: repo discovery, branch
// naming, capacity checks, per-worktree metadata read/write, mass-deletion
// classification, and sync-primary precondition checks. Every function here
// is a plain unit -- no argv parsing, no process.exit, no console output --
// so the CLI layer (cli.mjs) can stay a thin wrapper that this module's
// tests never need to know about.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsModule from 'node:fs';
import { join } from 'node:path';

import { assertNoForbiddenMergeStrategy } from './forbid-auto-resolve-strategy.mjs';

// ---------------------------------------------------------------------------
// Transient-failure retry (closed set)
// ---------------------------------------------------------------------------
//
// Several AI sessions share one object store and one remote, so two kinds of
// failure are routine and clear on their own within seconds:
//   - a local ref/packed-refs lock held for a moment by someone else's git
//   - a dropped HTTPS/SSH connection during fetch or push
// Retrying those is correct. Retrying anything else is a bug: a rejected push
// (non-fast-forward), an auth failure, or a hook refusal is a real answer, and
// retrying it only delays and hides it. So the classifier below is a CLOSED
// list of known signatures, never "any non-zero exit".

const REF_LOCK_PATTERNS = [
  ['ref-lock-file-exists', /Unable to create '[^']*\.lock'/i],
  ['packed-refs-lock', /packed-refs\.lock/i],
  // "cannot lock ref 'a/b': 'a' exists; cannot create 'a/b'" is a permanent
  // directory/file ref conflict, not contention -- excluded below.
  ['cannot-lock-ref', /cannot lock ref/i],
];

const TRANSPORT_PATTERNS = [
  ['could-not-resolve-host', /Could not resolve host/i],
  ['connection-reset', /Connection reset by peer/i],
  ['connection-timed-out', /Connection timed out/i],
  ['remote-end-hung-up', /The remote end hung up unexpectedly/i],
  ['rpc-failed', /RPC failed/i],
  ['early-eof', /early EOF/i],
  ['ssl-error-syscall', /SSL_ERROR_SYSCALL/i],
];

// A message carrying any of these is a real answer from the remote or a hook,
// even if it also happens to contain a transport-looking phrase (for example
// "RPC failed; HTTP 403"). Never retried.
const HARD_FAILURE_PATTERN =
  /Authentication failed|Permission denied|could not read (?:Username|Password)|HTTP 40\d|returned error: 40\d|\[(?:remote )?rejected\]|non-fast-forward|fetch first|hook declined|pre-push hook|exists; cannot create/i;

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'push']);

// Global options that consume the next argv element as their value.
const GIT_FLAGS_WITH_SEPARATE_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace']);

/**
 * The real git subcommand of an argv, skipping leading global options such as
 * `-c user.name=x`.
 *
 * @param {string[]} args
 * @returns {string|undefined}
 */
export function gitSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (typeof arg !== 'string' || !arg.startsWith('-')) return arg;
    i += GIT_FLAGS_WITH_SEPARATE_VALUE.has(arg) ? 2 : 1;
  }
  return undefined;
}

/**
 * Name the transient class of a failed git invocation, or null when the
 * failure is not on the closed retryable list. Ref-lock signatures apply to
 * every subcommand; transport signatures only to `fetch` and `push`.
 *
 * @param {string[]} args
 * @param {string} stderr
 * @returns {string|null}
 */
export function classifyTransientGitFailure(args, stderr) {
  const text = String(stderr || '');
  if (HARD_FAILURE_PATTERN.test(text)) return null;
  for (const [name, pattern] of REF_LOCK_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  if (NETWORK_SUBCOMMANDS.has(gitSubcommand(args))) {
    for (const [name, pattern] of TRANSPORT_PATTERNS) {
      if (pattern.test(text)) return name;
    }
  }
  return null;
}

/** Total attempts per git call (1 initial + 2 retries). */
export const GIT_RETRY_MAX_ATTEMPTS = 3;
/** Wait before the 2nd and 3rd attempt. */
export const GIT_RETRY_BACKOFF_MS = Object.freeze([1000, 3000]);

function blockingSleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultRunner(args, spawnOptions) {
  return spawnSync('git', args, spawnOptions);
}

// ---------------------------------------------------------------------------
// git process wrappers
// ---------------------------------------------------------------------------

/**
 * Run `git <args>` in `cwd` and return the result without throwing, unless
 * `options.allowFailure` is explicitly `false` and the process exited
 * non-zero (in which case it throws). `allowFailure` defaults to `true` --
 * i.e. by default this never throws, and callers are expected to inspect
 * `status` themselves.
 *
 * Output is trimmed by default, which is right for single-value answers
 * (`rev-parse`, `config --get`). It is WRONG for line-oriented output whose
 * lines carry meaning in their leading characters -- `status --porcelain`
 * prints ` M path` for a file modified only in the working tree, and trimming
 * the whole blob eats that first line's leading space, so a fixed-column slice
 * then reads one character into the path. Pass `{ trim: false }` (or use
 * `gitRaw` / `gitLines`) for those callers.
 *
 * Options beyond `allowFailure` / `env`:
 *   - `trim` (default true): trim stdout/stderr.
 *   - `retry` (default true): retry known-transient failures, see
 *     `classifyTransientGitFailure`. Pass false to run exactly once.
 *   - `sleep` / `log`: injectable for tests (default: blocking sleep, stderr).
 *   - `runner`: injectable spawn function (tests only).
 *   - `timeoutMs`: kill the git process after this long. A timed-out call is
 *     never retried and is reported as `timedOut: true` (and, with
 *     `allowFailure: false`, as a thrown error that says so). Only git itself
 *     is killed: spawnSync returns once every process holding git's output
 *     pipes has exited, so a transport helper that outlives git can delay the
 *     return until it ends.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {{allowFailure?: boolean, env?: NodeJS.ProcessEnv, trim?: boolean, retry?: boolean,
 *   sleep?: (ms: number) => void, log?: (message: string) => void,
 *   runner?: (args: string[], spawnOptions: object) => any, timeoutMs?: number,
 *   [key: string]: any}} [options]
 * @returns {{status: number|null, stdout: string, stderr: string, signal: string|null,
 *   timedOut: boolean, attempts: number}}
 */
export function git(args, cwd, options = {}) {
  assertNoForbiddenMergeStrategy(args);
  const {
    allowFailure = true,
    env,
    trim = true,
    retry = true,
    sleep = blockingSleep,
    log = (message) => console.error(message),
    runner = defaultRunner,
    timeoutMs,
    ...rest
  } = options;

  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    env: env ?? process.env,
    ...rest,
  };
  if (timeoutMs !== undefined && timeoutMs > 0) {
    spawnOptions.timeout = timeoutMs;
    spawnOptions.killSignal = 'SIGTERM';
  }

  let output;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = runner(args, spawnOptions);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
    output = {
      status: result.status,
      stdout: trim ? stdout.trim() : stdout,
      stderr: trim ? stderr.trim() : stderr,
      signal: result.signal ?? null,
      timedOut,
      attempts,
    };

    if (output.status === 0 || timedOut || !retry || attempts >= GIT_RETRY_MAX_ATTEMPTS) break;
    const transientClass = classifyTransientGitFailure(args, stderr);
    if (!transientClass) break;
    const wait = GIT_RETRY_BACKOFF_MS[attempts - 1] ?? GIT_RETRY_BACKOFF_MS[GIT_RETRY_BACKOFF_MS.length - 1];
    log(
      `[worktree-guard] git ${gitSubcommand(args)} hit a transient error (${transientClass}, `
      + `attempt ${attempts}/${GIT_RETRY_MAX_ATTEMPTS}); retrying in ${wait}ms`,
    );
    sleep(wait);
  }

  if (allowFailure === false && output.status !== 0) {
    if (output.timedOut) {
      throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms and was killed`);
    }
    throw new Error(
      `git ${args.join(' ')} failed (exit ${output.status}): ${output.stderr || output.stdout}`,
    );
  }

  return output;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeGitOperations = new Set();

/** Cancel and await every Git operation owned by this process. A lock holder
 * must await this before releasing the finish lock on a signal. */
export async function settleActiveGitOperations({ reason = 'finish interrupted' } = {}) {
  const operations = [...activeGitOperations];
  const outcomes = await Promise.allSettled(operations.map((operation) => operation.cancel(reason)));
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  await Promise.all(operations.map((operation) => operation.settled));
}

function remaining(deadline) {
  return deadline === Infinity ? Infinity : Math.max(0, deadline - Date.now());
}

/** Async Git runner with one absolute time budget covering launch, all retries,
 * and backoff. Each operation is registered until its owned process container
 * is confirmed empty and its stdio is closed. */
export async function gitAsync(args, cwd, options = {}) {
  assertNoForbiddenMergeStrategy(args);
  const {
    allowFailure = true, env, trim = true, retry = true,
    log = (message) => console.error(message), timeoutMs, signal,
    ...rest
  } = options;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const startWindowsJob = process.platform === 'win32'
    ? (await import('./windows-git-job.mjs')).startWindowsJob
    : null;
  let output;
  let attempts = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error('Git operation cancelled');
    const budget = remaining(deadline);
    if (budget <= 0) {
      output = { status: null, stdout: '', stderr: '', signal: null, timedOut: true };
      break;
    }
    attempts += 1;
    const operation = { cancel: null, settled: null };
    let cleanupUnconfirmed = false;
    let resolveSettled;
    operation.settled = new Promise((resolve) => { resolveSettled = resolve; });
    activeGitOperations.add(operation);
    try {
      output = await new Promise((resolve, reject) => {
        let child;
        let windowsJob;
        let spawnError = null;
        let timedOut = false;
        let cancelPromise;
        let cancelRequested;
        let cancelImplementation;
        let timer;
        let abortHandler;
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const maxOutputBytes = 32 * 1024 * 1024;
        const collect = (chunks, count, chunk) => {
          if (count >= maxOutputBytes) return count;
          const kept = chunk.length > maxOutputBytes - count ? chunk.subarray(0, maxOutputBytes - count) : chunk;
          chunks.push(kept);
          return count + kept.length;
        };
        const onData = (chunks, key) => (chunk) => { if (key === 'stdout') stdoutBytes = collect(chunks, stdoutBytes, chunk); else stderrBytes = collect(chunks, stderrBytes, chunk); };
        const finish = async (status, childSignal) => {
          if (timer) clearTimeout(timer);
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
          if (cancelPromise) await cancelPromise;
          resolve({
            error: spawnError, status,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            signal: childSignal ?? null, timedOut,
          });
        };
        operation.cancel = async (reason = 'cancelled') => {
          cancelRequested = reason;
          if (!cancelImplementation) return;
          return cancelImplementation(reason);
        };
        cancelImplementation = async (reason = 'cancelled') => {
          if (cancelPromise) return cancelPromise;
          timedOut ||= reason === 'timeout';
          cancelPromise = (async () => {
            if (windowsJob) {
              await windowsJob.cancel(reason);
              return;
            }
            if (!child?.pid) return;
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* no group remains */ }
            await delay(100);
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no group remains */ }
          })();
          return cancelPromise;
        };
        try {
          if (process.platform === 'win32') {
            windowsJob = startWindowsJob('git.exe', args, {
              cwd,
              env: env ?? process.env,
              maxOutputBytes,
              ...(Number.isFinite(budget) ? { timeoutMs: Math.max(1, Math.floor(budget)) } : {}),
            });
            cancelImplementation = (reason) => windowsJob.cancel(reason);
            if (cancelRequested) void cancelImplementation(cancelRequested);
            timer = Number.isFinite(deadline) ? setTimeout(() => {
              timedOut = true;
              void operation.cancel('timeout').then(() => windowsJob.result).then((result) => {
                resolve({ ...result, timedOut: true });
              }, (error) => {
                cleanupUnconfirmed = true;
                const failure = new Error(`Windows Git Job Object cleanup could not be confirmed: ${error?.message ?? error}`);
                failure.code = 'GIT_JOB_UNCONFIRMED';
                reject(failure);
              });
            }, Math.max(1, remaining(deadline))) : null;
            abortHandler = () => { void operation.cancel(signal.reason ?? 'cancelled'); };
            signal?.addEventListener('abort', abortHandler, { once: true });
            windowsJob.result.then((result) => {
              if (timer) clearTimeout(timer);
              if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
              resolve({ ...result, timedOut: Boolean(result.timedOut || timedOut) });
            }, (error) => {
              if (timer) clearTimeout(timer);
              if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
              cleanupUnconfirmed = true;
              const failure = new Error(`Windows Git Job Object cleanup could not be confirmed: ${error?.message ?? error}`);
              failure.code = 'GIT_JOB_UNCONFIRMED';
              reject(failure);
            });
            return;
          } else {
            child = spawn('git', args, {
              cwd, env: env ?? process.env, ...rest,
              stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
            });
          }
        } catch (error) {
          spawnError = error;
          resolve({ error, status: null, stdout: '', stderr: '', signal: null, timedOut: false });
          return;
        }
        child.stdout?.on('data', onData(stdout, 'stdout'));
        child.stderr?.on('data', onData(stderr, 'stderr'));
        child.once('error', (error) => { spawnError = error; });
        timer = Number.isFinite(deadline) ? setTimeout(() => { timedOut = true; void operation.cancel('timeout'); }, Math.max(1, remaining(deadline))) : null;
        abortHandler = () => { void operation.cancel(signal.reason ?? 'cancelled'); };
        signal?.addEventListener('abort', abortHandler, { once: true });
        child.once('close', (status, childSignal) => { void finish(status, childSignal); });
        if (cancelRequested) void cancelImplementation(cancelRequested);

      });
    } finally {
      if (!cleanupUnconfirmed) {
        activeGitOperations.delete(operation);
        resolveSettled();
      }
    }

    output = {
      status: output.status,
      stdout: trim ? String(output.stdout || '').trim() : String(output.stdout || ''),
      stderr: trim ? String(output.stderr || '').trim() : String(output.stderr || ''),
      signal: output.signal ?? null,
      timedOut: Boolean(output.timedOut || output.error?.code === 'ETIMEDOUT'),
      attempts,
    };
    if (output.status === 0 || output.timedOut || !retry || attempts >= GIT_RETRY_MAX_ATTEMPTS) break;
    const transientClass = classifyTransientGitFailure(args, output.stderr);
    if (!transientClass) break;
    const wait = Math.min(GIT_RETRY_BACKOFF_MS[attempts - 1] ?? GIT_RETRY_BACKOFF_MS.at(-1), remaining(deadline));
    if (wait <= 0) { output.timedOut = true; break; }
    log(`[worktree-guard] git ${gitSubcommand(args)} hit a transient error (${transientClass}, attempt ${attempts}/${GIT_RETRY_MAX_ATTEMPTS}); retrying in ${wait}ms`);
    await delay(wait);
  }

  if (allowFailure === false && output.status !== 0) {
    if (output.timedOut) throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms and was terminated`);
    throw new Error(`git ${args.join(' ')} failed (exit ${output.status}): ${output.stderr || output.stdout}`);
  }
  return output;
}

/**
 * `git` with stdout/stderr left exactly as git printed them. Use for any
 * output whose leading or trailing characters are significant.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {object} [options]
 */
export function gitRaw(args, cwd, options = {}) {
  return git(args, cwd, { ...options, trim: false });
}

/**
 * Untrimmed stdout split into non-empty lines (CRLF tolerated). No per-line
 * trimming: a leading space is data.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {object} [options]
 * @returns {string[]}
 */
export function gitLines(args, cwd, options = {}) {
  const result = gitRaw(args, cwd, options);
  return result.status === 0 ? splitLines(result.stdout) : [];
}

function splitLines(text) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean);
}

/**
 * Like `git`, but always throws on a non-zero exit code and returns just the
 * trimmed stdout string on success.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {{env?: NodeJS.ProcessEnv, [key: string]: any}} [options]
 * @returns {string}
 */
export function gitText(args, cwd, options = {}) {
  const result = git(args, cwd, { ...options, allowFailure: false });
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

/**
 * Parse the output of `git worktree list --porcelain` into an array of
 * { path, branch, head } records, preserving the order git printed them in.
 * The first record is always the primary (main) worktree -- that's a fixed
 * git behaviour, not something this parser decides.
 *
 * @param {string} porcelain
 * @returns {{path: string, branch: string|null, head: string|null}[]}
 */
export function parseWorktreePorcelain(porcelain) {
  const worktrees = [];
  let current = null;

  const flush = () => {
    if (current) {
      worktrees.push(current);
      current = null;
    }
  };

  for (const line of String(porcelain ?? '').split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      if (current) {
        const ref = line.slice('branch '.length);
        current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
    } else if (line === 'detached') {
      if (current) current.branch = null;
    }
    // 'bare', 'locked', 'locked <reason>', 'prunable', 'prunable <reason>' are
    // ignored -- not needed by any caller of discoverRepo today.
  }
  flush();

  return worktrees;
}

/**
 * @typedef {{
 *   topLevel: string,
 *   gitDir: string,
 *   commonGitDir: string,
 *   worktrees: {path: string, branch: string|null, head: string|null}[],
 *   branchShort: string|null,
 *   repoUrl: string,
 *   primaryWorktree: {path: string, branch: string|null, head: string|null}|null,
 * }} RepoInfo
 */

/**
 * Discover the repo rooted at (or containing) `cwd`: top-level path, git
 * dirs, current branch, remote URL, and the full worktree list with the
 * primary worktree identified as the first entry of `git worktree list
 * --porcelain` (git's own fixed ordering, not re-derived here).
 *
 * @param {string} cwd
 * @returns {RepoInfo}
 */
export function discoverRepo(cwd) {
  const topLevel = gitText(['rev-parse', '--show-toplevel'], cwd);
  const gitDir = gitText(['rev-parse', '--git-dir'], cwd);
  const commonGitDir = gitText(['rev-parse', '--git-common-dir'], cwd);
  const branchShort = git(['symbolic-ref', '--short', 'HEAD'], cwd).stdout || null;
  const repoUrl = git(['config', '--get', 'remote.origin.url'], cwd).stdout || '';
  // Raw, not trimmed: this is line-oriented output (see git()).
  const porcelainResult = gitRaw(['worktree', 'list', '--porcelain'], cwd, { allowFailure: false });
  const porcelain = porcelainResult.stdout;
  const worktrees = parseWorktreePorcelain(porcelain);
  const primaryWorktree = worktrees.length > 0 ? worktrees[0] : null;

  return { topLevel, gitDir, commonGitDir, worktrees, branchShort, repoUrl, primaryWorktree };
}

// ---------------------------------------------------------------------------
// Tool detection / naming
// ---------------------------------------------------------------------------

/**
 * Detect which AI tool (claude/codex/...) owns the current process, checking
 * an explicit override env var first, then each tool's detectEnv signals in
 * config.tools declaration order, falling back to config.defaultTool.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function detectWorktreeTool(env, config) {
  const override = String(env[config.envVars.workerTool] || '').trim().toLowerCase();
  if (config.tools[override]) return override;

  for (const [toolId, toolCfg] of Object.entries(config.tools)) {
    if ((toolCfg.detectEnv ?? []).some((name) => env[name] !== undefined && env[name] !== '')) {
      return toolId;
    }
  }

  return config.defaultTool;
}

/**
 * @param {string} toolId
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {{prefix: string, home: string, detectEnv: string[]}}
 */
export function toolConfig(toolId, config) {
  const cfg = config.tools[toolId];
  if (!cfg) {
    throw new Error(`unknown worktree tool id: "${toolId}" (known: ${Object.keys(config.tools).join(', ')})`);
  }
  return cfg;
}

/**
 * Turn an arbitrary human label into a branch-name-safe slug: NFKD-normalize
 * and strip combining diacritics, lowercase, collapse any run of
 * non-alphanumeric characters into a single hyphen, trim leading/trailing
 * hyphens, and cap the length at 80 characters. Never returns an empty
 * string -- falls back to 'worktree' when the input slugifies to nothing.
 *
 * @param {string} label
 * @returns {string}
 */
export function slugifyLabel(label) {
  let value = String(label ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  value = value.toLowerCase();
  value = value.replace(/[^a-z0-9]+/g, '-');
  value = value.replace(/^-+|-+$/g, '');
  value = value.slice(0, 80);
  value = value.replace(/^-+|-+$/g, '');
  return value || 'worktree';
}

/**
 * Allocate a unique branch name for a new worktree: `<prefix><slug>`, or
 * `<prefix><slug>-<n>` if that name is already in use (checked against both
 * the currently-checked-out worktree branches and any existing local branch
 * ref, so a branch that exists but isn't checked out anywhere still counts
 * as taken).
 *
 * @param {RepoInfo} repo
 * @param {string} label
 * @param {string} toolId
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function allocateWorktreeBranchName(repo, label, toolId, config) {
  const { prefix } = toolConfig(toolId, config);
  const base = slugifyLabel(label);

  for (let index = 1; index <= 99; index += 1) {
    const candidate = index === 1 ? `${prefix}${base}` : `${prefix}${base}-${index}`;
    const exists = repo.worktrees.some((w) => w.branch === candidate)
      || git(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], repo.topLevel).status === 0;
    if (!exists) return candidate;
  }

  throw new Error(`could not allocate a unique branch name for label "${label}" after 99 attempts`);
}

/**
 * Allocate a filesystem path for a new worktree under `worktreeRoot`, based
 * on `branchName` (slashes replaced with hyphens), appending `-2`, `-3`, ...
 * until an unused path is found.
 *
 * @param {string} worktreeRoot
 * @param {string} branchName
 * @returns {string}
 */
export function uniqueWorktreePath(worktreeRoot, branchName) {
  const safeName = branchName.replaceAll('/', '-');
  let candidate = join(worktreeRoot, safeName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(worktreeRoot, `${safeName}-${index}`);
    index += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Capacity checks
// ---------------------------------------------------------------------------

/**
 * Best-effort free disk space in GiB for the filesystem containing `path`.
 * Uses node:fs statfsSync (Node 18.15+) when available. On older Node
 * versions where statfsSync doesn't exist, this can't inspect disk space at
 * all -- rather than fail the caller over a missing diagnostic feature, it
 * returns Infinity so the disk-space check becomes a no-op (skipped, not
 * failed) and worktree creation isn't blocked by an unsupported platform.
 *
 * @param {string} path
 * @returns {number}
 */
function freeDiskGb(path) {
  if (typeof fsModule.statfsSync !== 'function') {
    return Infinity;
  }
  const stats = fsModule.statfsSync(path);
  return (stats.bfree * stats.bsize) / 1024 ** 3;
}

/**
 * Throw if creating another worktree would exceed config.maxWorktrees
 * managed worktrees, or if free disk space is below config.minFreeDiskGb.
 *
 * @param {RepoInfo} repo
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {void}
 */
export function checkCapacity(repo, config) {
  const existingCount = repo.worktrees.length - 1; // exclude the primary worktree itself
  if (existingCount >= config.maxWorktrees) {
    throw new Error(
      `refusing to create: already at capacity (${existingCount}/${config.maxWorktrees} managed worktrees)`,
    );
  }

  const free = freeDiskGb(repo.topLevel);
  if (free < config.minFreeDiskGb) {
    throw new Error(
      `refusing to create: only ${free.toFixed(1)}GB free disk, minimum is ${config.minFreeDiskGb}GB`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-worktree metadata
// ---------------------------------------------------------------------------

function escapeRegExpDots(value) {
  return value.replace(/\./g, '\\.');
}

/**
 * Read all `--worktree`-scoped git config keys under config.configNamespace
 * for the worktree at `cwd`, returning them as a flat { key: value } object
 * with the namespace prefix stripped. Returns {} (never throws) when no
 * metadata has ever been written for this worktree. Keys come back as git
 * stored them -- lowercased, per git's own case-insensitive variable-name
 * handling (see the note on writeWorktreeMetadata).
 *
 * @param {string} cwd
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {Record<string, string>}
 */
export function readWorktreeMetadata(cwd, config) {
  const namespacePattern = escapeRegExpDots(config.configNamespace);
  // Raw output: a value's own leading/trailing spaces are data, and only the
  // first space on a line separates key from value.
  const result = gitRaw(
    ['config', '--worktree', '--get-regexp', `^${namespacePattern}\\.`],
    cwd,
  );

  if (result.status !== 0 || !result.stdout) return {};

  const metadata = {};
  for (const line of splitLines(result.stdout)) {
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex === -1) continue;
    const fullKey = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex + 1);
    const key = fullKey.startsWith(`${config.configNamespace}.`)
      ? fullKey.slice(config.configNamespace.length + 1)
      : fullKey;
    metadata[key] = value;
  }
  return metadata;
}

/**
 * Write { key: value } pairs as `--worktree`-scoped git config under
 * config.configNamespace for the worktree at `cwd`, enabling
 * extensions.worktreeConfig first if needed. Keys whose value is undefined,
 * null, or '' are skipped.
 *
 * Note: git config variable names are case-insensitive and git itself
 * downcases them on storage (see git-config(1)) -- this is stable, long-
 * standing git behaviour, not something this function decides. A mixed-case
 * key like `ownerEmail` will therefore read back as `owneremail`. Callers
 * that want predictable round-tripping should use already-lowercase keys.
 *
 * @param {string} cwd
 * @param {Record<string, unknown>} metadata
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {void}
 */
export function writeWorktreeMetadata(cwd, metadata, config) {
  git(['config', 'extensions.worktreeConfig', 'true'], cwd, { allowFailure: true });
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null || value === '') continue;
    gitText(['config', '--worktree', `${config.configNamespace}.${key}`, String(value)], cwd);
  }
}

// ---------------------------------------------------------------------------
// Mass-deletion classifier
// ---------------------------------------------------------------------------

/**
 * List tracked files deleted between the merge-base of `baseBranch` and HEAD
 * and HEAD itself, in the worktree at `worktreePath`. Returns [] when
 * `baseBranch` is falsy or no merge-base can be found (never throws).
 *
 * @param {string} worktreePath
 * @param {string|null|undefined} baseBranch
 * @returns {string[]}
 */
export function computeDeletedTrackedFiles(worktreePath, baseBranch) {
  if (!baseBranch) return [];
  const mergeBase = git(['merge-base', baseBranch, 'HEAD'], worktreePath).stdout;
  if (!mergeBase) return [];
  // -z: NUL-separated, never C-quoted, so a name with a leading space, a
  // non-ASCII byte, or a quote survives intact (and nothing is trimmed).
  const diff = gitRaw(['diff', '--diff-filter=D', '--name-only', '-z', mergeBase], worktreePath);
  if (diff.status !== 0) return [];
  return diff.stdout.split('\0').filter(Boolean);
}

/**
 * Classify a set of deleted files as a mass-deletion event: triggered when
 * the count reaches config.massDeletion.threshold, OR when any deleted file
 * matches (equals or is nested under) one of config.massDeletion
 * .criticalPrefixes -- whichever comes first, this is an OR not an AND, so
 * even a single critical-path deletion trips it.
 *
 * @param {string[]} deletedFiles
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {{deletedFiles: string[], deletedCount: number, criticalHits: string[], isMassDeletion: boolean}}
 */
export function classifyMassDeletion(deletedFiles, config) {
  const files = (deletedFiles || []).map((f) => String(f || '').trim()).filter(Boolean);
  const { threshold, criticalPrefixes } = config.massDeletion;
  const criticalHits = files.filter((f) => criticalPrefixes.some((prefix) => f === prefix || f.startsWith(prefix)));
  return {
    deletedFiles: files,
    deletedCount: files.length,
    criticalHits,
    isMassDeletion: files.length >= threshold || criticalHits.length > 0,
  };
}

// ---------------------------------------------------------------------------
// `git status --porcelain` parsing
// ---------------------------------------------------------------------------

/**
 * Decode one C-style quoted git path (double quotes, backslash escapes, and
 * octal triples that are raw UTF-8 bytes) into the literal path.
 *
 * @param {string} quoted a path including its surrounding double quotes
 * @returns {string}
 */
export function unquoteGitCPath(quoted) {
  const body = String(quoted).slice(1, -1);
  const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const encoder = new TextEncoder();
  const bytes = [];
  for (let i = 0; i < body.length;) {
    if (body[i] !== '\\') {
      const ch = String.fromCodePoint(body.codePointAt(i));
      bytes.push(...encoder.encode(ch));
      i += ch.length;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 4;
    } else if (body[i + 1] in named) {
      bytes.push(named[body[i + 1]]);
      i += 2;
    } else {
      bytes.push(...encoder.encode(body[i]));
      i += 1;
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * Parse RAW (never trimmed) `git status --porcelain` stdout into
 * `{ statusCode, path }` entries. `statusCode` is the two-character XY pair
 * verbatim and may start with a space (` M`). For a rename/copy only the
 * destination path is returned. A path git quoted is unquoted.
 *
 * Pass stdout from `gitRaw` / `git(..., { trim: false })`. A value that has
 * already been trimmed loses the leading space of a first ` M path` line and
 * this fixed-column slice would then drop the path's first character.
 *
 * @param {string} rawStdout
 * @returns {{statusCode: string, path: string}[]}
 */
export function parsePorcelainEntries(rawStdout) {
  return splitLines(rawStdout).map((line) => {
    const statusCode = line.slice(0, 2);
    const rest = line.slice(3);
    const arrowIndex = rest.indexOf(' -> ');
    const rawPath = arrowIndex === -1 ? rest : rest.slice(arrowIndex + 4);
    const path = rawPath.length >= 2 && rawPath.startsWith('"') && rawPath.endsWith('"')
      ? unquoteGitCPath(rawPath)
      : rawPath;
    return { statusCode, path };
  });
}

/**
 * Paths only, in porcelain order. See `parsePorcelainEntries`.
 *
 * @param {string} rawStdout
 * @returns {string[]}
 */
export function parsePorcelainPaths(rawStdout) {
  return parsePorcelainEntries(rawStdout).map((entry) => entry.path).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Upstream resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the configured upstream (@{u}) for HEAD in `worktreePath` into its
 * remote name and remote-tracking branch name. Returns { remote: null,
 * branch: null } when no upstream is configured.
 *
 * @param {string} worktreePath
 * @returns {{remote: string|null, branch: string|null}}
 */
export function resolveUpstream(worktreePath) {
  const upstream = git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    worktreePath,
  ).stdout;
  if (!upstream) return { remote: null, branch: null };

  const slashIndex = upstream.indexOf('/');
  if (slashIndex === -1) return { remote: null, branch: upstream };
  return { remote: upstream.slice(0, slashIndex), branch: upstream.slice(slashIndex + 1) };
}

// ---------------------------------------------------------------------------
// Stash-audit diagnostics (read-only forensics, not a safety-critical path)
// ---------------------------------------------------------------------------

/**
 * @typedef {{sha: string, subject: string}} Finding
 */

/**
 * Find dangling (unreachable, not reflog-protected) commit objects whose
 * subject line looks like a stash commit ("On <branch>: ..." / "WIP on
 * <branch>: ..."), which is the fingerprint left behind when a stash entry's
 * commit object survives but its ref/reflog entry doesn't. Best-effort: any
 * parse miss is simply excluded, and finding nothing returns [] rather than
 * throwing.
 *
 * @param {RepoInfo} repo
 * @returns {Finding[]}
 */
export function findSuspiciousDanglingStashCommits(repo) {
  const result = git(['fsck', '--unreachable', '--no-reflog'], repo.topLevel);
  if (result.status !== 0 || !result.stdout) return [];

  const findings = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^unreachable commit ([0-9a-f]+)/);
    if (!match) continue;
    const sha = match[1];
    const subject = git(['log', '-1', '--format=%s', sha], repo.topLevel).stdout;
    if (/^(On|WIP on) [^:]+:/.test(subject)) {
      findings.push({ sha, subject });
    }
  }
  return findings;
}

/**
 * Detect the fingerprint of a stash ref whose value still resolves but whose
 * reflog has been truncated (e.g. by a hook intercepting `stash pop`/`stash
 * drop`): refs/stash resolves to a sha, but `git reflog show refs/stash` is
 * empty. Returns null when refs/stash doesn't exist, or when it exists and
 * its reflog is intact.
 *
 * @param {string} cwd
 * @returns {{ref: string, reflogEmpty: true}|null}
 */
export function findStashReflogValueMismatch(cwd) {
  const ref = git(['rev-parse', '--verify', '-q', 'refs/stash'], cwd).stdout;
  if (!ref) return null;

  const reflog = git(['reflog', 'show', 'refs/stash'], cwd).stdout;
  if (!reflog) {
    return { ref, reflogEmpty: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Is this branch already merged?" -- ancestry first, patch-id content
// equivalence second
// ---------------------------------------------------------------------------
//
// Ancestry alone ("is HEAD reachable from the base?") says "not merged" for a
// branch that was squash-merged or cherry-picked: the base carries the same
// CHANGES under different commit ids. Without a fallback such a worktree can
// never be cleaned up. The fallback compares `git patch-id --stable` values:
// every commit unique to HEAD must have a patch-id that also appears among the
// commits unique to the base. No cache is kept -- the window is bounded and
// recomputed each call.

/** Hard cap on how many base-only commits are scanned for matching patch-ids. */
export const PATCH_ID_WINDOW_HARD_CAP = 20000;

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Large buffer: `git log -p` over a long window is big.
const PATCH_TEXT_MAX_BUFFER = 512 * 1024 * 1024;

function revParseCommit(cwd, ref) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return result.status === 0 && result.stdout ? result.stdout : '';
}

function commitSubject(cwd, sha) {
  return git(['log', '-1', '--format=%s', sha], cwd).stdout || '(no subject)';
}

/** True when the commit introduces no change relative to its first parent. */
function isEmptyCommit(cwd, sha) {
  const tree = git(['rev-parse', `${sha}^{tree}`], cwd).stdout;
  const parentTree = git(['rev-parse', '--verify', '--quiet', `${sha}^1^{tree}`], cwd).stdout;
  return Boolean(tree) && tree === (parentTree || EMPTY_TREE_SHA);
}

/**
 * Pipe diff text through `git patch-id --stable`. Returns patch-id -> [sha].
 * For `git log -p` text the sha is the commit named on the preceding header;
 * for a bare `git diff` it is the all-zero placeholder git prints.
 * Throws (fail closed) when patch-id itself fails.
 */
function patchIdMapFromText(cwd, text) {
  const map = new Map();
  if (!String(text || '').trim()) return map;
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd,
    input: text,
    encoding: 'utf8',
    maxBuffer: PATCH_TEXT_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git patch-id --stable failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const [patchId, sha] = line.trim().split(/\s+/);
    if (!patchId || !sha) continue;
    if (!map.has(patchId)) map.set(patchId, []);
    map.get(patchId).push(sha);
  }
  return map;
}

function logPatchText(cwd, range, limit) {
  const args = ['log', '--no-color', '--no-merges', '-p'];
  if (limit) args.push(`-${limit}`);
  args.push(range);
  const result = gitRaw(args, cwd, { maxBuffer: PATCH_TEXT_MAX_BUFFER });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Decide whether `headRef`'s content is already on `baseRef`.
 *
 *   1. Ancestry: headRef is reachable from baseRef  -> landed, via 'ancestry'.
 *   2. Patch-id (skipped when `usePatchId` is false): every commit unique to
 *      headRef (`base..head`) must have a patch-id present among the commits
 *      unique to baseRef (`head..base`, newest PATCH_ID_WINDOW_HARD_CAP). An
 *      empty commit is trivially fine. A MERGE commit unique to headRef cannot
 *      be verified this way and blocks. If single commits do not match, the
 *      whole branch's net diff is tried once against the same window, which
 *      recognises a multi-commit branch squashed into one commit.
 *
 * Never throws: any git failure yields `landed: false` with a reason.
 *
 * @param {string} cwd a worktree (or repo) containing both refs
 * @param {string} baseRef the ref to test against (single ref, caller chooses)
 * @param {{headRef?: string, usePatchId?: boolean, windowCap?: number}} [options]
 * @returns {{landed: boolean, via: 'ancestry'|'patch-id'|null, baseRef: string, reason: string,
 *   unmatched: {sha: string, subject: string, reason: string}[]}}
 */
export function assessHeadLanded(cwd, baseRef, options = {}) {
  const { headRef = 'HEAD', usePatchId = true, windowCap = PATCH_ID_WINDOW_HARD_CAP } = options;
  const fail = (reason, unmatched = []) => ({ landed: false, via: null, baseRef, reason, unmatched });

  const headSha = revParseCommit(cwd, headRef);
  const baseSha = baseRef ? revParseCommit(cwd, baseRef) : '';
  if (!headSha) return fail(`${headRef} does not resolve to a commit`);
  if (!baseSha) return fail(`base ref ${baseRef || '(none)'} does not resolve to a commit`);

  if (git(['merge-base', '--is-ancestor', headSha, baseSha], cwd).status === 0) {
    return { landed: true, via: 'ancestry', baseRef, reason: '', unmatched: [] };
  }
  if (!usePatchId) {
    return fail(`${headRef} is not an ancestor of ${baseRef} (patch-id fallback disabled)`);
  }

  try {
    const unique = gitLines(['rev-list', '--reverse', `${baseSha}..${headSha}`], cwd);
    const merges = new Set(gitLines(['rev-list', '--merges', `${baseSha}..${headSha}`], cwd));
    const unmatched = [];
    for (const sha of unique) {
      if (merges.has(sha)) {
        unmatched.push({ sha, subject: commitSubject(cwd, sha), reason: 'merge commit cannot be verified by patch-id' });
      }
    }
    if (unmatched.length > 0) return fail(`${unmatched.length} merge commit(s) unique to ${headRef} cannot be verified`, unmatched);

    const windowCount = Number(git(['rev-list', '--count', `${headSha}..${baseSha}`], cwd).stdout) || 0;
    const upstream = patchIdMapFromText(cwd, logPatchText(cwd, `${headSha}..${baseSha}`, windowCap));
    const local = patchIdMapFromText(cwd, logPatchText(cwd, `${baseSha}..${headSha}`));
    const localIdOf = new Map();
    for (const [patchId, shas] of local) for (const sha of shas) localIdOf.set(sha, patchId);

    const windowNote = windowCount > windowCap
      ? ` (only the newest ${windowCap} of ${windowCount} base-only commits were scanned)`
      : '';
    for (const sha of unique) {
      const patchId = localIdOf.get(sha);
      if (!patchId) {
        if (isEmptyCommit(cwd, sha)) continue;
        unmatched.push({ sha, subject: commitSubject(cwd, sha), reason: 'no patch-id could be computed for this commit' });
      } else if (!upstream.has(patchId)) {
        unmatched.push({
          sha,
          subject: commitSubject(cwd, sha),
          reason: `patch-id not found among the ${Math.min(windowCount, windowCap)} commit(s) unique to ${baseRef}${windowNote}`,
        });
      }
    }
    if (unmatched.length === 0) return { landed: true, via: 'patch-id', baseRef, reason: '', unmatched: [] };

    // Squash of several commits into one: compare the branch's NET diff.
    const mergeBase = git(['merge-base', baseSha, headSha], cwd).stdout;
    if (mergeBase) {
      const net = gitRaw(['diff', '--no-color', mergeBase, headSha], cwd, { maxBuffer: PATCH_TEXT_MAX_BUFFER });
      if (net.status === 0) {
        const netIds = [...patchIdMapFromText(cwd, net.stdout).keys()];
        if (netIds.length === 1 && upstream.has(netIds[0])) {
          return { landed: true, via: 'patch-id', baseRef, reason: '', unmatched: [] };
        }
      }
    }
    return fail(`${unmatched.length} commit(s) unique to ${headRef} are not on ${baseRef} by content`, unmatched);
  } catch (error) {
    return fail(`could not verify ${headRef} against ${baseRef}: ${error.message}`);
  }
}

/**
 * One-line-per-commit rendering of `assessHeadLanded().unmatched`.
 *
 * @param {{sha: string, subject: string, reason: string}[]} unmatched
 * @returns {string[]}
 */
export function formatUnmatchedCommits(unmatched) {
  return unmatched.map((entry) => `${entry.sha.slice(0, 10)} ${entry.subject} -- ${entry.reason}`);
}
