import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (path) => pathToFileURL(join(here, path)).href;

function runGit(cwd, args) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), {
    cwd,
    env: isolatedFixtureGitEnv(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `fixture git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

function initRepo(path, name) {
  mkdirSync(path, { recursive: true });
  runGit(path, ['init', '-q', '-b', 'main']);
  runGit(path, ['config', '--local', 'user.name', name]);
  runGit(path, ['config', '--local', 'user.email', `${name.toLowerCase().replaceAll(' ', '.')}@fixture.invalid`]);
  writeFileSync(join(path, 'tracked.txt'), `${name}\n`);
  runGit(path, ['add', 'tracked.txt']);
  runGit(path, ['commit', '-q', '-m', `${name} initial`]);
}

test('Git wrappers and worktree consumers stay on their explicit child repo under inherited parent-hook selectors', () => {
  const root = mkdtempSync(join(tmpdir(), 'wtg-git-env-boundary-'));
  const parent = join(root, 'parent');
  const child = join(parent, 'child-repo');
  try {
    initRepo(parent, 'Parent Fixture');
    initRepo(child, 'Child Fixture');
    const canonicalChild = realpathSync(child);
    const childBase = runGit(child, ['rev-parse', 'HEAD']);
    writeFileSync(join(child, 'second.txt'), 'child second\n');
    runGit(child, ['add', 'second.txt']);
    runGit(child, ['commit', '-q', '-m', 'child second']);

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
const asyncResult = await gitAsync(['rev-parse', '--show-toplevel'], childRoot, { allowFailure: false, timeoutMs: 5000 });
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
      timeout: 15_000,
    });

    assert.equal(parentCommit.status, 0, `parent commit hook failed: ${parentCommit.stderr || parentCommit.stdout}`);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.ok(result.inheritedParentGitDir, 'the real Git hook must receive parent repository selectors');
    assert.equal(result.syncRoot, canonicalChild);
    assert.equal(result.rawRoot, canonicalChild);
    assert.equal(result.asyncRoot, canonicalChild);
    assert.equal(result.repoTopLevel, canonicalChild);
    assert.equal(result.repoGitDir, '.git');
    assert.equal(result.repoCommonGitDir, '.git');
    assert.deepEqual(result.identity, { name: 'Child Fixture', email: 'child.fixture@fixture.invalid' });
    assert.equal(result.reauthor.rewritten, true);
    assert.equal(result.rewrittenIdentity, 'Boundary Test Bot\x1fbot@boundary.invalid\x1fBoundary Test Bot\x1fbot@boundary.invalid');
    assert.equal(result.hookStatus.installed, true);
    assert.equal(result.hookStatus.intact, true);
    assert.equal(result.primaryRoot, canonicalChild);
    assert.equal(result.outsideChildAllowed, true);
    assert.equal(result.selectorsRemoved, true);
    assert.equal(result.protocolConfigPreserved, true);
    assert.equal(result.authPreserved, true);

    const parentHookPath = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: parent,
      env: isolatedFixtureGitEnv(),
      encoding: 'utf8',
    });
    assert.notEqual(parentHookPath.status, 0, 'child hook setup must not mutate parent config');
    assert.equal(runGit(parent, ['status', '--porcelain']), '?? child-repo/', 'the parent repo must remain otherwise untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
