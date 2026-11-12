import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTaskProgressStorage } from "vibe-coding-kit/src/contracts/task-progress-storage.mjs";
import {
  atomicCreateFile,
  atomicWriteFile,
  ensurePrivateDirectory,
} from "../../store/src/atomic.js";
import { type HeartbeatOptions, HeartbeatService } from "./heartbeat.js";
import { TaskStore, TaskStoreError } from "./task-store.js";

export interface WorkspaceTaskStorageOptions {
  /** Exact module paths or Kit roots. An empty array selects the pinned bundled contract. */
  kitPaths?: readonly string[];
  heartbeat?: HeartbeatOptions;
}
export interface WorkspaceTaskStorageLocation {
  mode: "workspace";
  cwd: string;
  root: string;
  taskDirectory: string;
  heartbeatDirectory: string;
  migrated: boolean;
  source?: string;
  contractSource: string;
}
export interface WorkspaceTaskStorageContext {
  taskStore: TaskStore;
  heartbeat: HeartbeatService;
  storage: WorkspaceTaskStorageLocation;
  /** Prepare the private, self-ignored directory before a model mutation or explicit binding. */
  ensureWritable(): Promise<void>;
}
interface IndexEntry {
  threadId: string;
  cwd: string;
  root: string;
}
interface StorageIndex {
  schemaVersion: 1;
  entries: Record<string, IndexEntry>;
}
interface StorageContract {
  schemaVersion: number;
  mode: string;
  cwd: string;
  workspaceRoot: string;
  storageRoot: string;
}
const queues = new Map<string, Promise<unknown>>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(key, result);
  try {
    return await result;
  } finally {
    if (queues.get(key) === result) queues.delete(key);
  }
}
function validateContract(value: unknown, cwd: string): StorageContract {
  const contract = value as Partial<StorageContract> | null;
  if (
    contract?.schemaVersion !== 1 ||
    contract.mode !== "workspace" ||
    contract.cwd !== cwd ||
    contract.workspaceRoot !== resolve(cwd, ".workspace") ||
    contract.storageRoot !== resolve(cwd, ".workspace", "codex-task-progress")
  )
    throw new TaskStoreError(
      "TASK_STORAGE_CONTRACT_INVALID",
      "Kit storage contract is incompatible",
    );
  return contract as StorageContract;
}

/** The Helper owns routing and writes; cwd is accepted only from verified native chat identity. */
export class WorkspaceTaskStorage {
  readonly #legacyRoot: string;
  readonly #options: WorkspaceTaskStorageOptions;
  readonly #contexts = new Map<string, WorkspaceTaskStorageContext>();
  #closed = false;

  constructor(legacyAppRoot: string, options: WorkspaceTaskStorageOptions = {}) {
    this.#legacyRoot = resolve(legacyAppRoot);
    this.#options = options;
  }

  async #contract(cwd: string): Promise<{ contract: StorageContract; source: string }> {
    let configured: string | undefined;
    if (this.#options.kitPaths === undefined) {
      const text = await optionalText(resolve(cwd, ".codex-task-progress.json"));
      if (text !== null) {
        const document = JSON.parse(text) as { heartbeat?: { kitPath?: unknown } };
        if (typeof document.heartbeat?.kitPath === "string")
          configured = resolve(cwd, document.heartbeat.kitPath);
      }
    }
    const candidates = this.#options.kitPaths ?? [
      resolve(cwd, ".vibe-coding/kit"),
      ...(configured ? [configured] : []),
      resolve(homedir(), "Workspace/Project/vibe-coding-kit"),
    ];
    for (const candidate of candidates) {
      const absolute = resolve(cwd, candidate);
      const info = await stat(absolute).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!info) continue;
      const modulePath = info.isDirectory()
        ? resolve(absolute, "src/contracts/task-progress-storage.mjs")
        : absolute.endsWith("heartbeat-ledger-api.mjs")
          ? resolve(dirname(absolute), "../contracts/task-progress-storage.mjs")
          : absolute;
      if (!(await stat(modulePath).catch(() => null))?.isFile()) continue;
      const imported = await import(pathToFileURL(modulePath).href);
      if (typeof imported.resolveTaskProgressStorage !== "function")
        throw new TaskStoreError(
          "TASK_STORAGE_CONTRACT_INVALID",
          "Kit storage resolver is missing",
        );
      return {
        contract: validateContract(imported.resolveTaskProgressStorage({ cwd }), cwd),
        source: modulePath,
      };
    }
    return {
      contract: validateContract(resolveTaskProgressStorage({ cwd }), cwd),
      source: "pinned-vibe-coding-kit",
    };
  }

  async #index(): Promise<StorageIndex> {
    const text = await optionalText(resolve(this.#legacyRoot, "workspace-storage-index.json"));
    if (text === null) return { schemaVersion: 1, entries: {} };
    try {
      const value = JSON.parse(text) as StorageIndex;
      if (
        value.schemaVersion !== 1 ||
        !value.entries ||
        typeof value.entries !== "object" ||
        Array.isArray(value.entries)
      )
        throw new Error("shape");
      for (const [key, entry] of Object.entries(value.entries)) {
        if (
          !entry ||
          typeof entry.threadId !== "string" ||
          digest(entry.threadId) !== key ||
          typeof entry.cwd !== "string" ||
          !isAbsolute(entry.cwd) ||
          entry.root !== resolve(entry.cwd, ".workspace", "codex-task-progress")
        )
          throw new Error("entry");
      }
      return value;
    } catch {
      throw new TaskStoreError(
        "TASK_STORAGE_INDEX_INVALID",
        "Workspace storage index is invalid; no records were overwritten",
      );
    }
  }

  async #migrateFile(
    source: string,
    destination: string,
    prepare: () => Promise<void>,
    history = false,
  ): Promise<boolean> {
    const original = await optionalText(source);
    if (original === null) return false;
    const existing = await optionalText(destination);
    if (existing !== null) {
      if (history && !existing.startsWith(original))
        throw new TaskStoreError(
          "TASK_STORAGE_DIVERGED",
          "Workspace and previous task histories differ; both copies were preserved",
        );
      return false;
    }
    await prepare();
    const created = await atomicCreateFile(destination, original);
    if (!created && history) {
      const current = await optionalText(destination);
      if (current === null || !current.startsWith(original))
        throw new TaskStoreError(
          "TASK_STORAGE_DIVERGED",
          "Workspace task history changed during migration; no records were overwritten",
        );
    }
    return created;
  }

  async forThread(threadId: string, cwd: string): Promise<WorkspaceTaskStorageContext> {
    if (this.#closed)
      throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
    if (!threadId.trim() || threadId.length > 512)
      throw new TaskStoreError("TASK_THREAD_INVALID", "A verified thread ID is required");
    if (typeof cwd !== "string" || !cwd.trim() || !isAbsolute(cwd))
      throw new TaskStoreError(
        "TASK_WORKSPACE_INVALID",
        "A trusted absolute chat working directory is required",
      );
    let canonical: string;
    try {
      canonical = await realpath(cwd);
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new TaskStoreError(
        "TASK_WORKSPACE_INVALID",
        `Chat working directory is unavailable: ${message(error)}`,
      );
    }
    const previousContext = this.#contexts.get(threadId);
    if (previousContext?.storage.cwd === canonical) return previousContext;
    return serialize(resolve(this.#legacyRoot, "workspace-storage-index.json"), async () => {
      if (this.#closed)
        throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
      const cached = this.#contexts.get(threadId);
      if (cached?.storage.cwd === canonical) return cached;
      try {
        const { contract, source: contractSource } = await this.#contract(canonical);
        const root = contract.storageRoot;
        for (const directory of [contract.workspaceRoot, root]) {
          const info = await stat(directory).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          });
          if (info && !info.isDirectory())
            throw new TaskStoreError(
              "TASK_WORKSPACE_UNWRITABLE",
              `Workspace directory is blocked by a file: ${directory}`,
            );
        }
        const key = digest(threadId);
        const taskDirectory = resolve(root, "tasks/v3", key);
        const heartbeatBase = resolve(root, "sessions", key);
        const heartbeatDirectory = resolve(heartbeatBase, "heartbeat");
        let prepared = false;
        const ensureWritable = async () => {
          if (prepared) return;
          try {
            await ensurePrivateDirectory(root);
            await atomicCreateFile(resolve(root, ".gitignore"), "*\n");
            prepared = true;
          } catch (error) {
            throw new TaskStoreError(
              "TASK_WORKSPACE_UNWRITABLE",
              `Cannot write task records to ${root}: ${message(error)}`,
            );
          }
        };
        const index = await this.#index();
        const entry = index.entries[key];
        const sourceRoot = entry?.root ?? this.#legacyRoot;
        let migrated = false;
        if (sourceRoot !== root) {
          const sourceTasks = resolve(sourceRoot, "tasks/v3", key);
          migrated = await this.#migrateFile(
            resolve(sourceTasks, "events.jsonl"),
            resolve(taskDirectory, "events.jsonl"),
            ensureWritable,
            true,
          );
          // A snapshot is optional and derived. Only copy it alongside a newly imported log.
          if (migrated)
            await this.#migrateFile(
              resolve(sourceTasks, "snapshot.json"),
              resolve(taskDirectory, "snapshot.json"),
              ensureWritable,
            );
          // A cwd change transfers task history, never another project's ledger association.
          if (!entry || entry.cwd === canonical) {
            const sourceHeartbeat = entry
              ? resolve(sourceRoot, "sessions", key, "heartbeat")
              : resolve(sourceRoot, "heartbeat");
            for (const suffix of [".jsonl", ".snapshot.json"]) {
              migrated =
                (await this.#migrateFile(
                  resolve(sourceHeartbeat, key + suffix),
                  resolve(heartbeatDirectory, key + suffix),
                  ensureWritable,
                )) || migrated;
            }
            const bindingsText = await optionalText(resolve(sourceHeartbeat, "bindings.json"));
            if (bindingsText !== null) {
              const bindings = JSON.parse(bindingsText) as Record<string, unknown>;
              const binding = bindings[threadId];
              if (typeof binding === "string" || binding === null) {
                await ensureWritable();
                migrated =
                  (await atomicCreateFile(
                    resolve(heartbeatDirectory, "bindings.json"),
                    `${JSON.stringify({ [threadId]: binding })}\n`,
                  )) || migrated;
              }
            }
          }
        }
        const taskStore = new TaskStore(root);
        // Validate migrated/previous workspace identity and rebuild the derived snapshot there.
        const current = await taskStore.get(threadId);
        if (current) await ensureWritable();
        const heartbeat = new HeartbeatService(heartbeatBase, this.#options.heartbeat);
        const context: WorkspaceTaskStorageContext = {
          taskStore,
          heartbeat,
          storage: {
            mode: "workspace",
            cwd: canonical,
            root,
            taskDirectory,
            heartbeatDirectory,
            migrated,
            ...(migrated ? { source: sourceRoot } : {}),
            contractSource,
          },
          ensureWritable,
        };
        index.entries[key] = { threadId, cwd: canonical, root };
        await atomicWriteFile(
          resolve(this.#legacyRoot, "workspace-storage-index.json"),
          `${JSON.stringify(index)}\n`,
        );
        cached?.heartbeat.close();
        this.#contexts.set(threadId, context);
        return context;
      } catch (error) {
        if (error instanceof TaskStoreError) throw error;
        throw new TaskStoreError(
          "TASK_WORKSPACE_STORAGE_FAILED",
          `Workspace task routing failed: ${message(error)}`,
        );
      }
    });
  }

  close(): void {
    this.#closed = true;
    for (const context of this.#contexts.values()) context.heartbeat.close();
    this.#contexts.clear();
  }
}
