import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { collectSubagentProgress as collectScoped } from '../../src/tasks/subagent-progress.mjs';
import { createTaskProgressSchemas } from '../../src/tasks/task-contract.mjs';
import { TaskStore, taskMarkdownPaths } from '../../src/tasks/task-store.mjs';
import { TaskSourceRelations } from '../../src/tasks/task-source-relations.mjs';
const cycleStartedAt = '2026-01-01T00:00:00.000Z';
const collectSubagentProgress = options => collectScoped({
  ...options, taskCycleId: 'cycle', cycleStartedAt,
  listTurnsPage: async () => ({ data: [{ id: 'turn', rootTurnId: 'turn', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [{ type: 'collabAgentToolCall', senderThreadId: options.parentThreadId, receiverThreadIds: ['child', 'foreign', 'bound', 'unresolved', 'huge'], tool: 'spawnAgent', status: 'completed', startedAtMs: Date.parse(cycleStartedAt) + 1000 }] }], nextCursor: null }),
  listPage: async cursor => { const page = await options.listPage(cursor); return { ...page, data: page.data.map(child => ({ ...child, source: { subAgent: { thread_spawn: { parent_thread_id: child.parentThreadId } } } })) }; },
});
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
    await new TaskStore(outside, { schemas }).initialize('child', { requestId: 'outside', expectedRevision: 0, reason: 'Start', title: 'Outside', objectives: [{ id: 'a', title: 'A' }] });
    await symlink(taskMarkdownPaths(outside, 'child').directory, childDir);
    await assert.rejects(store.getReadOnly('child'), /escapes storage root/);
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [{ id: 'child', parentThreadId: 'p', cwd: root }], nextCursor: null }) });
    assert.equal(result.status, 'partial');
    assert.equal(result.agents[0].progress, null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('bounded read rejects a non-regular file without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-fifo-'));
  try {
    const { constants } = await import('node:fs');
    const { open, writeFile } = await import('node:fs/promises');
    const { readBoundedText } = await import('../../src/tasks/markdown-records.mjs');
    const path = join(root, 'pipe');
    await writeFile(path, 'placeholder');
    // A FIFO is simulated through the injected open: the handle reports a non-regular file, so the rejection and
    // the non-blocking, no-follow open flags are asserted identically on every host.
    let flags;
    const openAsFifo = async (target, openFlags) => {
      flags = openFlags;
      const handle = await open(target, openFlags);
      return new Proxy(handle, {
        get: (object, name) => name === 'stat'
          ? async () => ({ isFile: () => false })
          : (typeof object[name] === 'function' ? object[name].bind(object) : object[name]),
      });
    };
    await assert.rejects(readBoundedText(path, 100, { open: openAsFifo }), /not a regular file/);
    const nonBlocking = constants.O_NONBLOCK ?? 0;
    const noFollow = constants.O_NOFOLLOW ?? 0;
    assert.equal(flags & nonBlocking, nonBlocking, 'opens without waiting for a writer');
    assert.equal(flags & noFollow, noFollow, 'refuses to follow links');
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


test('directory swap around every record open rejects a valid outside task before reading bytes', async () => {
  for (const target of ['taskhistory.md', 'heartbeat.md', 'events.jsonl']) {
    const root = await mkdtemp(join(tmpdir(), 'subagent-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'subagent-race-outside-'));
    try {
      const { rename, symlink, unlink, writeFile } = await import('node:fs/promises');
      const local = new TaskStore(root, { schemas });
      const external = new TaskStore(outside, { schemas });
      const init = (store, title) => store.initialize('child', { requestId: `init-${title}`, expectedRevision: 0, reason: 'Start', title, objectives: [{ id: 'a', title: 'A' }] });
      await init(local, 'inside'); await init(external, 'outside');
      const dir = taskMarkdownPaths(root, 'child').directory;
      const outsideDir = taskMarkdownPaths(outside, 'child').directory;
      await writeFile(join(outsideDir, 'events.jsonl'), '');
      const saved = `${dir}.saved`;
      let swapped = false; let restored = false;
      await assert.rejects(local.getReadOnly('child', {
        beforeOpen: async path => {
          if (path.endsWith(target) && !swapped) { await rename(dir, saved); await symlink(outsideDir, dir); swapped = true; }
        },
        afterOpen: async () => {
          if (swapped && !restored) { await unlink(dir); await rename(saved, dir); restored = true; }
        },
      }), /changed during open/);
      assert.equal(swapped, true, target); assert.equal(restored, true, target);
      assert.equal((await local.getReadOnly('child')).state.title, 'inside');
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  }
});

test('root alias changes after open fail closed before reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-root-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'subagent-root-outside-'));
  const saved = `${root}.saved`;
  let moved = false;
  try {
    const { rename, symlink, unlink, writeFile } = await import('node:fs/promises');
    const { readBoundedText } = await import('../../src/tasks/markdown-records.mjs');
    await writeFile(join(root, 'record'), 'inside');
    await assert.rejects(readBoundedText(join(root, 'record'), 100, { trustedRoot: root, afterOpen: async () => {
      await rename(root, saved); moved = true; await symlink(outside, root);
    } }), /storage root changed/);
    await unlink(root); await rename(saved, root); moved = false;
  } finally { if (moved) { await rm(root, { force: true }); await (await import('node:fs/promises')).rename(saved, root); } await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test('cycle membership uses accepted parent dispatch and fails closed when evidence is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-cycle-'));
  try {
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'cycle', cycleStartedAt,
      listPage: async () => ({ data: ['old', 'new', 'failed', 'wrong'].map(id => ({ id, cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } } })), nextCursor: null }) };
    const missing = await collectScoped(base);
    assert.equal(missing.status, 'unavailable'); assert.deepEqual(missing.agents, []); assert.equal(missing.runningCount, null);
    const dispatch = (id, tool, status = 'completed', senderThreadId = 'p') => ({ type: 'collabAgentToolCall', senderThreadId, receiverThreadIds: [id], tool, status });
    const result = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [{ id: 'turn', rootTurnId: 'turn', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [dispatch('old', 'followupTask'), dispatch('new', 'spawnAgent'), dispatch('new', 'sendInput'), dispatch('failed', 'spawnAgent', 'failed'), dispatch('wrong', 'spawnAgent', 'completed', 'other')] }], nextCursor: null }) });
    assert.deepEqual(result.agents.map(x => x.id), ['old', 'new']);
    assert.equal(result.complete, true); assert.equal(result.scopeBasis, 'parent-root-turn'); assert.equal(result.runningCount, null);
    const summary = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [{ id: 'turn', rootTurnId: 'turn', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'summary', items: [] }], nextCursor: null }) });
    assert.equal(summary.complete, false); assert.deepEqual(summary.agents, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('full current root scopes live child and a missing child leaves membership partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-live-'));
  try {
    const turn = { id: 'root', rootTurnId: 'root', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [
      { type: 'subAgentActivity', agentThreadId: 'live', kind: 'started' },
      { type: 'subAgentActivity', agentThreadId: 'absent', kind: 'interacted' },
    ] };
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [turn], nextCursor: null }),
      listPage: async () => ({ data: [{ id: 'live', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'active', activeFlags: [] } }], nextCursor: null }),
    });
    assert.equal(result.scopeBasis, 'parent-root-turn'); assert.equal(result.rootTurnId, 'root');
    assert.equal(result.agents[0].state, 'working'); assert.equal(result.complete, false); assert.equal(result.status, 'partial');
    assert.equal(result.runningCount, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('different older root stops bounded turn pagination and does not mix agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-root-boundary-'));
  try {
    let pages = 0;
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => { pages++; return { data: [
        { id: 'new', rootTurnId: 'new', startedAt: Date.parse(cycleStartedAt) / 1000 + 2, itemsView: 'full', items: [] },
        { id: 'old', rootTurnId: 'old', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'old-child', kind: 'started' }] },
      ], nextCursor: 'older' }; },
      listPage: async () => { throw new Error('should not list historical children'); },
    });
    assert.equal(pages, 1); assert.equal(result.complete, false); assert.deepEqual(result.agents, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('child inventory stops once all current members have been resolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-found-'));
  try {
    let pages = 0;
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [{ id: 'turn', rootTurnId: 'turn', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'live', kind: 'started' }] }], nextCursor: null }),
      listPage: async () => { pages++; return { data: [{ id: 'live', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'notLoaded' } }], nextCursor: 'historic' }; },
    });
    assert.equal(pages, 1); assert.equal(result.complete, true); assert.equal(result.truncated, false); assert.equal(result.agents[0].state, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid newest turn never falls back to an older root or historical child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-newest-invalid-'));
  try {
    const startedAt = Date.parse(cycleStartedAt) / 1000 + 1;
    const older = { id: 'older', rootTurnId: 'older', startedAt, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'historic', kind: 'started' }] };
    const child = { id: 'historic', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'active', activeFlags: [] } };
    for (const latest of [
      { id: 'latest', startedAt, itemsView: 'full', items: [] },
      { id: 'latest', rootTurnId: 'latest', itemsView: 'full', items: [] },
      null,
      { id: '', rootTurnId: 'latest', startedAt, itemsView: 'full', items: [] },
    ]) {
      let childReads = 0;
      const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
        listTurnsPage: async () => ({ data: [latest, older], nextCursor: null }),
        listPage: async () => { childReads++; return { data: [child], nextCursor: null }; },
      });
      assert.equal(result.status, 'unavailable'); assert.equal(result.scopeBasis, 'unknown');
      assert.equal(result.complete, false); assert.deepEqual(result.agents, []); assert.equal(childReads, 0);
    }
    let pages = 0;
    const emptyFirst = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ++pages === 1 ? { data: [], nextCursor: 'older' } : { data: [older], nextCursor: null },
      listPage: async () => ({ data: [child], nextCursor: null }),
    });
    assert.equal(pages, 1); assert.equal(emptyFirst.scopeBasis, 'unknown'); assert.deepEqual(emptyFirst.agents, []);
    const valid = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [older], nextCursor: null }),
      listPage: async () => ({ data: [child], nextCursor: null }),
    });
    assert.equal(valid.scopeBasis, 'parent-root-turn'); assert.deepEqual(valid.agents.map(agent => agent.id), ['historic']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('child progress must belong to latest precise dispatch; reused completed work is hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-dispatch-progress-'));
  try {
    const store = new TaskStore(root, { schemas });
    await store.initialize('child', { requestId: 'init', expectedRevision: 0, reason: 'Start', title: 'Work', objectives: [{ id: 'a', title: 'A', items: [{ id: 'a1', title: 'Do' }] }] });
    await store.update('child', { requestId: 'done', expectedRevision: 1, reason: 'Done', changes: [{ targetId: 'a1', status: 'completed', evidence: [{ summary: 'verified', verification: 'verified' }] }] });
    const childState = await store.get('child');
    const childStart = Date.parse(childState.createdAt);
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listPage: async () => ({ data: [{ id: 'child', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'notLoaded' } }], nextCursor: null }) };
    const dispatch = (tool, startedAtMs) => ({ type: 'collabAgentToolCall', senderThreadId: 'p', receiverThreadIds: ['child'], status: 'completed', tool, ...(startedAtMs == null ? {} : { startedAtMs }) });
    const collect = items => collectScoped({ ...base, listTurnsPage: async () => ({ data: [{ id: 'root', rootTurnId: 'root', startedAt: Math.floor(childStart / 1000), itemsView: 'full', items }], nextCursor: null }) });
    const fresh = await collect([dispatch('spawnAgent', childStart - 1)]);
    assert.equal(fresh.agents[0].progress.percent, 100);
    const reused = await collect([dispatch('spawnAgent', childStart - 1), { type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed' }, dispatch('followupTask', childStart + 1000)]);
    assert.equal(reused.agents[0].progress, null); assert.equal(reused.agents[0].state, 'unknown');
    const untimed = await collect([dispatch('spawnAgent', childStart - 1), dispatch('sendInput', null)]);
    assert.equal(untimed.agents[0].progress, null);
    const interacted = await collect([dispatch('spawnAgent', childStart - 1), { type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed' }, { type: 'subAgentActivity', agentThreadId: 'child', kind: 'interacted' }]);
    assert.equal(interacted.agents[0].state, 'unknown'); assert.equal(interacted.agents[0].progress, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('root start is the root turn start, never a later continuation start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-root-start-'));
  try {
    const start = Date.parse(cycleStartedAt) / 1000;
    const latest = { id: 'continuation', rootTurnId: 'root', startedAt: start + 60, itemsView: 'full', items: [] };
    const rootTurn = { id: 'root', rootTurnId: 'root', startedAt: start + 1, itemsView: 'full', items: [] };
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt, listPage: async () => ({ data: [], nextCursor: null }) };
    const full = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [latest, rootTurn], nextCursor: null }) });
    assert.equal(full.rootTurnStartedAt, new Date((start + 1) * 1000).toISOString());
    const missing = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [latest], nextCursor: null }) });
    assert.equal(missing.scopeBasis, 'parent-root-turn'); assert.equal(missing.rootTurnStartedAt, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('later continuation dispatch supersedes root completion across descending pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-turn-order-'));
  try {
    const start = Date.parse(cycleStartedAt) / 1000;
    let page = 0;
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ++page === 1 ? { data: [{ id: 'next', rootTurnId: 'root', startedAt: start + 2, itemsView: 'full', items: [{ type: 'collabAgentToolCall', senderThreadId: 'p', receiverThreadIds: ['child'], tool: 'followupTask', status: 'completed' }] }], nextCursor: 'older' } : { data: [{ id: 'root', rootTurnId: 'root', startedAt: start + 1, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed' }] }], nextCursor: null },
      listPage: async () => ({ data: [{ id: 'child', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'notLoaded' } }], nextCursor: null }),
    });
    assert.equal(result.agents[0].state, 'unknown'); assert.equal(result.rootTurnStartedAt, new Date((start + 1) * 1000).toISOString());
  } finally { await rm(root, { recursive: true, force: true }); }
});
