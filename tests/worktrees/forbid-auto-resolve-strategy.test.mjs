// worktree-guard/forbid-auto-resolve-strategy.test.mjs
//
// Coverage for forbid-auto-resolve-strategy.mjs: landing must never auto-resolve a conflict by
// taking one side (-X theirs / -X ours / -s ours). Run with:
//   node --test forbid-auto-resolve-strategy.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoForbiddenMergeStrategy, findForbiddenMergeStrategy } from '../../src/worktrees/forbid-auto-resolve-strategy.mjs';
import { git } from '../../src/worktrees/worktree-core.mjs';
import { fixtureGitIdentityArgs } from '../support/isolated-git-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', 'src', 'worktrees');

test('rebase/merge/cherry-pick/pull/revert with -X / --strategy-option / -s ours are refused', () => {
  for (const args of [
    ['rebase', '-X', 'theirs', 'origin/main'],
    ['rebase', '-Xtheirs', 'origin/main'],
    ['rebase', '-Xours', 'origin/main'],
    ['merge', '--strategy-option=theirs', 'x'],
    ['merge', '--strategy-option', 'ours', 'x'],
    ['merge', '-s', 'ours', 'x'],
    ['merge', '--strategy=ours', 'x'],
    ['pull', '--rebase', '-Xtheirs'],
    ['cherry-pick', '-X', 'theirs', 'abc'],
    ['revert', '-Xours', 'abc'],
    ['-c', 'user.name=x', '-c', 'user.email=y', 'rebase', '-Xtheirs', 'origin/main'],
  ]) {
    assert.ok(findForbiddenMergeStrategy(args), args.join(' '));
    assert.throws(() => assertNoForbiddenMergeStrategy(args), /resolve the conflict by hand/u, args.join(' '));
  }
});

test('ordinary landing invocations pass', () => {
  for (const args of [
    ['rebase', 'origin/main'],
    ['rebase', '--continue'],
    ['rebase', '--abort'],
    ['merge', '--ff-only', 'x'],
    ['merge', '--no-ff', '--no-verify', '-m', 'msg -Xtheirs prose', 'x'],
    ['cherry-pick', '--allow-empty', '--keep-redundant-commits', 'abc'],
    ['diff', '-X'],
    ['log', '-s'],
  ]) assert.equal(findForbiddenMergeStrategy(args), null, args.join(' '));
});

test('git() refuses before spawning anything, even with allowFailure', () => {
  let spawned = false;
  assert.throws(
    () => git([...fixtureGitIdentityArgs(), 'rebase', '-X', 'theirs', 'origin/main'], '/nonexistent', {
      allowFailure: true,
      runner: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /refusing `git .*rebase -X theirs/u,
  );
  assert.equal(spawned, false);
});

test('git() refuses an operator-supplied base ref that smuggles a strategy option', () => {
  assert.throws(() => git([...fixtureGitIdentityArgs(), 'rebase', '-Xtheirs'], '/nonexistent', { runner: () => ({ status: 0 }) }), /refusing/u);
});

test('class guard: no kit source spells a -X theirs/ours or -s ours git invocation', () => {
  const offenders = [];
  for (const name of readdirSync(SOURCE)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || name === 'forbid-auto-resolve-strategy.mjs') continue;
    const text = readFileSync(join(SOURCE, name), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*)/u.test(line))
      .join('\n');
    if (/['"`]-X\s*(?:theirs|ours)?['"`]|-X\s?(?:theirs|ours)|strategy-option|['"]-s['"],\s*['"]ours/u.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('class guard: every path that spawns a merge-family git command itself routes through the assertion', () => {
  // git() in worktree-core.mjs is the shared wrapper; git-identity.mjs spawns its reauthor rebase directly.
  for (const name of ['worktree-core.mjs', 'git-identity.mjs']) {
    const text = readFileSync(join(SOURCE, name), 'utf8');
    assert.match(text, /assertNoForbiddenMergeStrategy\(/u, `${name} must call assertNoForbiddenMergeStrategy`);
  }
  // Any other module spawning git directly with a rebase/merge/cherry-pick/pull/revert must be added above.
  const direct = [];
  for (const name of readdirSync(SOURCE)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const text = readFileSync(join(SOURCE, name), 'utf8');
    if (/spawnSync\(\s*['"]git['"]/u.test(text) && /['"](?:rebase|merge|cherry-pick|pull|revert)['"]/u.test(text)) direct.push(name);
  }
  assert.deepEqual(direct.filter((name) => !['worktree-core.mjs', 'git-identity.mjs'].includes(name)), []);
});
