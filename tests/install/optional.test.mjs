import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureOptional } from '../../cli.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { cliPath, configure, install, optionalConsumer, optionalProbeEnv, repoRoot } from '../support/optional-install-harness.mjs';

after(cleanupTempDirs);

// In-process host simulation: platform, architecture, home and every external command are injected, so the
// missing-tool paths run identically on every operating system.
// Tools the catalog probes for unrelated categories; present by default so only the case under test varies.
const DEFAULT_COMMANDS = { curl: () => ({ code: 0, stdout: 'curl 8.0.0\n', stderr: '' }) };

function simulatedHost(fixture, { home, platform = 'darwin', arch = 'arm64', commands = {} } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const name = command.replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe)$/i, '');
    const handler = commands[name] ?? DEFAULT_COMMANDS[name];
    if (handler) return handler(args);
    return { code: 127, stdout: '', stderr: 'command not found' };
  };
  const base = home ?? join(fixture.root, 'isolated-home');
  return { host: { platform, arch, env: { ...process.env, HOME: base, USERPROFILE: base }, runner }, calls };
}

async function configureInProcess(fixture, overrides, host) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => { lines.push(parts.join(' ')); };
  try {
    await configureOptional(fixture.project, join(fixture.project, '.vibe-coding/kit'), overrides, {}, host);
  } finally { console.log = original; }
  return lines.join('\n');
}

function readProjectConfig(fixture) {
  return JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
}

test('installer accepts the full inline optional assignment and stores category preferences', () => {
  const fixture = optionalConsumer();
  const result = install(fixture, ['--optional=aliyun=on', '--optional', 'lark=off']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.deepEqual(config.optional, { aliyun: true, lark: false, 'non-code': false, 'app-store-compliance': false });
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

test('optional setup-required reports partial setup without discarding core initialization', async () => {
  const fixture = optionalConsumer();
  const installed = install(fixture);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  // npm and lark-cli are both unavailable on the simulated host.
  const { host } = simulatedHost(fixture, { platform: 'linux', arch: 'x64' });
  await assert.rejects(
    configureInProcess(fixture, { lark: true }, host),
    /Optional lark setup is incomplete \(setup-required\)/,
  );
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), true);
  assert.equal(readProjectConfig(fixture).optional.lark, true);
});

test('retired Dock setup CLI flag gives a migration hint before project changes', () => {
  const fixture = optionalConsumer();
  const result = install(fixture, ['--managed-dock-opt-in', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /managed Dock setup options are retired/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
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
