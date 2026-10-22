import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { assertKitSafeToRemove, checkKit, inspectKit, prepareKit } from '../../src/dependencies/submodule.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { git, commit, makeProject } from '../support/submodule-fixture.mjs';
after(cleanupTempDirs);

test('inspects and checks an initialized kit against the parent gitlink', () => {
  const fixture = makeProject();
  const result = inspectKit({ projectRoot: fixture.project });
  assert.deepEqual(result, {
    applicable: true,
    path: join(fixture.project, '.vibe-coding/kit'),
    commit: fixture.sourceCommit,
    initialized: true,
  });
  assert.equal(checkKit({ projectRoot: fixture.project }).commit, fixture.sourceCommit);
  assert.equal(assertKitSafeToRemove({ projectRoot: fixture.project }).safeToRemove, true);
});

test('prepare follows the parent index pin and refuses dirty, ignored, and local-ref state', () => {
  const fixture = makeProject();
  writeFileSync(join(fixture.source, 'second.txt'), 'second pin\n');
  const secondCommit = commit(fixture.source, 'source second');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${secondCommit},.vibe-coding/kit`]);
  assert.throws(() => prepareKit({ projectRoot: fixture.project, allowNetwork: false }), /Offline kit prepare cannot find pinned commit/);
  assert.equal(prepareKit({ projectRoot: fixture.project }).commit, secondCommit);
  assert.equal(git(join(fixture.project, '.vibe-coding/kit'), ['rev-parse', 'HEAD']).stdout.trim(), secondCommit);

  writeFileSync(join(fixture.project, '.vibe-coding/kit', 'ignored.txt'), 'keep me\n');
  assert.throws(() => prepareKit({ projectRoot: fixture.project }), /Refusing to change dirty submodule/);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit/ignored.txt')), true);
});

test('offline prepare refuses a cold module cache before invoking any remote helper', () => {
  const fixture = makeProject();
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
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
  const previousSsh = process.env.GIT_SSH;
  process.env.GIT_SSH = sshStub;
  try {
    assert.throws(() => prepareKit({ projectRoot: fixture.project, allowNetwork: false }), /registered module cache/);
  } finally {
    if (previousSsh === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = previousSsh;
  }
  assert.equal(existsSync(callLog), false);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit/.git')), false);
});

test('offline prepare accepts a deinitialized checkout when its pinned commit is cached', () => {
  const fixture = makeProject();
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  const result = prepareKit({ projectRoot: fixture.project, allowNetwork: false });
  assert.equal(result.commit, fixture.sourceCommit);
  assert.equal(result.initialized, true);
});

test('offline prepare passes no-lazy-fetch and no-prompt to the update process', () => {
  const fixture = makeProject();
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  const wrapperDir = join(fixture.root, 'git-wrapper');
  mkdirSync(wrapperDir);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const capture = join(fixture.root, 'git-environment.log');
  const wrapper = join(wrapperDir, 'git');
  writeFileSync(wrapper, '#!/bin/sh\nprintf "%s|%s|%s\\n" "${GIT_TERMINAL_PROMPT-unset}" "${GIT_NO_LAZY_FETCH-unset}" "$*" >> "$GIT_CAPTURE_LOG"\nexec "$REAL_GIT" "$@"\n');
  chmodSync(wrapper, 0o755);
  const script = `import { prepareKit } from ${JSON.stringify(new URL('../../src/dependencies/submodule.mjs', import.meta.url).href)}; prepareKit({ projectRoot: process.env.KIT_ROOT, allowNetwork: false });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KIT_ROOT: fixture.project,
      PATH: [wrapperDir, process.env.PATH].join(delimiter),
      REAL_GIT: realGit,
      GIT_CAPTURE_LOG: capture,
      GIT_TERMINAL_PROMPT: '1',
      GIT_NO_LAZY_FETCH: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const update = readFileSync(capture, 'utf8').split(/\r?\n/).find((line) => line.includes('submodule update --init --checkout --no-fetch'));
  assert.match(update, /^0\|1\|submodule update --init --checkout --no-fetch/);
});

test('offline prepare rejects a pin missing from a warm cache before invoking any remote helper', () => {
  const fixture = makeProject();
  writeFileSync(join(fixture.source, 'later.txt'), 'new commit not cached locally\n');
  const nextPin = commit(fixture.source, 'advance source beyond module cache');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${nextPin},.vibe-coding/kit`]);
  const privateUrl = 'ssh://example.invalid/private/vibe-coding-kit.git';
  git(fixture.project, ['config', '-f', '.gitmodules', 'submodule.vibe-coding-kit.url', privateUrl]);
  const configPath = join(fixture.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.kit.url = privateUrl;
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const child = join(fixture.project, '.vibe-coding/kit');
  git(child, ['remote', 'set-url', 'origin', privateUrl]);
  const beforeHead = git(child, ['rev-parse', 'HEAD']).stdout.trim();
  const callLog = join(fixture.root, 'ssh-called.txt');
  const sshStub = join(fixture.root, 'ssh-stub');
  writeFileSync(sshStub, `#!/bin/sh\nprintf called >> '${callLog}'\nexit 1\n`);
  chmodSync(sshStub, 0o755);
  const previousSsh = process.env.GIT_SSH;
  process.env.GIT_SSH = sshStub;
  try {
    assert.throws(() => prepareKit({ projectRoot: fixture.project, allowNetwork: false }), /cannot find pinned commit/);
  } finally {
    if (previousSsh === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = previousSsh;
  }
  assert.equal(existsSync(callLog), false);
  assert.equal(git(child, ['rev-parse', 'HEAD']).stdout.trim(), beforeHead);
});

test('cleanup proof rejects a kit path whose gitfile points at another worktree', () => {
  const fixture = makeProject();
  const child = join(fixture.project, '.vibe-coding/kit');
  const otherWorktree = join(fixture.root, 'other-kit-worktree');
  git(fixture.source, ['worktree', 'add', '--detach', otherWorktree, fixture.sourceCommit]);
  const otherGitDir = git(otherWorktree, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const otherHead = git(otherWorktree, ['rev-parse', 'HEAD']).stdout.trim();
  const sourceHead = git(fixture.source, ['rev-parse', 'HEAD']).stdout.trim();
  const gitfile = join(child, '.git');
  chmodSync(gitfile, 0o666);
  writeFileSync(gitfile, `gitdir: ${otherGitDir}\n`);
  const otherStatus = git(otherWorktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout;
  const parentStatus = git(fixture.project, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout;

  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /Git directory resolves outside registered module/);
  assert.equal(git(otherWorktree, ['rev-parse', 'HEAD']).stdout.trim(), otherHead);
  assert.equal(git(otherWorktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout, otherStatus);
  assert.equal(git(fixture.source, ['rev-parse', 'HEAD']).stdout.trim(), sourceHead);
  assert.equal(git(fixture.project, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout, parentStatus);
  assert.equal(existsSync(child), true);
});

test('fails closed for a registered but uninitialized kit and for URL/config disagreement', () => {
  const fixture = makeProject();
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  assert.throws(() => checkKit({ projectRoot: fixture.project }), /not initialized/);

  const next = makeProject();
  const configPath = join(next.project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.kit.url = 'https://example.invalid/other.git';
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  assert.throws(() => inspectKit({ projectRoot: next.project }), /Submodule URL mismatch/);

  const missing = makeProject();
  unlinkSync(join(missing.project, '.vibe-coding/project.config.json'));
  assert.throws(() => checkKit({ projectRoot: missing.project }), /Required project config is missing/);
});

test('cleanup proof rejects private remotes and upstreams without changing kit state', () => {
  const fixture = makeProject();
  const child = join(fixture.project, '.vibe-coding/kit');
  git(child, ['remote', 'add', 'private', pathToFileURL(fixture.source).href]);
  git(child, ['fetch', 'private']);
  git(child, ['branch', 'private-tracked']);
  git(child, ['config', 'branch.private-tracked.remote', 'private']);
  git(child, ['config', 'branch.private-tracked.merge', 'refs/heads/main']);
  const beforeHead = git(child, ['rev-parse', 'HEAD']).stdout.trim();
  const beforeStatus = git(child, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout;
  const beforeRefs = git(child, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout;

  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /unapproved remotes/);
  assert.equal(git(child, ['rev-parse', 'HEAD']).stdout.trim(), beforeHead);
  assert.equal(git(child, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout, beforeStatus);
  assert.equal(git(child, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout, beforeRefs);
});

test('cleanup proof rejects a tampered origin URL without changing the kit checkout', () => {
  const fixture = makeProject();
  const child = join(fixture.project, '.vibe-coding/kit');
  git(child, ['remote', 'set-url', 'origin', pathToFileURL(join(fixture.root, 'private.git')).href]);
  const beforeHead = git(child, ['rev-parse', 'HEAD']).stdout.trim();
  const beforeStatus = git(child, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout;
  const beforeRefs = git(child, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout;

  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /origin URL does not match the registered kit URL/);
  assert.equal(git(child, ['rev-parse', 'HEAD']).stdout.trim(), beforeHead);
  assert.equal(git(child, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']).stdout, beforeStatus);
  assert.equal(git(child, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout, beforeRefs);
});

test('path identity resolves aliases without accepting distinct directories', () => {
  const fixture = makeProject();
  const alternateSpelling = process.platform === 'win32' ? fixture.source.toUpperCase() : fixture.source;
  assert.equal(samePathIdentity(fixture.source, alternateSpelling), true);
  assert.equal(samePathIdentity(fixture.source, fixture.project), false);
});

test('old fixtures with no registered kit remain inapplicable without requiring config', () => {
  const project = join(mkdtempTracked('vibe-kit-legacy-test-'), 'legacy');
  mkdirSync(project);
  git(project, ['init', '-q']);
  assert.deepEqual(inspectKit({ projectRoot: project }), {
    applicable: false,
    path: join(project, '.vibe-coding/kit'),
    commit: null,
    initialized: false,
  });
  mkdirSync(join(project, '.vibe-coding'), { recursive: true });
  writeFileSync(join(project, '.vibe-coding/project.config.json'), JSON.stringify({
    schemaVersion: 1,
    kit: { path: '.vibe-coding/kit', url: 'https://example.invalid/kit.git' },
    adapter: 'adapter.mjs',
    identity: { name: 'Fixture User', email: 'fixture@example.invalid' },
  }));
  assert.throws(() => inspectKit({ projectRoot: project }), /no \.vibe-coding\/kit registration/);
});
