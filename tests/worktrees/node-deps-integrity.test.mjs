// worktree-guard/node-deps-integrity.test.mjs
//
// Tests for the dependency-vs-lockfile stamp check: the module on its own
// (plain temp directories, a fake install command that writes a marker file) and
// wired into `create` / `finish` / `deps-sync` against real throwaway repos.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

import { main } from '../../src/worktrees/cli.mjs';
import { DEFAULT_CONFIG, loadConfig } from '../../src/worktrees/config.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';
import {
  checkNodeDeps,
  ensureNodeDepsMatchLockfile,
  lockfileSha,
  readNodeDepsStamp,
  resolveNodeDepsSettings,
  writeNodeDepsStamp,
} from '../../src/worktrees/node-deps-integrity.mjs';

after(cleanupTempDirs);

const STAMP = 'node_modules/.worktree-guard-lockfile-stamp';
const CROSS_PLATFORM_COMMAND = fileURLToPath(new URL('./fixtures/cross-platform-command.mjs', import.meta.url));
const quoteShellArg = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
const nodeFixture = (...args) => [process.execPath, CROSS_PLATFORM_COMMAND, ...args].map(quoteShellArg).join(' ');
// Appends a line per run, so the number of installs is countable.
const FAKE_INSTALL = nodeFixture('install');

function configWith(nodeDeps, extra = {}) {
  return { ...DEFAULT_CONFIG, nodeDeps, ...extra };
}

function makeTree(lock = 'lock v1\n') {
  const root = mkdtempTracked('wtg-node-deps-');
  writeFileSync(join(root, 'package-lock.json'), lock);
  return root;
}

function installCount(root) {
  const file = join(root, 'node_modules', 'install.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

function collect() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

const statusLine = (lines) => lines.filter((line) => /phase=deps-integrity status=/.test(line));

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------

test('feature OFF: an empty nodeDeps.lockfile (or a missing lockfile) does nothing and says so in one line', () => {
  const root = makeTree();
  const off = collect();
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config: configWith({ lockfile: '' }), log: off.log });
  assert.equal(result.status, 'off');
  assert.equal(installCount(root), 0);
  assert.equal(statusLine(off.lines).length, 1);
  assert.match(statusLine(off.lines)[0], /^\[worktree-guard\] phase=deps-integrity status=off ms=\d+$/);

  assert.equal(ensureNodeDepsMatchLockfile({
    worktreeRoot: root, config: configWith({ lockfile: 'no-such.lock', installCommand: FAKE_INSTALL }), log: () => {},
  }).status, 'off');
  // The default config ships OFF.
  assert.equal(checkNodeDeps({ worktreeRoot: root, config: DEFAULT_CONFIG }).status, 'off');
});

test('fresh: a matching stamp is a fast no-op that does not run the install command', () => {
  const root = makeTree();
  const config = configWith({ lockfile: 'package-lock.json', installCommand: FAKE_INSTALL });
  writeNodeDepsStamp(root, STAMP, lockfileSha(root, 'package-lock.json'));
  const out = collect();
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: out.log });
  assert.equal(result.status, 'fresh');
  assert.equal(installCount(root), 0);
  assert.match(statusLine(out.lines)[0], /status=fresh ms=\d+$/);
});

test('stale => installed: a missing or different stamp runs the install command once, records the stamp, and the next call is fresh', () => {
  const root = makeTree();
  const config = configWith({ lockfile: 'package-lock.json', installCommand: FAKE_INSTALL });

  const first = collect();
  assert.equal(ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: first.log }).status, 'installed');
  assert.equal(installCount(root), 1);
  assert.equal(readNodeDepsStamp(root, STAMP), lockfileSha(root, 'package-lock.json'));
  assert.match(statusLine(first.lines)[0], /status=installed/);

  assert.equal(ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: () => {} }).status, 'fresh');
  assert.equal(installCount(root), 1);

  // The lockfile moves (a rebase pulled in a new version): stale again.
  writeFileSync(join(root, 'package-lock.json'), 'lock v2\n');
  assert.equal(checkNodeDeps({ worktreeRoot: root, config }).reason, 'stamp-mismatch');
  assert.equal(ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: () => {} }).status, 'installed');
  assert.equal(installCount(root), 2);
  assert.equal(readNodeDepsStamp(root, STAMP), lockfileSha(root, 'package-lock.json'));
});

test('a failing install fails CLOSED: status failed, the exact repair command and output tail in the message, no stamp written', () => {
  const root = makeTree();
  const installCommand = nodeFixture('fail', 'registry unreachable', '3');
  const config = configWith({ lockfile: 'package-lock.json', installCommand });
  const out = collect();
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: out.log });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'install-failed');
  assert.match(result.message, /exit 3/);
  assert.match(result.message, /registry unreachable/);
  assert.ok(result.message.includes(`cd "${root}" && ${installCommand}`), result.message);
  assert.match(result.message, /worktree-guard deps-sync/);
  assert.equal(readNodeDepsStamp(root, STAMP), null);
  assert.match(statusLine(out.lines)[0], /status=failed/);
  // And it stays failed: stale is never silently promoted to fresh.
  assert.equal(ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: () => {} }).status, 'failed');
});

test('an install that rewrites the lockfile fails, and no stamp is written', () => {
  const root = makeTree();
  const config = configWith({ lockfile: 'package-lock.json', installCommand: nodeFixture('tamper-lockfile') });
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'lockfile-modified');
  assert.equal(readNodeDepsStamp(root, STAMP), null);
});

test('no install command at all (nodeDeps.installCommand and postCreateInstallCommand both empty) fails closed with guidance; the legacy post-create command is the fallback', () => {
  const root = makeTree();
  const noCommand = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config: configWith({ lockfile: 'package-lock.json' }), log: () => {} });
  assert.equal(noCommand.status, 'failed');
  assert.equal(noCommand.reason, 'no-install-command');
  assert.match(noCommand.message, /nodeDeps\.installCommand or postCreateInstallCommand/);

  const fallback = ensureNodeDepsMatchLockfile({
    worktreeRoot: root,
    config: configWith({ lockfile: 'package-lock.json' }, { postCreateInstallCommand: FAKE_INSTALL }),
    log: () => {},
  });
  assert.equal(fallback.status, 'installed');
  assert.equal(installCount(root), 1);
});

test('check mode (worker roles) never installs: a stale tree is reported with a WARN and the repair command', () => {
  const root = makeTree();
  const config = configWith({ lockfile: 'package-lock.json', installCommand: FAKE_INSTALL });
  const out = collect();
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, mode: 'check', log: out.log });
  assert.equal(result.status, 'stale');
  assert.equal(installCount(root), 0);
  assert.ok(out.lines.some((line) => /WARN: installed dependencies do not match package-lock\.json/.test(line) && line.includes(FAKE_INSTALL)), out.lines.join('\n'));
});

test('provisionIfMissing: false leaves a tree whose dependency directory never existed alone', () => {
  const root = makeTree();
  const config = configWith({ lockfile: 'package-lock.json', installCommand: FAKE_INSTALL });
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, provisionIfMissing: false, log: () => {} });
  assert.equal(result.status, 'off');
  assert.equal(installCount(root), 0);
  mkdirSync(join(root, 'node_modules'));
  assert.equal(ensureNodeDepsMatchLockfile({ worktreeRoot: root, config, provisionIfMissing: false, log: () => {} }).status, 'installed');
});

test('a stamp path that escapes the worktree is refused (fail closed), and settings fall back per key', () => {
  const root = makeTree();
  const escaping = configWith({ lockfile: 'package-lock.json', stampFile: '../outside-stamp', installCommand: FAKE_INSTALL });
  const result = ensureNodeDepsMatchLockfile({ worktreeRoot: root, config: escaping, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'stamp-write-failed');
  assert.equal(existsSync(join(root, '..', 'outside-stamp')), false);

  assert.deepEqual(resolveNodeDepsSettings({ nodeDeps: { lockfile: 'a.lock' } }), {
    lockfile: 'a.lock', stampFile: STAMP, installCommand: '',
  });
  assert.deepEqual(resolveNodeDepsSettings({}), { lockfile: '', stampFile: STAMP, installCommand: '' });
});

test('the stamp is replaced atomically: a hardlinked stamp from another checkout is not corrupted', () => {
  const root = makeTree();
  mkdirSync(join(root, 'node_modules'));
  const shared = join(root, 'shared-stamp');
  writeFileSync(shared, `${'a'.repeat(64)}\n`);
  linkSync(shared, join(root, STAMP));
  writeNodeDepsStamp(root, STAMP, 'b'.repeat(64));
  assert.equal(readFileSync(shared, 'utf8').trim(), 'a'.repeat(64), 'the other link keeps its content');
  assert.equal(readNodeDepsStamp(root, STAMP), 'b'.repeat(64));
});

// ---------------------------------------------------------------------------
// wired into create / finish / deps-sync
// ---------------------------------------------------------------------------

function run(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: isolatedFixtureGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
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

function makeProject() {
  const root = mkdtempTracked('wtg-node-deps-cli-');
  const remoteDir = join(root, 'remote.git');
  const primaryDir = join(root, 'primary');
  run(['init', '--bare', '--initial-branch=main', remoteDir], root);
  run(['clone', '--shared', remoteDir, primaryDir], root);
  writeFileSync(join(primaryDir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(primaryDir, 'package-lock.json'), 'lock v1\n');
  writeFileSync(join(primaryDir, 'README.md'), '# fixture\n');
  run(['add', '-A'], primaryDir);
  run(['commit', '-m', 'initial commit'], primaryDir);
  run(['push', 'origin', 'HEAD:refs/heads/main'], primaryDir);
  run(['branch', '--set-upstream-to=origin/main', 'main'], primaryDir);
  const configPath = join(root, 'wtg.json');
  const writeConfig = (nodeDeps) => writeFileSync(configPath, JSON.stringify({
    nodeDeps,
    identity: { name: 'Synthetic Worktree Bot', email: 'worker@worktree-kit.test' },
  }));
  writeConfig({ lockfile: 'package-lock.json', installCommand: FAKE_INSTALL });
  return { root, remoteDir, primaryDir, configPath, writeConfig, worktreeRoot: join(root, 'worktrees') };
}

function pushMainChange(fx, file, contents, message) {
  fx.changeSequence = (fx.changeSequence ?? 0) + 1;
  const changeClone = join(fx.root, `remote-change-${fx.changeSequence}`);
  run(['clone', '--shared', fx.remoteDir, changeClone], fx.root);
  writeFileSync(join(changeClone, file), contents);
  run(['add', file], changeClone);
  run(['commit', '-m', message], changeClone);
  const sha = run(['rev-parse', 'HEAD'], changeClone);
  run(['push', 'origin', 'HEAD:refs/heads/main'], changeClone);
  // The fixture's primary only refreshes its permitted remote-tracking ref.
  run(['fetch', 'origin', 'main'], fx.primaryDir);
  return sha;
}

const create = (fx, name, extra = []) => withCwd(fx.primaryDir, () => capture(() => (
  main(['create', '--name', name, '--tool', 'claude', '--worktree-root', fx.worktreeRoot, '--config', fx.configPath, ...extra])
)));

const worktreeOf = (fx, name) => discoverRepo(fx.primaryDir).worktrees.find((w) => w.branch === `claude/${name}`)?.path;

test('create installs stale dependencies before handing out the path, and the log has the one status line', async () => {
  const fx = makeProject();
  const out = await create(fx, 'fresh-start');
  assert.equal(out.result, 0, out.errors.join('\n'));
  const path = worktreeOf(fx, 'fresh-start');
  assert.equal(installCount(path), 1);
  assert.equal(readNodeDepsStamp(path, STAMP), lockfileSha(path, 'package-lock.json'));
  assert.equal(statusLine(out.logs).length, 1);
  assert.match(statusLine(out.logs)[0], /status=installed/);
  const createdIndex = out.logs.findIndex((line) => /created branch/.test(line));
  assert.ok(createdIndex > out.logs.findIndex((line) => /phase=deps-integrity/.test(line)), 'the path is announced after the check');
});

test('create fails closed when the install fails: non-zero exit, no "created" line, the repair command is printed', async () => {
  const fx = makeProject();
  fx.writeConfig({ lockfile: 'package-lock.json', installCommand: nodeFixture('fail', 'fixture failure', '4') });
  const out = await create(fx, 'bad-install');
  assert.equal(out.result, 1);
  assert.equal(out.logs.some((line) => /created branch/.test(line)), false);
  assert.match(out.errors.join('\n'), /Repair: cd ".*" && ".*cross-platform-command\.mjs" "fail"/);
  assert.ok(out.logs.some((line) => /status=failed/.test(line)));
});

test('create --worker never installs: a stale tree gets a WARN with the repair command instead', async () => {
  const fx = makeProject();
  const out = await create(fx, 'worker-lane', ['--worker']);
  assert.equal(out.result, 0, out.errors.join('\n'));
  const path = worktreeOf(fx, 'worker-lane');
  assert.equal(installCount(path), 0);
  assert.ok(out.logs.some((line) => /WARN: installed dependencies do not match/.test(line) && line.includes(FAKE_INSTALL)), out.logs.join('\n'));
  assert.ok(out.logs.some((line) => /created branch/.test(line)));
});

test('create with the feature off (default config) is unchanged apart from one status=off line', async () => {
  const fx = makeProject();
  const out = await withCwd(fx.primaryDir, () => capture(() => (
    main(['create', '--name', 'plain', '--tool', 'claude', '--worktree-root', fx.worktreeRoot])
  )));
  assert.equal(out.result, 0, out.errors.join('\n'));
  assert.match(statusLine(out.logs)[0], /status=off/);
  assert.equal(existsSync(join(worktreeOf(fx, 'plain'), 'node_modules')), false);
});

test('finish re-installs after the rebase pulled in a new lockfile, before pushing', async () => {
  const fx = makeProject();
  assert.equal((await create(fx, 'rebase-lock')).result, 0);
  const path = worktreeOf(fx, 'rebase-lock');
  assert.equal(installCount(path), 1);

  // main's lockfile moves while the worktree works on something else.
  pushMainChange(fx, 'package-lock.json', 'lock v2\n', 'bump lockfile');
  writeFileSync(join(path, 'feature.txt'), 'feature\n');

  const out = await withCwd(path, () => capture(() => (
    main(['finish', '--message', 'feature', '--no-wait', '--config', fx.configPath])
  )));
  assert.equal(out.result, 0, out.errors.join('\n'));
  assert.match(statusLine(out.logs)[0], /status=installed/);
  assert.equal(run(['show', 'main:feature.txt'], fx.remoteDir), 'feature');
});

test('finish stops BEFORE the push when the dependency repair fails, keeping the worktree and the remote untouched', async () => {
  const fx = makeProject();
  assert.equal((await create(fx, 'finish-fails')).result, 0);
  const path = worktreeOf(fx, 'finish-fails');

  pushMainChange(fx, 'package-lock.json', 'lock v2\n', 'bump lockfile');
  const remoteBefore = run(['rev-parse', 'main'], fx.remoteDir);
  fx.writeConfig({ lockfile: 'package-lock.json', installCommand: nodeFixture('fail', 'fixture failure', '9') });
  writeFileSync(join(path, 'feature.txt'), 'feature\n');

  const out = await withCwd(path, () => capture(() => (
    main(['finish', '--message', 'feature', '--no-wait', '--config', fx.configPath])
  )));
  assert.equal(out.result, 1);
  assert.match(out.errors.join('\n'), /deps-integrity: the install command failed/);
  assert.match(out.errors.join('\n'), /Repair: cd /);
  assert.equal(run(['rev-parse', 'main'], fx.remoteDir), remoteBefore, 'nothing was pushed');
  assert.equal(existsSync(path), true);
});

test('deps-sync repairs a stale worktree on demand, fails closed when the install fails, and says so when the feature is off', async () => {
  const fx = makeProject();
  assert.equal((await create(fx, 'manual-sync', ['--worker'])).result, 0);
  const path = worktreeOf(fx, 'manual-sync');
  assert.equal(installCount(path), 0);

  const synced = await withCwd(path, () => capture(() => main(['deps-sync', '--config', fx.configPath])));
  assert.equal(synced.result, 0, synced.errors.join('\n'));
  assert.equal(installCount(path), 1);
  assert.match(statusLine(synced.logs)[0], /status=installed/);
  assert.match(statusLine((await withCwd(path, () => capture(() => main(['deps-sync', '--config', fx.configPath])))).logs)[0], /status=fresh/);

  writeFileSync(join(path, 'package-lock.json'), 'lock v9\n');
  fx.writeConfig({ lockfile: 'package-lock.json', installCommand: nodeFixture('fail', 'fixture failure', '2') });
  const failed = await withCwd(path, () => capture(() => main(['deps-sync', '--config', fx.configPath])));
  assert.equal(failed.result, 1);
  assert.match(failed.errors.join('\n'), /Repair: cd /);

  const off = await withCwd(path, () => capture(() => main(['deps-sync'])));
  assert.equal(off.result, 0);
  assert.match(statusLine(off.logs)[0], /status=off/);
});

test('loadConfig keeps the node-deps defaults available to the CLI', () => {
  assert.equal(loadConfig(undefined, {}).nodeDeps.lockfile, '');
});
