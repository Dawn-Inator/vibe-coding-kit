// Reconstructible, bounded observation cache. It is never source authority.
const MAX_SCOPES = 8;
const MAX_ROWS = 2000;
const MAX_BYTES = 1024 * 1024;
const MAX_AGE_MS = 180_000;
const entries = new Map();
let generation = 0;

function safeRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const spawn = value.source?.subAgent?.thread_spawn;
  const copy = value => typeof value === 'string' ? (value.length <= 4096 ? value : null) : typeof value === 'number' || typeof value === 'boolean' || value == null ? value : null;
  return {
    id: copy(value.id), cwd: copy(value.cwd), parentThreadId: copy(value.parentThreadId),
    name: typeof value.name === 'string' ? value.name.slice(0, 200) : undefined,
    updatedAt: ['number', 'string'].includes(typeof value.updatedAt) ? copy(value.updatedAt) : null,
    source: spawn && typeof spawn === 'object' && !Array.isArray(spawn)
      ? { subAgent: { thread_spawn: { parent_thread_id: copy(spawn.parent_thread_id),
        agent_path: copy(spawn.agent_path), agent_nickname: copy(spawn.agent_nickname), agent_role: copy(spawn.agent_role) } } }
      : null,
    status: value.status && typeof value.status === 'object' && !Array.isArray(value.status)
      ? { type: copy(value.status.type), activeFlags: Array.isArray(value.status.activeFlags) ? value.status.activeFlags.slice(0, 17).map(copy) : copy(value.status.activeFlags) }
      : null,
  };
}
function headKey(page) {
  return JSON.stringify([page.rows.map(({ child }) => [child?.id, child?.cwd, child?.parentThreadId, child?.source?.subAgent?.thread_spawn?.parent_thread_id]), page.nextCursor]);
}
function normalize(result, at, stamp, cursor) {
  if (!result || !Array.isArray(result.data) || result.data.length > 50) throw new Error('Invalid child page');
  return { rows: result.data.map(value => ({ child: safeRow(value), observedAt: at, generation: stamp })), nextCursor: result.nextCursor, cursor };
}
/** Four page requests per step, plus a final head recheck on completion. */
export async function readIncrementalAgentCatalog({ key, listPage, now = () => new Date() }) {
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError('now must be valid');
  const observedAt = at.toISOString(), time = at.getTime(), stamp = ++generation;
  let entry = entries.get(key);
  // Parallel calls do not race mutable sweep state. Returning partial permits a retry.
  if (entry?.pending) return { rows: [], complete: false, truncated: false, pending: true, proofs: new Map() };
  if (!entry || time < entry.lastAccessAt || time - entry.lastAccessAt > MAX_AGE_MS) entry = null;
  const lock = entry ?? { pending: false, lastAccessAt: time };
  lock.pending = true; entries.set(key, lock);
  try {
    const head = normalize(await listPage(undefined), observedAt, stamp, undefined);
    if (Buffer.byteLength(JSON.stringify(head)) > MAX_BYTES) throw new Error('Child catalog page exceeds byte limit');
    const signature = headKey(head);
    if (!entry || entry.headSignature !== signature) entry = { pending: true, lastAccessAt: time, headSignature: signature, pages: [], cursors: new Set(), nextCursor: undefined, complete: false, truncated: false, proofs: new Map() };
    if (entry.pages.length) entry.pages[0] = head; else { entry.pages.push(head); entry.nextCursor = head.nextCursor; }
    // Once complete, refresh one retained page per poll. A changed identity
    // invalidates the sweep; changed updatedAt invalidates its scoped proof.
    if (entry.complete && entry.pages.length > 1) {
      const index = Math.max(1, Math.min(entry.refreshIndex ?? 1, entry.pages.length - 1));
      const old = entry.pages[index];
      const refreshed = normalize(await listPage(old.cursor), observedAt, stamp, old.cursor);
      if (headKey(refreshed) !== headKey(old)) throw new Error('Child catalog changed during refresh');
      entry.pages[index] = refreshed;
      entry.refreshIndex = index + 1 < entry.pages.length ? index + 1 : 1;
    }
    let budget = 3;
    while (!entry.complete && entry.nextCursor !== null && budget > 0) {
      budget--;
      const cursor = entry.nextCursor;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || entry.cursors.has(cursor)) { entry.invalid = true; break; }
      entry.cursors.add(cursor);
      const page = normalize(await listPage(cursor), observedAt, stamp, cursor);
      entry.pages.push(page);
      entry.nextCursor = page.nextCursor;
      if (entry.pages.reduce((n, current) => n + current.rows.length, 0) > MAX_ROWS || Buffer.byteLength(JSON.stringify(entry.pages)) > MAX_BYTES) {
        entry.pages.pop(); entry.truncated = true; break;
      }
    }
    if (entry.nextCursor === null && !entry.truncated && !entry.invalid && !entry.complete) {
      // Revisit every page identity after the scan. This detects changes away
      // from the head as well as additions at the head, without freezing writers.
      entry.verifyIndex ??= 1;
      while (entry.verifyIndex < entry.pages.length && budget-- > 0) {
        const old = entry.pages[entry.verifyIndex];
        const checked = normalize(await listPage(old.cursor), now().toISOString(), stamp, old.cursor);
        if (headKey(checked) !== headKey(old)) throw new Error('Child catalog changed during verification');
        entry.pages[entry.verifyIndex++] = checked;
      }
      if (entry.verifyIndex === entry.pages.length) {
        // A new child may arrive after this invocation's first head read.
        const finalHead = normalize(await listPage(undefined), now().toISOString(), stamp, undefined);
        if (headKey(finalHead) !== entry.headSignature) throw new Error('Child catalog changed during verification');
        entry.pages[0] = finalHead;
        entry.complete = true;
      }
    }
    entry.pending = false;
    entry.lastAccessAt = now().getTime();
    if (entry.invalid) entries.delete(key); else entries.set(key, entry);
    while (entries.size > MAX_SCOPES) entries.delete(entries.keys().next().value);
    return { rows: entry.pages.flatMap(page => page.rows), complete: entry.complete, truncated: entry.truncated, pending: false, proofs: entry.proofs, state: entry, generation: stamp };
  } catch (error) {
    entries.delete(key);
    throw error;
  } finally { lock.pending = false; }
}
