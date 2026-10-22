import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { assertKitSafeToRemove } from '../../src/dependencies/submodule.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
import { removeWorktreeSafely } from '../../src/worktrees/cli.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);

function makeKitWorktree() {
  const fixture = makeProject();
  const branch = 'claude/safe-kit-cleanup';
  const worktreePath = join(fixture.root, 'consumer-worktree');
  git(fixture.project, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  git(worktreePath, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--checkout', '--', '.vibe-coding/kit']);
  return { ...fixture, branch, worktreePath, kitPath: join(worktreePath, '.vibe-coding/kit') };
}

function assertStillRegistered({ project, branch, worktreePath }) {
  const paths = git(project, ['worktree', 'list', '--porcelain']).stdout
    .split(/\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  assert.equal(paths.some((path) => samePathIdentity(path, worktreePath)), true);
  assert.equal(git(project, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status, 0);
}

function assertSafeRemovalRefused(fixture, mutate) {
  mutate(fixture);
  const calls = [];
  assert.throws(() => removeWorktreeSafely({
    projectRoot: fixture.worktreePath,
    worktreePath: fixture.worktreePath,
    primaryPath: fixture.project,
    force: true,
    deleteBranch: fixture.branch,
    runGit: (...args) => { calls.push(args); throw new Error('git runner should not be reached'); },
  }));
  assert.deepEqual(calls, [], 'no Git removal or branch deletion runs without a successful proof');
  assertStillRegistered(fixture);
}

test('cleanup proof accepts only a clean child at the committed parent pin', () => {
  const fixture = makeProject();
  assert.equal(assertKitSafeToRemove({ projectRoot: fixture.project }).safeToRemove, true);

  writeFileSync(join(fixture.project, '.vibe-coding/kit/ignored.txt'), 'preserve local file\n');
  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /Refusing to change dirty submodule/);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'status', '--porcelain=v1', '--ignored=matching']).stdout.includes('ignored.txt'), true);
});

test('cleanup proof rejects staged gitlink changes and local-only child refs', () => {
  const fixture = makeProject();
  writeFileSync(join(fixture.source, 'second.txt'), 'new object\n');
  const nextPin = commit(fixture.source, 'new source commit');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${nextPin},.vibe-coding/kit`]);
  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /parent HEAD and index do not agree/);

  const second = makeProject();
  const child = join(second.project, '.vibe-coding/kit');
  git(child, ['branch', 'private-local-work']);
  assert.throws(() => assertKitSafeToRemove({ projectRoot: second.project }), /local (?:branch|ref)/);
});

test('safe cleanup preserves the worktree and branch for dirty, untracked, ignored, private-ref, and mismatched-pin kits', () => {
  assertSafeRemovalRefused(makeKitWorktree(), ({ kitPath }) => {
    writeFileSync(join(kitPath, 'README.md'), 'local tracked edit\n');
  });
  assertSafeRemovalRefused(makeKitWorktree(), ({ kitPath }) => {
    writeFileSync(join(kitPath, 'untracked.txt'), 'local data\n');
  });
  assertSafeRemovalRefused(makeKitWorktree(), ({ kitPath }) => {
    writeFileSync(join(kitPath, 'ignored.txt'), 'local ignored data\n');
  });
  assertSafeRemovalRefused(makeKitWorktree(), ({ kitPath }) => {
    git(kitPath, ['branch', 'private-local-work']);
  });
  assertSafeRemovalRefused(makeKitWorktree(), (fixture) => {
    writeFileSync(join(fixture.source, 'second.txt'), 'new object\n');
    const nextPin = commit(fixture.source, 'new source commit');
    git(fixture.worktreePath, ['update-index', '--cacheinfo', `160000,${nextPin},.vibe-coding/kit`]);
  });
});

test('a worktree removal failure aborts before branch deletion and is not reported as success', () => {
  const fixture = makeKitWorktree();
  const calls = [];
  assert.throws(() => removeWorktreeSafely({
    projectRoot: fixture.worktreePath,
    worktreePath: fixture.worktreePath,
    primaryPath: fixture.project,
    force: true,
    deleteBranch: fixture.branch,
    runGit: (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('simulated remove failure');
      return { status: 0, stdout: '', stderr: '' };
    },
  }), /simulated remove failure/);
  assert.deepEqual(calls, [['worktree', 'remove', '--force', fixture.worktreePath]]);
  assertStillRegistered(fixture);
});
