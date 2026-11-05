import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';
import { isolatedFixtureGitEnv } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);
const CLI = fileURLToPath(new URL('../../src/worktrees/cli.mjs', import.meta.url));
const ADAPTER = 'engineering/automation/vibe-coding/project-adapter.mjs';
const BOOTSTRAP = 'engineering/automation/vibe-coding/bootstrap.mjs';
const CONFIG = '.vibe-coding/project.config.json';
const KIT = '.vibe-coding/kit';

function fixture() {
  const f = makeProject();
  mkdirSync(join(f.project, 'engineering/automation/vibe-coding'), { recursive: true });
  writeFileSync(join(f.project, ADAPTER), 'export const adapterContract = { schemaVersion: 1, hooks: {} };\n');
  writeFileSync(join(f.project, BOOTSTRAP), '// fixture bootstrap\n');
  commit(f.project, 'complete project initialization');
  const override = join(f.root, 'worktree-config.json');
  writeFileSync(override, JSON.stringify({ identity: { name: 'Lifecycle CI Agent', email: 'lifecycle-agent@example.com' } }));
  const env = isolatedFixtureGitEnv();
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
  env.GIT_CONFIG_VALUE_0 = 'always';
  return { ...f, override, env, worktrees: join(f.root, 'worktrees') };
}

function begin(f, args = []) {
  return spawnSync(process.execPath, [CLI, 'begin', '--name', 'baseline proof', '--tool', 'codex',
    '--config', f.override, '--worktree-root', f.worktrees, ...args], {
    cwd: f.project, env: f.env, encoding: 'utf8', timeout: 30_000,
  });
}

function unchangedState(f) {
  return {
    refs: git(f.project, ['show-ref']).stdout,
    worktrees: git(f.project, ['worktree', 'list', '--porcelain']).stdout,
    status: git(f.project, ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
    index: readFileSync(join(f.project, '.git/index')),
  };
}

function assertRejectedBeforeCreation(f, args = [], expected = /worktree baseline.*initialization/is) {
  const before = unchangedState(f);
  const result = begin(f, args);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, expected);
  assert.deepEqual(unchangedState(f), before, 'failure must not mutate refs, index, files or worktree registrations');
  assert.equal(existsSync(f.worktrees), false, 'failure must precede worktree directory creation');
}

test('begin rejects initialization present only in the source index and working tree', () => {
  const f = fixture();
  const beforeInitialization = git(f.project, ['rev-parse', `${f.parentCommit}^`]).stdout.trim();
  git(f.project, ['reset', '--soft', beforeInitialization]);
  assertRejectedBeforeCreation(f);
});

for (const path of ['.gitmodules', KIT, CONFIG, ADAPTER, BOOTSTRAP]) {
  test(`begin rejects an uncommitted baseline dependency: ${path}`, () => {
    const f = fixture();
    git(f.project, ['rm', '--cached', '--', path]);
    git(f.project, ['-c', 'user.name=Lifecycle CI Agent', '-c', 'user.email=lifecycle-agent@example.com',
      'commit', '-m', 'incomplete initialization']);
    // Keep the current source usable: only the selected commit is incomplete.
    git(f.project, ['add', '--', path]);
    assertRejectedBeforeCreation(f, [], /worktree baseline/is);
  });
}

test('begin validates the selected base even when current HEAD initialization is complete', () => {
  const f = fixture();
  const oldBase = git(f.project, ['rev-parse', `${f.parentCommit}^`]).stdout.trim();
  git(f.project, ['branch', 'incomplete-base', oldBase]);
  assertRejectedBeforeCreation(f, ['--base', 'incomplete-base']);
});

test('begin validates the fetched upstream rather than the complete local branch', () => {
  const f = fixture();
  const oldBase = git(f.project, ['rev-parse', `${f.parentCommit}^`]).stdout.trim();
  const remote = join(f.root, 'remote.git');
  git(f.root, ['init', '--bare', '--initial-branch=main', remote]);
  git(f.project, ['remote', 'add', 'origin', remote]);
  git(f.project, ['push', '-u', 'origin', `${oldBase}:refs/heads/main`]);
  git(f.project, ['branch', '--set-upstream-to=origin/main', 'main']);
  assertRejectedBeforeCreation(f);
});

test('begin dry-run rejects incomplete initialization without creating anything', () => {
  const f = fixture();
  git(f.project, ['reset', '--soft', `${f.parentCommit}^`]);
  assertRejectedBeforeCreation(f, ['--dry-run']);
});

test('begin accepts a committed baseline with an unrelated dirty source file', () => {
  const f = fixture();
  writeFileSync(join(f.project, 'README.md'), 'keep this uncommitted user edit\n');
  const result = begin(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /created branch/);
  assert.equal(readFileSync(join(f.project, 'README.md'), 'utf8'), 'keep this uncommitted user edit\n');
  const created = join(f.worktrees, 'codex-baseline-proof');
  assert.ok(existsSync(join(created, KIT, '.git')));
  assert.ok(existsSync(join(created, CONFIG)));
  assert.ok(existsSync(join(created, ADAPTER)));
  assert.ok(existsSync(join(created, BOOTSTRAP)));
});

test('begin refuses success when afterCreate removes required kit registration', () => {
  const f = fixture();
  writeFileSync(join(f.project, ADAPTER), `
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
export const adapterContract = { schemaVersion: 1, hooks: { afterCreate: 'removeRegistration' } };
export async function removeRegistration({ projectRoot }) {
  unlinkSync(join(projectRoot, '.gitmodules'));
  unlinkSync(join(projectRoot, '${CONFIG}'));
}
`);
  commit(f.project, 'adapter removes registration');
  const result = begin(f);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /required kit registration/i);
  assert.doesNotMatch(result.stdout, /created branch/);
});
