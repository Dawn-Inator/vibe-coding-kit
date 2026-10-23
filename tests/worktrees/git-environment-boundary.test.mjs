import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { gitTrim } from '../support/git-fixture.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (path) => pathToFileURL(join(here, path)).href;

function initRepo(path, name) {
  mkdirSync(path, { recursive: true });
  gitTrim(['init', '-q', '-b', 'main'], path);
  gitTrim(['config', '--local', 'user.name', name], path);
  gitTrim(['config', '--local', 'user.email', `${name.toLowerCase().replaceAll(' ', '.')}@fixture.invalid`], path);
  writeFileSync(join(path, 'tracked.txt'), `${name}\n`);
  gitTrim(['add', 'tracked.txt'], path);
  gitTrim(['commit', '-q', '-m', `${name} initial`], path);
}

function assertPathIdentity(actual, expected, message) {
  assert.equal(typeof actual, 'string', `${message}: actual path must be a string`);
  assert.ok(samePathIdentity(actual, expected), `${message}: expected same path identity; actual=${actual}; expected=${expected}`);
}

test('Git wrappers and worktree consumers stay on their explicit child repo under inherited parent-hook selectors', { timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wtg-git-env-boundary-'));
  const parent = join(root, 'parent');
  const child = join(parent, 'child-repo');
  try {
    initRepo(parent, 'Parent Fixture');
    initRepo(child, 'Child Fixture');
    const canonicalChild = realpathSync(child);
    const childBase = gitTrim(['rev-parse', 'HEAD'], child);
    writeFileSync(join(child, 'second.txt'), 'child second\n');
    gitTrim(['add', 'second.txt'], child);
    gitTrim(['commit', '-q', '-m', 'child second'], child);

    const gitDir = join(parent, '.git');
    const resultPath = join(root, 'hook-result.json');
    const pollutedEnv = {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: parent,
      GIT_INDEX_FILE: join(gitDir, 'index'),
      GIT_COMMON_DIR: gitDir,
      GIT_PREFIX: 'parent-prefix/',
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'always',
      GH_TOKEN: 'synthetic-preserved-token',
    };
    const hookScript = join(gitDir, 'hooks', 'pre-commit');
    writeFileSync(hookScript, `#!/usr/bin/env node
import { discoverRepo, git, gitAsync, gitRaw } from ${JSON.stringify(moduleUrl('../../src/worktrees/worktree-core.mjs'))};
import { readLocalGitIdentityPair, gitIdentityEnv, reauthorUnpushedCommitsToAiIdentity } from ${JSON.stringify(moduleUrl('../../src/worktrees/git-identity.mjs'))};
import { installStashGuardHook, stashGuardStatus } from ${JSON.stringify(moduleUrl('../../src/worktrees/hooks.mjs'))};
import { resolvePrimaryRoot, decidePrimaryWrite } from ${JSON.stringify(moduleUrl('../../src/worktrees/primary-write-guard.mjs'))};
import { DEFAULT_CONFIG } from ${JSON.stringify(moduleUrl('../../src/worktrees/config.mjs'))};
import { sanitizedGitEnv, GIT_REPOSITORY_SELECTION_ENV } from ${JSON.stringify(moduleUrl('../../src/git-environment.mjs'))};
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const parentRoot = ${JSON.stringify(parent)};
const childRoot = ${JSON.stringify(child)};
const childBase = ${JSON.stringify(childBase)};
const bot = { identity: { name: 'Boundary Test Bot', email: 'bot@boundary.invalid' }, fixtureIdentityPattern: '^nonexistent-fixture-identity$' };
const sync = git(['rev-parse', '--show-toplevel'], childRoot, { allowFailure: false });
const raw = gitRaw(['rev-parse', '--show-toplevel'], childRoot, { allowFailure: false });
const asyncResult = await gitAsync(['rev-parse', '--show-toplevel'], childRoot, { allowFailure: false, timeoutMs: 60_000 });
const repoProvenance = discoverRepo(childRoot);
const identity = readLocalGitIdentityPair(childRoot);
const identityEnv = gitIdentityEnv(bot);
const reauthor = reauthorUnpushedCommitsToAiIdentity(childRoot, childBase, bot);
installStashGuardHook(childRoot, DEFAULT_CONFIG);
const hookStatus = stashGuardStatus(childRoot, DEFAULT_CONFIG);
const primaryRoot = resolvePrimaryRoot(childRoot);
const outsideChildDecision = decidePrimaryWrite({
  toolName: 'Write',
  toolInput: { file_path: join(parentRoot, 'parent-only.txt') },
  cwd: childRoot,
});
const result = {
  syncRoot: sync.stdout,
  rawRoot: raw.stdout.trim(),
  asyncRoot: asyncResult.stdout,
  repoTopLevel: repoProvenance.topLevel,
  repoGitDir: repoProvenance.gitDir,
  repoCommonGitDir: repoProvenance.commonGitDir,
  identity,
  reauthor,
  rewrittenIdentity: git(['log', '-1', '--format=%an%x1f%ae%x1f%cn%x1f%ce'], childRoot).stdout,
  hookStatus,
  primaryRoot,
  outsideChildAllowed: outsideChildDecision.allow,
  selectorsRemoved: GIT_REPOSITORY_SELECTION_ENV.every((key) => !Object.hasOwn(sanitizedGitEnv(), key)),
  protocolConfigPreserved: identityEnv.GIT_CONFIG_COUNT === '1' && identityEnv.GIT_CONFIG_KEY_0 === 'protocol.file.allow' && identityEnv.GIT_CONFIG_VALUE_0 === 'always',
  authPreserved: identityEnv.GH_TOKEN === 'synthetic-preserved-token',
  inheritedParentGitDir: process.env.GIT_DIR,
};
writeFileSync(process.env.WTG_TEST_RESULT_FILE, JSON.stringify(result));
`);
    chmodSync(hookScript, 0o755);
    const parentCommit = spawnSync('git', withFixtureCommitIdentity(['commit', '-q', '--allow-empty', '-m', 'trigger inherited-env hook']), {
      cwd: parent,
      env: { ...pollutedEnv, WTG_TEST_RESULT_FILE: resultPath },
      encoding: 'utf8',
      timeout: 120_000,
    });

    assert.equal(parentCommit.status, 0, `parent commit hook failed: ${parentCommit.stderr || parentCommit.stdout}`);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assertPathIdentity(
      resolve(parent, result.inheritedParentGitDir),
      join(parent, '.git'),
      'the real Git hook must receive its parent repository Git-dir selector',
    );
    assert.equal(
      samePathIdentity(resolve(parent, result.inheritedParentGitDir), join(child, '.git')),
      false,
      'the real Git hook selector must not identify the child Git directory',
    );
    for (const [label, path] of [
      ['sync wrapper', result.syncRoot],
      ['raw wrapper', result.rawRoot],
      ['async wrapper', result.asyncRoot],
      ['repo provenance', result.repoTopLevel],
      ['primary guard', result.primaryRoot],
    ]) {
      assertPathIdentity(path, canonicalChild, `${label} must resolve to the child repository`);
      assert.equal(samePathIdentity(path, realpathSync(parent)), false, `${label} must not resolve to the parent repository`);
    }
    assertPathIdentity(resolve(canonicalChild, result.repoGitDir), join(canonicalChild, '.git'), 'repo Git-dir provenance must identify the child Git dir');
    assertPathIdentity(resolve(canonicalChild, result.repoCommonGitDir), join(canonicalChild, '.git'), 'repo common-dir provenance must identify the child common Git dir');
    assert.deepEqual(result.identity, { name: 'Child Fixture', email: 'child.fixture@fixture.invalid' });
    assert.equal(result.reauthor.rewritten, true);
    assert.equal(result.rewrittenIdentity, 'Boundary Test Bot\x1fbot@boundary.invalid\x1fBoundary Test Bot\x1fbot@boundary.invalid');
    assert.equal(result.hookStatus.installed, true);
    assert.equal(result.hookStatus.intact, true);
    assert.equal(result.outsideChildAllowed, true);
    assert.equal(result.selectorsRemoved, true);
    assert.equal(result.protocolConfigPreserved, true);
    assert.equal(result.authPreserved, true);

    const parentHookPath = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: parent,
      env: isolatedFixtureGitEnv(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(parentHookPath.status, 0, 'child hook setup must not mutate parent config');
    const parentStatus = gitTrim(['status', '--porcelain'], parent);
    const parentStatusLines = parentStatus.split(/\r?\n/).filter(Boolean);
    assert.equal(parentStatusLines.length, 1, 'the parent repo must remain otherwise untouched except for the child fixture');
    assert.equal(parentStatusLines[0].slice(0, 3), '?? ', 'the nested fixture must be the only parent-repository change');
    assertPathIdentity(
      resolve(parent, parentStatusLines[0].slice(3)),
      child,
      'the only parent-repository change must be the nested child repository',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
