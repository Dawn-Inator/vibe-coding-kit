import { realpath } from 'node:fs/promises';
import { TaskStore } from './task-store.mjs';

export async function collectSubagentProgress({ parentThreadId, cwd, storageRoot, schemas, listPage, now = () => new Date() }) {
  const observedAt = now().toISOString();
  const snapshot = { schemaVersion: 1, parentThreadId, observedAt, status: 'ready', runningCount: null, runningBasis: 'unknown', agents: [], complete: true, truncated: false };
  let cursor;
  const seen = new Set();
  const canonicalCwd = await realpath(cwd);
  const store = new TaskStore(storageRoot, { schemas });
  try {
    for (let page = 0; page < 4; page++) {
      const result = await listPage(cursor);
      if (!result || !Array.isArray(result.data) || result.data.length > 50) throw new Error('Invalid child page');
      for (const child of result.data) {
        if (!child || typeof child.id !== 'string' || !child.id || child.id.length > 256 || child.parentThreadId !== parentThreadId || seen.has(child.id)) { snapshot.complete = false; continue; }
        seen.add(child.id);
        if (snapshot.agents.length >= 100) { snapshot.complete = false; snapshot.truncated = true; break; }
        const entry = { id: child.id, name: String(child.name || child.agentNickname || child.agentRole || child.id).slice(0, 200), state: 'unknown', observedAt, progress: null, progressBasis: null };
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
      if (snapshot.truncated) break;
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) { snapshot.complete = false; break; }
      cursor = result.nextCursor;
      if (page === 3) { snapshot.complete = false; snapshot.truncated = true; }
    }
  } catch { snapshot.complete = false; snapshot.status = snapshot.agents.length ? 'partial' : 'unavailable'; }
  if (!snapshot.complete && snapshot.status === 'ready') snapshot.status = 'partial';
  return snapshot;
}
