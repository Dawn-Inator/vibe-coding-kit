import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTaskProgressStorage } from "vibe-coding-kit/src/contracts/task-progress-storage.mjs";
import { HeartbeatDiscoveryIndex } from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import { createTaskProgressSchemas } from "vibe-coding-kit/src/tasks/task-contract.mjs";
import type { WorkspaceTaskStorageContext as KitWorkspaceContext } from "vibe-coding-kit/src/tasks/workspace-storage.mjs";
import { z } from "zod";
import { type HeartbeatOptions, HeartbeatProjectViewCache, HeartbeatService } from "./heartbeat.js";
import { TaskStoreError } from "./task-store.js";

export interface WorkspaceTaskStorageOptions {
  /** Exact Kit module paths or Kit roots. Primarily used by isolated fixtures. */
  kitPaths?: readonly string[];
  heartbeat?: HeartbeatOptions;
}
export type WorkspaceTaskStorageLocation = KitWorkspaceContext["storage"];
export type WorkspaceTaskStorageContext = KitWorkspaceContext & {
  heartbeat: HeartbeatService;
};
type KitWorkspace = InstanceType<
  typeof import("vibe-coding-kit/src/tasks/workspace-storage.mjs").WorkspaceTaskStorage
>;
const schemas = createTaskProgressSchemas(z);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Thin plugin adapter: Kit owns storage routing, migration, task history, and source relations. */
export class WorkspaceTaskStorage {
  readonly #legacyRoot: string;
  readonly #options: WorkspaceTaskStorageOptions;
  readonly #contexts = new Map<string, WorkspaceTaskStorageContext>();
  readonly #projectViewCache = new HeartbeatProjectViewCache();
  readonly #discoveryIndex = new HeartbeatDiscoveryIndex();
  #kit?: KitWorkspace;
  #closed = false;

  constructor(legacyAppRoot: string, options: WorkspaceTaskStorageOptions = {}) {
    this.#legacyRoot = resolve(legacyAppRoot);
    this.#options = options;
  }

  async #adapter(): Promise<KitWorkspace> {
    if (this.#kit) return this.#kit;
    const api = await import("vibe-coding-kit/src/tasks/workspace-storage.mjs");
    if (this.#closed)
      throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
    if (typeof api.WorkspaceTaskStorage !== "function")
      throw new TaskStoreError(
        "TASK_STORAGE_CONTRACT_INVALID",
        "Kit workspace storage adapter is missing",
      );
    const resolveContract = async (cwd: string) => {
      let configured: string | undefined;
      if (!this.#options.kitPaths) {
        try {
          const config = JSON.parse(
            await readFile(resolve(cwd, ".codex-task-progress.json"), "utf8"),
          ) as {
            heartbeat?: { kitPath?: unknown };
          };
          if (typeof config.heartbeat?.kitPath === "string")
            configured = resolve(cwd, config.heartbeat.kitPath);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      const contractCandidates = this.#options.kitPaths ?? [
        resolve(cwd, ".vibe-coding/kit"),
        ...(configured ? [configured] : []),
      ];
      for (const candidate of contractCandidates) {
        const absolute = resolve(cwd, candidate);
        const contractPath = absolute.endsWith("task-progress-storage.mjs")
          ? absolute
          : absolute.endsWith("heartbeat-ledger-api.mjs")
            ? resolve(absolute, "../../contracts/task-progress-storage.mjs")
            : resolve(absolute, "src/contracts/task-progress-storage.mjs");
        if (!(await stat(contractPath).catch(() => null))?.isFile()) continue;
        const contractApi = await import(pathToFileURL(contractPath).href);
        if (typeof contractApi.resolveTaskProgressStorage !== "function") continue;
        return {
          contract: contractApi.resolveTaskProgressStorage({ cwd }),
          source: contractPath,
        };
      }
      return {
        contract: resolveTaskProgressStorage({ cwd }),
        source: "pinned-vibe-coding-kit",
      };
    };
    this.#kit = new api.WorkspaceTaskStorage(this.#legacyRoot, {
      schemas,
      resolveContract,
    });
    return this.#kit;
  }

  async forThread(threadId: string, cwd: string): Promise<WorkspaceTaskStorageContext> {
    if (this.#closed)
      throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
    const kit = await this.#adapter();
    const context = await kit.forThread(threadId, cwd);
    if (this.#closed)
      throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
    const cached = this.#contexts.get(threadId);
    // Kit canonicalizes cwd. Reuse the plugin-owned service for symlink aliases of the
    // same workspace, and release it only after Kit has routed the chat elsewhere.
    if (cached?.storage.cwd === context.storage.cwd) return cached;
    const heartbeat = new HeartbeatService(context.storage.root, {
      ...(this.#options.heartbeat ?? {}),
      recordsRoot: context.storage.root,
      cacheRoot: context.cacheRoot,
      legacyHeartbeatRoots: context.legacyHeartbeatRoots,
      prepareWrite: context.ensureWritable,
      projectViewCache: this.#projectViewCache,
      discoveryIndex: this.#discoveryIndex,
    });
    const adapted: WorkspaceTaskStorageContext = { ...context, heartbeat };
    this.#contexts.set(threadId, adapted);
    cached?.heartbeat.close();
    return adapted;
  }

  async hasRecoverableTasks(): Promise<boolean> {
    if (this.#closed)
      throw new TaskStoreError("TASK_STORAGE_CLOSED", "Workspace storage is closed");
    const kit = await this.#adapter();
    if (typeof kit.hasRecoverableTasks !== "function")
      throw new TaskStoreError(
        "TASK_STORAGE_CONTRACT_INVALID",
        "Kit workspace storage recovery detection is missing",
      );
    return kit.hasRecoverableTasks();
  }

  close(): void {
    this.#closed = true;
    for (const context of this.#contexts.values()) context.heartbeat.close();
    this.#contexts.clear();
    this.#projectViewCache.close();
    this.#discoveryIndex.close();
    this.#kit?.close();
  }
}
