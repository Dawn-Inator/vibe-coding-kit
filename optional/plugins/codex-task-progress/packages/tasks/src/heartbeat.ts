import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HeartbeatInspectionReport,
  HeartbeatWake,
  InspectHeartbeatLedgerOptions,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs";
import {
  inspectHeartbeatLedger as bundledHeartbeatInspector,
  projectHeartbeatOrchestration,
  validateHeartbeatOrchestration,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs";
import {
  type AgentTaskProgress,
  type CurrentAgent,
  projectAgentTaskProgress,
} from "vibe-coding-kit/src/tasks/agent-task-associations.mjs";
import type {
  HeartbeatLedgerDiscoveryReport,
  HeartbeatTaskState,
} from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import {
  HeartbeatDiscoveryInvalidatedError,
  isHeartbeatDiscoveryInvalidatedError,
} from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import { createTaskProgressSchemas } from "vibe-coding-kit/src/tasks/task-contract.mjs";
import { z } from "zod";
import {
  atomicCreateFile,
  atomicWriteFile,
  ensurePrivateDirectory,
} from "../../store/src/atomic.js";

export interface HeartbeatCandidate {
  path: string;
  associated: boolean;
}
export interface HeartbeatFinding {
  severity: string;
  message: string;
  rule?: string;
}
export interface HeartbeatView {
  status: "none" | "candidates" | "ready" | "stale" | "error" | "pending";
  sourcePath: string | null;
  historyPath?: string;
  candidates: HeartbeatCandidate[];
  refreshedAt: string;
  modifiedAt: string | null;
  lastWakeAt: string | null;
  nextWakeAt: string | null;
  cadenceMinutes: number | null;
  certifiesCurrent: boolean;
  passed: boolean;
  items: Record<string, unknown>[];
  wakes: Record<string, unknown>[];
  findings: HeartbeatFinding[];
  itemCount: number;
  wakeCount: number;
  itemStatusCounts: Record<string, number>;
  itemsTruncated: boolean;
  wakesTruncated: boolean;
  candidateCount?: number;
  candidatesTruncated?: boolean;
  discoveryComplete?: boolean;
  discoveryVisitedFiles?: number;
  discoveryLimits?: { maxFiles: number; maxDepth: number };
  discoveryReasons?: string[];
  basis?: "configured" | "latest-recorded-wake" | "items-inventory" | "none";
  findingsTruncated?: boolean;
  error?: string;
  warning?: string;
  retryable?: true;
  contentHash?: string;
}
export interface HeartbeatHistoryPage {
  wakes: Record<string, unknown>[];
  nextCursor: string | null;
  total: number;
  sourcePath: string | null;
  historyPath?: string;
  contentHash?: string;
  itemStatuses?: Record<string, string>;
  error?: string;
  retryable?: true;
}
export interface HeartbeatTaskProjection {
  status: "none" | "candidates" | "pending-selection" | "ready" | "stale" | "error" | "pending";
  task: ProjectedHeartbeatTask | null;
  sourcePath: string | null;
  historyPath?: string;
  contentHash?: string;
  itemStatuses?: Record<string, string>;
  recordedAgentObservation?: { activeAgents: number; observedAt: string };
  error?: string;
  retryable?: true;
}
interface ProjectedHeartbeatTask extends Omit<HeartbeatTaskState, "source"> {
  source: HeartbeatTaskState["source"] & {
    presentation: {
      truncated: boolean;
      sourceItemCount: number;
      displayedItemCount: number;
      itemStatusesTruncated: boolean;
      linkRisksTruncated: boolean;
    };
    itemStatusCount: number;
    linkRiskCount: number;
  };
}
const TASK_SOURCE_PANEL_BYTES = 128 * 1024;
const HEARTBEAT_ITEM_STATUS_BUCKETS = new Set([
  "done",
  "completed",
  "blocked",
  "dispatched",
  "in-flight",
  "active",
  "pending",
  "deferred",
  "owner",
  "cancelled",
]);
function countItemStatuses(items: readonly { status?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const token = shortened(item.status, 64).split(/\s+/)[0]?.toLowerCase() || "unknown";
    const bucket = HEARTBEAT_ITEM_STATUS_BUCKETS.has(token) ? token : "unknown";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}
function compactProjectedTask(sourceTask: HeartbeatTaskState): ProjectedHeartbeatTask {
  const itemStatusEntries = Object.entries(sourceTask.source.itemStatuses);
  const linkRisks = sourceTask.source.linkRisks ?? [];
  const sourceItemCount = itemStatusEntries.length;
  const sourceStatusesTruncated = itemStatusEntries.some(
    ([id, status]) => id.length > 512 || status.length > 100,
  );
  const sourceLinkRisksTruncated = linkRisks.some((risk) => risk.length > 250);
  const displayLimit = 200;
  const statusLimit = 100;
  const riskLimit = 20;
  let remaining = displayLimit;
  const compactEvidence = (evidence: HeartbeatTaskState["objectives"][number]["evidence"]) =>
    evidence.slice(0, 1).map((item) => ({
      ...item,
      summary: shortened(item.summary, 250),
      ...(item.reference ? { reference: shortened(item.reference, 350) } : {}),
    }));
  const objectives: HeartbeatTaskState["objectives"] = [];
  for (const objective of sourceTask.objectives) {
    if (remaining <= 0) break;
    if (objective.id.length > 512) continue;
    remaining -= 1;
    const items: HeartbeatTaskState["objectives"][number]["items"] = [];
    for (const item of objective.items) {
      if (remaining <= 0) break;
      if (item.id.length > 512) continue;
      items.push({
        ...item,
        title: shortened(item.title, 400),
        evidence: compactEvidence(item.evidence),
      });
      remaining -= 1;
    }
    objectives.push({
      ...objective,
      title: shortened(objective.title, 400),
      evidence: compactEvidence(objective.evidence),
      items,
    });
  }
  const displayedItemCount = objectives.reduce(
    (total, objective) => total + 1 + objective.items.length,
    0,
  );
  // Owner identities remain private to the full verified in-memory task.
  const { itemOwners: _itemOwners, ...publicSource } = sourceTask.source;
  const task = {
    ...sourceTask,
    title: shortened(sourceTask.title, 500),
    objectives,
    source: {
      ...publicSource,
      itemStatuses: Object.fromEntries(
        itemStatusEntries
          .filter(([id]) => id.length <= 512)
          .slice(0, statusLimit)
          .map(([id, status]) => [id, shortened(status, 100)]),
      ),
      linkRisks: linkRisks.slice(0, riskLimit).map((risk) => shortened(risk, 250)),
      itemStatusCount: sourceItemCount,
      linkRiskCount: linkRisks.length,
      presentation: {
        truncated:
          displayedItemCount < sourceItemCount ||
          sourceItemCount > statusLimit ||
          linkRisks.length > riskLimit ||
          sourceStatusesTruncated ||
          sourceLinkRisksTruncated,
        sourceItemCount,
        displayedItemCount,
        itemStatusesTruncated:
          itemStatusEntries.filter(([id]) => id.length <= 512).slice(0, statusLimit).length <
            sourceItemCount || sourceStatusesTruncated,
        linkRisksTruncated: linkRisks.length > riskLimit || sourceLinkRisksTruncated,
      },
    },
  } as ProjectedHeartbeatTask;
  while (Buffer.byteLength(JSON.stringify(task)) > TASK_SOURCE_PANEL_BYTES) {
    const last = task.objectives.at(-1);
    if (last?.items.length) last.items.pop();
    else if (last) task.objectives.pop();
    else {
      const statusIds = Object.keys(task.source.itemStatuses);
      const lastStatusId = statusIds.at(-1);
      if (lastStatusId) {
        delete task.source.itemStatuses[lastStatusId];
        task.source.presentation.itemStatusesTruncated = true;
      } else if (task.source.linkRisks?.length) {
        task.source.linkRisks.pop();
        task.source.presentation.linkRisksTruncated = true;
      } else break;
    }
    const boundedCount = task.objectives.reduce(
      (total, objective) => total + 1 + objective.items.length,
      0,
    );
    task.source.presentation.displayedItemCount = boundedCount;
    task.source.presentation.truncated = true;
  }
  return task;
}
type Inspector = (
  text: string,
  options: InspectHeartbeatLedgerOptions,
) => HeartbeatInspectionReport;
export interface HeartbeatOptions {
  kitPath?: string;
  fallbackKitPath?: string | null;
  refreshMs?: number;
  maxFiles?: number;
  maxDepth?: number;
  now?: () => Date;
  prepareWrite?: () => Promise<void>;
  recordsRoot?: string;
  cacheRoot?: string;
  legacyHeartbeatRoots?: string[];
  /** Workspace-owned cache for read-only project summaries; thread state stays service-local. */
  projectViewCache?: HeartbeatProjectViewCache;
  discoveryIndex?: import("vibe-coding-kit/src/tasks/heartbeat-task-source.mjs").HeartbeatDiscoveryIndex;
}
interface ProjectConfig {
  heartbeat?: {
    ledgerPath?: string;
    kitPath?: string;
    cadenceMinutes?: number;
    nextWakeAt?: string;
    maxFiles?: number;
    maxDepth?: number;
  };
}
interface CacheEntry {
  generation?: number | null;
  bound?: boolean;
  configFingerprint?: string;
  cwd: string;
  time: number;
  value: HeartbeatView | null;
}
interface ProjectViewCacheEntry {
  time: number;
  value: HeartbeatView;
}
/** Shared only by services with the same owner; it contains no thread bindings or task history. */
export class HeartbeatProjectViewCache {
  readonly #values = new Map<string, ProjectViewCacheEntry>();
  readonly #failures = new Map<string, HeartbeatView>();
  readonly #pending = new Map<
    string,
    { root: string; epoch: number; owner: object; promise: Promise<HeartbeatView> }
  >();
  readonly #epochs = new Map<string, number>();
  #closed = false;

  get(key: string): ProjectViewCacheEntry | undefined {
    return this.#values.get(key);
  }

  epoch(root: string): number {
    return this.#epochs.get(root) ?? 0;
  }

  pending(key: string, root: string, epoch: number): Promise<HeartbeatView> | undefined {
    const pending = this.#pending.get(key);
    return pending?.root === root && pending.epoch === epoch ? pending.promise : undefined;
  }

  setPending(
    key: string,
    root: string,
    epoch: number,
    owner: object,
    promise: Promise<HeartbeatView>,
  ): void {
    if (!this.#closed && this.epoch(root) === epoch)
      this.#pending.set(key, { root, epoch, owner, promise });
  }

  setValue(key: string, root: string, epoch: number, entry: ProjectViewCacheEntry): void {
    if (!this.#closed && this.epoch(root) === epoch) this.#values.set(key, entry);
  }

  invalidateProject(root: string): void {
    if (this.#closed) return;
    this.#epochs.set(root, this.epoch(root) + 1);
    const prefix = `${root}\0`;
    for (const key of this.#values.keys()) if (key.startsWith(prefix)) this.#values.delete(key);
    for (const key of this.#failures.keys()) if (key.startsWith(prefix)) this.#failures.delete(key);
  }

  failure(key: string): HeartbeatView | undefined {
    return this.#failures.get(key);
  }

  setFailure(key: string, root: string, epoch: number, value: HeartbeatView): void {
    if (!this.#closed && this.epoch(root) === epoch) this.#failures.set(key, value);
  }

  clearFailure(key: string, root: string, epoch: number): void {
    if (!this.#closed && this.epoch(root) === epoch) this.#failures.delete(key);
  }

  clearPendingIfOwner(key: string, owner: object): void {
    if (this.#pending.get(key)?.owner === owner) this.#pending.delete(key);
  }

  clear(): void {
    this.#pending.clear();
    this.#values.clear();
    this.#failures.clear();
  }

  close(): void {
    this.#closed = true;
    this.clear();
  }
}

const isDisplayChanged = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "HEARTBEAT_DISPLAY_CHANGED";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const nowFunctionIds = new WeakMap<() => Date, number>();
let nextNowFunctionId = 1;
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
type HeartbeatTaskSourceApi = typeof import("vibe-coding-kit/src/tasks/heartbeat-task-source.mjs");
type ProjectHeartbeatApi = typeof import("vibe-coding-kit/src/tasks/project-heartbeat.mjs");
type RelationsApi = typeof import("vibe-coding-kit/src/tasks/task-source-relations.mjs");
type PairFilesApi = typeof import("vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs");
let heartbeatTaskSourceApi: Promise<HeartbeatTaskSourceApi> | undefined;
let projectHeartbeatApi: Promise<ProjectHeartbeatApi> | undefined;
let relationsApi: Promise<RelationsApi> | undefined;
let pairFilesApi: Promise<PairFilesApi> | undefined;
function loadHeartbeatTaskSourceApi(): Promise<HeartbeatTaskSourceApi> {
  heartbeatTaskSourceApi ??= import("vibe-coding-kit/src/tasks/heartbeat-task-source.mjs");
  return heartbeatTaskSourceApi;
}
function loadProjectHeartbeatApi(): Promise<ProjectHeartbeatApi> {
  projectHeartbeatApi ??= import("vibe-coding-kit/src/tasks/project-heartbeat.mjs");
  return projectHeartbeatApi;
}
function loadRelationsApi(): Promise<RelationsApi> {
  relationsApi ??= import("vibe-coding-kit/src/tasks/task-source-relations.mjs");
  return relationsApi;
}
function loadPairFilesApi(): Promise<PairFilesApi> {
  pairFilesApi ??= import("vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs");
  return pairFilesApi;
}
function validateHistoryCursor(cursor: string | undefined): void {
  if (cursor === undefined) return;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) throw new Error();
    const value = JSON.parse(raw.toString("utf8")) as {
      v?: unknown;
      contentHash?: unknown;
      offset?: unknown;
    };
    if (
      value.v !== 1 ||
      typeof value.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.contentHash) ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0
    )
      throw new Error();
  } catch {
    throw new Error("Invalid heartbeat history cursor.");
  }
}
const isStaleCursor = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "HEARTBEAT_DISPLAY_CURSOR_STALE";
const PANEL_BYTES = 192 * 1024;
const taskProgressSchemas = createTaskProgressSchemas(z);
const shortened = (value: unknown, max = 500): string => {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
function compactItem(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    ...[
      "id",
      "source",
      "item",
      "status",
      "evidence",
      "owner",
      "repository",
      "worktree",
      "mode",
      "write_set",
      "dispatch_ref",
    ].map((field) => [field, shortened(item[field], field === "evidence" ? 700 : 300)]),
    ["line", typeof item.line === "number" ? item.line : null],
  ]);
}
type TransportWake = Omit<HeartbeatWake, "rows"> & {
  sourcePath?: string;
  sourceLine?: number;
  rows: Array<HeartbeatWake["rows"][number] & { sourcePath?: string; sourceLine?: number }>;
};
function transportWake(wake: TransportWake): TransportWake {
  return { ...wake, rows: wake.rows.map((row) => ({ ...row })) };
}
function compactWake(wake: TransportWake): Record<string, unknown> {
  const rows = wake.rows;
  const compact: Record<string, unknown> = {
    heading: shortened(wake.heading, 240),
    timeMs: typeof wake.timeMs === "number" && Number.isFinite(wake.timeMs) ? wake.timeMs : null,
    line: wake.sourceLine ?? wake.line,
    ...(wake.sourcePath ? { sourcePath: wake.sourcePath } : {}),
    rows: rows.slice(0, 10).map((row) => ({
      num: row.num,
      category: shortened(row.category, 150),
      state: shortened(row.state, 500),
      line: row.sourceLine ?? row.line,
      ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}),
    })),
    rowCount: rows.length,
    truncated: true,
    ...(wake.orchestrationError
      ? { orchestrationError: shortened(wake.orchestrationError, 499) }
      : {}),
  };
  if (wake.orchestration != null) {
    // Keep the full Kit preview when possible. Reduce only its preview, through Kit,
    // if unusually long task fields would make a single wake exceed the IPC budget.
    let preview = 20;
    compact.orchestration = projectHeartbeatOrchestration(wake.orchestration);
    while (preview > 0 && Buffer.byteLength(JSON.stringify(compact)) > 128 * 1024) {
      preview -= 1;
      compact.orchestration = projectHeartbeatOrchestration(wake.orchestration, {
        maxBlockedPreview: preview,
      });
    }
  }
  return compact;
}
function compactView(view: HeartbeatView): HeartbeatView {
  const value: HeartbeatView = {
    ...view,
    itemCount: view.itemCount ?? view.items.length,
    wakeCount: view.wakeCount ?? view.wakes.length,
    candidateCount: view.candidateCount ?? view.candidates.length,
    itemStatusCounts: view.itemStatusCounts ?? {},
    items: view.items.slice(0, 20).map(compactItem),
    wakes: view.wakes.slice(-5),
    candidates: view.candidates.slice(0, 40),
    findings: view.findings.slice(0, 30).map((finding) => ({
      severity: shortened(finding.severity, 20),
      message: shortened(finding.message, 300),
      ...(finding.rule ? { rule: shortened(finding.rule, 100) } : {}),
    })),
    ...(view.error ? { error: shortened(view.error, 1000) } : {}),
    ...(view.warning ? { warning: shortened(view.warning, 1000) } : {}),
  };
  while (Buffer.byteLength(JSON.stringify(value)) > PANEL_BYTES) {
    if (value.items.length) value.items.pop();
    else if (value.wakes.length) value.wakes.shift();
    else if (value.candidates.length) value.candidates.pop();
    else if (value.findings.length) value.findings.pop();
    else break;
  }
  value.itemsTruncated = value.items.length < value.itemCount;
  value.wakesTruncated = value.wakes.length < value.wakeCount;
  value.candidatesTruncated = value.candidates.length < (value.candidateCount ?? 0);
  value.findingsTruncated = value.findings.length < view.findings.length;
  return value;
}

/** Read-only ledger consumer. It never arms timers or writes project/Kit files. */
export class HeartbeatService {
  readonly #root: string;
  readonly #cacheRoot: string;
  readonly #legacyHeartbeatRoots: string[];
  readonly #options: HeartbeatOptions;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #canonicalTasks = new Map<string, HeartbeatTaskState>();
  readonly #projectViewCache: HeartbeatProjectViewCache;
  readonly #ownsProjectViewCache: boolean;
  readonly #last = new Map<string, HeartbeatView>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #pending = new Map<string, Promise<HeartbeatView | null>>();
  #restored = new Set<string>();

  constructor(root: string, options: HeartbeatOptions = {}) {
    this.#root = resolve(options.recordsRoot ?? root);
    this.#cacheRoot = resolve(
      options.cacheRoot ?? root,
      ...(options.cacheRoot ? [] : [".tmpcache"]),
    );
    this.#legacyHeartbeatRoots = options.legacyHeartbeatRoots ?? [];
    this.#options = options;
    this.#projectViewCache = options.projectViewCache ?? new HeartbeatProjectViewCache();
    this.#ownsProjectViewCache = options.projectViewCache === undefined;
  }

  async #relations() {
    const { TaskSourceRelations } = await loadRelationsApi();
    return new TaskSourceRelations(this.#root, {
      schemas: taskProgressSchemas,
      legacyHeartbeatRoots: this.#legacyHeartbeatRoots,
      ...(this.#options.prepareWrite ? { beforeWrite: this.#options.prepareWrite } : {}),
    });
  }

  async #restore(threadId: string): Promise<void> {
    if (this.#restored.has(threadId)) return;
    try {
      const saved = JSON.parse(
        await readFile(resolve(this.#cacheRoot, `${hash(threadId)}.snapshot.json`), "utf8"),
      ) as { view?: HeartbeatView };
      if (saved.view?.status === "ready" && saved.view.sourcePath && saved.view.contentHash)
        this.#last.set(threadId, compactView(saved.view));
    } catch {
      // Cache corruption and unavailable cache paths are misses, never source authority.
    }
    this.#restored.add(threadId);
  }

  async #cacheSnapshot(threadId: string, view: HeartbeatView): Promise<void> {
    try {
      await ensurePrivateDirectory(this.#cacheRoot);
      await atomicCreateFile(resolve(this.#cacheRoot, ".gitignore"), "*\n");
      await atomicWriteFile(
        resolve(this.#cacheRoot, `${hash(threadId)}.snapshot.json`),
        JSON.stringify({ view }),
      );
    } catch {
      // Persisted task/source records remain authoritative if this rebuildable cache is unwritable.
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** Reads the current project's canonical heartbeat source without consulting chat bindings. */
  async projectView(cwd: string): Promise<HeartbeatView> {
    const now = this.#now();
    const refreshedAt = now.toISOString();
    let root: string | null = null;
    let rootEpoch: number | null = null;
    try {
      const resolvedRoot = await this.#project(cwd);
      root = resolvedRoot;
      const epoch = this.#projectViewCache.epoch(resolvedRoot);
      rootEpoch = epoch;
      // Read config before consulting the shared cache so changed discovery bounds and source
      // selection cannot be hidden by another chat's still-fresh summary.
      const config = await this.#config(resolvedRoot);
      const key = this.#projectViewKey(resolvedRoot, config, this.#nowFunctionId());
      const cached = this.#projectViewCache.get(key);
      if (cached && now.getTime() - cached.time < (this.#options.refreshMs ?? 30_000))
        return cached.value;
      const pending = this.#projectViewCache.pending(key, resolvedRoot, epoch);
      if (pending) return pending;
      const owner = {};
      const operation = this.#readProjectView(resolvedRoot, config, now, refreshedAt)
        .then((view) => {
          // A failed source read is not cached: another call can retry immediately.
          if (view.status !== "error" && view.status !== "pending") {
            this.#projectViewCache.setValue(key, resolvedRoot, epoch, {
              time: this.#now().getTime(),
              value: view,
            });
            this.#projectViewCache.clearFailure(key, resolvedRoot, epoch);
            this.#projectViewCache.clearFailure(
              this.#projectViewBaseKey(resolvedRoot),
              resolvedRoot,
              epoch,
            );
          } else this.#projectViewCache.setFailure(key, resolvedRoot, epoch, view);
          return view;
        })
        .finally(() => this.#projectViewCache.clearPendingIfOwner(key, owner));
      this.#projectViewCache.setPending(key, resolvedRoot, epoch, owner, operation);
      return operation;
    } catch (error) {
      const view = compactView({
        status: "error",
        sourcePath: null,
        candidates: [],
        refreshedAt,
        modifiedAt: null,
        lastWakeAt: null,
        nextWakeAt: null,
        cadenceMinutes: null,
        certifiesCurrent: false,
        passed: false,
        items: [],
        wakes: [],
        findings: [],
        itemCount: 0,
        wakeCount: 0,
        itemStatusCounts: {},
        itemsTruncated: false,
        wakesTruncated: false,
        basis: "none",
        error: String(error),
      });
      if (root && rootEpoch !== null)
        this.#projectViewCache.setFailure(this.#projectViewBaseKey(root), root, rootEpoch, view);
      return view;
    }
  }

  /** Returns a fresh cached project summary, if available, and schedules a deduplicated refresh. */
  async projectViewSnapshot(
    cwd: string,
  ): Promise<{ view: HeartbeatView | null; pending: boolean }> {
    try {
      const root = await this.#project(cwd);
      const now = this.#now();
      const nowId = this.#nowFunctionId();
      const baseKey = this.#projectViewBaseKey(root, nowId);
      let key: string | null = null;
      let cached: ProjectViewCacheEntry | undefined;
      let failure = this.#projectViewCache.failure(baseKey);
      try {
        const config = await this.#config(root);
        key = this.#projectViewKey(root, config, nowId);
        cached = this.#projectViewCache.get(key);
        failure = this.#projectViewCache.failure(key) ?? failure;
      } catch {
        // Keep the last config-read failure visible while the retry below checks the source again.
      }
      const fresh =
        key !== null &&
        cached !== undefined &&
        now.getTime() - cached.time < (this.#options.refreshMs ?? 30_000);
      const refresh = this.projectView(cwd);
      // Refresh failures are represented by projectView's error view; no detached rejection leaks.
      void refresh.catch(() => undefined);
      const stale = key !== null && cached ? { ...cached.value, certifiesCurrent: false } : null;
      const fallback =
        failure?.status === "pending" && failure.retryable === true && stale
          ? stale
          : (failure ?? stale);
      return { view: fresh ? (cached?.value ?? null) : fallback, pending: !fresh };
    } catch (error) {
      const refresh = this.projectView(cwd);
      void refresh.catch(() => undefined);
      return {
        view: compactView({
          status: "error",
          sourcePath: null,
          candidates: [],
          refreshedAt: this.#now().toISOString(),
          modifiedAt: null,
          lastWakeAt: null,
          nextWakeAt: null,
          cadenceMinutes: null,
          certifiesCurrent: false,
          passed: false,
          items: [],
          wakes: [],
          findings: [],
          itemCount: 0,
          wakeCount: 0,
          itemStatusCounts: {},
          itemsTruncated: false,
          wakesTruncated: false,
          basis: "none",
          error: String(error),
        }),
        pending: true,
      };
    }
  }

  #nowFunctionId(): number {
    if (!this.#options.now) return 0;
    const existing = nowFunctionIds.get(this.#options.now);
    if (existing !== undefined) return existing;
    const id = nextNowFunctionId++;
    nowFunctionIds.set(this.#options.now, id);
    return id;
  }

  #projectViewKey(root: string, config: ProjectConfig, nowId: number): string {
    return `${this.#projectViewBaseKey(root, nowId)}\0${hash(JSON.stringify(config.heartbeat ?? null))}`;
  }

  #projectViewBaseKey(root: string, nowId = this.#nowFunctionId()): string {
    const scope = JSON.stringify({
      options: {
        kitPath: this.#options.kitPath ?? null,
        fallbackKitPath: this.#options.fallbackKitPath ?? null,
        refreshMs: this.#options.refreshMs ?? 30_000,
        maxFiles: this.#options.maxFiles ?? null,
        maxDepth: this.#options.maxDepth ?? null,
        nowId,
      },
    });
    return `${root}\0${hash(scope)}`;
  }

  async #readProjectView(
    root: string,
    config: ProjectConfig,
    now: Date,
    refreshedAt: string,
  ): Promise<HeartbeatView> {
    try {
      const { readProjectHeartbeatDisplay } = await loadProjectHeartbeatApi();
      const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
      const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
      const cadence = config.heartbeat?.cadenceMinutes;
      const report = await readProjectHeartbeatDisplay({
        root,
        ...(config.heartbeat?.ledgerPath ? { ledgerPath: config.heartbeat.ledgerPath } : {}),
        ...(this.#options.discoveryIndex ? { discoveryIndex: this.#options.discoveryIndex } : {}),
        now,
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        ...(typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0
          ? { intervalMinutes: cadence }
          : {}),
      });
      const source = report.source;
      const inventoryItems = source?.inventory.items ?? [];
      const discovery = report.discovery;
      const discoveryWarning = discovery.complete
        ? undefined
        : `Project heartbeat discovery was incomplete (${discovery.reasons.join(", ") || "scan limit"}); the displayed record is the best available result.`;
      const explicitNext = config.heartbeat?.nextWakeAt;
      const nextWakeAt =
        explicitNext && Number.isFinite(Date.parse(explicitNext))
          ? new Date(explicitNext).toISOString()
          : (source?.cadence?.nextDueAt ?? null);
      const itemStatusCounts = countItemStatuses(inventoryItems);
      const view = compactView({
        status: report.status,
        sourcePath: source?.path ?? null,
        ...(source ? { historyPath: source.isLegacy ? source.headPath : source.historyPath } : {}),
        candidates: [],
        refreshedAt,
        modifiedAt: source?.modifiedAt ?? null,
        lastWakeAt: source?.lastRecordedAt ?? null,
        nextWakeAt,
        cadenceMinutes:
          typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0 ? cadence : null,
        certifiesCurrent: false,
        passed: false,
        items: inventoryItems,
        wakes:
          source?.historyPage.wakes
            .slice()
            .reverse()
            .map((wake) => compactWake(transportWake(wake))) ?? [],
        findings: source?.inventory.findings ?? [],
        itemCount: inventoryItems.length,
        wakeCount: source?.historyPage.total ?? 0,
        itemStatusCounts,
        itemsTruncated: false,
        wakesTruncated: false,
        discoveryComplete: discovery.complete,
        discoveryVisitedFiles: discovery.visitedFiles,
        discoveryLimits: discovery.limits,
        discoveryReasons: discovery.reasons,
        basis: report.basis,
        ...(report.error ? { error: report.error } : {}),
        ...(discoveryWarning ? { warning: discoveryWarning } : {}),
        ...(source?.contentHash ? { contentHash: source.contentHash } : {}),
      });
      return view;
    } catch (error) {
      return compactView({
        status:
          isHeartbeatDiscoveryInvalidatedError(error) || isDisplayChanged(error)
            ? "pending"
            : "error",
        sourcePath: null,
        candidates: [],
        refreshedAt,
        modifiedAt: null,
        lastWakeAt: null,
        nextWakeAt: null,
        cadenceMinutes: null,
        certifiesCurrent: false,
        passed: false,
        items: [],
        wakes: [],
        findings: [],
        itemCount: 0,
        wakeCount: 0,
        itemStatusCounts: {},
        itemsTruncated: false,
        wakesTruncated: false,
        basis: "none",
        ...(isHeartbeatDiscoveryInvalidatedError(error) || isDisplayChanged(error)
          ? { retryable: true as const }
          : { error: String(error) }),
      });
    }
  }

  async #project(cwd: string): Promise<string> {
    const initial = resolve(cwd);
    let current = initial;
    while (true) {
      try {
        await stat(resolve(current, ".git"));
        return await realpath(current);
      } catch {
        /* Ascend. */
      }
      const parent = dirname(current);
      if (parent === current || current === homedir()) return await realpath(initial);
      current = parent;
    }
  }

  async #config(root: string): Promise<ProjectConfig> {
    try {
      return JSON.parse(
        await readFile(resolve(root, ".codex-task-progress.json"), "utf8"),
      ) as ProjectConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Cannot read .codex-task-progress.json: ${String(error)}`);
    }
  }

  async #inspector(root: string, config: ProjectConfig): Promise<Inspector> {
    const paths = [
      this.#options.kitPath,
      config.heartbeat?.kitPath && resolve(root, config.heartbeat.kitPath),
      resolve(root, ".vibe-coding/kit/src/supervision/heartbeat-ledger-api.mjs"),
      this.#options.fallbackKitPath,
    ].filter((p): p is string => Boolean(p));
    for (const path of paths) {
      const info = await stat(path).catch(() => null);
      const modulePath = info?.isDirectory()
        ? resolve(path, "src/supervision/heartbeat-ledger-api.mjs")
        : path;
      if (!(await stat(modulePath).catch(() => null))?.isFile()) continue;
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
      if (typeof module.inspectHeartbeatLedger === "function")
        return module.inspectHeartbeatLedger as Inspector;
    }
    if (this.#options.fallbackKitPath === undefined) return bundledHeartbeatInspector;
    throw new Error(
      "Kit heartbeat API unavailable. Configure heartbeat.kitPath in .codex-task-progress.json.",
    );
  }

  #observeFile(threadId: string, path: string): void {
    this.#watchers.get(threadId)?.close();
    try {
      const sourceName = path.split(/[\\/]/).at(-1);
      const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        // A warm bound hit revalidates source, companion, binding and Git boundary.
        // Unrelated siblings do not invalidate the selected source.
        if (filename === null || filename.toString() === sourceName) this.#cache.delete(threadId);
      });
      watcher.on("error", () => this.#cache.delete(threadId));
      this.#watchers.set(threadId, watcher);
    } catch {
      /* Bound warm hits perform canonical validation even without a watcher. */
    }
  }

  async #boundViewStillValid(
    threadId: string,
    root: string,
    view: HeartbeatView,
    configFingerprint: string,
  ): Promise<boolean> {
    if (view.status !== "ready" || !view.sourcePath || !view.contentHash) return false;
    try {
      if (hash(JSON.stringify(await this.#config(root))) !== configFingerprint) return false;
      const relations = await this.#relations();
      const before = await relations.get(threadId);
      if (!before.found || !before.binding) return false;
      const { discoverBoundHeartbeatSource } = await loadHeartbeatTaskSourceApi();
      const discovery = await discoverBoundHeartbeatSource({
        root,
        threadId,
        ledgerPath: before.binding.path,
      });
      const candidate = discovery.candidates[0];
      if (!candidate || (before.binding.origin === "automatic" && !candidate.associated))
        return false;
      if (candidate.path !== (await realpath(view.sourcePath))) return false;
      const pair = await (await loadPairFilesApi()).readHeartbeatDisplay({
        canonicalDisplayOnly: true,
        root,
        path: candidate.path,
        now: this.#now(),
        pageSize: 5,
      });
      if (
        pair.contentHash !== view.contentHash ||
        !discovery.boundSourceDigest ||
        pair.headDigest !== discovery.boundSourceDigest
      )
        return false;
      const after = await relations.get(threadId);
      return Boolean(
        after.found &&
          after.binding &&
          after.binding.path === before.binding.path &&
          after.binding.origin === before.binding.origin,
      );
    } catch {
      return false;
    }
  }

  async view(
    threadId: string,
    cwd: string,
    options: { forceDiscovery?: boolean } = {},
  ): Promise<HeartbeatView | null> {
    const pendingKey = `${threadId}\0${resolve(cwd)}`;
    const alreadyPending = this.#pending.get(pendingKey);
    if (alreadyPending && !options.forceDiscovery) return alreadyPending;
    const index = this.#options.discoveryIndex;
    const root = index ? await this.#project(cwd) : null;
    const cached = this.#cache.get(threadId);
    const now = this.#now().getTime();
    const fresh =
      !options.forceDiscovery &&
      cached?.cwd === cwd &&
      now - cached.time < (this.#options.refreshMs ?? 30_000);
    if (fresh && cached?.bound && cached.value && cached.configFingerprint) {
      const boundRoot = root ?? (await this.#project(cwd).catch(() => null));
      if (
        boundRoot &&
        (await this.#boundViewStillValid(
          threadId,
          boundRoot,
          cached.value,
          cached.configFingerprint,
        ))
      )
        return cached.value;
      this.#cache.delete(threadId);
    }
    const generation = root && index ? await index.generation(root) : null;
    if (
      fresh &&
      cached &&
      !cached.bound &&
      (!index || (generation !== null && cached.generation === generation))
    )
      return cached.value;
    const pending = this.#pending.get(pendingKey);
    if (pending) {
      if (!options.forceDiscovery) return pending;
      await pending.catch(() => undefined);
    }
    const operation = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observation: {
          generation: number | null;
          configFingerprint?: string;
          boundOnly?: boolean;
        } = { generation: null };
        const value = await this.#read(
          threadId,
          cwd,
          {
            forceDiscovery: Boolean(options.forceDiscovery && attempt === 0),
          },
          observation,
        );
        if (value?.retryable) return value;
        if (value?.status === "ready" && value.sourcePath && observation.configFingerprint) {
          const boundRoot = root ?? (await this.#project(cwd).catch(() => null));
          if (
            boundRoot &&
            (await this.#boundViewStillValid(
              threadId,
              boundRoot,
              value,
              observation.configFingerprint,
            ))
          ) {
            // Full-scan candidate metadata must not outlive its root generation.
            // Cache only source-only views whose bounded claim remains accurate.
            if (!options.forceDiscovery && value.discoveryReasons?.includes("source-only"))
              this.#cache.set(threadId, {
                cwd,
                time: this.#now().getTime(),
                value,
                bound: true,
                configFingerprint: observation.configFingerprint,
              });
            return value;
          }
          continue;
        }
        if (observation.boundOnly && value?.status !== "ready") return value;
        const completed = root && index ? await index.generation(root) : null;
        if (!index || (observation.generation !== null && completed === observation.generation)) {
          const explicitTemp = Boolean(
            root &&
              value &&
              [value.sourcePath, ...value.candidates.map((candidate) => candidate.path)].some(
                (path) => path && relative(root, path).split(/[\\/]/).includes(".tmp"),
              ),
          );
          if (!explicitTemp)
            this.#cache.set(threadId, {
              cwd,
              time: this.#now().getTime(),
              value,
              generation: completed,
            });
          return value;
        }
        // An unavailable watcher cannot certify a cache hit, but the just-completed
        // canonical scan remains usable; the next request will scan again.
        if (observation.generation === null) return value;
      }
      throw new HeartbeatDiscoveryInvalidatedError(
        "Heartbeat discovery changed while reading; retry required",
      );
    })().finally(() => this.#pending.delete(pendingKey));
    this.#pending.set(pendingKey, operation);
    return operation;
  }

  async #read(
    threadId: string,
    cwd: string,
    options: { forceDiscovery?: boolean } = {},
    observation?: { generation: number | null; configFingerprint?: string; boundOnly?: boolean },
  ): Promise<HeartbeatView | null> {
    await this.#restore(threadId);
    const now = this.#now().toISOString();
    const empty: HeartbeatView = {
      status: "candidates",
      sourcePath: null,
      candidates: [],
      refreshedAt: now,
      modifiedAt: null,
      lastWakeAt: null,
      nextWakeAt: null,
      cadenceMinutes: null,
      certifiesCurrent: false,
      passed: false,
      items: [],
      wakes: [],
      findings: [],
      itemCount: 0,
      wakeCount: 0,
      itemStatusCounts: {},
      itemsTruncated: false,
      wakesTruncated: false,
    };
    let source: string | undefined;
    try {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      if (observation) observation.configFingerprint = hash(JSON.stringify(config));
      if (source) {
        source = await realpath(source);
        if (!within(root, source))
          throw new Error("Bound heartbeat source is outside the project root.");
      }
      const { discoverHeartbeatLedgerSources, discoverBoundHeartbeatSource } =
        await loadHeartbeatTaskSourceApi();
      const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
      const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
      const relations = await this.#relations();
      const previous = await relations.get(threadId);
      let storedBindingPath: string | undefined;
      if (previous.found && previous.binding) {
        try {
          const canonicalBinding = await realpath(previous.binding.path);
          if (within(root, canonicalBinding)) storedBindingPath = canonicalBinding;
        } catch {
          // Leave stale/missing path diagnosis to Kit's relation resolver below.
        }
      }
      const discoveryLedgerPath = storedBindingPath ?? config.heartbeat?.ledgerPath;
      const discoveryOptions = {
        root,
        threadId,
        ...(discoveryLedgerPath ? { ledgerPath: discoveryLedgerPath } : {}),
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      };
      const boundPath = previous.found && previous.binding ? previous.binding.path : undefined;
      const boundOnly = Boolean(boundPath && !options.forceDiscovery);
      if (observation) observation.boundOnly = boundOnly;
      let discovery: HeartbeatLedgerDiscoveryReport;
      try {
        discovery =
          boundOnly && boundPath
            ? await discoverBoundHeartbeatSource({ ...discoveryOptions, ledgerPath: boundPath })
            : await (this.#options.discoveryIndex
                ? this.#options.discoveryIndex.discover(discoveryOptions, {
                    force: Boolean(options.forceDiscovery),
                  })
                : discoverHeartbeatLedgerSources(discoveryOptions));
      } catch (error) {
        if (isHeartbeatDiscoveryInvalidatedError(error)) throw error;
        // An existing binding remains latched on missing, escaped or unreadable
        // sources; it must never fall back to an unrelated local checklist.
        if (boundOnly && boundPath)
          return compactView({
            ...(this.#last.get(threadId) ?? empty),
            status: "stale",
            sourcePath: boundPath,
            refreshedAt: now,
            certifiesCurrent: false,
            error: String(error),
          });
        throw error;
      }
      let relation = await relations.resolve(threadId, {
        projectRoot: root,
        discovery,
      });
      // A default bounded scan can stop before reaching deep sources in a large
      // project. Retry once with a still-bounded scope, but never override an
      // explicit limit, an existing binding, or non-budget scan failures.
      const budgetOnly =
        discovery.reasons.length > 0 &&
        discovery.reasons.every((reason) => reason === "file-limit" || reason === "depth-limit");
      if (
        relation.status === "pending-selection" &&
        !previous.found &&
        !boundOnly &&
        maxFiles === undefined &&
        maxDepth === undefined &&
        !discovery.complete &&
        budgetOnly
      ) {
        const expanded = { ...discoveryOptions, maxFiles: 12_000, maxDepth: 32 };
        discovery = await (this.#options.discoveryIndex
          ? this.#options.discoveryIndex.discover(expanded, {
              force: Boolean(options.forceDiscovery),
            })
          : discoverHeartbeatLedgerSources(expanded));
        // A protected scan must still describe the current root before it can
        // create an automatic source binding. The outer view check also fences
        // the final snapshot; unprotected scans retain their existing semantics.
        if (
          this.#options.discoveryIndex &&
          discovery.indexGeneration !== undefined &&
          (await this.#options.discoveryIndex.generation(root)) !== discovery.indexGeneration
        )
          throw new HeartbeatDiscoveryInvalidatedError(
            "Heartbeat discovery changed while reading; retry required",
          );
        relation = await relations.resolve(threadId, { projectRoot: root, discovery });
      }
      if (observation)
        observation.generation = boundOnly ? null : (discovery.indexGeneration ?? null);
      const candidates = discovery.candidates;
      if (relation.status === "none") return null;
      if (relation.status === "candidates" || relation.status === "pending-selection")
        return compactView({
          ...empty,
          status: "candidates",
          candidates,
          candidateCount: candidates.length,
          discoveryComplete: discovery.complete,
          discoveryVisitedFiles: discovery.visitedFiles,
          discoveryLimits: discovery.limits,
          discoveryReasons: discovery.reasons,
        });
      source = relation.binding?.path;
      if (relation.status === "stale")
        return compactView({
          ...(this.#last.get(threadId) ?? empty),
          status: "stale",
          sourcePath: source ?? null,
          refreshedAt: now,
          certifiesCurrent: false,
          error: relation.error ?? "The bound chat task source is stale and remains read-only.",
        });
      if (!source) return null;
      this.#observeFile(threadId, source);
      const inspect = await this.#inspector(root, config);
      const cadence = config.heartbeat?.cadenceMinutes;
      const cadenceMinutes =
        typeof cadence === "number" && cadence > 0 && Number.isFinite(cadence) ? cadence : null;
      const pair = await (await loadPairFilesApi()).readHeartbeatDisplay({
        canonicalDisplayOnly: true,
        root,
        path: source,
        now: this.#now(),
        pageSize: 5,
        inspect,
        ...(cadenceMinutes === null ? {} : { intervalMinutes: cadenceMinutes }),
      });
      const inventory = pair.inventory;
      const explicitNext = config.heartbeat?.nextWakeAt;
      const nextWakeAt =
        explicitNext && Number.isFinite(Date.parse(explicitNext))
          ? new Date(explicitNext).toISOString()
          : (pair.cadence?.nextDueAt ?? null);
      const itemStatusCounts = countItemStatuses(inventory.items);
      const view: HeartbeatView = compactView({
        ...empty,
        status: "ready",
        sourcePath: source,
        historyPath: pair.isLegacy ? pair.headPath : pair.historyPath,
        candidates,
        candidateCount: candidates.length,
        discoveryComplete: discovery.complete,
        discoveryVisitedFiles: discovery.visitedFiles,
        discoveryLimits: discovery.limits,
        discoveryReasons: discovery.reasons,
        modifiedAt: pair.modifiedAt,
        contentHash: pair.contentHash,
        lastWakeAt: pair.lastRecordedAt,
        nextWakeAt,
        cadenceMinutes,
        certifiesCurrent: false,
        passed: false,
        items: inventory.items,
        wakes: pair.historyPage.wakes.slice().reverse().map(compactWake),
        findings: inventory.findings,
        itemCount: inventory.items.length,
        wakeCount: pair.historyPage.total,
        itemStatusCounts,
      });
      this.#last.set(threadId, view);
      await this.#cacheSnapshot(threadId, view);
      return view;
    } catch (error) {
      if (isHeartbeatDiscoveryInvalidatedError(error)) throw error;
      const previous = this.#last.get(threadId);
      if (isDisplayChanged(error))
        return previous
          ? { ...previous, certifiesCurrent: false, retryable: true }
          : { ...empty, status: "pending", retryable: true };
      return compactView({
        ...(previous ?? empty),
        status: previous ? "stale" : "error",
        sourcePath: source ?? null,
        refreshedAt: now,
        certifiesCurrent: false,
        error: String(error),
      });
    }
  }

  async #readHistoryPage(
    root: string,
    sourcePath: string,
    limit: number,
    cursor?: string,
  ): Promise<HeartbeatHistoryPage> {
    const api = await loadPairFilesApi();
    let pageSize = limit;
    while (true) {
      const pair = await api.readHeartbeatDisplay({
        canonicalDisplayOnly: true,
        root,
        path: sourcePath,
        now: this.#now(),
        pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page: HeartbeatHistoryPage = {
        wakes: pair.historyPage.wakes.map((wake) => compactWake(transportWake(wake))),
        nextCursor: pair.historyPage.nextCursor,
        total: pair.historyPage.total,
        sourcePath,
        historyPath: pair.isLegacy ? pair.headPath : pair.historyPath,
        contentHash: pair.contentHash,
      };
      if (Buffer.byteLength(JSON.stringify(page), "utf8") <= PANEL_BYTES) return page;
      if (page.wakes.length <= 1)
        throw new Error("Heartbeat history record exceeds display byte limit.");
      pageSize = Math.max(1, Math.floor(page.wakes.length / 2));
    }
  }

  async history(
    threadId: string,
    cwd: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<HeartbeatHistoryPage> {
    validateHistoryCursor(options.cursor);
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("Heartbeat history limit must be 1–10.");
    const empty = (
      sourcePath: string | null,
      error?: string,
      contentHash?: string,
      historyPath?: string,
    ) => ({
      wakes: [],
      nextCursor: null,
      total: 0,
      sourcePath,
      ...(historyPath ? { historyPath } : {}),
      ...(contentHash ? { contentHash } : {}),
      ...(error ? { error: shortened(error, 2_000) } : {}),
    });
    let view: HeartbeatView | null;
    try {
      view = await this.view(threadId, cwd);
    } catch (error) {
      if (!isHeartbeatDiscoveryInvalidatedError(error)) throw error;
      return { ...empty(null), retryable: true };
    }
    if (!view?.sourcePath)
      return empty(
        null,
        view?.error ??
          (view?.status === "none"
            ? undefined
            : `Heartbeat task source is ${view?.status ?? "unavailable"}.`),
      );
    if (view.status !== "ready")
      return empty(
        view.sourcePath,
        view.error ?? `Heartbeat task source is ${view.status}.`,
        view.contentHash,
        view.historyPath,
      );
    try {
      const root = await this.#project(cwd);
      const sourcePath = await realpath(view.sourcePath);
      if (!within(root, sourcePath) || sourcePath !== view.sourcePath)
        throw new Error("Bound heartbeat source changed outside its verified project path.");
      const page = await this.#readHistoryPage(root, sourcePath, limit, options.cursor);
      if (page.contentHash !== view.contentHash)
        return empty(
          sourcePath,
          "Heartbeat ledger changed while reading history; refresh before using its audit history.",
          page.contentHash,
          page.historyPath,
        );
      return page;
    } catch (error) {
      if (isDisplayChanged(error) || isStaleCursor(error))
        return {
          ...empty(view.sourcePath, undefined, view.contentHash, view.historyPath),
          retryable: true,
        };
      return empty(view.sourcePath, String(error), view.contentHash, view.historyPath);
    }
  }

  /** Projects paginated audit history for the current project source, without chat IDs. */
  async projectHistory(
    cwd: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<HeartbeatHistoryPage> {
    const view = await this.projectView(cwd);
    if (!view.sourcePath)
      return {
        wakes: [],
        nextCursor: null,
        total: 0,
        sourcePath: null,
        ...(view.status === "pending" ? { retryable: true as const } : {}),
        ...(view.error ? { error: view.error } : {}),
      };
    validateHistoryCursor(options.cursor);
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("Heartbeat history limit must be 1–10.");
    const sourcePath = view.sourcePath;
    const failure = (
      error: string,
      contentHash = view.contentHash,
      historyPath = view.historyPath,
    ): HeartbeatHistoryPage => ({
      wakes: [],
      nextCursor: null,
      total: 0,
      sourcePath,
      ...(historyPath ? { historyPath } : {}),
      ...(contentHash ? { contentHash } : {}),
      error: shortened(error, 2_000),
    });
    try {
      const root = await this.#project(cwd);
      const canonicalSource = await realpath(sourcePath);
      if (!within(root, canonicalSource) || canonicalSource !== sourcePath)
        return failure("Project heartbeat source changed outside its verified project path.");
      if (!view.contentHash)
        return failure("Project heartbeat source has no verified content hash.");
      const page = await this.#readHistoryPage(root, canonicalSource, limit, options.cursor);
      if (page.contentHash !== view.contentHash)
        return failure(
          "Heartbeat ledger changed while reading history; refresh before using its audit history.",
          page.contentHash,
          page.historyPath,
        );
      return page;
    } catch (error) {
      if (isDisplayChanged(error) || isStaleCursor(error)) {
        const { error: _error, ...retry } = failure("");
        return { ...retry, retryable: true };
      }
      return failure(String(error));
    }
  }

  /** Returns the canonical Kit projection only for a fresh, successfully read source ledger. */
  async taskProjection(
    threadId: string,
    cwd: string,
    options: { forceDiscovery?: boolean } = {},
  ): Promise<HeartbeatTaskProjection> {
    let view: HeartbeatView | null;
    try {
      view = await this.view(threadId, cwd, options);
    } catch (error) {
      if (!isHeartbeatDiscoveryInvalidatedError(error)) throw error;
      return { status: "pending", task: null, sourcePath: null, retryable: true };
    }
    if (view?.status === "stale" && view.sourcePath)
      return {
        status: "stale",
        task: null,
        sourcePath: view.sourcePath,
        ...(view.historyPath ? { historyPath: view.historyPath } : {}),
        ...(view.contentHash ? { contentHash: view.contentHash } : {}),
        ...(view.error ? { error: view.error } : {}),
      };
    if (!view?.sourcePath && view?.status === "candidates") {
      const associatedCount = view.candidates.filter((candidate) => candidate.associated).length;
      const discoveryTruncated =
        view.candidatesTruncated === true ||
        (view.candidateCount ?? view.candidates.length) > view.candidates.length;
      if (view.discoveryComplete === false || associatedCount > 1 || discoveryTruncated)
        return {
          status: "pending-selection",
          task: null,
          sourcePath: null,
          error:
            view.error ??
            (discoveryTruncated || view.discoveryComplete === false
              ? "Heartbeat discovery was incomplete, so the runtime cannot confirm this chat's task-source association yet."
              : "Multiple heartbeat ledgers carry this chat association; task-source authority is unresolved while project Heartbeat remains available separately."),
        };
    }
    if (!view?.sourcePath)
      return view?.status === "error"
        ? {
            status: "error",
            task: null,
            sourcePath: null,
            ...(view.error ? { error: view.error } : {}),
          }
        : {
            status: view?.status === "candidates" ? "candidates" : "none",
            task: null,
            sourcePath: null,
          };
    if (view.status !== "ready")
      return {
        status: view.status === "stale" ? "stale" : "error",
        task: null,
        sourcePath: view.sourcePath,
        ...(view.contentHash ? { contentHash: view.contentHash } : {}),
        ...(view.error ? { error: view.error } : {}),
      };
    try {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      const inspect = await this.#inspector(root, config);
      const pair = await (await loadPairFilesApi()).readHeartbeatDisplay({
        canonicalDisplayOnly: true,
        root,
        path: view.sourcePath,
        now: this.#now(),
        pageSize: 5,
        inspect,
      });
      const contentHash = pair.contentHash;
      if (contentHash !== view.contentHash)
        return {
          status: "stale",
          task: null,
          sourcePath: view.sourcePath,
          contentHash,
          error: "Heartbeat ledger changed during projection; refresh before using its task view.",
        };
      if (pair.inventory.mode !== "items")
        throw new Error("Kit heartbeat inspector did not return an Items report.");
      const report = { ...pair.inventory, mode: "items" as const };
      const { parseHeartbeatTaskRoot, projectHeartbeatTask } = await loadHeartbeatTaskSourceApi();
      const taskRootId = parseHeartbeatTaskRoot(pair.headText);
      const canonicalTask = projectHeartbeatTask({
        report,
        root,
        threadId,
        path: view.sourcePath,
        contentHash,
        modifiedAt: pair.modifiedAt,
        ...(taskRootId === undefined ? {} : { taskRootId }),
      });
      const canonicalKey = JSON.stringify([threadId, view.sourcePath, contentHash]);
      for (const key of this.#canonicalTasks.keys()) {
        const [cachedThread, cachedPath] = JSON.parse(key) as string[];
        if (cachedThread === threadId && cachedPath === view.sourcePath)
          this.#canonicalTasks.delete(key);
      }
      this.#canonicalTasks.set(canonicalKey, canonicalTask);
      if (this.#canonicalTasks.size > 16) {
        const oldest = this.#canonicalTasks.keys().next().value;
        if (oldest !== undefined) this.#canonicalTasks.delete(oldest);
      }
      const task = compactProjectedTask(canonicalTask);
      // The newest wake and the task projection share this verified source hash.
      // Never use project-wide heartbeat data for a separately bound task.
      let recordedAgentObservation: HeartbeatTaskProjection["recordedAgentObservation"];
      const wake = pair.historyPage.wakes[0];
      if (wake?.orchestration && !wake.orchestrationError) {
        try {
          const snapshot = validateHeartbeatOrchestration(wake.orchestration);
          const plan = snapshot.agentPlan;
          const after = snapshot.after;
          if (
            after &&
            Date.parse(after.observedAt) <= this.#now().getTime() &&
            (!plan || (plan.parentThreadId === threadId && !Object.hasOwn(plan, "taskCycleId")))
          )
            recordedAgentObservation = {
              activeAgents: after.activeAgents,
              observedAt: after.observedAt,
            };
        } catch {
          /* Invalid source observations stay unknown. */
        }
      }
      return {
        status: "ready",
        task,
        sourcePath: view.sourcePath,
        ...(view.historyPath ? { historyPath: view.historyPath } : {}),
        contentHash,
        itemStatuses: task.source.itemStatuses,
        ...(recordedAgentObservation ? { recordedAgentObservation } : {}),
      };
    } catch (error) {
      if (isDisplayChanged(error))
        return { status: "pending", task: null, sourcePath: view.sourcePath, retryable: true };
      return {
        status: "error",
        task: null,
        sourcePath: view.sourcePath,
        ...(view.contentHash ? { contentHash: view.contentHash } : {}),
        error: shortened(String(error), 2_000),
      };
    }
  }

  /** Full-scope assignment is private and usable only with the exact verified source version. */
  agentTaskProgress(options: {
    threadId: string;
    sourcePath: string;
    contentHash: string;
    agents: readonly CurrentAgent[];
  }): AgentTaskProgress[] | null {
    const key = JSON.stringify([options.threadId, options.sourcePath, options.contentHash]);
    const task = this.#canonicalTasks.get(key);
    if (!task) return null;
    this.#canonicalTasks.delete(key);
    this.#canonicalTasks.set(key, task);
    return projectAgentTaskProgress({
      task: task as Parameters<typeof projectAgentTaskProgress>[0]["task"],
      agents: options.agents,
    });
  }

  async bind(threadId: string, path: string | null, cwd: string): Promise<HeartbeatView | null> {
    if (path !== null) {
      const root = await this.#project(cwd);
      const { discoverBoundHeartbeatSource } = await loadHeartbeatTaskSourceApi();
      const discovery = await discoverBoundHeartbeatSource({ root, threadId, ledgerPath: path });
      const candidate = discovery.candidates[0];
      if (!candidate || !discovery.boundSourceDigest)
        throw new Error("Heartbeat source must be a valid project ledger within the read limit.");
      const absolutePath = candidate.path;
      const pair = await (await loadPairFilesApi()).readHeartbeatDisplay({
        canonicalDisplayOnly: true,
        root,
        path: absolutePath,
        now: this.#now(),
        pageSize: 5,
      });
      if (pair.headDigest !== discovery.boundSourceDigest)
        throw new Error("Heartbeat source changed during binding; retry required.");
      await (await this.#relations()).set(threadId, { path: absolutePath, origin: "explicit" });
    } else {
      await (await this.#relations()).set(threadId, null);
      this.#watchers.get(threadId)?.close();
      this.#watchers.delete(threadId);
    }
    this.#cache.delete(threadId);
    for (const key of this.#canonicalTasks.keys()) {
      if (JSON.parse(key)[0] === threadId) this.#canonicalTasks.delete(key);
    }
    return this.view(threadId, cwd);
  }

  close(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#cache.clear();
    this.#canonicalTasks.clear();
    if (this.#ownsProjectViewCache) this.#projectViewCache.close();
  }
}
