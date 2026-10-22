// Worktree discovery for heartbeat-sweep: registered managed worktrees that the kit's own reclaim
// pass would remove. The verdict is `assessReclaimCandidate` itself (HEAD landed, clean, no live
// process cwd, no live finish ticket, NOT active-recent, older than --stale-days), so the sweep can
// never propose what `cleanup --reclaim-stale` would refuse. Read-only: nothing is removed here.

import { lstatSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import { samePathIdentity } from '../lib/path-identity.mjs';
import { loadConfig } from '../worktrees/config.mjs';
import {
  assessReclaimCandidate,
  finishLockIsLive,
  livePathsFromFinishQueue,
  liveProcessCwds,
  managedWorktreeRoots,
} from '../worktrees/reclaim-stale.mjs';
import { discoverRepo } from '../worktrees/worktree-core.mjs';

// Wall-clock budget for the whole pass. The reclaim verdict walks each tree and runs `git status`,
// which is slow on a large checkout with many worktrees; the sweep must stay quick, so it assesses the
// oldest trees first (the likeliest to be reclaimable) and reports how many it left for the next run.
const DEFAULT_BUDGET_MS = 12_000;

function budgetMs() {
  const raw = Number(process.env.HEARTBEAT_SWEEP_WORKTREE_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BUDGET_MS;
}

function rootMtimeMs(path) {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Mirrors the worktree CLI's own state-dir rule: relative to the common git dir unless absolute.
function stateDirOf(repo, config) {
  if (config.stateDirAbs) return config.stateDirAbs;
  if (isAbsolute(config.stateDir)) return config.stateDir;
  return resolve(repo.commonGitDir, config.stateDir.replace(/^\.git[\\/]?/, ''));
}

export function discoverWorktrees(cwd, { staleDays, worktreeRoot, configPath }) {
  const notes = [];
  let repo;
  try {
    repo = discoverRepo(cwd);
  } catch (error) {
    return { candidates: [], notes: [`worktrees: not a git repository (${error.message.split('\n')[0]})`] };
  }
  const config = loadConfig(configPath);
  const stateDir = stateDirOf(repo, config);
  if (finishLockIsLive(stateDir)) {
    return { candidates: [], notes: ['worktrees: a worktree finish is in flight (live finish lock); not proposing reclaims this wake'] };
  }
  const primaryPath = repo.primaryWorktree?.path || repo.topLevel;
  const others = repo.worktrees
    .filter((entry) => !samePathIdentity(entry.path, primaryPath))
    .sort((a, b) => rootMtimeMs(a.path) - rootMtimeMs(b.path));
  if (others.length === 0) return { candidates: [], notes };
  const ctx = {
    config,
    primaryPath,
    currentPath: repo.topLevel,
    roots: managedWorktreeRoots(config, { worktreeRoot }),
    staleDays,
    allowRecent: false,
    usePatchId: true,
    nowMs: Date.now(),
    livePaths: livePathsFromFinishQueue(stateDir),
    liveCwds: liveProcessCwds(),
  };
  if (!ctx.liveCwds) notes.push('worktrees: lsof unavailable, live-process check skipped (clean, landed and idle gates still apply)');

  const command = `pnpm worktree:cleanup -- --reclaim-stale --stale-days ${staleDays}${worktreeRoot ? ` --worktree-root ${worktreeRoot}` : ''}`;
  const candidates = [];
  const deadline = Date.now() + budgetMs();
  let assessed = 0;
  for (const entry of others) {
    if (assessed > 0 && Date.now() > deadline) break;
    assessed += 1;
    const verdict = assessReclaimCandidate(entry, ctx);
    if (!verdict.removable) continue;
    candidates.push({
      source: `sweep:worktrees:${(verdict.branch || basename(verdict.path)).replace(/[^\w./-]/g, '_')}`,
      item: `reclaim idle landed worktree ${verdict.path} (${verdict.branch || 'detached'})`,
      evidence: `\`${command}\` is the dry run (landed on ${verdict.landedOn} via ${verdict.landedVia}, idle ${verdict.idle}); re-run with --apply after reading it`,
    });
  }
  if (assessed < others.length) {
    notes.push(`worktrees: assessed ${assessed} of ${others.length} within the time budget (oldest first); raise HEARTBEAT_SWEEP_WORKTREE_BUDGET_MS, or run \`${command}\` for the full pass`);
  }
  return { candidates, notes };
}
