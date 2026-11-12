import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HeartbeatTaskState } from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import {
  appendDurableLine,
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
  status: "none" | "candidates" | "ready" | "stale" | "error";
  sourcePath: string | null;
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
  contentHash?: string;
}
export interface HeartbeatHistoryPage {
  wakes: Record<string, unknown>[];
  nextCursor: string | null;
  total: number;
  sourcePath: string | null;
  contentHash?: string;
  itemStatuses?: Record<string, string>;
  error?: string;
}
export interface HeartbeatTaskProjection {
  status: "none" | "candidates" | "pending-selection" | "ready" | "stale" | "error";
  task: ProjectedHeartbeatTask | null;
  sourcePath: string | null;
  contentHash?: string;
  itemStatuses?: Record<string, string>;
  error?: string;
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
  const task = {
    ...sourceTask,
    title: shortened(sourceTask.title, 500),
    objectives,
    source: {
      ...sourceTask.source,
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
interface KitReport {
  mode: "items" | "current" | "history";
  certifiesCurrent: boolean;
  passed: boolean;
  wakes: Record<string, unknown>[];
  items: {
    id: string;
    item?: string;
    status?: string;
    evidence?: string;
    line?: number;
    children?: unknown;
    [field: string]: unknown;
  }[];
  findings: HeartbeatFinding[];
}
type Inspector = (text: string, options: Record<string, unknown>) => KitReport;
export interface HeartbeatOptions {
  kitPath?: string;
  fallbackKitPath?: string | null;
  refreshMs?: number;
  maxFiles?: number;
  maxDepth?: number;
  now?: () => Date;
  prepareWrite?: () => Promise<void>;
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
interface HeartbeatBinding {
  path: string;
  origin: "automatic" | "explicit";
}
type HeartbeatBindingValue = HeartbeatBinding | null;
interface CacheEntry {
  cwd: string;
  time: number;
  value: HeartbeatView | null;
}
const MAX_BYTES = 8 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
type HeartbeatTaskSourceApi = typeof import("vibe-coding-kit/src/tasks/heartbeat-task-source.mjs");
type HeartbeatAuditApi = typeof import("vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs");
type ProjectHeartbeatApi = typeof import("vibe-coding-kit/src/tasks/project-heartbeat.mjs");
let heartbeatTaskSourceApi: Promise<HeartbeatTaskSourceApi> | undefined;
let heartbeatAuditApi: Promise<HeartbeatAuditApi> | undefined;
let projectHeartbeatApi: Promise<ProjectHeartbeatApi> | undefined;
function loadHeartbeatTaskSourceApi(): Promise<HeartbeatTaskSourceApi> {
  heartbeatTaskSourceApi ??= import("vibe-coding-kit/src/tasks/heartbeat-task-source.mjs");
  return heartbeatTaskSourceApi;
}
function loadHeartbeatAuditApi(): Promise<HeartbeatAuditApi> {
  heartbeatAuditApi ??= import("vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs");
  return heartbeatAuditApi;
}
function loadProjectHeartbeatApi(): Promise<ProjectHeartbeatApi> {
  projectHeartbeatApi ??= import("vibe-coding-kit/src/tasks/project-heartbeat.mjs");
  return projectHeartbeatApi;
}
const PANEL_BYTES = 192 * 1024;
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
function compactWake(wake: Record<string, unknown>): Record<string, unknown> {
  const rows = Array.isArray(wake.rows) ? wake.rows : [];
  return {
    heading: shortened(wake.heading, 240),
    timeMs: typeof wake.timeMs === "number" && Number.isFinite(wake.timeMs) ? wake.timeMs : null,
    line: typeof wake.line === "number" ? wake.line : null,
    rows: rows.slice(0, 10).map((row: Record<string, unknown>) => ({
      num: typeof row.num === "number" ? row.num : null,
      category: shortened(row.category, 150),
      state: shortened(row.state, 500),
      line: typeof row.line === "number" ? row.line : null,
    })),
    rowCount: rows.length,
    truncated: true,
  };
}
function compactView(view: HeartbeatView): HeartbeatView {
  const value: HeartbeatView = {
    ...view,
    itemCount: view.itemCount ?? view.items.length,
    wakeCount: view.wakeCount ?? view.wakes.length,
    candidateCount: view.candidateCount ?? view.candidates.length,
    itemStatusCounts: view.itemStatusCounts ?? {},
    items: view.items.slice(0, 20).map(compactItem),
    wakes: view.wakes.slice(-5).map(compactWake),
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
  readonly #options: HeartbeatOptions;
  readonly #bindings = new Map<string, HeartbeatBindingValue>();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #projectCache = new Map<string, { time: number; value: HeartbeatView }>();
  readonly #last = new Map<string, HeartbeatView>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #observed = new Map<string, string>();
  readonly #pending = new Map<string, Promise<HeartbeatView | null>>();
  readonly #loaded: Promise<void>;
  readonly #restored = new Set<string>();
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(root: string, options: HeartbeatOptions = {}) {
    this.#root = resolve(root, "heartbeat");
    this.#options = options;
    this.#loaded = this.#loadBindings();
  }

  async #loadBindings(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(resolve(this.#root, "bindings.json"), "utf8"),
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (value === null) this.#bindings.set(key, null);
          else if (typeof value === "string")
            this.#bindings.set(key, { path: value, origin: "explicit" });
          else if (value && typeof value === "object" && !Array.isArray(value)) {
            const binding = value as Partial<HeartbeatBinding>;
            if (
              typeof binding.path === "string" &&
              (binding.origin === "automatic" || binding.origin === "explicit")
            )
              this.#bindings.set(key, { path: binding.path, origin: binding.origin });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #prepareWritable(): Promise<void> {
    await this.#options.prepareWrite?.();
    await ensurePrivateDirectory(this.#root);
  }

  async #persistBinding(threadId: string, binding: HeartbeatBindingValue): Promise<void> {
    this.#bindings.set(threadId, binding);
    await this.#prepareWritable();
    const serialized = JSON.stringify(Object.fromEntries(this.#bindings));
    const save = this.#saveQueue.then(() =>
      atomicWriteFile(resolve(this.#root, "bindings.json"), serialized),
    );
    this.#saveQueue = save.catch(() => undefined);
    await save;
  }

  async #restore(threadId: string): Promise<void> {
    if (this.#restored.has(threadId)) return;
    try {
      const saved = JSON.parse(
        await readFile(resolve(this.#root, `${hash(threadId)}.snapshot.json`), "utf8"),
      ) as { key: string; view: HeartbeatView };
      if (saved.view.status === "ready" && saved.view.sourcePath && saved.view.contentHash) {
        this.#last.set(threadId, compactView(saved.view));
        this.#observed.set(threadId, saved.key);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#restored.add(threadId);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** Reads the current project's canonical heartbeat source without consulting chat bindings. */
  async projectView(cwd: string): Promise<HeartbeatView> {
    const now = this.#now();
    const refreshedAt = now.toISOString();
    let root: string | null = null;
    try {
      root = await this.#project(cwd);
      const cached = this.#projectCache.get(root);
      if (cached && now.getTime() - cached.time < (this.#options.refreshMs ?? 30_000))
        return cached.value;
      const config = await this.#config(root);
      const { readProjectHeartbeat } = await loadProjectHeartbeatApi();
      const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
      const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
      const cadence = config.heartbeat?.cadenceMinutes;
      const report = await readProjectHeartbeat({
        root,
        ...(config.heartbeat?.ledgerPath ? { ledgerPath: config.heartbeat.ledgerPath } : {}),
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
        candidates: [],
        refreshedAt,
        modifiedAt: source?.modifiedAt ?? null,
        lastWakeAt: source?.lastRecordedAt ?? null,
        nextWakeAt,
        cadenceMinutes: source?.cadence?.intervalMinutes ?? null,
        certifiesCurrent: source?.current.certifiesCurrent ?? false,
        passed: source?.current.passed ?? false,
        items: inventoryItems,
        wakes: source?.history.wakes.map((wake) => ({ ...wake })) ?? [],
        findings: source?.current.findings ?? [],
        itemCount: inventoryItems.length,
        wakeCount: source?.history.wakeCount ?? 0,
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
      this.#projectCache.set(root, { time: now.getTime(), value: view });
      return view;
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
      if (root) this.#projectCache.set(root, { time: now.getTime(), value: view });
      return view;
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
    const fallback =
      this.#options.fallbackKitPath === undefined
        ? resolve(
            homedir(),
            "Workspace/Project/vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs",
          )
        : this.#options.fallbackKitPath;
    const paths = [
      this.#options.kitPath,
      config.heartbeat?.kitPath && resolve(root, config.heartbeat.kitPath),
      resolve(root, ".vibe-coding/kit/src/supervision/heartbeat-ledger-api.mjs"),
      fallback,
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
    throw new Error(
      "Kit heartbeat API unavailable. Configure heartbeat.kitPath in .codex-task-progress.json.",
    );
  }

  #observeFile(threadId: string, path: string): void {
    this.#watchers.get(threadId)?.close();
    try {
      const watcher = watch(dirname(path), { persistent: false }, () =>
        this.#cache.delete(threadId),
      );
      watcher.on("error", () => this.#cache.delete(threadId));
      this.#watchers.set(threadId, watcher);
    } catch {
      /* view() also performs bounded-time polling. */
    }
  }

  async view(threadId: string, cwd: string): Promise<HeartbeatView | null> {
    await this.#loaded;
    const cached = this.#cache.get(threadId);
    const now = this.#now().getTime();
    if (cached?.cwd === cwd && now - cached.time < (this.#options.refreshMs ?? 30_000))
      return cached.value;
    const pending = this.#pending.get(threadId);
    if (pending) return pending;
    const operation = this.#read(threadId, cwd)
      .then((value) => {
        this.#cache.set(threadId, { cwd, time: now, value });
        return value;
      })
      .finally(() => this.#pending.delete(threadId));
    this.#pending.set(threadId, operation);
    return operation;
  }

  async #read(threadId: string, cwd: string): Promise<HeartbeatView | null> {
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
    const binding = this.#bindings.get(threadId);
    if (binding === null) return null;
    let source = binding?.path;
    let sourceOrigin = binding?.origin;
    try {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      if (source) {
        source = await realpath(source);
        if (!within(root, source))
          throw new Error("Bound heartbeat source is outside the project root.");
      }
      const { discoverHeartbeatLedgerSources } = await loadHeartbeatTaskSourceApi();
      const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
      const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
      const discoveryLedgerPath = source ?? config.heartbeat?.ledgerPath;
      const discovery = await discoverHeartbeatLedgerSources({
        root,
        threadId,
        ...(discoveryLedgerPath ? { ledgerPath: discoveryLedgerPath } : {}),
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      });
      const candidates = discovery.candidates;
      if (source === undefined) {
        const previouslyObserved = this.#last.get(threadId)?.sourcePath;
        if (previouslyObserved) {
          source = previouslyObserved;
          sourceOrigin = "automatic";
          await this.#persistBinding(threadId, { path: source, origin: "automatic" });
        } else if (!discovery.complete) {
          return compactView({
            ...empty,
            candidates,
            candidateCount: candidates.length,
            discoveryComplete: false,
            discoveryVisitedFiles: discovery.visitedFiles,
            discoveryLimits: discovery.limits,
            discoveryReasons: discovery.reasons,
            error:
              "Automatic task-source association is unresolved because project discovery is incomplete; the runtime cannot confirm this chat's task source yet.",
          });
        } else {
          const associated = candidates.filter((candidate) => candidate.associated);
          if (associated.length > 1)
            return compactView({
              ...empty,
              candidates,
              candidateCount: candidates.length,
              discoveryComplete: true,
              discoveryVisitedFiles: discovery.visitedFiles,
              discoveryLimits: discovery.limits,
              discoveryReasons: discovery.reasons,
            });
          if (associated.length === 0) {
            if (candidates.length)
              return compactView({
                ...empty,
                candidates,
                candidateCount: candidates.length,
                discoveryComplete: true,
                discoveryVisitedFiles: discovery.visitedFiles,
                discoveryLimits: discovery.limits,
                discoveryReasons: discovery.reasons,
              });
            return null;
          }
          source = associated[0]?.path;
          if (source) {
            sourceOrigin = "automatic";
            await this.#persistBinding(threadId, { path: source, origin: "automatic" });
          }
        }
      }
      const selectedCandidate = candidates.find((candidate) => candidate.path === source);
      if (!selectedCandidate)
        throw new Error(
          "The bound chat task source is absent from the current project scan; it remains read-only while the runtime reconciles source status.",
        );
      if (sourceOrigin === "automatic" && !selectedCandidate.associated)
        throw new Error(
          "The automatic chat task-source association is no longer confirmed; the source remains read-only while the runtime reconciles task authority.",
        );
      if (!source) return null;
      this.#observeFile(threadId, source);
      const info = await stat(source);
      if (info.size > MAX_BYTES) throw new Error("Heartbeat ledger exceeds 8 MiB read limit.");
      const text = await readFile(source, "utf8");
      const inspect = await this.#inspector(root, config);
      const current = inspect(text, {
        mode: "current",
        latest: true,
        ledgerPath: source,
        now: this.#now(),
      });
      const history = inspect(text, {
        mode: "history",
        latest: false,
        ledgerPath: source,
        now: this.#now(),
      });
      const inventory = inspect(text, { mode: "items", ledgerPath: source, now: this.#now() });
      const times = history.wakes
        .map((wake) => wake.timeMs)
        .filter((time): time is number => typeof time === "number" && Number.isFinite(time));
      const lastTime = times.length ? Math.max(...times) : null;
      const cadence = config.heartbeat?.cadenceMinutes;
      const cadenceMinutes =
        typeof cadence === "number" && cadence > 0 && Number.isFinite(cadence) ? cadence : null;
      const explicitNext = config.heartbeat?.nextWakeAt;
      const cadenceNextWake =
        lastTime !== null && cadenceMinutes !== null
          ? (await loadHeartbeatAuditApi()).heartbeatAuditDue(text, {
              now: this.#now(),
              intervalMinutes: cadenceMinutes,
            }).nextDueAt
          : null;
      const nextWakeAt =
        explicitNext && Number.isFinite(Date.parse(explicitNext))
          ? new Date(explicitNext).toISOString()
          : cadenceNextWake;
      const itemStatusCounts = countItemStatuses(inventory.items);
      const view: HeartbeatView = compactView({
        ...empty,
        status: "ready",
        sourcePath: source,
        candidates,
        candidateCount: candidates.length,
        discoveryComplete: discovery.complete,
        discoveryVisitedFiles: discovery.visitedFiles,
        discoveryLimits: discovery.limits,
        discoveryReasons: discovery.reasons,
        modifiedAt: info.mtime.toISOString(),
        contentHash: hash(text),
        lastWakeAt: lastTime === null ? null : new Date(lastTime).toISOString(),
        nextWakeAt,
        cadenceMinutes,
        certifiesCurrent: current.certifiesCurrent,
        passed: current.passed,
        items: inventory.items,
        wakes: history.wakes,
        findings: current.findings,
        itemCount: inventory.items.length,
        wakeCount: history.wakes.length,
        itemStatusCounts,
      });
      this.#last.set(threadId, view);
      const eventKey = `${source}:${view.contentHash}`;
      if (this.#observed.get(threadId) !== eventKey) {
        await this.#prepareWritable();
        await appendDurableLine(
          resolve(this.#root, `${hash(threadId)}.jsonl`),
          JSON.stringify({
            type: "heartbeat.observed",
            threadId,
            observedAt: now,
            sourcePath: source,
            contentHash: view.contentHash,
            lastWakeAt: view.lastWakeAt,
            certifiesCurrent: view.certifiesCurrent,
          }),
        );
        this.#observed.set(threadId, eventKey);
        await atomicWriteFile(
          resolve(this.#root, `${hash(threadId)}.snapshot.json`),
          JSON.stringify({ key: eventKey, view }),
        );
      }
      return view;
    } catch (error) {
      const previous = this.#last.get(threadId);
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

  async history(
    threadId: string,
    cwd: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<HeartbeatHistoryPage> {
    const before = options.cursor === undefined ? null : Number(options.cursor);
    if (before !== null && (!Number.isSafeInteger(before) || before < 0))
      throw new Error("Invalid heartbeat history cursor.");
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("Heartbeat history limit must be 1–10.");
    const empty = (sourcePath: string | null, error?: string, contentHash?: string) => ({
      wakes: [],
      nextCursor: null,
      total: 0,
      sourcePath,
      ...(contentHash ? { contentHash } : {}),
      ...(error ? { error: shortened(error, 2_000) } : {}),
    });
    const view = await this.view(threadId, cwd);
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
      );
    try {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      const sourcePath = await realpath(view.sourcePath);
      if (!within(root, sourcePath) || sourcePath !== view.sourcePath)
        throw new Error("Bound heartbeat source changed outside its verified project path.");
      const info = await stat(sourcePath);
      if (info.size > MAX_BYTES) throw new Error("Heartbeat ledger exceeds 8 MiB read limit.");
      const text = await readFile(sourcePath, "utf8");
      const contentHash = hash(text);
      if (contentHash !== view.contentHash)
        return empty(
          sourcePath,
          "Heartbeat ledger changed while reading history; refresh before using its audit history.",
          contentHash,
        );
      const inspect = await this.#inspector(root, config);
      const report = inspect(text, {
        mode: "history",
        latest: false,
        ledgerPath: sourcePath,
        now: this.#now(),
      });
      if (report.mode !== "history")
        throw new Error("Kit heartbeat inspector did not return a History report.");
      const end = before === null ? report.wakes.length : Math.min(before, report.wakes.length);
      const records = report.wakes.slice(Math.max(0, end - limit), end).reverse();
      const wakes: Record<string, unknown>[] = [];
      for (const record of records) {
        const compact = compactWake(record);
        if (wakes.length && Buffer.byteLength(JSON.stringify([...wakes, compact])) > PANEL_BYTES)
          break;
        wakes.push(compact);
      }
      const remaining = end - wakes.length;
      return {
        wakes,
        nextCursor: remaining > 0 ? String(remaining) : null,
        total: report.wakes.length,
        sourcePath,
        contentHash,
      };
    } catch (error) {
      return empty(view.sourcePath, String(error), view.contentHash);
    }
  }

  /** Projects paginated audit history for the current project source, without chat IDs. */
  async projectHistory(
    cwd: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<HeartbeatHistoryPage> {
    const view = await this.projectView(cwd);
    if (!view.sourcePath) return { wakes: [], nextCursor: null, total: 0, sourcePath: null };
    const before = options.cursor === undefined ? null : Number(options.cursor);
    if (before !== null && (!Number.isSafeInteger(before) || before < 0))
      throw new Error("Invalid heartbeat history cursor.");
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("Heartbeat history limit must be 1–10.");
    const root = await this.#project(cwd);
    const config = await this.#config(root);
    const { readProjectHeartbeat } = await loadProjectHeartbeatApi();
    const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
    const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
    const cadence = config.heartbeat?.cadenceMinutes;
    const report = await readProjectHeartbeat({
      root,
      ...(config.heartbeat?.ledgerPath ? { ledgerPath: config.heartbeat.ledgerPath } : {}),
      now: this.#now(),
      ...(maxFiles === undefined ? {} : { maxFiles }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0
        ? { intervalMinutes: cadence }
        : {}),
    });
    const source = report.source;
    if (!source || source.path !== view.sourcePath)
      return { wakes: [], nextCursor: null, total: 0, sourcePath: view.sourcePath };
    const wakesAll = source.history.wakes;
    const end = before === null ? wakesAll.length : Math.min(before, wakesAll.length);
    const records = wakesAll.slice(Math.max(0, end - limit), end).reverse();
    const wakes: Record<string, unknown>[] = [];
    for (const record of records) {
      const compact = compactWake({ ...record });
      if (wakes.length && Buffer.byteLength(JSON.stringify([...wakes, compact])) > PANEL_BYTES)
        break;
      wakes.push(compact);
    }
    const remaining = end - wakes.length;
    return {
      wakes,
      nextCursor: remaining > 0 ? String(remaining) : null,
      total: source.history.wakeCount,
      sourcePath: source.path,
    };
  }

  /** Returns the canonical Kit projection only for a fresh, successfully read source ledger. */
  async taskProjection(threadId: string, cwd: string): Promise<HeartbeatTaskProjection> {
    const view = await this.view(threadId, cwd);
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
            (discoveryTruncated
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
      const info = await stat(view.sourcePath);
      if (info.size > MAX_BYTES) throw new Error("Heartbeat ledger exceeds 8 MiB read limit.");
      const text = await readFile(view.sourcePath, "utf8");
      const contentHash = hash(text);
      if (contentHash !== view.contentHash)
        return {
          status: "stale",
          task: null,
          sourcePath: view.sourcePath,
          contentHash,
          error: "Heartbeat ledger changed during projection; refresh before using its task view.",
        };
      const inspect = await this.#inspector(root, config);
      const inspected = inspect(text, {
        mode: "items",
        ledgerPath: view.sourcePath,
        now: this.#now(),
      });
      if (inspected.mode !== "items")
        throw new Error("Kit heartbeat inspector did not return an Items report.");
      const report = { ...inspected, mode: "items" as const };
      const { projectHeartbeatTask } = await loadHeartbeatTaskSourceApi();
      const canonicalTask = projectHeartbeatTask({
        report,
        root,
        threadId,
        path: view.sourcePath,
        contentHash,
        modifiedAt: info.mtime.toISOString(),
      });
      const task = compactProjectedTask(canonicalTask);
      return {
        status: "ready",
        task,
        sourcePath: view.sourcePath,
        contentHash,
        itemStatuses: task.source.itemStatuses,
      };
    } catch (error) {
      return {
        status: "error",
        task: null,
        sourcePath: view.sourcePath,
        ...(view.contentHash ? { contentHash: view.contentHash } : {}),
        error: shortened(String(error), 2_000),
      };
    }
  }

  async bind(threadId: string, path: string | null, cwd: string): Promise<HeartbeatView | null> {
    await this.#loaded;
    if (path !== null) {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      const { discoverHeartbeatLedgerSources } = await loadHeartbeatTaskSourceApi();
      const maxFiles = config.heartbeat?.maxFiles ?? this.#options.maxFiles;
      const maxDepth = config.heartbeat?.maxDepth ?? this.#options.maxDepth;
      const discovery = await discoverHeartbeatLedgerSources({
        root,
        threadId,
        ...(config.heartbeat?.ledgerPath ? { ledgerPath: config.heartbeat.ledgerPath } : {}),
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      });
      const candidates = discovery.candidates;
      const requestedPath = resolve(root, path);
      const absolutePath = await realpath(requestedPath).catch(() => requestedPath);
      if (!candidates.some((candidate) => candidate.path === absolutePath))
        throw new Error("Heartbeat source must be a discovered project ledger.");
      await this.#persistBinding(threadId, { path: absolutePath, origin: "explicit" });
    } else {
      await this.#persistBinding(threadId, null);
      this.#watchers.get(threadId)?.close();
      this.#watchers.delete(threadId);
    }
    this.#cache.delete(threadId);
    return this.view(threadId, cwd);
  }

  close(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#cache.clear();
    this.#projectCache.clear();
  }
}
