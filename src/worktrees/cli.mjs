#!/usr/bin/env node
// worktree-guard/cli.mjs
//
// Command-line entry point wiring the six worktree-guard modules (config,
// git-identity, process-provenance, hooks, finish-lock, worktree-core) into a
// runnable CLI. This file only orchestrates -- all git/fs business logic
// lives in the modules it imports; cli.mjs itself stays a thin dispatcher.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { mkdirSync, existsSync, readFileSync, appendFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { loadConfig, syncPrimarySettings } from './config.mjs';
import {
  gitIdentityArgs,
  gitIdentityEnv,
  assertNoFixtureGitIdentity,
  reauthorUnpushedCommitsToAiIdentity,
} from './git-identity.mjs';
import { checkOtherAiActivity } from './ai-idle-check.mjs';
import { detectAiParent } from './process-provenance.mjs';
import { reclaimStaleWorktrees, recentWorktreeActivity } from './reclaim-stale.mjs';
import { makeOwnedTreeWritable } from './writable-tree.mjs';
import { assertKitSafeToRemove, checkKit, prepareKit } from '../dependencies/submodule.mjs';
import { runProjectHook } from '../contracts/project-adapter.mjs';
import { ensureNodeDepsMatchLockfile } from './node-deps-integrity.mjs';
import { hasFirstParentMerge, isAncestor, listFirstParentMerges, redoMergesOnTip } from './merge-topology.mjs';
import {
  installStashGuardHook,
  stashGuardStatus,
  installPrimaryLockHook,
  primaryLockHookIsInstalled,
  primaryAuditLogPath,
  createBypassMarker,
  removeBypassMarker,
} from './hooks.mjs';
import {
  acquireFinishLock,
  acquireFinishLockQueued,
  startFinishLockHeartbeat,
  FinishLockHoldTimeoutError,
} from './finish-lock.mjs';
import {
  git,
  gitRaw,
  gitText,
  parsePorcelainPaths,
  discoverRepo,
  detectWorktreeTool,
  toolConfig,
  allocateWorktreeBranchName,
  uniqueWorktreePath,
  checkCapacity,
  readWorktreeMetadata,
  writeWorktreeMetadata,
  computeDeletedTrackedFiles,
  classifyMassDeletion,
  resolveUpstream,
  findSuspiciousDanglingStashCommits,
  findStashReflogValueMismatch,
} from './worktree-core.mjs';

/**
 * Remove a worktree only after the registered kit has independently proved safe to delete.
 * No-kit projects keep their existing cleanup behavior because the proof returns non-applicable.
 * @param {{projectRoot:string, worktreePath:string, primaryPath:string, force?:boolean, env?:NodeJS.ProcessEnv, deleteBranch?:string, runGit?:typeof git, beforeRemove?:()=>void}} options
 */
export function removeWorktreeSafely({
  projectRoot,
  worktreePath,
  primaryPath,
  force = false,
  env,
  deleteBranch,
  runGit = git,
  beforeRemove,
}) {
  const proof = assertKitSafeToRemove({ projectRoot });
  beforeRemove?.();
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
  runGit(args, primaryPath, { allowFailure: false, ...(env ? { env } : {}) });
  if (deleteBranch) {
    runGit(['branch', '-D', deleteBranch], primaryPath, {
      allowFailure: true,
      ...(env ? { env } : {}),
    });
  }
  return proof;
}

function prepareAndCheckKit(projectRoot) {
  const prepared = prepareKit({ projectRoot });
  if (prepared.applicable) checkKit({ projectRoot });
  return prepared;
}

function candidateSnapshot(projectRoot) {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], projectRoot).stdout;
  const kit = checkKit({ projectRoot });
  return {
    head: gitText(['rev-parse', 'HEAD'], projectRoot),
    status,
    kitPin: kit.applicable ? kit.commit : null,
  };
}

async function runStableLifecycleHook(projectRoot, phase, context, { requireClean = false } = {}) {
  const before = candidateSnapshot(projectRoot);
  if (requireClean && before.status) {
    throw new Error(`refusing ${phase}: candidate worktree is not clean before the adapter hook`);
  }
  await runProjectHook({
    projectRoot,
    phase,
    context: {
      ...context,
      ...before,
      candidateSha: before.head,
      pin: before.kitPin,
    },
  });
  const after = candidateSnapshot(projectRoot);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`project adapter hook ${phase} changed HEAD, worktree cleanliness, or kit pin; candidate is invalid`);
  }
  if (requireClean && after.status) {
    throw new Error(`project adapter hook ${phase} left the candidate worktree dirty; candidate is invalid`);
  }
  return after;
}

// ---------------------------------------------------------------------------
// §1 argv parsing (spec-mandated exact algorithm -- do not "improve" this)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [command = 'status', ...rest] = normalizedArgv;
  const booleanFlags = new Set([
    'allowMassDeletion', 'dryRun', 'worker', 'noPush', 'noWait', 'help',
    'strict', 'install', 'force', 'offline', 'typecheck', 'json', 'stale',
    'reclaimStale', 'apply', 'allowRecent', 'noPatchId',
  ]);
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    if (eqIndex !== -1) {
      const key = flagKey(body.slice(0, eqIndex));
      flags[key] = body.slice(eqIndex + 1);
      continue;
    }
    const key = flagKey(body);
    const next = rest[i + 1];
    if (!booleanFlags.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  const HELP_TOKENS = new Set(['--help', '-h', 'help']);
  const isHelpCommand = HELP_TOKENS.has(command);
  const help = isHelpCommand || Boolean(flags.help) || positional.some((v) => HELP_TOKENS.has(v));
  const helpTarget = isHelpCommand ? undefined : command;
  return { command: isHelpCommand ? 'status' : command, flags, positional, help, helpTarget };
}

function flagKey(raw) {
  return raw.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// §2 small local helpers
// ---------------------------------------------------------------------------

function sleepAsync(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function yieldToEventLoop() {
  return new Promise((res) => setImmediate(res));
}

/**
 * `git()` for the steps that run while the finish lock is held. Differences:
 *   - yields to the event loop first, so a SIGINT/SIGTERM that arrived during
 *     the previous (blocking) git call is handled before the next step starts;
 *   - refuses to start once the hold budget (`queue.maxHoldMs`) is spent, and
 *     gives the call only the REMAINING budget as a hard timeout;
 *   - if git itself was ended by SIGINT/SIGTERM (a Ctrl-C reaches the whole
 *     foreground process group), releases the lock and exits like the handler.
 * A timeout throws FinishLockHoldTimeoutError; the caller's `finally` releases
 * the lock.
 */
async function lockedGit(lock, args, cwd, options = {}) {
  await yieldToEventLoop();
  if (lock.holdExpired()) throw new FinishLockHoldTimeoutError(lock.maxHoldMs, `git ${args[0]}`);
  const result = git(args, cwd, { ...options, allowFailure: true, timeoutMs: lock.remainingHoldMs() });
  if (result.timedOut) {
    // A killed rebase leaves the worktree mid-rebase; put it back.
    if (args.includes('rebase')) git(['rebase', '--abort'], cwd, { allowFailure: true, retry: false });
    throw new FinishLockHoldTimeoutError(lock.maxHoldMs, `git ${args.join(' ')}`);
  }
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') lock.exitFromSignal(result.signal);
  if (options.allowFailure === false && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
}

/**
 * Mirrors the PRIVATE primaryLockHooksDir()/gitDirAbsoluteForWorktree()
 * helpers inside hooks.mjs (neither is exported from that module), just
 * closely enough for this CLI to point createBypassMarker/removeBypassMarker
 * at the exact directory the primary-lock reference-transaction hook scans
 * for a live bypass marker (see hooks.mjs's PRIMARY_LOCK_HOOK_TEMPLATE:
 * `for marker in "$HOOKS_DIR"/.bypass-*.marker`). There is nothing to import
 * for this, so it is kept in lockstep by hand with hooks.mjs's own
 * `join(gitDirAbsoluteForWorktree(primaryPath), 'primary-lock-hooks')`.
 *
 * @param {string} primaryPath
 * @returns {string}
 */
function primaryLockHooksDirFor(primaryPath) {
  const gitDirRaw = gitText(['rev-parse', '--git-dir'], primaryPath);
  const gitDirAbs = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(primaryPath, gitDirRaw);
  return join(gitDirAbs, 'primary-lock-hooks');
}

/**
 * Env override carrying the internal "guard-internal-bypass" token
 * (config.primaryLockBypassToken, checked by the primary-lock hook via
 * config.envVars.primaryLockBypass) -- used for the handful of git ref
 * writes on the PRIMARY worktree that this CLI itself performs as part of a
 * sanctioned command (finish's post-push branch cleanup, sync-primary's
 * fast-forward merge). Both fields are ordinary exported config values, so
 * this needs no access to hooks.mjs internals.
 *
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
function primaryLockBypassEnv(config, base = process.env) {
  return { ...base, [config.envVars.primaryLockBypass]: config.primaryLockBypassToken };
}

/**
 * config.mjs documents `stateDir` as "relative to the *common* git dir
 * unless absolute", and its default value spells that out literally as
 * ".git/worktree-guard-state". repo.commonGitDir (from `git rev-parse
 * --git-common-dir`) is already the resolved absolute common git dir for
 * BOTH the primary worktree (where ".git" is a real directory) and any
 * linked worktree (where ".git" is a file pointing elsewhere) -- so a
 * leading ".git" path segment in config.stateDir is stripped before joining
 * onto repo.commonGitDir, rather than doubled up.
 *
 * @param {import('./worktree-core.mjs').RepoInfo} repo
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
function resolveStateDirAbs(repo, config) {
  const dir = config.stateDir;
  if (isAbsolute(dir)) return dir;
  const withoutLeadingGitDir = dir.replace(/^\.git[\\/]?/, '');
  return resolve(repo.commonGitDir, withoutLeadingGitDir);
}

// Strip a leading "<remote>/" prefix (for any remote actually configured on
// this repo) or "refs/heads/"/"refs/remotes/<remote>/" from a base-branch
// ref, so what gets stored as worktree metadata is always a plain local
// branch name -- never a remote-qualified ref -- regardless of whether the
// caller passed a bare branch name (the common case) or an explicit
// "<remote>/<branch>" ref via --base (e.g. to branch from the remote's
// exact tip rather than a possibly-stale local branch).
function normalizeBaseRef(ref, cwd) {
  let value = String(ref || '');
  value = value.replace(/^refs\/heads\//, '');
  value = value.replace(/^refs\/remotes\//, '');
  const remotesResult = git(['remote'], cwd, { allowFailure: true });
  const remotes = (remotesResult.stdout || '').split('\n').map((r) => r.trim()).filter(Boolean);
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  return value;
}

// Resolve the remote + remote-branch a *local* branch is configured to track
// (branch.<name>.remote / branch.<name>.merge), independent of HEAD -- unlike
// resolveUpstream() in worktree-core.mjs, which only reads HEAD's own @{u}.
// `create` needs this because the base branch being branched from is not
// necessarily the worktree's own current HEAD (it's usually the PRIMARY
// checkout's current branch, e.g. "develop", or an explicit --base). Returns
// null when the branch has no configured upstream (e.g. a fresh/local-only
// branch, or an explicit remote-qualified --base that normalizeBaseRef()
// already stripped down to a plain name pointing at a remote ref with no
// local tracking branch behind it).
function resolveBranchUpstreamRemote(branch, cwd) {
  const remote = git(['config', '--get', `branch.${branch}.remote`], cwd, { allowFailure: true }).stdout;
  const mergeRef = git(['config', '--get', `branch.${branch}.merge`], cwd, { allowFailure: true }).stdout;
  if (!remote || !mergeRef) return null;
  const remoteBranch = mergeRef.replace(/^refs\/heads\//, '');
  return { remote, remoteBranch };
}

// Default staleness threshold (minutes) for the STALE-UNCOMMITTED marker in
// `status` -- see commandStatus()'s --stale-minutes flag.
const DEFAULT_STALE_MINUTES = 20;

/**
 * Format a millisecond duration as a short human age string ("<1m", "5m",
 * "3h", "2d"), rounding down to the coarsest unit that applies. Never
 * negative -- a clock-skew/future timestamp is clamped to 0.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatAgeMs(ms) {
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Compute { dirtyCount, lastActivityMs } for a managed worktree: the number
 * of tracked-modified + untracked (never ignored) files per `git status
 * --porcelain`, and the newest mtime among them (null when there are no
 * dirty files, or none of them still exist on disk -- e.g. all-deleted).
 *
 * @param {string} worktreePath
 * @returns {{dirtyCount: number, lastActivityMs: number|null}}
 */
function computeDirtyInfo(worktreePath) {
  // Raw stdout: parsePorcelainPaths needs the first line's leading space.
  const result = gitRaw(['status', '--porcelain'], worktreePath, { allowFailure: true });
  if (result.status !== 0) return { dirtyCount: 0, lastActivityMs: null };
  const paths = parsePorcelainPaths(result.stdout);
  let lastActivityMs = null;
  for (const relPath of paths) {
    try {
      const stat = statSync(join(worktreePath, relPath));
      const mtimeMs = stat.mtimeMs;
      if (lastActivityMs === null || mtimeMs > lastActivityMs) lastActivityMs = mtimeMs;
    } catch {
      // Deleted/unreadable path -- no mtime to contribute, still counts
      // toward dirtyCount above.
    }
  }
  return { dirtyCount: paths.length, lastActivityMs };
}

function appendPrimaryAuditLog(repo, config, entry) {
  try {
    const logPath = primaryAuditLogPath(repo.primaryWorktree.path, config);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({ ts: new Date().toISOString(), command: 'sync-primary', ...entry })}\n`,
    );
  } catch {
    // Best-effort only -- never let audit-log bookkeeping block the real
    // decision it's recording.
  }
}

// ---------------------------------------------------------------------------
// §3 commands
// ---------------------------------------------------------------------------

function commandStatus(flags, config) {
  const staleMinutesRaw = flags.staleMinutes !== undefined ? Number(flags.staleMinutes) : DEFAULT_STALE_MINUTES;
  const staleMinutes = Number.isFinite(staleMinutesRaw) && staleMinutesRaw >= 0
    ? staleMinutesRaw
    : DEFAULT_STALE_MINUTES;
  const staleOnly = Boolean(flags.stale);
  const asJson = Boolean(flags.json);
  const now = Date.now();

  const repo = discoverRepo(process.cwd());
  const primaryPath = repo.primaryWorktree ? repo.primaryWorktree.path : null;

  const prefixes = Object.values(config.tools).map((tool) => tool.prefix);
  const managed = repo.worktrees.filter((w) => (
    w.path !== repo.primaryWorktree?.path
    && w.branch
    && prefixes.some((prefix) => w.branch.startsWith(prefix))
  ));

  const rows = managed.map((w) => {
    const metadata = readWorktreeMetadata(w.path, config);
    const lifecycle = metadata.lifecycle || '(unknown)';
    const executionRole = metadata['execution-role'] || '(none)';
    // Surfaced so a restarted/new session can tell, at a glance, which
    // managed worktrees already hold committed progress instead of having
    // to `cd` into each one and run `git log` by hand.
    const baseSha = metadata['base-sha'];
    let aheadCount = '?';
    let lastSubject = '(unknown)';
    if (baseSha) {
      const aheadResult = git(['rev-list', '--count', `${baseSha}..HEAD`], w.path, { allowFailure: true });
      if (aheadResult.status === 0 && aheadResult.stdout) aheadCount = aheadResult.stdout;
    }
    const subjectResult = git(['log', '-1', '--format=%s'], w.path, { allowFailure: true });
    if (subjectResult.status === 0 && subjectResult.stdout) lastSubject = subjectResult.stdout;

    // A worktree with uncommitted changes sitting well past its last commit
    // (or, for a worker that has committed nothing yet, well past when its
    // branch was created) gets flagged: nothing in ahead=0 output alone
    // distinguishes a clean, idle worktree from one silently abandoned
    // mid-edit despite per-unit-commit discipline being required.
    const { dirtyCount, lastActivityMs } = computeDirtyInfo(w.path);

    const aheadIsPositive = aheadCount !== '?' && Number(aheadCount) > 0;
    let referenceMs = null;
    if (aheadIsPositive) {
      const commitDateResult = git(['log', '-1', '--format=%cI'], w.path, { allowFailure: true });
      if (commitDateResult.status === 0 && commitDateResult.stdout) {
        referenceMs = Date.parse(commitDateResult.stdout);
      }
    } else if (metadata['created-at']) {
      referenceMs = Date.parse(metadata['created-at']);
    }
    if (referenceMs === null || Number.isNaN(referenceMs)) {
      // Fallback: whatever HEAD's own commit date is (for ahead=0 this is
      // the base commit's date, a weaker signal than created-at but still
      // better than nothing).
      const fallbackResult = git(['log', '-1', '--format=%cI'], w.path, { allowFailure: true });
      referenceMs = fallbackResult.status === 0 && fallbackResult.stdout
        ? Date.parse(fallbackResult.stdout)
        : null;
    }
    const lastCommitAgeMs = referenceMs !== null && !Number.isNaN(referenceMs) ? now - referenceMs : null;

    const stale = dirtyCount > 0
      && lastCommitAgeMs !== null
      && lastCommitAgeMs > staleMinutes * 60000;

    return {
      branch: w.branch,
      path: w.path,
      lifecycle,
      executionRole,
      aheadCount,
      lastSubject,
      dirtyCount,
      lastActivityAge: lastActivityMs !== null ? formatAgeMs(now - lastActivityMs) : '-',
      lastCommitAge: lastCommitAgeMs !== null ? formatAgeMs(lastCommitAgeMs) : '-',
      stale,
    };
  });

  const displayRows = staleOnly ? rows.filter((r) => r.stale) : rows;

  if (asJson) {
    console.log(JSON.stringify({
      primaryWorktree: primaryPath,
      staleMinutes,
      managed: displayRows,
    }, null, 2));
    return 0;
  }

  console.log(`Primary worktree: ${primaryPath || '(unknown)'}`);

  if (managed.length === 0) {
    console.log('Managed worktrees: (none)');
    return 0;
  }

  if (staleOnly) {
    const staleCount = rows.filter((r) => r.stale).length;
    console.log(`Managed worktrees (${staleCount} stale of ${managed.length}):`);
    if (staleCount === 0) {
      console.log('  (none stale)');
      return 0;
    }
  } else {
    console.log(`Managed worktrees (${managed.length}):`);
  }

  for (const r of displayRows) {
    const marker = r.stale ? '\tSTALE-UNCOMMITTED' : '';
    console.log(
      `  ${r.branch}\t${r.path}\tlifecycle=${r.lifecycle}\texecution-role=${r.executionRole}`
      + `\tahead=${r.aheadCount}\tlast-commit="${r.lastSubject}"`
      + `\tdirty=${r.dirtyCount} files\tlast-activity=${r.lastActivityAge}\tlast-commit-age=${r.lastCommitAge}`
      + marker,
    );
  }
  return 0;
}

async function commandCreate(flags, positional, config) {
  if (flags.worker && flags.install) {
    throw new Error(
      'refusing to combine --worker and --install: worker worktrees must not run a post-create install command',
    );
  }

  const repo = discoverRepo(process.cwd());
  assertNoFixtureGitIdentity(repo.topLevel, config);

  const label = flags.name || positional.join(' ');
  if (!label) {
    throw new Error('missing worktree label: pass --name "<label>" or a positional label');
  }

  const toolId = flags.tool || detectWorktreeTool(process.env, config);
  checkCapacity(repo, config);

  const branchName = allocateWorktreeBranchName(repo, label, toolId, config);
  const worktreeRoot = flags.worktreeRoot || join(homedir(), toolConfig(toolId, config).home, 'worktrees');
  const worktreePath = uniqueWorktreePath(worktreeRoot, branchName);

  const baseBranch = flags.base || repo.branchShort;
  if (!baseBranch) {
    throw new Error('cannot determine a base branch: HEAD is detached and no --base was given');
  }
  // `baseBranch` may be a fully-qualified remote ref (e.g. "origin/develop",
  // passed explicitly via --base so `create` branches from the remote's
  // exact tip rather than a possibly-stale local branch). What gets stored
  // in metadata as `base-ref` -- and later read back by `finish` to build a
  // fetch/rebase/push refspec against `${remoteName}/${baseBranch}` -- must
  // be the plain local branch name, never a remote-prefixed ref, or finish
  // ends up fetching a malformed ref like "refs/heads/origin/develop".
  const normalizedBaseRef = normalizeBaseRef(baseBranch, repo.topLevel);

  // With several parallel workers finishing and pushing to the shared
  // remote, a plain local branch name like "develop" can be minutes stale by
  // the time a *new* worktree is created from it. Whenever that local branch
  // has a configured upstream, fetch it first and base the new worktree on
  // the freshly-fetched remote-tracking ref instead of the possibly-stale
  // local one. This only ever updates refs/remotes/<remote>/<branch> -- it
  // never touches the primary checkout's own branch ref or working tree.
  // Fetch failure is loud (throws) unless --offline is passed, in which case
  // it warns and falls back to the local branch.
  let effectiveBaseRef = baseBranch;
  const branchUpstream = normalizedBaseRef === baseBranch
    ? resolveBranchUpstreamRemote(baseBranch, repo.topLevel)
    : null;
  if (branchUpstream) {
    const remoteRef = `${branchUpstream.remote}/${branchUpstream.remoteBranch}`;
    if (flags.offline) {
      console.error(
        `[worktree-guard] --offline: skipping fetch of ${remoteRef}; basing "${branchName}" on the local branch `
        + `"${baseBranch}", which may be stale relative to the remote.`,
      );
    } else {
      const fetchResult = git(
        ['fetch', branchUpstream.remote, `+refs/heads/${branchUpstream.remoteBranch}:refs/remotes/${remoteRef}`],
        repo.topLevel,
        { allowFailure: true },
      );
      if (fetchResult.status !== 0) {
        throw new Error(
          `failed to fetch ${remoteRef} before creating the worktree (offline? pass --offline `
          + `to base on the local branch "${baseBranch}" instead, accepting it may be stale): `
          + `${fetchResult.stderr || fetchResult.stdout}`,
        );
      }
      effectiveBaseRef = remoteRef;
    }
  }

  const baseSha = gitText(['rev-parse', effectiveBaseRef], repo.topLevel);

  if (flags.dryRun) {
    console.log(`[dry-run] would create branch "${branchName}" at "${worktreePath}" from ${effectiveBaseRef}@${baseSha}`);
    return 0;
  }

  const primaryPath = repo.primaryWorktree ? repo.primaryWorktree.path : repo.topLevel;

  mkdirSync(dirname(worktreePath), { recursive: true });

  // `git worktree add` below creates a new refs/heads/<branchName> ref while
  // running with cwd = repo.topLevel (the PRIMARY worktree in the normal
  // case) -- if a primary-lock hook is already installed there from a prior
  // `create` (step further down always installs/refreshes it), this write
  // would be blocked as coming from a non-human AI context. Bracket it with
  // a short-lived bypass marker so the tool's own sanctioned worktree-add
  // always succeeds regardless.
  const hooksDir = primaryLockHooksDirFor(primaryPath);
  const marker = createBypassMarker(hooksDir);
  try {
    git(['worktree', 'add', '-b', branchName, worktreePath, effectiveBaseRef], repo.topLevel, { allowFailure: false });
  } catch (error) {
    // Only remove partial state when a registered kit proves its own checkout is safe.
    // If proof or removal fails, retain the path for inspection instead of risking local kit data.
    try {
      removeWorktreeSafely({
        projectRoot: worktreePath,
        worktreePath,
        primaryPath: repo.topLevel,
        force: true,
      });
    } catch (cleanupError) {
      throw new Error(
        `worktree creation failed; cleanup was not proven or completed for ${worktreePath}; inspect any remaining partial state: `
        + `${cleanupError.message}; original error: ${error.message}`,
      );
    }
    throw new Error(`worktree creation failed, cleaned up partial state: ${error.message}`);
  } finally {
    removeBypassMarker(marker);
  }

  try {
    // Consumer hooks and later CLI imports must see the exact parent gitlink pin.
    prepareAndCheckKit(worktreePath);
  } catch (error) {
    throw new Error(`worktree exists at ${worktreePath}, but its registered kit could not be prepared and verified; inspect it before use: ${error.message}`);
  }

  writeWorktreeMetadata(worktreePath, {
    managed: 'true',
    'created-by': toolId,
    lifecycle: 'active',
    'worktree-path': worktreePath,
    'primary-worktree-path': primaryPath,
    'base-ref': normalizedBaseRef,
    'base-sha': baseSha,
    'created-at': new Date().toISOString(),
    ...(flags.worker ? { 'execution-role': 'worker' } : {}),
  }, config);

  // Default AI git identity on the new worktree -- best-effort, a missing
  // identity here shouldn't undo an otherwise-successful creation.
  git(['config', '--worktree', 'user.name', config.identity.name], worktreePath, { allowFailure: true });
  git(['config', '--worktree', 'user.email', config.identity.email], worktreePath, { allowFailure: true });

  installStashGuardHook(worktreePath, config);

  try {
    installPrimaryLockHook(primaryPath, `worktree-create:${toolId}`, config);
  } catch (error) {
    console.error(`[worktree-guard] warning: failed to install/refresh the primary-lock hook: ${error.message}`);
  }

  // The dependencies installed here must match THIS worktree's lockfile before
  // the path is handed out. A worker role never installs (it only gets a WARN
  // with the repair command), unless it was explicitly given the dependency
  // lane with --with-deps. Feature is off while nodeDeps.lockfile is empty.
  if (!flags.worker || flags.withDeps) {
    const deps = ensureNodeDepsMatchLockfile({ worktreeRoot: worktreePath, config, mode: 'install' });
    if (deps.status === 'failed') {
      console.error(
        `[worktree-guard] ${deps.message}\n`
        + `[worktree-guard] the worktree exists at ${worktreePath} but is NOT ready; repair it as above, or remove it.`,
      );
      return 1;
    }
  } else {
    ensureNodeDepsMatchLockfile({ worktreeRoot: worktreePath, config, mode: 'check' });
  }

  if (flags.install && config.postCreateInstallCommand) {
    const installResult = spawnSync(config.postCreateInstallCommand, {
      cwd: worktreePath,
      shell: true,
      stdio: 'inherit',
    });
    if (installResult.status !== 0) {
      console.error(`[worktree-guard] warning: post-create install command exited with status ${installResult.status}`);
    }
  }

  await runProjectHook({
    projectRoot: worktreePath,
    phase: 'afterCreate',
    context: { worktreePath, branch: branchName, baseRef: normalizedBaseRef, baseSha },
  });
  try {
    prepareAndCheckKit(worktreePath);
  } catch (error) {
    throw new Error(`afterCreate completed, but the registered kit is no longer prepared and safe at ${worktreePath}: ${error.message}`);
  }

  if (flags.withDeps) {
    const clientNames = resolveClientSelection(flags.withDeps, config);
    for (const clientName of clientNames) {
      const client = config.clients?.[clientName];
      if (!client || !client.installCommand) {
        console.error(`[worktree-guard] warning: no installCommand configured for client "${clientName}" -- skipping`);
        continue;
      }
      const installResult = spawnSync(client.installCommand, {
        cwd: worktreePath,
        shell: true,
        stdio: 'inherit',
      });
      if (installResult.status !== 0) {
        console.error(`[worktree-guard] warning: --with-deps install for "${clientName}" exited with status ${installResult.status}`);
      }
    }
  }

  console.log(`[worktree-guard] created branch "${branchName}" at ${worktreePath} (base: ${effectiveBaseRef}@${baseSha.slice(0, 12)})`);
  return 0;
}

// Resolve a `--with-deps` flag value to the ordered list of client names to
// install: `true` (bare `--with-deps`) -> [config.defaultClient]; `"all"`
// -> every registered client, in registration order; any other string ->
// that single client name (validated against the registry so a typo fails
// loudly instead of silently installing nothing).
function resolveClientSelection(withDepsFlag, config) {
  const registered = Object.keys(config.clients || {});
  if (withDepsFlag === true) {
    return config.defaultClient ? [config.defaultClient] : registered;
  }
  if (withDepsFlag === 'all') {
    return registered;
  }
  if (!registered.includes(withDepsFlag)) {
    throw new Error(
      `--with-deps=${withDepsFlag}: no such client in config.clients (known: ${registered.join(', ') || '(none registered)'})`,
    );
  }
  return [withDepsFlag];
}

function commandClientCheck(flags, positional, config) {
  const clientName = flags.app || config.defaultClient;
  if (!clientName) {
    console.error('[worktree-guard] client-check: pass --app <client> or set config.defaultClient');
    return 1;
  }
  const client = config.clients?.[clientName];
  if (!client) {
    const known = Object.keys(config.clients || {}).join(', ') || '(none registered)';
    console.error(`[worktree-guard] client-check: no such client "${clientName}" in config.clients (known: ${known})`);
    return 1;
  }
  const baseCommand = flags.typecheck ? client.typecheckCommand : client.testCommand;
  if (!baseCommand) {
    const which = flags.typecheck ? 'typecheckCommand' : 'testCommand';
    console.error(`[worktree-guard] client-check: no ${which} configured for client "${clientName}"`);
    return 1;
  }
  // Any positional args (e.g. specific test files) are appended verbatim to
  // the configured command string, which is then run through the shell --
  // matches how `--install`/`--with-deps` already run their commands.
  const fullCommand = positional.length > 0 ? `${baseCommand} ${positional.join(' ')}` : baseCommand;
  const result = spawnSync(fullCommand, {
    cwd: process.cwd(),
    shell: true,
    stdio: 'inherit',
  });
  return result.status === 0 ? 0 : (result.status ?? 1);
}

/**
 * After a rebase or merge the lockfile may have changed under the installed
 * dependencies. Repair that before anything is pushed; a failed repair stops the
 * finish (the worktree and the remote are left untouched). A worktree whose
 * dependencies were never provisioned is left alone.
 */
function assertNodeDepsMatchLockfile(cwd, config) {
  const deps = ensureNodeDepsMatchLockfile({ worktreeRoot: cwd, config, mode: 'install', provisionIfMissing: false });
  if (deps.status === 'failed') throw new Error(deps.message);
}

async function finalizeIntegration(cwd, config, remoteRef, mode, sources) {
  // Reconcile a changed gitlink only after Git has produced the integrated parent tree.
  prepareAndCheckKit(cwd);
  assertNodeDepsMatchLockfile(cwd, config);
  await runStableLifecycleHook(cwd, 'verifyCandidate', { remoteRef, mode, sources }, { requireClean: true });
  return { mode, sources };
}

/**
 * Bring HEAD onto the freshly fetched `remoteRef`.
 *
 * Ordinary branch: `git rebase`, then re-author the new commits. A branch that
 * carries a merge commit of its own (for example a back-merge made with
 * `git merge --no-ff origin/main`) must NOT be rebased -- a rebase drops the
 * merge. It is kept instead:
 *   - the target has not moved (`remoteRef` is already an ancestor of HEAD): the
 *     unpublished commits are re-created under the AI identity with their
 *     parents and trees intact;
 *   - the target moved: the merge is re-done on the new tip with
 *     `git merge --no-ff`. A conflict aborts, restores HEAD, and throws with the
 *     manual instructions; nothing half-done is ever pushed.
 *
 * @returns {Promise<{mode: 'rebase'|'preserve-merges', sources: string[]}>} `sources` are the
 *   merged-in tips (second parents) the push must make ancestors of the target.
 */
async function integrateOntoRemote(lock, repo, config, remoteRef) {
  const cwd = repo.topLevel;

  if (hasFirstParentMerge(cwd, `${remoteRef}..HEAD`)) {
    const merges = listFirstParentMerges(cwd, `${remoteRef}..HEAD`);
    console.log(
      `[worktree-guard] merge-preserving finish onto ${remoteRef}: ${merges.length} merge commit(s) on this branch `
      + `(${merges.map((merge) => merge.sha.slice(0, 10)).join(', ')}); the branch is not rebased`,
    );
    if (!isAncestor(cwd, remoteRef, 'HEAD')) {
      await yieldToEventLoop();
      if (lock.holdExpired()) throw new FinishLockHoldTimeoutError(lock.maxHoldMs, 'merge-preserving redo');
      console.log(`[worktree-guard] ${remoteRef} moved since this branch's merge was made; re-doing the merge on the new tip`);
      const redo = redoMergesOnTip(cwd, remoteRef, gitText(['rev-parse', 'HEAD'], cwd), {
        identityArgs: gitIdentityArgs(config),
        env: gitIdentityEnv(config),
        run: (args, runCwd, options = {}) => git(args, runCwd, { allowFailure: true, retry: false, ...options }),
      });
      if (!redo.ok) throw new Error(redo.error);
    }
    reauthorUnpushedCommitsToAiIdentity(cwd, remoteRef, config);
    const sources = listFirstParentMerges(cwd, `${remoteRef}..HEAD`).flatMap((merge) => merge.parents.slice(1));
    return finalizeIntegration(cwd, config, remoteRef, 'preserve-merges', sources);
  }

  const rebaseResult = await lockedGit(
    lock,
    [...gitIdentityArgs(config), 'rebase', remoteRef],
    cwd,
    { env: gitIdentityEnv(config) },
  );
  if (rebaseResult.status !== 0) {
    // Read the conflict list BEFORE aborting: abort clears it.
    const conflicted = gitRaw(['diff', '--name-only', '-z', '--diff-filter=U'], cwd)
      .stdout.split('\0').filter(Boolean);
    git(['rebase', '--abort'], cwd, { allowFailure: true });
    throw new Error(
      `rebase onto ${remoteRef} failed`
      + `${conflicted.length ? ` (conflicting files: ${conflicted.join(', ')})` : ''}: `
      + `${rebaseResult.stderr || rebaseResult.stdout}`,
    );
  }
  reauthorUnpushedCommitsToAiIdentity(cwd, remoteRef, config);
  return finalizeIntegration(cwd, config, remoteRef, 'rebase', []);
}

async function commandFinish(flags, positional, config) {
  const repo = discoverRepo(process.cwd());
  assertNoFixtureGitIdentity(repo.topLevel, config);

  const metadata = readWorktreeMetadata(repo.topLevel, config);
  if (metadata.managed !== 'true') {
    console.error('[worktree-guard] this doesn\'t look like a managed worktree (no managed=true metadata found)');
    return 1;
  }

  const baseBranch = flags.base || metadata['base-ref'];
  if (!baseBranch) {
    console.error('[worktree-guard] cannot determine the base branch: pass --base or use a worktree created by this tool');
    return 1;
  }

  let message = typeof flags.message === 'string' ? flags.message : undefined;
  if (!message && typeof flags.messageFile === 'string') {
    message = readFileSync(flags.messageFile, 'utf8');
  }
  if (!message) message = 'chore: worktree-guard finish';

  await runProjectHook({
    projectRoot: repo.topLevel,
    phase: 'beforeCandidate',
    context: { branch: repo.branchShort, baseBranch },
  });
  const statusResult = git(['status', '--porcelain'], repo.topLevel);
  if (statusResult.stdout) {
    git(['add', '-A'], repo.topLevel, { allowFailure: false });
    git(
      [...gitIdentityArgs(config), 'commit', '-m', message],
      repo.topLevel,
      { allowFailure: false, env: gitIdentityEnv(config) },
    );
  }

  const upstream = resolveUpstream(repo.topLevel);
  const remoteName = upstream.remote || 'origin';
  const remoteRef = `${remoteName}/${baseBranch}`;

  const deletedFiles = computeDeletedTrackedFiles(repo.topLevel, remoteRef);
  const massDeletion = classifyMassDeletion(deletedFiles, config);
  if (massDeletion.isMassDeletion && !flags.allowMassDeletion) {
    console.error(
      `[worktree-guard] refusing to finish: mass deletion detected `
      + `(${massDeletion.deletedCount} tracked file(s) deleted relative to ${remoteRef}`
      + `${massDeletion.criticalHits.length ? `, including critical path(s): ${massDeletion.criticalHits.join(', ')}` : ''}). `
      + `Pass --allow-mass-deletion to override if this is intentional.`,
    );
    return 1;
  }

  const stateDir = config.stateDirAbs ?? resolveStateDirAbs(repo, config);
  const lock = flags.noWait
    ? acquireFinishLock(stateDir, { dryRun: flags.dryRun, worktree: repo.branchShort, config })
    : await acquireFinishLockQueued(stateDir, {
      worktree: repo.branchShort,
      timeoutMs: flags.waitTimeoutMin ? Number(flags.waitTimeoutMin) * 60000 : undefined,
      config,
    });
  const heartbeat = startFinishLockHeartbeat(stateDir, repo.branchShort, config);
  // Stopped by release(), including when a signal releases the lock.
  lock.addCleanup(() => heartbeat.stop());
  const setPhase = (phase) => {
    lock.setPhase(phase);
    heartbeat.setPhase(phase);
  };

  try {
    // Every fetch / rebase / push below runs under the hold budget.
    setPhase('fetch');
    await lockedGit(
      lock,
      ['fetch', remoteName, `+refs/heads/${baseBranch}:refs/remotes/${remoteName}/${baseBranch}`],
      repo.topLevel,
      { allowFailure: false },
    );

    setPhase('rebase');
    let integration = await integrateOntoRemote(lock, repo, config, remoteRef);

    if (flags.noPush) {
      console.log(integration.mode === 'preserve-merges'
        ? '[worktree-guard] merged onto latest (merge-preserving); skipping push and worktree cleanup (--no-push).'
        : '[worktree-guard] rebased onto latest; skipping push and worktree cleanup (--no-push).');
      return 0;
    }

    setPhase('push');
    let pushed = false;
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runStableLifecycleHook(repo.topLevel, 'beforePush', {
        remote: remoteName,
        baseBranch,
        remoteRef,
        attempt,
        integrationMode: integration.mode,
        mergedSources: integration.sources,
      }, { requireClean: true });
      const res = await lockedGit(
        lock,
        ['push', remoteName, `HEAD:refs/heads/${baseBranch}`],
        repo.topLevel,
        { env: gitIdentityEnv(config) },
      );
      if (res.status === 0) { pushed = true; break; }
      lastError = res.stderr;
      if (!/non-fast-forward|fetch first|stale info|rejected/i.test(res.stderr) || attempt === 5) break;

      await sleepAsync(5000 + Math.random() * 15000);
      await lockedGit(
        lock,
        ['fetch', remoteName, `+refs/heads/${baseBranch}:refs/remotes/${remoteName}/${baseBranch}`],
        repo.topLevel,
        { allowFailure: false },
      );
      try {
        integration = await integrateOntoRemote(lock, repo, config, remoteRef);
      } catch (error) {
        lastError = `could not integrate the moved ${remoteRef} during retry: ${error.message}`;
        break;
      }
    }
    if (!pushed) throw new Error(`push failed after retries: ${lastError}`);

    // A merge-preserving finish exists to create an ancestry link, so read it
    // back from the remote instead of trusting that the push did what we meant.
    if (integration.sources.length > 0) {
      await lockedGit(
        lock,
        ['fetch', remoteName, `+refs/heads/${baseBranch}:refs/remotes/${remoteName}/${baseBranch}`],
        repo.topLevel,
        { allowFailure: false },
      );
      const missing = integration.sources.filter((sha) => !isAncestor(repo.topLevel, sha, remoteRef));
      if (missing.length > 0) {
        console.error(
          `[worktree-guard] merge ancestry check FAILED after push: ${missing.map((sha) => sha.slice(0, 10)).join(', ')} `
          + `is not an ancestor of ${remoteRef}. The push DID land; the worktree is kept for inspection.`,
        );
        return 1;
      }
      console.log(
        `[worktree-guard] merge ancestry verified: ${integration.sources.map((sha) => sha.slice(0, 10)).join(', ')} `
        + `is an ancestor of ${remoteRef}`,
      );
    }

    try {
      await runStableLifecycleHook(repo.topLevel, 'afterLand', {
        remote: remoteName,
        baseBranch,
        remoteRef,
        head: gitText(['rev-parse', 'HEAD'], repo.topLevel),
      }, { requireClean: true });
    } catch (error) {
      throw new Error(`push DID land on ${remoteRef}, but afterLand hook failed; worktree and branch are preserved for inspection: ${error.message}`);
    }

    setPhase('cleanup');

    // These two writes happen with cwd = the PRIMARY worktree (the worker
    // worktree itself is being removed, so they can't run from inside it):
    // branch -D deletes a refs/heads/<prefix>* ref, which the primary-lock
    // hook (if installed) would otherwise attribute to this AI-parented
    // process and block. Use the tool's own internal bypass token -- this is
    // the sanctioned cleanup half of a `finish` the CLI already validated
    // above, not a raw ad hoc git command.
    const bypassEnv = primaryLockBypassEnv(config);
    removeWorktreeSafely({
      projectRoot: repo.topLevel,
      worktreePath: repo.topLevel,
      primaryPath: repo.primaryWorktree.path,
      force: true,
      env: bypassEnv,
      deleteBranch: repo.branchShort,
      beforeRemove: () => writeWorktreeMetadata(repo.topLevel, { lifecycle: 'merged' }, config),
    });

    console.log(`[worktree-guard] finished and pushed to ${remoteName}/${baseBranch}. Remember to run: worktree-guard sync-primary`);
    return 0;
  } finally {
    lock.release(); // also stops the heartbeat and removes the signal handlers
  }
}

/**
 * Gate for a worker or AI-parented caller. Precedence:
 *   1. the explicit approval variable always wins (human path, scan not run);
 *   2. otherwise a worker context is refused outright, idle or not;
 *   3. a top-level AI session is allowed only when the idle scan finds nothing
 *      active (config.syncPrimary.idleSelfAuthorize, default on);
 *   4. everything else is refused and needs the approval variable.
 * Returns 0 to continue, 1 to refuse (already reported).
 */
function gateSyncPrimary({ repo, config, workerContext, aiParent, idleSeams }) {
  const approvedBy = process.env[config.envVars.syncPrimaryApprovedBy];
  const gateReason = `gated-context(worker=${workerContext},ai-parent=${aiParent.via ?? 'no'})`;
  const approvalHint = `A human or orchestrator must explicitly approve this sync by setting ${config.envVars.syncPrimaryApprovedBy}.`;

  if (approvedBy) {
    appendPrimaryAuditLog(repo, config, { decision: 'allowed', result: 'allowed-override', reason: `approved-by=${approvedBy}` });
    return 0;
  }

  const settings = syncPrimarySettings(config);
  if (workerContext || !settings.idleSelfAuthorize) {
    appendPrimaryAuditLog(repo, config, { decision: 'blocked', result: 'refused', reason: gateReason });
    console.error(
      `[worktree-guard] sync-primary refused: running from a worker/AI-parented context without `
      + `${config.envVars.syncPrimaryApprovedBy} set. ${approvalHint}`
      + (workerContext
        ? ' A worker is never eligible for idle self-authorization.'
        : ' (idle self-authorization is turned off by syncPrimary.idleSelfAuthorize)'),
    );
    return 1;
  }

  // Top-level AI session, no approval variable: allowed only when nothing else is active.
  const stateDir = config.stateDirAbs ?? resolveStateDirAbs(repo, config);
  const idle = checkOtherAiActivity({ repo, stateDir, config, seams: idleSeams });
  for (const line of idle.report) console.log(`[worktree-guard] sync-primary idle-check: ${line}`);
  if (idle.busy) {
    appendPrimaryAuditLog(repo, config, {
      decision: 'blocked',
      result: 'refused-busy',
      reason: `${gateReason}; busy: ${idle.reasons.join('; ')}`,
    });
    console.error(`[worktree-guard] sync-primary refused: other activity detected (${idle.reasons.join('; ')}).`);
    console.error(`[worktree-guard] Wait for it to clear and retry. ${approvalHint}`);
    return 1;
  }
  appendPrimaryAuditLog(repo, config, {
    decision: 'allowed',
    result: 'allowed-ai-idle',
    reason: `idle-self-authorized(ai-parent=${aiParent.via ?? 'no'})`,
  });
  console.log('[worktree-guard] sync-primary self-authorized: no other activity detected (top-level AI session, not a worker).');
  return 0;
}

function commandSyncPrimary(flags, config, deps = {}) {
  const repo = discoverRepo(process.cwd());

  const workerContext = String(process.env[config.envVars.workerRole] || '') === 'worker'
    || !samePath(repo.topLevel, repo.primaryWorktree ? repo.primaryWorktree.path : repo.topLevel);
  // Two signals, either is enough: an AI-CLI environment marker (works at any
  // wrapper depth) or the ancestor process chain.
  const aiParent = detectAiParent({ env: process.env, config });
  if (workerContext || aiParent.aiParented) {
    if (gateSyncPrimary({ repo, config, workerContext, aiParent, idleSeams: deps.idleSeams }) !== 0) return 1;
  }

  if (!samePath(repo.topLevel, repo.primaryWorktree ? repo.primaryWorktree.path : repo.topLevel)) {
    console.error('[worktree-guard] sync-primary must be run from the primary worktree.');
    return 1;
  }
  if (!repo.branchShort) {
    console.error('[worktree-guard] sync-primary cannot run on a detached HEAD.');
    return 1;
  }
  const statusResult = git(['status', '--porcelain'], repo.topLevel);
  if (statusResult.stdout) {
    console.error('[worktree-guard] sync-primary refused: the primary worktree is not clean.');
    return 1;
  }

  const upstream = resolveUpstream(repo.topLevel);
  const remoteName = upstream.remote || 'origin';
  const remoteBranch = upstream.branch || repo.branchShort;

  if (flags.dryRun) {
    console.log(`[dry-run] would fetch ${remoteName}/${remoteBranch} and fast-forward-merge it into ${repo.branchShort}`);
    return 0;
  }

  // sync-primary IS the sanctioned pathway for advancing the primary
  // worktree, so its own fetch/merge always carry the internal bypass token
  // -- the JS-level approval gate above already did the real gatekeeping.
  const bypassEnv = primaryLockBypassEnv(config);
  git(
    ['fetch', remoteName, `+refs/heads/${remoteBranch}:refs/remotes/${remoteName}/${remoteBranch}`],
    repo.topLevel,
    { allowFailure: false, env: bypassEnv },
  );
  const mergeResult = git(
    ['merge', '--ff-only', `${remoteName}/${remoteBranch}`],
    repo.topLevel,
    { allowFailure: true, env: bypassEnv },
  );
  if (mergeResult.status !== 0) {
    console.error(`[worktree-guard] fast-forward failed -- never force-merges: ${mergeResult.stderr}`);
    return 1;
  }

  const newHead = gitText(['rev-parse', '--short', 'HEAD'], repo.topLevel);
  console.log(`[worktree-guard] primary fast-forwarded to ${newHead}`);
  return 0;
}

async function commandCleanup(flags, config) {
  const repo = discoverRepo(process.cwd());

  if (flags.reclaimStale) {
    const stateDir = config.stateDirAbs ?? resolveStateDirAbs(repo, config);
    const outcome = await reclaimStaleWorktrees(repo, config, {
      staleDays: flags.staleDays,
      apply: Boolean(flags.apply),
      allowRecent: Boolean(flags.allowRecent),
      usePatchId: !flags.noPatchId,
      worktreeRoot: flags.worktreeRoot,
      stateDir,
      // The sanctioned removal of a worktree/branch from the primary checkout.
      env: primaryLockBypassEnv(config),
    });
    if (!flags.apply && !outcome.refused) {
      console.log(`[worktree-guard] reclaim-stale is a dry run; pass --apply to remove the worktrees listed as "would be reclaimed".`);
    }
    return outcome.exitCode;
  }

  let cleaned = 0;
  for (const w of repo.worktrees) {
    if (repo.primaryWorktree && w.path === repo.primaryWorktree.path) continue;
    const metadata = readWorktreeMetadata(w.path, config);
    if (metadata.lifecycle === 'merged') {
      // A "merged" worktree that was touched moments ago may be another
      // session's still-live checkout: leave it unless the caller insists.
      if (!flags.allowRecent) {
        const activity = recentWorktreeActivity(w.path, config);
        if (activity.recent) {
          console.log(`[worktree-guard] cleanup-skipped:${w.path} (${activity.reason}; pass --allow-recent to override)`);
          continue;
        }
      }
      try {
        removeWorktreeSafely({
          projectRoot: w.path,
          worktreePath: w.path,
          primaryPath: repo.primaryWorktree.path,
          beforeRemove: () => makeOwnedTreeWritable(w.path),
        });
        cleaned += 1;
      } catch (error) {
        console.error(`[worktree-guard] cleanup-skipped:${w.path} (${error.message})`);
      }
    }
  }
  console.log(`[worktree-guard] cleaned up ${cleaned} merged worktree(s).`);
  return 0;
}

function commandDepsSync(flags, config) {
  const repo = discoverRepo(process.cwd());
  const deps = ensureNodeDepsMatchLockfile({ worktreeRoot: repo.topLevel, config, mode: 'install' });
  if (deps.status === 'failed') {
    console.error(`[worktree-guard] ${deps.message}`);
    return 1;
  }
  if (deps.status === 'off') console.log(`[worktree-guard] deps-sync: nothing to do (${deps.reason})`);
  return 0;
}

function commandStashAudit(flags, config) {
  const repo = discoverRepo(process.cwd());
  const dangling = findSuspiciousDanglingStashCommits(repo);
  const mismatch = findStashReflogValueMismatch(repo.topLevel);

  let problems = dangling.length + (mismatch ? 1 : 0);

  if (dangling.length > 0) {
    console.log(`Found ${dangling.length} suspicious dangling stash-like commit(s):`);
    for (const finding of dangling) {
      console.log(`  ${finding.sha}  ${finding.subject}`);
      console.log(`    recover: git stash apply ${finding.sha}`);
    }
  }
  if (mismatch) {
    console.log(`refs/stash resolves to ${mismatch.ref} but its reflog is empty (possible truncated stash history).`);
    console.log(`  recover: git stash apply ${mismatch.ref}`);
  }
  if (problems === 0) {
    console.log('No stash irregularities found.');
  }

  return flags.strict && problems > 0 ? 1 : 0;
}

function commandStashGuard(flags, positional, config) {
  const sub = positional[0] || 'status';
  const cwd = process.cwd();

  if (sub === 'repair') {
    installStashGuardHook(cwd, config);
    console.log('[worktree-guard] stash-guard hook (re)installed.');
    return 0;
  }

  const status = stashGuardStatus(cwd, config);
  console.log(`installed=${status.installed} intact=${status.intact} hooksPath=${status.hooksPath ?? '(none)'}`);
  return 0;
}

function commandPrimaryLock(flags, config) {
  const repo = discoverRepo(process.cwd());
  const primaryPath = repo.primaryWorktree ? repo.primaryWorktree.path : repo.topLevel;
  installPrimaryLockHook(primaryPath, flags.lockedBy || 'manual', config);
  console.log(`[worktree-guard] primary-lock hook installed on ${primaryPath}`);
  return 0;
}

function commandPrimaryAudit(flags, config) {
  const repo = discoverRepo(process.cwd());
  const primaryPath = repo.primaryWorktree ? repo.primaryWorktree.path : repo.topLevel;

  console.log(`Branch: ${repo.branchShort ?? '(detached)'}`);
  const statusResult = git(['status', '--porcelain'], repo.topLevel);
  console.log(`Clean: ${statusResult.stdout ? 'no' : 'yes'}`);

  const reflog = git(['reflog', 'show', '-n', '3', '--date=iso-strict', 'HEAD'], repo.topLevel);
  console.log('Recent HEAD reflog:');
  console.log(reflog.stdout || '(none)');

  console.log(`Primary-lock hook installed: ${primaryLockHookIsInstalled(primaryPath, config)}`);

  const logPath = primaryAuditLogPath(primaryPath, config);
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-5);
    console.log(`Audit log tail (${logPath}):`);
    for (const line of tail) console.log(`  ${line}`);
  } else {
    console.log(`Audit log not found at ${logPath}.`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// §4 help
// ---------------------------------------------------------------------------

const COMMAND_DESCRIPTIONS = [
  ['status', 'Show the primary worktree and all managed worktrees (--stale, --stale-minutes <N>, --json).'],
  ['create | begin', 'Create a new managed worktree and branch (--offline, --with-deps[=<client>|all]).'],
  ['finish | end', 'Commit, rebase, push, and clean up a managed worktree.'],
  ['sync-primary', 'Fast-forward the primary worktree to its upstream.'],
  ['cleanup', 'Remove managed worktrees whose lifecycle=merged (--allow-recent skips the 2h activity floor).'],
  ['cleanup --reclaim-stale', 'Reclaim abandoned worktrees: --stale-days <n> (required) [--apply] [--allow-recent] [--no-patch-id] [--worktree-root <dir>]. Dry run unless --apply.'],
  ['deps-sync', 'Make installed dependencies match the lockfile (nodeDeps config); repairs a stale worktree, fails closed.'],
  ['client-check', 'Run a registered client\'s test (or --typecheck) command: -- --app <client> [files...]'],
  ['stash-audit', 'Look for signs of a lost or damaged git stash.'],
  ['stash-guard <status|repair>', 'Inspect or reinstall the stash-guard hook.'],
  ['primary-lock', 'Install/refresh the primary-worktree lock hook.'],
  ['primary-audit', 'Print primary-worktree status and recent audit-log entries.'],
];

function printHelp(target) {
  if (target) {
    console.log(`worktree-guard ${target} --help`);
    console.log('');
  }
  console.log('Usage: worktree-guard <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const [name, desc] of COMMAND_DESCRIPTIONS) {
    console.log(`  ${name.padEnd(28)}${desc}`);
  }
}

// ---------------------------------------------------------------------------
// §5 dispatch
// ---------------------------------------------------------------------------

export async function main(argv, deps = {}) {
  const { command, flags, positional, help, helpTarget } = parseArgs(argv);
  if (help) {
    printHelp(helpTarget);
    return 0;
  }
  try {
    const config = loadConfig(flags.config);
    if (command === 'status') return commandStatus(flags, config);
    if (command === 'create' || command === 'begin') return await commandCreate(flags, positional, config);
    if (command === 'finish' || command === 'end') return await commandFinish(flags, positional, config);
    if (command === 'sync-primary') return commandSyncPrimary(flags, config, deps);
    if (command === 'cleanup') return await commandCleanup(flags, config);
    if (command === 'deps-sync') return commandDepsSync(flags, config);
    if (command === 'client-check') return commandClientCheck(flags, positional, config);
    if (command === 'stash-audit') return commandStashAudit(flags, config);
    if (command === 'stash-guard') return commandStashGuard(flags, positional, config);
    if (command === 'primary-lock') return commandPrimaryLock(flags, config);
    if (command === 'primary-audit') return commandPrimaryAudit(flags, config);
    console.error(`[worktree-guard] unknown command: ${command}`);
    printHelp();
    return 1;
  } catch (error) {
    console.error(`[worktree-guard] ${error.message}`);
    return 1;
  }
}

// Robust "am I the entry script" check: a plain `import.meta.url ===
// 'file://' + process.argv[1]` string-concat can mismatch across symlinks or
// relative/absolute path differences, so both sides are resolved to real
// filesystem paths and compared instead.
const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
