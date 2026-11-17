import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from './isolated-git-env.mjs';
import { main } from '../../src/worktrees/cli.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';

export const CROSS_PLATFORM_COMMAND = fileURLToPath(new URL('../worktrees/fixtures/cross-platform-command.mjs', import.meta.url));
export const quoteShellArg = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
export const nodeFixture = (...args) => [process.execPath, CROSS_PLATFORM_COMMAND, ...args].map(quoteShellArg).join(' ');

export function run(cmd, args, cwd) {
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
export function makeFixtureRepo(rootDir, { fileCount = 0 } = {}) {
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

export async function withCwd(dir, fn, { worktreeTool = 'claude' } = {}) {
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
export async function withEnv(overrides, fn) {
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

export async function captureConsole(fn) {
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

export function findManagedWorktree(repo, branchPrefix) {
  return repo.worktrees.find((w) => w.branch && w.branch.startsWith(branchPrefix));
}

export async function setUpFinishableWorktree(tmp, name) {
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
