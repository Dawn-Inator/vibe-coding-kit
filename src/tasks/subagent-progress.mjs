import { realpath } from 'node:fs/promises';
import { TaskStore } from './task-store.mjs';

export async function collectSubagentProgress({ parentThreadId, cwd, storageRoot, schemas, listPage, listTurnsPage, taskCycleId, cycleStartedAt, now = () => new Date() }) {
  const observedAt = now().toISOString();
  const snapshot = { schemaVersion: 1, parentThreadId, observedAt, status: 'ready', runningCount: null, runningBasis: 'unknown', agents: [], complete: true, truncated: false, taskCycleId: taskCycleId ?? null, scopeBasis: 'unknown' };
  const cycleMs = Date.parse(cycleStartedAt);
  if (typeof taskCycleId !== 'string' || !taskCycleId || !Number.isFinite(cycleMs) || typeof listTurnsPage !== 'function') {
    snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot;
  }
  const members = new Set();
  const recorded = new Map();
  let rootTurnId;
  let turnCursor;
  let boundary = false;
  try {
    for (let page = 0; page < 8; page++) {
      const result = await listTurnsPage(turnCursor);
      if (!result || !Array.isArray(result.data) || result.data.length > 2) throw new Error('Invalid turn page');
      for (const turn of result.data) {
        if (!turn || typeof turn.id !== 'string' || !Number.isFinite(turn.startedAt) || !Array.isArray(turn.items)) { if (rootTurnId === undefined) throw new Error('Invalid newest turn'); snapshot.complete = false; continue; }
        if (rootTurnId === undefined) {
          if (typeof turn.rootTurnId !== 'string' || !turn.rootTurnId) throw new Error('Missing newest root turn');
          rootTurnId = turn.rootTurnId;
          snapshot.rootTurnId = rootTurnId;
          snapshot.rootTurnStartedAt = new Date(turn.startedAt * 1000).toISOString();
        }
        const startMs = turn.startedAt * 1000;
        if (Number.isFinite(turn.completedAt) && turn.completedAt * 1000 < cycleMs) { boundary = true; continue; }
        if (turn.rootTurnId !== rootTurnId) { boundary = true; snapshot.complete = false; break; }
        if (turn.itemsView !== 'full') snapshot.complete = false;
        for (const item of turn.items) {
          if (!item) continue;
          const itemMs = Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
          if (itemMs !== null ? itemMs < cycleMs : startMs < cycleMs) { if (itemMs === null && startMs < cycleMs) snapshot.complete = false; continue; }
          if (item.type === 'collabAgentToolCall' && item.senderThreadId === parentThreadId && ['spawnAgent', 'followupTask', 'resumeAgent', 'sendInput'].includes(item.tool) && item.status === 'completed' && Array.isArray(item.receiverThreadIds)) {
            for (const id of item.receiverThreadIds) if (typeof id === 'string' && id && id.length <= 256) members.add(id);
          } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId && item.agentThreadId.length <= 256 && ['started', 'interacted', 'completed', 'interrupted'].includes(item.kind)) {
            members.add(item.agentThreadId);
            const timestamp = itemMs ?? startMs;
            if (!recorded.has(item.agentThreadId) || recorded.get(item.agentThreadId).timestamp <= timestamp) recorded.set(item.agentThreadId, { kind: item.kind, timestamp });
          }
        }
      }
      if (boundary || result.nextCursor == null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === turnCursor) { snapshot.complete = false; break; }
      turnCursor = result.nextCursor;
      if (page === 7) { snapshot.complete = false; snapshot.truncated = true; }
    }
    if (rootTurnId) snapshot.scopeBasis = 'parent-root-turn'; else snapshot.complete = false;
  } catch { snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot; }
  if (!members.size) { if (!snapshot.complete) snapshot.status = 'partial'; return snapshot; }
  let cursor;
  const seen = new Set();
  const canonicalCwd = await realpath(cwd);
  const store = new TaskStore(storageRoot, { schemas });
  try {
    for (let page = 0; page < 4; page++) {
      const result = await listPage(cursor);
      if (!result || !Array.isArray(result.data) || result.data.length > 50) throw new Error('Invalid child page');
      for (const child of result.data) {
        if (!child || typeof child.id !== 'string' || !members.has(child.id) || seen.has(child.id)) continue;
        const spawn = child.source?.subAgent?.thread_spawn;
        if (!spawn || spawn.parent_thread_id !== parentThreadId || (child.parentThreadId != null && child.parentThreadId !== parentThreadId)) { snapshot.complete = false; continue; }
        seen.add(child.id);
        if (snapshot.agents.length >= 100) { snapshot.complete = false; snapshot.truncated = true; break; }
        const entry = { id: child.id, name: String(child.name || spawn.agent_nickname || spawn.agent_role || child.id).slice(0, 200), state: 'unknown', observedAt, progress: null, progressBasis: null };
        const activity = recorded.get(child.id);
        if (activity?.kind === 'completed') { entry.state = 'completed'; entry.observedAt = new Date(activity.timestamp).toISOString(); }
        if (child.status?.type === 'active' && Array.isArray(child.status.activeFlags)) {
          entry.state = child.status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working';
          entry.observedAt = observedAt;
        } else if (child.status?.type === 'idle' && entry.state !== 'completed') { entry.state = 'idle'; entry.observedAt = observedAt; }
        snapshot.agents.push(entry);
        try {
          if (typeof child.cwd !== 'string' || await realpath(child.cwd) !== canonicalCwd) { snapshot.complete = false; continue; }
          const { state, uncertain } = await store.getReadOnly(child.id, { maxBytes: 1024 * 1024 });
          if (uncertain) snapshot.complete = false;
          if (state?.threadId === child.id && state.progress) {
            entry.progress = state.progress;
            entry.progressBasis = state.lifecycle ? 'task-lifecycle' : 'registered-checklist';
          }
        } catch { snapshot.complete = false; }
      }
      if (snapshot.truncated || seen.size === members.size) break;
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) { snapshot.complete = false; break; }
      cursor = result.nextCursor;
      if (page === 3) { snapshot.complete = false; snapshot.truncated = true; }
    }
  } catch { snapshot.complete = false; snapshot.status = snapshot.agents.length ? 'partial' : 'unavailable'; }
  if (seen.size !== members.size) snapshot.complete = false;
  if (!snapshot.complete && snapshot.status === 'ready') snapshot.status = 'partial';
  return snapshot;
}
