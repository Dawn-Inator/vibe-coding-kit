import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TaskStore } from './task-store.mjs';
import { readIncrementalAgentCatalog } from './agent-catalog-cache.mjs';

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
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/.test(value);
  const validCwd = value => typeof value === 'string' && value.trim().length > 0 && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f-\x9f]/.test(value);
  const validAgentPath = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value) && value.trim() === value;
  const dispatches = new Map();
  const invalidations = new Map();
  const turns = [];
  let rootTurnId;
  let turnCursor;
  const turnCursors = new Set();
  let boundary = false;
  let rootCount = 0;
  let parentWindowIncomplete = false;
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
        if (turn.itemsView !== 'full') parentWindowIncomplete = true;
        turns.push(turn);
      }
      if (boundary || result.nextCursor === null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || turnCursors.has(result.nextCursor)) { snapshot.complete = false; break; }
      turnCursors.add(result.nextCursor);
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
        if (!item || typeof item !== 'object' || Array.isArray(item)) { snapshot.complete = false; continue; }
        const itemMs = Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
        if (itemMs !== null ? itemMs < cycleMs : startMs < cycleMs) { if (itemMs === null && startMs < cycleMs) snapshot.complete = false; continue; }
        if (item.type === 'collabAgentToolCall' && item.senderThreadId === parentThreadId && ['spawnAgent', 'followupTask', 'resumeAgent', 'sendInput'].includes(item.tool) && item.status === 'completed') {
          if (!Array.isArray(item.receiverThreadIds)) { snapshot.complete = false; continue; }
          for (const id of item.receiverThreadIds) if (validId(id)) {
            members.add(id);
            recorded.delete(id);
            // Only an item timestamp can bind a child cycle to this particular dispatch.
            dispatches.set(id, itemMs);
            invalidations.set(id, itemMs);
          } else snapshot.complete = false;
        } else if (item.type === 'subAgentActivity' && validId(item.agentThreadId) && ['started', 'interacted', 'completed', 'interrupted'].includes(item.kind)) {
          members.add(item.agentThreadId);
          if (validAgentPath(item.agentPath)) {
            const prior = activityPaths.get(item.agentThreadId);
            activityPaths.set(item.agentThreadId, prior === undefined || prior === item.agentPath ? item.agentPath : null);
          }
          if (item.kind === 'interacted' || item.kind === 'started') invalidations.set(item.agentThreadId, itemMs);
          if (item.kind === 'interacted') dispatches.delete(item.agentThreadId);
          recorded.set(item.agentThreadId, { kind: item.kind, timestamp: itemMs ?? startMs, reliable: itemMs !== null });
        } else if (item.type === 'subAgentActivity') snapshot.complete = false;
      }
    }
    if (rootTurnId) snapshot.scopeBasis = 'parent-root-turn'; else snapshot.complete = false;
  } catch { snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot; }
  let runtimeStatusesComplete = true;
  const countEntries = [];
  const finalizeRunningCount = () => {
    const working = countEntries.filter(agent => agent.state === 'working' && ['runtime', 'recorded-runtime', 'codex-rollout'].includes(agent.stateBasis));
    // A runtime idle/completed status proves not running even if the displayed
    // completed label is sourced from an earlier parent activity event.
    const runtimeExact = snapshot.complete && snapshot.status === 'ready' && rootCount === 1 && runtimeStatusesComplete;
    const allObserved = runtimeExact || (snapshot.complete && snapshot.status === 'ready' && rootCount === 1 && countEntries.every(agent => ['runtime', 'recorded-runtime', 'codex-rollout', 'codex-turn'].includes(agent.stateBasis) && ['working', 'waiting', 'idle', 'completed', 'failed'].includes(agent.state)));
    const bases = new Set(countEntries.map(agent => agent.stateBasis).filter(basis => ['runtime', 'recorded-runtime', 'codex-rollout', 'codex-turn'].includes(basis)));
    snapshot.observedRunningCount = working.length || (allObserved ? 0 : null);
    snapshot.observedRunningComplete = allObserved;
    snapshot.observedRunningBasis = bases.size > 1 ? 'mixed' : bases.size ? [...bases][0] : allObserved ? 'runtime' : 'unknown';
    if (runtimeExact) {
      snapshot.runningCount = countEntries.filter(agent => agent.state === 'working' && agent.stateBasis === 'runtime').length;
      snapshot.runningBasis = 'runtime';
    }
  };
  const canonicalCwd = await realpath(cwd);
  const admittedCatalog = new Map(), ambiguousIds = new Set(), catalogIds = new Set(), catalogTimes = new Map(), catalogGenerations = new Map();
  let catalogFailed = false, catalogPages = 0, parentScopeResolved = !parentWindowIncomplete, catalog;
  try {
    const key = JSON.stringify([parentThreadId, canonicalCwd, rootTurnId, taskSourcePath ?? null, taskCycleId ?? null, cycleStartedAt ?? null, resolve(storageRoot)]);
    catalog = await readIncrementalAgentCatalog({ key, listPage, now });
    catalogPages = catalog.rows.length || (catalog.complete ? 1 : 0);
    if (!catalog.complete) snapshot.complete = false;
    if (catalog.truncated) snapshot.truncated = true;
    for (const row of catalog.rows) {
      const child = row.child;
      if (!child || typeof child !== 'object' || Array.isArray(child) || !validId(child.id)) { snapshot.complete = false; continue; }
      if (catalogIds.has(child.id)) { snapshot.complete = false; ambiguousIds.add(child.id); admittedCatalog.delete(child.id); continue; }
      catalogIds.add(child.id);
      const spawn = child.source?.subAgent?.thread_spawn;
      const spawnParent = spawn?.parent_thread_id;
      if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn) || !validId(spawnParent)) { snapshot.complete = false; continue; }
      const declaredParent = child.parentThreadId;
      if (declaredParent != null && (!validId(declaredParent) || declaredParent !== spawnParent)) { snapshot.complete = false; continue; }
      if (spawnParent !== parentThreadId) { if (members.has(child.id)) snapshot.complete = false; continue; }
      if (!validCwd(child.cwd)) { snapshot.complete = false; continue; }
      try { if (await realpath(child.cwd) !== canonicalCwd) { if (members.has(child.id)) snapshot.complete = false; continue; } }
      catch { snapshot.complete = false; continue; }
      admittedCatalog.set(child.id, child);
      catalogTimes.set(child.id, row.observedAt);
      catalogGenerations.set(child.id, row.generation);
    }
    if (catalog.complete) {
      for (const cache of [catalog.proofs, catalog.state?.observations].filter(Boolean))
        for (const id of cache.keys()) if (!admittedCatalog.has(id)) cache.delete(id);
    }
    const candidates = [...admittedCatalog.values()].filter(child => parentWindowIncomplete || !members.has(child.id));
    if (parentWindowIncomplete && catalog.complete && candidates.length === 0) parentScopeResolved = true;
    if (candidates.length && (typeof verifyAgent !== 'function' || !rootTurnId || !snapshot.rootTurnStartedAt)) snapshot.complete = false;
    if (typeof verifyAgent === 'function' && rootTurnId && snapshot.rootTurnStartedAt) {
      const cache = catalog.proofs;
      const saveProof = (id, value) => { if (!cache.has(id) && cache.size >= 2000) cache.delete(cache.keys().next().value); cache.set(id, value); };
      const proofVersion = child => {
        const changedByParent = invalidations.has(child.id);
        const parentTimestamp = invalidations.get(child.id);
        if (changedByParent && !Number.isFinite(parentTimestamp)) return null;
        return JSON.stringify([child.updatedAt ?? catalogTimes.get(child.id), changedByParent ? parentTimestamp : null]);
      };
      const unresolved = candidates.filter(child => {
        const cached = cache.get(child.id);
        return proofVersion(child) !== null && (!cached || cached.updatedAt !== proofVersion(child));
      });
      const offset = unresolved.length ? (catalog.state?.proofOffset ?? 0) % unresolved.length : 0;
      const work = [...unresolved.slice(offset), ...unresolved.slice(0, offset)].slice(0, 100);
      if (catalog.state && unresolved.length) catalog.state.proofOffset = (offset + work.length) % unresolved.length;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
        while (next < work.length) {
          const child = work[next++];
          try {
            const proof = await verifyAgent(child.id, { parentThreadId, cwd: canonicalCwd, rootTurnId, rootTurnStartedAt: snapshot.rootTurnStartedAt });
            if (!proof || proof.verdict === 'unknown' || proof.parentThreadId !== parentThreadId || !validId(proof.rootTurnId) || !validCwd(proof.cwd) || await realpath(proof.cwd) !== canonicalCwd || typeof proof.turnStartedAt !== 'string' || !Number.isFinite(Date.parse(proof.turnStartedAt))) continue;
            if (proof.verdict === 'out-of-scope' && proof.rootTurnId !== rootTurnId) saveProof(child.id, { proof, updatedAt: proofVersion(child) });
            else if ((proof.verdict === undefined || proof.verdict === 'in-scope') && proof.rootTurnId === rootTurnId && Date.parse(proof.turnStartedAt) >= cycleMs) saveProof(child.id, { proof, updatedAt: proofVersion(child) });
          } catch { /* Retry unknown identity in a later bounded pass. */ }
        }
      }));
      let allResolved = true;
      for (const child of candidates) {
        const cached = cache.get(child.id);
        if (proofVersion(child) === null) { members.delete(child.id); allResolved = false; continue; }
        if (!cached || cached.updatedAt !== proofVersion(child)) { allResolved = false; continue; }
        const proof = cached.proof;
        if (proof.verdict === 'out-of-scope') {
          if (members.has(child.id)) { members.delete(child.id); allResolved = false; }
        } else {
          members.add(child.id);
          if (!invalidations.has(child.id)) invalidations.set(child.id, Date.parse(proof.turnStartedAt));
        }
      }
      if (!allResolved) snapshot.complete = false;
      if (parentWindowIncomplete && allResolved && catalog.complete) parentScopeResolved = true;
    }
  } catch { catalogFailed = true; snapshot.complete = false; }
  if (!parentScopeResolved) snapshot.complete = false;
  // A proof lookup can yield while workspace paths change. Recheck the admitted
  // map before any entry, state, progress or count is derived from it.
  for (const [id, child] of admittedCatalog) {
    try {
      if (!validCwd(child.cwd) || await realpath(child.cwd) !== canonicalCwd) {
        admittedCatalog.delete(id); snapshot.complete = false;
      }
    } catch { admittedCatalog.delete(id); snapshot.complete = false; }
  }
  for (const id of members) if (!admittedCatalog.has(id) || ambiguousIds.has(id)) snapshot.complete = false;
  if (!members.size) {
    if (!snapshot.complete) snapshot.status = catalogFailed && !catalogPages ? 'unavailable' : 'partial';
    finalizeRunningCount(); return snapshot;
  }
  const seen = new Set();
  const observationQueue = [];
  const observationCache = catalog?.state?.observations ?? new Map();
  const store = new TaskStore(storageRoot, { schemas });
  try {
      for (const [id, child] of admittedCatalog) {
        if (!members.has(id)) continue;
        const spawn = child.source.subAgent.thread_spawn;
        seen.add(id);
        const displayed = snapshot.agents.length < 100;
        if (!displayed) snapshot.truncated = true;
        const catalogPath = validAgentPath(spawn.agent_path) ? spawn.agent_path : undefined;
        const activityPath = activityPaths.get(child.id);
        const path = activityPath === null || (catalogPath && activityPath && catalogPath !== activityPath) ? undefined : catalogPath ?? activityPath;
        const catalogTime = catalogTimes.get(id);
        const freshRuntime = catalogGenerations.get(id) === catalog.generation;
        const entry = { id: child.id, name: String(child.name || spawn.agent_nickname || spawn.agent_role || child.id).slice(0, 200), state: 'unknown', stateBasis: 'unknown', observedAt: null, progress: null, progressBasis: null, ...(path ? { agentPath: path } : {}) };
        const statusType = child.status?.type;
        const flags = child.status?.activeFlags;
        const validActive = statusType === 'active' && Array.isArray(flags) && flags.length <= 16 && flags.every(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
        const validNonActive = ['idle', 'completed'].includes(statusType) && (flags === undefined || (Array.isArray(flags) && flags.length === 0));
        const invalidation = invalidations.get(child.id);
        const parentTerminal = recorded.get(child.id);
        const terminalEvent = parentTerminal && ['completed', 'interrupted'].includes(parentTerminal.kind) ? parentTerminal : null;
        const terminalUnknown = terminalEvent && !terminalEvent.reliable;
        const runtimeUsable = (validActive || validNonActive) && (freshRuntime || ((!validActive || (!terminalUnknown && (!terminalEvent || Date.parse(catalogTime ?? '') >= terminalEvent.timestamp))) && (!invalidations.has(child.id) || (Number.isFinite(invalidation) && Date.parse(catalogTime ?? '') >= invalidation))));
        if (!runtimeUsable || !freshRuntime) runtimeStatusesComplete = false;
        const activity = recorded.get(child.id);
        if (activity?.kind === 'completed') { entry.state = 'completed'; entry.stateBasis = 'recorded-activity'; entry.observedAt = new Date(activity.timestamp).toISOString(); }
        if (runtimeUsable && validActive) {
          entry.state = child.status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working';
          entry.observedAt = catalogTime ?? null; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime';
        } else if (runtimeUsable && validNonActive && statusType === 'idle' && entry.state !== 'completed') { entry.state = 'idle'; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime'; entry.observedAt = catalogTime ?? null; }
        else if (runtimeUsable && validNonActive && statusType === 'completed') { entry.state = 'completed'; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime'; entry.observedAt = catalogTime ?? null; }
        countEntries.push(entry);
        if (displayed) snapshot.agents.push(entry);
        try {
          entry.assignmentEligible = true;
          if (typeof observeAgent === 'function' && !runtimeUsable) {
            const parentStamp = invalidations.has(child.id) ? invalidations.get(child.id) : null;
            const version = invalidations.has(child.id) && !Number.isFinite(parentStamp) ? null : JSON.stringify([child.updatedAt ?? catalogTime, parentStamp, terminalEvent ? [terminalEvent.kind, terminalEvent.timestamp, terminalEvent.reliable] : null]);
            const cached = observationCache.get(child.id);
            const baseline = { state: entry.state, stateBasis: entry.stateBasis, observedAt: entry.observedAt };
            const applyObservation = result => {
              const proof = (result?.basis === 'codex-rollout' ? result.readStable === true : result?.basis === 'codex-turn' && result.latestTurnVerified === true) && result.complete === true && typeof result.eventTurnId === 'string' && result.eventTurnId.trim().length > 0 && result.eventTurnId.length <= 256 && result.rootTurnId === rootTurnId;
              const timestamp = typeof result?.observedAt === 'string' ? Date.parse(result.observedAt) : NaN;
              const currentWorkingTurn = proof && result.basis === 'codex-rollout' && result.state === 'working';
              const afterInteraction = Number.isFinite(invalidation) ? timestamp >= invalidation : result.basis === 'codex-turn' && !invalidations.has(child.id);
              const afterParentTerminal = result?.state !== 'working' || !terminalEvent || (terminalEvent.reliable && Number.isFinite(timestamp) && timestamp >= terminalEvent.timestamp);
              if (proof && afterParentTerminal && (result.basis === 'codex-turn' ? ['completed', 'idle', 'failed'].includes(result.state) : ['working', 'completed', 'idle'].includes(result.state)) && Number.isFinite(timestamp) && timestamp >= cycleMs && (currentWorkingTurn || afterInteraction) && (result.basis === 'codex-turn' || baseline.stateBasis !== 'recorded-activity' || timestamp >= Date.parse(baseline.observedAt))) {
                entry.state = result.state; entry.stateBasis = result.basis; entry.observedAt = result.observedAt; return true;
              }
              return false;
            };
            if (version !== null && cached?.version === version && Date.parse(observedAt) >= cached.checkedAt) applyObservation(cached.result);
            if (version !== null)
              observationQueue.push(async () => {
                try {
                  const result = await observeAgent(child.id, { parentThreadId, cwd: canonicalCwd, rootTurnId, rootTurnStartedAt: snapshot.rootTurnStartedAt });
                  if (applyObservation(result)) { if (!observationCache.has(child.id) && observationCache.size >= 2000) observationCache.delete(observationCache.keys().next().value); observationCache.set(child.id, { version, checkedAt: Date.parse(observedAt), result: { state: result.state, basis: result.basis, observedAt: result.observedAt, eventTurnId: result.eventTurnId, rootTurnId: result.rootTurnId, complete: true, ...(result.basis === 'codex-turn' ? { latestTurnVerified: true } : { readStable: true }) } }); }
                  else { Object.assign(entry, baseline); observationCache.delete(child.id); }
                } catch { /* Unknown stays unknown; observation never creates membership. */ }
              });
          }
          if (!displayed) continue;
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
  } catch { snapshot.complete = false; snapshot.status = snapshot.agents.length ? 'partial' : 'unavailable'; }
  const offset = observationQueue.length ? (catalog?.state?.observationOffset ?? 0) % observationQueue.length : 0;
  const work = [...observationQueue.slice(offset), ...observationQueue.slice(0, offset)].slice(0, 100);
  if (catalog?.state && observationQueue.length) catalog.state.observationOffset = (offset + work.length) % observationQueue.length;
  let nextObservation = 0;
  await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
    while (nextObservation < work.length) await work[nextObservation++]();
  }));
  if (seen.size !== members.size) snapshot.complete = false;
  if (!runtimeStatusesComplete && countEntries.some(agent => !['runtime', 'recorded-runtime', 'codex-rollout', 'codex-turn'].includes(agent.stateBasis))) snapshot.complete = false;
  if (catalogFailed && !catalogPages && !snapshot.agents.length) snapshot.status = 'unavailable';
  if (!snapshot.complete && snapshot.status === 'ready') snapshot.status = 'partial';
  const observationTimes = countEntries.map(agent => Date.parse(agent.observedAt ?? '')).filter(Number.isFinite);
  if (observationTimes.length) snapshot.observedAt = new Date(Math.min(...observationTimes)).toISOString();
  finalizeRunningCount();
  return snapshot;
}
