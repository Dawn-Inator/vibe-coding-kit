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
    assert.deepEqual(result.agents.map(x => x.id), ['child']);
    assert.equal(result.agents[0].state, 'unknown');
    assert.equal(result.agents[0].progressBasis, 'registered-checklist');
    assert.equal(result.runningCount, null);
    assert.deepEqual(await Promise.all([readFile(paths.history), readFile(paths.heartbeat)]), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pagination and failures never claim completeness or an authoritative zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-'));
  try {
    let pages = 0;
    const result = await collectSubagentProgress({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, listPage: async () => ({ data: [], nextCursor: String(++pages) }) });
    assert.equal(pages, 4); assert.equal(result.truncated, false); assert.equal(result.complete, false); assert.equal(result.runningCount, null);
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
    assert.equal(result.complete, false); assert.equal(result.scopeBasis, 'parent-root-turn'); assert.equal(result.runningCount, null);
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
      listPage: async () => ({ data: [], nextCursor: null }),
    });
    // The current root was fully observed before the older root: this is a
    // successful scope boundary, while older members remain excluded.
    assert.equal(pages, 1); assert.equal(result.complete, true); assert.deepEqual(result.agents, []);
    assert.equal(result.runningCount, 0); assert.equal(result.runningBasis, 'runtime');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repeated catalog cursors and duplicate identities exclude ambiguous members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-found-'));
  try {
    let pages = 0;
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [{ id: 'turn', rootTurnId: 'turn', startedAt: Date.parse(cycleStartedAt) / 1000 + 1, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'live', kind: 'started' }] }], nextCursor: null }),
      listPage: async () => { pages++; return { data: [{ id: 'live', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'notLoaded' } }], nextCursor: 'historic' }; },
    });
    assert.equal(pages, 2); assert.equal(result.complete, false); assert.equal(result.status, 'partial'); assert.equal(result.runningCount, null); assert.equal(result.observedRunningCount, null); assert.deepEqual(result.agents, []);
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

test('source scope uses the verified latest parent root and fences reused checklist progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-source-scope-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const canonicalRoot = await realpath(root), source = join(canonicalRoot, 'heartbeat.md');
    const store = new TaskStore(root, { schemas });
    await store.initialize('current', { requestId: 'init', expectedRevision: 0, reason: 'Start', title: 'Work', objectives: [{ id: 'a', title: 'A', items: [{ id: 'a1', title: 'Do' }] }] });
    await store.update('current', { requestId: 'done', expectedRevision: 1, reason: 'Done', changes: [{ targetId: 'a1', status: 'completed', evidence: [{ summary: 'verified', verification: 'verified' }] }] });
    const childStart = Date.parse((await store.get('current')).createdAt);
    const start = Math.floor(childStart / 1000) - 60;
    const dispatch = at => ({ type: 'collabAgentToolCall', senderThreadId: 'p', receiverThreadIds: ['current'], tool: 'followupTask', status: 'completed', startedAtMs: at });
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskSourcePath: source,
      listPage: async () => ({ data: ['historic', 'current'].map(id => ({ id, cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'notLoaded' } })), nextCursor: null }) };
    const collect = (items, itemsView = 'full', taskSourcePath = source) => collectScoped({ ...base, taskSourcePath,
      listTurnsPage: async () => ({ data: [
        { id: 'continuation', rootTurnId: 'root', startedAt: start + 2, itemsView, items },
        { id: 'root', rootTurnId: 'root', startedAt: start, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'current', kind: 'completed' }] },
      ], nextCursor: null }),
    });
    const fresh = await collect([dispatch(childStart - 1)]);
    assert.equal(fresh.taskCycleId, null); assert.equal(fresh.taskSourcePath, source);
    assert.equal(fresh.scopeBasis, 'parent-root-turn'); assert.equal(fresh.rootTurnStartedAt, new Date(start * 1000).toISOString());
    assert.deepEqual(fresh.agents.map(agent => agent.id), ['current']);
    assert.equal(fresh.agents[0].state, 'unknown'); assert.equal(fresh.agents[0].progress.percent, 100);
    assert.equal(fresh.runningCount, null); assert.equal(fresh.runningBasis, 'unknown');
    const reused = await collect([dispatch(childStart + 1000)]);
    assert.equal(reused.agents[0].progress, null); assert.equal(reused.agents[0].state, 'unknown');
    const partial = await collect([dispatch(childStart - 1)], 'summary');
    assert.equal(partial.complete, false); assert.equal(partial.status, 'partial');
    const other = join(canonicalRoot, 'other.md');
    assert.equal((await collect([dispatch(childStart - 1)], 'full', other)).taskSourcePath, other);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source scope fails closed for missing or ambiguous root metadata and malformed scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-source-invalid-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const source = join(await realpath(root), 'heartbeat.md'), start = 1767225600;
    const latest = { id: 'continuation', rootTurnId: 'root', startedAt: start + 2, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'historic', kind: 'started' }] };
    let childReads = 0;
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskSourcePath: source,
      listPage: async () => { childReads++; return { data: [], nextCursor: null }; } };
    for (const data of [
      [latest],
      [{ ...latest, rootTurnId: '' }],
      [latest, { id: 'root', rootTurnId: 'root', itemsView: 'full', items: [] }],
      [latest, { id: 'root', rootTurnId: 'root', startedAt: start + 3, itemsView: 'full', items: [] }],
    ]) {
      const result = await collectScoped({ ...base, listTurnsPage: async () => ({ data, nextCursor: null }) });
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.agents, []); assert.equal(result.runningCount, null);
    }
    for (const scope of [
      { taskSourcePath: 'relative/path' }, { taskSourcePath: '/tmp/../tmp/path' },
      { taskSourcePath: source, taskCycleId: 'cycle' }, { taskSourcePath: source, cycleStartedAt },
      { taskSourcePath: source, taskCycleId: 'cycle', cycleStartedAt },
    ]) {
      const result = await collectScoped({ ...base, ...scope, listTurnsPage: async () => { throw new Error('invalid scope must not query'); } });
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.agents, []);
    }
    assert.equal(childReads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('running count is exact only for complete verified roots with known runtime states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-running-count-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const source = join(await realpath(root), 'heartbeat.md'), start = Date.parse(cycleStartedAt) / 1000;
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskSourcePath: source };
    const activity = id => ({ type: 'subAgentActivity', agentThreadId: id, kind: id === 'done' ? 'completed' : 'started' });
    const child = (id, status) => ({ id, cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status });
    const collect = (items, children, itemsView = 'full', rootTurnId = 'root') => collectScoped({ ...base,
      listTurnsPage: async () => ({ data: [{ id: 'root', rootTurnId, startedAt: start + 1, itemsView, items }], nextCursor: null }),
      listPage: async () => ({ data: children, nextCursor: null }),
    });
    const items = ['active', 'waiting', 'idle', 'done'].map(activity);
    const children = [child('active', { type: 'active', activeFlags: [] }), child('waiting', { type: 'active', activeFlags: ['waitingOnUserInput'] }), child('idle', { type: 'idle' }), child('done', { type: 'idle' })];
    const exact = await collect(items, children);
    assert.equal(exact.complete, true); assert.equal(exact.runningCount, 1); assert.equal(exact.runningBasis, 'runtime');
    assert.deepEqual(exact.agents.map(agent => agent.state), ['working', 'waiting', 'idle', 'completed']);
    const empty = await collect([], []);
    assert.equal(empty.complete, true); assert.equal(empty.runningCount, 0); assert.equal(empty.runningBasis, 'runtime');
    const unknown = await collect(items, [child('active', { type: 'notLoaded' }), ...children.slice(1)]);
    assert.equal(unknown.complete, false); assert.equal(unknown.status, 'partial'); assert.equal(unknown.runningCount, null); assert.equal(unknown.runningBasis, 'unknown');
    const unloadedDone = await collect(items, [...children.slice(0, 3), child('done', { type: 'notLoaded' })]);
    assert.equal(unloadedDone.runningCount, null);
    const partial = await collect(items, children, 'summary');
    assert.equal(partial.complete, false); assert.equal(partial.runningCount, null);
    const missing = await collect(items, children.slice(0, 3));
    assert.equal(missing.complete, false); assert.equal(missing.runningCount, null);
    const noRoot = await collect(items, children, 'full', 'missing-root');
    assert.equal(noRoot.status, 'unavailable'); assert.equal(noRoot.runningCount, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('source scope stops cleanly at an older root only after seeing the current root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-source-boundary-'));
  try {
    const { realpath } = await import('node:fs/promises');
    const source = join(await realpath(root), 'heartbeat.md'), start = Date.parse(cycleStartedAt) / 1000;
    const previous = { id: 'previous', rootTurnId: 'previous', startedAt: start, itemsView: 'full', items: [{ type: 'subAgentActivity', agentThreadId: 'historic', kind: 'started' }] };
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskSourcePath: source,
      listPage: async () => ({ data: [], nextCursor: null }) };
    const complete = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [{ id: 'current', rootTurnId: 'current', startedAt: start + 1, itemsView: 'full', items: [] }, previous], nextCursor: 'older' }) });
    assert.equal(complete.complete, true); assert.equal(complete.status, 'ready');
    assert.deepEqual(complete.agents, []); assert.equal(complete.runningCount, 0);
    const unseen = await collectScoped({ ...base, listTurnsPage: async () => ({ data: [{ id: 'continuation', rootTurnId: 'unseen', startedAt: start + 2, itemsView: 'full', items: [] }, previous], nextCursor: null }) });
    assert.equal(unseen.status, 'unavailable'); assert.equal(unseen.complete, false);
    assert.deepEqual(unseen.agents, []); assert.equal(unseen.runningCount, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified current children preserve exact agent paths and recorded state provenance', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-assignment-'));
 try {
  const started = Date.parse(cycleStartedAt);
  let active = 0, peak = 0;
  const result = await collectScoped({parentThreadId:'p', cwd:root, storageRoot:root, schemas, taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[
    {type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a','b','c'],tool:'spawnAgent',status:'completed',startedAtMs:started},
    {type:'subAgentActivity',agentThreadId:'a',agentPath:'/root/a',kind:'started',startedAtMs:started},
    {type:'subAgentActivity',agentThreadId:'c',agentPath:'/root/conflict',kind:'started',startedAtMs:started},
   ]}],nextCursor:null}),
   listPage:async()=>({data:['a','b','c'].map(id=>({id,cwd:root,status:{type:id==='b'?'active':'notLoaded',...(id==='b'?{activeFlags:[]}:{})},source:{subAgent:{thread_spawn:{parent_thread_id:'p',agent_path:`/root/${id}`}}}})),nextCursor:null}),
   observeAgent:async id=>{ active++; peak=Math.max(peak,active); await Promise.resolve(); active--; return {state:id==='a'?'working':'completed',basis:'codex-rollout',observedAt:new Date(started+2000).toISOString(),eventTurnId:'child-turn',rootTurnId:'r',complete:true,readStable:true}; },
  });
  assert.ok(peak<=2);
  assert.equal(result.status,'ready');
  assert.equal(result.runningCount,null, 'persisted observations never become a live exact count');
  assert.equal(result.observedRunningCount,2);
  assert.equal(result.observedRunningComplete,true);
  assert.equal(result.observedRunningBasis,'mixed');
  assert.deepEqual(result.agents.map(a=>[a.id,a.state,a.stateBasis,a.agentPath??null]), [['a','working','codex-rollout','/root/a'],['b','working','runtime','/root/b'],['c','completed','codex-rollout',null]]);
  assert.ok(result.agents.every(a=>a.assignmentEligible));
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('incomplete membership reports a recorded lower bound without inventing live zero', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-observed-partial-'));
 try {
  const started = Date.parse(cycleStartedAt);
  const options = {parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'partial',items:[{type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a','missing'],tool:'spawnAgent',status:'completed',startedAtMs:started}]}],nextCursor:null}),
   listPage:async()=>({data:[{id:'a',cwd:root,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null})};
  const observed = await collectScoped({...options,observeAgent:async()=>({state:'working',basis:'codex-rollout',observedAt:new Date(started+1000).toISOString(),eventTurnId:'child-turn',rootTurnId:'r',complete:true,readStable:true})});
  assert.equal(observed.status,'partial'); assert.equal(observed.runningCount,null);
  assert.equal(observed.observedRunningCount,1); assert.equal(observed.observedRunningComplete,false); assert.equal(observed.observedRunningBasis,'codex-rollout');
  const unknown = await collectScoped(options);
  assert.equal(unknown.runningCount,null); assert.equal(unknown.observedRunningCount,null);
  assert.equal(unknown.observedRunningBasis,'unknown'); assert.equal(unknown.observedRunningComplete,false);
 } finally { await rm(root,{recursive:true,force:true}); }
});


test('older rollout state cannot survive a later followup or parent interaction', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-rollout-stale-'));
 try {
  const started=Date.parse(cycleStartedAt);
  for (const newer of [
   {type:'subAgentActivity',agentThreadId:'a',kind:'interacted',startedAtMs:started+3000},
   {type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a'],tool:'followupTask',status:'completed',startedAtMs:started+3000},
   {type:'subAgentActivity',agentThreadId:'a',kind:'interacted'},
  ]) {
   const result = await collectScoped({parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
    listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[
     {type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a'],tool:'spawnAgent',status:'completed',startedAtMs:started+1000},
     {type:'subAgentActivity',agentThreadId:'a',kind:'completed',startedAtMs:started+2000},newer
    ]}],nextCursor:null}),
    listPage:async()=>({data:[{id:'a',cwd:root,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null}),
    observeAgent:async()=>({state:'completed',basis:'codex-rollout',observedAt:new Date(started+2000).toISOString(),eventTurnId:'child-turn',rootTurnId:'r',complete:true,readStable:true})
   });
   assert.equal(result.agents[0].state,'unknown');
   assert.equal(result.agents[0].stateBasis,'unknown');
   assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,null);
  }
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('catalog candidates require same parent, project and exact current root before joining a partial run', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-root-proof-'));
 try {
  const started=Date.parse(cycleStartedAt); let active=0, peak=0;
  const child=(id,parent='p',cwd=root)=>({id,cwd,status:{type:'active',activeFlags:[]},source:{subAgent:{thread_spawn:{parent_thread_id:parent}}}});
  const result = await collectScoped({parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'root-now',rootTurnId:'root-now',startedAt:started/1000,itemsView:'partial',items:[]}],nextCursor:null}),
   listPage:async()=>({data:[child('current'),child('old'),child('foreign','other'),child('outside','p','/')],nextCursor:null}),
   verifyAgent:async id=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return {parentThreadId:'p',cwd:root,rootTurnId:id==='old'?'root-old':'root-now',turnStartedAt:new Date(started+1000).toISOString()};}
  });
  assert.ok(peak<=2); assert.equal(result.status,'partial'); assert.equal(result.complete,false);
  assert.deepEqual(result.agents.map(a=>a.id),['current']);
  assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,1); assert.equal(result.observedRunningComplete,false);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('unverified direct candidates prevent an authoritative empty running count', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-unverified-catalog-'));
 try {
  const started = Date.parse(cycleStartedAt);
  const base = { parentThreadId:'p', cwd:root, storageRoot:root, schemas, taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[]}],nextCursor:null}),
   listPage:async()=>({data:[{id:'candidate',cwd:root,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null}) };
  for (const verifyAgent of [async()=>null, async()=>{throw new Error('offline');}, async()=>({parentThreadId:'p',cwd:root,rootTurnId:'old-root',turnStartedAt:cycleStartedAt}), async()=>({parentThreadId:'p',cwd:root,rootTurnId:'r',turnStartedAt:'invalid'})]) {
   const result = await collectScoped({...base,verifyAgent});
   assert.equal(result.status,'partial'); assert.equal(result.complete,false);
   assert.deepEqual(result.agents,[]); assert.equal(result.runningCount,null);
   assert.equal(result.observedRunningCount,null); assert.equal(result.observedRunningComplete,false);
  }
  const empty = await collectScoped({...base,listPage:async()=>({data:[],nextCursor:null}),verifyAgent:async()=>null});
  assert.equal(empty.status,'ready'); assert.equal(empty.complete,true);
  assert.equal(empty.runningCount,0); assert.equal(empty.runningBasis,'runtime');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('complete running counts require an examined catalog with resolved direct-child identities', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-catalog-matrix-'));
 try {
  const canonical = await (await import('node:fs/promises')).realpath(root);
  const started = Date.parse(cycleStartedAt);
  const child = (extra={}) => ({id:'candidate',cwd:canonical,status:{type:'active',activeFlags:[]},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}},...extra});
  const base = {parentThreadId:'p',cwd:canonical,storageRoot:canonical,schemas,taskSourcePath:join(canonical,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[]}],nextCursor:null})};
  const goodProof = async()=>({parentThreadId:'p',cwd:canonical,rootTurnId:'r',turnStartedAt:new Date(started+1000).toISOString()});
  const invalidRows = [null, 1, [], {}, child({id:''}), child({id:' '}), child({id:'x'.repeat(257)}), child({source:null}), child({source:{subAgent:{}}}), child({source:{subAgent:{thread_spawn:{}}}}), child({source:{subAgent:{thread_spawn:'wrong'}}}), child({parentThreadId:'foreign'}),
   ...[' foreign', 'foreign ', 'foreign\nother', `other${String.fromCharCode(127)}`, 'x'.repeat(257)].flatMap(parent => [
    child({source:{subAgent:{thread_spawn:{parent_thread_id:parent}}}}),
    child({parentThreadId:parent,source:{subAgent:{thread_spawn:{parent_thread_id:parent}}}}),
   ]),
   child({cwd:undefined}), child({cwd:'relative/path'}), child({cwd:join(canonical,'missing')})];
  for (const row of invalidRows) for (const verifier of [undefined,goodProof]) {
   const result=await collectScoped({...base,listPage:async()=>({data:[row],nextCursor:null}),...(verifier ? {verifyAgent:verifier} : {})});
   assert.equal(result.complete,false,JSON.stringify(row)); assert.notEqual(result.status,'ready');
   assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,null);
  }
  for (const verifyAgent of [undefined,async()=>null,async()=>{throw new Error('unavailable');},async()=>({parentThreadId:'p',cwd:canonical,rootTurnId:'old',turnStartedAt:cycleStartedAt})]) {
   const result=await collectScoped({...base,listPage:async()=>({data:[child()],nextCursor:null}),...(verifyAgent ? {verifyAgent} : {})});
   assert.equal(result.complete,false); assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,null);
  }
  for (const mode of ['repeat','truncated','malformed-cursor']) for (const verifier of [undefined,goodProof]) {
   let pages=0;
   const result=await collectScoped({...base,listPage:async()=>({data:[],nextCursor:mode==='malformed-cursor'?undefined:mode==='repeat'?'same':String(++pages)}),...(verifier ? {verifyAgent:verifier} : {})});
   assert.equal(result.complete,false,mode); assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,null);
  }
  const empty=await collectScoped({...base,listPage:async()=>({data:[],nextCursor:null})});
  assert.equal(empty.complete,true); assert.equal(empty.runningCount,0);
  const foreign=child({parentThreadId:'other',source:{subAgent:{thread_spawn:{parent_thread_id:'other'}}}});
  assert.equal((await collectScoped({...base,listPage:async()=>({data:[foreign],nextCursor:null})})).runningCount,0);
  const verified=await collectScoped({...base,listPage:async()=>({data:[child()],nextCursor:null}),verifyAgent:goodProof});
  assert.equal(verified.complete,true); assert.equal(verified.runningCount,1);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('unknown or contradictory runtime states cannot certify an exact count', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-unknown-states-'));
 try {
  const started=Date.parse(cycleStartedAt);
  const options={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'subAgentActivity',agentThreadId:'a',kind:'started',startedAtMs:started}]}],nextCursor:null})};
  for (const status of [undefined,{type:'notLoaded'},{type:'future'},{type:'active',activeFlags:['futureFlag']},{type:'active',activeFlags:'wrong'},{type:'idle',activeFlags:['waitingOnUserInput']}]) {
   const result=await collectScoped({...options,listPage:async()=>({data:[{id:'a',cwd:root,status,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null})});
   assert.equal(result.status,'partial'); assert.equal(result.complete,false); assert.equal(result.runningCount,null);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});

test('only stable exact-turn rollout proof can retain recorded work across a later interaction', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-rollout-proof-'));
 try {
  const started=Date.parse(cycleStartedAt);
  const options={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a'],tool:'spawnAgent',status:'completed',startedAtMs:started+1000},{type:'subAgentActivity',agentThreadId:'a',kind:'interacted',startedAtMs:started+3000}]}],nextCursor:null}),
   listPage:async()=>({data:[{id:'a',cwd:root,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null})};
  const proof={state:'working',basis:'codex-rollout',observedAt:new Date(started+2000).toISOString(),eventTurnId:'child-turn',rootTurnId:'r',complete:true,readStable:true};
  const working=await collectScoped({...options,observeAgent:async()=>proof});
  assert.equal(working.agents[0].state,'working'); assert.equal(working.agents[0].stateBasis,'codex-rollout');
  assert.equal(working.agents[0].progress,null); assert.equal(working.runningCount,null);
  for (const invalid of [{...proof,readStable:false},{...proof,complete:false},{...proof,eventTurnId:null},{...proof,rootTurnId:'other'}, {...proof,state:'completed'}, {...proof,state:'idle'}]) {
   const result=await collectScoped({...options,observeAgent:async()=>invalid});
   assert.equal(result.agents[0].state,'unknown'); assert.equal(result.runningCount,null);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});


test('causal membership never promotes rejected or ambiguous catalog rows into state, progress or counts', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-causal-admission-'));
 try {
  const canonical = await (await import('node:fs/promises')).realpath(root);
  const started = Date.parse(cycleStartedAt);
  const valid = (status={type:'active',activeFlags:[]}) => ({id:'candidate',cwd:canonical,status,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}});
  const options = {parentThreadId:'p',cwd:canonical,storageRoot:canonical,schemas,taskSourcePath:join(canonical,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'subAgentActivity',agentThreadId:'candidate',kind:'started',startedAtMs:started}]}],nextCursor:null})};
  for (const status of [{type:'active',activeFlags:[]},{type:'notLoaded'}]) {
   const row=valid(status);
   const cases=[
    [{...row,cwd:undefined}],
    [{...row,cwd:join(canonical,'missing')}],
    [{...row,cwd:'/'}],
    [{...row,source:null}],
    [{...row,source:{subAgent:{thread_spawn:{parent_thread_id:'other'}}}}],
    [{...row,parentThreadId:'other'}],
    [row,{...row}],
    [row,{...row,source:null}],
   ];
   for (const entries of cases) {
    let observed=0;
    const result=await collectScoped({...options,listPage:async()=>({data:entries,nextCursor:null}),
     observeAgent:async()=>{observed++;return {state:'working',basis:'codex-rollout',observedAt:new Date(started+1000).toISOString(),eventTurnId:'turn',rootTurnId:'r',complete:true,readStable:true};}});
    assert.equal(result.status,'partial'); assert.equal(result.complete,false);
    assert.deepEqual(result.agents,[]); assert.equal(result.runningCount,null);
    assert.equal(result.observedRunningCount,null); assert.equal(observed,0);
   }
  }
  const validResult=await collectScoped({...options,listPage:async()=>({data:[valid()],nextCursor:null})});
  assert.equal(validResult.status,'ready'); assert.equal(validResult.runningCount,1);
  assert.deepEqual(validResult.agents.map(a=>a.id),['candidate']);
  const empty=await collectScoped({...options,listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[]}],nextCursor:null}),listPage:async()=>({data:[],nextCursor:null})});
  assert.equal(empty.status,'ready'); assert.equal(empty.runningCount,0);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('incremental catalog exhausts history and distinguishes verified older roots from unknown scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-catalog-sweep-'));
  try {
    const started = Date.parse(cycleStartedAt) + 1000;
    const children = Array.from({ length: 251 }, (_, index) => ({
      id: `child-${index}`, cwd: root, updatedAt: 1,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } },
      status: { type: index === 250 ? 'active' : 'idle', activeFlags: [] },
    }));
    let nowMs = started + 10_000;
    let calls = 0;
    const base = {
      parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      now: () => new Date(nowMs),
      listTurnsPage: async () => ({ data: [{ id: 'r', rootTurnId: 'r', startedAt: started / 1000, itemsView: 'partial', items: [] }], nextCursor: null }),
      listPage: async cursor => { calls++; const offset = cursor ? Number(cursor) : 0; return { data: children.slice(offset, offset + 50), nextCursor: offset + 50 < children.length ? String(offset + 50) : null }; },
      verifyAgent: async id => ({ verdict: ['child-50','child-250'].includes(id) ? 'in-scope' : 'out-of-scope', parentThreadId: 'p', cwd: root, rootTurnId: ['child-50','child-250'].includes(id) ? 'r' : 'old', turnStartedAt: new Date(started + 1000).toISOString() }),
    };
    const first = await collectScoped(base);
    assert.equal(calls, 4); assert.equal(first.complete, false); assert.equal(first.runningCount, null);
    let result;
    for (let attempt = 0; attempt < 5; attempt++) { nowMs += 1000; result = await collectScoped(base); if (result.observedRunningComplete) break; }
    assert.equal(result.complete, true);
    assert.deepEqual(result.agents.map(agent => agent.id), ['child-50', 'child-250']);
    assert.equal(Date.parse(result.observedAt), Math.min(...result.agents.map(agent => Date.parse(agent.observedAt))));
    assert.equal(result.observedRunningCount, 1);
    assert.equal(result.observedRunningComplete, true);
    assert.ok(['runtime', 'recorded-runtime', 'mixed'].includes(result.observedRunningBasis));
    assert.ok(calls < 20, 'resume pages rather than restart the full catalog on each poll');
    children[250].updatedAt = 2;
    children[250].status = { type: 'idle', activeFlags: [] };
    for (let attempt = 0; attempt < 8; attempt++) { nowMs += 1000; result = await collectScoped(base); if (result.observedRunningComplete && result.observedRunningCount === 0) break; }
    assert.equal(result.observedRunningCount, 0);
    assert.equal(result.observedRunningComplete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unresolved root proof and changed scope cannot reuse an exact observed count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-catalog-unknown-'));
  try {
    const started = Date.parse(cycleStartedAt) + 1000;
    const base = { parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [{ id: 'r', rootTurnId: 'r', startedAt: started / 1000, itemsView: 'partial', items: [] }], nextCursor: null }),
      listPage: async () => ({ data: [{ id: 'child', cwd: root, updatedAt: 1, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'active', activeFlags: [] } }], nextCursor: null }),
      verifyAgent: async () => ({ verdict: 'unknown' }),
    };
    const result = await collectScoped(base);
    assert.equal(result.complete, false); assert.equal(result.runningCount, null);
    assert.equal(result.observedRunningCount, null); assert.equal(result.observedRunningComplete, false);
    assert.deepEqual(result.agents, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('catalog completion rechecks the head and rejects a concurrent arrival', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-final-head-'));
  try {
    const started = Date.parse(cycleStartedAt) + 1000;
    const child = { id: 'new', cwd: root, source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } }, status: { type: 'active', activeFlags: [] } };
    let reads = 0;
    const result = await collectScoped({ parentThreadId: 'p', cwd: root, storageRoot: root, schemas, taskCycleId: 'c', cycleStartedAt,
      listTurnsPage: async () => ({ data: [{ id: 'r', rootTurnId: 'r', startedAt: started / 1000, itemsView: 'full', items: [] }], nextCursor: null }),
      listPage: async () => ({ data: ++reads === 1 ? [] : [child], nextCursor: null }),
    });
    assert.equal(reads, 2);
    assert.equal(result.complete, false); assert.equal(result.runningCount, null);
    assert.equal(result.observedRunningCount, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified latest child terminal turn counts only after the latest parent interaction', async () => {
 const root = await mkdtemp(join(tmpdir(), 'subagent-terminal-turn-'));
 try {
  const started = Date.parse(cycleStartedAt);
  const options = { parentThreadId:'p', cwd:root, storageRoot:root, schemas, taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'collabAgentToolCall',senderThreadId:'p',receiverThreadIds:['a'],tool:'spawnAgent',status:'completed',startedAtMs:started+1000},{type:'subAgentActivity',agentThreadId:'a',kind:'interacted',startedAtMs:started+3000}]}],nextCursor:null}),
   listPage:async()=>({data:[{id:'a',cwd:root,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null}) };
  const proof = {basis:'codex-turn',state:'completed',observedAt:new Date(started+4000).toISOString(),eventTurnId:'latest',rootTurnId:'r',complete:true,latestTurnVerified:true};
  for (const state of ['completed','failed','idle']) {
   const result=await collectScoped({...options,observeAgent:async()=>({...proof,state})});
   assert.equal(result.agents[0].state,state); assert.equal(result.agents[0].stateBasis,'codex-turn');
   assert.equal(result.runningCount,null); assert.equal(result.observedRunningCount,0); assert.equal(result.observedRunningComplete,true); assert.equal(result.observedRunningBasis,'codex-turn');
  }
  for (const invalid of [{...proof,observedAt:new Date(started+2000).toISOString()},{...proof,observedAt:null},{...proof,eventTurnId:null},{...proof,rootTurnId:'old'},{...proof,complete:false},{...proof,latestTurnVerified:false},{...proof,state:'working'}]) {
   const result=await collectScoped({...options,observeAgent:async()=>invalid});
   assert.equal(result.agents[0].state,'unknown'); assert.equal(result.observedRunningComplete,false); assert.equal(result.runningCount,null);
  }
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('catalog sweep expires after inactivity rather than while actively refreshed', async () => {
 const { readIncrementalAgentCatalog } = await import('../../src/tasks/agent-catalog-cache.mjs');
 let time = Date.parse(cycleStartedAt), calls = [];
 const rows = Array.from({length:251}, (_,i)=>({id:`row-${i}`}));
 const listPage = async cursor => { calls.push(cursor ?? 'head'); const offset = cursor ? Number(cursor) : 0; return {data:rows.slice(offset,offset+50),nextCursor:offset+50<rows.length?String(offset+50):null}; };
 const read = () => readIncrementalAgentCatalog({key:`ttl-${cycleStartedAt}`,listPage,now:()=>new Date(time)});
 let result;
 for (let n=0;n<5;n++) { result=await read(); time+=60_000; }
 assert.equal(result.complete,true);
 calls=[]; result=await read(); assert.equal(result.complete,true);
 assert.ok(calls.length <= 2, 'active cache should refresh a page, not restart the sweep');
 time+=181_000; calls=[]; result=await read();
 assert.equal(result.complete,false); assert.equal(calls.length,4);
});

test('later parent activity invalidates old-root scope proof even before the child page refreshes', async () => {
 const root = await mkdtemp(join(tmpdir(),'subagent-proof-invalidate-'));
 try {
  const started=Date.parse(cycleStartedAt), child={id:'child',cwd:root,updatedAt:1,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}},status:{type:'active',activeFlags:[]}};
  let items=[], proofReads=0, newRoot=false;
  const options={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'partial',items}],nextCursor:null}),
   listPage:async()=>({data:[child],nextCursor:null}),
   verifyAgent:async()=>{proofReads++;return {verdict:newRoot?'in-scope':'out-of-scope',parentThreadId:'p',cwd:root,rootTurnId:newRoot?'r':'old',turnStartedAt:new Date(started+1000).toISOString()};}};
  const old=await collectScoped(options); assert.equal(old.complete,true); assert.deepEqual(old.agents,[]); assert.equal(proofReads,1);
  newRoot=true; items=[{type:'subAgentActivity',agentThreadId:'child',kind:'interacted',startedAtMs:started+2000}];
  const current=await collectScoped(options); assert.equal(proofReads,2); assert.equal(current.agents[0]?.id,'child'); assert.equal(current.agents[0]?.state,'working');
  items=[{type:'subAgentActivity',agentThreadId:'child',kind:'interacted'}];
  const uncertain=await collectScoped(options); assert.equal(uncertain.complete,false); assert.deepEqual(uncertain.agents,[]); assert.equal(uncertain.runningCount,null);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('recorded count covers more than 100 members while cards remain bounded', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-count-101-'));
 try {
  const started=Date.parse(cycleStartedAt), children=Array.from({length:101},(_,i)=>({id:`c${i}`,cwd:root,updatedAt:1,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}},status:{type:'active',activeFlags:[]}}));
  const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:children.map(child=>({type:'subAgentActivity',agentThreadId:child.id,kind:'started',startedAtMs:started}))}],nextCursor:null}),
   listPage:async cursor=>{const n=cursor?Number(cursor):0;return {data:children.slice(n,n+50),nextCursor:n+50<children.length?String(n+50):null};}};
  let result; for(let i=0;i<5;i++){result=await collectScoped(opts);if(result.observedRunningComplete)break;}
  assert.equal(result.complete,true); assert.equal(result.truncated,true); assert.equal(result.agents.length,100);
  assert.equal(result.observedRunningCount,101); assert.equal(result.observedRunningComplete,true);
  children[100].status={type:'notLoaded'}; children[100].updatedAt=2;
  for(let i=0;i<5;i++){result=await collectScoped(opts);if(!result.observedRunningComplete)break;}
  assert.equal(result.observedRunningComplete,false); assert.equal(result.runningCount,null);
  assert.ok(result.observedRunningCount<=100);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('catalog refresh preserves bounded scoped proofs, checks replacement bytes and never exceeds four page reads', async () => {
 const {readIncrementalAgentCatalog}=await import('../../src/tasks/agent-catalog-cache.mjs');
 let tick=0, calls=0, extra=false, large=false;
 const child=i=>({id:`c${i}`,cwd:'/tmp',source:{subAgent:{thread_spawn:{parent_thread_id:'p',agent_path:large?'x'.repeat(4096):'a'}}}});
 const listPage=async cursor=>{calls++;const n=cursor?Number(cursor):0;const rows=Array.from({length:251},(_,i)=>child(i));if(extra)rows.unshift(child(251));return {data:rows.slice(n,n+50),nextCursor:n+50<rows.length?String(n+50):null};};
 const read=async()=>{calls=0;const value=await readIncrementalAgentCatalog({key:'bounded-refresh-regression',listPage,now:()=>new Date(Date.parse(cycleStartedAt)+tick++)});assert.ok(calls<=4);return value;};
 let result;for(let i=0;i<8;i++){result=await read();if(result.complete)break;}
 assert.equal(result.complete,true);result.proofs.set('c0',{proof:{verdict:'unknown'},updatedAt:1});
 extra=true;result=await read();assert.equal(result.complete,false);assert.ok(result.proofs.has('c0'));
 for(let i=0;i<8;i++){result=await read();if(result.complete)break;}assert.equal(result.complete,true);
 large=true;let overflow=false;for(let i=0;i<8;i++){result=await read();if(result.truncated){overflow=true;break;}}
 assert.equal(overflow,true);assert.equal(result.complete,false);assert.equal(result.rows.length,0);
});

test('retained runtime terminal evidence is invalidated by a later parent interaction', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-stale-status-'));
 try {
  const started=Date.parse(cycleStartedAt), children=Array.from({length:101},(_,i)=>({id:`c${i}`,cwd:root,updatedAt:1,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}},status:{type:'completed'}}));
  let nowMs=started+10000, interacted=false, observations=0;
  const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),now:()=>new Date(nowMs),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'subAgentActivity',agentThreadId:'c100',kind:interacted?'interacted':'started',startedAtMs:interacted?started+20000:started}]}],nextCursor:null}),
   listPage:async cursor=>{const n=cursor?Number(cursor):0;return {data:children.slice(n,n+50),nextCursor:n+50<children.length?String(n+50):null};},
   verifyAgent:async()=>({verdict:'out-of-scope',parentThreadId:'p',cwd:root,rootTurnId:'old',turnStartedAt:new Date(started+1000).toISOString()}),
   observeAgent:async()=>{observations++;return {state:'unknown',basis:'codex-rollout',observedAt:null,complete:false,readStable:false};}};
  await collectScoped(opts); nowMs+=1000; await collectScoped(opts);
  interacted=true;nowMs=started+21000;const result=await collectScoped(opts);
  assert.equal(observations,1);assert.equal(result.agents[0]?.state,'unknown');assert.equal(result.runningCount,null);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('observation collection across more than 100 members resumes with a bounded per-pass budget', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-observe-101-'));
 try {
  const started=Date.parse(cycleStartedAt), children=Array.from({length:101},(_,i)=>({id:`c${i}`,cwd:root,updatedAt:1,source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}},status:{type:'notLoaded'}}));
  let calls=0;const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:children.map(child=>({type:'subAgentActivity',agentThreadId:child.id,kind:'started',startedAtMs:started}))}],nextCursor:null}),
   listPage:async cursor=>{const n=cursor?Number(cursor):0;return {data:children.slice(n,n+50),nextCursor:n+50<children.length?String(n+50):null};},
   observeAgent:async()=>{calls++;return {state:'working',basis:'codex-rollout',observedAt:new Date(started+1000).toISOString(),eventTurnId:'t',rootTurnId:'r',complete:true,readStable:true};}};
  let result;for(let i=0;i<6;i++){const before=calls;result=await collectScoped(opts);assert.ok(calls-before<=100);if(result.observedRunningComplete)break;}
  assert.equal(result.agents.length,100);assert.equal(result.observedRunningCount,101);assert.equal(result.observedRunningComplete,true);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('cached observation is refreshed when the child changes without an updated catalog version', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-refresh-observation-'));
 try {
  const started=Date.parse(cycleStartedAt);let terminal=false,calls=0;
  const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'subAgentActivity',agentThreadId:'child',kind:'started',startedAtMs:started}]}],nextCursor:null}),
   listPage:async()=>({data:[{id:'child',cwd:root,updatedAt:1,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null}),
   observeAgent:async()=>{calls++;return {state:terminal?'completed':'working',basis:'codex-rollout',observedAt:new Date(started+(terminal?2000:1000)).toISOString(),eventTurnId:'t',rootTurnId:'r',complete:true,readStable:true};}};
  const first=await collectScoped(opts);assert.equal(first.observedRunningCount,1);
  terminal=true;const second=await collectScoped(opts);assert.equal(calls,2);assert.equal(second.agents[0].state,'completed');assert.equal(second.observedRunningCount,0);assert.equal(second.observedRunningComplete,true);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('bounded observation refresh rotates through members beyond the first hundred', async () => {
 const root=await mkdtemp(join(tmpdir(),'subagent-refresh-rotation-'));
 try {
  const started=Date.parse(cycleStartedAt), children=Array.from({length:101},(_,i)=>({id:`child-${i}`,cwd:root,updatedAt:1,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}));
  const seen=new Map();
  const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
   listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:children.map(child=>({type:'subAgentActivity',agentThreadId:child.id,kind:'started',startedAtMs:started}))}],nextCursor:null}),
   listPage:async cursor=>{const offset=cursor?Number(cursor):0;return {data:children.slice(offset,offset+50),nextCursor:offset+50<children.length?String(offset+50):null};},
   observeAgent:async id=>{seen.set(id,(seen.get(id)??0)+1);return {state:'working',basis:'codex-rollout',observedAt:new Date(started+1000).toISOString(),eventTurnId:'t',rootTurnId:'r',complete:true,readStable:true};}};
  let result;for(let poll=0;poll<5;poll++)result=await collectScoped(opts);
  assert.ok(seen.has('child-100'));assert.equal(seen.size,101);assert.equal(result.observedRunningCount,101);assert.equal(result.observedRunningComplete,true);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('parent completion or interruption invalidates an older cached working observation', async () => {
 for (const kind of ['completed','interrupted']) {
  const root=await mkdtemp(join(tmpdir(),'subagent-parent-terminal-'));
  try {
   const started=Date.parse(cycleStartedAt);let terminal=false,observations=0;
   const opts={parentThreadId:'p',cwd:root,storageRoot:root,schemas,taskSourcePath:join(root,'heartbeat.md'),
    listTurnsPage:async()=>({data:[{id:'r',rootTurnId:'r',startedAt:started/1000,itemsView:'full',items:[{type:'subAgentActivity',agentThreadId:'child',kind:'started',startedAtMs:started},...(terminal?[{type:'subAgentActivity',agentThreadId:'child',kind,startedAtMs:started+3000}]:[])]}],nextCursor:null}),
    listPage:async()=>({data:[{id:'child',cwd:root,updatedAt:1,status:{type:'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'p'}}}}],nextCursor:null}),
    observeAgent:async()=>{observations++;return terminal?{state:'unknown',basis:'codex-rollout',observedAt:null,complete:false,readStable:false}:{state:'working',basis:'codex-rollout',observedAt:new Date(started+1000).toISOString(),eventTurnId:'t',rootTurnId:'r',complete:true,readStable:true};}};
   const first=await collectScoped(opts);assert.equal(first.observedRunningCount,1);
   terminal=true;const result=await collectScoped(opts);
   assert.equal(observations,2);assert.notEqual(result.agents[0].state,'working');assert.equal(result.observedRunningCount,null);assert.equal(result.observedRunningComplete,false);assert.equal(result.runningCount,null);
  } finally {await rm(root,{recursive:true,force:true});}
 }
});
