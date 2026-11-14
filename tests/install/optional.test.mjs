import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { askTaskProgressDockSetup, askTaskProgressSigningIdentity, shouldAskTaskProgressDockSetup } from '../../cli.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(repoRoot, 'cli.mjs');

test('signing identity prompt is TTY-only, lists certificates, and declines by default', async () => {
  const candidates = [{ name: 'Developer ID Application: Example', identity: '0123456789abcdef0123456789abcdef01234567' }];
  const unavailableQuestion = async () => assert.fail('a non-TTY invocation must not prompt');
  assert.equal(await askTaskProgressSigningIdentity(candidates, {
    input: { isTTY: false }, output: { isTTY: true }, ask: unavailableQuestion,
  }), null);

  let questionCount = 0, message = '';
  const ask = async (text) => { questionCount += 1; message = text; return ''; };
  assert.equal(await askTaskProgressSigningIdentity(candidates, {
    input: { isTTY: true }, output: { isTTY: true }, ask,
  }), null);
  assert.equal(questionCount, 1);
  assert.match(message, /1\. Developer ID Application: Example/);
  assert.match(message, /0123456789abcdef0123456789abcdef01234567/);
  assert.match(message, /Enter to decline/);

  assert.equal(await askTaskProgressSigningIdentity(candidates, {
    input: { isTTY: true }, output: { isTTY: true }, ask: async () => '1',
  }), candidates[0].identity);
  assert.equal(await askTaskProgressSigningIdentity(candidates, {
    input: { isTTY: true }, output: { isTTY: true }, ask: async () => candidates[0].identity,
  }), candidates[0].identity);
});

test('managed Dock prompt is a separate default-no opt-in and is hidden unless the supported launcher is missing', async () => {
  const status = { status: 'installed', launcherSupported: true, launcherInstalled: false, dockConfigured: false };
  assert.equal(shouldAskTaskProgressDockSetup(status, true), true);
  assert.equal(shouldAskTaskProgressDockSetup({ ...status, dockConfigured: true }, true), false);
  assert.equal(shouldAskTaskProgressDockSetup({ ...status, launcherSupported: false }, true), false);
  assert.equal(shouldAskTaskProgressDockSetup(status, false), false);

  let message = '';
  const ask = async (text) => { message = text; return ''; };
  assert.equal(await askTaskProgressDockSetup({ input: { isTTY: true }, output: { isTTY: true }, ask }), false);
  assert.match(message, /same-name, same-icon one-click Codex Task Progress entry in the Dock\? \[y\/N\]/);
  assert.equal(await askTaskProgressDockSetup({ input: { isTTY: true }, output: { isTTY: true }, ask: async () => 'no' }), false);
  assert.equal(await askTaskProgressDockSetup({ input: { isTTY: true }, output: { isTTY: true }, ask: async () => 'yes' }), true);
  let prompted = false;
  assert.equal(await askTaskProgressDockSetup({ input: { isTTY: false }, output: { isTTY: true }, ask: async () => { prompted = true; return 'yes'; } }), false);
  assert.equal(prompted, false, 'non-TTY callers must not prompt or authorize Dock changes');
});

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

function configure(fixture, category, env = process.env) {
  return spawnSync(process.execPath, [cliPath, 'optional', 'configure', '--project-root', fixture.project,
    '--optional', category], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture, env) });
}

test('installer accepts the full inline optional assignment and stores category preferences', () => {
  const fixture = optionalConsumer();
  const result = install(fixture, ['--optional=aliyun=on', '--optional', 'task-progress=off']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.deepEqual(config.optional, { aliyun: true, lark: false, 'non-code': false, 'task-progress': false });
  assert.match(result.stdout, /Optional categories:/);
  const optionalMirror = join(fixture.project, '.agents/skills/alibabacloud-find-skills/SKILL.md');
  assert.equal(existsSync(optionalMirror), true);
  const localSkill = join(fixture.project, '.vibe-coding/skills/manual-local/SKILL.md');
  mkdirSync(join(localSkill, '..'), { recursive: true });
  writeFileSync(localSkill, '---\nname: manual-local\ndescription: User-owned local skill.\n---\nKeep this source.\n');
  const durableFile = join(fixture.project, 'private-notes/credential-sentinel.txt');
  mkdirSync(join(durableFile, '..'), { recursive: true });
  writeFileSync(durableFile, 'keep me\n');

  const disabled = configure(fixture, 'aliyun=off');
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.equal(existsSync(optionalMirror), false);
  assert.equal(readFileSync(localSkill, 'utf8').includes('Keep this source.'), true);
  assert.equal(readFileSync(durableFile, 'utf8'), 'keep me\n');
  assert.equal(existsSync(join(fixture.project, '.agents/skills/agent-orchestration-guardrails/SKILL.md')), true);

  const enabled = configure(fixture, 'aliyun=on');
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.equal(existsSync(optionalMirror), true);

  const changed = install(fixture, ['--optional=aliyun=off']);
  assert.equal(changed.status, 0, changed.stderr || changed.stdout);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8')).optional.aliyun, false);
  assert.equal(existsSync(optionalMirror), false);
  assert.equal(readFileSync(localSkill, 'utf8').includes('Keep this source.'), true);
  assert.equal(readFileSync(durableFile, 'utf8'), 'keep me\n');
});

test('fresh init accepts optional adopt/extend/exclude decisions from enabled categories', () => {
  const fixture = optionalConsumer();
  const fakeTools = join(fixture.root, 'optional-tools');
  mkdirSync(fakeTools);
  writeFileSync(join(fakeTools, 'lark-cli'), '#!/bin/sh\nprintf "lark-cli 1.0.0\\n"\n', { mode: 0o755 });
  const result = install(fixture, [
    '--optional=lark=on',
    '--skill', 'lark=extend',
    '--skill', 'lark-doc=exclude:User chose a smaller Lark skill set.',
  ], { ...process.env, PATH: `${fakeTools}${delimiter}${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.skills.skills.lark.mode, 'extend');
  assert.equal(config.skills.skills['lark-doc'].mode, 'exclude');
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/skills/lark/EXTENSION.md')), true);
  assert.equal(existsSync(join(fixture.project, '.agents/skills/lark/SKILL.md')), true);
  assert.equal(existsSync(join(fixture.project, '.agents/skills/lark-doc/SKILL.md')), false);
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

  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  config.optional = { aliyun: false };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const partialConfig = configure(fixture, 'aliyun=on', { ...process.env, HOME: fakeHome });
  assert.equal(partialConfig.status, 0, partialConfig.stderr || partialConfig.stdout);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).optional['task-progress'], false);
});

test('existing plugin changes its Dock launcher only after explicit task-progress opt-in', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  for (const explicit of [false, true]) {
    const fixture = optionalConsumer();
    const initialized = install(fixture);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const fakeHome = join(fixture.root, 'fake-home');
    const launcherLog = join(fixture.root, 'launcher-calls.log');
    const helper = join(fakeHome, 'Library/Application Support/CodexTaskProgress/install/bin/goal-progress');
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, [
      '#!/bin/sh',
      'if [ "$1" = doctor ]; then printf \'{"ok":true,"details":{"pluginInstalled":true}}\\n\'; exit 0; fi',
      'if [ "$1" = launcher ] && [ "$2" = --status ]; then printf \'{"launcherInstalled":false,"dockConfigured":false,"launcherAppPath":null}\\n\'; exit 0; fi',
      `printf '%s\\n' "$*" >> '${launcherLog}'`,
      'if [ "$1" = launcher ] && [ "$2" = --install ]; then printf \'{"ok":true,"details":{"launcherInstalled":true,"dockConfigured":true,"launcherAppPath":"/Applications/Goal Progress.app"}}\\n\'; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    chmodSync(helper, 0o755);
    const result = configure(fixture, explicit ? 'task-progress=on' : 'aliyun=on', { ...process.env, HOME: fakeHome });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    if (explicit) assert.equal(readFileSync(launcherLog, 'utf8').trim(), 'launcher --install --dock --json');
    else assert.equal(existsSync(launcherLog), false, 'an unrelated category update must only reuse the installed plugin');
  }
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

test('legacy animated-presentations selection survives enabling Aliyun without selecting HyperFrames', () => {
  const fixture = optionalConsumer();
  const installed = install(fixture);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.optional;
  config.skills.skills['agent-orchestration-guardrails'] = { mode: 'exclude', rationale: 'User-owned exclusion stays intact.' };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const legacySkill = join(fixture.project, '.vibe-coding/skills/animated-presentations');
  cpSync(join(fixture.source, 'optional/skills/presentations/skills/animated-presentations'), legacySkill, { recursive: true });
  const localSkill = join(fixture.project, '.vibe-coding/skills/manual-local/SKILL.md');
  mkdirSync(join(localSkill, '..'), { recursive: true });
  writeFileSync(localSkill, '---\nname: manual-local\ndescription: User-owned local skill.\n---\nKeep this source.\n');

  const probeBin = join(fixture.root, 'no-hyperframes-probe');
  const npxLog = join(fixture.root, 'unexpected-npx-call');
  mkdirSync(probeBin);
  writeFileSync(join(probeBin, 'curl'), '#!/bin/sh\nprintf "curl 8.0.0\\n"\n', { mode: 0o755 });
  writeFileSync(join(probeBin, 'npx'), `#!/bin/sh\nprintf called >> '${npxLog}'\nexit 127\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${probeBin}${delimiter}${process.env.PATH}` };
  const result = configure(fixture, 'aliyun=on', env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(npxLog), false, 'HyperFrames toolchain was not probed or installed');
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(after.optional.aliyun, true);
  assert.equal(after.optional['non-code'], true);
  assert.equal(after.skills.skills['agent-orchestration-guardrails'].mode, 'exclude');
  assert.equal(after.skills.skills['agent-orchestration-guardrails'].rationale, 'User-owned exclusion stays intact.');
  assert.match(readFileSync(localSkill, 'utf8'), /Keep this source/);
  assert.equal(existsSync(join(fixture.project, '.agents/skills/animated-presentations/SKILL.md')), true);
  assert.equal(existsSync(join(fixture.project, '.agents/skills/hyperframes/SKILL.md')), false);
});
