// platform-gate: posix-only
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { commit } from '../support/submodule-fixture.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { consumerProject, run } from '../support/install-command-harness.mjs';

after(cleanupTempDirs);

test('install rejects a committed symlink at the kit path without touching its target', () => {
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
