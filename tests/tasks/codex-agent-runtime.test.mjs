import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCodexAgentObservation } from '../../src/tasks/codex-agent-runtime.mjs';

const at = (seconds) => new Date(Date.parse('2026-11-16T12:00:00.000Z') + seconds * 1000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
function event(type, turn, seconds, extra = {}) {
  return { type: 'event_msg', timestamp: at(seconds), payload: { type, turn_id: turn, ...extra } };
}
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-observe-')));
  const cwd = join(root, 'project');
  const logs = join(root, 'rollouts');
  const path = join(logs, 'session.jsonl');
  await mkdir(cwd); await mkdir(logs);
  const header = (overrides = {}) => ({ type: 'session_meta', payload: { id: 'child', cwd, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, ...overrides } });
  const write = (records, suffix = '') => writeFile(path, records.map(line).join('') + suffix);
  const options = { path, trustedRoot: logs, threadId: 'child', cwd, parentThreadId: 'parent', turnId: 'turn-2', rootTurnId: 'root-2', turnStartedAt: at(0) };
  try { await run({ root, cwd, logs, path, header, write, options }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('records exact current turn state with no message or prompt leakage', () => fixture(async ({ header, write, options }) => {
  await write([header(), event('task_started', 'turn-2', 1, { root_turn_id: 'root-2', prompt: 'private text' })]);
  const working = await readCodexAgentObservation(options);
  assert.deepEqual(working, { state: 'working', basis: 'codex-rollout', observedAt: at(1), eventType: 'task_started', eventTurnId: 'turn-2', rootTurnId: 'root-2', complete: true, readStable: true, reason: null, tailTruncated: false });
  assert.equal(JSON.stringify(working).includes('private text'), false);
  await write([header(), event('task_started', 'turn-2', 1), event('task_complete', 'turn-2', 2)]);
  const complete = await readCodexAgentObservation(options);
  assert.equal(complete.state, 'completed'); assert.equal(complete.eventType, 'task_complete');
  await write([header(), event('task_started', 'turn-2', 1), event('turn_aborted', 'turn-2', 2)]);
  const aborted = await readCodexAgentObservation(options);
  assert.equal(aborted.state, 'idle'); assert.equal(aborted.eventType, 'turn_aborted');
}));

test('identity, project, parent, root and path boundaries fail closed', () => fixture(async ({ root, cwd, path, header, write, options }) => {
  for (const meta of [header({ id: 'other' }), header({ cwd: root }), header({ source: { subagent: { thread_spawn: { parent_thread_id: 'foreign' } } } })]) {
    await write([meta, event('task_started', 'turn-2', 1)]);
    assert.equal((await readCodexAgentObservation(options)).reason, 'identity-mismatch');
  }
  await write([header(), event('task_started', 'turn-2', 1, { root_turn_id: 'foreign' })]);
  assert.equal((await readCodexAgentObservation(options)).state, 'unknown');
  await write([header(), event('task_started', 'turn-2', 1)]);
  const alias = join(root, 'alias.jsonl'); await symlink(path, alias);
  assert.equal((await readCodexAgentObservation({ ...options, path: alias })).state, 'unknown');
  assert.equal((await readCodexAgentObservation({ ...options, trustedRoot: cwd })).state, 'unknown');
  assert.equal((await readCodexAgentObservation({ ...options, path: options.trustedRoot })).state, 'unknown');
}));

test('previous completion cannot certify a new turn or missing event identity', () => fixture(async ({ header, write, options }) => {
  await write([header(), event('task_complete', 'turn-1', 1, { output: '100%' })]);
  const absent = await readCodexAgentObservation(options);
  assert.equal(absent.state, 'unknown'); assert.equal(absent.reason, 'no-current-event');
  await write([header(), event('task_complete', 'turn-1', 1), event('task_started', 'turn-2', 2)]);
  assert.equal((await readCodexAgentObservation(options)).state, 'working');
  await write([header(), event('task_started', 'turn-2', 1), { type: 'event_msg', timestamp: at(2), payload: { type: 'task_complete' } }]);
  assert.equal((await readCodexAgentObservation(options)).state, 'unknown');
  await write([header(), event('task_started', 'turn-2', 1, { turnId: 'different' })]);
  assert.equal((await readCodexAgentObservation(options)).state, 'unknown');
}));

test('untagged historical lifecycle events do not hide a resumed child turn', () => fixture(async ({ header, write, options }) => {
  const history = [event('turn_aborted', null, -60), event('task_complete', undefined, -30)];
  await write([header(), ...history, event('task_started', 'turn-2', 1)]);
  const working = await readCodexAgentObservation(options);
  assert.equal(working.state, 'working');
  assert.equal(working.eventTurnId, 'turn-2');
  assert.equal(working.observedAt, at(1));
  assert.equal(working.readStable, true);
  await write([header(), ...history, event('task_started', 'turn-2', 1), event('task_complete', 'turn-2', 2)]);
  assert.equal((await readCodexAgentObservation(options)).state, 'completed');
  for (const ambiguous of [
    event('turn_aborted', null, 0),
    event('task_complete', undefined, 2),
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: null } },
    { type: 'event_msg', timestamp: 'invalid', payload: { type: 'turn_aborted' } },
    event('turn_aborted', 'turn-2', -1),
    event('turn_aborted', 'turn-2', -1, { turnId: 'different' }),
  ]) {
    await write([header(), event('task_started', 'turn-2', 1), ambiguous]);
    assert.equal((await readCodexAgentObservation(options)).state, 'unknown');
  }
}));

test('partial append, corrupt line, oversize and byte budget never certify a state', () => fixture(async ({ header, write, options }) => {
  await write([header(), event('task_started', 'turn-2', 1)], '{"type":');
  assert.equal((await readCodexAgentObservation(options)).reason, 'incomplete-or-invalid');
  await write([header(), event('task_started', 'turn-2', 1)], 'not-json\n');
  assert.equal((await readCodexAgentObservation(options)).state, 'unknown');
  await write([header(), event('task_started', 'turn-2', 1)]);
  assert.equal((await readCodexAgentObservation({ ...options, maxBytes: 1 })).state, 'unknown');
  await write([header(), event('task_started', 'turn-2', 1), { type: 'message', text: 'x'.repeat(1024 * 1024 + 1) }]);
  assert.equal((await readCodexAgentObservation({ ...options, maxLineBytes: 1024 * 1024 })).reason, 'line-budget-exceeded');
}));

test('path replacement retries once and rejects repeated concurrent replacement', () => fixture(async ({ path, logs, header, write, options }) => {
  const original = [header(), event('task_started', 'turn-2', 1)];
  await write(original);
  let swaps = 0;
  const replace = async () => { const replacement = join(logs, `replacement-${swaps++}`); await writeFile(replacement, [header(), event('task_complete', 'turn-2', 2)].map(line).join('')); await rename(replacement, path); };
  const recovered = await readCodexAgentObservation({ ...options, onRead: async ({ phase, attempt }) => { if (phase === 'scanned' && attempt === 0) await replace(); } });
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.readStable, true); assert.equal(swaps, 1);
  await write(original); swaps = 0;
  const changed = await readCodexAgentObservation({ ...options, onRead: async ({ phase }) => { if (phase === 'scanned') await replace(); } });
  assert.equal(changed.state, 'unknown'); assert.equal(changed.reason, 'changed'); assert.equal(swaps, 2);
}));


test('bounded tails find recent current events and never revive old completions', () => fixture(async ({ header, write, options }) => {
  const filler = { type: 'message', text: 'private ' + 'x'.repeat(512) };
  await write([header(), event('task_complete', 'turn-1', 1), filler, event('task_complete', 'turn-2', 2)]);
  const recent = await readCodexAgentObservation({ ...options, maxBytes: 200 });
  assert.equal(recent.state, 'completed'); assert.equal(recent.tailTruncated, true);
  assert.equal(JSON.stringify(recent).includes('private'), false);
  await write([header(), event('task_started', 'turn-2', 1), filler]);
  const unseen = await readCodexAgentObservation({ ...options, maxBytes: 200 });
  assert.equal(unseen.state, 'unknown'); assert.equal(unseen.reason, 'outside-window-or-unobserved');
  await write([header(), event('task_complete', 'turn-1', 1), filler]);
  assert.equal((await readCodexAgentObservation({ ...options, maxBytes: 200 })).state, 'unknown');
}));

test('same-file cache invalidates after a new verified event', () => fixture(async ({ header, write, options }) => {
  await write([header(), event('task_started', 'turn-2', 1)]);
  assert.equal((await readCodexAgentObservation(options)).state, 'working');
  assert.equal((await readCodexAgentObservation(options)).state, 'working');
  await write([header(), event('task_started', 'turn-2', 1), event('task_complete', 'turn-2', 2)]);
  assert.equal((await readCodexAgentObservation(options)).state, 'completed');
}));


test('large valid response items between current-turn events do not hide recorded state', () => fixture(async ({ header, write, options }) => {
  const secret = 'private-prompt-' + 'x'.repeat(3 * 1024 * 1024);
  await write([header(), event('task_started', 'turn-2', 1), { type: 'response_item', payload: { type: 'function_call_output', output: secret } }, event('task_complete', 'turn-2', 2)]);
  const result = await readCodexAgentObservation(options);
  assert.equal(result.state, 'completed');
  assert.equal(result.eventType, 'task_complete');
  assert.equal(result.complete, true);
  assert.equal(JSON.stringify(result).includes('private-prompt'), false);
  assert.equal((await readCodexAgentObservation({ ...options, maxLineBytes: 1024 * 1024 })).reason, 'line-budget-exceeded');
}));


test('large malformed lines still invalidate otherwise valid current events', () => fixture(async ({ path, header, options }) => {
  const bad = '{"type":"response_item","payload":' + 'x'.repeat(2 * 1024 * 1024) + '}\n';
  await writeFile(path, line(header()) + line(event('task_started', 'turn-2', 1)) + bad + line(event('task_complete', 'turn-2', 2)));
  const result = await readCodexAgentObservation(options);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'incomplete-or-invalid');
}));
