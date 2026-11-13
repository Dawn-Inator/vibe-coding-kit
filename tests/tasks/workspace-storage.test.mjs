import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createTaskProgressSchemas } from '../../src/tasks/task-contract.mjs';
import { TaskStore, TaskStoreError, taskMarkdownPaths } from '../../src/tasks/task-store.mjs';
import { WorkspaceTaskStorage } from '../../src/tasks/workspace-storage.mjs';
import { writeMarkdownRecords } from '../../src/tasks/markdown-records.mjs';

const schemas = createTaskProgressSchemas(z);
const roots = [];
const managers = [];
const digest = (value) => createHash('sha256').update(value).digest('hex');
test.afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(resolve(tmpdir(), 'kit-task-workspace-'));
  roots.push(root);
  const cwd = resolve(root, 'project');
  const next = resolve(root, 'next-project');
  await mkdir(cwd, { recursive: true });
  await mkdir(next, { recursive: true });
  const app = resolve(root, 'app');
  return { root, cwd, next, app };
}
function manager(app, resolveContract) {
  const value = new WorkspaceTaskStorage(app, { schemas, ...(resolveContract ? { resolveContract } : {}) });
  managers.push(value);
  return value;
}
function initialize(store, threadId, title = 'Task') {
  return store.initialize(threadId, {
    requestId: `initialize-${title}`,
    expectedRevision: 0,
    reason: 'Requested',
    title,
    objectives: [{ id: 'A', title: 'Build' }],
  });
}
const hasCode = (code) => (error) => error instanceof TaskStoreError && error.code === code;

test('legacy task history imports into canonical Markdown paths and leaves source intact', async () => {
  const { cwd, app } = await setup();
  const legacy = new TaskStore(app, { schemas });
  await initialize(legacy, 'thread', 'Migrated');
  const original = await readFile(taskMarkdownPaths(app, 'thread').history, 'utf8');
  const context = await manager(app).forThread('thread', cwd);
  assert.equal(context.storage.cwd, await realpath(cwd));
  assert.equal(context.storage.migrated, true);
  assert.equal(context.storage.source, app);
  assert.equal(context.storage.heartbeatPath, taskMarkdownPaths(context.storage.root, 'thread').heartbeat);
  assert.equal(context.storage.taskhistoryPath, taskMarkdownPaths(context.storage.root, 'thread').history);
  assert.equal(context.cacheRoot, resolve(await realpath(cwd), '.tmp/codex-task-progress', digest('thread')));
  assert.match(await readFile(context.storage.taskhistoryPath, 'utf8'), /task-records-v1/);
  assert.equal(await readFile(taskMarkdownPaths(app, 'thread').history, 'utf8'), original);
  assert.equal((await context.taskStore.get('thread'))?.revision, 1);
  assert.equal(await readFile(resolve(context.storage.root, '.gitignore'), 'utf8'), '*\n');
  assert.equal((await stat(context.storage.root)).mode & 0o777, 0o700);
});

test('empty read leaves project workspace uncreated and routing stores in app-owned Markdown', async () => {
  const { cwd, app } = await setup();
  const context = await manager(app).forThread('empty', cwd);
  assert.equal(await context.taskStore.get('empty'), null);
  await assert.rejects(stat(resolve(cwd, '.workspace')), (error) => error.code === 'ENOENT');
  const routePath = resolve(app, 'task-routing/taskhistory.md');
  assert.match(await readFile(routePath, 'utf8'), /task-records-v1/);
  await context.ensureWritable();
  await initialize(context.taskStore, 'empty');
  assert.equal((await context.taskStore.get('empty'))?.revision, 1);
});

test('two projects and two chats stay isolated; a cwd move copies only task history', async () => {
  const { cwd, next, app } = await setup();
  const router = manager(app);
  const a = await router.forThread('chat-a', cwd);
  const b = await router.forThread('chat-b', next);
  await a.ensureWritable(); await b.ensureWritable();
  await initialize(a.taskStore, 'chat-a', 'A');
  await initialize(b.taskStore, 'chat-b', 'B');
  assert.equal(await a.taskStore.get('chat-b'), null);
  assert.equal(await b.taskStore.get('chat-a'), null);
  const paths = taskMarkdownPaths(a.storage.root, 'chat-a');
  await writeFile(paths.heartbeat, '# old heartbeat association\n');
  const moved = await router.forThread('chat-a', next);
  assert.equal((await moved.taskStore.get('chat-a'))?.title, 'A');
  assert.equal(moved.storage.source, a.storage.root);
  assert.deepEqual(moved.legacyHeartbeatRoots, []);
  assert.equal(await readFile(paths.heartbeat, 'utf8'), '# old heartbeat association\n');
  assert.notEqual(a.storage.taskDirectory, b.storage.taskDirectory);
});

test('routing survives restart and cache deletion without reimporting stale legacy history', async () => {
  const { cwd, app } = await setup();
  const legacy = new TaskStore(app, { schemas });
  await initialize(legacy, 'thread', 'Original');
  const first = manager(app);
  const context = await first.forThread('thread', cwd);
  await context.taskStore.rescope('thread', {
    requestId: 'advance', expectedRevision: 1, reason: 'Expanded',
    objectives: [{ id: 'A', title: 'Build' }, { id: 'B', title: 'Ship' }],
  });
  first.close();
  await rm(context.cacheRoot, { recursive: true, force: true });
  const resumed = await manager(app).forThread('thread', cwd);
  assert.equal(resumed.storage.migrated, false);
  assert.equal((await resumed.taskStore.get('thread'))?.revision, 2);
  assert.equal((await legacy.get('thread'))?.revision, 1);
});

test('legacy index is imported read-only and new workspace conflicts fail closed', async () => {
  const { cwd, next, app } = await setup();
  const oldRoot = resolve(next, '.workspace/codex-task-progress');
  const legacy = new TaskStore(oldRoot, { schemas });
  await initialize(legacy, 'thread', 'Legacy');
  const indexPath = resolve(app, 'workspace-storage-index.json');
  await mkdir(app, { recursive: true });
  const index = { schemaVersion: 1, entries: { [digest('thread')]: { threadId: 'thread', cwd: next, root: oldRoot } } };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const indexBefore = await readFile(indexPath, 'utf8');
  const workspace = resolve(cwd, '.workspace/codex-task-progress');
  const destination = new TaskStore(workspace, { schemas });
  await initialize(destination, 'thread', 'Diverged');
  await assert.rejects(manager(app).forThread('thread', cwd), hasCode('TASK_HISTORY_CONFLICT'));
  assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
  assert.equal((await legacy.get('thread'))?.title, 'Legacy');
});

test('unavailable, relative, and blocked workspaces fail without global fallback writes', async () => {
  const { cwd, app } = await setup();
  const router = manager(app);
  await assert.rejects(router.forThread('thread', 'relative'), hasCode('TASK_WORKSPACE_INVALID'));
  await assert.rejects(router.forThread('thread', resolve(cwd, 'missing')), hasCode('TASK_WORKSPACE_INVALID'));
  await writeFile(resolve(cwd, '.workspace'), 'blocked');
  await assert.rejects(router.forThread('thread', cwd), hasCode('TASK_WORKSPACE_UNWRITABLE'));
  assert.equal(await new TaskStore(app, { schemas }).get('thread'), null);
  await assert.rejects(stat(resolve(app, 'task-routing/taskhistory.md')), (error) => error.code === 'ENOENT');
});

test('concurrent same-thread resolution is idempotent and validates resolver roots', async () => {
  const { cwd, app } = await setup();
  const router = manager(app);
  const [a, b] = await Promise.all([router.forThread('same', cwd), router.forThread('same', cwd)]);
  assert.strictEqual(a, b);
  const invalid = manager(app, async () => ({ source: 'untrusted', contract: { schemaVersion: 2, mode: 'workspace', cwd, workspaceRoot: cwd, storageRoot: app, cacheRoot: app } }));
  await assert.rejects(invalid.forThread('other', cwd), hasCode('TASK_STORAGE_CONTRACT_INVALID'));
});

test('recovery detects completed ordinary history and legacy events without writing', async () => {
  const { root, app } = await setup();
  const store = new TaskStore(app, { schemas });
  await initialize(store, 'completed');
  await store.update('completed', { requestId: 'done', expectedRevision: 1, reason: 'Finished', changes: [{ targetId: 'A', status: 'completed', evidence: [{ summary: 'Verified', verification: 'verified' }] }] });
  const paths = store.paths('completed');
  const before = await readFile(paths.history, 'utf8');
  const heartbeat = await readFile(paths.heartbeat, 'utf8');
  assert.equal(await manager(app).hasRecoverableTasks(), true);
  assert.equal(await readFile(paths.history, 'utf8'), before);
  assert.equal(await readFile(paths.heartbeat, 'utf8'), heartbeat);
  await assert.rejects(stat(resolve(root, 'project/.workspace')), { code: 'ENOENT' });
  const events = (await store.load('completed', { persist: false })).events;
  await rm(paths.history); await rm(paths.heartbeat);
  await writeFile(paths.legacyEvents, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  assert.equal(await manager(app).hasRecoverableTasks(), true);
  await assert.rejects(stat(paths.history), { code: 'ENOENT' });
  await assert.rejects(stat(paths.heartbeat), { code: 'ENOENT' });
});

test('recovery follows valid routes and legacy indexes, rejecting corrupt and unrelated paths', async () => {
  const { cwd, next, app } = await setup();
  const router = manager(app);
  assert.equal(await router.hasRecoverableTasks(), false);
  const context = await router.forThread('routed', cwd);
  assert.equal(await router.hasRecoverableTasks(), false);
  await context.ensureWritable();
  await initialize(context.taskStore, 'routed');
  assert.equal(await manager(app).hasRecoverableTasks(), true);
  const routePath = resolve(app, 'task-routing/taskhistory.md');
  const route = await readFile(routePath, 'utf8');
  await writeFile(routePath, route.replace(context.storage.root, resolve(next, '.workspace/codex-task-progress')));
  assert.equal(await manager(app).hasRecoverableTasks(), false);
  await writeFile(routePath, 'corrupt');
  const indexPath = resolve(app, 'workspace-storage-index.json');
  const entry = { threadId: 'routed', cwd: context.storage.cwd, root: context.storage.root };
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, entries: { [digest('routed')]: entry } }));
  const indexBefore = await readFile(indexPath, 'utf8');
  assert.equal(await manager(app).hasRecoverableTasks(), true);
  assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
  entry.root = resolve(next, '.workspace/codex-task-progress');
  await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, entries: { [digest('routed')]: entry } }));
  assert.equal(await manager(app).hasRecoverableTasks(), false);
});


test('recovery accepts a source association but rejects corrupt task records', async () => {
  const { app } = await setup();
  const paths = taskMarkdownPaths(app, 'source-only');
  await mkdir(paths.directory, { recursive: true });
  await writeMarkdownRecords(paths.history, { kind: 'task-progress', identity: 'source-only', records: [{ type: 'source-binding', binding: { path: '/trusted/source', origin: 'explicit' } }] });
  assert.equal(await manager(app).hasRecoverableTasks(), true);
  await writeMarkdownRecords(paths.history, { kind: 'task-progress', identity: 'source-only', records: [{ type: 'source-binding', binding: { path: 'relative', origin: 'explicit' } }] });
  assert.equal(await manager(app).hasRecoverableTasks(), false);
});


test('recovery rejects mismatched app directory hashes and duplicate managed payloads', async () => {
  const { app } = await setup();
  const paths = taskMarkdownPaths(app, 'directory-id');
  await mkdir(paths.directory, { recursive: true });
  await writeMarkdownRecords(paths.history, { kind: 'task-progress', identity: 'different-id', records: [{ type: 'source-binding', binding: { path: '/source', origin: 'explicit' } }] });
  assert.equal(await manager(app).hasRecoverableTasks(), false);
  await writeMarkdownRecords(paths.history, { kind: 'task-progress', identity: 'directory-id', records: [{ type: 'source-binding', binding: { path: '/source', origin: 'explicit' } }] });
  const valid = await readFile(paths.history, 'utf8');
  await writeFile(paths.history, `${valid}\n${valid}`);
  assert.equal(await manager(app).hasRecoverableTasks(), false);
});
