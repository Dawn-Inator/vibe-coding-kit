// worktree-guard/writable-tree.test.mjs
//
// Coverage for writable-tree.mjs: a sealed (0555) tree left by a killed test run must become
// removable, without the walk ever leaving the candidate or widening group/other bits. Run with:
//   node --test writable-tree.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { makeOwnedTreeWritable } from '../../src/worktrees/writable-tree.mjs';

after(cleanupTempDirs);


test('Windows leaves ACL authorization to the OS instead of fabricating POSIX ownership or mode changes', () => {
  const root = mkdtempTracked('wtg-windows-acl-');
  mkdirSync(join(root, 'candidate', 'nested'), { recursive: true });
  const result = makeOwnedTreeWritable(join(root, 'candidate'), { uid: 0, platform: 'win32' });
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
