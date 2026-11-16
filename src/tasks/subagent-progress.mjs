import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TaskStore } from './task-store.mjs';

export async function collectSubagentProgress({ parentThreadId, cwd, storageRoot, schemas, listPage, listTurnsPage, taskCycleId, cycleStartedAt, taskSourcePath, now = () => new Date() }) {
  const observedAt = now().toISOString();
  const snapshot = { schemaVersion: 1, parentThreadId, observedAt, status: 'ready', runningCount: null, runningBasis: 'unknown', agents: [], complete: true, truncated: false, taskCycleId: taskCycleId ?? null, taskSourcePath: taskSourcePath ?? null, scopeBasis: 'unknown' };
  const hasCycle = taskCycleId != null || cycleStartedAt != null;
  const validCycle = typeof taskCycleId === 'string' && !!taskCycleId.trim() && Number.isFinite(Date.parse(cycleStartedAt));
  const validSource = typeof taskSourcePath === 'string' && !!taskSourcePath.trim() && !taskSourcePath.includes('\0') && isAbsolute(taskSourcePath) && resolve(taskSourcePath) === taskSourcePath;
  const sourceScope = !hasCycle && validSource;
  let cycleMs = validCycle ? Date.parse(cycleStartedAt) : NaN;
  if ((taskSourcePath != null && !validSource) || (hasCycle && taskSourcePath != null) || (hasCycle && !validCycle) || (!hasCycle && !sourceScope) || typeof listTurnsPage !== 'function') {
    snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot;
  }
  const members = new Set();
  const recorded = new Map();
  const dispatches = new Map();
  const turns = [];
  let rootTurnId;
  let turnCursor;
  let boundary = false;
  let rootCount = 0;
  try {
    for (let page = 0; page < 8; page++) {
      const result = await listTurnsPage(turnCursor);
      if (!result || !Array.isArray(result.data) || result.data.length > 2) throw new Error('Invalid turn page');
      if (page === 0) {
        const latest = result.data[0];
        if (result.data.length === 0) {
          if (result.nextCursor != null) throw new Error('Missing newest turn');
          snapshot.complete = false;
          break;
        }
        if (!latest || typeof latest !== 'object' || Array.isArray(latest) || typeof latest.id !== 'string' || !latest.id.trim() || typeof latest.rootTurnId !== 'string' || !latest.rootTurnId.trim() || !Number.isFinite(latest.startedAt) || !Array.isArray(latest.items)) throw new Error('Invalid newest turn');
        rootTurnId = latest.rootTurnId;
        snapshot.rootTurnId = rootTurnId;
      }
      for (const turn of result.data) {
        if (!turn || typeof turn.id !== 'string' || !turn.id.trim() || !Number.isFinite(turn.startedAt) || !Array.isArray(turn.items)) { snapshot.complete = false; continue; }
        const startMs = turn.startedAt * 1000;
        if (turn.rootTurnId !== rootTurnId) { boundary = true; if (rootCount !== 1) snapshot.complete = false; break; }
        if (turn.id === rootTurnId) {
          rootCount++;
          if (sourceScope && rootCount > 1) throw new Error('Ambiguous root turn');
          snapshot.rootTurnStartedAt = new Date(startMs).toISOString();
        }
        if (Number.isFinite(turn.completedAt) && turn.completedAt * 1000 < cycleMs) { boundary = true; continue; }
        if (turn.itemsView !== 'full') snapshot.complete = false;
        turns.push(turn);
      }
      if (boundary || result.nextCursor == null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === turnCursor) { snapshot.complete = false; break; }
      turnCursor = result.nextCursor;
      if (page === 7) { snapshot.complete = false; snapshot.truncated = true; }
    }
    if (sourceScope) {
      if (!rootTurnId || rootCount !== 1 || !snapshot.rootTurnStartedAt) {
        snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot;
      }
      cycleMs = Date.parse(snapshot.rootTurnStartedAt);
      if (!Number.isFinite(cycleMs) || turns.some(turn => turn.startedAt * 1000 < cycleMs)) {
        snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot;
      }
    }
    // Pages are newest first, while items inside each turn are ordered oldest first.
    // Replaying the turns in reverse makes a later dispatch invalidate an earlier completion.
    for (const turn of turns.reverse()) {
      const startMs = turn.startedAt * 1000;
      for (const item of turn.items) {
        if (!item) continue;
        const itemMs = Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
        if (itemMs !== null ? itemMs < cycleMs : startMs < cycleMs) { if (itemMs === null && startMs < cycleMs) snapshot.complete = false; continue; }
        if (item.type === 'collabAgentToolCall' && item.senderThreadId === parentThreadId && ['spawnAgent', 'followupTask', 'resumeAgent', 'sendInput'].includes(item.tool) && item.status === 'completed' && Array.isArray(item.receiverThreadIds)) {
          for (const id of item.receiverThreadIds) if (typeof id === 'string' && id && id.length <= 256) {
            members.add(id);
            recorded.delete(id);
            // Only an item timestamp can bind a child cycle to this particular dispatch.
            dispatches.set(id, itemMs);
          }
        } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId && item.agentThreadId.length <= 256 && ['started', 'interacted', 'completed', 'interrupted'].includes(item.kind)) {
          members.add(item.agentThreadId);
          if (item.kind === 'interacted') dispatches.delete(item.agentThreadId);
          recorded.set(item.agentThreadId, { kind: item.kind, timestamp: itemMs ?? startMs });
        }
      }
    }
    if (rootTurnId) snapshot.scopeBasis = 'parent-root-turn'; else snapshot.complete = false;
  } catch { snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot; }
  let runtimeStatusesComplete = true;
  const finalizeRunningCount = () => {
    if (snapshot.complete && snapshot.status === 'ready' && rootCount === 1 && runtimeStatusesComplete && snapshot.agents.every(agent => ['working', 'waiting', 'idle', 'completed'].includes(agent.state))) {
      snapshot.runningCount = snapshot.agents.filter(agent => agent.state === 'working').length;
      snapshot.runningBasis = 'runtime';
    }
  };
  if (!members.size) { if (!snapshot.complete) snapshot.status = 'partial'; finalizeRunningCount(); return snapshot; }
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
        const statusType = child.status?.type;
        if (!((statusType === 'active' && Array.isArray(child.status.activeFlags)) || statusType === 'idle' || statusType === 'completed')) runtimeStatusesComplete = false;
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
          const dispatchedAt = dispatches.get(child.id);
          const progressStart = Date.parse(state?.lifecycle?.startedAt ?? state?.createdAt);
          if (state?.threadId === child.id && state.progress && Number.isFinite(dispatchedAt) && Number.isFinite(progressStart) && progressStart >= dispatchedAt) {
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
  finalizeRunningCount();
  return snapshot;
}
