import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  resolveTaskProgressStorage,
  TASK_PROGRESS_STORAGE_DIRECTORY,
  TASK_PROGRESS_STORAGE_SCHEMA_VERSION,
} from '../../src/contracts/task-progress-storage.mjs';

test('task progress storage uses the trusted cwd workspace with a frozen versioned result', () => {
  const cwd = resolve(tmpdir(), 'task-progress-contract', 'nested', '..', 'project');
  const result = resolveTaskProgressStorage({ cwd });
  assert.deepEqual(result, {
    schemaVersion: 1,
    mode: 'workspace',
    cwd,
    workspaceRoot: resolve(cwd, '.workspace'),
    storageRoot: resolve(cwd, '.workspace', 'codex-task-progress'),
  });
  assert.equal(TASK_PROGRESS_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(TASK_PROGRESS_STORAGE_DIRECTORY, 'codex-task-progress');
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.storageRoot = 'another-path'; }, TypeError);
});

test('nested directories and separate worktrees do not collapse into a parent workspace', () => {
  const project = resolve(tmpdir(), 'task-progress-contract');
  const nested = resolveTaskProgressStorage({ cwd: resolve(project, 'packages', 'api') });
  const worktree = resolveTaskProgressStorage({ cwd: resolve(project, 'worktree-b') });
  assert.equal(nested.storageRoot, resolve(project, 'packages/api/.workspace/codex-task-progress'));
  assert.equal(worktree.storageRoot, resolve(project, 'worktree-b/.workspace/codex-task-progress'));
  assert.notEqual(nested.storageRoot, worktree.storageRoot);
});

test('invalid cwd values are rejected rather than falling back to the helper process cwd', () => {
  for (const cwd of [undefined, null, '', '  ', 'relative/project', 42, {}]) {
    assert.throws(() => resolveTaskProgressStorage({ cwd }), TypeError);
  }
  assert.throws(() => resolveTaskProgressStorage(), TypeError);
});

test('path resolution accepts spaces and Unicode without creating files or directories', () => {
  const cwd = resolve(tmpdir(), `task-progress-no-io-${process.pid}-${Date.now()}`, '项目 with spaces');
  assert.equal(existsSync(cwd), false);
  const result = resolveTaskProgressStorage({ cwd });
  assert.equal(result.storageRoot, resolve(cwd, '.workspace', 'codex-task-progress'));
  assert.equal(existsSync(cwd), false);
});
