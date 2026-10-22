// worktree-guard/reclaim-stale.mjs
//
// `cleanup --reclaim-stale --stale-days <n> [--apply] [--allow-recent]`
//
// Reclaims REGISTERED managed worktrees whose owning session is gone (crashed,
// closed, or switched away). The ordinary `cleanup` only removes worktrees a
// finished session marked `lifecycle=merged`; a session that never got to finish
// leaves a registered worktree no other command will ever touch, and they pile
// up (disk, `git worktree list` noise, the capacity limit in `create`).
//
// This is the most destructive cleanup mode, so every rule below errs toward
// leaving the worktree alone:
//   - dry-run by default; `--apply` is the only thing that removes anything;
//   - `--stale-days` is mandatory. There is no implicit age;
//   - a worktree is reclaimed only if EVERY gate holds (see assessReclaimCandidate);
//     the first failing gate is not enough to stop evaluating -- all reasons are
//     collected and printed so the operator sees everything that blocks it;
//   - "landed" is judged against ONE deterministic base ref (never "try several
//     bases until one says yes");
//   - a registered kit must first prove its checkout is safe to remove; only
//     then may that verified worktree use `git worktree remove --force` to let
//     Git remove its initialized submodule. Ordinary worktrees use plain remove;
//   - the active-recent floor: any file or git-admin mtime inside
//     `reclaim.activeRecentHours` means somebody is (or just was) working there,
//     and the worktree is refused unless the caller passes --allow-recent;
//   - a live `finish.lock` makes the whole run yield: a finish may itself be in the
//     middle of removing a worktree.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPathWithin, samePathIdentity } from '../lib/path-identity.mjs';

import { makeOwnedTreeWritable } from './writable-tree.mjs';
import { assertKitSafeToRemove } from '../dependencies/submodule.mjs';
import { listProcessCommands } from './process-provenance.mjs';
// eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
import { acquireFinishLockQueued, finishLockPath, finishQueueDir, pidIsAlive, releaseFinishLock } from './finish-lock.mjs';
import {
  assessHeadLanded,
  formatUnmatchedCommits,
  git,
  gitRaw,
  parsePorcelainPaths,
  readWorktreeMetadata,
} from './worktree-core.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Trees that are regenerated or foreign; touching them says nothing about a
// person or agent editing the checkout.
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '.next', '.turbo', '.cache', '__pycache__', '.pytest_cache']);
// Git admin files whose mtime is NOT activity: read-only commands touch them (`git status`
// refreshes `index` and creates/renames `index.lock` in the admin dir, `git fetch` rewrites
// FETCH_HEAD, ...), so counting them made every landed, clean worktree look "just modified" and
// nothing was ever reclaimable. Exported so the tests can pin that none of them is consulted.
export const NON_ACTIVITY_ADMIN_FILES = Object.freeze(['HEAD', 'index', 'ORIG_HEAD', 'FETCH_HEAD', 'config.worktree']);
const REFLOG_TAIL_BYTES = 8192;
// A walk this large is not a normal checkout; stop and treat it as active.
const WALK_ENTRY_LIMIT = 500_000;

const LOG_PREFIX = '[worktree-guard]';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** realpath when the path exists (macOS reports /private/var for /var). */
function canonical(path) {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isSameOrUnder(path, root) {
  return isPathWithin(root, path);
}

/**
 * The directories a managed worktree must live under: the `--worktree-root`
 * the caller passes (use the same value `create` was given) plus each
 * configured tool's default `~/<home>/worktrees`.
 *
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @param {{worktreeRoot?: string|true}} [flags]
 * @returns {string[]}
 */
export function managedWorktreeRoots(config, flags = {}) {
  const roots = Object.values(config.tools || {}).map((tool) => join(homedir(), tool.home, 'worktrees'));
  if (typeof flags.worktreeRoot === 'string' && flags.worktreeRoot) roots.push(resolve(flags.worktreeRoot));
  return roots;
}

// ---------------------------------------------------------------------------
// Activity probes
// ---------------------------------------------------------------------------

function mtimeMsOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // A missing or unreadable file contributes no activity signal.
    return 0;
  }
}

function adminDirOf(worktreePath) {
  try {
    const text = readFileSync(join(worktreePath, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match) return '';
    const dir = match[1].trim();
    return isAbsolute(dir) ? dir : resolve(worktreePath, dir);
  } catch {
    return '';
  }
}

function readTextOf(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The checked-out branch's reflog; branch reflogs live in the COMMON git dir. */
function branchReflogPath(admin) {
  const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readTextOf(join(admin, 'HEAD')));
  if (!head) return '';
  const commonText = readTextOf(join(admin, 'commondir')).trim();
  const common = commonText ? resolve(admin, commonText) : admin;
  return join(common, 'logs', 'refs', 'heads', head[1].trim());
}

/**
 * Timestamp (ms) of the LAST entry of a reflog. A reflog line ends
 * `<name> <email> <unix-ts> <tz>\t<message>`. Falls back to the file mtime
 * only when the file exists but its last line cannot be parsed (never to 0:
 * an unreadable reflog must not read as "idle").
 */
export function lastReflogEntryMs(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    if (size === 0) return 0;
    const length = Math.min(size, REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim());
    const match = /> (\d{9,}) [+-]\d{4}(?:\t|$)/.exec(lines[lines.length - 1] || '');
    return match ? Number(match[1]) * 1000 : mtimeMsOf(path);
  } catch {
    // No reflog (fresh, never-updated ref): no activity signal.
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Newest REAL activity in this worktree: the last HEAD reflog entry and the
 * last entry of the checked-out branch's reflog (a commit, checkout, reset or
 * rebase writes one with its own timestamp; status and fetch never do), the
 * worktree root dir, and every working-tree file outside the skipped
 * dependency/cache directories.
 *
 * Admin-dir, index, HEAD and FETCH_HEAD mtimes are deliberately NOT signals
 * (see NON_ACTIVITY_ADMIN_FILES): read-only git commands touch them.
 *
 * @param {string} worktreePath
 * @returns {{ms: number, what: string, truncated: boolean}}
 */
export function newestWorktreeActivity(worktreePath) {
  let newest = { ms: 0, what: 'nothing' };
  const consider = (ms, what) => {
    if (ms > newest.ms) newest = { ms, what };
  };
  consider(mtimeMsOf(worktreePath), 'worktree root dir');
  const admin = adminDirOf(worktreePath);
  if (admin) {
    consider(lastReflogEntryMs(join(admin, 'logs', 'HEAD')), 'a HEAD reflog entry (commit/checkout/reset)');
    const branchLog = branchReflogPath(admin);
    if (branchLog) consider(lastReflogEntryMs(branchLog), 'a branch reflog entry');
  }

  const stack = [worktreePath];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      seen += 1;
      if (seen > WALK_ENTRY_LIMIT) return { ms: Date.now(), what: 'a very large working tree (walk limit hit)', truncated: true };
      const full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      consider(stat.mtimeMs, `working-tree entry ${full.slice(worktreePath.length + 1)}`);
      if (stat.isDirectory()) stack.push(full);
    }
  }
  return { ...newest, truncated: false };
}

// ---------------------------------------------------------------------------
// Liveness probes (all best-effort and read-only)
// ---------------------------------------------------------------------------

/**
 * True when a `finish.lock` exists and its holder may still be running. An
 * unreadable lock file counts as live: yielding is always the safe answer.
 *
 * @param {string} stateDir
 * @returns {boolean}
 */
export function finishLockIsLive(stateDir) {
  const path = finishLockPath(stateDir);
  if (!existsSync(path)) return false;
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return true;
    // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
    return pidIsAlive(lock.pid);
  } catch {
    return true;
  }
}

/**
 * Canonical worktree paths named by a queued finish whose process is alive.
 * Read-only (unlike `listLiveQueueTickets`, which deletes dead tickets).
 *
 * @param {string} stateDir
 * @returns {Set<string>}
 */
export function livePathsFromFinishQueue(stateDir) {
  const live = new Set();
  const dir = finishQueueDir(stateDir);
  if (!existsSync(dir)) return live;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const ticket = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
      if (ticket.worktree && Number.isInteger(ticket.pid) && pidIsAlive(ticket.pid)) {
        live.add(canonical(String(ticket.worktree)));
      }
    } catch {
      // mid-write or corrupt ticket: ignore, the live-lock gate covers a running finish
    }
  }
  return live;
}

/**
 * Current working directories of all running processes, from `lsof`, or from
 * /proc/<pid>/cwd on Linux hosts that ship no lsof. Returns null when neither
 * is available (the check is then simply skipped: the clean tree, landed HEAD
 * and activity gates still apply).
 *
 * @returns {Set<string>|null}
 */
function procProcessCwds() {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return null; // no /proc (macOS without lsof): the live-process check is skipped
  }
  const cwds = new Set();
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || pid === process.ppid) continue;
    try {
      cwds.add(canonical(readlinkSync(`/proc/${pid}/cwd`)));
    } catch {
      // process exited meanwhile, or another user's process: nothing to learn from it
    }
  }
  return cwds;
}

export function liveProcessCwds({ platform = process.platform, listProcesses = listProcessCommands } = {}) {
  if (platform === 'win32') {
    const processes = listProcesses({ platform });
    const cwds = new Set();
    const unknownPids = [];
    for (const process of processes) {
      if (process.cwdStatus === 'readable' && process.cwd) cwds.add(canonical(process.cwd));
      else if (process.cwdStatus !== 'exited') unknownPids.push(process.pid);
    }
    if (unknownPids.length > 0) Object.defineProperty(cwds, 'unknownPids', { value: unknownPids });
    return cwds;
  }

  const result = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || !result.stdout) return procProcessCwds();
  const cwds = new Set();
  let skip = false;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      skip = pid === process.pid || pid === process.ppid;
    } else if (line.startsWith('n') && !skip) {
      cwds.add(canonical(line.slice(1)));
    }
  }
  return cwds;
}

// ---------------------------------------------------------------------------
// Landing target
// ---------------------------------------------------------------------------

/**
 * The single ref a worktree's HEAD is judged against: `<remote>/<base>` when
 * that remote-tracking ref exists (the shared truth -- a squash merge happens
 * on the remote), otherwise the local `<base>` branch (repos with no remote).
 * Deliberately one answer: trying several bases until one says "landed" would
 * let an unrelated branch vouch for the work.
 *
 * @param {string} cwd
 * @param {string} baseBranch plain branch name
 * @returns {string|null}
 */
export function resolveLandingRef(cwd, baseBranch) {
  const remote = git(['config', '--get', `branch.${baseBranch}.remote`], cwd).stdout || 'origin';
  const remoteRef = `refs/remotes/${remote}/${baseBranch}`;
  if (git(['rev-parse', '--verify', '--quiet', remoteRef], cwd).status === 0) return `${remote}/${baseBranch}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], cwd).status === 0) return baseBranch;
  return null;
}

// ---------------------------------------------------------------------------
// Verdict for one worktree
// ---------------------------------------------------------------------------

function formatDays(ms) {
  return `${(ms / DAY_MS).toFixed(1)}d`;
}

/**
 * @typedef {{
 *   path: string, branch: string|null, removable: boolean, reasons: string[],
 *   deleteBranch: boolean, landedOn: string, landedVia: string, idle: string,
 * }} ReclaimVerdict
 */

/**
 * Decide whether one registered worktree may be reclaimed. Pure with respect to
 * its injected context, so tests can drive every gate.
 *
 * @param {{path: string, branch: string|null}} entry
 * @param {{
 *   config: typeof import('./config.mjs').DEFAULT_CONFIG,
 *   primaryPath: string, currentPath: string, roots: string[],
 *   staleDays: number, allowRecent: boolean, usePatchId: boolean,
 *   nowMs: number, livePaths: Set<string>, liveCwds: Set<string>|null,
 * }} ctx
 * @returns {ReclaimVerdict}
 */
export function assessReclaimCandidate(entry, ctx) {
  const { config } = ctx;
  const path = canonical(entry.path);
  const reasons = [];
  const detached = !entry.branch;
  const branch = detached ? null : entry.branch;
  const verdict = (extra = {}) => ({
    path,
    branch,
    removable: reasons.length === 0,
    reasons,
    deleteBranch: false,
    landedOn: '',
    landedVia: '',
    idle: '',
    tip: '',
    ...extra,
  });

  if (!ctx.roots.some((root) => isSameOrUnder(path, root))) {
    reasons.push('not under a managed worktree root (pass --worktree-root if create used one)');
  }
  if (samePathIdentity(ctx.primaryPath, path)) reasons.push('primary worktree');
  if (samePathIdentity(ctx.currentPath, path)) reasons.push('the worktree this command is running from');
  if (ctx.liveCwds?.unknownPids?.length) {
    reasons.push(`cannot verify working directories of ${ctx.liveCwds.unknownPids.length} process(es)`);
  }
  const prefixes = Object.values(config.tools || {}).map((tool) => tool.prefix);
  if (!detached && !prefixes.some((prefix) => branch.startsWith(prefix))) {
    reasons.push(`branch ${branch} does not use a managed prefix (${prefixes.join(', ')})`);
  }
  if (!existsSync(path)) {
    reasons.push('checkout directory is missing (use `git worktree prune`)');
    return verdict();
  }
  // Structural refusals above never need the expensive probes below.
  if (reasons.length > 0) return verdict();

  // Activity first: it is cheap (reflog tails + an mtime walk) and decides the
  // age every other refusal below is reported against.
  const activity = newestWorktreeActivity(path);
  const idleMs = ctx.nowMs - activity.ms;
  const idle = formatDays(Math.max(0, idleMs));
  const recentHours = Number(config.reclaim?.activeRecentHours ?? 2);
  if (!ctx.allowRecent && idleMs < recentHours * HOUR_MS) {
    const minutes = Math.max(0, Math.round(idleMs / 60_000));
    reasons.push(
      `active-recent: ${activity.what} modified ${minutes}min ago (< ${recentHours}h activity floor); pass --allow-recent to override`,
    );
  }
  if (idleMs < ctx.staleDays * DAY_MS) {
    reasons.push(`younger than --stale-days ${ctx.staleDays} (idle ${idle})`);
  }

  const metadata = readWorktreeMetadata(path, config);
  const baseRef = String(metadata['base-ref'] || '').replace(/^refs\/heads\//, '');
  if (metadata.managed !== 'true') reasons.push('no managed=true metadata (not created by this tool)');
  if (!baseRef) {
    reasons.push('no recorded base-ref');
  } else if (/^[0-9a-f]{7,40}$/i.test(baseRef)) {
    reasons.push(`recorded base "${baseRef}" is a commit id, not a branch name`);
  }

  const status = gitRaw(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], path);
  let dirty = false;
  if (status.status !== 0) {
    reasons.push('git status failed (broken or incomplete checkout)');
    dirty = true;
  } else if (parsePorcelainPaths(status.stdout).length > 0) {
    reasons.push('worktree has uncommitted or untracked files');
    dirty = true;
  }

  if (ctx.liveCwds && [...ctx.liveCwds].some((cwd) => isSameOrUnder(cwd, path))) {
    reasons.push('a running process has this worktree as its working directory');
  }
  if ([...ctx.livePaths].some((livePath) => samePathIdentity(livePath, path))) reasons.push('a live finish ticket names this worktree');

  let landed = null;
  if (baseRef && !/^[0-9a-f]{7,40}$/i.test(baseRef) && !dirty) {
    const landingRef = resolveLandingRef(path, baseRef);
    if (!landingRef) {
      reasons.push(`base branch ${baseRef} was not found locally or on its remote`);
    } else {
      // Patch-id matching re-reads `git log -p` for the whole window and can take
      // minutes on a large or force-pushed base; once this pass's budget is
      // spent, only ancestry is checked and anything needing patch-id is kept.
      // A ctx without a deadline (other read-only callers) has no budget.
      const budgetSpent = ctx.usePatchId && (ctx.now ?? Date.now)() >= (ctx.patchIdDeadlineMs ?? Infinity);
      landed = assessHeadLanded(path, landingRef, { usePatchId: ctx.usePatchId && !budgetSpent });
      if (!landed.landed && budgetSpent) {
        ctx.patchIdBudgetSkipped = (ctx.patchIdBudgetSkipped ?? 0) + 1;
        reasons.push(`patch-id budget (${ctx.patchIdBudgetSeconds}s) for this pass is spent and HEAD is not an ancestor of ${landingRef}; rerun cleanup to check it`);
      } else if (!landed.landed) {
        const detail = landed.unmatched.length > 0
          ? `: ${formatUnmatchedCommits(landed.unmatched).join(' | ')}`
          : '';
        reasons.push(`HEAD is not landed on ${landingRef} (${landed.reason}${detail})`);
      }
    }
  }

  const tip = git(['rev-parse', 'HEAD'], path);
  return verdict({
    idle,
    tip: tip.status === 0 ? tip.stdout : '',
    deleteBranch: !detached && Boolean(landed?.landed),
    landedOn: landed?.landed ? landed.baseRef : '',
    landedVia: landed?.landed ? landed.via : '',
  });
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Re-check, while holding finish.lock, only the facts that can change between
 * classification and removal and are cheap to read: the tip did not move, the
 * tree is still clean, and no live finish ticket names it. Landing is NOT
 * recomputed: it depends only on the tip (checked) and on a base that only
 * moves forward.
 *
 * @returns {string} '' when still safe, else the reason to skip
 */
function recheckUnderLock(v, stateDir) {
  if (!existsSync(v.path)) return 'checkout directory disappeared';
  const tip = git(['rev-parse', 'HEAD'], v.path);
  if (tip.status !== 0 || tip.stdout !== v.tip) return `tip moved since classification (${v.tip.slice(0, 10)} -> ${tip.stdout.slice(0, 10) || '?'})`;
  const status = gitRaw(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], v.path);
  if (status.status !== 0 || parsePorcelainPaths(status.stdout).length > 0) return 'worktree is no longer clean';
  if (livePathsFromFinishQueue(stateDir).has(v.path)) return 'a live finish ticket now names this worktree';
  return '';
}

function removeReclaimable(v, result, { primaryPath, gitOptions, out }) {
  let kitProof;
  try {
    kitProof = assertKitSafeToRemove({ projectRoot: v.path });
  } catch (error) {
    const reason = `kit cleanup proof failed: ${error.message}`;
    out(`${LOG_PREFIX} could not reclaim ${v.path}: ${reason}`);
    result.blocked.push({ ...v, removable: false, reasons: [reason] });
    return;
  }
  // A killed test run can leave read-only (0555) directories behind; only this
  // verified candidate's own directories get u+rwx back.
  // Windows pins the parent's current directory and refuses to delete it.
  // Leave the process in the surviving primary after this removal.
  process.chdir(primaryPath);
  makeOwnedTreeWritable(v.path);
  // An initialized submodule requires Git's force flag even after its own
  // safety proof. Scope that flag to the exact candidate whose kit passed it;
  // ordinary worktrees keep Git's native dirty/locked safeguards.
  const removeArgs = ['worktree', 'remove', ...(kitProof.applicable ? ['--force'] : []), v.path];
  const removed = git(removeArgs, primaryPath, gitOptions);
  if (removed.status !== 0) {
    out(`${LOG_PREFIX} could not reclaim ${v.path}: ${removed.stderr || removed.stdout}`);
    result.blocked.push({ ...v, removable: false, reasons: [`git worktree remove failed: ${removed.stderr || removed.stdout}`] });
    return;
  }
  result.reclaimed.push(v.path);
  out(`${LOG_PREFIX} reclaimed ${v.path} (idle ${v.idle}, landed on ${v.landedOn} via ${v.landedVia})`);
  if (v.deleteBranch) {
    // -D because a squash-merged branch is not an ancestor; landing was verified above.
    const deleted = git(['branch', '-D', v.branch], primaryPath, gitOptions);
    out(deleted.status === 0
      ? `${LOG_PREFIX} deleted landed local branch ${v.branch}`
      : `${LOG_PREFIX} kept branch ${v.branch} (${deleted.stderr || 'git branch -D failed'})`);
  } else {
    out(`${LOG_PREFIX} kept branch ${v.branch || '(detached)'}`);
  }
}

/**
 * Reclaim registered managed worktrees that are landed, clean, idle and
 * unused (see assessReclaimCandidate for every condition).
 *
 * A live finish.lock never makes the run skip: back-to-back finishes would
 * otherwise starve cleanup forever. Classification is read-only and always
 * runs (its verdict is advisory while a finish holds the lock). `--apply`
 * queues for finish.lock through the same FIFO tickets a finish uses, removes
 * only under the lock (finish also removes worktrees), re-checks the cheap
 * facts first, and holds the lock at most `config.reclaim.lockHoldSeconds`
 * per turn before releasing it and queueing again, so a long reclaim never
 * blocks a waiting finish for minutes.
 *
 * @param {import('./worktree-core.mjs').RepoInfo} repo
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @param {{
 *   staleDays: unknown, apply?: boolean, allowRecent?: boolean, usePatchId?: boolean,
 *   worktreeRoot?: string|true, stateDir: string, env?: NodeJS.ProcessEnv,
 *   now?: () => number, liveCwds?: Set<string>|null, out?: (line: string) => void,
 *   acquireLock?: typeof acquireFinishLockQueued,
 * }} options
 * @returns {Promise<{exitCode: number, refused: boolean,
 *   reclaimed: string[], blocked: ReclaimVerdict[], removable: ReclaimVerdict[]}>}
 */
export async function reclaimStaleWorktrees(repo, config, options) {
  const {
    apply = false,
    allowRecent = false,
    usePatchId = true,
    stateDir,
    env,
    now = Date.now,
    out = (line) => console.log(line),
    acquireLock = acquireFinishLockQueued,
  } = options;
  const result = { exitCode: 0, refused: false, reclaimed: [], blocked: [], removable: [] };

  const staleDays = typeof options.staleDays === 'string' ? Number(options.staleDays) : options.staleDays;
  if (typeof staleDays !== 'number' || !Number.isFinite(staleDays) || staleDays <= 0) {
    out(`${LOG_PREFIX} --reclaim-stale requires --stale-days <n> (a positive number of days); refusing to reclaim: there is no safe implicit age`);
    return { ...result, refused: true, exitCode: 1 };
  }

  if (finishLockIsLive(stateDir)) {
    out(`${LOG_PREFIX} a worktree finish holds finish.lock: classifying anyway (read-only); ${apply ? '--apply queues for the lock and re-checks each worktree under it' : 'this dry-run verdict is advisory until that finish completes'}`);
  }

  const primaryPath = repo.primaryWorktree?.path || repo.topLevel;
  const ctx = {
    config,
    primaryPath,
    currentPath: repo.topLevel,
    roots: managedWorktreeRoots(config, options),
    staleDays,
    allowRecent,
    usePatchId,
    nowMs: now(),
    now,
    patchIdBudgetSeconds: Number(config.reclaim?.patchIdBudgetSeconds ?? 120),
    patchIdDeadlineMs: now() + Number(config.reclaim?.patchIdBudgetSeconds ?? 120) * 1000,
    patchIdBudgetSkipped: 0,
    livePaths: livePathsFromFinishQueue(stateDir),
    liveCwds: options.liveCwds !== undefined ? options.liveCwds : liveProcessCwds(),
  };

  const candidates = repo.worktrees.filter((w) => !samePathIdentity(w.path, primaryPath));
  const verdicts = candidates.map((entry) => assessReclaimCandidate(entry, ctx));
  result.removable = verdicts.filter((v) => v.removable);
  result.blocked = verdicts.filter((v) => !v.removable);

  for (const v of result.blocked) {
    out(`${LOG_PREFIX} reclaim-blocked:${v.path} (${v.reasons.join('; ')}) -- left on disk`);
  }
  if (ctx.patchIdBudgetSkipped > 0) {
    out(`${LOG_PREFIX} patch-id budget (${ctx.patchIdBudgetSeconds}s, config.reclaim.patchIdBudgetSeconds) spent: ${ctx.patchIdBudgetSkipped} worktree(s) left unchecked and kept; rerun cleanup to continue`);
  }
  if (result.removable.length === 0) {
    out(`${LOG_PREFIX} no registered managed worktrees are reclaimable at --stale-days ${staleDays}`);
    return { ...result, exitCode: apply && result.blocked.length > 0 ? 1 : 0 };
  }

  const describeBranch = (v) => (v.deleteBranch ? `branch ${v.branch} will be deleted` : `branch ${v.branch || '(detached)'} is kept`);
  if (!apply) {
    out(`${LOG_PREFIX} ${result.removable.length} registered managed worktree(s) would be reclaimed (--reclaim-stale, needs --apply):`);
    for (const v of result.removable) {
      out(`  - ${v.path} (idle ${v.idle}, landed on ${v.landedOn} via ${v.landedVia}; ${describeBranch(v)})`);
    }
    return result;
  }

  out(`${LOG_PREFIX} reclaiming ${result.removable.length} stale registered managed worktree(s) (--reclaim-stale --apply):`);
  const gitOptions = { allowFailure: true, ...(env ? { env } : {}) };
  const holdMs = Number(config.reclaim?.lockHoldSeconds ?? 20) * 1000;
  const pending = [...result.removable];
  while (pending.length > 0) {
    const handle = await acquireLock(stateDir, { worktree: 'cleanup:reclaim', config });
    const heldSince = now();
    try {
      while (pending.length > 0) {
        const v = pending.shift();
        const skip = recheckUnderLock(v, stateDir);
        if (skip) {
          out(`${LOG_PREFIX} reclaim-skipped-under-lock:${v.path} (${skip}) -- left on disk`);
          result.blocked.push({ ...v, removable: false, reasons: [skip] });
        } else {
          removeReclaimable(v, result, { primaryPath, gitOptions, out });
        }
        if (pending.length > 0 && now() - heldSince >= holdMs) {
          out(`${LOG_PREFIX} reclaim held finish.lock for its ${holdMs / 1000}s budget; releasing it and queueing again (${pending.length} left)`);
          break;
        }
      }
    } finally {
      releaseFinishLock(handle);
    }
  }
  result.exitCode = result.blocked.length > 0 ? 1 : 0;
  return result;
}

// ---------------------------------------------------------------------------
// Plain `cleanup` (lifecycle=merged) activity floor
// ---------------------------------------------------------------------------

/**
 * The active-recent test on its own, for the plain `cleanup` path.
 *
 * @param {string} worktreePath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @param {number} [nowMs]
 * @returns {{recent: boolean, reason: string}}
 */
export function recentWorktreeActivity(worktreePath, config, nowMs = Date.now()) {
  const recentHours = Number(config.reclaim?.activeRecentHours ?? 2);
  const activity = newestWorktreeActivity(worktreePath);
  const idleMs = nowMs - activity.ms;
  if (idleMs >= recentHours * HOUR_MS) return { recent: false, reason: '' };
  const minutes = Math.max(0, Math.round(idleMs / 60_000));
  return {
    recent: true,
    reason: `active-recent: ${activity.what} modified ${minutes}min ago (< ${recentHours}h activity floor)`,
  };
}
