import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CACHE_LIMIT = 128;
const cache = new Map();
const EVENT_STATES = { task_started: 'working', task_complete: 'completed', turn_aborted: 'idle' };
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
};
const fingerprint = (info) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const observation = (reason, rootTurnId) => ({ state: 'unknown', basis: 'codex-rollout', observedAt: null, eventTurnId: null, ...(rootTurnId ? { rootTurnId } : {}), eventType: null, complete: false, readStable: false, reason });
const cleanId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');

/**
 * Observe recorded events for one already-verified thread and exact current turn.
 * This reports persisted events, never process liveness. No files are written.
 * `trustedRoot` and `path` must be supplied by a trusted caller, not discovered here.
 */
export async function readCodexAgentObservation({ path, trustedRoot, threadId, cwd, parentThreadId, turnId, rootTurnId, turnStartedAt, maxBytes = MAX_BYTES, maxLineBytes = maxBytes, onRead } = {}) {
  const unknown = (reason) => observation(reason, cleanId(rootTurnId) ? rootTurnId : undefined);
  if (![path, trustedRoot, cwd].every(value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')) || !cleanId(threadId) || !cleanId(parentThreadId) || !cleanId(turnId) || !cleanId(rootTurnId) || typeof turnStartedAt !== 'string' || !Number.isFinite(Date.parse(turnStartedAt)) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > maxBytes || (onRead !== undefined && typeof onRead !== 'function')) return unknown('invalid-input');
  let root, project, target;
  try {
    root = await realpath(trustedRoot);
    project = await realpath(cwd);
    target = resolve(path);
    if (!inside(root, target) || await realpath(target) !== target) return unknown('untrusted-path');
  } catch { return unknown('unavailable'); }
  const startMs = Date.parse(turnStartedAt);
  for (let attempt = 0; attempt < 2; attempt++) {
    let file;
    try {
      const entry = await lstat(target, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink()) return unknown('untrusted-path');
      file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || fingerprint(before) !== fingerprint(entry)) { if (attempt === 0) continue; return unknown('changed'); }
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return unknown('budget-exceeded');
      const size = Number(before.size);
      const cacheKey = JSON.stringify([target, root, project, fingerprint(before), threadId, parentThreadId, turnId, rootTurnId, turnStartedAt, maxBytes, maxLineBytes]);
      if (!onRead && cache.has(cacheKey)) {
        const after = await file.stat({ bigint: true });
        const current = await lstat(target, { bigint: true });
        if (fingerprint(before) === fingerprint(after) && fingerprint(after) === fingerprint(current) && current.isFile() && !current.isSymbolicLink() && await realpath(target) === target) {
          const saved = cache.get(cacheKey); cache.delete(cacheKey); cache.set(cacheKey, saved);
          return structuredClone(saved);
        }
        if (attempt === 0) continue;
        return unknown('changed');
      }
      await onRead?.({ phase: 'opened', attempt });
      const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
      const headerRead = await file.read(head, 0, head.length, 0);
      const headerEnd = head.indexOf(10);
      let invalid = headerRead.bytesRead !== head.length || headerEnd < 0;
      let header = null;
      if (!invalid) { try { header = JSON.parse(head.subarray(0, headerEnd).toString('utf8')); } catch { invalid = true; } }
      const start = Math.max(0, size - maxBytes), tailTruncated = start > 0;
      let skipping = false;
      if (tailTruncated) {
        const preceding = Buffer.alloc(1);
        const read = await file.read(preceding, 0, 1, start - 1);
        if (read.bytesRead !== 1) invalid = true;
        else skipping = preceding[0] !== 10;
      }
      const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(CHUNK_BYTES);
      let offset = start, fragment = '', fragmentBytes = 0, oversized = false, last = null, firstLine = start === 0;
      const processLine = (line) => {
        if (firstLine) { firstLine = false; return; }
        if (!line) { invalid = true; return; }
        let record;
        try { record = JSON.parse(line); } catch { invalid = true; return; }
        if (record?.type !== 'event_msg' || !Object.hasOwn(EVENT_STATES, record.payload?.type)) return;
        const event = record.payload;
        if (event.turn_id != null && event.turnId != null && event.turn_id !== event.turnId) { invalid = true; return; }
        const eventTurn = event.turn_id ?? event.turnId;
        if (eventTurn == null) {
          // A cloned child rollout can retain an untagged abort from before
          // this turn. It cannot describe the verified current turn, while an
          // untagged event inside (or without) that time fence remains unsafe.
          const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
          if (Number.isFinite(timestamp) && timestamp < startMs) return;
          invalid = true; return;
        }
        if (eventTurn !== turnId) return;
        if (event.root_turn_id != null && event.rootTurnId != null && event.root_turn_id !== event.rootTurnId) { invalid = true; return; }
        const eventRoot = event.root_turn_id ?? event.rootTurnId;
        if (eventRoot != null && eventRoot !== rootTurnId) { invalid = true; return; }
        if (event.thread_id != null && event.thread_id !== threadId) { invalid = true; return; }
        const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
        if (!Number.isFinite(timestamp) || timestamp < startMs || (last && timestamp < Date.parse(last.observedAt))) { invalid = true; return; }
        last = { state: EVENT_STATES[event.type], observedAt: new Date(timestamp).toISOString(), eventType: event.type };
      };
      while (offset < size) {
        const requested = Math.min(buffer.length, size - offset);
        const { bytesRead } = await file.read(buffer, 0, requested, offset);
        if (!bytesRead) { invalid = true; break; }
        offset += bytesRead;
        let text = decoder.write(buffer.subarray(0, bytesRead));
        if (skipping) {
          const newline = text.indexOf('\n');
          if (newline < 0) continue;
          text = text.slice(newline + 1); skipping = false;
        }
        fragment += text;
        fragmentBytes += Buffer.byteLength(text);
        let newline;
        while ((newline = fragment.indexOf('\n')) >= 0) {
          const line = fragment.slice(0, newline); fragment = fragment.slice(newline + 1);
          const lineBytes = Buffer.byteLength(line);
          fragmentBytes -= lineBytes + 1;
          if (lineBytes > maxLineBytes) oversized = true; else processLine(line);
        }
        if (fragmentBytes > maxLineBytes) { oversized = true; break; }
      }
      fragment += decoder.end();
      const partialEof = fragment.length > 0 || skipping;
      await onRead?.({ phase: 'scanned', attempt });
      const after = await file.stat({ bigint: true });
      const current = await lstat(target, { bigint: true });
      if (fingerprint(before) !== fingerprint(after) || fingerprint(after) !== fingerprint(current) || !current.isFile() || current.isSymbolicLink() || await realpath(target) !== target) {
        if (attempt === 0) continue;
        return unknown('changed');
      }
      if (oversized) return unknown('line-budget-exceeded');
      if (partialEof) { if (attempt === 0) continue; return unknown('incomplete-or-invalid'); }
      if (invalid) return unknown('incomplete-or-invalid');
      const meta = header?.type === 'session_meta' ? header.payload : null;
      if (!meta || meta.id !== threadId || typeof meta.cwd !== 'string' || !isAbsolute(meta.cwd)) return unknown('identity-mismatch');
      let metaCwd;
      try { metaCwd = await realpath(meta.cwd); } catch { return unknown('identity-mismatch'); }
      if (metaCwd !== project) return unknown('identity-mismatch');
      const spawn = meta.source?.subAgent?.thread_spawn ?? meta.source?.subagent?.thread_spawn;
      if (spawn?.parent_thread_id != null && spawn.parent_thread_id !== parentThreadId) return unknown('identity-mismatch');
      const result = last
        ? { ...last, basis: 'codex-rollout', eventTurnId: turnId, rootTurnId, complete: true, readStable: true, reason: null, tailTruncated }
        : { ...unknown(tailTruncated ? 'outside-window-or-unobserved' : 'no-current-event'), complete: !tailTruncated, readStable: true, tailTruncated };
      if (!onRead) {
        cache.set(cacheKey, structuredClone(result));
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      }
      return result;
    } catch (error) {
      if (attempt === 0 && ['ENOENT', 'ELOOP'].includes(error?.code)) continue;
      return unknown(error?.code === 'ENOENT' || error?.code === 'ELOOP' ? 'changed' : 'unavailable');
    } finally { await file?.close(); }
  }
  return unknown('changed');
}
