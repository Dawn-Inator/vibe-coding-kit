import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
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

function snapshotFiles(root, { excludedPaths = new Set() } = {}) {
  const entries = [];
  const walk = (directory, relativeDirectory = '') => {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (excludedPaths.has(relativePath)) continue;
      const absolutePath = join(directory, name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        entries.push(`symlink ${relativePath} -> ${readlinkSync(absolutePath)}`);
      } else if (stat.isDirectory()) {
        entries.push(`directory ${relativePath}`);
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
        entries.push(`file ${relativePath} ${digest}`);
      } else {
        entries.push(`other ${relativePath} mode=${stat.mode}`);
      }
    }
  };
  walk(root);
  return entries;
}

function snapshotGitState(repo, { excludedPaths = new Set() } = {}) {
  return {
    head: git(repo, ['rev-parse', '--verify', 'HEAD']).stdout.trim(),
    index: git(repo, ['ls-files', '--stage', '-z']).stdout,
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout,
    config: git(repo, ['config', '--local', '--list', '--null']).stdout,
    files: snapshotFiles(repo, { excludedPaths }),
  };
}

function snapshotInstalledProject(fixture) {
  return {
    parent: snapshotGitState(fixture.project, { excludedPaths: new Set(['.git', '.vibe-coding/kit']) }),
    kit: snapshotGitState(join(fixture.project, '.vibe-coding/kit'), { excludedPaths: new Set(['.git']) }),
  };
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
  const projectStateBefore = snapshotInstalledProject(fixture);
  const generatedInstructions = join(fixture.project, '.vibe-coding/loading.md');
  const originalInstructions = readFileSync(generatedInstructions);
  try {
    writeFileSync(generatedInstructions, Buffer.concat([originalInstructions, Buffer.from('\nmutation probe\n')]));
    assert.notDeepEqual(snapshotInstalledProject(fixture), projectStateBefore, 'semantic snapshot must detect real generated-file content changes');
  } finally {
    writeFileSync(generatedInstructions, originalInstructions);
  }
  assert.deepEqual(snapshotInstalledProject(fixture), projectStateBefore, 'restoring generated-file bytes restores the semantic snapshot');

  const repeat = run(fixture, ['--ref', 'fixture-v1']);
  assert.equal(repeat.status, 0, repeat.stderr || repeat.stdout);
  const alias = run(fixture, ['--ref', 'fixture-v1-alias']);
  assert.equal(alias.status, 0, alias.stderr || alias.stdout);
  const otherTag = run(fixture, ['--ref', 'fixture-v2']);
  assert.equal(otherTag.status, 1);
  assert.match(otherTag.stderr, /resolves locally to .*install does not upgrade/);

  assert.deepEqual(snapshotInstalledProject(fixture), projectStateBefore, 'repeated installs preserve parent and kit index, refs, config, and file contents');
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

test('installer accepts Windows case and available 8.3 aliases for the same project root', { skip: process.platform !== 'win32' }, (t) => {
  const fixture = consumerProject();
  const caseAlias = fixture.project.toUpperCase();
  assert.notEqual(caseAlias, fixture.project);
  const caseCheck = run(fixture, ['--check'], caseAlias);
  assert.equal(caseCheck.status, 1, `case-alias install --check: status=${caseCheck.status}, stderr=${caseCheck.stderr}, stdout=${caseCheck.stdout}`);
  assert.match(caseCheck.stdout, /Would register/, `case-alias install --check: status=${caseCheck.status}, stderr=${caseCheck.stderr}, stdout=${caseCheck.stdout}`);

  const shortPathScript = join(fixture.project, 'resolve-short-path.cmd');
  writeFileSync(shortPathScript, '@echo off\r\nfor %%I in ("%CD%") do @echo %%~sI\r\n');
  const shortPath = spawnSync('cmd.exe', ['/d', '/c', 'resolve-short-path.cmd'], { cwd: fixture.project, encoding: 'utf8' });
  rmSync(shortPathScript, { force: true });
  assert.equal(shortPath.error, undefined, `8.3 path query failed to start: ${shortPath.error?.message || ''}`);
  assert.equal(shortPath.status, 0, `8.3 path query failed: status=${shortPath.status}, stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  const shortAlias = shortPath.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(shortAlias, `8.3 path query returned no candidate: status=${shortPath.status}, stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  assert.ok(existsSync(shortAlias), `8.3 path candidate does not exist: ${JSON.stringify(shortAlias)}; stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  assert.ok(samePathIdentity(shortAlias, fixture.project), `8.3 path candidate is a different filesystem object: ${JSON.stringify(shortAlias)}; project=${fixture.project}`);
  if (!/(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/.test(shortAlias)) {
    t.diagnostic(`Windows did not provide an alternate 8.3 component for this fixture path; case-alias coverage passed. Candidate=${JSON.stringify(shortAlias)}`);
  } else {
    t.diagnostic(`Validated Windows 8.3 candidate: ${JSON.stringify(shortAlias)} (same filesystem identity as ${JSON.stringify(fixture.project)})`);
    const shortCheck = run(fixture, ['--check'], shortAlias);
    assert.equal(shortCheck.status, 1, `8.3-alias install --check: status=${shortCheck.status}, stderr=${shortCheck.stderr}, stdout=${shortCheck.stdout}`);
    assert.match(shortCheck.stdout, /Would register/, `8.3-alias install --check: status=${shortCheck.status}, stderr=${shortCheck.stderr}, stdout=${shortCheck.stdout}`);
  }
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
});
