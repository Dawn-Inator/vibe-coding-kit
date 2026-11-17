// platform-gate: darwin-only
// Real-subprocess end-to-end coverage of `install` -> configure on a macOS host with a fake already-installed Task
// Progress helper under a temporary HOME. The helper path and reuse logic exist for Apple Silicon only, so this
// file is meant for the arm64 macOS runner. tests/install/optional.test.mjs covers the same outcomes through
// injected host seams on every platform.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { configure, install, optionalConsumer } from '../support/optional-install-harness.mjs';

after(cleanupTempDirs);

test('fresh install reuses an already installed task progress plugin while configuring another category', () => {
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
  assert.match(result.stdout, /Optional codex-task-progress: already installed; reused/);

  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  config.optional = { aliyun: false };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const partialConfig = configure(fixture, 'aliyun=on', { ...process.env, HOME: fakeHome });
  assert.equal(partialConfig.status, 0, partialConfig.stderr || partialConfig.stdout);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).optional['task-progress'], false);
});

test('explicit task-progress selection reuses the native plugin without launcher setup', () => {
  const fixture = optionalConsumer();
  const initialized = install(fixture);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const fakeHome = join(fixture.root, 'fake-home');
  const helper = join(fakeHome, 'Library/Application Support/CodexTaskProgress/install/bin/goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, [
    '#!/bin/sh',
    'if [ "$1" = doctor ]; then printf \'{"ok":true,"details":{"pluginInstalled":true}}\\n\'; exit 0; fi',
    'exit 97',
    '',
  ].join('\n'));
  chmodSync(helper, 0o755);
  const result = configure(fixture, 'task-progress=on', { ...process.env, HOME: fakeHome });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /codex-task-progress: already installed; reused/);
  assert.doesNotMatch(result.stdout + result.stderr, /Dock|launcher/i);
});

test('task progress detection errors do not block other categories but selected setup fails clearly', () => {
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

test('unselected Task Progress detection failure does not block core optional setup', () => {
  const fixture = optionalConsumer();
  const result = install(fixture, ['--optional=aliyun=on'], { ...process.env, KIT_OPTIONAL_PROBE_CODEX_FAIL: '1' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.optional.aliyun, true);
  assert.equal(config.optional['task-progress'], false);
  assert.match(result.stdout, /task-progress: plugin detection failed/);
});
