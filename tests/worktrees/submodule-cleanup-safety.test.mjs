import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { assertKitSafeToRemove } from '../../src/dependencies/submodule.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);

test('cleanup proof accepts only a clean child at the committed parent pin', () => {
  const fixture = makeProject();
  assert.equal(assertKitSafeToRemove({ projectRoot: fixture.project }).safeToRemove, true);

  writeFileSync(join(fixture.project, '.vibe-coding/kit/ignored.txt'), 'preserve local file\n');
  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /Refusing to change dirty submodule/);
  assert.equal(git(fixture.project, ['-C', '.vibe-coding/kit', 'status', '--porcelain=v1', '--ignored=matching']).stdout.includes('ignored.txt'), true);
});

test('cleanup proof rejects staged gitlink changes and local-only child refs', () => {
  const fixture = makeProject();
  writeFileSync(join(fixture.source, 'second.txt'), 'new object\n');
  const nextPin = commit(fixture.source, 'new source commit');
  git(fixture.project, ['update-index', '--cacheinfo', `160000,${nextPin},.vibe-coding/kit`]);
  assert.throws(() => assertKitSafeToRemove({ projectRoot: fixture.project }), /parent HEAD and index do not agree/);

  const second = makeProject();
  const child = join(second.project, '.vibe-coding/kit');
  git(child, ['branch', 'private-local-work']);
  assert.throws(() => assertKitSafeToRemove({ projectRoot: second.project }), /local (?:branch|ref)/);
});
