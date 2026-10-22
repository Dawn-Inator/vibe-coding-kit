import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { checkKit, prepareKit } from '../../src/dependencies/submodule.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';
import { fixtureGitIdentityArgs } from '../support/isolated-git-env.mjs';

after(cleanupTempDirs);

test('two linked worktrees prepare and retain separate pinned kit commits', () => {
  const fixture = makeProject();
  const parentAtA = fixture.parentCommit;
  const worktreeA = join(fixture.root, 'consumer-a');
  git(fixture.project, ['worktree', 'add', '--detach', worktreeA, parentAtA]);
  const preparedA = prepareKit({ projectRoot: worktreeA });
  assert.equal(preparedA.commit, fixture.sourceCommit);

  const sourceB = join(fixture.source, 'second.txt');
  writeFileSync(sourceB, 'second public version\n');
  const kitCommitB = commit(fixture.source, 'kit version B');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${kitCommitB},.vibe-coding/kit`]);
  git(fixture.project, [...fixtureGitIdentityArgs(), 'commit', '-m', 'consumer pins kit B']);
  const parentAtB = git(fixture.project, ['rev-parse', 'HEAD']).stdout.trim();
  const worktreeB = join(fixture.root, 'consumer-b');
  git(fixture.project, ['worktree', 'add', '--detach', worktreeB, parentAtB]);
  const preparedB = prepareKit({ projectRoot: worktreeB });

  assert.equal(preparedB.commit, kitCommitB);
  assert.equal(checkKit({ projectRoot: worktreeA }).commit, fixture.sourceCommit);
  assert.equal(checkKit({ projectRoot: worktreeB }).commit, kitCommitB);
  assert.equal(git(join(worktreeA, '.vibe-coding/kit'), ['rev-parse', 'HEAD']).stdout.trim(), fixture.sourceCommit);
  assert.equal(git(join(worktreeB, '.vibe-coding/kit'), ['rev-parse', 'HEAD']).stdout.trim(), kitCommitB);
});
