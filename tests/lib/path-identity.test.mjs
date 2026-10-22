import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPathWithin } from '../../src/lib/path-identity.mjs';

test('path containment includes the root and accepts missing descendants', () => {
  const parent = mkdtempSync(join(tmpdir(), 'vibe-path-identity-'));
  try {
    const root = join(parent, 'root');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'file.txt'), 'fixture\n');
    writeFileSync(join(root, 'plain-file'), 'fixture\n');
    assert.equal(isPathWithin(root, root), true);
    assert.equal(isPathWithin(root, join(root, 'nested', 'file.txt')), true);
    assert.equal(isPathWithin(root, join(root, 'future', 'deep', 'file.txt')), true);
    assert.equal(isPathWithin(root, join(root, 'plain-file', 'child')), false);
    assert.equal(isPathWithin(root, join(parent, 'sibling', 'file.txt')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('path containment follows aliases but rejects symlink escapes and unknown roots', () => {
  const parent = mkdtempSync(join(tmpdir(), 'vibe-path-identity-'));
  try {
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const alias = process.platform === 'win32' ? root.toUpperCase() : join(root, '.');
    assert.equal(isPathWithin(root, join(alias, 'missing.txt')), true);

    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(isPathWithin(root, join(root, 'escape', 'not-created.txt')), false);
    assert.equal(isPathWithin(join(parent, 'missing-root'), join(parent, 'missing-root', 'file')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
