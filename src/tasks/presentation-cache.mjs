import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { serialize } from 'node:v8';

// Never retain arbitrary loader errors: they can carry large payloads or causes.
function boundedError(error) {
  let name = 'Error';
  let message = 'Snapshot loader failed';
  let code;
  try {
    if (typeof error === 'string') message = error.slice(0, 1000);
    else if (error && typeof error === 'object') {
      if (typeof error.name === 'string') name = error.name.slice(0, 100);
      if (typeof error.message === 'string') message = error.message.slice(0, 1000);
      if (typeof error.code === 'string') code = error.code.slice(0, 100);
      else if (typeof error.code === 'number' && Number.isFinite(error.code)) code = error.code;
    }
  } catch { /* hostile accessors must not escape the rejection handler */ }
  const result = new Error(message);
  result.name = name;
  if (code !== undefined) result.code = code;
  return result;
}

/** Display-only cache. Keys must come from a verified host; never use it as authority. */
export class ReadOnlySnapshotCache {
  #entries = new Map();
  #bytes = 0;
  #inFlight = 0;
  #maxEntries;
  #maxBytes;
  #maxEntryBytes;
  #now;

  constructor({ maxEntries = 16, maxBytes = 4 * 1024 * 1024, maxEntryBytes = 512 * 1024, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ maxEntries, maxBytes, maxEntryBytes })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
    this.#maxEntryBytes = maxEntryBytes;
    this.#now = now;
  }

  #touch(key, entry) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #remove(key) {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#bytes -= entry.bytes;
      this.#entries.delete(key);
    }
  }

  #fit() {
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      this.#remove(this.#entries.keys().next().value);
    }
  }

  #snapshot(entry) {
    return {
      value: entry?.hasValue ? structuredClone(entry.value) : null,
      pending: entry?.pending ?? false,
      error: entry?.error ? boundedError(entry.error) : null,
      updatedAt: entry?.updatedAt ?? null,
    };
  }

  peek(key) {
    const entry = this.#entries.get(key);
    if (entry) this.#touch(key, entry);
    return this.#snapshot(entry);
  }

  read(key, loader) {
    let entry = this.#entries.get(key);
    if (!entry && this.#maxEntries > 0) {
      entry = { value: null, hasValue: false, bytes: 0, pending: false, error: null, updatedAt: null };
      this.#entries.set(key, entry);
      this.#fit();
    }
    if (!entry) return this.#snapshot(null);
    this.#touch(key, entry);
    if (!entry.pending && this.#inFlight < this.#maxEntries) {
      entry.pending = true;
      this.#inFlight += 1;
      // The entry object is the generation token. Eviction, deletion, or set
      // replaces it, so a late result can never repopulate a newer generation.
      Promise.resolve().then(loader).then((value) => {
        if (this.#entries.get(key) !== entry) return;
        const clone = structuredClone(value);
        const bytes = serialize(clone).byteLength;
        entry.pending = false;
        if (bytes > this.#maxEntryBytes || bytes > this.#maxBytes) {
          entry.error = new RangeError('Snapshot exceeds cache size limit');
          return;
        }
        entry.error = null;
        this.#bytes += bytes - entry.bytes;
        entry.value = clone;
        entry.hasValue = true;
        entry.bytes = bytes;
        entry.updatedAt = this.#now();
        this.#touch(key, entry);
        this.#fit();
      }).catch((error) => {
        if (this.#entries.get(key) !== entry) return;
        entry.pending = false;
        entry.error = boundedError(error);
      }).finally(() => { this.#inFlight -= 1; });
    }
    return this.#snapshot(entry);
  }

  set(key, value) {
    // Clone and size before invalidating the previous generation if cloning fails.
    const clone = structuredClone(value);
    const bytes = serialize(clone).byteLength;
    this.#remove(key);
    if (!this.#maxEntries || bytes > this.#maxEntryBytes || bytes > this.#maxBytes) return;
    this.#entries.set(key, { value: clone, hasValue: true, bytes, pending: false, error: null, updatedAt: this.#now() });
    this.#bytes += bytes;
    this.#fit();
  }

  delete(key) { this.#remove(key); }
  clear() { this.#entries.clear(); this.#bytes = 0; }
}

/** Scope only canonical, verified host inputs. This does not resolve paths or access the filesystem. */
export function taskPresentationScope({ threadId, cwd, projectRoot }) {
  if (typeof threadId !== 'string' || !threadId.trim() || typeof cwd !== 'string' || !isAbsolute(cwd) || typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new TypeError('threadId must be nonblank and cwd and projectRoot must be absolute paths');
  }
  return createHash('sha256').update(JSON.stringify([threadId, cwd, projectRoot])).digest('hex');
}
