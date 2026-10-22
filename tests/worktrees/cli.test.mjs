// worktree-guard/cli.test.mjs
//
// Tests for the CLI entry point (cli.mjs). Exercises argv parsing, the
// "help short-circuits before any side effect" regression across every
// position help can appear in, and end-to-end command flows against real
// throwaway git repos (a bare "remote" + a "primary" clone), because every
// command here is thin glue around real git/fs operations and a mock would
// just re-describe the implementation.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isolatedFixtureGitEnv,
  withFixtureCommitIdentity,
} from '../support/isolated-git-env.mjs';

import { main, parseArgs, removeWorktreeSafely } from '../../src/worktrees/cli.mjs';
import { discoverRepo, readWorktreeMetadata } from '../../src/worktrees/worktree-core.mjs';
import { stashGuardStatus, primaryAuditLogPath } from '../../src/worktrees/hooks.mjs';
import { loadConfig } from '../../src/worktrees/config.mjs';
import { aiParentEnvMarkers } from '../../src/worktrees/process-provenance.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';

// The suite may itself run inside an AI CLI session, which exports the very
// markers sync-primary treats as proof of AI-parenthood. A "human shell" test
// must scrub every configured marker.
const NO_AI_MARKERS = Object.fromEntries(aiParentEnvMarkers(loadConfig()).map((name) => [name, undefined]));
const CROSS_PLATFORM_COMMAND = fileURLToPath(new URL('./fixtures/cross-platform-command.mjs', import.meta.url));
const quoteShellArg = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
const nodeFixture = (...args) => [process.execPath, CROSS_PLATFORM_COMMAND, ...args].map(quoteShellArg).join(' ');

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

function run(cmd, args, cwd) {
  const result = spawnSync(
    cmd,
    cmd === 'git' ? withFixtureCommitIdentity(args) : args,
    {
      cwd,
      encoding: 'utf8',
      ...(cmd === 'git' ? { env: isolatedFixtureGitEnv() } : {}),
    },
  );
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * A throwaway bare "remote" repo plus a "primary" clone of it, with an
 * initial commit already pushed to `main` and upstream tracking configured
 * -- everything commandCreate/commandFinish/commandSyncPrimary need to
 * operate against a real repo end to end.
 */
function makeFixtureRepo(rootDir, { fileCount = 0 } = {}) {
  const remoteDir = join(rootDir, 'remote.git');
  const primaryDir = join(rootDir, 'primary');

  run('git', ['init', '--bare', '--initial-branch=main', remoteDir], rootDir);
  run('git', ['clone', '--shared', remoteDir, primaryDir], rootDir);

  writeFileSync(join(primaryDir, 'README.md'), '# fixture\n');
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(primaryDir, `file${i}.txt`), `content ${i}\n`);
  }

  run('git', ['add', '-A'], primaryDir);
  run('git', ['commit', '-m', 'initial commit'], primaryDir);
  run('git', ['push', 'origin', 'HEAD:refs/heads/main'], primaryDir);
  run('git', ['branch', '--set-upstream-to=origin/main', 'main'], primaryDir);

  return { remoteDir, primaryDir };
}

test('safe removal moves the process cwd to the surviving primary before deleting a worktree', () => {
  const original = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'wtg-remove-own-cwd-'));
  try {
    const { primaryDir } = makeFixtureRepo(root);
    const worktreePath = join(root, 'worktrees', 'candidate');
    run('git', ['worktree', 'add', '-b', 'claude/remove-own-cwd', worktreePath, 'main'], primaryDir);

    process.chdir(worktreePath);
    removeWorktreeSafely({ projectRoot: worktreePath, worktreePath, primaryPath: primaryDir });

    assert.equal(process.cwd(), realpathSync(primaryDir), 'do not restore cwd into the directory that Git removed');
    assert.equal(existsSync(worktreePath), false);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

async function withCwd(dir, fn, { worktreeTool = 'claude' } = {}) {
  const original = process.cwd();
  const originalWorktreeTool = process.env.WTG_WORKTREE_TOOL;
  const originalConfigPath = process.env.WTG_CONFIG_PATH;
  const configDir = mkdtempSync(join(tmpdir(), 'wtg-cli-test-config-'));
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ identity: { name: 'Synthetic Worktree Bot', email: 'worker@worktree-kit.test' } }));
  process.chdir(dir);
  process.env.WTG_WORKTREE_TOOL = worktreeTool;
  process.env.WTG_CONFIG_PATH = configPath;
  try {
    return await fn();
  } finally {
    if (originalWorktreeTool === undefined) delete process.env.WTG_WORKTREE_TOOL;
    else process.env.WTG_WORKTREE_TOOL = originalWorktreeTool;
    if (originalConfigPath === undefined) delete process.env.WTG_CONFIG_PATH;
    else process.env.WTG_CONFIG_PATH = originalConfigPath;
    process.chdir(original);
    rmSync(configDir, { recursive: true, force: true });
  }
}

// A value of `undefined` removes the variable for the duration of `fn`.
async function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

async function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function findManagedWorktree(repo, branchPrefix) {
  return repo.worktrees.find((w) => w.branch && w.branch.startsWith(branchPrefix));
}

// ---------------------------------------------------------------------------
// ① parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: --key=value, --key value, boolean flags, and positionals', () => {
  const result = parseArgs(['create', '--name=my task', '--base', 'develop', '--dry-run', 'extra', '--worker']);
  assert.equal(result.command, 'create');
  assert.equal(result.flags.name, 'my task');
  assert.equal(result.flags.base, 'develop');
  assert.equal(result.flags.dryRun, true);
  assert.equal(result.flags.worker, true);
  assert.deepEqual(result.positional, ['extra']);
  assert.equal(result.help, false);
});

test('parseArgs: a leading "--" separator is stripped', () => {
  const result = parseArgs(['--', 'status', '--strict']);
  assert.equal(result.command, 'status');
  assert.equal(result.flags.strict, true);
});

test('parseArgs: kebab-case flag names are camelCased', () => {
  const result = parseArgs(['create', '--worktree-root', '/tmp/x', '--wait-timeout-min=5']);
  assert.equal(result.flags.worktreeRoot, '/tmp/x');
  assert.equal(result.flags.waitTimeoutMin, '5');
});

test('parseArgs: a boolean flag never consumes the next token as its value', () => {
  const result = parseArgs(['finish', '--no-wait', '--message', 'done']);
  assert.equal(result.flags.noWait, true);
  assert.equal(result.flags.message, 'done');
});

test('parseArgs: defaults to the "status" command with empty argv', () => {
  const result = parseArgs([]);
  assert.equal(result.command, 'status');
  assert.deepEqual(result.flags, {});
  assert.deepEqual(result.positional, []);
  assert.equal(result.help, false);
});

// ---------------------------------------------------------------------------
// ② cross-cutting: help short-circuits before any side effect, everywhere
// ---------------------------------------------------------------------------

test('help short-circuits before any git/fs side effect, in every position it can appear', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-help-'));
  try {
    const { logs } = await withCwd(tmp, () => captureConsole(async () => {
      for (const argv of [
        ['--help'],
        ['-h'],
        ['help'],
        ['status', '--help'],
        ['create', '--help', '--name', 'x'],
        ['finish', '--help'],
        ['sync-primary', '--help'],
        ['bogus-command', '--help'],
      ]) {
        const code = await main(argv);
        assert.equal(code, 0, `expected help to return 0 for argv=${JSON.stringify(argv)}`);
      }
    }));
    assert.ok(logs.some((l) => l.includes('Usage: worktree-guard')), 'expected help text to be printed');

    // `tmp` is not a git repo at all -- if help had NOT short-circuited
    // before discoverRepo()/loadConfig() side effects, at least one of
    // those eight calls would have thrown ("not a git repository") instead
    // of returning 0, and/or left files behind. Neither happened.
    assert.deepEqual(readdirSync(tmp), [], 'help must not create any files as a side effect');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ③④⑤ create -> finish -> sync-primary, chained against one real fixture repo
// ---------------------------------------------------------------------------

test('create -> finish -> sync-primary: full worker lifecycle against a real remote', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-lifecycle-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    const config = loadConfig();

    // ③ create
    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'lifecycle task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repoAfterCreate = discoverRepo(primaryDir);
    const created = findManagedWorktree(repoAfterCreate, 'claude/lifecycle-task');
    assert.ok(created, 'expected a created claude/lifecycle-task* worktree');
    assert.ok(existsSync(created.path));

    const metadata = readWorktreeMetadata(created.path, config);
    assert.equal(metadata.managed, 'true');
    assert.equal(metadata.lifecycle, 'active');
    assert.equal(metadata['base-ref'], 'main');
    assert.equal(metadata['created-by'], 'claude');

    const stashStatus = stashGuardStatus(created.path, config);
    assert.equal(stashStatus.installed, true);
    assert.equal(stashStatus.intact, true);

    // ④ finish
    writeFileSync(join(created.path, 'change.txt'), 'hello from worker\n');
    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'test commit', '--no-wait'])
    )));
    assert.equal(finishRun.result, 0, finishRun.errors.join('\n'));
    assert.equal(existsSync(created.path), false, 'worker worktree should be removed after a successful finish');

    const pushedSubject = run('git', ['log', '-1', '--format=%s', 'main'], remoteDir).trim();
    assert.equal(pushedSubject, 'test commit');

    // ⑤ sync-primary (chained on top of the finish above)
    assert.equal(existsSync(join(primaryDir, 'change.txt')), false, 'primary should not have the change yet');
    const syncRun = await withEnv({ ...NO_AI_MARKERS, WTG_TEST_PARENT_CHAIN_OVERRIDE: '/bin/zsh -l' }, () => (
      withCwd(primaryDir, () => captureConsole(() => main(['sync-primary'])))
    ));
    assert.equal(syncRun.result, 0, syncRun.errors.join('\n'));
    assert.equal(existsSync(join(primaryDir, 'change.txt')), true, 'primary should fast-forward to include the pushed change');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('create honors either supported fixture tool prefix', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-tool-prefix-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    for (const tool of ['claude', 'codex']) {
      const worktreeRoot = join(tmp, `worktrees-${tool}`);
      const createRun = await withCwd(primaryDir, () => captureConsole(() => (
        main(['create', '--name', `${tool} task`, '--worktree-root', worktreeRoot])
      )), { worktreeTool: tool });
      assert.equal(createRun.result, 0, createRun.errors.join('\n'));

      const created = findManagedWorktree(discoverRepo(primaryDir), `${tool}/${tool}-task`);
      assert.ok(created, `expected a created ${tool}/${tool}-task* worktree`);
      assert.equal(readWorktreeMetadata(created.path, loadConfig())['created-by'], tool);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('create --base <remote>/<branch> normalizes base-ref to the plain branch name, so finish can fetch/push correctly', async () => {
  // Regression test: passing a fully-qualified remote ref (a legitimate way
  // to branch from the remote's exact tip rather than a possibly-stale
  // local branch) must not leak "origin/main" verbatim into the stored
  // base-ref -- finish reads that field back to build a fetch refspec
  // (refs/heads/${baseBranch}), and "origin/main" there produces the
  // malformed, nonexistent ref "refs/heads/origin/main".
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-baseref-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    const config = loadConfig();

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'base ref task', '--worktree-root', worktreeRoot, '--base', 'origin/main'])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/base-ref-task');
    assert.ok(created);

    const metadata = readWorktreeMetadata(created.path, config);
    assert.equal(metadata['base-ref'], 'main', 'base-ref must be normalized to the plain branch name, not "origin/main"');

    writeFileSync(join(created.path, 'change.txt'), 'hello\n');
    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'base ref regression test', '--no-wait'])
    )));
    assert.equal(finishRun.result, 0, finishRun.errors.join('\n'));

    const pushedSubject = run('git', ['log', '-1', '--format=%s', 'main'], remoteDir).trim();
    assert.equal(pushedSubject, 'base ref regression test');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑥ mass-deletion guard actually blocks finish
// ---------------------------------------------------------------------------

test('finish refuses a mass-deletion diff without --allow-mass-deletion, leaving the worktree intact', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-massdel-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp, { fileCount: 25 });
    const worktreeRoot = join(tmp, 'worktrees');

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'mass deletion task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/mass-deletion-task');
    assert.ok(created);

    for (let i = 0; i < 25; i += 1) {
      rmSync(join(created.path, `file${i}.txt`));
    }

    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'delete everything', '--no-wait'])
    )));
    assert.equal(finishRun.result, 1);
    assert.ok(
      finishRun.errors.some((line) => /25/.test(line) && /mass deletion/i.test(line)),
      `expected an error mentioning the deleted-file count, got: ${finishRun.errors.join('\n')}`,
    );
    assert.equal(existsSync(created.path), true, 'the worktree must not be cleaned up when mass-deletion is refused');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑦ unknown command
// ---------------------------------------------------------------------------

test('an unknown command returns 1 and prints the available command list', async () => {
  const { result, logs, errors } = await captureConsole(() => main(['not-a-real-command']));
  assert.equal(result, 1);
  assert.ok(errors.some((l) => l.includes('unknown command: not-a-real-command')));
  assert.ok(logs.some((l) => l.includes('Usage: worktree-guard')));
  assert.ok(logs.some((l) => l.includes('status')) && logs.some((l) => l.includes('cleanup')));
});

// ---------------------------------------------------------------------------
// ⑧ read-only diagnostic commands
// ---------------------------------------------------------------------------

test('read-only diagnostics (stash-audit, stash-guard status, primary-audit) run cleanly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-readonly-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'readonly checks', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/readonly-checks');
    assert.ok(created);

    const stashGuardRun = await withCwd(created.path, () => captureConsole(() => main(['stash-guard', 'status'])));
    assert.equal(stashGuardRun.result, 0, stashGuardRun.errors.join('\n'));
    assert.ok(stashGuardRun.logs.some((l) => l.includes('installed=true')));

    const stashAuditRun = await withCwd(primaryDir, () => captureConsole(() => main(['stash-audit'])));
    assert.equal(stashAuditRun.result, 0, stashAuditRun.errors.join('\n'));

    const primaryAuditRun = await withCwd(primaryDir, () => captureConsole(() => main(['primary-audit'])));
    assert.equal(primaryAuditRun.result, 0, primaryAuditRun.errors.join('\n'));
    assert.ok(primaryAuditRun.logs.some((l) => l.startsWith('Branch: main')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑨ create fetches the base branch's remote before branching (loud unless
//    --offline)
// ---------------------------------------------------------------------------

test('create fetches the base branch from its remote and bases the new worktree on the fresh remote-tracking ref', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-fetch-base-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');

    // A second clone pushes a commit straight to the shared remote -- this
    // primary checkout's local "main" never fetches it, so it is now stale
    // relative to origin/main, exactly the scenario T-W61 covers (a parallel
    // worker finishes/pushes between when this session last synced primary
    // and when it creates a new worktree).
    const otherClone = join(tmp, 'other-clone');
    run('git', ['clone', '--shared', remoteDir, otherClone], tmp);
    writeFileSync(join(otherClone, 'remote-only.txt'), 'pushed by someone else\n');
    run('git', ['add', '-A'], otherClone);
    run('git', ['commit', '-m', 'a commit only on the remote'], otherClone);
    run('git', ['push', 'origin', 'HEAD:refs/heads/main'], otherClone);

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'fetch base task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/fetch-base-task');
    assert.ok(created);
    assert.equal(
      existsSync(join(created.path, 'remote-only.txt')),
      true,
      'the new worktree must be based on the freshly-fetched remote tip, not the stale local "main"',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('create --offline skips the fetch, warns, and falls back to the (possibly stale) local base branch', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-offline-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');

    const otherClone = join(tmp, 'other-clone');
    run('git', ['clone', '--shared', remoteDir, otherClone], tmp);
    writeFileSync(join(otherClone, 'remote-only.txt'), 'pushed by someone else\n');
    run('git', ['add', '-A'], otherClone);
    run('git', ['commit', '-m', 'a commit only on the remote'], otherClone);
    run('git', ['push', 'origin', 'HEAD:refs/heads/main'], otherClone);

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'offline task', '--worktree-root', worktreeRoot, '--offline'])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));
    assert.ok(createRun.errors.some((l) => /--offline/.test(l) && /skipping fetch/.test(l)));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/offline-task');
    assert.ok(created);
    assert.equal(
      existsSync(join(created.path, 'remote-only.txt')),
      false,
      '--offline must base on the stale local branch, never fetch',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('create fails loudly when the fetch itself fails (remote unreachable) and --offline was not passed', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-fetch-fail-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    rmSync(remoteDir, { recursive: true, force: true }); // simulate an unreachable remote

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'unreachable task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 1);
    assert.ok(createRun.errors.some((l) => /failed to fetch/.test(l) && /--offline/.test(l)));

    const repo = discoverRepo(primaryDir);
    assert.equal(findManagedWorktree(repo, 'claude/unreachable-task'), undefined, 'no worktree should be left behind');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑩ status: dirty / last-activity / last-commit-age / STALE-UNCOMMITTED
// ---------------------------------------------------------------------------

test('status reports dirty=, last-activity=, last-commit-age=, and flags STALE-UNCOMMITTED past --stale-minutes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-status-stale-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'stale task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const repo = discoverRepo(primaryDir);
    const created = findManagedWorktree(repo, 'claude/stale-task');
    assert.ok(created);

    // Clean worktree: dirty=0, never flagged, even with --stale-minutes 0.
    const cleanStatus = await withCwd(primaryDir, () => captureConsole(() => (
      main(['status', '--stale-minutes', '0'])
    )));
    assert.equal(cleanStatus.result, 0, cleanStatus.errors.join('\n'));
    assert.ok(cleanStatus.logs.some((l) => l.includes('dirty=0 files') && !l.includes('STALE-UNCOMMITTED')));

    // Dirty it, then re-check with --stale-minutes 0 (branch creation is
    // always "in the past" relative to now, so any threshold of 0 trips it).
    writeFileSync(join(created.path, 'uncommitted.txt'), 'not committed\n');
    const dirtyStatus = await withCwd(primaryDir, () => captureConsole(() => (
      main(['status', '--stale-minutes', '0'])
    )));
    assert.equal(dirtyStatus.result, 0, dirtyStatus.errors.join('\n'));
    assert.ok(dirtyStatus.logs.some((l) => l.includes('dirty=1 files') && l.includes('STALE-UNCOMMITTED')));

    // A high threshold must not flag it.
    const notYetStale = await withCwd(primaryDir, () => captureConsole(() => (
      main(['status', '--stale-minutes', '999999'])
    )));
    assert.ok(notYetStale.logs.some((l) => l.includes('dirty=1 files') && !l.includes('STALE-UNCOMMITTED')));

    // --stale filters to only flagged worktrees.
    const staleOnly = await withCwd(primaryDir, () => captureConsole(() => (
      main(['status', '--stale-minutes', '0', '--stale'])
    )));
    assert.ok(staleOnly.logs.some((l) => /1 stale of 1/.test(l)));

    // --json emits a parseable, equivalent object.
    const jsonRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['status', '--stale-minutes', '0', '--json'])
    )));
    assert.equal(jsonRun.result, 0, jsonRun.errors.join('\n'));
    const parsed = JSON.parse(jsonRun.logs.join('\n'));
    assert.equal(parsed.managed.length, 1);
    assert.equal(parsed.managed[0].dirtyCount, 1);
    assert.equal(parsed.managed[0].stale, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('status reads the first porcelain line intact: a tracked file modified only in the working tree still yields a last-activity age', async () => {
  // Regression: git() used to trim the whole porcelain blob, so the first line
  // " M README.md" arrived as "M README.md" and slice(3) produced "ADME.md" --
  // statSync failed silently and last-activity showed "-" for the only dirty file.
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-status-porcelain-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'porcelain task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));

    const created = findManagedWorktree(discoverRepo(primaryDir), 'claude/porcelain-task');
    writeFileSync(join(created.path, 'README.md'), '# fixture\nedited\n');
    assert.match(run('git', ['status', '--porcelain'], created.path), /^ M README\.md/);

    const jsonRun = await withCwd(primaryDir, () => captureConsole(() => main(['status', '--json'])));
    assert.equal(jsonRun.result, 0, jsonRun.errors.join('\n'));
    const row = JSON.parse(jsonRun.logs.join('\n')).managed[0];
    assert.equal(row.dirtyCount, 1);
    assert.notEqual(row.lastActivityAge, '-', 'the first (and only) dirty path must resolve to a real mtime');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('finish: a rebase conflict names the conflicting files (read before the abort clears them)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-finish-conflict-'));
  try {
    const { remoteDir, primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'conflict task', '--worktree-root', worktreeRoot])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));
    const created = findManagedWorktree(discoverRepo(primaryDir), 'claude/conflict-task');

    // Same file edited differently on the remote and in the worker.
    const otherClone = join(tmp, 'other-clone');
    run('git', ['clone', '--shared', remoteDir, otherClone], tmp);
    writeFileSync(join(otherClone, 'README.md'), '# remote edit\n');
    run('git', ['commit', '-am', 'remote edit'], otherClone);
    run('git', ['push', 'origin', 'HEAD:refs/heads/main'], otherClone);
    writeFileSync(join(created.path, 'README.md'), '# worker edit\n');

    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'worker edit', '--no-wait'])
    )));
    assert.equal(finishRun.result, 1);
    assert.ok(
      finishRun.errors.some((line) => line.includes('conflicting files: README.md')),
      finishRun.errors.join('\n'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: an AI-CLI env marker gates the command even when the ancestor chain looks human (any wrapper depth)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-gate-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const config = loadConfig();
    // The ancestor override simulates a deep wrapper chain that hides the AI CLI from the ps walk.
    const humanChain = { ...NO_AI_MARKERS, WTG_TEST_PARENT_CHAIN_OVERRIDE: '/bin/zsh -l' };

    // Idle self-authorization is switched off here so this test keeps proving the gate
    // itself: a marked context without the approval variable is refused.
    const configPath = join(tmp, 'wtg-no-idle.json');
    writeFileSync(configPath, JSON.stringify({ syncPrimary: { idleSelfAuthorize: false } }));
    const refused = await withEnv({ ...humanChain, CLAUDECODE: '1' }, () => (
      withCwd(primaryDir, () => captureConsole(() => main(['sync-primary', '--config', configPath])))
    ));
    assert.equal(refused.result, 1);
    assert.ok(refused.errors.some((l) => l.includes(config.envVars.syncPrimaryApprovedBy)), refused.errors.join('\n'));
    const auditLog = readFileSync(primaryAuditLogPath(primaryDir, config), 'utf8');
    assert.match(auditLog, /ai-parent=env:CLAUDECODE/);

    // The same call from a shell without any marker is not gated.
    const allowed = await withEnv(humanChain, () => (
      withCwd(primaryDir, () => captureConsole(() => main(['sync-primary', '--dry-run'])))
    ));
    assert.equal(allowed.result, 0, allowed.errors.join('\n'));

    // Explicit approval lifts the gate for a marked context.
    const approved = await withEnv(
      { ...humanChain, CODEX_SANDBOX: 'seatbelt', [config.envVars.syncPrimaryApprovedBy]: 'reviewer' },
      () => withCwd(primaryDir, () => captureConsole(() => main(['sync-primary', '--dry-run']))),
    );
    assert.equal(approved.result, 0, approved.errors.join('\n'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sync-primary: idle self-authorization (default on)
// ---------------------------------------------------------------------------

const IDLE_CALLER_PID = 5000;
const HOUR_MS = 60 * 60 * 1000;
const AI_CALLER_ENV = {
  ...NO_AI_MARKERS,
  CLAUDECODE: '1',
  WTG_TEST_PARENT_CHAIN_OVERRIDE: '/bin/zsh -l',
  WTG_SYNC_PRIMARY_APPROVED_BY: undefined,
  WTG_WORKTREE_ROLE: undefined,
};

/** Idle-scan seams over a fake process table; `calls.list` counts how often the scan ran. */
function idleSeams({ others = [], cwds = {}, listThrows = false } = {}) {
  const calls = { list: 0 };
  return {
    calls,
    seams: {
      selfPid: IDLE_CALLER_PID,
      now: () => Date.now() + HOUR_MS, // every existing commit is "old"
      listProcesses: () => {
        calls.list += 1;
        if (listThrows) throw new Error('process listing failed: ps exited 1');
        return [
          { pid: 4000, ppid: 1, commandLine: '/usr/local/bin/claude --resume' },
          { pid: IDLE_CALLER_PID, ppid: 4000, commandLine: 'node cli.mjs sync-primary' },
          ...others,
        ];
      },
      resolveCwds: (pids) => new Map(pids.map((pid) => [pid, cwds[pid] ?? null])),
    },
  };
}

async function runSyncPrimary({ cwd, env = AI_CALLER_ENV, seams, args = [] }) {
  return withEnv(env, () => withCwd(cwd, () => captureConsole(() => main(['sync-primary', '--dry-run', ...args], { idleSeams: seams }))));
}

function lastAuditEntry(primaryDir) {
  const lines = readFileSync(primaryAuditLogPath(primaryDir, loadConfig()), 'utf8').split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('sync-primary: an idle top-level AI session self-authorizes and the audit log says allowed-ai-idle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-idle-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const idle = idleSeams();
    const out = await runSyncPrimary({ cwd: primaryDir, seams: idle.seams });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.equal(idle.calls.list, 1, 'the scan ran');
    assert.ok(out.logs.some((l) => l.includes('idle-check: finish/queue')), out.logs.join('\n'));
    assert.ok(out.logs.some((l) => l.includes('self-authorized')));
    assert.equal(lastAuditEntry(primaryDir).result, 'allowed-ai-idle');
    assert.equal(lastAuditEntry(primaryDir).decision, 'allowed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sync-primary: the caller's own AI ancestor (cwd inside the repository) does not count as busy", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-own-tree-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    // pid 4000 is the caller's parent AI CLI in the fake table; its cwd is the primary checkout.
    const idle = idleSeams({ cwds: { 4000: primaryDir } });
    const out = await runSyncPrimary({ cwd: primaryDir, seams: idle.seams });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.equal(lastAuditEntry(primaryDir).result, 'allowed-ai-idle');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: each busy condition refuses, names the reason and logs refused-busy', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-busy-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const config = loadConfig();
    const stateDir = join(primaryDir, '.git', 'worktree-guard-state');

    // (c) another AI process inside the repository
    const other = { pid: 6000, ppid: 1, commandLine: '/usr/local/bin/codex exec' };
    const process_ = idleSeams({ others: [other], cwds: { 6000: primaryDir } });
    let out = await runSyncPrimary({ cwd: primaryDir, seams: process_.seams });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('pid=6000')), out.errors.join('\n'));
    assert.equal(lastAuditEntry(primaryDir).result, 'refused-busy');

    // (b) a live finish.lock
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'finish.lock'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    out = await runSyncPrimary({ cwd: primaryDir, seams: idleSeams().seams });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('finish.lock')), out.errors.join('\n'));
    rmSync(join(stateDir, 'finish.lock'));

    // (d) a managed worktree with uncommitted work
    const created = await withCwd(primaryDir, () => captureConsole(() => main(['create', '--name', 'busy-one', '--worktree-root', join(tmp, 'wt')])));
    assert.equal(created.result, 0, created.errors.join('\n'));
    const worktree = findManagedWorktree(discoverRepo(primaryDir), 'claude/busy-one');
    writeFileSync(join(worktree.path, 'wip.txt'), 'x\n');
    out = await runSyncPrimary({ cwd: primaryDir, seams: idleSeams().seams });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('uncommitted')), out.errors.join('\n'));
    assert.equal(lastAuditEntry(primaryDir).result, 'refused-busy');

    // all quiet again: allowed
    rmSync(join(worktree.path, 'wip.txt'));
    out = await runSyncPrimary({ cwd: primaryDir, seams: idleSeams().seams });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.ok(config);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: a probe that cannot run counts as busy (fail closed)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-failclosed-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const out = await runSyncPrimary({ cwd: primaryDir, seams: idleSeams({ listThrows: true }).seams });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('probe error') && l.includes('ps exited 1')), out.errors.join('\n'));
    assert.equal(lastAuditEntry(primaryDir).result, 'refused-busy');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: a worker context is refused even when everything is idle, and the scan never runs', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-worker-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const created = await withCwd(primaryDir, () => captureConsole(() => main(['create', '--name', 'w-one', '--worktree-root', join(tmp, 'wt')])));
    assert.equal(created.result, 0, created.errors.join('\n'));
    const worktree = findManagedWorktree(discoverRepo(primaryDir), 'claude/w-one');

    // cwd inside a managed worktree
    const idle = idleSeams();
    let out = await runSyncPrimary({ cwd: worktree.path, seams: idle.seams });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('never eligible')), out.errors.join('\n'));
    assert.equal(lastAuditEntry(primaryDir).result, 'refused');

    // the worker role variable, even with cwd in primary
    out = await runSyncPrimary({ cwd: primaryDir, env: { ...AI_CALLER_ENV, WTG_WORKTREE_ROLE: 'worker' }, seams: idle.seams });
    assert.equal(out.result, 1);
    assert.equal(idle.calls.list, 0, 'the scan is never consulted for a worker');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: the approval variable allows without running the scan, even when busy', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-approved-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const other = { pid: 6000, ppid: 1, commandLine: '/usr/local/bin/codex exec' };
    const busy = idleSeams({ others: [other], cwds: { 6000: primaryDir } });
    const out = await runSyncPrimary({
      cwd: primaryDir,
      env: { ...AI_CALLER_ENV, WTG_SYNC_PRIMARY_APPROVED_BY: 'reviewer' },
      seams: busy.seams,
    });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.equal(busy.calls.list, 0);
    assert.equal(lastAuditEntry(primaryDir).result, 'allowed-override');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: a human shell is not gated and does not run the scan', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-human-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const idle = idleSeams();
    const human = { ...NO_AI_MARKERS, WTG_TEST_PARENT_CHAIN_OVERRIDE: '/bin/zsh -l', WTG_SYNC_PRIMARY_APPROVED_BY: undefined, WTG_WORKTREE_ROLE: undefined };
    const out = await runSyncPrimary({ cwd: primaryDir, env: human, seams: idle.seams });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.equal(idle.calls.list, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: syncPrimary.idleSelfAuthorize=false restores the approval-variable-only gate', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-off-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const configPath = join(tmp, 'wtg.json');
    writeFileSync(configPath, JSON.stringify({ syncPrimary: { idleSelfAuthorize: false } }));
    const idle = idleSeams();
    const out = await runSyncPrimary({ cwd: primaryDir, seams: idle.seams, args: ['--config', configPath] });
    assert.equal(out.result, 1);
    assert.ok(out.errors.some((l) => l.includes('WTG_SYNC_PRIMARY_APPROVED_BY') && l.includes('idleSelfAuthorize')), out.errors.join('\n'));
    assert.equal(idle.calls.list, 0);
    assert.equal(lastAuditEntry(primaryDir).result, 'refused');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-primary: a partial syncPrimary override keeps idle self-authorization on', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-sync-partial-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const configPath = join(tmp, 'wtg.json');
    writeFileSync(configPath, JSON.stringify({ syncPrimary: { idleMinutes: 3 } }));
    const idle = idleSeams();
    const out = await runSyncPrimary({ cwd: primaryDir, seams: idle.seams, args: ['--config', configPath] });
    assert.equal(out.result, 0, out.errors.join('\n'));
    assert.equal(idle.calls.list, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// finish: hold budget (queue.maxHoldMs)
// ---------------------------------------------------------------------------

async function setUpFinishableWorktree(tmp, name) {
  const { primaryDir } = makeFixtureRepo(tmp);
  const worktreeRoot = join(tmp, 'worktrees');
  const createRun = await withCwd(primaryDir, () => captureConsole(() => (
    main(['create', '--name', name, '--worktree-root', worktreeRoot])
  )));
  assert.equal(createRun.result, 0, createRun.errors.join('\n'));
  const created = findManagedWorktree(discoverRepo(primaryDir), `claude/${name.replaceAll(' ', '-')}`);
  writeFileSync(join(created.path, 'change.txt'), 'work\n');
  const repo = discoverRepo(created.path);
  return { primaryDir, created, lockFile: join(repo.commonGitDir, 'worktree-guard-state', 'finish.lock') };
}

test('finish: an exhausted hold budget fails with a clear message and releases the lock', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-hold-spent-'));
  try {
    const { created, lockFile } = await setUpFinishableWorktree(tmp, 'hold spent');
    const cfgPath = join(tmp, 'hold.json');
    // 1ms: the budget is gone before the first in-lock git call starts.
    writeFileSync(cfgPath, JSON.stringify({ queue: { maxHoldMs: 1 } }));

    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'work', '--no-wait', '--config', cfgPath])
    )));
    assert.equal(finishRun.result, 1);
    assert.ok(
      finishRun.errors.some((l) => /hold limit of 1ms reached/.test(l) && /lock was released/.test(l)),
      finishRun.errors.join('\n'),
    );
    assert.equal(existsSync(lockFile), false, 'the finish lock must be released after a hold timeout');
    assert.equal(existsSync(created.path), true, 'nothing was pushed or removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('finish releases the lock if primary-CWD setup fails before heartbeat initialization', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-finish-setup-failure-'));
  const originalChdir = process.chdir;
  try {
    const { primaryDir, created, lockFile } = await setUpFinishableWorktree(tmp, 'setup failure');
    process.chdir = function chdirWithInjectedPrimaryFailure(path) {
      if (samePathIdentity(path, primaryDir)) throw new Error('injected primary CWD failure');
      return originalChdir.call(process, path);
    };
    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'work', '--no-wait'])
    )));
    assert.equal(finishRun.result, 1);
    assert.ok(finishRun.errors.some((line) => /injected primary CWD failure/.test(line)), finishRun.errors.join('\n'));
    assert.equal(existsSync(lockFile), false, 'setup failure must release the already-acquired finish lock');
    assert.equal(existsSync(created.path), true, 'setup failure leaves the worktree intact');
  } finally {
    process.chdir = originalChdir;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('finish: a git network call that hangs is killed at the hold limit, the lock is released, and the error says so', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-hold-hang-'));
  try {
    const { primaryDir, created, lockFile } = await setUpFinishableWorktree(tmp, 'hold hang');
    // From now on "fetching origin" runs `sleep 4` as the transport, i.e. hangs.
    run('git', ['remote', 'set-url', 'origin', 'ext::sleep 4'], primaryDir);
    const cfgPath = join(tmp, 'hold.json');
    writeFileSync(cfgPath, JSON.stringify({ queue: { maxHoldMs: 1500 } }));

    const finishRun = await withEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.ext.allow',
      GIT_CONFIG_VALUE_0: 'always',
    }, () => withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'work', '--no-wait', '--config', cfgPath])
    ))));

    // Not asserting wall-clock: spawnSync returns only once every process holding
    // git's output pipes has exited, and the `sleep` transport outlives the killed
    // git. Only the hold-limit message can come from the timeout path; an ordinary
    // failed fetch reports git's own error instead.
    assert.equal(finishRun.result, 1);
    assert.ok(
      finishRun.errors.some((l) => /hold limit of 1500ms reached during `git fetch/.test(l)),
      finishRun.errors.join('\n'),
    );
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('finish: while it holds the lock, the lock file names the worktree and the current phase', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-hold-phase-'));
  try {
    const { created, lockFile } = await setUpFinishableWorktree(tmp, 'hold phase');
    // The managed hooks directory forwards pre-push to <worktree>/.husky/_/pre-push.
    // This hook snapshots the lock file at push time and lets the push proceed.
    const snapshot = join(tmp, 'lock-during-push.json');
    mkdirSync(join(created.path, '.husky', '_'), { recursive: true });
    writeFileSync(
      join(created.path, '.husky', '_', 'pre-push'),
      `#!/bin/sh\nexec ${nodeFixture('snapshot', lockFile, snapshot)}\n`,
      { mode: 0o755 },
    );

    const finishRun = await withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'work', '--no-wait'])
    )));
    assert.equal(finishRun.result, 0, finishRun.errors.join('\n'));

    assert.ok(existsSync(snapshot), 'the pre-push hook should have run while the lock was held');
    const data = JSON.parse(readFileSync(snapshot, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.match(data.worktree, /^claude\/hold-phase/);
    assert.equal(data.phase, 'push');
    assert.equal(existsSync(lockFile), false, 'released after a successful finish');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑪ generalized dependency lane: create --with-deps and client-check
// ---------------------------------------------------------------------------

test('create --with-deps=<client> runs that client\'s installCommand, and client-check runs its testCommand/typecheckCommand', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-clients-'));
  try {
    const { primaryDir } = makeFixtureRepo(tmp);
    const worktreeRoot = join(tmp, 'worktrees');
    const markerFile = join(tmp, 'install-marker.txt');
    const testMarkerFile = join(tmp, 'test-marker.txt');
    const typecheckMarkerFile = join(tmp, 'typecheck-marker.txt');

    const configPath = join(tmp, 'wtg-config.json');
    writeFileSync(configPath, JSON.stringify({
      clients: {
        web: {
          installCommand: nodeFixture('write-marker', markerFile),
          testCommand: nodeFixture('write-marker', testMarkerFile),
          typecheckCommand: nodeFixture('write-marker', typecheckMarkerFile),
        },
      },
      defaultClient: 'web',
    }));

    const createRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['create', '--name', 'clients task', '--worktree-root', worktreeRoot, '--with-deps=web', '--config', configPath])
    )));
    assert.equal(createRun.result, 0, createRun.errors.join('\n'));
    assert.equal(existsSync(markerFile), true, '--with-deps=web must run the "web" client\'s installCommand');

    const testRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['client-check', '--app', 'web', '--config', configPath])
    )));
    assert.equal(testRun.result, 0, testRun.errors.join('\n'));
    assert.equal(existsSync(testMarkerFile), true, 'client-check --app web must run the "web" client\'s testCommand');

    const typecheckRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['client-check', '--app', 'web', '--typecheck', '--config', configPath])
    )));
    assert.equal(typecheckRun.result, 0, typecheckRun.errors.join('\n'));
    assert.equal(existsSync(typecheckMarkerFile), true, 'client-check --typecheck must run the "web" client\'s typecheckCommand');

    const unknownClientRun = await withCwd(primaryDir, () => captureConsole(() => (
      main(['client-check', '--app', 'does-not-exist', '--config', configPath])
    )));
    assert.equal(unknownClientRun.result, 1);
    assert.ok(unknownClientRun.errors.some((l) => /no such client/.test(l)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
