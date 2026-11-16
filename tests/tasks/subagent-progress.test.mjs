import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { collectSubagentProgress } from '../../src/tasks/subagent-progress.mjs';
import { createTaskProgressSchemas } from '../../src/tasks/task-contract.mjs';
import { TaskStore, taskMarkdownPaths } from '../../src/tasks/task-store.mjs';
import { TaskSourceRelations } from '../../src/tasks/task-source-relations.mjs';
const schemas = createTaskProgressSchemas(z);
test('direct child checklist is read without writes; other parents and cwd cannot leak', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-'));
  try {
    const store = new TaskStore(root, { schemas });
    await store.initialize('child', { requestId: 'init', expectedRevision: 0, reason: 'Start', title: 'Task', objectives: [{ id: 'a', title: 'A', items: [{ id: 'a1', title: 'Build' }] }] });
    const paths = taskMarkdownPaths(root, 'child');
    const before = await Promise.all([readFile(paths.history), readFile(paths.heartbeat)]);
    const result = await collectSubagentProgress({ parentThreadId: 'parent', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [
      { id: 'child', parentThreadId: 'parent', cwd: root, status: { type: 'notLoaded' } },
      { id: 'other', parentThreadId: 'wrong', cwd: root },
      { id: 'foreign', parentThreadId: 'parent', cwd: '/' },
    ], nextCursor: null }) });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.agents.map(x => x.id), ['child', 'foreign']);
    assert.equal(result.agents[0].state, 'unknown');
    assert.equal(result.agents[0].progressBasis, 'registered-checklist');
    assert.equal(result.agents[1].progress, null);
    assert.equal(result.runningCount, null);
    assert.deepEqual(await Promise.all([readFile(paths.history), readFile(paths.heartbeat)]), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pagination and failures never claim completeness or an authoritative zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-'));
  try {
    let pages = 0;
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [], nextCursor: String(++pages) }) });
    assert.equal(pages, 4); assert.equal(result.truncated, true); assert.equal(result.complete, false); assert.equal(result.runningCount, null);
    const failed = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => { throw new Error('offline'); } });
    assert.equal(failed.status, 'unavailable'); assert.equal(failed.runningCount, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bound sources and oversized histories cannot expose dormant progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-'));
  try {
    const store = new TaskStore(root, { schemas });
    const initialize = id => store.initialize(id, { requestId: `init-${id}`, expectedRevision: 0, reason: 'Start', title: 'Task', objectives: [{ id: 'a', title: 'A' }] });
    await initialize('bound'); await initialize('unresolved'); await initialize('huge');
    await new TaskSourceRelations(root, { schemas }).set('bound', { path: '/tmp/another-source', origin: 'explicit' });
    await new TaskSourceRelations(root, { schemas }).set('huge', null);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(taskMarkdownPaths(root, 'huge').history, 'x'.repeat(1024 * 1024));
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: ['bound', 'unresolved', 'huge'].map(id => ({ id, parentThreadId: 'p', cwd: root })), nextCursor: null }) });
    assert.equal(result.agents[0].progress, null);
    assert.ok(result.agents[1].progress);
    assert.equal(result.agents[2].progress, null);
    assert.equal(result.status, 'partial');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('canonical read accepts a valid lagging head without updating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-prefix-'));
  try {
    const store = new TaskStore(root, { schemas });
    await store.initialize('child', { requestId: 'init', expectedRevision: 0, reason: 'Start', title: 'Task', objectives: [{ id: 'a', title: 'A', items: [{ id: 'a1', title: 'Work' }] }] });
    const paths = taskMarkdownPaths(root, 'child');
    const head = await readFile(paths.heartbeat);
    await store.update('child', { requestId: 'done', expectedRevision: 1, reason: 'Done', changes: [{ targetId: 'a1', status: 'completed', evidence: [{ summary: 'verified', verification: 'verified' }] }] });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.heartbeat, head);
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [{ id: 'child', parentThreadId: 'p', cwd: root }], nextCursor: null }) });
    assert.equal(result.agents[0].progress.percent, 100);
    assert.deepEqual(await readFile(paths.heartbeat), head);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded canonical reader rejects a file that grew after a preliminary size check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-growth-'));
  try {
    const { appendFile, stat, writeFile } = await import('node:fs/promises');
    const { readBoundedText } = await import('../../src/tasks/markdown-records.mjs');
    const path = join(root, 'record');
    await writeFile(path, '1234');
    assert.equal((await stat(path)).size, 4);
    await appendFile(path, '56789');
    await assert.rejects(readBoundedText(path, 8), /exceeds byte limit/);
    assert.equal(await readBoundedText(path, 9), '123456789');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded reads reject a symlinked record and an escaping child directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'subagent-outside-'));
  try {
    const { mkdir, symlink, writeFile } = await import('node:fs/promises');
    const { readBoundedText } = await import('../../src/tasks/markdown-records.mjs');
    const secret = join(outside, 'secret');
    await writeFile(secret, 'outside');
    await symlink(secret, join(root, 'link'));
    await assert.rejects(readBoundedText(join(root, 'link'), 100));
    const store = new TaskStore(root, { schemas });
    const childDir = taskMarkdownPaths(root, 'child').directory;
    await mkdir(join(root, 'tasks', 'v3'), { recursive: true });
    await symlink(outside, childDir);
    await assert.rejects(store.getReadOnly('child'), /escapes storage root/);
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [{ id: 'child', parentThreadId: 'p', cwd: root }], nextCursor: null }) });
    assert.equal(result.status, 'partial');
    assert.equal(result.agents[0].progress, null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('bounded read rejects a FIFO without waiting for a writer', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-fifo-'));
  try {
    const { execFileSync } = await import('node:child_process');
    const { readBoundedText } = await import('../../src/tasks/markdown-records.mjs');
    const path = join(root, 'pipe');
    execFileSync('mkfifo', [path]);
    await assert.rejects(readBoundedText(path, 100), /not a regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('custom readers cannot be used by persistent task loads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-writer-'));
  try {
    const store = new TaskStore(root, { schemas });
    await assert.rejects(store.load('child', { reader: async () => '' }), /cannot authorize writes/);
    const created = await store.initialize('child', { requestId: 'init', expectedRevision: 0, reason: 'Start', title: 'Task', objectives: [{ id: 'a', title: 'A' }] });
    assert.equal(created.state.revision, 1);
    assert.equal((await store.get('child')).revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
