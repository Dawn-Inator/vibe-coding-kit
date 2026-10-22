// worktree-guard/ai-idle-check.test.mjs
//
// Tests for the sync-primary idle scan. The finish-lock and worktree-activity
// probes run against real scratch git repositories and real linked worktrees;
// the process probe runs against fake process tables through the injected
// seams (a test must never depend on what happens to be running on the host).
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

import { checkOtherAiActivity, resolveProcessCwds } from '../../src/worktrees/ai-idle-check.mjs';
import { loadConfig } from '../../src/worktrees/config.mjs';
import { finishLockPath, finishQueueDir, writeQueueTicketFile } from '../../src/worktrees/finish-lock.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';

after(cleanupTempDirs);

const config = loadConfig(undefined, {});
const HOUR_MS = 60 * 60 * 1000;

function git(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: isolatedFixtureGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** A primary checkout with one commit and `n` linked worktrees (each with one extra commit). */
function makeRepo({ worktrees = 1 } = {}) {
  const root = mkdtempTracked('wtg-idle-');
  const primary = join(root, 'primary');
  mkdirSync(primary);
  git(['init', '--initial-branch=main'], primary);
  writeFileSync(join(primary, 'README.md'), '# fixture\n');
  git(['add', '-A'], primary);
  git(['commit', '-m', 'initial commit'], primary);
  const linked = [];
  for (let i = 0; i < worktrees; i += 1) {
    const path = join(root, 'worktrees', `w${i}`);
    git(['worktree', 'add', '-b', `claude/w${i}`, path], primary);
    writeFileSync(join(path, `f${i}.txt`), 'work\n');
    git(['add', '-A'], path);
    git(['commit', '-m', `work ${i}`], path);
    linked.push(path);
  }
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  return { root, primary, linked, stateDir, repo: discoverRepo(primary) };
}

const SELF = 5000;
/** The caller (5000) runs under an AI CLI (4000) under a shell (3000). */
function callerTree(extra = []) {
  return [
    { pid: 3000, ppid: 1, commandLine: '/bin/zsh -l' },
    { pid: 4000, ppid: 3000, commandLine: '/usr/local/bin/claude --resume' },
    { pid: SELF, ppid: 4000, commandLine: 'node cli.mjs sync-primary' },
    ...extra,
  ];
}

function seams({ processes = callerTree(), cwds = {}, now = Date.now() + HOUR_MS, platform = 'linux' } = {}) {
  return {
    selfPid: SELF,
    platform,
    now: () => now,
    listProcesses: () => processes,
    resolveCwds: (pids) => new Map(pids.map((pid) => [pid, cwds[pid] ?? null])),
  };
}

function scan(fx, options = {}, cfg = config) {
  return checkOtherAiActivity({ repo: fx.repo, stateDir: fx.stateDir, config: cfg, seams: seams(options) });
}

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(child.status, 0);
  return child.pid;
}

// ---------------------------------------------------------------------------

test('idle: no lock, no other AI process, clean and old worktrees => not busy, every check reported', () => {
  const fx = makeRepo({ worktrees: 2 });
  const outcome = scan(fx, { cwds: { 4000: fx.primary } });
  assert.equal(outcome.busy, false, outcome.reasons.join('\n'));
  assert.deepEqual(outcome.reasons, []);
  const text = outcome.report.join('\n');
  assert.match(text, /finish\/queue: no lock held/);
  assert.match(text, /other AI processes: none/);
  assert.match(text, /worktree activity: 2 linked worktree\(s\) clean/);
});

test('(b) finish.lock held by a live pid => busy; held by a dead pid => idle', () => {
  const fx = makeRepo();
  writeFileSync(finishLockPath(fx.stateDir), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  const busy = scan(fx);
  assert.equal(busy.busy, true);
  assert.ok(busy.reasons.some((r) => r.includes('finish.lock')), busy.reasons.join('\n'));

  writeFileSync(finishLockPath(fx.stateDir), JSON.stringify({ pid: exitedPid(), acquiredAt: new Date().toISOString() }));
  assert.equal(scan(fx).busy, false);

  // An unreadable lock file cannot be proven dead.
  writeFileSync(finishLockPath(fx.stateDir), '{not json');
  assert.equal(scan(fx).busy, true);
});

test('(b) a live finish.queue ticket => busy; a ticket of a dead pid does not block', () => {
  const fx = makeRepo();
  const queueDir = finishQueueDir(fx.stateDir);
  writeQueueTicketFile(queueDir, { pid: exitedPid(), enqueuedAt: new Date().toISOString() });
  assert.equal(scan(fx).busy, false);

  writeQueueTicketFile(queueDir, { pid: process.pid, enqueuedAt: new Date().toISOString() });
  const busy = scan(fx);
  assert.equal(busy.busy, true);
  assert.ok(busy.reasons.some((r) => /finish\.queue ticket/.test(r)), busy.reasons.join('\n'));
});

test('(c) another AI process with its cwd inside a linked worktree or the primary => busy, pid named', () => {
  const fx = makeRepo();
  const other = { pid: 6000, ppid: 1, commandLine: '/usr/local/bin/codex exec' };
  for (const cwd of [fx.linked[0], join(fx.linked[0], 'sub'), fx.primary]) {
    const outcome = scan(fx, { processes: callerTree([other]), cwds: { 6000: cwd } });
    assert.equal(outcome.busy, true, cwd);
    assert.ok(outcome.reasons.some((r) => r.includes('pid=6000')), outcome.reasons.join('\n'));
    assert.ok(outcome.report.some((l) => l.includes(`cwd=${cwd}`)), outcome.report.join('\n'));
  }
});

test('(c) AI processes elsewhere, and non-AI processes inside the repository, do not count', () => {
  const fx = makeRepo();
  const elsewhere = { pid: 6000, ppid: 1, commandLine: '/usr/local/bin/claude' };
  const editor = { pid: 6001, ppid: 1, commandLine: '/usr/bin/vim notes.txt' };
  const outcome = scan(fx, {
    processes: callerTree([elsewhere, editor]),
    cwds: { 6000: join(fx.root, 'unrelated'), 6001: fx.linked[0] },
  });
  assert.equal(outcome.busy, false, outcome.reasons.join('\n'));
});

test("(c) the caller's own process tree is excluded, a sibling AI process is not", () => {
  const fx = makeRepo();
  // Own AI CLI (4000) sits in the primary checkout: excluded.
  const own = scan(fx, { cwds: { 4000: fx.primary } });
  assert.equal(own.busy, false, own.reasons.join('\n'));

  // A second CLI under the same shell is somebody else.
  const sibling = { pid: 4100, ppid: 3000, commandLine: '/usr/local/bin/claude --resume' };
  const outcome = scan(fx, { processes: callerTree([sibling]), cwds: { 4000: fx.primary, 4100: fx.primary } });
  assert.equal(outcome.busy, true);
  assert.ok(outcome.reasons.some((r) => r.includes('pid=4100')));
  assert.ok(!outcome.reasons.some((r) => r.includes('pid=4000')));
});

test('(c) a live AI process whose cwd cannot be read is busy; one that has exited is not', () => {
  const fx = makeRepo();
  const live = scan(fx, { processes: callerTree([{ pid: process.pid, ppid: 1, commandLine: 'claude' }]) });
  assert.equal(live.busy, true);
  assert.ok(live.reasons.some((r) => r.includes('could not be read')), live.reasons.join('\n'));

  const gone = exitedPid();
  const exited = scan(fx, { processes: callerTree([{ pid: gone, ppid: 1, commandLine: 'claude' }]) });
  assert.equal(exited.busy, false, exited.reasons.join('\n'));
});

test('(c, Windows) an AI process with unreadable native CWD is busy, while unrelated unreadable processes are not AI matches', () => {
  const fx = makeRepo({ worktrees: 0 });
  const aiProcess = {
    pid: 6001,
    ppid: 1,
    commandLine: 'C:\\Tools\\claude.exe\u0000--resume',
    cwd: null,
    cwdStatus: 'unreadable',
  };
  const self = { pid: SELF, ppid: 1, commandLine: 'C:\\node\\node.exe\u0000cli.mjs', cwd: fx.primary, cwdStatus: 'readable' };
  const busy = scan(fx, { platform: 'win32', processes: [aiProcess, self] });
  assert.equal(busy.busy, true);
  assert.ok(busy.reasons.some((reason) => reason.includes('pid=6001') && reason.includes('unreadable')));

  const unrelated = scan(fx, {
    platform: 'win32',
    processes: [
      { pid: 6002, ppid: 1, commandLine: 'C:\\Windows\\notepad.exe\u0000', cwd: null, cwdStatus: 'unreadable' },
      self,
    ],
  });
  assert.equal(unrelated.busy, false, unrelated.reasons.join('\n'));
});

test('(d) uncommitted or untracked files in a linked worktree => busy', () => {
  const fx = makeRepo({ worktrees: 2 });
  writeFileSync(join(fx.linked[1], 'f1.txt'), 'edited\n');
  const modified = scan(fx);
  assert.equal(modified.busy, true);
  const dirtyReason = modified.reasons.find((reason) => reason.endsWith(' has uncommitted changes'));
  assert.ok(dirtyReason, modified.reasons.join('\n'));
  assert.equal(
    samePathIdentity(dirtyReason.slice(0, -' has uncommitted changes'.length), fx.linked[1]),
    true,
    dirtyReason,
  );

  git(['checkout', '--', 'f1.txt'], fx.linked[1]);
  assert.equal(scan(fx).busy, false);
  writeFileSync(join(fx.linked[0], 'scratch.txt'), 'new\n');
  assert.equal(scan(fx).busy, true, 'an untracked file counts');
});

test('(d) a commit younger than idleMinutes => busy; older, or a smaller window => idle', () => {
  const fx = makeRepo();
  const justNow = scan(fx, { now: Date.now() });
  assert.equal(justNow.busy, true);
  assert.ok(justNow.reasons.some((r) => /committed \d+m ago \(window 10m\)/.test(r)), justNow.reasons.join('\n'));

  assert.equal(scan(fx, { now: Date.now() + 11 * 60 * 1000 }).busy, false, 'older than the default window');
  assert.equal(scan(fx, { now: Date.now() + 3 * 60 * 1000 }, { ...config, syncPrimary: { idleMinutes: 2 } }).busy, false,
    'a configured smaller window is honoured');
  assert.equal(scan(fx, { now: Date.now() + 3 * 60 * 1000 }, { ...config, syncPrimary: {} }).busy, true,
    'a partial override falls back to the 10 minute default');
});

test('(d) a worktree registered but missing on disk is reported and skipped', () => {
  const fx = makeRepo();
  const repo = { ...fx.repo, worktrees: [...fx.repo.worktrees, { path: join(fx.root, 'gone'), branch: 'x', head: null }] };
  const outcome = checkOtherAiActivity({ repo, stateDir: fx.stateDir, config, seams: seams() });
  assert.equal(outcome.busy, false, outcome.reasons.join('\n'));
  assert.ok(outcome.report.some((l) => l.includes('missing on disk')));
});

test('fail closed: a probe that throws is busy, with the probe named', () => {
  const fx = makeRepo();
  const listFails = checkOtherAiActivity({
    repo: fx.repo, stateDir: fx.stateDir, config,
    seams: { ...seams(), listProcesses: () => { throw new Error('process listing failed: ps exited 1'); } },
  });
  assert.equal(listFails.busy, true);
  assert.ok(listFails.reasons.some((r) => r.includes('probe error (AI processes)') && r.includes('ps exited 1')));

  const lsofMissing = checkOtherAiActivity({
    repo: fx.repo, stateDir: fx.stateDir, config,
    seams: {
      ...seams({ processes: callerTree([{ pid: 6000, ppid: 1, commandLine: 'claude' }]) }),
      resolveCwds: () => { throw new Error('lsof is not installed; cannot read process working directories'); },
    },
  });
  assert.equal(lsofMissing.busy, true);
  assert.ok(lsofMissing.reasons.some((r) => r.includes('lsof is not installed')));

  // A worktree git cannot read is a failed probe, not a clean one.
  const broken = join(fx.root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/gitdir\n');
  const repo = { ...fx.repo, worktrees: [...fx.repo.worktrees, { path: broken, branch: 'b', head: null }] };
  const gitFails = checkOtherAiActivity({ repo, stateDir: fx.stateDir, config, seams: seams() });
  assert.equal(gitFails.busy, true);
  assert.ok(gitFails.reasons.some((r) => r.includes('probe error (worktree activity)')), gitFails.reasons.join('\n'));
});

test('the slow worktree probe is skipped once another probe already made the answer busy', () => {
  const fx = makeRepo();
  writeFileSync(join(fx.linked[0], 'dirty.txt'), 'x\n');
  const failing = checkOtherAiActivity({
    repo: fx.repo, stateDir: fx.stateDir, config,
    seams: { ...seams(), listProcesses: () => { throw new Error('boom'); } },
  });
  assert.equal(failing.busy, true);
  assert.ok(failing.reasons.some((r) => r.includes('probe error (AI processes)')));
  assert.ok(failing.report.some((l) => l.includes('worktree activity: skipped')));

  // When the earlier probes are quiet, the dirty worktree is what makes it busy.
  assert.ok(scan(fx).reasons.some((r) => r.includes('uncommitted')));
});

// ---------------------------------------------------------------------------
// resolveProcessCwds (default cwd resolver)
// ---------------------------------------------------------------------------

test('resolveProcessCwds: lsof output is parsed per pid; a missing pid maps to null', () => {
  let seen;
  const spawn = (cmd, args) => {
    seen = [cmd, args];
    return { status: 1, stdout: 'p100\nn/work/a\np300\nn/work/c b\n' };
  };
  const cwds = resolveProcessCwds([100, 200, 300], { platform: 'darwin', spawn });
  assert.deepEqual([...cwds], [[100, '/work/a'], [300, '/work/c b'], [200, null]]);
  assert.equal(seen[0], 'lsof');
  assert.ok(seen[1].includes('100,200,300'));
});

test('resolveProcessCwds: a missing lsof or a spawn failure throws (never an empty answer)', () => {
  const noLsof = () => ({ status: null, error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) });
  assert.throws(() => resolveProcessCwds([1], { platform: 'darwin', spawn: noLsof }), /lsof is not installed/);
  const broken = () => ({ status: null, error: Object.assign(new Error('boom'), { code: 'EAGAIN' }) });
  assert.throws(() => resolveProcessCwds([1], { platform: 'darwin', spawn: broken }), /lsof failed/);
  assert.equal(resolveProcessCwds([], { platform: 'darwin', spawn: noLsof }).size, 0, 'nothing to look up, nothing to run');
});

test('resolveProcessCwds: on linux /proc is read per pid; a vanished pid is null, other errors throw', () => {
  const readlink = (path) => {
    if (path === '/proc/1/cwd') return '/work/x';
    if (path === '/proc/2/cwd') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    throw Object.assign(new Error('io'), { code: 'EIO' });
  };
  const cwds = resolveProcessCwds([1, 2], { platform: 'linux', readlink });
  assert.deepEqual([...cwds], [[1, '/work/x'], [2, null]]);
  assert.throws(() => resolveProcessCwds([3], { platform: 'linux', readlink }), /io/);
});
