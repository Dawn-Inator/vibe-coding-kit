// Shared, evidence-backed orchestration snapshot contract. Null always means unknown.
const MAX_JSON = 262144;
const MAX_TASKS = 1000;
const MAX_COUNT = 1000000;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, required, optional = []) => object(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...required, ...optional].includes(k));
const validPlan = (v) => keys(v, ['parentThreadId', 'planId', 'revision', 'plannedAgents'], ['taskCycleId']) && text(v.parentThreadId, 512) && text(v.planId, 512) && Number.isSafeInteger(v.revision) && v.revision >= 1 && Number.isSafeInteger(v.plannedAgents) && v.plannedAgents >= 0 && (!Object.hasOwn(v, 'taskCycleId') || text(v.taskCycleId, 512));
const observation = (v) => v === null || (keys(v, ['activeAgents', 'observedAt', 'evidence']) && Number.isSafeInteger(v.activeAgents) && v.activeAgents >= 0 && v.activeAgents <= MAX_COUNT && text(v.evidence, 1024) && typeof v.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v.observedAt) && Number.isFinite(Date.parse(v.observedAt)));

export function validateHeartbeatOrchestration(value) {
  if (!keys(value, ['scope', 'before', 'after', 'blockedTasks', 'blockersEvidence'], ['agentPlan']) || !text(value.scope, 512) || !observation(value.before) || !observation(value.after) || !(value.blockersEvidence === null || text(value.blockersEvidence, 1024)) || !(value.blockedTasks === null || (Array.isArray(value.blockedTasks) && value.blockedTasks.length <= MAX_TASKS))) throw new TypeError('Invalid heartbeat orchestration snapshot');
  if (Object.hasOwn(value, 'agentPlan') && !validPlan(value.agentPlan)) throw new TypeError('Invalid agent plan');
  if (value.before !== null && value.after !== null && Date.parse(value.after.observedAt) < Date.parse(value.before.observedAt)) throw new TypeError('After observation precedes before observation');
  if (value.blockedTasks !== null) {
    if (!value.blockersEvidence) throw new TypeError('Known blocked tasks require blockersEvidence');
    const ids = new Set();
    for (const task of value.blockedTasks) {
      if (!keys(task, ['id', 'title', 'reason', 'requiresOwner'], ['evidence']) || !text(task.id, 256) || !text(task.title, 512) || !text(task.reason, 2048) || ![true, false, null].includes(task.requiresOwner) || (Object.hasOwn(task, 'evidence') && !text(task.evidence, 1024)) || ids.has(task.id)) throw new TypeError('Invalid or duplicate blocked task');
      ids.add(task.id);
    }
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON) throw new TypeError('Heartbeat orchestration snapshot exceeds size limit');
  return JSON.parse(json);
}

// JSON.parse accepts repeated member names, including escaped equivalents. Walk the
// already-valid JSON separately so ambiguous metadata cannot certify a healthy state.
function rejectDuplicateMembers(raw) {
  let i = 0;
  const whitespace = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i += 1; };
  const string = () => {
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i++] === '"') return JSON.parse(raw.slice(start, i));
    }
    throw new SyntaxError('Unterminated JSON string');
  };
  const value = () => {
    whitespace();
    if (raw[i] === '"') { string(); return; }
    if (raw[i] === '{') {
      i += 1;
      const seen = new Set();
      whitespace();
      if (raw[i] === '}') { i += 1; return; }
      while (i < raw.length) {
        whitespace();
        const key = string();
        if (seen.has(key)) throw new SyntaxError('Duplicate JSON member');
        seen.add(key);
        whitespace(); i += 1; // colon, guaranteed by JSON.parse
        value(); whitespace();
        if (raw[i++] === '}') return;
      }
    } else if (raw[i] === '[') {
      i += 1; whitespace();
      if (raw[i] === ']') { i += 1; return; }
      while (i < raw.length) {
        value(); whitespace();
        if (raw[i++] === ']') return;
      }
    } else {
      while (i < raw.length && !/[\s,\]}]/.test(raw[i])) i += 1;
    }
  };
  value();
}

export function parseHeartbeatOrchestrationLines(lines) {
  const matches = lines.filter((line) => /^\s*orchestration\s*:/i.test(line));
  if (!matches.length) return { orchestration: null, orchestrationError: null };
  if (matches.length !== 1) return { orchestration: null, orchestrationError: 'duplicate orchestration metadata' };
  try {
    const raw = matches[0].replace(/^\s*orchestration\s*:\s*/i, '');
    if (Buffer.byteLength(raw, 'utf8') > MAX_JSON) throw new Error('size');
    const parsed = JSON.parse(raw);
    rejectDuplicateMembers(raw);
    return { orchestration: validateHeartbeatOrchestration(parsed), orchestrationError: null };
  } catch { return { orchestration: null, orchestrationError: 'invalid orchestration metadata' }; }
}

/** Allocation derives only from the same wake's explicit plan and after observation. */
export function projectAgentAllocation(snapshot, { parentThreadId, taskCycleId } = {}) {
  const unknown = { status: 'unknown', planId: null, planRevision: null, plannedCount: null, runningCount: null, ratio: null, observedAt: null, basis: 'unknown' };
  if (!object(snapshot) || !validPlan(snapshot.agentPlan)) return unknown;
  const plan = snapshot.agentPlan;
  if ((parentThreadId !== undefined && (plan.parentThreadId !== parentThreadId || (plan.taskCycleId !== undefined && taskCycleId === undefined))) || (taskCycleId !== undefined && plan.taskCycleId !== taskCycleId)) return unknown;
  const after = snapshot.after;
  const validAfter = after !== null && observation(after);
  const value = { ...unknown, planId: plan.planId, planRevision: plan.revision, plannedCount: plan.plannedAgents };
  if (!validAfter) return value;
  value.runningCount = after.activeAgents;
  value.observedAt = after.observedAt;
  value.basis = 'heartbeat';
  if (plan.plannedAgents === 0) return value;
  if (after.activeAgents > plan.plannedAgents) return { ...value, status: 'over-plan' };
  return { ...value, status: 'ready', ratio: after.activeAgents / plan.plannedAgents };
}

export function projectHeartbeatOrchestration(snapshot, { maxBlockedPreview = 20 } = {}) {
  if (!Number.isSafeInteger(maxBlockedPreview) || maxBlockedPreview < 0 || maxBlockedPreview > 1000) throw new TypeError('Invalid maxBlockedPreview');
  if (snapshot === null || snapshot === undefined) return null;
  const value = validateHeartbeatOrchestration(snapshot);
  const tasks = value.blockedTasks;
  const ownerCount = tasks === null ? null : tasks.filter((task) => task.requiresOwner === true).length;
  const unknownCount = tasks === null ? null : tasks.filter((task) => task.requiresOwner === null).length;
  const preview = tasks === null ? null : [true, null, false].flatMap((state) => tasks.filter((task) => task.requiresOwner === state)).slice(0, maxBlockedPreview);
  return { scope: value.scope, before: value.before, after: value.after, ...(value.agentPlan ? { agentPlan: value.agentPlan, allocation: projectAgentAllocation(value) } : {}), blockedTasks: preview, blockedTaskCount: tasks?.length ?? null, ownerInterventionCount: ownerCount, requiresOwner: tasks === null ? null : ownerCount > 0 ? true : unknownCount > 0 ? null : false, blockersEvidence: value.blockersEvidence, truncated: tasks !== null && tasks.length > maxBlockedPreview };
}
