import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TaskStore } from './task-store.mjs';

export async function collectSubagentProgress({ parentThreadId, cwd, storageRoot, schemas, listPage, listTurnsPage, observeAgent, verifyAgent, taskCycleId, cycleStartedAt, taskSourcePath, now = () => new Date() }) {
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
  const activityPaths = new Map();
  const validAgentPath = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value) && value.trim() === value;
  const dispatches = new Map();
  const invalidations = new Map();
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
            invalidations.set(id, itemMs);
          }
        } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId && item.agentThreadId.length <= 256 && ['started', 'interacted', 'completed', 'interrupted'].includes(item.kind)) {
          members.add(item.agentThreadId);
          if (validAgentPath(item.agentPath)) {
            const prior = activityPaths.get(item.agentThreadId);
            activityPaths.set(item.agentThreadId, prior === undefined || prior === item.agentPath ? item.agentPath : null);
          }
          if (item.kind === 'interacted' || item.kind === 'started') invalidations.set(item.agentThreadId, itemMs);
          if (item.kind === 'interacted') dispatches.delete(item.agentThreadId);
          recorded.set(item.agentThreadId, { kind: item.kind, timestamp: itemMs ?? startMs });
        }
      }
    }
    if (rootTurnId) snapshot.scopeBasis = 'parent-root-turn'; else snapshot.complete = false;
  } catch { snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot; }
  let runtimeStatusesComplete = true;
  const finalizeRunningCount = () => {
    const working = snapshot.agents.filter(agent => agent.state === 'working' && ['runtime', 'codex-rollout'].includes(agent.stateBasis));
    // A runtime idle/completed status proves not running even if the displayed
    // completed label is sourced from an earlier parent activity event.
    const runtimeExact = snapshot.complete && snapshot.status === 'ready' && rootCount === 1 && runtimeStatusesComplete;
    const allObserved = runtimeExact || (snapshot.complete && snapshot.status === 'ready' && rootCount === 1 && snapshot.agents.every(agent => ['runtime', 'codex-rollout'].includes(agent.stateBasis) && ['working', 'waiting', 'idle', 'completed'].includes(agent.state)));
    const recorded = snapshot.agents.some(agent => agent.stateBasis === 'codex-rollout');
    const live = snapshot.agents.some(agent => agent.stateBasis === 'runtime');
    snapshot.observedRunningCount = working.length || (allObserved ? 0 : null);
    snapshot.observedRunningComplete = allObserved;
    snapshot.observedRunningBasis = recorded ? (live ? 'mixed' : 'codex-rollout') : live || allObserved ? 'runtime' : 'unknown';
    if (runtimeExact) {
      snapshot.runningCount = snapshot.agents.filter(agent => agent.state === 'working' && agent.stateBasis === 'runtime').length;
      snapshot.runningBasis = 'runtime';
    }
  };
  const canonicalCwd = await realpath(cwd);
  let effectiveListPage = listPage;
  // A direct child absent from the recent parent-item window is admitted only
  // after its own latest public turn proves the exact current parent root.
  if (typeof verifyAgent === 'function' && rootTurnId && snapshot.rootTurnStartedAt) {
    const pages = [], candidates = [], candidateIds = new Set();
    let catalogCursor;
    try {
      for (let page = 0; page < 4; page++) {
        const result = await listPage(catalogCursor);
        if (!result || !Array.isArray(result.data) || result.data.length > 50) throw new Error('Invalid child page');
        pages.push(result);
        for (const child of result.data) {
          if (!child || typeof child.id !== 'string' || !child.id || child.id.length > 256 || members.has(child.id) || candidateIds.has(child.id)) continue;
          const spawn = child.source?.subAgent?.thread_spawn;
          if (!spawn || spawn.parent_thread_id !== parentThreadId || (child.parentThreadId != null && child.parentThreadId !== parentThreadId)) continue;
          candidateIds.add(child.id);
          if (candidates.length >= 100) { snapshot.complete = false; snapshot.truncated = true; continue; }
          candidates.push(child);
        }
        if (result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === catalogCursor) { snapshot.complete = false; break; }
        catalogCursor = result.nextCursor;
        if (page === 3) { snapshot.complete = false; snapshot.truncated = true; }
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
        while (next < candidates.length) {
          const child = candidates[next++];
          try {
            if (typeof child.cwd !== 'string') { snapshot.complete = false; continue; }
            if (await realpath(child.cwd) !== canonicalCwd) continue;
            const proof = await verifyAgent(child.id, { parentThreadId, cwd: canonicalCwd, rootTurnId, rootTurnStartedAt: snapshot.rootTurnStartedAt });
            if (!proof || proof.parentThreadId !== parentThreadId || proof.rootTurnId !== rootTurnId ||
                typeof proof.cwd !== 'string' || await realpath(proof.cwd) !== canonicalCwd ||
                typeof proof.turnStartedAt !== 'string' || !Number.isFinite(Date.parse(proof.turnStartedAt)) ||
                Date.parse(proof.turnStartedAt) < cycleMs) { snapshot.complete = false; continue; }
            members.add(child.id);
            invalidations.set(child.id, Date.parse(proof.turnStartedAt));
          } catch { snapshot.complete = false; /* Unknown proof cannot establish complete membership. */ }
        }
      }));
      let replay = 0;
      effectiveListPage = async () => pages[replay++] ?? { data: [], nextCursor: null };
    } catch { snapshot.complete = false; effectiveListPage = async () => ({ data: [], nextCursor: null }); }
  }
  if (!members.size) { if (!snapshot.complete) snapshot.status = 'partial'; finalizeRunningCount(); return snapshot; }
  let cursor;
  const seen = new Set();
  const observationQueue = [];
  const store = new TaskStore(storageRoot, { schemas });
  try {
    for (let page = 0; page < 4; page++) {
      const result = await effectiveListPage(cursor);
      if (!result || !Array.isArray(result.data) || result.data.length > 50) throw new Error('Invalid child page');
      for (const child of result.data) {
        if (!child || typeof child.id !== 'string' || !members.has(child.id) || seen.has(child.id)) continue;
        const spawn = child.source?.subAgent?.thread_spawn;
        if (!spawn || spawn.parent_thread_id !== parentThreadId || (child.parentThreadId != null && child.parentThreadId !== parentThreadId)) { snapshot.complete = false; continue; }
        seen.add(child.id);
        if (snapshot.agents.length >= 100) { snapshot.complete = false; snapshot.truncated = true; break; }
        const catalogPath = validAgentPath(spawn.agent_path) ? spawn.agent_path : undefined;
        const activityPath = activityPaths.get(child.id);
        const path = activityPath === null || (catalogPath && activityPath && catalogPath !== activityPath) ? undefined : catalogPath ?? activityPath;
        const entry = { id: child.id, name: String(child.name || spawn.agent_nickname || spawn.agent_role || child.id).slice(0, 200), state: 'unknown', stateBasis: 'unknown', observedAt: null, progress: null, progressBasis: null, ...(path ? { agentPath: path } : {}) };
        const statusType = child.status?.type;
        if (!((statusType === 'active' && Array.isArray(child.status.activeFlags)) || statusType === 'idle' || statusType === 'completed')) runtimeStatusesComplete = false;
        const activity = recorded.get(child.id);
        if (activity?.kind === 'completed') { entry.state = 'completed'; entry.stateBasis = 'recorded-activity'; entry.observedAt = new Date(activity.timestamp).toISOString(); }
        if (child.status?.type === 'active' && Array.isArray(child.status.activeFlags)) {
          entry.state = child.status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working';
          entry.observedAt = observedAt; entry.stateBasis = 'runtime';
        } else if (child.status?.type === 'idle' && entry.state !== 'completed') { entry.state = 'idle'; entry.stateBasis = 'runtime'; entry.observedAt = observedAt; }
        else if (child.status?.type === 'completed') { entry.state = 'completed'; entry.stateBasis = 'runtime'; entry.observedAt = observedAt; }
        snapshot.agents.push(entry);
        try {
          if (typeof child.cwd !== 'string' || await realpath(child.cwd) !== canonicalCwd) { snapshot.complete = false; continue; }
          entry.assignmentEligible = true;
          if (typeof observeAgent === 'function' && !['active', 'idle', 'completed'].includes(statusType))
            observationQueue.push(async () => {
              try {
                const result = await observeAgent(child.id, { parentThreadId, cwd: canonicalCwd, rootTurnId, rootTurnStartedAt: snapshot.rootTurnStartedAt });
                if (result?.basis === 'codex-rollout' && ['working', 'completed', 'idle'].includes(result.state) && typeof result.observedAt === 'string' && Number.isFinite(Date.parse(result.observedAt)) && Date.parse(result.observedAt) >= cycleMs && Number.isFinite(invalidations.get(child.id)) && Date.parse(result.observedAt) >= invalidations.get(child.id) && (entry.stateBasis !== 'recorded-activity' || Date.parse(result.observedAt) >= Date.parse(entry.observedAt))) {
                  entry.state = result.state; entry.stateBasis = 'codex-rollout'; entry.observedAt = result.observedAt;
                }
              } catch { /* Unknown stays unknown; observation never creates membership. */ }
            });
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
      if ((snapshot.truncated && snapshot.agents.length >= 100) || seen.size === members.size) break;
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) { snapshot.complete = false; break; }
      cursor = result.nextCursor;
      if (page === 3) { snapshot.complete = false; snapshot.truncated = true; }
    }
  } catch { snapshot.complete = false; snapshot.status = snapshot.agents.length ? 'partial' : 'unavailable'; }
  let nextObservation = 0;
  await Promise.all(Array.from({ length: Math.min(2, observationQueue.length) }, async () => {
    while (nextObservation < observationQueue.length) await observationQueue[nextObservation++]();
  }));
  if (seen.size !== members.size) snapshot.complete = false;
  if (!snapshot.complete && snapshot.status === 'ready') snapshot.status = 'partial';
  finalizeRunningCount();
  return snapshot;
}
