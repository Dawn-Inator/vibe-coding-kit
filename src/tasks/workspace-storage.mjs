import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { atomicCreateFile, ensurePrivateDirectory } from './task-io.mjs';
import { inspectMarkdownRecordsIdentity, readMarkdownRecords, withMarkdownLock, writeMarkdownRecords } from './markdown-records.mjs';
import { TaskStore, TaskStoreError, taskMarkdownPaths } from './task-store.mjs';
import { resolveTaskProgressStorage } from '../contracts/task-progress-storage.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const missing = (error) => error?.code === 'ENOENT';
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
}

/** Routes and task history are durable Markdown records under the helper-owned app root. */
export class WorkspaceTaskStorage {
  #legacyRoot;
  #schemas;
  #resolveContract;
  #contexts = new Map();
  #closed = false;

  constructor(legacyAppRoot, { schemas, resolveContract } = {}) {
    this.#legacyRoot = resolve(legacyAppRoot);
    this.#schemas = schemas;
    this.#resolveContract = resolveContract;
  }

  async #contract(cwd) {
    let resolved;
    let source = 'pinned-vibe-coding-kit';
    if (this.#resolveContract) {
      const result = await this.#resolveContract(cwd);
      resolved = result?.contract;
      source = result?.source ?? source;
    } else resolved = resolveTaskProgressStorage({ cwd });
    const contract = resolved;
    const expected = resolveTaskProgressStorage({ cwd });
    const validRoots = contract?.cwd === expected.cwd && contract?.mode === 'workspace' &&
      contract?.workspaceRoot === expected.workspaceRoot && contract?.storageRoot === expected.storageRoot &&
      (contract?.schemaVersion === 1 || contract?.schemaVersion === 2);
    if (!validRoots || (contract.schemaVersion === 2 && contract.cacheRoot !== expected.cacheRoot))
      throw new TaskStoreError('TASK_STORAGE_CONTRACT_INVALID', 'Kit storage contract is incompatible or contains untrusted paths');
    // Version 1 remains compatible only for the exact known project roots; cache location is normalized.
    return { contract: Object.freeze({ ...expected, ...contract, cacheRoot: expected.cacheRoot }), source };
  }

  #routingPath() { return resolve(this.#legacyRoot, 'task-routing/taskhistory.md'); }
  #routeIdentity(threadId) { return `workspace-routing:${digest(threadId)}`; }

  async #routes() {
    const history = await readMarkdownRecords(this.#routingPath(), { kind: 'task-workspace-routing', identity: 'workspace-routing' });
    const latest = new Map();
    for (const record of history.records) {
      const key = typeof record?.threadId === 'string' ? digest(record.threadId) : '';
      if (!record || typeof record !== 'object' || typeof record.threadId !== 'string' || !record.threadId.trim() ||
          typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || typeof record.root !== 'string' || !isAbsolute(record.root) ||
          record.root !== resolve(record.cwd, '.workspace/codex-task-progress') || record.identity !== this.#routeIdentity(record.threadId) ||
          record.taskhistoryPath !== resolve(record.root, 'tasks/v3', key, 'taskhistory.md') ||
          record.heartbeatPath !== resolve(record.root, 'tasks/v3', key, 'heartbeat.md') ||
          record.cacheRoot !== resolve(record.cwd, '.tmp/codex-task-progress', key))
        throw new TaskStoreError('TASK_STORAGE_ROUTING_INVALID', 'Persistent workspace routing history is invalid');
      latest.set(record.threadId, record);
    }
    return latest;
  }

  async #legacyRoute(threadId) {
    const path = resolve(this.#legacyRoot, 'workspace-storage-index.json');
    const text = await optionalText(path);
    if (text === null) return null;
    let value;
    try { value = JSON.parse(text); } catch { throw new TaskStoreError('TASK_STORAGE_INDEX_INVALID', 'Legacy workspace storage index is invalid'); }
    const key = digest(threadId);
    const entry = value?.schemaVersion === 1 ? value.entries?.[key] : null;
    if (!entry) return null;
    if (entry.threadId !== threadId || !isAbsolute(entry.cwd) || entry.root !== resolve(entry.cwd, '.workspace/codex-task-progress'))
      throw new TaskStoreError('TASK_STORAGE_INDEX_INVALID', 'Legacy workspace storage entry is invalid');
    let canonicalCwd;
    try {
      canonicalCwd = await realpath(entry.cwd);
      if (!(await stat(canonicalCwd)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new TaskStoreError('TASK_STORAGE_INDEX_INVALID', 'Legacy workspace storage cwd is unavailable');
    }
    // The old index may contain a valid lexical alias (for example macOS /var -> /private/var).
    // Its root must still be exactly derived from that cwd; normalize it before routing so
    // arbitrary absolute source roots never become trusted migration inputs.
    return {
      threadId,
      identity: this.#routeIdentity(threadId),
      cwd: canonicalCwd,
      root: resolve(canonicalCwd, '.workspace/codex-task-progress'),
      source: 'legacy-index',
    };
  }

  // Observe only known task directories. Never resolve a chat context here: doing so
  // acquires a lock and can migrate records or create project directories.
  async #hasTask(root, threadId) {
    try {
      const paths = taskMarkdownPaths(root, threadId);
      const canonicalRoot = await realpath(root);
      if (await realpath(paths.directory) !== resolve(canonicalRoot, 'tasks/v3', digest(threadId))) return false;
      for (const path of [paths.history, paths.heartbeat, paths.legacyEvents]) {
        try { if (await realpath(path) !== resolve(canonicalRoot, 'tasks/v3', digest(threadId), basename(path))) return false; }
        catch (error) { if (!missing(error)) return false; }
      }
      const loaded = await new TaskStore(root, { schemas: this.#schemas }).load(threadId, { persist: false });
      return loaded.events.length > 0 || loaded.records.some((r) => r.type === 'source-binding' && r.binding !== null);
    } catch { return false; }
  }

  async #legacyThreadIds() {
    const base = resolve(this.#legacyRoot, 'tasks/v3');
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); } catch { return []; }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const dir = resolve(base, entry.name);
      try {
        // The authoritative parser and TaskStore validate the candidate below. This
        // preliminary read only discovers the identity hidden by the directory hash.
        const idFromMarkdown = await inspectMarkdownRecordsIdentity(resolve(dir, 'taskhistory.md'), { kind: 'task-progress' });
        let id = idFromMarkdown;
        if (id === null) {
          const legacy = await optionalText(resolve(dir, 'events.jsonl'));
          if (legacy) id = JSON.parse(legacy.split('\n')[0])?.threadId;
        }
        if (typeof id === 'string' && id.trim() && id.length <= 512 && digest(id) === entry.name) ids.push(id);
      } catch { /* Corrupt or incomplete candidates are not evidence. */ }
    }
    return ids;
  }

  /** Startup eligibility hint. Project routes are verified lazily when their chat opens. */
  async hasRecoverableTasks() {
    if (this.#closed) throw new TaskStoreError('TASK_STORAGE_CLOSED', 'Workspace storage is closed');
    for (const id of await this.#legacyThreadIds()) if (await this.#hasTask(this.#legacyRoot, id)) return true;
    let routes;
    try { routes = await this.#routes(); } catch { routes = new Map(); }
    // The Helper-owned route is only an eligibility hint; even an empty or
    // missing workspace may justify attempting a visible-chat reattachment.
    // Actual task/source authority stays with forThread and TaskStore validation.
    if (routes.size > 0) return true;
    try {
      const text = await optionalText(resolve(this.#legacyRoot, 'workspace-storage-index.json'));
      if (text === null) return false;
      const index = JSON.parse(text);
      if (index?.schemaVersion !== 1 || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) return false;
      for (const [key, entry] of Object.entries(index.entries)) {
        if (typeof entry?.threadId !== 'string' || !entry.threadId.trim() || entry.threadId.length > 512 || digest(entry.threadId) !== key) continue;
        // Match the legacy route's lexical shape without accessing its cwd.
        if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) ||
            typeof entry.root !== 'string' ||
            entry.root !== resolve(entry.cwd, '.workspace/codex-task-progress')) continue;
        return true;
      }
    } catch { /* Missing or corrupt index is not evidence. */ }
    return false;
  }

  async #saveRoute(route) {
    const path = this.#routingPath();
    const data = await readMarkdownRecords(path, { kind: 'task-workspace-routing', identity: 'workspace-routing' });
    const records = data.records;
    const previous = [...records].reverse().find((record) => record?.threadId === route.threadId);
    if (previous?.cwd === route.cwd && previous?.root === route.root) return false;
    await ensurePrivateDirectory(dirname(path));
    await writeMarkdownRecords(path, { kind: 'task-workspace-routing', identity: 'workspace-routing', records: [...records, route] });
    return true;
  }

  async forThread(threadId, cwd) {
    if (this.#closed) throw new TaskStoreError('TASK_STORAGE_CLOSED', 'Workspace storage is closed');
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 512)
      throw new TaskStoreError('TASK_THREAD_INVALID', 'A verified thread ID is required');
    if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd))
      throw new TaskStoreError('TASK_WORKSPACE_INVALID', 'A trusted absolute chat working directory is required');
    let canonical;
    try { canonical = await realpath(cwd); if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory'); }
    catch (error) { throw new TaskStoreError('TASK_WORKSPACE_INVALID', `Chat working directory is unavailable: ${errorMessage(error)}`); }
    const cached = this.#contexts.get(threadId);
    if (cached?.storage.cwd === canonical) return cached;
    return withMarkdownLock(this.#routingPath(), async () => {
      if (this.#closed) throw new TaskStoreError('TASK_STORAGE_CLOSED', 'Workspace storage is closed');
      const again = this.#contexts.get(threadId);
      if (again?.storage.cwd === canonical) return again;
      try {
        const { contract, source: contractSource } = await this.#contract(canonical);
        for (const directory of [contract.workspaceRoot, contract.storageRoot]) {
          const info = await stat(directory).catch((error) => missing(error) ? null : Promise.reject(error));
          if (info && !info.isDirectory()) throw new TaskStoreError('TASK_WORKSPACE_UNWRITABLE', `Workspace directory is blocked by a file: ${directory}`);
        }
        const key = digest(threadId);
        const taskDirectory = resolve(contract.storageRoot, 'tasks/v3', key);
        const cacheRoot = resolve(contract.cacheRoot, key);
        const taskPaths = taskMarkdownPaths(contract.storageRoot, threadId);
        const targetHasLegacyHistory = Boolean(await stat(taskPaths.legacyEvents).catch((error) => missing(error) ? null : Promise.reject(error)));
        let prepared = false;
        const ensureWritable = async () => {
          if (prepared) return;
          try {
            await ensurePrivateDirectory(contract.storageRoot);
            await atomicCreateFile(resolve(contract.storageRoot, '.gitignore'), '*\n');
            prepared = true;
          } catch (error) { throw new TaskStoreError('TASK_WORKSPACE_UNWRITABLE', `Cannot write task records to ${contract.storageRoot}: ${errorMessage(error)}`); }
        };
        const routes = await this.#routes();
        let prior = routes.get(threadId);
        if (!prior) prior = await this.#legacyRoute(threadId);
        const sourceRoot = prior?.root ?? this.#legacyRoot;
        let migrated = false;
        const taskStore = new TaskStore(contract.storageRoot, { schemas: this.#schemas });
        if (targetHasLegacyHistory) await ensureWritable();
        if (sourceRoot !== contract.storageRoot) {
          const sourceDirectory = resolve(sourceRoot, 'tasks/v3', key);
          const sourceExists = (await stat(sourceDirectory).catch((error) => missing(error) ? null : Promise.reject(error)))?.isDirectory();
          if (sourceExists) {
            await ensureWritable();
            migrated = (await taskStore.importFrom(threadId, sourceDirectory, { includeBindings: false })).migrated;
          }
        }
        // Old heartbeat locations are exposed as direct roots so the association API can import
        // only records related to this chat. On a project move, previous-project bindings are excluded.
        const legacyHeartbeatRoots = [];
        if (prior && prior.cwd === canonical) {
          legacyHeartbeatRoots.push(resolve(prior.root, 'sessions', key, 'heartbeat'));
        } else if (!prior) {
          legacyHeartbeatRoots.push(resolve(this.#legacyRoot, 'tasks/heartbeat'), resolve(this.#legacyRoot, 'heartbeat'));
        }
        const taskhistoryPath = taskPaths.history;
        const heartbeatPath = taskPaths.heartbeat;
        const existing = await taskStore.get(threadId);
        if (existing) await ensureWritable();
        const context = {
          taskStore,
          storage: {
            mode: 'workspace', cwd: canonical, root: contract.storageRoot, taskDirectory,
            heartbeatDirectory: resolve(contract.storageRoot, 'tasks/v3', key), migrated,
            ...(migrated ? { source: sourceRoot } : {}), contractSource,
            taskhistoryPath, historyPath: taskhistoryPath, heartbeatPath, cacheRoot,
          },
          taskhistoryPath,
          heartbeatPath,
          cacheRoot,
          legacyHeartbeatRoots,
          ensureWritable,
        };
        const route = { threadId, identity: this.#routeIdentity(threadId), cwd: canonical, root: contract.storageRoot, taskhistoryPath, heartbeatPath, cacheRoot };
        await this.#saveRoute(route);
        this.#contexts.set(threadId, context);
        return context;
      } catch (error) {
        if (error instanceof TaskStoreError) throw error;
        throw new TaskStoreError('TASK_WORKSPACE_STORAGE_FAILED', `Workspace task routing failed: ${errorMessage(error)}`);
      }
    });
  }

  close() { this.#closed = true; this.#contexts.clear(); }
}
