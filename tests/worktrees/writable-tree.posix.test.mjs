// platform-gate: posix-only
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { makeOwnedTreeWritable } from '../../src/worktrees/writable-tree.mjs';

after(cleanupTempDirs);

const mode = (path) => statSync(path).mode & 0o777;

function sealedTree() {
  const root = mkdtempTracked('wtg-writable-');
  const candidate = join(root, 'candidate');
  const outside = join(root, 'outside');
  mkdirSync(join(candidate, 'snapshot', 'deep'), { recursive: true });
  writeFileSync(join(candidate, 'snapshot', 'deep', 'file.txt'), 'x\n');
  chmodSync(join(candidate, 'snapshot', 'deep', 'file.txt'), 0o444);
  mkdirSync(outside);
  symlinkSync(outside, join(candidate, 'snapshot', 'link-out'));
  for (const dir of [join(candidate, 'snapshot', 'deep'), join(candidate, 'snapshot'), outside]) chmodSync(dir, 0o555);
  return { root, candidate, outside };
}

test('sealed directories inside the candidate get u+rwx back, group/other bits are not widened', () => {
  const { candidate, outside } = sealedTree();
  const result = makeOwnedTreeWritable(candidate);
  assert.equal(mode(join(candidate, 'snapshot')), 0o755);
  assert.equal(mode(join(candidate, 'snapshot', 'deep')), 0o755);
  assert.equal(mode(join(candidate, 'snapshot', 'deep', 'file.txt')), 0o444, 'files are left alone');
  assert.equal(result.chmodded, 2);
  assert.equal(mode(outside), 0o555, 'a symlink target outside the candidate is never touched');
  assert.equal(result.symlinks, 1);
  chmodSync(outside, 0o755);
});

test('directories owned by another uid are never touched', () => {
  const { candidate, outside } = sealedTree();
  const result = makeOwnedTreeWritable(candidate, { uid: -12345 });
  assert.equal(result.chmodded, 0);
  assert.ok(result.foreign >= 1);
  assert.equal(mode(join(candidate, 'snapshot')), 0o555);
  for (const dir of [join(candidate, 'snapshot', 'deep'), join(candidate, 'snapshot'), outside]) chmodSync(dir, 0o755);
});

test('a symlinked root is refused outright and a missing root is a no-op', () => {
  const { root, candidate, outside } = sealedTree();
  const linkRoot = join(root, 'link-root');
  symlinkSync(candidate, linkRoot);
  assert.deepEqual(makeOwnedTreeWritable(linkRoot), { chmodded: 0, foreign: 0, symlinks: 1, errors: 0 });
  assert.equal(mode(join(candidate, 'snapshot')), 0o555);
  assert.deepEqual(makeOwnedTreeWritable(join(root, 'missing')), { chmodded: 0, foreign: 0, symlinks: 0, errors: 0 });
  for (const dir of [join(candidate, 'snapshot', 'deep'), join(candidate, 'snapshot'), outside]) chmodSync(dir, 0o755);
});
