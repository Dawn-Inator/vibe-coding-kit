// worktree-guard/ai-idle-check.mjs
//
// The idle scan behind `sync-primary`'s self-authorization. A top-level AI
// session may advance the primary checkout without a human exporting the
// approval variable, but only when nothing else is observably active in the
// repository. Worker contexts never reach this module (cli.mjs refuses them
// first), and the explicit approval variable never needs it.
//
// Fails CLOSED by design: every probe below counts an error, a missing tool or
// an unreadable state file as BUSY. "Idle" has to be affirmatively shown; a
// probe that found no evidence because it could not look is not evidence. The
// price of a false BUSY is one human running the command with the approval
// variable; the price of a false IDLE is two sessions racing the primary
// checkout.
//
// What is scanned (all must be quiet):
//   (b) finish.lock held by a live pid, or live finish.queue tickets.
//   (c) another AI-tool process, outside the caller's own process tree, whose
//       cwd is inside the primary checkout or any linked worktree.
//   (d) a linked worktree with uncommitted changes (untracked files included)
//       or a commit newer than the idle window.
// There is deliberately no "other live session registration" probe: this kit
// keeps no session registry, and inventing one here would be a second source of
// truth. Add one if your project has it.
//
// "Managed worktree" here means every linked worktree git lists for the repo,
// not only those under a configured root: counting a hand-made worktree as
// active can only make the scan more conservative.
//
// The worktree probe is skipped once an earlier one already found the repository
// busy (it is the slow one).
//
// Every output line is value-safe: counts, paths, pids and process names only.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { spawnSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { syncPrimarySettings } from './config.mjs';
// eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
import { finishQueueDir, listLiveQueueTickets, pidIsAlive } from './finish-lock.mjs';
import { listProcessCommands, matchesAiParentProcess } from './process-provenance.mjs';
import { finishLockIsLive } from './reclaim-stale.mjs';
import { gitText } from './worktree-core.mjs';

// realpath of the deepest existing ancestor plus the unresolved tail, so a cwd
// that was deleted underneath its process (or a symlinked temp root such as
// macOS /var -> /private/var) still compares equal to a resolved root.
function canonical(path) {
  const absolute = resolve(path);
  const tail = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      if (dirname(current) === current) return absolute;
      tail.unshift(basename(current));
    }
  }
}

function isSameOrUnder(path, root) {
  const p = canonical(path);
  const r = canonical(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Linked (non-primary) worktrees that still exist on disk. */
function linkedWorktrees(repo) {
  const primary = repo.primaryWorktree?.path;
  const linked = [];
  const missing = [];
  for (const entry of repo.worktrees ?? []) {
    if (primary && canonical(entry.path) === canonical(primary)) continue;
    (existsSync(entry.path) ? linked : missing).push(entry.path);
  }
  return { linked, missing };
}

// ---------------------------------------------------------------------------
// (c) default seams: process cwd lookup
// ---------------------------------------------------------------------------

/**
 * Current working directory for each pid. A pid that has already exited maps to
 * null (benign race); any tooling failure throws so the scan fails closed.
 * `lsof` rather than reclaim-stale's liveProcessCwds: that helper drops the pid
 * and reports "no lsof" as an empty answer, which is the wrong failure
 * direction for an affirmative idle claim.
 *
 * @param {number[]} pids
 * @param {{platform?: string, spawn?: typeof spawnSync, readlink?: typeof readlinkSync}} [options]
 * @returns {Map<number, string|null>}
 */
export function resolveProcessCwds(pids, options = {}) {
  const { platform = process.platform, spawn = spawnSync, readlink = readlinkSync } = options;
  const cwds = new Map();
  if (pids.length === 0) return cwds;

  if (platform === 'linux') {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlink(`/proc/${pid}/cwd`));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') cwds.set(pid, null);
        else if (error?.code === 'EACCES' || error?.code === 'EPERM') cwds.set(pid, null); // alive-check decides
        else throw error;
      }
    }
    return cwds;
  }

  const result = spawn('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error('lsof is not installed; cannot read process working directories');
    throw new Error(`lsof failed: ${result.error.message}`);
  }
  // lsof exits 1 when some of the pids vanished or were unreadable, while still
  // printing the rest: take whatever it printed and let the caller decide what
  // an unanswered pid means.
  let current = null;
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isInteger(current)) cwds.set(current, line.slice(1));
  }
  for (const pid of pids) if (!cwds.has(pid)) cwds.set(pid, null);
  return cwds;
}

// ---------------------------------------------------------------------------
// Probes. Each returns { reasons: string[], report: string[] }; a throw is
// turned into a BUSY reason by checkOtherAiActivity.
// ---------------------------------------------------------------------------

/** (b) finish.lock held by a live pid, or live finish.queue tickets. */
export function probeFinishLocks(stateDir) {
  const reasons = [];
  if (finishLockIsLive(stateDir)) reasons.push('finish.lock is held by a live (or unreadable) lock');
  const tickets = listLiveQueueTickets(finishQueueDir(stateDir));
  if (tickets.length > 0) reasons.push(`${tickets.length} live finish.queue ticket(s)`);
  return {
    reasons,
    report: reasons.length ? reasons.map((r) => `finish/queue: ${r}`) : ['finish/queue: no lock held, no live tickets'],
  };
}

/**
 * (c) AI-tool processes outside the caller's own process tree (itself plus its
 * ancestors) whose cwd is inside the primary checkout or a linked worktree.
 * An AI process whose cwd cannot be read while it is still alive counts as busy.
 */
export function probeOtherAiProcesses({ repo, config, selfPid, listProcesses, resolveCwds }) {
  const table = listProcesses();
  const ppidOf = new Map(table.map((p) => [p.pid, p.ppid]));
  const own = new Set([selfPid]);
  for (let pid = ppidOf.get(selfPid); Number.isInteger(pid) && pid > 1 && !own.has(pid); pid = ppidOf.get(pid)) {
    own.add(pid);
  }

  const candidates = table.filter((p) => !own.has(p.pid) && matchesAiParentProcess(p.commandLine, config));
  const roots = [repo.primaryWorktree?.path ?? repo.topLevel, ...linkedWorktrees(repo).linked];
  const cwds = resolveCwds(candidates.map((p) => p.pid));

  const reasons = [];
  const report = [];
  for (const proc of candidates) {
    const name = proc.commandLine.split('\u0000')[0].split(/[\\/]/).pop();
    const cwd = cwds.get(proc.pid);
    if (!cwd) {
      // eslint-disable-next-line lf/no-bare-pid-probe -- legacy bare pid probe (lock root cure RC4); migrate to lease-lock recordedPidLive/inspectLease
      if (pidIsAlive(proc.pid)) {
        reasons.push(`cwd of AI process pid=${proc.pid} (${name}) could not be read`);
        report.push(`other-process: pid=${proc.pid} name=${name} cwd=(unreadable)`);
      }
      continue; // exited between listing and probing
    }
    if (roots.some((root) => isSameOrUnder(cwd, root))) {
      reasons.push(`AI process pid=${proc.pid} (${name}) has its cwd inside the repository`);
      report.push(`other-process: pid=${proc.pid} name=${name} cwd=${cwd}`);
    }
  }
  if (reasons.length === 0) {
    report.push(`other AI processes: none inside the repository (${candidates.length} elsewhere)`);
  }
  return { reasons, report };
}

/** (d) uncommitted work or a recent commit in any linked worktree. */
export function probeWorktreeActivity({ repo, idleMinutes, now }) {
  const reasons = [];
  const report = [];
  const { linked, missing } = linkedWorktrees(repo);
  const nowMs = now();
  for (const path of linked) {
    const status = gitText(['status', '--porcelain', '--untracked-files=all'], path, {
      retry: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (status) {
      reasons.push(`${path} has uncommitted changes`);
      continue;
    }
    const committedSec = Number(gitText(['log', '-1', '--format=%ct'], path, { retry: false }));
    if (!Number.isFinite(committedSec)) throw new Error(`cannot read the newest commit time of ${path}`);
    const ageMinutes = (nowMs - committedSec * 1000) / 60000;
    if (ageMinutes < idleMinutes) {
      reasons.push(`${path} committed ${Math.max(0, Math.round(ageMinutes))}m ago (window ${idleMinutes}m)`);
    }
  }
  if (reasons.length === 0) {
    report.push(`worktree activity: ${linked.length} linked worktree(s) clean and older than ${idleMinutes}m`);
  } else {
    for (const r of reasons) report.push(`worktree activity: ${r}`);
  }
  for (const path of missing) report.push(`worktree activity: ${path} is registered but missing on disk (skipped)`);
  return { reasons, report };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every probe. `busy` is true when any probe found activity or failed.
 *
 * @param {{
 *   repo: import('./worktree-core.mjs').RepoInfo,
 *   stateDir: string,
 *   config: object,
 *   seams?: {
 *     listProcesses?: () => {pid: number, ppid: number, commandLine: string}[],
 *     resolveCwds?: (pids: number[]) => Map<number, string|null>,
 *     now?: () => number,
 *     selfPid?: number,
 *   },
 * }} params
 * @returns {{busy: boolean, reasons: string[], report: string[]}}
 */
export function checkOtherAiActivity({ repo, stateDir, config, seams = {} }) {
  const {
    listProcesses = () => listProcessCommands(),
    resolveCwds = (pids) => resolveProcessCwds(pids),
    now = Date.now,
    selfPid = process.pid,
  } = seams;
  const { idleMinutes } = syncPrimarySettings(config);

  const reasons = [];
  const report = [];
  const probes = [
    ['finish/queue locks', () => probeFinishLocks(stateDir)],
    ['AI processes', () => probeOtherAiProcesses({ repo, config, selfPid, listProcesses, resolveCwds })],
    ['worktree activity', () => probeWorktreeActivity({ repo, idleMinutes, now }), true],
  ];
  for (const [name, probe, costly] of probes) {
    // The worktree probe runs git in every linked worktree, which is slow on a
    // large repository; once something else already made the answer BUSY there
    // is nothing left for it to change.
    if (costly && reasons.length > 0) {
      report.push(`${name}: skipped, already busy`);
      continue;
    }
    try {
      const outcome = probe();
      reasons.push(...outcome.reasons);
      report.push(...outcome.report);
    } catch (error) {
      const message = error?.message || String(error);
      reasons.push(`probe error (${name}): ${message}`);
      report.push(`${name}: probe error, treated as busy: ${message}`);
    }
  }
  return { busy: reasons.length > 0, reasons, report };
}
