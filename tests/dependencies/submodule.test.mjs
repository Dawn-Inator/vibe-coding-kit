import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { assertKitSafeToRemove, checkKit, inspectKit, prepareKit } from '../../src/dependencies/submodule.mjs';
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
  assert.throws(() => prepareKit({ projectRoot: fixture.project, allowNetwork: false }), /submodule update --init --checkout --no-fetch/);
  assert.equal(prepareKit({ projectRoot: fixture.project }).commit, secondCommit);
  assert.equal(git(join(fixture.project, '.vibe-coding/kit'), ['rev-parse', 'HEAD']).stdout.trim(), secondCommit);

  writeFileSync(join(fixture.project, '.vibe-coding/kit', 'ignored.txt'), 'keep me\n');
  assert.throws(() => prepareKit({ projectRoot: fixture.project }), /Refusing to change dirty submodule/);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit/ignored.txt')), true);
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
