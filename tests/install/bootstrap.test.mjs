import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);

const template = new URL('../../templates/bootstrap.mjs', import.meta.url);
const depsRuntime = fileURLToPath(new URL('../../src/dependencies/submodule.mjs', import.meta.url));
const pathIdentityRuntime = fileURLToPath(new URL('../../src/lib/path-identity.mjs', import.meta.url));

function runtimeProject() {
  const fixture = makeProject();
  const runtime = join(fixture.source, 'src/dependencies/submodule.mjs');
  const identity = join(fixture.source, 'src/lib/path-identity.mjs');
  mkdirSync(join(fixture.source, 'src/dependencies'), { recursive: true });
  mkdirSync(join(fixture.source, 'src/lib'), { recursive: true });
  cpSync(depsRuntime, runtime);
  cpSync(pathIdentityRuntime, identity);
  const pin = commit(fixture.source, 'add real public dependency runtime');
  const child = join(fixture.project, '.vibe-coding/kit');
  git(child, ['fetch', 'origin', pin]);
  git(child, ['checkout', '--detach', pin]);
  git(fixture.project, ['add', '.vibe-coding/kit']);
  commit(fixture.project, 'record real runtime pin');
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  return { ...fixture, pin, child };
}

function installBootstrap(project) {
  const path = join(project, 'engineering/automation/vibe-coding/bootstrap.mjs');
  mkdirSync(join(project, 'engineering/automation/vibe-coding'), { recursive: true });
  writeFileSync(path, readFileSync(template, 'utf8'));
  return path;
}

function runBootstrap(project, bootstrapPath, args, extraEnv = {}) {
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always', ...extraEnv };
  return spawnSync(process.execPath, [bootstrapPath, ...args], { cwd: project, encoding: 'utf8', env });
}

test('cold bootstrap hydrates an absent target from its cached pin and preserves unrelated parent changes', () => {
  const fixture = runtimeProject();
  rmSync(fixture.child, { recursive: true, force: true });
  writeFileSync(join(fixture.project, 'unrelated-parent-change.txt'), 'keep me\n');
  const bootstrapPath = installBootstrap(fixture.project);
  const result = runBootstrap(fixture.project, bootstrapPath, ['prepare', '--offline']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(join(fixture.project, '.vibe-coding/kit'), ['rev-parse', 'HEAD']).stdout.trim(), fixture.pin);
  assert.equal(readFileSync(join(fixture.project, 'unrelated-parent-change.txt'), 'utf8'), 'keep me\n');
});
test('cold bootstrap hydrates an empty target directory', () => {
  const fixture = runtimeProject();
  rmSync(fixture.child, { recursive: true, force: true });
  mkdirSync(fixture.child);
  const result = runBootstrap(fixture.project, installBootstrap(fixture.project), ['prepare', '--offline']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(fixture.child, ['rev-parse', 'HEAD']).stdout.trim(), fixture.pin);
});

test('bootstrap offline hydration passes no-lazy-fetch and no-prompt to the update process', () => {
  const fixture = runtimeProject();
  rmSync(fixture.child, { recursive: true, force: true });
  const trace = join(fixture.root, 'git-trace2.json');
  const result = runBootstrap(fixture.project, installBootstrap(fixture.project), ['prepare', '--offline'], {
    GIT_TRACE2_EVENT: trace,
    GIT_TRACE2_ENV_VARS: 'GIT_NO_LAZY_FETCH,GIT_TERMINAL_PROMPT',
    GIT_TERMINAL_PROMPT: '1',
    GIT_NO_LAZY_FETCH: '0',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = readFileSync(trace, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const bySession = new Map();
  for (const event of events) bySession.set(event.sid, [...(bySession.get(event.sid) || []), event]);
  const update = [...bySession.values()].find((group) => group.some((event) => event.event === 'start'
    && event.argv?.some((arg, index, argv) => arg === 'submodule' && argv[index + 1] === 'update')));
  assert.ok(update, 'Git trace must include the actual submodule update process');
  const parameters = new Map(update.filter((event) => event.event === 'def_param').map((event) => [event.param, event.value]));
  assert.equal(parameters.get('GIT_NO_LAZY_FETCH'), '1');
  assert.equal(parameters.get('GIT_TERMINAL_PROMPT'), '0');
});

test('cold bootstrap preserves a non-empty uninitialized target and gives recovery guidance', () => {
  const fixture = runtimeProject();
  rmSync(fixture.child, { recursive: true, force: true });
  mkdirSync(fixture.child);
  writeFileSync(join(fixture.child, 'keep.txt'), 'user data\n');
  const result = runBootstrap(fixture.project, installBootstrap(fixture.project), ['prepare', '--offline']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-empty uninitialized directory.*preserve or move its contents aside/i);
  assert.equal(readFileSync(join(fixture.child, 'keep.txt'), 'utf8'), 'user data\n');
});

test('offline hydration fails closed without the target object, then succeeds after the cache is populated', () => {
  const fixture = runtimeProject();
  writeFileSync(join(fixture.source, 'later.txt'), 'object not yet in the child cache\n');
  const laterPin = commit(fixture.source, 'advance source beyond local submodule cache');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${laterPin},.vibe-coding/kit`]);
  commit(fixture.project, 'advance the parent gitlink');
  rmSync(fixture.child, { recursive: true, force: true });
  const moduleDb = git(fixture.project, ['rev-parse', '--git-path', 'modules/vibe-coding-kit']).stdout.trim();
  const modulePath = moduleDb.startsWith('/') ? moduleDb : join(fixture.project, moduleDb);
  const objects = join(modulePath, 'objects');
  const privateUrl = 'ssh://example.invalid/private/vibe-coding-kit.git';
  git(fixture.project, ['config', '-f', '.gitmodules', 'submodule.vibe-coding-kit.url', privateUrl]);
  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.kit.url = privateUrl;
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const callLog = join(fixture.root, 'ssh-called.txt');
  const sshStub = join(fixture.root, 'ssh-stub');
  writeFileSync(sshStub, `#!/bin/sh\nprintf called >> '${callLog}'\nexit 1\n`);
  chmodSync(sshStub, 0o755);
  const result = runBootstrap(fixture.project, installBootstrap(fixture.project), ['prepare', '--offline'], { GIT_SSH: sshStub });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Offline kit prepare cannot find pinned commit/);
  assert.equal(existsSync(callLog), false);
  assert.equal(existsSync(join(fixture.child, 'src/dependencies/submodule.mjs')), false);

  git(modulePath, ['fetch', fixture.source, laterPin]);
  git(modulePath, ['config', 'remote.origin.url', privateUrl]);
  const retry = runBootstrap(fixture.project, installBootstrap(fixture.project), ['prepare', '--offline'], { GIT_SSH: sshStub });
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(existsSync(callLog), false);
  assert.equal(git(fixture.child, ['rev-parse', 'HEAD']).stdout.trim(), laterPin);
  assert.equal(readdirSync(objects).length > 0, true);
});

test('bootstrap offline cold-cache refusal leaves a recovery marker and invokes no remote helper', () => {
  const fixture = runtimeProject();
  const modulePath = git(fixture.project, ['rev-parse', '--git-path', 'modules/vibe-coding-kit']).stdout.trim();
  const absoluteModulePath = modulePath.startsWith('/') ? modulePath : join(fixture.project, modulePath);
  rmSync(absoluteModulePath, { recursive: true, force: true });

  const privateUrl = 'ssh://example.invalid/private/vibe-coding-kit.git';
  git(fixture.project, ['config', '-f', '.gitmodules', 'submodule.vibe-coding-kit.url', privateUrl]);
  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.kit.url = privateUrl;
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const callLog = join(fixture.root, 'ssh-called.txt');
  const sshStub = join(fixture.root, 'ssh-stub');
  writeFileSync(sshStub, `#!/bin/sh\nprintf called >> '${callLog}'\nexit 1\n`);
  chmodSync(sshStub, 0o755);
  const bootstrapPath = installBootstrap(fixture.project);
  const result = runBootstrap(fixture.project, bootstrapPath, ['prepare', '--offline'], { GIT_SSH: sshStub });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registered module cache/);
  assert.equal(existsSync(callLog), false);
  const marker = git(fixture.project, ['rev-parse', '--git-path', 'vibe-coding-kit-bootstrap.json']).stdout.trim();
  const markerPath = marker.startsWith('/') ? marker : join(fixture.project, marker);
  assert.equal(existsSync(markerPath), true);
});
