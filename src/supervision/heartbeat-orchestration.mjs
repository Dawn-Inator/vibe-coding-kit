// Shared, evidence-backed orchestration snapshot contract. Null always means unknown.
const MAX_JSON = 262144;
const MAX_TASKS = 1000;
const MAX_COUNT = 1000000;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, required, optional = []) => object(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...required, ...optional].includes(k));
const observation = (v) => v === null || (keys(v, ['activeAgents', 'observedAt', 'evidence']) && Number.isSafeInteger(v.activeAgents) && v.activeAgents >= 0 && v.activeAgents <= MAX_COUNT && text(v.evidence, 1024) && typeof v.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v.observedAt) && Number.isFinite(Date.parse(v.observedAt)));

export function validateHeartbeatOrchestration(value) {
  if (!keys(value, ['scope', 'before', 'after', 'blockedTasks', 'blockersEvidence']) || !text(value.scope, 512) || !observation(value.before) || !observation(value.after) || !(value.blockersEvidence === null || text(value.blockersEvidence, 1024)) || !(value.blockedTasks === null || (Array.isArray(value.blockedTasks) && value.blockedTasks.length <= MAX_TASKS))) throw new TypeError('Invalid heartbeat orchestration snapshot');
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

export function parseHeartbeatOrchestrationLines(lines) {
  const matches = lines.filter((line) => /^\s*orchestration\s*:/i.test(line));
  if (!matches.length) return { orchestration: null, orchestrationError: null };
  if (matches.length !== 1) return { orchestration: null, orchestrationError: 'duplicate orchestration metadata' };
  try {
    const raw = matches[0].replace(/^\s*orchestration\s*:\s*/i, '');
    if (Buffer.byteLength(raw, 'utf8') > MAX_JSON) throw new Error('size');
    return { orchestration: validateHeartbeatOrchestration(JSON.parse(raw)), orchestrationError: null };
  } catch { return { orchestration: null, orchestrationError: 'invalid orchestration metadata' }; }
}

export function projectHeartbeatOrchestration(snapshot, { maxBlockedPreview = 20 } = {}) {
  if (!Number.isSafeInteger(maxBlockedPreview) || maxBlockedPreview < 0 || maxBlockedPreview > 1000) throw new TypeError('Invalid maxBlockedPreview');
  if (snapshot === null || snapshot === undefined) return null;
  const value = validateHeartbeatOrchestration(snapshot);
  const tasks = value.blockedTasks;
  const ownerCount = tasks === null ? null : tasks.filter((task) => task.requiresOwner === true).length;
  const unknownCount = tasks === null ? null : tasks.filter((task) => task.requiresOwner === null).length;
  const preview = tasks === null ? null : [true, null, false].flatMap((state) => tasks.filter((task) => task.requiresOwner === state)).slice(0, maxBlockedPreview);
  return { scope: value.scope, before: value.before, after: value.after, blockedTasks: preview, blockedTaskCount: tasks?.length ?? null, ownerInterventionCount: ownerCount, requiresOwner: tasks === null ? null : ownerCount > 0 ? true : unknownCount > 0 ? null : false, blockersEvidence: value.blockersEvidence, truncated: tasks !== null && tasks.length > maxBlockedPreview };
}
