// worktree-guard/writable-tree.test.mjs
//
// Coverage for writable-tree.mjs: a sealed (0555) tree left by a killed test run must become
// removable, without the walk ever leaving the candidate or widening group/other bits. Run with:
//   node --test writable-tree.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

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

test('sealed directories inside the candidate get u+rwx back, group/other bits are not widened', { skip: process.platform === 'win32' && 'Windows uses ACLs, not POSIX mode bits' }, () => {
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

test('directories owned by another uid are never touched', { skip: process.platform === 'win32' && 'Windows uses ACLs, not POSIX ownership' }, () => {
  const { candidate, outside } = sealedTree();
  const result = makeOwnedTreeWritable(candidate, { uid: -12345 });
  assert.equal(result.chmodded, 0);
  assert.ok(result.foreign >= 1);
  assert.equal(mode(join(candidate, 'snapshot')), 0o555);
  for (const dir of [join(candidate, 'snapshot', 'deep'), join(candidate, 'snapshot'), outside]) chmodSync(dir, 0o755);
});

test('a symlinked root is refused outright and a missing root is a no-op', { skip: process.platform === 'win32' && 'POSIX symlink ownership and chmod semantics do not apply to Windows ACLs' }, () => {
  const { root, candidate, outside } = sealedTree();
  const linkRoot = join(root, 'link-root');
  symlinkSync(candidate, linkRoot);
  assert.deepEqual(makeOwnedTreeWritable(linkRoot), { chmodded: 0, foreign: 0, symlinks: 1, errors: 0 });
  assert.equal(mode(join(candidate, 'snapshot')), 0o555);
  assert.deepEqual(makeOwnedTreeWritable(join(root, 'missing')), { chmodded: 0, foreign: 0, symlinks: 0, errors: 0 });
  for (const dir of [join(candidate, 'snapshot', 'deep'), join(candidate, 'snapshot'), outside]) chmodSync(dir, 0o755);
});

test('Windows leaves ACL authorization to the OS instead of fabricating POSIX ownership or mode changes', { skip: process.platform !== 'win32' && 'Windows ACL behavior' }, () => {
  const root = mkdtempTracked('wtg-windows-acl-');
  mkdirSync(join(root, 'candidate', 'nested'), { recursive: true });
  const result = makeOwnedTreeWritable(join(root, 'candidate'), { uid: 0 });
  assert.deepEqual(result, { chmodded: 0, foreign: 0, symlinks: 0, errors: 0, aclProtected: true });
});

test('class guard: every worktree removal in the kit makes the tree writable first', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['reclaim-stale.mjs', 'cli.mjs']) {
    const source = readFileSync(new URL(`../../src/worktrees/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/git\(\['worktree', 'remove', (?!'--force')/g)) {
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      assert.match(before, /makeOwnedTreeWritable\(/, `${file}: a plain worktree removal without makeOwnedTreeWritable first`);
    }
  }
});
