import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectAgentAllocation, projectHeartbeatOrchestration, validateHeartbeatOrchestration } from '../../src/supervision/heartbeat-ledger-api.mjs';

const plan = { parentThreadId: 'parent', planId: 'delivery', revision: 2, plannedAgents: 6, taskCycleId: 'cycle-1' };
const observation = activeAgents => ({ activeAgents, observedAt: '2026-11-16T12:00:00Z', evidence: 'wake receipt' });
const wake = after => ({ scope: 'task', before: null, after, blockedTasks: null, blockersEvidence: null, agentPlan: plan });
const scope = { parentThreadId: 'parent', taskCycleId: 'cycle-1' };

test('explicit same-wake plan and after observation define allocation, independent of listed agents', () => {
  const snapshot = { ...wake(observation(3)), agents: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) };
  const actual = projectAgentAllocation(snapshot, scope);
  assert.deepEqual(actual, { status: 'ready', planId: 'delivery', planRevision: 2, plannedCount: 6, runningCount: 3, ratio: .5, observedAt: '2026-11-16T12:00:00Z', basis: 'heartbeat' });
  assert.equal(projectAgentAllocation(wake(observation(0)), scope).ratio, 0);
  const over = projectAgentAllocation(wake(observation(7)), scope);
  assert.equal(over.status, 'over-plan'); assert.equal(over.ratio, null); assert.equal(over.runningCount, 7);
});

test('unavailable, zero, invalid and mismatched plan never fabricate a ratio', () => {
  const samples = [
    [wake(null), scope],
    [{ ...wake(observation(0)), agentPlan: { ...plan, plannedAgents: 0 } }, scope],
    [wake(observation(3)), { parentThreadId: 'other', taskCycleId: 'cycle-1' }],
    [wake(observation(3)), { parentThreadId: 'parent', taskCycleId: 'cycle-2' }],
    [wake(observation(3)), { parentThreadId: 'parent' }],
    [{ ...wake(observation(3)), agentPlan: { ...plan, revision: 0 } }, scope],
    [{ ...wake(observation(3)), agentPlan: undefined }, scope],
  ];
  for (const [value, options] of samples) assert.equal(projectAgentAllocation(value, options).ratio, null);
  const legacy = { scope: 'task', before: null, after: observation(3), blockedTasks: null, blockersEvidence: null };
  assert.deepEqual(validateHeartbeatOrchestration(legacy), legacy);
  assert.equal(Object.hasOwn(projectHeartbeatOrchestration(legacy), 'allocation'), false);
  assert.throws(() => validateHeartbeatOrchestration({ ...legacy, agentPlan: { ...plan, plannedAgents: -1 } }));
  assert.equal(projectHeartbeatOrchestration(wake(observation(3))).allocation.ratio, .5);
});
