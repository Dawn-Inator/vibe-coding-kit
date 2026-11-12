import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  status: "candidates" | "ready" | "stale" | "error";
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
  error?: string;
  contentHash?: string;
}
interface KitReport {
  certifiesCurrent: boolean;
  passed: boolean;
  wakes: Record<string, unknown>[];
  items: Record<string, unknown>[];
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
}
interface ProjectConfig {
  heartbeat?: {
    ledgerPath?: string;
    kitPath?: string;
    cadenceMinutes?: number;
    nextWakeAt?: string;
  };
}
interface CacheEntry {
  cwd: string;
  time: number;
  value: HeartbeatView | null;
}
const SKIP = new Set([".git", "node_modules", "dist", "build", "runtime", "vendor", ".cache"]);
const MAX_BYTES = 8 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Read-only ledger consumer. It never arms timers or writes project/Kit files. */
export class HeartbeatService {
  readonly #root: string;
  readonly #options: HeartbeatOptions;
  readonly #bindings = new Map<string, string | null>();
  readonly #cache = new Map<string, CacheEntry>();
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
          if (typeof value === "string" || value === null) this.#bindings.set(key, value);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #restore(threadId: string): Promise<void> {
    if (this.#restored.has(threadId)) return;
    try {
      const saved = JSON.parse(
        await readFile(resolve(this.#root, `${hash(threadId)}.snapshot.json`), "utf8"),
      ) as { key: string; view: HeartbeatView };
      if (saved.view.status === "ready" && saved.view.sourcePath && saved.view.contentHash) {
        this.#last.set(threadId, saved.view);
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

  async #project(cwd: string): Promise<string> {
    const initial = resolve(cwd);
    let current = initial;
    while (true) {
      try {
        await stat(resolve(current, ".git"));
        return current;
      } catch {
        /* Ascend. */
      }
      const parent = dirname(current);
      if (parent === current || current === homedir()) return initial;
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

  async #discover(
    root: string,
    threadId: string,
    config: ProjectConfig,
  ): Promise<HeartbeatCandidate[]> {
    const candidates: HeartbeatCandidate[] = [];
    let visited = 0;
    const inspect = async (path: string) => {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size > MAX_BYTES) return;
      const text = await readFile(path, "utf8").catch(() => "");
      // Discovery excludes fenced examples; the Kit remains the only ledger parser.
      let fence: string | null = null;
      const content = text
        .split("\n")
        .filter((line) => {
          const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
          if (marker) {
            if (fence === null) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            return false;
          }
          return fence === null;
        })
        .join("\n");
      const wakeLedger =
        /^##\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\s+wake\s*\((?:8|10)-row ledger\)\s*$/m.test(
          content,
        );
      const namedHeartbeat =
        /heartbeat/i.test(basename(path)) ||
        path === resolve(root, config.heartbeat?.ledgerPath ?? "");
      const itemsOnlyLedger =
        namedHeartbeat &&
        /^##\s+Items\s*$/m.test(content) &&
        /^\|\s*id\s*\|\s*source\s*\|\s*item\s*\|\s*status\s*\|\s*evidence\s*\|/im.test(content);
      if (!wakeLedger && !itemsOnlyLedger) return;
      const escaped = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const associated = new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, "m").test(
        text,
      );
      candidates.push({ path, associated });
    };
    if (config.heartbeat?.ledgerPath) {
      const path = resolve(root, config.heartbeat.ledgerPath);
      if (within(root, path)) await inspect(path);
    }
    const scan = async (directory: string, depth: number): Promise<void> => {
      if (depth > (this.#options.maxDepth ?? 5)) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const priority = (name: string) => {
        if (/heartbeat/i.test(name)) return 0;
        if ([".workspace", ".todolist", ".codex", "doc", "docs"].includes(name)) return 1;
        return 2;
      };
      entries.sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visited > (this.#options.maxFiles ?? 2500)) return;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory() && !SKIP.has(entry.name)) await scan(path, depth + 1);
        else if (
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          !candidates.some((c) => c.path === path)
        )
          await inspect(path);
      }
    };
    await scan(root, 0);
    return candidates.sort((a, b) => a.path.localeCompare(b.path));
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
    };
    let source = this.#bindings.get(threadId);
    if (source === null) return null;
    try {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      const candidates = await this.#discover(root, threadId, config);
      if (source === undefined) {
        const associated = candidates.filter((candidate) => candidate.associated);
        if (associated.length !== 1) {
          if (candidates.length) return { ...empty, candidates };
          source = this.#last.get(threadId)?.sourcePath ?? undefined;
          if (!source) return null;
        } else source = associated[0]?.path;
      }
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
      const nextWakeAt =
        explicitNext && Number.isFinite(Date.parse(explicitNext))
          ? new Date(explicitNext).toISOString()
          : lastTime !== null && cadenceMinutes !== null
            ? new Date(lastTime + cadenceMinutes * 60_000).toISOString()
            : null;
      const view: HeartbeatView = {
        ...empty,
        status: "ready",
        sourcePath: source,
        candidates,
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
      };
      this.#last.set(threadId, view);
      const eventKey = `${source}:${view.contentHash}`;
      if (this.#observed.get(threadId) !== eventKey) {
        await ensurePrivateDirectory(this.#root);
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
      return {
        ...(previous ?? empty),
        status: previous ? "stale" : "error",
        sourcePath: source ?? null,
        refreshedAt: now,
        certifiesCurrent: false,
        error: String(error),
      };
    }
  }

  async bind(threadId: string, path: string | null, cwd: string): Promise<HeartbeatView | null> {
    await this.#loaded;
    if (path !== null) {
      const root = await this.#project(cwd);
      const config = await this.#config(root);
      const candidates = await this.#discover(root, threadId, config);
      const absolutePath = resolve(root, path);
      if (!candidates.some((candidate) => candidate.path === absolutePath))
        throw new Error("Heartbeat source must be a discovered project ledger.");
      this.#bindings.set(threadId, absolutePath);
    } else {
      this.#bindings.set(threadId, null);
      this.#watchers.get(threadId)?.close();
      this.#watchers.delete(threadId);
    }
    const serialized = JSON.stringify(Object.fromEntries(this.#bindings));
    const save = this.#saveQueue.then(() =>
      atomicWriteFile(resolve(this.#root, "bindings.json"), serialized),
    );
    this.#saveQueue = save.catch(() => undefined);
    await save;
    this.#cache.delete(threadId);
    return this.view(threadId, cwd);
  }

  close(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#cache.clear();
  }
}
