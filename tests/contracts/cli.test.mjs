import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  gitOut,
  gitResult,
  gitTrim,
  isolatedFixtureGitEnv,
} from '../support/git-fixture.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { isMainModule } from '../../src/lib/main-module.mjs';

after(cleanupTempDirs);

const cliSource = fileURLToPath(new URL('../../src/contracts/cli.mjs', import.meta.url));
const cliSourceDirectory = fileURLToPath(new URL('../../src/contracts', import.meta.url));
const libSourceDirectory = fileURLToPath(new URL('../../src/lib', import.meta.url));
const testSupportSource = fileURLToPath(new URL('../support', import.meta.url));

function repoFixture() {
  const root = mkdtempTracked('starter preflight ');
  gitOut(['init', '-q', '--initial-branch=main'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  gitOut(['add', 'base.txt'], root);
  gitOut(['commit', '-qm', 'initial'], root);
  return root;
}

function unbornRepoFixture() {
  const area = mkdtempTracked('starter preflight unborn ');
  const root = join(area, 'project with spaces');
  const origin = join(area, `${basename(area)}.git`);
  mkdirSync(root);
  gitOut(['init', '--bare', '-q', '--initial-branch=main', origin], area);
  gitOut(['init', '-q', '--initial-branch=main'], root);
  gitOut(['remote', 'add', 'origin', origin], root);
  return root;
}

function invoke(cliPath, cwd, args = []) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: isolatedFixtureGitEnv(),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `node was terminated by ${result.signal}`);
  const line = result.stdout.trim() || result.stderr.trim();
  return { code: result.status, json: line ? JSON.parse(line) : null, output: line };
}

test('copied kit install emits a complete, conservative manifest for untracked and renamed files', () => {
  const root = repoFixture();
  const copiedCli = join(root, 'engineering', 'automation', 'agent-preflight', 'cli.mjs');
  mkdirSync(join(root, 'engineering', 'automation', 'agent-preflight'), { recursive: true });
  mkdirSync(join(root, 'engineering', 'automation', 'lib'), { recursive: true });
  cpSync(cliSource, copiedCli);
  cpSync(join(libSourceDirectory, 'main-module.mjs'), join(root, 'engineering', 'automation', 'lib', 'main-module.mjs'));
  gitOut(['mv', 'base.txt', 'renamed.txt'], root);
  writeFileSync(join(root, 'new-file.txt'), 'new\n');
  const nested = join(root, 'nested dir');
  mkdirSync(nested);
  const result = invoke(copiedCli, nested);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.json.profile, 'full');
  assert.equal(result.json.status, 'complete');
  assert.equal(result.json.source, 'working-tree');
  assert.deepEqual(result.json.files, [
    'base.txt',
    'engineering/automation/agent-preflight/cli.mjs',
    'engineering/automation/lib/main-module.mjs',
    'new-file.txt',
    'renamed.txt',
  ]);
  assert.equal(Object.hasOwn(result.json, 'changedLines'), false, 'does not claim diff stats');
});

test('empty working tree is valid and reported as empty with full profile', () => {
  const root = repoFixture();
  const result = invoke(cliSource, root);
  assert.equal(result.code, 0);
  assert.equal(result.json.profile, 'full');
  assert.equal(result.json.status, 'empty');
  assert.deepEqual(result.json.files, []);
  assert.equal(result.json.fileCount, 0);
});

test('invalid refs and unknown options fail closed with machine-readable errors', () => {
  const root = repoFixture();
  const cli = cliSource;
  const badRef = invoke(cli, root, ['--base', 'missing-ref']);
  assert.equal(badRef.code, 2);
  assert.equal(badRef.json.profile, 'full');
  assert.equal(badRef.json.status, 'error');
  assert.equal(badRef.json.files, null);
  const badOption = invoke(cli, root, ['--base', 'HEAD', '--surprise']);
  assert.equal(badOption.code, 2);
  assert.equal(badOption.json.status, 'error');
  assert.match(badOption.json.reason, /unknown option/u);
  const missingBase = invoke(cli, root, ['--head', 'HEAD']);
  assert.equal(missingBase.code, 2);
  assert.match(missingBase.json.reason, /requires --base/u);
});

test('portable Git fixture runner reports command failure and refuses a process that never ran', () => {
  const root = repoFixture();
  const failed = gitResult(['rev-parse', 'missing-ref'], root);
  assert.notEqual(failed.status, 0);
  assert.throws(() => gitTrim(['rev-parse', 'missing-ref'], root), /git rev-parse missing-ref failed/u);
  assert.throws(
    () => gitResult(['status'], join(root, 'missing-directory')),
    /fixture prerequisite failed: git did not complete/u,
  );
});

test('explicit base/head compares committed refs and reports renamed paths', () => {
  const root = repoFixture();
  const base = gitTrim(['rev-parse', 'HEAD'], root);
  gitOut(['mv', 'base.txt', 'next.txt'], root);
  gitOut(['commit', '-qm', 'rename'], root);
  const head = gitTrim(['rev-parse', 'HEAD'], root);
  const result = invoke(cliSource, root, ['--base', base, '--head', head]);
  assert.equal(result.code, 0);
  assert.equal(result.json.source, 'refs');
  assert.equal(result.json.base, base);
  assert.equal(result.json.head, head);
  assert.deepEqual(result.json.files, ['base.txt', 'next.txt']);
});

test('binary tracked changes remain in the manifest without an invented line count', () => {
  const root = repoFixture();
  writeFileSync(join(root, 'base.txt'), Buffer.from([0, 255, 1, 2]));
  const result = invoke(cliSource, root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.files, ['base.txt']);
  assert.equal(Object.hasOwn(result.json, 'changedLines'), false);
});

test('a symlinked CLI entry still executes and paths with spaces are supported', () => {
  const root = repoFixture();
  const link = join(root, '.git', 'preflight alias.mjs');
  symlinkSync(cliSource, link);
  const result = invoke(link, root);
  assert.equal(result.code, 0);
  assert.equal(result.json.status, 'empty');
});

test('working-tree manifest unions staged, unstaged, deleted, and untracked paths', () => {
  const root = repoFixture();
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  gitOut(['add', 'staged.txt'], root);
  writeFileSync(join(root, 'unstaged.txt'), 'unstaged\n');
  unlinkSync(join(root, 'base.txt'));
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n');
  const result = invoke(cliSource, root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.files, ['base.txt', 'staged.txt', 'unstaged.txt', 'untracked.txt']);
});

test('staged paths remain visible when unstaged edits restore the HEAD contents', () => {
  const root = repoFixture();
  writeFileSync(join(root, 'base.txt'), 'staged contents\n');
  gitOut(['add', 'base.txt'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  const result = invoke(cliSource, root);
  assert.equal(result.code, 0);
  assert.equal(result.json.status, 'complete');
  assert.deepEqual(result.json.files, ['base.txt']);
});

test('copied CLI classifies staged and untracked files on an unborn branch with an empty local origin', () => {
  const root = unbornRepoFixture();
  const copiedCli = join(root, 'engineering', 'automation', 'agent-preflight', 'cli.mjs');
  mkdirSync(join(root, 'engineering', 'automation', 'agent-preflight'), { recursive: true });
  mkdirSync(join(root, 'engineering', 'automation', 'lib'), { recursive: true });
  cpSync(cliSource, copiedCli);
  cpSync(join(libSourceDirectory, 'main-module.mjs'), join(root, 'engineering', 'automation', 'lib', 'main-module.mjs'));
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  gitOut(['add', 'engineering/automation/agent-preflight/cli.mjs', 'staged.txt'], root);
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n');

  const result = invoke(copiedCli, root);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.json.profile, 'full');
  assert.equal(result.json.status, 'complete');
  assert.equal(result.json.source, 'working-tree');
  assert.equal(result.json.head, null);
  assert.equal(result.json.headState, 'unborn');
  assert.deepEqual(result.json.files, [
    'engineering/automation/agent-preflight/cli.mjs',
    'engineering/automation/lib/main-module.mjs',
    'staged.txt',
    'untracked.txt',
  ]);

  const explicitBase = invoke(copiedCli, root, ['--base', 'origin/main']);
  assert.equal(explicitBase.code, 2);
  assert.equal(explicitBase.json.status, 'error');
});

test('invalid non-symbolic HEAD is not mistaken for an unborn branch', () => {
  const root = unbornRepoFixture();
  writeFileSync(join(root, '.git', 'HEAD'), 'not-a-symbolic-ref\n');
  const result = invoke(cliSource, root);
  assert.equal(result.code, 2);
  assert.equal(result.json.status, 'error');
  assert.match(result.json.reason, /git .*failed|HEAD/u);
});

test('copied test file runs from a copied kit tree whose path contains spaces', () => {
  const root = repoFixture();
  const installRoot = join(root, 'installed kit with spaces', 'a', 'b');
  const copiedRoot = join(installRoot, 'tests', 'contracts');
  mkdirSync(copiedRoot, { recursive: true });
  cpSync(fileURLToPath(new URL('.', import.meta.url)), copiedRoot, { recursive: true });
  cpSync(cliSourceDirectory, join(installRoot, 'src', 'contracts'), { recursive: true });
  cpSync(libSourceDirectory, join(installRoot, 'src', 'lib'), { recursive: true });
  cpSync(testSupportSource, join(installRoot, 'tests', 'support'), {
    recursive: true,
  });
  const childEnv = isolatedFixtureGitEnv();
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-name-pattern=^(empty working tree is valid and reported as empty with full profile|binary tracked changes remain in the manifest without an invented line count|staged paths remain visible when unstaged edits restore the HEAD contents)$',
      join(copiedRoot, 'cli.test.mjs'),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: childEnv,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `node was terminated by ${result.signal}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /fail 0/u);
});

test('main-module detection canonicalizes symlinks and refuses a dead entrypoint', () => {
  const root = mkdtempTracked('starter main-module ');
  const source = join(root, 'entry.mjs');
  const alias = join(root, 'entry-alias.mjs');
  writeFileSync(source, '');
  symlinkSync(source, alias);
  const moduleUrl = pathToFileURL(source).href;
  assert.equal(isMainModule(moduleUrl, alias), true);
  assert.equal(isMainModule(moduleUrl, join(root, 'missing.mjs')), false);
  assert.equal(isMainModule(moduleUrl, ''), false);
});
