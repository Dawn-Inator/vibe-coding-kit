import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);
const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

function consumerProject() {
  const fixture = makeProject();
  requireExplicitFixtureIdentity(fixture);
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  for (const name of ['cli.mjs']) cpSync(join(repo, name), join(fixture.source, name));
  for (const name of ['src', 'templates']) cpSync(join(repo, name), join(fixture.source, name), { recursive: true });
  cpSync(join(repo, 'skills'), join(fixture.source, 'skills'), { recursive: true });
  const adapterTemplate = join(fixture.source, 'templates/project-adapter.mjs');
  writeFileSync(adapterTemplate, `${readFileSync(adapterTemplate, 'utf8')}\n// older-template-marker\n`);
  fixture.sourceCommit = commit(fixture.source, 'seed runnable kit CLI and templates');
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  git(fixture.project, ['rm', '-f', '.vibe-coding/kit']);
  git(fixture.project, ['rm', '-f', '.vibe-coding/project.config.json']);
  git(fixture.project, ['config', '-f', '.gitmodules', '--remove-section', 'submodule.vibe-coding-kit'], { allowFailure: true });
  rmSync(join(fixture.project, '.gitmodules'), { force: true });
  rmSync(join(fixture.project, '.vibe-coding/kit'), { recursive: true, force: true });
  rmSync(join(fixture.project, '.git/modules/vibe-coding-kit'), { recursive: true, force: true });
  commit(fixture.project, 'remove fixture kit registration');
  return fixture;
}

function requireExplicitFixtureIdentity(fixture) {
  for (const repo of [fixture.source, fixture.project]) {
    git(repo, ['config', 'user.useConfigOnly', 'true']);
    const identityFallbackProbe = git(repo, ['commit', '--allow-empty', '-m', 'identity fallback must fail'], { allowFailure: true });
    assert.notEqual(identityFallbackProbe.status, 0, 'bare commit must fail when the isolated fixture has no explicit identity');
  }
}

function run(fixture, more = [], projectRoot = fixture.project) {
  return spawnSync(process.execPath, [cliPath, 'install', '--project-root', projectRoot,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid', ...more], { cwd: fixture.project, encoding: 'utf8', env: process.env });
}

test('install check is read-only and fresh install delegates init then is idempotent', () => {
  const fixture = consumerProject();
  const check = run(fixture, ['--check']);
  assert.equal(check.status, 1, check.stderr || check.stdout);
  assert.match(check.stdout, /Remote state was not checked/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit')), false);
  const installed = run(fixture);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(git(fixture.project, ['config', '-f', '.gitmodules', '--get', 'submodule.vibe-coding-kit.path']).stdout.trim(), '.vibe-coding/kit');
  const again = run(fixture);
  assert.equal(again.status, 0, again.stderr || again.stdout);
  assert.match(again.stdout, /existing configuration .* preserved/i);
  assert.equal(run(fixture, ['--check']).status, 0);
});

test('fresh JavaScript projects keep their package metadata and merge kit scripts', () => {
  const fixture = consumerProject();
  const packagePath = join(fixture.project, 'package.json');
  writeFileSync(packagePath, `${JSON.stringify({ name: 'consumer-app', scripts: { test: 'node app-test.mjs' }, dependencies: { sample: '1.0.0' } }, null, 2)}\n`);
  writeFileSync(join(fixture.project, '.gitignore'), 'node_modules/\n');
  commit(fixture.project, 'JavaScript consumer');
  mkdirSync(join(fixture.project, 'node_modules/sample'), { recursive: true });
  writeFileSync(join(fixture.project, 'node_modules/sample/package.json'), '{}');
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(packageJson.name, 'consumer-app');
  assert.equal(packageJson.scripts.test, 'node app-test.mjs');
  assert.equal(packageJson.scripts['skills:sync'], 'node engineering/automation/vibe-coding/bootstrap.mjs skills sync');
  assert.deepEqual(packageJson.dependencies, { sample: '1.0.0' });
});

test('install accepts an exact older commit and repeat preserves local edits without fetching upgrades', () => {
  const fixture = consumerProject();
  const older = fixture.sourceCommit;
  writeFileSync(join(fixture.source, 'templates/project-adapter.mjs'), `${readFileSync(join(fixture.source, 'templates/project-adapter.mjs'), 'utf8')}\n// newer-template-marker\n`);
  const current = commit(fixture.source, 'newer fixture revision');
  assert.notEqual(current, older);
  const installed = run(fixture, ['--ref', older]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'rev-parse', 'HEAD']).stdout.trim(), older);
  const installedAdapter = readFileSync(join(fixture.project, 'engineering/automation/vibe-coding/project-adapter.mjs'), 'utf8');
  assert.match(installedAdapter, /older-template-marker/);
  assert.doesNotMatch(installedAdapter, /newer-template-marker/);
  const adapter = join(fixture.project, 'engineering/automation/vibe-coding/project-adapter.mjs');
  writeFileSync(adapter, 'export const consumerAdapter = true;\n');
  const rerun = run(fixture);
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  assert.equal(readFileSync(adapter, 'utf8'), 'export const consumerAdapter = true;\n');
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'rev-parse', 'HEAD']).stdout.trim(), older);
  const requestedUpgrade = run(fixture, ['--ref', current]);
  assert.equal(requestedUpgrade.status, 1);
  assert.match(requestedUpgrade.stderr, /does not upgrade/);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'rev-parse', 'HEAD']).stdout.trim(), older);
  const wrongUrl = run(fixture, ['--url', 'https://example.invalid/other-kit.git']);
  assert.equal(wrongUrl.status, 1);
  assert.match(wrongUrl.stderr, /differs from requested URL/);
  assert.equal(readFileSync(adapter, 'utf8'), 'export const consumerAdapter = true;\n');
});

test('install repeats resolve tags locally by commit and reject a different local tag without changing Git state', () => {
  const fixture = consumerProject();
  const older = fixture.sourceCommit;
  git(fixture.source, ['tag', 'fixture-v1', older]);
  git(fixture.source, ['tag', 'fixture-v1-alias', older]);
  const template = join(fixture.source, 'templates/project-adapter.mjs');
  writeFileSync(template, `${readFileSync(template, 'utf8')}\n// tag-v2-template-marker\n`);
  const newer = commit(fixture.source, 'newer tagged fixture');
  git(fixture.source, ['tag', 'fixture-v2', newer]);

  const installed = run(fixture, ['--ref', 'fixture-v1']);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'rev-parse', 'HEAD']).stdout.trim(), older);
  const projectStateBefore = git(fixture.project, ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
  const moduleStateBefore = git(join(fixture.project, '.vibe-coding/kit'), ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
  const refsBefore = git(join(fixture.project, '.vibe-coding/kit'), ['for-each-ref', '--format=%(refname) %(objectname)']).stdout;

  const repeat = run(fixture, ['--ref', 'fixture-v1']);
  assert.equal(repeat.status, 0, repeat.stderr || repeat.stdout);
  const alias = run(fixture, ['--ref', 'fixture-v1-alias']);
  assert.equal(alias.status, 0, alias.stderr || alias.stdout);
  const otherTag = run(fixture, ['--ref', 'fixture-v2']);
  assert.equal(otherTag.status, 1);
  assert.match(otherTag.stderr, /resolves locally to .*install does not upgrade/);

  assert.equal(git(fixture.project, ['status', '--porcelain=v1', '--untracked-files=all']).stdout, projectStateBefore);
  assert.equal(git(join(fixture.project, '.vibe-coding/kit'), ['status', '--porcelain=v1', '--untracked-files=all']).stdout, moduleStateBefore);
  assert.equal(git(join(fixture.project, '.vibe-coding/kit'), ['for-each-ref', '--format=%(refname) %(objectname)']).stdout, refsBefore);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'rev-parse', 'HEAD']).stdout.trim(), older);
});

test('install preflight rejects missing identity, dirty roots, and occupied paths without modifying them', () => {
  const missingIdentity = consumerProject();
  const result = spawnSync(process.execPath, [cliPath, 'install', '--project-root', missingIdentity.project,
    '--url', pathToFileURL(missingIdentity.source).href, '--identity-name', 'Only Name'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity-name and --identity-email/);
  assert.equal(existsSync(join(missingIdentity.project, '.gitmodules')), false);

  const dirty = consumerProject();
  writeFileSync(join(dirty.project, 'local.txt'), 'keep me');
  const dirtyResult = run(dirty);
  assert.equal(dirtyResult.status, 1);
  assert.match(dirtyResult.stderr, /dirty Git project/);
  assert.equal(existsSync(join(dirty.project, '.gitmodules')), false);
  assert.equal(readFileSync(join(dirty.project, 'local.txt'), 'utf8'), 'keep me');

  const occupied = consumerProject();
  mkdirSync(join(occupied.project, '.vibe-coding/kit'), { recursive: true });
  writeFileSync(join(occupied.project, '.vibe-coding/kit/keep.txt'), 'keep');
  commit(occupied.project, 'occupied path');
  const occupiedResult = run(occupied);
  assert.equal(occupiedResult.status, 1);
  assert.match(occupiedResult.stderr, /occupied and will be preserved/i);
  assert.equal(readFileSync(join(occupied.project, '.vibe-coding/kit/keep.txt'), 'utf8'), 'keep');
});

test('install and direct init preserve existing generated instruction targets', () => {
  const fresh = consumerProject();
  const instructions = join(fresh.project, 'AGENTS.md');
  writeFileSync(instructions, 'consumer instructions\n');
  commit(fresh.project, 'consumer instructions');
  const install = run(fresh);
  assert.equal(install.status, 1);
  assert.match(install.stderr, /projection target already exists/);
  assert.equal(existsSync(join(fresh.project, '.gitmodules')), false);
  assert.equal(readFileSync(instructions, 'utf8'), 'consumer instructions\n');

  const registered = makeProject();
  requireExplicitFixtureIdentity(registered);
  git(registered.project, ['rm', '-f', '.vibe-coding/project.config.json']);
  writeFileSync(join(registered.project, 'CLAUDE.md'), 'local Claude instructions\n');
  commit(registered.project, 'consumer Claude instructions');
  const direct = spawnSync(process.execPath, [cliPath, 'init', '--project-root', registered.project,
    '--url', pathToFileURL(registered.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid'], { encoding: 'utf8' });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /projection target already exists/);
  assert.equal(existsSync(join(registered.project, '.vibe-coding/project.config.json')), false);
  assert.equal(readFileSync(join(registered.project, 'CLAUDE.md'), 'utf8'), 'local Claude instructions\n');
});

test('install validates invalid skill decisions before registering the submodule', () => {
  const fixture = consumerProject();
  const result = run(fixture, ['--skill', 'agent-orchestration-guardrails=exclude']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exclude requires a common skill and an explicit rationale/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit')), false);
});

test('install rejects a committed symlink at the kit path without touching its target', { skip: process.platform === 'win32' }, () => {
  const fixture = consumerProject();
  const outside = join(fixture.root, 'outside-kit-target');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'preserve');
  mkdirSync(join(fixture.project, '.vibe-coding'), { recursive: true });
  symlinkSync(outside, join(fixture.project, '.vibe-coding/kit'), 'dir');
  commit(fixture.project, 'symlink kit target');
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink install target/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'preserve');
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
});

test('install refuses non-root paths and missing refs before init', () => {
  const fixture = consumerProject();
  const nested = join(fixture.project, 'nested');
  mkdirSync(nested);
  const notRoot = spawnSync(process.execPath, [cliPath, 'install', '--project-root', nested,
    '--identity-name', 'Install User', '--identity-email', 'install@example.invalid'], { encoding: 'utf8' });
  assert.equal(notRoot.status, 1);
  assert.match(notRoot.stderr, /existing Git project root/);
  const missing = run(fixture, ['--ref', 'missing-ref-for-fixture']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /could not be fetched/);
  assert.ok(existsSync(join(fixture.project, '.gitmodules')), 'registration is accurately retained after fetch failure');
  assert.equal(existsSync(join(fixture.project, 'engineering/automation/vibe-coding/project-adapter.mjs')), false);
});

test('installer accepts Windows case and available 8.3 aliases for the same project root', { skip: process.platform !== 'win32' }, () => {
  const fixture = consumerProject();
  const caseAlias = fixture.project.toUpperCase();
  assert.notEqual(caseAlias, fixture.project);
  const caseCheck = run(fixture, ['--check'], caseAlias);
  assert.equal(caseCheck.status, 1, caseCheck.stderr || caseCheck.stdout);
  assert.match(caseCheck.stdout, /Would register/);

  const shortPath = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${fixture.project}") do @echo %~sI`], { encoding: 'utf8' });
  if (shortPath.status === 0) {
    const shortAlias = shortPath.stdout.trim().split(/\r?\n/).at(-1);
    if (shortAlias && shortAlias.toLowerCase() !== fixture.project.toLowerCase()) {
      const shortCheck = run(fixture, ['--check'], shortAlias);
      assert.equal(shortCheck.status, 1, shortCheck.stderr || shortCheck.stdout);
      assert.match(shortCheck.stdout, /Would register/);
    }
  }
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
});
