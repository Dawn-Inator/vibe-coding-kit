import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  isolatedFixtureGitEnv,
  withFixtureCommitIdentity,
} from '../support/isolated-git-env.mjs';

import {
  gitIdentityArgs,
  gitIdentityEnv,
  looksLikeFixtureGitIdentity,
  readLocalGitIdentityPair,
  assertNoFixtureGitIdentity,
  reauthorUnpushedCommitsToAiIdentity,
} from '../../src/worktrees/git-identity.mjs';
import { DEFAULT_CONFIG } from '../../src/worktrees/config.mjs';

const config = {
  ...DEFAULT_CONFIG,
  identity: { name: 'Test Worktree Bot', email: 'bot@worktree-kit.test' },
};

function makeScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-git-identity-'));
  run(dir, ['init', '-b', 'main']);
  return dir;
}

function run(cwd, args, opts = {}) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), {
    cwd,
    encoding: 'utf8',
    ...opts,
    env: isolatedFixtureGitEnv(opts.env || process.env),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function commit(dir, filename, content, identityOverrides = {}) {
  writeFileSync(join(dir, filename), content);
  run(dir, ['add', filename]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identityOverrides.authorName || 'Scratch Human',
    GIT_AUTHOR_EMAIL: identityOverrides.authorEmail || 'scratch@example.com',
    GIT_COMMITTER_NAME: identityOverrides.committerName || identityOverrides.authorName || 'Scratch Human',
    GIT_COMMITTER_EMAIL: identityOverrides.committerEmail || identityOverrides.authorEmail || 'scratch@example.com',
  };
  run(dir, ['commit', '-m', `commit ${filename}`], { env });
}

function headSha(dir) {
  return run(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function allShas(dir, range) {
  return run(dir, ['rev-list', range]).stdout.trim().split('\n').filter(Boolean);
}

// --- looksLikeFixtureGitIdentity -------------------------------------------------

test('looksLikeFixtureGitIdentity: matches known fixture patterns', () => {
  assert.equal(looksLikeFixtureGitIdentity('Baseline Gate', 'x@y.com', config), true);
  assert.equal(looksLikeFixtureGitIdentity('Rehearsal Bot', 'x@y.com', config), true);
  assert.equal(looksLikeFixtureGitIdentity('Someone', 'user@example.test', config), true);
  assert.equal(looksLikeFixtureGitIdentity('Someone', 'ai-bot@example.invalid', config), true);
  assert.equal(looksLikeFixtureGitIdentity('Someone', 'user@local', config), true);
  assert.equal(looksLikeFixtureGitIdentity('Synthetic Worktree Bot', 'worker@worktree-kit.test', config), false);
});

test('public default identity is intentionally treated as an unconfigured placeholder', () => {
  assert.equal(looksLikeFixtureGitIdentity(DEFAULT_CONFIG.identity.name, DEFAULT_CONFIG.identity.email, DEFAULT_CONFIG), true);
});

test('looksLikeFixtureGitIdentity: normal human identity does not match', () => {
  assert.equal(looksLikeFixtureGitIdentity('Jane Doe', 'jane@company.com', config), false);
});

// --- gitIdentityArgs / gitIdentityEnv ----------------------------------------------

test('gitIdentityArgs: reads from config.identity, not a hardcoded value', () => {
  const customConfig = { identity: { name: 'Custom Bot', email: 'bot@custom.test' } };
  assert.deepEqual(gitIdentityArgs(customConfig), [
    '-c', 'user.name=Custom Bot',
    '-c', 'user.email=bot@custom.test',
  ]);
});

test('gitIdentityEnv: reads from config.identity, not a hardcoded value', () => {
  const customConfig = { identity: { name: 'Custom Bot', email: 'bot@custom.test' } };
  const env = gitIdentityEnv(customConfig, {});
  assert.equal(env.GIT_AUTHOR_NAME, 'Custom Bot');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'bot@custom.test');
  assert.equal(env.GIT_COMMITTER_NAME, 'Custom Bot');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'bot@custom.test');
});

// --- readLocalGitIdentityPair / assertNoFixtureGitIdentity -------------------------

test('assertNoFixtureGitIdentity: throws on a fixture identity, passes on a normal one', () => {
  const dir = makeScratchRepo();
  try {
    run(dir, ['config', '--local', 'user.name', 'Rehearsal Bot']);
    assert.throws(() => assertNoFixtureGitIdentity(dir, config), /fixture/i);

    run(dir, ['config', '--local', 'user.name', 'Jane Doe']);
    run(dir, ['config', '--local', 'user.email', 'jane@company.com']);
    assert.doesNotThrow(() => assertNoFixtureGitIdentity(dir, config));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocalGitIdentityPair: returns empty pair without throwing when unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-git-identity-unset-'));
  try {
    run(dir, ['init', '-b', 'main']);
    const pair = readLocalGitIdentityPair(dir);
    assert.equal(pair.name, '');
    assert.equal(pair.email, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- reauthorUnpushedCommitsToAiIdentity -------------------------------------------

test('reauthorUnpushedCommitsToAiIdentity: rewrites author+committer for a range of human commits', () => {
  const dir = makeScratchRepo();
  try {
    commit(dir, 'a.txt', 'a');
    const baseSha = headSha(dir);
    commit(dir, 'b.txt', 'b');
    commit(dir, 'c.txt', 'c');

    const before = allShas(dir, `${baseSha}..HEAD`);
    assert.equal(before.length, 2);

    const result = reauthorUnpushedCommitsToAiIdentity(dir, baseSha, config);
    assert.equal(result.rewritten, true);
    assert.equal(result.count, 2);

    const after = allShas(dir, `${baseSha}..HEAD`);
    assert.equal(after.length, 2);
    assert.notDeepEqual(after, before, 'SHAs should change after rebase reauthor');

    const log = run(dir, ['log', `${baseSha}..HEAD`, '--format=%an%x1f%ae%x1f%cn%x1f%ce']).stdout.trim();
    for (const line of log.split('\n')) {
      const [an, ae, cn, ce] = line.split('\x1f');
      assert.equal(an, config.identity.name);
      assert.equal(ae, config.identity.email);
      assert.equal(cn, config.identity.name);
      assert.equal(ce, config.identity.email);
    }

    // Working tree content must be unchanged.
    const bContent = run(dir, ['show', 'HEAD~0:b.txt']).stdout;
    assert.equal(bContent, 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reauthorUnpushedCommitsToAiIdentity: no-op (stable SHAs) on a second call', () => {
  const dir = makeScratchRepo();
  try {
    commit(dir, 'a.txt', 'a');
    const baseSha = headSha(dir);
    commit(dir, 'b.txt', 'b');

    reauthorUnpushedCommitsToAiIdentity(dir, baseSha, config);
    const firstPassShas = allShas(dir, `${baseSha}..HEAD`);

    const result = reauthorUnpushedCommitsToAiIdentity(dir, baseSha, config);
    assert.equal(result.rewritten, false);
    assert.equal(result.count, 1);

    const secondPassShas = allShas(dir, `${baseSha}..HEAD`);
    assert.deepEqual(secondPassShas, firstPassShas, 'no-op pass must not change SHAs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reauthorUnpushedCommitsToAiIdentity: fail-closed when a fixture identity is in range', () => {
  const dir = makeScratchRepo();
  try {
    commit(dir, 'a.txt', 'a');
    const baseSha = headSha(dir);
    commit(dir, 'b.txt', 'b');
    commit(dir, 'c.txt', 'c', { authorName: 'Rehearsal Bot', authorEmail: 'bot@rehearsal.test' });

    const before = allShas(dir, `${baseSha}..HEAD`);

    assert.throws(
      () => reauthorUnpushedCommitsToAiIdentity(dir, baseSha, config),
      /fixture/i,
    );

    const after = allShas(dir, `${baseSha}..HEAD`);
    assert.deepEqual(after, before, 'history must be untouched after a fail-closed rejection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reauthorUnpushedCommitsToAiIdentity: empty range is a no-op', () => {
  const dir = makeScratchRepo();
  try {
    commit(dir, 'a.txt', 'a');
    const baseSha = headSha(dir);

    const result = reauthorUnpushedCommitsToAiIdentity(dir, baseSha, config);
    assert.equal(result.rewritten, false);
    assert.equal(result.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
