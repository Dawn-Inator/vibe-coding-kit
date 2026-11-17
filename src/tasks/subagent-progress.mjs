import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TaskStore } from './task-store.mjs';
import { readIncrementalAgentCatalog } from './agent-catalog-cache.mjs';

export async function collectSubagentProgress({ parentThreadId, cwd, storageRoot, schemas, listPage, listTurnsPage, observeAgent, verifyAgent, lookupAgent, taskCycleId, cycleStartedAt, taskSourcePath, activityScope, now = () => new Date() }) {
  const parentMode = activityScope === 'parent-thread';
  const observedAt = now().toISOString();
  const snapshot = { schemaVersion: 1, parentThreadId, observedAt, status: 'ready', runningCount: null, runningBasis: 'unknown', agents: [], complete: true, truncated: false, taskCycleId: taskCycleId ?? null, taskSourcePath: taskSourcePath ?? null, scopeBasis: 'unknown' };
  const hasCycle = taskCycleId != null || cycleStartedAt != null;
  const validCycle = typeof taskCycleId === 'string' && !!taskCycleId.trim() && Number.isFinite(Date.parse(cycleStartedAt));
  const validSource = typeof taskSourcePath === 'string' && !!taskSourcePath.trim() && !taskSourcePath.includes('\0') && isAbsolute(taskSourcePath) && resolve(taskSourcePath) === taskSourcePath;
  const sourceScope = !hasCycle && validSource;
  let cycleMs = validCycle ? Date.parse(cycleStartedAt) : NaN;
  if ((taskSourcePath != null && !validSource) || (hasCycle && taskSourcePath != null) || (hasCycle && !validCycle) || (!hasCycle && !sourceScope && !parentMode) || typeof listTurnsPage !== 'function') {
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
          if (!parentMode) snapshot.complete = false;
          break;
        }
        if (!latest || typeof latest !== 'object' || Array.isArray(latest) || typeof latest.id !== 'string' || !latest.id.trim() || (!parentMode && (typeof latest.rootTurnId !== 'string' || !latest.rootTurnId.trim())) || !Number.isFinite(latest.startedAt) || !Array.isArray(latest.items)) throw new Error('Invalid newest turn');
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
    if (sourceScope && !parentMode) {
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
    if (parentMode) snapshot.scopeBasis = 'parent-thread';
    else if (rootTurnId) snapshot.scopeBasis = 'parent-root-turn'; else snapshot.complete = false;
  } catch { if (!parentMode) { snapshot.complete = false; snapshot.status = 'unavailable'; return snapshot; } snapshot.scopeBasis = 'parent-thread'; }
  // The parent scan supplies dispatch and invalidation hints only. Its root or
  // pagination completeness does not determine parent-thread catalog coverage.
  const recentMembers = new Set(members);
  if (parentMode) { snapshot.complete = true; snapshot.truncated = false; }
  let runtimeStatusesComplete = true;
  const countEntries = [];
  const finalizeRunningCount = () => {
    const working = countEntries.filter(agent => agent.state === 'working' && ['runtime', 'recorded-runtime', 'codex-rollout'].includes(agent.stateBasis));
    // A runtime idle/completed status proves not running even if the displayed
    // completed label is sourced from an earlier parent activity event.
    const runtimeExact = snapshot.complete && snapshot.status === 'ready' && (parentMode || rootCount === 1) && runtimeStatusesComplete;
    const allObserved = runtimeExact || (snapshot.complete && snapshot.status === 'ready' && (parentMode || rootCount === 1) && countEntries.every(agent => ['runtime', 'recorded-runtime', 'codex-rollout', 'codex-turn'].includes(agent.stateBasis) && ['working', 'waiting', 'idle', 'completed', 'failed'].includes(agent.state)));
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
  let activityHints = new Set();
  const hintedLookups = new Set();
  try {
    const key = JSON.stringify([parentThreadId, canonicalCwd, parentMode ? 'parent-thread' : rootTurnId, parentMode ? null : taskSourcePath ?? null, parentMode ? null : taskCycleId ?? null, parentMode ? null : cycleStartedAt ?? null, resolve(storageRoot)]);
    catalog = await readIncrementalAgentCatalog({ key, listPage, now });
    catalogPages = catalog.rows.length || (catalog.complete ? 1 : 0);
    if (parentMode && catalog.state) activityHints = (catalog.state.activityHints ??= new Set());
    if (!catalog.complete) snapshot.complete = false;
    if (catalog.truncated) snapshot.truncated = true;
    const admit = async (child, row) => {
      if (!child || typeof child !== 'object' || Array.isArray(child) || !validId(child.id)) return false;
      const spawn = child.source?.subAgent?.thread_spawn;
      const spawnParent = spawn?.parent_thread_id;
      if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn) || !validId(spawnParent) || (child.path != null && !validCwd(child.path))) return false;
      const declaredParent = child.parentThreadId;
      if (declaredParent != null && (!validId(declaredParent) || declaredParent !== spawnParent)) return false;
      if (spawnParent !== parentThreadId || !validCwd(child.cwd)) return false;
      try { if (await realpath(child.cwd) !== canonicalCwd) return false; }
      catch { return false; }
      admittedCatalog.set(child.id, child);
      catalogTimes.set(child.id, row.observedAt);
      catalogGenerations.set(child.id, row.generation);
      return true;
    };
    for (const row of catalog.rows) {
      const child = row.child;
      if (!child || !validId(child.id)) { snapshot.complete = false; continue; }
      if (catalogIds.has(child.id)) { snapshot.complete = false; ambiguousIds.add(child.id); admittedCatalog.delete(child.id); continue; }
      catalogIds.add(child.id);
      if (!await admit(child, row)) {
        // Only a well-formed foreign-parent identity can be excluded without
        // reducing coverage. A rejected local or malformed row may be ours.
        const foreignParent = child.source?.subAgent?.thread_spawn?.parent_thread_id;
        const declared = child.parentThreadId;
        const verifiedForeign = validId(foreignParent) && foreignParent !== parentThreadId &&
          (declared == null || (validId(declared) && declared === foreignParent));
        if (!verifiedForeign || members.has(child.id)) snapshot.complete = false;
      }
    }
    // Parent activity identifies candidates, not ownership. Resolve missing
    // recent IDs with the public identity API and the same admission rules.
    if (parentMode && !catalog.complete && typeof lookupAgent === 'function') {
      const missing = [...new Set([...recentMembers, ...activityHints])].filter(id => !admittedCatalog.has(id) && !catalogIds.has(id) && !ambiguousIds.has(id));
      const offset = missing.length ? (catalog.state?.lookupOffset ?? 0) % missing.length : 0;
      const work = [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, 100);
      if (catalog.state && missing.length) catalog.state.lookupOffset = (offset + work.length) % missing.length;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
        while (next < work.length) {
          const id = work[next++];
          try {
            const child = await lookupAgent(id);
            if (child?.id !== id || !await admit(child, { observedAt, generation: catalog.generation })) {
              activityHints.delete(id); snapshot.complete = false;
            } else if (!recentMembers.has(id)) hintedLookups.add(id);
          } catch { snapshot.complete = false; }
        }
      }));
    }
    if (catalog.complete) {
      for (const cache of [catalog.proofs, catalog.state?.observations].filter(Boolean))
        for (const id of cache.keys()) if (!admittedCatalog.has(id)) cache.delete(id);
    }
    if (parentMode) { members.clear(); for (const id of admittedCatalog.keys()) members.add(id); parentScopeResolved = true; }
    const candidates = parentMode ? [] : [...admittedCatalog.values()].filter(child => parentWindowIncomplete || !members.has(child.id));
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
  // These hints only schedule reads; they are never displayed as state evidence.
  if (parentMode && catalog?.complete) for (const id of activityHints) if (!admittedCatalog.has(id)) activityHints.delete(id);
  const store = new TaskStore(storageRoot, { schemas });
  const readProgress = async entry => {
    const { state, uncertain } = await store.getReadOnly(entry.id, { maxBytes: 1024 * 1024 });
    if (uncertain) snapshot.complete = false;
    const dispatchedAt = dispatches.get(entry.id);
    const progressStart = Date.parse(state?.lifecycle?.startedAt ?? state?.createdAt);
    if (state?.threadId === entry.id && state.progress && Number.isFinite(dispatchedAt) && Number.isFinite(progressStart) && progressStart >= dispatchedAt) {
      entry.progress = state.progress;
      entry.progressBasis = state.lifecycle ? 'task-lifecycle' : 'registered-checklist';
    }
  };
  try {
      for (const [id, child] of admittedCatalog) {
        if (!members.has(id)) continue;
        const spawn = child.source.subAgent.thread_spawn;
        seen.add(id);
        const displayed = snapshot.agents.length < 100;
        if (!displayed && !parentMode) snapshot.truncated = true;
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
        const needsFreshHint = parentMode && !recentMembers.has(child.id) && hintedLookups.has(child.id);
        const runtimeUsable = !needsFreshHint && (validActive || validNonActive) && (freshRuntime || ((!validActive || (!terminalUnknown && (!terminalEvent || Date.parse(catalogTime ?? '') >= terminalEvent.timestamp))) && (!invalidations.has(child.id) || (Number.isFinite(invalidation) && Date.parse(catalogTime ?? '') >= invalidation))));
        if (!runtimeUsable || !freshRuntime) runtimeStatusesComplete = false;
        const activity = recorded.get(child.id);
        if (activity?.kind === 'completed') { entry.state = 'completed'; entry.stateBasis = 'recorded-activity'; entry.observedAt = new Date(activity.timestamp).toISOString(); }
        if (runtimeUsable && validActive) {
          entry.state = child.status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working';
          entry.observedAt = catalogTime ?? null; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime';
          if (parentMode && freshRuntime) {
            if (!activityHints.has(child.id) && activityHints.size >= 2000) activityHints.delete(activityHints.values().next().value);
            activityHints.add(child.id);
          }
        } else if (runtimeUsable && validNonActive && statusType === 'idle' && entry.state !== 'completed') { entry.state = 'idle'; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime'; entry.observedAt = catalogTime ?? null; }
        else if (runtimeUsable && validNonActive && statusType === 'completed') { entry.state = 'completed'; entry.stateBasis = freshRuntime ? 'runtime' : 'recorded-runtime'; entry.observedAt = catalogTime ?? null; }
        if (parentMode && freshRuntime && runtimeUsable && validNonActive) activityHints.delete(child.id);
        countEntries.push(entry);
        if (displayed && !parentMode) snapshot.agents.push(entry);
        try {
          // Parent-thread membership proves activity ownership, not a current
          // task assignment. Only a precise dispatch in the current root and
          // task/source window can authorize host path-based assignment.
          const rootStartMs = Date.parse(snapshot.rootTurnStartedAt ?? '');
          const assignmentStart = validCycle ? Math.max(cycleMs, rootStartMs) : sourceScope ? rootStartMs : NaN;
          const dispatchedAt = dispatches.get(child.id);
          entry.assignmentEligible = !parentMode || (validId(rootTurnId) && rootCount === 1 && Number.isFinite(assignmentStart) && Number.isFinite(dispatchedAt) && dispatchedAt >= assignmentStart);
          if (typeof observeAgent === 'function' && !runtimeUsable) {
            const parentStamp = invalidations.has(child.id) ? invalidations.get(child.id) : null;
            const version = invalidations.has(child.id) && !Number.isFinite(parentStamp) ? null : JSON.stringify([child.updatedAt ?? catalogTime, parentStamp, terminalEvent ? [terminalEvent.kind, terminalEvent.timestamp, terminalEvent.reliable] : null]);
            const cached = observationCache.get(child.id);
            const baseline = { state: entry.state, stateBasis: entry.stateBasis, observedAt: entry.observedAt };
            const applyObservation = result => {
              const proof = (result?.basis === 'codex-rollout' ? result.readStable === true : result?.basis === 'codex-turn' && result.latestTurnVerified === true) && result.complete === true && typeof result.eventTurnId === 'string' && result.eventTurnId.trim().length > 0 && result.eventTurnId.length <= 256 && (parentMode ? (validId(result.rootTurnId) || (result.basis === 'codex-turn' && result.rootTurnId == null)) : result.rootTurnId === rootTurnId);
              const timestamp = typeof result?.observedAt === 'string' ? Date.parse(result.observedAt) : NaN;
              const currentWorkingTurn = proof && result.basis === 'codex-rollout' && result.state === 'working';
              const afterInteraction = Number.isFinite(invalidation) ? timestamp >= invalidation : result.basis === 'codex-turn' && !invalidations.has(child.id);
              const afterParentTerminal = result?.state !== 'working' || !terminalEvent || (terminalEvent.reliable && Number.isFinite(timestamp) && timestamp >= terminalEvent.timestamp);
              if (proof && afterParentTerminal && (result.basis === 'codex-turn' ? ['completed', 'idle', 'failed'].includes(result.state) : ['working', 'completed', 'idle'].includes(result.state)) && Number.isFinite(timestamp) && (parentMode || timestamp >= cycleMs) && (currentWorkingTurn || afterInteraction) && (result.basis === 'codex-turn' || baseline.stateBasis !== 'recorded-activity' || timestamp >= Date.parse(baseline.observedAt))) {
                entry.state = result.state; entry.stateBasis = result.basis; entry.observedAt = result.observedAt; return true;
              }
              return false;
            };
            const cachedAccepted = !needsFreshHint && version !== null && cached?.version === version && Date.parse(observedAt) >= cached.checkedAt && applyObservation(cached.result);
            // A terminal observation is reusable only while its catalog version and
            // parent lifecycle fence remain unchanged. Working always refreshes.
            const stableTerminal = parentMode && cachedAccepted && ['completed', 'idle', 'failed'].includes(cached.result.state);
            if ((version !== null || parentMode) && !stableTerminal)
              observationQueue.push({ id: child.id, updatedAt: child.updatedAt, urgent: parentMode && (recentMembers.has(child.id) || activityHints.has(child.id) || ['working', 'waiting'].includes(cached?.result?.state)), run: async () => {
                try {
                  const result = await observeAgent(child.id, { parentThreadId, cwd: canonicalCwd, rootTurnId, rootTurnStartedAt: snapshot.rootTurnStartedAt, ...(parentMode ? { activityScope: 'parent-thread' } : {}) });
                  const accepted = applyObservation(result);
                  if (parentMode) {
                    if (accepted && ['working', 'waiting'].includes(result.state)) {
                      if (!activityHints.has(child.id) && activityHints.size >= 2000) activityHints.delete(activityHints.values().next().value);
                      activityHints.add(child.id);
                    } else activityHints.delete(child.id);
                  }
                  if (accepted && version !== null) { if (!observationCache.has(child.id) && observationCache.size >= 2000) observationCache.delete(observationCache.keys().next().value); observationCache.set(child.id, { version, checkedAt: Date.parse(observedAt), result: { state: result.state, basis: result.basis, observedAt: result.observedAt, eventTurnId: result.eventTurnId, rootTurnId: result.rootTurnId, complete: true, ...(result.basis === 'codex-turn' ? { latestTurnVerified: true } : { readStable: true }) } }); }
                  else if (accepted) { observationCache.delete(child.id); }
                  else { Object.assign(entry, baseline); observationCache.delete(child.id); }
                } catch { if (parentMode) activityHints.delete(child.id); Object.assign(entry, baseline); observationCache.delete(child.id); }
              } });
          }
          if (!parentMode && displayed) await readProgress(entry);
        } catch { snapshot.complete = false; }
      }
  } catch { snapshot.complete = false; snapshot.status = snapshot.agents.length ? 'partial' : 'unavailable'; }
  if (parentMode) {
    // Sorting affects read order only; timestamps never establish activity.
    const updated = value => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : -Infinity;
    };
    observationQueue.sort((a, b) => Number(recentMembers.has(b.id)) - Number(recentMembers.has(a.id)) || updated(b.updatedAt) - updated(a.updatedAt));
  }
  let work;
  if (parentMode) {
    const urgent = observationQueue.filter(item => item.urgent);
    const other = observationQueue.filter(item => !item.urgent);
    // Reserve 20 slots for history while lending unused slots in either lane.
    // Each lane advances independently, including when urgent exceeds capacity.
    const urgentLimit = Math.min(urgent.length, other.length ? 80 : 100);
    const otherLimit = Math.min(other.length, 100 - urgentLimit);
    const urgentCount = Math.min(urgent.length, 100 - otherLimit);
    const take = (queue, count, key) => {
      if (!queue.length || !count) return [];
      const offset = (catalog?.state?.[key] ?? 0) % queue.length;
      const selected = [...queue.slice(offset), ...queue.slice(0, offset)].slice(0, count);
      if (catalog?.state) catalog.state[key] = (offset + selected.length) % queue.length;
      return selected;
    };
    work = [...take(urgent, urgentCount, 'urgentObservationOffset'), ...take(other, otherLimit, 'otherObservationOffset')];
  } else {
    const offset = observationQueue.length ? (catalog?.state?.observationOffset ?? 0) % observationQueue.length : 0;
    work = [...observationQueue.slice(offset), ...observationQueue.slice(0, offset)].slice(0, 100);
    if (catalog?.state && observationQueue.length) catalog.state.observationOffset = (offset + work.length) % observationQueue.length;
  }
  let nextObservation = 0;
  await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
    while (nextObservation < work.length) await work[nextObservation++].run();
  }));
  if (parentMode) {
    const active = countEntries.filter(entry => ['working', 'waiting'].includes(entry.state));
    snapshot.agents = active.slice(0, 100);
    if (active.length > 100) snapshot.truncated = true;
  }
  if (seen.size !== members.size) snapshot.complete = false;
  if (!runtimeStatusesComplete && countEntries.some(agent => !['runtime', 'recorded-runtime', 'codex-rollout', 'codex-turn'].includes(agent.stateBasis))) snapshot.complete = false;
  if (catalogFailed && !catalogPages && !snapshot.agents.length) snapshot.status = 'unavailable';
  if (!snapshot.complete && snapshot.status === 'ready') snapshot.status = 'partial';
  const observationTimes = countEntries.map(agent => Date.parse(agent.observedAt ?? '')).filter(Number.isFinite);
  if (observationTimes.length) snapshot.observedAt = new Date(Math.min(...observationTimes)).toISOString();
  finalizeRunningCount();
  return snapshot;
}
