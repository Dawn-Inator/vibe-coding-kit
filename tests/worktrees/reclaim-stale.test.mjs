// worktree-guard/reclaim-stale.test.mjs
//
// End-to-end tests for `cleanup --reclaim-stale` (and the activity floor on the
// plain `cleanup`) against real throwaway repos: a bare "remote" plus a primary
// clone, worktrees made by the real `create` command, ages faked with utimes.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync, lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { ageWorktreeReflogs, worktreeAdminDir } from '../support/worktree-age.mjs';

import { main } from '../../src/worktrees/cli.mjs';
import { loadConfig } from '../../src/worktrees/config.mjs';
import { discoverRepo, writeWorktreeMetadata, readWorktreeMetadata } from '../../src/worktrees/worktree-core.mjs';
import { assessReclaimCandidate, reclaimStaleWorktrees, finishLockIsLive, liveProcessCwds, newestWorktreeActivity, NON_ACTIVITY_ADMIN_FILES } from '../../src/worktrees/reclaim-stale.mjs';

after(cleanupTempDirs);

const config = loadConfig(undefined, {});
const DAY_MS = 24 * 60 * 60 * 1000;

function run(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: isolatedFixtureGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function makeFixtureRepo({ withKit = false } = {}) {
  const root = mkdtempTracked('wtg-reclaim-');
  const remoteDir = join(root, 'remote.git');
  const primaryDir = join(root, 'primary');
  run(['init', '--bare', '--initial-branch=main', remoteDir], root);
  run(['clone', '--shared', remoteDir, primaryDir], root);
  writeFileSync(join(primaryDir, 'README.md'), '# fixture\n');
  run(['add', '-A'], primaryDir);
  run(['commit', '-m', 'initial commit'], primaryDir);
  run(['push', 'origin', 'HEAD:refs/heads/main'], primaryDir);
  run(['branch', '--set-upstream-to=origin/main', 'main'], primaryDir);
  if (withKit) {
    const kitSource = join(root, 'kit-source');
    mkdirSync(kitSource);
    run(['init', '--initial-branch=main'], kitSource);
    writeFileSync(join(kitSource, 'README.md'), 'fixture kit\n');
    run(['add', '-A'], kitSource);
    run(['commit', '-m', 'fixture kit'], kitSource);
    const kitUrl = pathToFileURL(kitSource).href;
    run(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'vibe-coding-kit', kitUrl, '.vibe-coding/kit'], primaryDir);
    run(['config', 'protocol.file.allow', 'always'], primaryDir);
    const configDir = join(primaryDir, '.vibe-coding');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'project.config.json'), `${JSON.stringify({
      schemaVersion: 1,
      kit: { path: '.vibe-coding/kit', url: kitUrl },
      adapter: 'engineering/automation/vibe-coding/project-adapter.mjs',
      identity: { name: 'Fixture Consumer', email: 'consumer@example.invalid' },
    })}\n`);
    const adapterPath = join(primaryDir, 'engineering/automation/vibe-coding/project-adapter.mjs');
    mkdirSync(join(primaryDir, 'engineering/automation/vibe-coding'), { recursive: true });
    writeFileSync(adapterPath, 'export const adapterContract = { schemaVersion: 1, hooks: {} };\n');
    run(['add', '-A'], primaryDir);
    run(['commit', '-m', 'register the fixture kit'], primaryDir);
    run(['push', 'origin', 'HEAD:refs/heads/main'], primaryDir);
  }
  return { root, remoteDir, primaryDir, worktreeRoot: join(root, 'worktrees') };
}

async function withCwd(dir, fn) {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

async function withLocalFileProtocol(fn) {
  const previous = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map((name) => process.env[name]);
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
  process.env.GIT_CONFIG_VALUE_0 = 'always';
  try { return await fn(); }
  finally {
    for (const [index, name] of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
}

async function capture(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Real `create`; returns the new worktree path. */
async function createWorktree(fx, name, worktreeTool = 'claude') {
  const out = await withCwd(fx.primaryDir, () => capture(() => (
    main(['create', '--name', name, '--tool', worktreeTool, '--worktree-root', fx.worktreeRoot])
  )));
  assert.equal(out.result, 0, out.errors.join('\n'));
  const entry = discoverRepo(fx.primaryDir).worktrees.find((w) => w.branch === `${worktreeTool}/${name}`);
  assert.ok(entry, `worktree for ${name}`);
  return entry.path;
}

test('createWorktree fixture is deterministic and covers both supported agent prefixes', async () => {
  const fx = makeFixtureRepo();
  for (const tool of ['claude', 'codex']) {
    const path = await createWorktree(fx, `${tool}-prefix`, tool);
    const entry = discoverRepo(fx.primaryDir).worktrees.find((w) => samePathIdentity(w.path, path));
    assert.equal(entry.branch, `${tool}/${tool}-prefix`);
    assert.equal(readWorktreeMetadata(path, config)['created-by'], tool);
  }
});

function commitInWorktree(path, file, content, message = `add ${file}`) {
  writeFileSync(join(path, file), content);
  run(['add', file], path);
  run(['commit', '-m', message], path);
  return run(['rev-parse', 'HEAD'], path);
}

/** Land `sha` on origin/main by cherry-pick (different commit id, same patch). */
function landByCherryPick(fx, sha, sourceWorktree) {
  fx.landingSequence = (fx.landingSequence ?? 0) + 1;
  const landingDir = join(fx.root, `landing-${fx.landingSequence}`);
  run(['clone', '--shared', sourceWorktree, landingDir], fx.root);
  run(['remote', 'set-url', 'origin', fx.remoteDir], landingDir);
  run(['fetch', 'origin', 'main'], landingDir);
  run(['checkout', '--detach', 'FETCH_HEAD'], landingDir);
  run(['cherry-pick', '-x', sha], landingDir); // -x: the message differs, so the id differs even when both commits land in the same second
  run(['push', 'origin', 'HEAD:refs/heads/main'], landingDir);
  // Keep the fixture's origin/main view current; fetch updates only the
  // remote-tracking ref, which the primary ref guard explicitly permits.
  run(['fetch', 'origin', 'main'], fx.primaryDir);
}

function setTimes(path, ms) {
  const when = new Date(ms);
  try {
    utimesSync(path, when, when);
  } catch {
    // vanished while walking
  }
}

function setTreeTimes(path, ms) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) setTreeTimes(join(path, name), ms);
  setTimes(path, ms);
}

const adminOf = worktreeAdminDir;
const ageReflogs = ageWorktreeReflogs;

/** Make the worktree, its git admin dir and its reflog entries look untouched for `days`. */
function ageWorktree(path, days) {
  const ms = Date.now() - days * DAY_MS;
  ageReflogs(path, ms);
  setTreeTimes(adminOf(path), ms);
  setTreeTimes(path, ms);
}

function reclaim(fx, args, cwd = fx.primaryDir) {
  return withCwd(cwd, () => capture(() => main(['cleanup', '--reclaim-stale', '--worktree-root', fx.worktreeRoot, ...args])));
}

function branchExists(fx, branch) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: fx.primaryDir, env: isolatedFixtureGitEnv() }).status === 0;
}

// A worktree whose branch was cherry-picked onto origin/main, then left idle.
async function landedIdleWorktree(fx, name, days = 30) {
  const path = await createWorktree(fx, name);
  const sha = commitInWorktree(path, `${name}.txt`, `${name}\n`);
  landByCherryPick(fx, sha, path);
  ageWorktree(path, days);
  return path;
}

test('--stale-days is required: missing, valueless, zero and non-numeric are all refused and touch nothing', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'needs-age');
  for (const args of [[], ['--stale-days'], ['--stale-days', '0'], ['--stale-days=abc'], ['--apply']]) {
    const out = await reclaim(fx, args);
    assert.equal(out.result, 1, JSON.stringify(args));
    assert.ok(out.logs.some((line) => /requires --stale-days/.test(line)), out.logs.join('\n'));
  }
  assert.ok(existsSync(path));
});

test('dry run lists what would be reclaimed and removes nothing; --apply removes the worktree and its landed branch', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'abandoned');

  const dry = await reclaim(fx, ['--stale-days', '14']);
  assert.equal(dry.result, 0, dry.errors.join('\n'));
  assert.ok(dry.logs.some((line) => /would be reclaimed/.test(line)), dry.logs.join('\n'));
  const patchIdLine = dry.logs.find((line) => /via patch-id/.test(line));
  assert.ok(patchIdLine, dry.logs.join('\n'));
  const listedPath = patchIdLine.match(/^\s*-\s+(.*?)\s+\(idle/u)?.[1];
  assert.equal(samePathIdentity(listedPath, path), true, patchIdLine);
  assert.ok(dry.logs.some((line) => /dry run; pass --apply/.test(line)));
  assert.ok(existsSync(path), 'dry run must not remove anything');
  assert.ok(branchExists(fx, 'claude/abandoned'));

  const applied = await reclaim(fx, ['--stale-days', '14', '--apply']);
  assert.equal(applied.result, 0, applied.logs.join('\n'));
  assert.ok(applied.logs.some((line) => /reclaimed .*abandoned/.test(line)));
  assert.equal(existsSync(path), false);
  assert.equal(branchExists(fx, 'claude/abandoned'), false, 'the landed managed branch is deleted');
});

test('reclaim removes an initialized kit only after proof, using force for that verified checkout', async () => {
  const fx = makeFixtureRepo({ withKit: true });
  const path = await withLocalFileProtocol(() => landedIdleWorktree(fx, 'kit-reclaim'));
  assert.equal(existsSync(join(path, '.vibe-coding/kit/.git')), true, 'the worktree has an initialized kit submodule');

  const applied = await reclaim(fx, ['--stale-days', '14', '--apply']);
  assert.equal(applied.result, 0, applied.logs.join('\n'));
  assert.ok(applied.logs.some((line) => /reclaimed .*kit-reclaim/u.test(line)), applied.logs.join('\n'));
  assert.equal(existsSync(path), false);
  assert.equal(branchExists(fx, 'claude/kit-reclaim'), false);
});

test('a worktree younger than --stale-days is blocked', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'fairly-recent', 3);
  const out = await reclaim(fx, ['--stale-days', '14', '--apply']);
  assert.equal(out.result, 1);
  assert.ok(out.logs.some((line) => line.includes(`reclaim-blocked:`) && /younger than --stale-days 14/.test(line)), out.logs.join('\n'));
  assert.ok(existsSync(path));
});

test('active-recent floor: a file touched within the last hours blocks the reclaim unless --allow-recent', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'in-use');
  // Everything is 30 days old except one tracked file touched an hour ago.
  setTimes(join(path, 'in-use.txt'), Date.now() - 60 * 60 * 1000);

  const blocked = await reclaim(fx, ['--stale-days', '0.01', '--apply']);
  assert.equal(blocked.result, 1);
  assert.ok(blocked.logs.some((line) => /reclaim-blocked:/.test(line) && /active-recent/.test(line) && /--allow-recent/.test(line)), blocked.logs.join('\n'));
  assert.ok(existsSync(path), 'left on disk');

  const allowed = await reclaim(fx, ['--stale-days', '0.01', '--allow-recent', '--apply']);
  assert.equal(allowed.result, 0, allowed.logs.join('\n'));
  assert.equal(existsSync(path), false);
});

test('active-recent floor: read-only git touches of the admin dir are NOT activity (they made nothing reclaimable)', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'admin-touch');
  const admin = adminOf(path);
  // What `git status` / `git fetch` / another session's sweep leave behind: fresh admin mtimes only.
  for (const file of NON_ACTIVITY_ADMIN_FILES) {
    if (!existsSync(join(admin, file))) writeFileSync(join(admin, file), '');
    setTimes(join(admin, file), Date.now());
  }
  setTimes(admin, Date.now());
  run(['status', '--porcelain'], path);
  const activity = newestWorktreeActivity(path);
  assert.doesNotMatch(activity.what, /admin|index|FETCH_HEAD|ORIG_HEAD|config\.worktree/);
  // HERMETIC-EXEMPT: freshness check against a 2h window, not a performance budget
  assert.ok(Date.now() - activity.ms > 2 * 60 * 60 * 1000, activity.what);

  const repo = discoverRepo(fx.primaryDir);
  const common = { staleDays: 14, apply: false, worktreeRoot: fx.worktreeRoot, stateDir: join(fx.root, 'state'), liveCwds: null, out: () => {} };
  assert.equal((await reclaimStaleWorktrees(repo, config, common)).removable.length, 1);
});

test('active-recent floor: a real commit (reflog entry) counts, and the floor length comes from config.reclaim', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'reflog-touch');
  ageReflogs(path, Date.now() - 30 * 60 * 1000);
  const activity = newestWorktreeActivity(path);
  assert.match(activity.what, /reflog entry/);

  const repo = discoverRepo(fx.primaryDir);
  const common = { staleDays: 0.01, apply: false, worktreeRoot: fx.worktreeRoot, stateDir: join(fx.root, 'state'), liveCwds: null, out: () => {} };
  assert.equal((await reclaimStaleWorktrees(repo, config, common)).blocked.length, 1);
  // A shorter floor (override replaces the whole key) lets the 30-minute-old commit through.
  const shortFloor = { ...config, reclaim: { activeRecentHours: 0.1 } };
  assert.equal((await reclaimStaleWorktrees(repo, shortFloor, common)).removable.length, 1);
  // A config override that drops the key falls back to the 2h default.
  const noKey = { ...config, reclaim: {} };
  assert.equal((await reclaimStaleWorktrees(repo, noKey, common)).blocked.length, 1);
});

test('class guard: the activity probe never reads an admin file mtime', () => {
  const source = readFileSync(new URL('../../src/worktrees/reclaim-stale.mjs', import.meta.url), 'utf8');
  const bodyStart = source.indexOf('export function newestWorktreeActivity');
  const bodyEnd = source.indexOf('// Liveness probes');
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'newestWorktreeActivity anchors must exist in order');
  const body = source.slice(bodyStart, bodyEnd);
  assert.doesNotMatch(body, /mtimeMsOf\(\s*(?:admin|join\(\s*admin)/u, 'admin-dir mtimes are not activity');
  assert.doesNotMatch(body, /NON_ACTIVITY_ADMIN_FILES/u);
});

test('a dirty or untracked worktree is blocked and left on disk', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'has-untracked');
  writeFileSync(join(path, 'scratch.txt'), 'unsaved\n');
  ageWorktree(path, 30);
  const out = await reclaim(fx, ['--stale-days', '14', '--apply']);
  assert.equal(out.result, 1);
  assert.ok(out.logs.some((line) => /reclaim-blocked:/.test(line) && /uncommitted or untracked/.test(line)), out.logs.join('\n'));
  assert.ok(existsSync(join(path, 'scratch.txt')));
});

test('unlanded work is blocked with the exact unmatched commit; one blocked path makes --apply exit 1 while landed siblings are still reclaimed', async () => {
  const fx = makeFixtureRepo();
  const landed = await landedIdleWorktree(fx, 'landed-one');
  const unlandedPath = await createWorktree(fx, 'unlanded-one');
  const sha = commitInWorktree(unlandedPath, 'precious.txt', 'not on main\n', 'precious unlanded work');
  ageWorktree(unlandedPath, 30);

  const out = await reclaim(fx, ['--stale-days', '14', '--apply']);
  assert.equal(out.result, 1);
  const blockedLine = out.logs.find((line) => line.includes(`reclaim-blocked:`) && line.includes('unlanded-one'));
  assert.ok(blockedLine, out.logs.join('\n'));
  assert.ok(blockedLine.includes(sha.slice(0, 10)) && blockedLine.includes('precious unlanded work'), blockedLine);
  assert.ok(existsSync(unlandedPath));
  assert.equal(existsSync(landed), false, 'the landed sibling was reclaimed');
  assert.ok(branchExists(fx, 'claude/unlanded-one'));
});

test('--no-patch-id restricts "landed" to ancestry, so a cherry-picked branch is blocked', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'ancestry-only');
  const out = await reclaim(fx, ['--stale-days', '14', '--no-patch-id', '--apply']);
  assert.equal(out.result, 1);
  assert.ok(out.logs.some((line) => /not landed/.test(line) && /patch-id fallback disabled/.test(line)), out.logs.join('\n'));
  assert.ok(existsSync(path));
});

test('structural refusals: current worktree, outside the managed root, unmanaged branch, no/SHA base-ref', async () => {
  const fx = makeFixtureRepo();
  // Build the foreign fixture before the first managed create installs the
  // primary ref guard. The test needs an unmanaged worktree shape; it must not
  // bypass the guard after it is installed.
  const foreign = join(fx.worktreeRoot, 'foreign');
  run(['worktree', 'add', '-b', 'feature/manual', foreign, 'main'], fx.primaryDir);
  ageWorktree(foreign, 30);

  const current = await landedIdleWorktree(fx, 'running-here');
  const shaBase = await landedIdleWorktree(fx, 'sha-base');
  writeWorktreeMetadata(shaBase, { 'base-ref': run(['rev-parse', 'HEAD'], shaBase) }, config);
  ageWorktree(shaBase, 30);
  const noBase = await landedIdleWorktree(fx, 'no-base');
  run(['config', '--worktree', '--unset', 'wtg.guard.base-ref'], noBase);
  ageWorktree(noBase, 30);
  const fromCurrent = await reclaim(fx, ['--stale-days', '14'], current);
  const text = fromCurrent.logs.join('\n');
  assert.match(text, /reclaim-blocked:\S*running-here\S* \([^)]*the worktree this command is running from/);
  assert.match(text, /reclaim-blocked:\S*sha-base\S* \([^)]*is a commit id, not a branch name/);
  assert.match(text, /reclaim-blocked:\S*no-base\S* \([^)]*no recorded base-ref/);
  assert.match(text, /reclaim-blocked:\S*foreign\S* \([^)]*does not use a managed prefix/);
  assert.ok(!text.includes('reclaim-blocked:' + fx.primaryDir), 'the primary is never even listed');

  // Without --worktree-root the managed roots are only ~/.claude|.codex/worktrees.
  const outside = await withCwd(fx.primaryDir, () => capture(() => main(['cleanup', '--reclaim-stale', '--stale-days', '14'])));
  assert.match(outside.logs.join('\n'), /not under a managed worktree root/);
});

test('a live finish.lock no longer skips the run: dry-run still classifies, --apply queues and reclaims once the holder is gone', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'during-finish');
  const stateDir = join(fx.primaryDir, '.git', 'worktree-guard-state');
  mkdirSync(stateDir, { recursive: true });
  // A real holder process that finishes shortly: the lock file outlives it, so the queue takes it over.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' });
  writeFileSync(join(stateDir, 'finish.lock'), JSON.stringify({ pid: holder.pid, acquiredAt: new Date().toISOString() }));
  assert.equal(finishLockIsLive(stateDir), true);

  const repo = discoverRepo(fx.primaryDir);
  const logs = [];
  const options = { staleDays: 14, worktreeRoot: fx.worktreeRoot, stateDir, liveCwds: null, out: (line) => logs.push(line) };
  const dry = await reclaimStaleWorktrees(repo, config, options);
  assert.equal(dry.removable.length, 1, logs.join('\n'));
  assert.ok(logs.some((line) => /holds finish\.lock: classifying anyway/.test(line)), logs.join('\n'));
  assert.ok(existsSync(path), 'dry run removes nothing');

  const fastQueue = { ...config, queue: { ...config.queue, pollIntervalMs: 50 } };
  const applied = await reclaimStaleWorktrees(repo, fastQueue, { ...options, apply: true });
  assert.equal(applied.exitCode, 0, logs.join('\n'));
  assert.deepEqual(applied.reclaimed, [dry.removable[0].path]);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(stateDir, 'finish.lock')), false, 'the reclaim released finish.lock');
});

test('under finish.lock, a worktree whose tip moved or that became dirty since classification is skipped, not removed', async () => {
  const fx = makeFixtureRepo();
  const moved = await landedIdleWorktree(fx, 'tip-moves');
  const dirtied = await landedIdleWorktree(fx, 'gets-dirty');
  const repo = discoverRepo(fx.primaryDir);
  const stateDir = join(fx.root, 'state');
  const logs = [];
  // The "lock wait" is where another session gets to act: commit in one tree, leave a file in the other.
  const acquireLock = async () => {
    commitInWorktree(moved, 'late.txt', 'late\n');
    writeFileSync(join(dirtied, 'scratch.txt'), 'unsaved\n');
    return { release() {} };
  };
  const result = await reclaimStaleWorktrees(repo, config, {
    staleDays: 14, apply: true, worktreeRoot: fx.worktreeRoot, stateDir, liveCwds: null, out: (line) => logs.push(line), acquireLock,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.reclaimed, []);
  assert.ok(logs.some((line) => /reclaim-skipped-under-lock:.*tip-moves.*tip moved/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /reclaim-skipped-under-lock:.*gets-dirty.*no longer clean/.test(line)), logs.join('\n'));
  assert.ok(existsSync(moved) && existsSync(dirtied));
});

test('the lock-hold budget releases finish.lock between worktrees and queues again', async () => {
  const fx = makeFixtureRepo();
  const first = await landedIdleWorktree(fx, 'budget-one');
  const second = await landedIdleWorktree(fx, 'budget-two');
  const repo = discoverRepo(fx.primaryDir);
  let acquired = 0;
  let released = 0;
  const acquireLock = async () => {
    acquired += 1;
    assert.equal(acquired - released, 1, 'never held twice at once');
    return { release() { released += 1; } };
  };
  const zeroBudget = { ...config, reclaim: { ...config.reclaim, lockHoldSeconds: 0 } };
  const result = await reclaimStaleWorktrees(repo, zeroBudget, {
    staleDays: 14, apply: true, worktreeRoot: fx.worktreeRoot, stateDir: join(fx.root, 'state'), liveCwds: null, out: () => {}, acquireLock,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reclaimed.length, 2);
  assert.equal(acquired, 2, 'one worktree per turn with a zero budget');
  assert.equal(released, 2);
  assert.ok(!existsSync(first) && !existsSync(second));
});

test('a spent patch-id budget keeps a worktree that only patch-id could prove landed, and says to rerun', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'needs-patch-id'); // landed by cherry-pick: not an ancestor
  const repo = discoverRepo(fx.primaryDir);
  const logs = [];
  const noBudget = { ...config, reclaim: { ...config.reclaim, patchIdBudgetSeconds: 0 } };
  const result = await reclaimStaleWorktrees(repo, noBudget, {
    staleDays: 14, apply: true, worktreeRoot: fx.worktreeRoot, stateDir: join(fx.root, 'state'), liveCwds: null, out: (line) => logs.push(line),
    acquireLock: async () => ({ release() {} }),
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.reclaimed, []);
  assert.match(result.blocked[0].reasons.join(';'), /patch-id budget \(0s\).*rerun/);
  assert.ok(logs.some((line) => /1 worktree\(s\) left unchecked and kept; rerun/.test(line)), logs.join('\n'));
  assert.ok(existsSync(path));

  const withBudget = await reclaimStaleWorktrees(repo, config, {
    staleDays: 14, apply: true, worktreeRoot: fx.worktreeRoot, stateDir: join(fx.root, 'state'), liveCwds: null, out: () => {},
    acquireLock: async () => ({ release() {} }),
  });
  assert.equal(withBudget.reclaimed.length, 1, 'the next run with budget left reclaims it');
});

test('without lsof, the live-process check falls back to /proc and still sees a process inside the worktree', { skip: !existsSync('/proc/self/cwd') && 'no /proc on this platform' }, async () => {
  const dir = realpathSync(mkdtempTracked('wtg-proc-cwd-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: dir, stdio: 'ignore' });
  const originalPath = process.env.PATH;
  try {
    await new Promise((resolveSpawn) => child.once('spawn', resolveSpawn));
    process.env.PATH = mkdtempTracked('wtg-empty-path-'); // no lsof on PATH -> spawnSync ENOENT
    const cwds = liveProcessCwds();
    assert.ok(cwds instanceof Set, 'the /proc fallback answered (null would mean the check was skipped)');
    assert.ok(cwds.has(dir), `the child's cwd ${dir} was found`);
  } finally {
    process.env.PATH = originalPath;
    child.kill('SIGKILL');
  }
});

test('Windows process CWD inventory preserves readable, unreadable, and exited statuses', () => {
  const root = mkdtempTracked('wtg-windows-cwds-');
  const processCwd = join(root, 'process-cwd');
  mkdirSync(processCwd);
  const cwds = liveProcessCwds({
    platform: 'win32',
    listProcesses: () => [
      { pid: 0, cwd: null, cwdStatus: 'unknown' },
      { pid: 201, cwd: processCwd, cwdStatus: 'readable' },
      { pid: 202, cwd: null, cwdStatus: 'unreadable' },
      { pid: 203, cwd: null, cwdStatus: 'exited' },
    ],
  });
  assert.ok([...cwds].some((cwd) => samePathIdentity(cwd, realpathSync(processCwd))));
  assert.deepEqual(cwds.unknownPids, [202]);
});

test('unknown Windows CWDs fail closed for reclamation without turning processes into AI matches', () => {
  const root = mkdtempTracked('wtg-windows-cwd-unknown-');
  const candidate = join(root, 'candidate');
  const primary = join(root, 'primary');
  mkdirSync(candidate);
  mkdirSync(primary);
  const cwds = liveProcessCwds({
    platform: 'win32',
    listProcesses: () => [{ pid: 204, cwd: null, cwdStatus: 'unreadable' }],
  });
  const result = assessReclaimCandidate({ path: candidate, branch: 'claude/windows-cwd' }, {
    config,
    primaryPath: primary,
    currentPath: primary,
    roots: [root],
    staleDays: 14,
    allowRecent: false,
    usePatchId: false,
    nowMs: Date.now(),
    livePaths: new Set(),
    liveCwds: cwds,
  });
  assert.equal(result.removable, false);
  assert.ok(result.reasons.includes('cannot verify working directories of 1 process(es)'));
});

test('Windows delete proof is repeated under lock before unknown-CWD reclaim', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'unknown-cwd-recheck');
  const repo = discoverRepo(fx.primaryDir);
  const unknownCwds = () => {
    const cwds = new Set();
    Object.defineProperty(cwds, 'unknownPids', { value: [205] });
    return cwds;
  };
  let inventoryReads = 0;
  let deleteProofs = 0;
  const result = await reclaimStaleWorktrees(repo, config, {
    staleDays: 14,
    apply: true,
    worktreeRoot: fx.worktreeRoot,
    stateDir: join(fx.primaryDir, '.git', 'worktree-guard-state'),
    platform: 'win32',
    getLiveProcessCwds: () => {
      inventoryReads += 1;
      return unknownCwds();
    },
    probeDirectoryDeleteSafety: (candidate, options) => {
      assert.equal(options.platform, 'win32');
      assert.equal(samePathIdentity(candidate, path), true);
      deleteProofs += 1;
      return { safe: deleteProofs === 1, reason: deleteProofs === 1 ? 'safe' : 'busy', checked: 1 };
    },
    out: () => {},
    acquireLock: async () => ({ release() {} }),
  });
  assert.equal(inventoryReads, 2, 'read a fresh Windows process inventory after acquiring the lock');
  assert.equal(deleteProofs, 2, 'repeat the non-destructive delete-handle proof under the lock');
  assert.ok(result.blocked.some((entry) => samePathIdentity(entry.path, path) && /cannot verify working directories/.test(entry.reasons.join(';'))));
  assert.equal(result.reclaimed.length, 0);
  assert.ok(existsSync(path), 'a failed locked proof leaves the worktree intact');
});

test('class guard: reclaim removes worktrees only from inside the finish.lock turn', () => {
  const source = readFileSync(new URL('../../src/worktrees/reclaim-stale.mjs', import.meta.url), 'utf8');
  assert.equal(source.split("'worktree', 'remove'").length - 1, 1, 'one removal site');
  const fnStart = source.indexOf('export async function reclaimStaleWorktrees');
  assert.ok(fnStart >= 0, 'reclaimStaleWorktrees must exist');
  const fn = source.slice(fnStart);
  const removalCalls = [...fn.matchAll(/removeReclaimable\(/g)].map((m) => m.index);
  assert.equal(removalCalls.length, 1);
  assert.ok(fn.indexOf('await acquireLock(') < removalCalls[0] && removalCalls[0] < fn.indexOf('releaseFinishLock(handle)'));
  assert.ok(fn.indexOf('recheckUnderLock(') < removalCalls[0], 're-check before removing');
});

test('a live finish ticket naming the worktree, or a running process whose cwd is inside it, blocks the reclaim', async () => {
  const fx = makeFixtureRepo();
  const path = await landedIdleWorktree(fx, 'queued');
  const repo = discoverRepo(fx.primaryDir);
  const stateDir = join(fx.primaryDir, '.git', 'worktree-guard-state');
  const queueDir = join(stateDir, 'finish.queue');
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, 'ticket-1.json'), JSON.stringify({ pid: process.pid, worktree: path, enqueuedAt: new Date().toISOString() }));

  const options = { staleDays: 14, worktreeRoot: fx.worktreeRoot, stateDir, liveCwds: null, out: () => {} };
  const withTicket = await reclaimStaleWorktrees(repo, config, options);
  assert.match(withTicket.blocked[0].reasons.join(';'), /live finish ticket/);

  writeFileSync(join(queueDir, 'ticket-1.json'), JSON.stringify({ pid: process.pid, worktree: '/elsewhere', enqueuedAt: new Date().toISOString() }));
  const withCwd1 = await reclaimStaleWorktrees(repo, config, { ...options, liveCwds: new Set([join(statSync(path).isDirectory() ? path : '', 'subdir')]) });
  assert.match(withCwd1.blocked[0].reasons.join(';'), /running process/);

  const clear = await reclaimStaleWorktrees(repo, config, options);
  assert.equal(clear.removable.length, 1);
  assert.ok(existsSync(path), 'dry run');
});

test('plain cleanup applies the same activity floor to lifecycle=merged worktrees', async () => {
  const fx = makeFixtureRepo();
  const fresh = await createWorktree(fx, 'merged-fresh');
  const old = await createWorktree(fx, 'merged-old');
  for (const path of [fresh, old]) writeWorktreeMetadata(path, { lifecycle: 'merged' }, config);
  assert.equal(readWorktreeMetadata(old, config).lifecycle, 'merged');
  ageWorktree(old, 5);

  const first = await withCwd(fx.primaryDir, () => capture(() => main(['cleanup'])));
  assert.equal(first.result, 0);
  assert.ok(first.logs.some((line) => /cleanup-skipped:/.test(line) && /active-recent/.test(line) && line.includes('merged-fresh')), first.logs.join('\n'));
  assert.ok(existsSync(fresh));
  assert.equal(existsSync(old), false);

  const forced = await withCwd(fx.primaryDir, () => capture(() => main(['cleanup', '--allow-recent'])));
  assert.equal(forced.result, 0);
  assert.equal(existsSync(fresh), false);
});
