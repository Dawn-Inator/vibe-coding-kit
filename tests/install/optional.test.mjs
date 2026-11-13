import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(repoRoot, 'cli.mjs');

function optionalProbeEnv(fixture, env = process.env) {
  const home = env.HOME && env.HOME !== process.env.HOME ? env.HOME : join(fixture.root, 'isolated-home');
  const bin = join(fixture.root, 'optional-probe-bin');
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') writeFileSync(codex, '@echo off\necho {"installed":[]}\n');
  else writeFileSync(codex, '#!/bin/sh\nprintf \'{"installed":[]}\\n\'\n', { mode: 0o755 });
  return { ...env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${env.PATH || ''}` };
}

function optionalConsumer() {
  const fixture = makeProject();
  for (const name of ['cli.mjs']) cpSync(join(repoRoot, name), join(fixture.source, name));
  for (const name of ['src', 'templates', 'skills']) cpSync(join(repoRoot, name), join(fixture.source, name), { recursive: true });
  const optionalRoot = join(repoRoot, 'optional');
  const excludedOptionalDirectories = new Set(['.git', '.tmp', '.cache', '.turbo', 'node_modules', 'dist', 'build', 'coverage', 'target', '.next', 'out']);
  cpSync(optionalRoot, join(fixture.source, 'optional'), {
    recursive: true,
    filter: (source) => !source.slice(optionalRoot.length).split(/[\\/]+/).some((part) => excludedOptionalDirectories.has(part)),
  });
  commit(fixture.source, 'seed runnable kit with optional catalog');
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

function install(fixture, options = [], env = process.env) {
  return spawnSync(process.execPath, [cliPath, 'install', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid', ...options], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture, env) });
}

test('installer accepts the full inline optional assignment and stores category preferences', () => {
  const fixture = optionalConsumer();
  const result = install(fixture, ['--optional=aliyun=on', '--optional', 'task-progress=off']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.deepEqual(config.optional, { aliyun: true, lark: false, 'non-code': false, 'task-progress': false });
  assert.match(result.stdout, /Optional categories:/);

  const changed = install(fixture, ['--optional=aliyun=off']);
  assert.equal(changed.status, 0, changed.stderr || changed.stdout);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8')).optional.aliyun, false);
});

test('invalid optional assignments fail before registering files and the submodule', () => {
  const fixture = optionalConsumer();
  const before = readFileSync(join(fixture.project, 'README.md'), 'utf8');
  const result = install(fixture, ['--optional=aliyun=yes']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --optional/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
  assert.equal(readFileSync(join(fixture.project, 'README.md'), 'utf8'), before);
});

test('existing install check previews optional overrides without saving them', () => {
  const fixture = optionalConsumer();
  const installed = install(fixture, ['--optional=aliyun=off']);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const before = readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8');
  const checked = spawnSync(process.execPath, [cliPath, 'install', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href, '--optional=aliyun=on', '--check'], { cwd: fixture.project, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /aliyun: on/);
  assert.equal(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'), before);
});

test('legacy init keeps an absent optional field absent and completes its summary', () => {
  const fixture = optionalConsumer();
  const installed = install(fixture);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.optional;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const initialized = spawnSync(process.execPath, [cliPath, 'init', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid'], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture) });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  assert.match(initialized.stdout, /Optional categories:/);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).optional, undefined);
});

test('optional setup-required exits nonzero and reports partial setup without discarding core initialization', { skip: process.platform === 'win32' }, () => {
  const fixture = optionalConsumer();
  const noOptionalTools = join(fixture.root, 'no-optional-tools');
  mkdirSync(noOptionalTools);
  for (const name of ['npm', 'lark-cli']) writeFileSync(join(noOptionalTools, name), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const result = install(fixture, ['--optional=lark=on'], { ...process.env, PATH: `${noOptionalTools}${delimiter}${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Optional lark setup is incomplete \(setup-required\)/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), true);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8')).optional.lark, true);
});

test('fresh install reuses an already installed task progress plugin while configuring another category', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const fixture = optionalConsumer();
  const fakeHome = join(fixture.root, 'fake-home');
  const helper = join(fakeHome, 'Library/Application Support/CodexTaskProgress/install/current/bin/goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n');
  chmodSync(helper, 0o755);
  const result = install(fixture, ['--optional=aliyun=on'], { ...process.env, HOME: fakeHome });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.optional['task-progress'], true);
  assert.match(result.stdout, /codex-task-progress: already installed; reused/);
});

test('task progress detection errors do not block other categories but selected setup fails clearly', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const fixture = optionalConsumer();
  const fakeHome = join(fixture.root, 'fake-home');
  const helper = join(fakeHome, 'Library/Application Support/CodexTaskProgress/install/current/bin/goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, '#!/bin/sh\nprintf \'{"ok":false}\\n\'\nexit 1\n');
  chmodSync(helper, 0o755);
  const env = { ...process.env, HOME: fakeHome };
  const installed = install(fixture, ['--optional=aliyun=on'], env);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /plugin detection failed/);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8')).optional.aliyun, true);

  const selected = install(fixture, ['--optional=task-progress=on'], env);
  assert.notEqual(selected.status, 0);
  assert.match(selected.stderr, /Could not detect selected optional plugin codex-task-progress/);
});
