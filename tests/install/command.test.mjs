import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';
import { fakeGhEnvironment } from '../support/fake-gh.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';
import { consumerProject, optionalProbeEnv, requireExplicitFixtureIdentity, run } from '../support/install-command-harness.mjs';

const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

after(cleanupTempDirs);

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
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.skills.skills['vault-secret-access'].mode, 'local');
  for (const mirror of ['.agents/skills', '.claude/skills']) {
    assert.ok(existsSync(join(fixture.project, mirror, 'vault-secret-access/SKILL.md')));
    assert.equal(existsSync(join(fixture.project, mirror, 'secret-repository-access/SKILL.md')), false);
  }
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

test('fresh noninteractive install defaults secret storage off without creating or asking for credentials', () => {
  const fixture = consumerProject();
  const result = spawnSync(process.execPath, [cliPath, 'install', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid'], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.secrets, undefined);
  assert.equal(config.optional.aliyun, false);
  assert.equal(config.optional.lark, false);
  assert.equal(config.optional['non-code'], false);
  assert.equal(config.optional['task-progress'], undefined);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), true);
});

test('install creates and records the private secrets repository without placing it inside the project', () => {
  const fixture = consumerProject();
  const log = join(fixture.project, '..', 'gh-calls');
  const args = [cliPath, 'install', '--project-root', fixture.project, '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Install User', '--identity-email', 'install@example.invalid', '--secrets', 'github'];
  const options = { cwd: fixture.project, encoding: 'utf8', env: fakeGhEnvironment(join(fixture.project, '..'), { log, cloneGit: true, env: optionalProbeEnv(fixture) }) };
  const dry = spawnSync(process.execPath, [...args, '--check'], options);
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, /would create private/);
  assert.doesNotMatch(existsSync(log) ? readFileSync(log, 'utf8') : '', /repo create/);
  const installed = spawnSync(process.execPath, args, options);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.secrets.method, 'github');
  assert.equal(config.skills.skills['secret-repository-access'].mode, 'local');
  for (const mirror of ['.agents/skills', '.claude/skills']) {
    assert.ok(existsSync(join(fixture.project, mirror, 'secret-repository-access/SKILL.md')));
    assert.equal(existsSync(join(fixture.project, mirror, 'vault-secret-access/SKILL.md')), false);
  }
  assert.match(config.secrets.repository, /^fixture-owner\/.+-secret-key$/);
  assert.ok(existsSync(join(fixture.project, config.secrets.localPath)));
  assert.match(readFileSync(log, 'utf8'), /repo create .* --private/);
  const repeat = spawnSync(process.execPath, args, options);
  assert.equal(repeat.status, 0, repeat.stderr || repeat.stdout);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('repo create ')).length, 1);
});

test('failed repository clone reports exact recovery and init verifies the repaired private clone', () => {
  const fixture = consumerProject();
  const options = { cwd: fixture.project, encoding: 'utf8', env: fakeGhEnvironment(join(fixture.project, '..'), { failClone: true, env: optionalProbeEnv(fixture) }) };
  const args = [cliPath, 'install', '--project-root', fixture.project, '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Install User', '--identity-email', 'install@example.invalid', '--secrets', 'github'];
  const failed = spawnSync(process.execPath, args, options);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /To recover[\s\S]*--secrets-repository[\s\S]*--secrets-local-path/);
  const repoName = `${basename(fixture.project)}-secret-key`;
  const sibling = join(fixture.project, '..', repoName);
  mkdirSync(sibling); git(sibling, ['init']); git(sibling, ['remote', 'add', 'origin', `https://github.com/fixture-owner/${repoName}.git`]);
  const recovery = [cliPath, 'init', '--project-root', fixture.project, '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Install User', '--identity-email', 'install@example.invalid', '--secrets', 'github',
    '--secrets-repository', `fixture-owner/${repoName}`, '--secrets-local-path', `../${repoName}`];
  const notPrivate = spawnSync(process.execPath, recovery, { ...options, env: { ...options.env, TEST_VISIBILITY: 'public' } });
  assert.equal(notPrivate.status, 1);
  assert.match(notPrivate.stderr, /must be private/);
  const repaired = spawnSync(process.execPath, recovery, options);
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.secrets.repository, `fixture-owner/${repoName}`);
  assert.equal(config.skills.skills['secret-repository-access'].mode, 'local');
});


test('install rejects an opposing pre-existing or explicitly selected secret access skill before mutation', () => {
  for (const mode of ['existing', 'explicit']) {
    const fixture = consumerProject();
    if (mode === 'existing') {
      const path = join(fixture.project, '.vibe-coding/skills/secret-repository-access');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'SKILL.md'), '---\nname: secret-repository-access\ndescription: Existing project skill\n---\nKeep this file.\n');
      commit(fixture.project, 'add existing access skill');
    }
    const result = run(fixture, mode === 'explicit' ? ['--skill', 'secret-repository-access=local'] : []);
    assert.notEqual(result.status, 0, mode);
    assert.match(result.stderr, /Conflicting secret access skill/, mode);
    assert.equal(existsSync(join(fixture.project, '.gitmodules')), false, mode);
    if (mode === 'existing') assert.match(readFileSync(join(fixture.project, '.vibe-coding/skills/secret-repository-access/SKILL.md'), 'utf8'), /Keep this file/);
  }
});

test('GitHub choice also rejects a pre-existing Vault skill without creating anything', () => {
  const fixture = consumerProject();
  git(fixture.project, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  const path = join(fixture.project, '.vibe-coding/skills/vault-secret-access');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), '---\nname: vault-secret-access\ndescription: Existing Vault skill\n---\nKeep it.\n');
  commit(fixture.project, 'add existing Vault skill');
  const result = run(fixture, ['--secrets', 'github']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Conflicting secret access skill vault-secret-access/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
  assert.match(readFileSync(join(path, 'SKILL.md'), 'utf8'), /Keep it/);
});
