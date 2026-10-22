import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, loadConfig, syncPrimarySettings } from '../../src/worktrees/config.mjs';

test('loadConfig: no args returns DEFAULT_CONFIG content (not necessarily same reference)', () => {
  const result = loadConfig();
  assert.deepEqual(result, DEFAULT_CONFIG);
});

test('loadConfig: override file replaces a top-level key entirely, leaves the rest default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-config-'));
  try {
    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({
      identity: { name: 'X', email: 'y@z' },
    }));

    const result = loadConfig(overridePath);
    assert.deepEqual(result.identity, { name: 'X', email: 'y@z' });

    // Everything else stays at the default.
    assert.equal(result.defaultTool, DEFAULT_CONFIG.defaultTool);
    assert.deepEqual(result.tools, DEFAULT_CONFIG.tools);
    assert.equal(result.maxWorktrees, DEFAULT_CONFIG.maxWorktrees);
    assert.deepEqual(result.massDeletion, DEFAULT_CONFIG.massDeletion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: an explicit missing override file fails closed', () => {
  assert.throws(() => loadConfig('/nonexistent/path/does-not-exist.json'), /does not exist/);
});

test('loadConfig: falls back to env.WTG_CONFIG_PATH when overridePath is omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-config-env-'));
  try {
    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ defaultTool: 'codex' }));

    const result = loadConfig(undefined, { WTG_CONFIG_PATH: overridePath });
    assert.equal(result.defaultTool, 'codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: mutating the returned object does not affect DEFAULT_CONFIG', () => {
  const result = loadConfig();
  result.identity.name = 'Mutated';
  assert.notEqual(DEFAULT_CONFIG.identity.name, 'Mutated');
});

test('DEFAULT_CONFIG: keys read by the primary write guard, finish, node-deps and reclaim have documented defaults', () => {
  assert.deepEqual(DEFAULT_CONFIG.primaryWriteGuard, { allowPrefixes: ['.workspace/'] });
  assert.deepEqual(DEFAULT_CONFIG.sharedHistoryRefs, ['refs/remotes/origin/main']);
  assert.deepEqual(DEFAULT_CONFIG.nodeDeps, {
    lockfile: '',
    stampFile: 'node_modules/.worktree-guard-lockfile-stamp',
    installCommand: '',
  });
  assert.deepEqual(DEFAULT_CONFIG.reclaim, { activeRecentHours: 2, lockHoldSeconds: 20, patchIdBudgetSeconds: 120 });
  assert.equal(DEFAULT_CONFIG.queue.maxHoldMs, 10 * 60 * 1000);
});

test('DEFAULT_CONFIG: node-deps is OFF by default (empty lockfile) so adopting projects opt in', () => {
  assert.equal(DEFAULT_CONFIG.nodeDeps.lockfile, '');
});

test('loadConfig: the new keys survive a load, are deep-cloned, and an override replaces a key as a whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-config-newkeys-'));
  try {
    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({
      primaryWriteGuard: { allowPrefixes: ['.scratch/'] },
      sharedHistoryRefs: ['refs/remotes/origin/main', 'refs/remotes/origin/release'],
      nodeDeps: { lockfile: 'package-lock.json' },
    }));
    const result = loadConfig(overridePath);
    assert.deepEqual(result.primaryWriteGuard.allowPrefixes, ['.scratch/']);
    assert.equal(result.sharedHistoryRefs.length, 2);
    assert.deepEqual(result.nodeDeps, { lockfile: 'package-lock.json' }, 'shallow merge: the whole key is replaced');
    assert.deepEqual(result.reclaim, DEFAULT_CONFIG.reclaim, 'untouched keys keep their defaults');

    const fresh = loadConfig();
    fresh.primaryWriteGuard.allowPrefixes.push('mutated/');
    fresh.sharedHistoryRefs.push('mutated');
    fresh.reclaim.activeRecentHours = 99;
    assert.deepEqual(DEFAULT_CONFIG.primaryWriteGuard.allowPrefixes, ['.workspace/']);
    assert.deepEqual(DEFAULT_CONFIG.sharedHistoryRefs, ['refs/remotes/origin/main']);
    assert.equal(DEFAULT_CONFIG.reclaim.activeRecentHours, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_CONFIG.tools: detectEnv lists are non-empty arrays (they double as AI-parent env markers)', () => {
  for (const [id, tool] of Object.entries(DEFAULT_CONFIG.tools)) {
    assert.ok(Array.isArray(tool.detectEnv) && tool.detectEnv.length > 0, id);
  }
});

test('DEFAULT_CONFIG.syncPrimary: idle self-authorization is on by default with a 10 minute window', () => {
  assert.deepEqual(DEFAULT_CONFIG.syncPrimary, { idleSelfAuthorize: true, idleMinutes: 10 });
});

test('syncPrimarySettings: each key falls back on its own after a partial override replaces the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-config-sp-'));
  try {
    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ syncPrimary: { idleMinutes: 3 } }));
    const loaded = loadConfig(overridePath, {});
    // loadConfig replaced the whole key, so the other field is absent here ...
    assert.deepEqual(loaded.syncPrimary, { idleMinutes: 3 });
    // ... and the reader restores its default.
    assert.deepEqual(syncPrimarySettings(loaded), { idleSelfAuthorize: true, idleMinutes: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncPrimarySettings: only an explicit false disables the scan; bad minutes use the default', () => {
  assert.equal(syncPrimarySettings({ syncPrimary: { idleSelfAuthorize: false } }).idleSelfAuthorize, false);
  assert.equal(syncPrimarySettings({ syncPrimary: { idleSelfAuthorize: 0 } }).idleSelfAuthorize, true);
  assert.equal(syncPrimarySettings({}).idleSelfAuthorize, true);
  assert.equal(syncPrimarySettings(undefined).idleMinutes, 10);
  for (const bad of [-1, 'ten', null, NaN]) {
    assert.equal(syncPrimarySettings({ syncPrimary: { idleMinutes: bad } }).idleMinutes, 10);
  }
  assert.equal(syncPrimarySettings({ syncPrimary: { idleMinutes: 0 } }).idleMinutes, 0);
});
