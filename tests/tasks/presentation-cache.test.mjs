import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlySnapshotCache, taskPresentationScope } from '../../src/tasks/presentation-cache.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('returns cached clone immediately, deduplicates work, and publishes a clone', async () => {
  const cache = new ReadOnlySnapshotCache({ now: () => 123 });
  const pending = deferred(); let calls = 0;
  cache.set('a', { items: [1] });
  const load = () => { calls++; return pending.promise; };
  const first = cache.read('a', load);
  first.value.items.push(2);
  assert.deepEqual(cache.read('a', load), { value: { items: [1] }, pending: true, error: null, updatedAt: 123 });
  await flush(); assert.equal(calls, 1);
  const result = { items: [3] }; pending.resolve(result); await flush();
  result.items.push(4);
  const snapshot = cache.peek('a'); snapshot.value.items.push(5);
  assert.deepEqual(cache.peek('a').value, { items: [3] });
});

test('slow work stays pending; terminal failure remains visible while retry starts', async () => {
  const cache = new ReadOnlySnapshotCache(); const slow = deferred(); let calls = 0;
  cache.read('a', () => { calls++; return slow.promise; });
  await flush(); await flush();
  assert.equal(cache.read('a', () => { calls++; }).pending, true); assert.equal(calls, 1);
  const error = new Error('offline'); slow.reject(error); await flush();
  assert.equal(cache.peek('a').error.message, error.message);
  const retry = deferred(); const state = cache.read('a', () => retry.promise);
  assert.equal(state.pending, true); assert.equal(state.error.message, error.message);
  retry.resolve('ok'); await flush();
  assert.equal(cache.peek('a').error, null); assert.equal(cache.peek('a').value, 'ok');
});

test('eviction, clear, delete, and set invalidate late publication even after reinsertion', async () => {
  for (const action of ['evict', 'clear', 'delete', 'set']) {
    const cache = new ReadOnlySnapshotCache({ maxEntries: 2 }); const slow = deferred();
    cache.read('a', () => slow.promise); await flush();
    if (action === 'evict') { cache.set('b', 2); cache.set('c', 3); }
    if (action === 'clear') cache.clear();
    if (action === 'delete') cache.delete('a');
    cache.set('a', 'new'); slow.resolve('old'); await flush();
    assert.equal(cache.peek('a').value, 'new', action);
  }
});

test('bounds entries, serialized bytes, and outstanding loaders', async () => {
  const cache = new ReadOnlySnapshotCache({ maxEntries: 1, maxBytes: 100, maxEntryBytes: 60 });
  cache.set('oversized', 'x'.repeat(100)); assert.equal(cache.peek('oversized').value, null);
  cache.set('a', 'a'); cache.set('b', 'b'); assert.equal(cache.peek('a').value, null);
  const slow = deferred(); let calls = 0;
  cache.read('a', () => { calls++; return slow.promise; }); await flush();
  assert.equal(cache.read('b', () => { calls++; return 'b'; }).pending, false);
  await flush(); assert.equal(calls, 1);
  slow.resolve('late'); await flush();
  cache.read('b', () => { calls++; return 'b'; }); await flush();
  assert.equal(calls, 2); assert.equal(cache.peek('b').value, 'b');
  const total = new ReadOnlySnapshotCache({ maxEntries: 4, maxBytes: 25, maxEntryBytes: 25 });
  total.set('a', '1234567890'); total.set('b', '1234567890');
  assert.equal(total.peek('a').value, null); assert.equal(total.peek('b').value, '1234567890');
});

test('scope hashes the full input tuple and rejects unverified-looking inputs', () => {
  const scope = { threadId: 'thread', cwd: '/work/a', projectRoot: '/work' };
  assert.match(taskPresentationScope(scope), /^[a-f0-9]{64}$/);
  for (const changes of [{ threadId: 'other' }, { cwd: '/work/b' }, { projectRoot: '/other' }]) {
    assert.notEqual(taskPresentationScope(scope), taskPresentationScope({ ...scope, ...changes }));
  }
  for (const changes of [{ threadId: ' ' }, { cwd: 'relative' }, { projectRoot: '' }]) {
    assert.throws(() => taskPresentationScope({ ...scope, ...changes }), TypeError);
  }
});


test('oversized loader results settle with an observable error and keep the last good value', async () => {
  const cache = new ReadOnlySnapshotCache({ maxEntryBytes: 30, now: () => 42 });
  cache.read('empty', () => 'x'.repeat(100)); await flush();
  const empty = cache.peek('empty');
  assert.equal(empty.pending, false); assert.equal(empty.value, null);
  assert.equal(empty.error.name, 'RangeError'); assert.equal(empty.updatedAt, null);
  const next = deferred();
  const retry = cache.read('empty', () => next.promise);
  assert.equal(retry.pending, true); assert.equal(retry.error.name, 'RangeError');
  next.resolve('ok'); await flush();
  assert.equal(cache.peek('empty').error, null);
  cache.set('good', 'good');
  cache.read('good', () => 'x'.repeat(100)); await flush();
  const good = cache.peek('good');
  assert.equal(good.pending, false); assert.equal(good.value, 'good');
  assert.equal(good.updatedAt, 42); assert.equal(good.error.name, 'RangeError');
});

test('loader error metadata is bounded and does not retain arbitrary payloads', async () => {
  const cache = new ReadOnlySnapshotCache();
  const failure = Object.assign(new Error('x'.repeat(2000)), { code: 'E'.repeat(200), payload: 'z'.repeat(100000) });
  cache.read('a', () => { throw failure; }); await flush();
  const error = cache.peek('a').error;
  assert.equal(error.message.length, 1000); assert.equal(error.code.length, 100);
  assert.equal(error.payload, undefined); assert.equal(error.cause, undefined);
});
