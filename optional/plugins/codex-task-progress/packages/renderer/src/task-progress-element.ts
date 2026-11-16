import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Clock,
  FileText,
  List,
  type LucideIconData,
  type LucideIconNode,
  RefreshCw,
} from "@lucide/icons";
import { html, LitElement, nothing, type PropertyValues, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { HeartbeatOrchestrationProjection } from "vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs";
import type {
  SubagentProgressEntry,
  SubagentProgressSnapshot,
} from "vibe-coding-kit/src/tasks/subagent-progress.mjs";
import type {
  TaskArchivePage,
  TaskArchiveSubtasksPage,
  TaskArchiveTasksPage,
  TaskLifecycle,
} from "vibe-coding-kit/src/tasks/task-contract.mjs";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/release-version.js";
import { taskPanelStyles } from "./styles/task-panel.js";

export interface TaskPanelEvidence {
  summary: string;
  verification: "reported" | "verified";
  kind?: string;
  reference?: string;
}
export interface TaskPanelItem {
  id: string;
  title: string;
  status: string;
  evidence: readonly TaskPanelEvidence[];
}
export interface TaskPanelObjective extends TaskPanelItem {
  required: boolean;
  items: readonly TaskPanelItem[];
}
export interface TaskPanelState {
  threadId: string;
  title: string;
  revision: number;
  updatedAt: string;
  objectives: readonly TaskPanelObjective[];
  progress: { completed: number; total: number; percent: number | null };
  phase: string;
  lifecycle?: TaskLifecycle;
  source?: {
    kind: "kit-heartbeat";
    path: string;
    historyPath?: string;
    readOnly: true;
    contentHash?: string;
    error?: string;
    itemStatuses?: Readonly<Record<string, string>>;
    itemStatusCount?: number;
    linkRiskCount?: number;
    linkRisks?: readonly string[];
    presentation?: {
      truncated: boolean;
      sourceItemCount: number;
      displayedItemCount: number;
      itemStatusesTruncated: boolean;
      linkRisksTruncated: boolean;
    };
  };
}
export interface TaskPanelHeartbeat {
  status: "none" | "candidates" | "ready" | "stale" | "error" | "pending";
  retryable?: boolean;
  sourcePath: string | null;
  historyPath?: string;
  contentHash?: string;
  candidates: readonly { path: string; associated: boolean }[];
  refreshedAt: string;
  modifiedAt: string | null;
  lastWakeAt: string | null;
  nextWakeAt: string | null;
  cadenceMinutes: number | null;
  certifiesCurrent: boolean;
  passed: boolean;
  discoveryComplete?: boolean;
  discoveryReasons?: readonly string[];
  items: readonly Record<string, unknown>[];
  wakes: readonly Record<string, unknown>[];
  itemCount?: number;
  wakeCount?: number;
  itemsTruncated?: boolean;
  wakesTruncated?: boolean;
  itemStatusCounts?: Readonly<Record<string, number>>;
  findings: readonly { severity: string; message: string; rule?: string }[];
  findingsTruncated?: boolean;
  error?: string;
  warning?: string;
  basis?: "configured" | "latest-recorded-wake" | "items-inventory" | "none";
}
export interface TaskPanelHistory {
  events: readonly Record<string, unknown>[];
  nextCursor: string | null;
  error?: string;
  canonicalHistoryPath?: string;
}
export interface TaskPanelSourceHistory {
  events: readonly Record<string, unknown>[];
  nextCursor: string | null;
  wakes: readonly Record<string, unknown>[];
  total: number;
  source: {
    kind: "kit-heartbeat";
    path: string | null;
    historyPath?: string;
    readOnly: true;
    contentHash?: string;
    error?: string;
    retryable?: boolean;
    itemStatuses?: Readonly<Record<string, string>>;
  };
}
export interface TaskPanelHeartbeatHistory {
  wakes: readonly Record<string, unknown>[];
  nextCursor: string | null;
  total: number;
  sourcePath?: string | null;
  contentHash?: string;
  error?: string;
  retryable?: boolean;
}
export interface TaskPanelExecution {
  state: "working" | "waiting" | "idle" | "unknown";
  observedAt: string;
  source: "codex-app-server" | "codex-ui";
  activeFlags?: readonly string[];
}
export interface TaskPanelResponse {
  subagents?: SubagentProgressSnapshot | null;
  enabled?: boolean;
  presentation?: {
    scope: string;
    pending: boolean;
    cached: boolean;
    updatedAt: number | null;
    error?: string;
  };
  task: TaskPanelState | null;
  heartbeat: TaskPanelHeartbeat | null;
  heartbeatPending?: boolean;
  taskSourcePending?: boolean;
  taskSource?: {
    status: "candidates" | "pending-selection" | "ready" | "stale" | "error" | "pending";
    retryable?: boolean;
    path?: string;
    historyPath?: string;
    readOnly: true;
    contentHash?: string;
    error?: string;
    itemStatuses?: Readonly<Record<string, string>>;
    itemStatusCount?: number;
  } | null;
  history?: TaskPanelHistory | TaskPanelSourceHistory;
  heartbeatHistory?: TaskPanelHeartbeatHistory;
  execution?: TaskPanelExecution;
  completionBasis?: "registered-checklist" | "task-lifecycle";
  archiveCount?: number | null;
  archive?:
    | (TaskArchivePage & { available?: true })
    | { available: false; reason?: string; currentTaskId: string | null };
}
export type TaskPanelViewState = Readonly<{
  threadId: string;
  tab: "tasks" | "history" | "heartbeat";
  selectedObjective: string | null;
  taskMode?: "subagents" | "registered-tasks";
  taskContext: string;
  history: TaskPanelHistory | TaskPanelSourceHistory | null;
  historyContext: string | null;
  heartbeatHistory: TaskPanelHeartbeatHistory | null;
  heartbeatHistoryContext: string | null;
  wakeExpansion: readonly (readonly [string, boolean])[];
}>;

export interface TaskPanelRequest {
  method: "get" | "history" | "bind-heartbeat" | "heartbeat-history" | "archive";
  threadId: string;
  cursor?: string;
  taskId?: string;
  limit?: number;
  path?: string | null;
}
export type TaskPanelRequester = (input: TaskPanelRequest) => Promise<TaskPanelResponse>;

export const TASK_PROGRESS_ELEMENT_NAME = "codex-task-panel";
export class TaskProgressElement extends LitElement {
  static override properties = {
    data: { attribute: false, noAccessor: true },
    observed: { attribute: false },
    threadId: { attribute: false },
    requester: { attribute: false },
    refreshTask: { attribute: false },
    refreshing: { attribute: false },
    connectionError: { attribute: false },
    expanded: { state: true },
    tab: { state: true },
    selectedObjective: { state: true },
    taskMode: { state: true },
    history: { state: true },
    heartbeatHistory: { state: true },
    heartbeatBusy: { state: true },
    refreshViewBusy: { state: true },
    busy: { state: true },
    locale: { attribute: false },
    archiveOpen: { state: true },
    archiveBusy: { state: true },
  };

  static override styles = taskPanelStyles;

  private panelData: TaskPanelResponse = { task: null, heartbeat: null };
  get data(): TaskPanelResponse {
    return this.panelData;
  }
  set data(value: TaskPanelResponse) {
    const old = this.panelData;
    const previousScope = JSON.stringify([
      old.presentation?.scope ?? null,
      old.task?.source?.path ?? old.taskSource?.path ?? null,
    ]);
    const nextScope = JSON.stringify([
      value.presentation?.scope ?? null,
      value.task?.source?.path ?? value.taskSource?.path ?? null,
    ]);
    if (previousScope !== nextScope) this.selectedObjective = null;
    this.panelData = value;
    const context = this.currentArchiveContext();
    if (context !== this.archiveContext) {
      this.clearArchive();
      this.archiveContext = context;
    }
    this.adoptCachedPages();
    this.requestUpdate("data", old);
  }
  declare observed: boolean;
  declare threadId: string | null;
  declare requester: TaskPanelRequester | null;
  declare refreshTask: (() => Promise<void>) | null;
  declare refreshing: boolean;
  declare connectionError: string | null;
  declare presentation: "panel";
  declare expanded: boolean;
  declare locale: string;
  private declare tab: "tasks" | "history" | "heartbeat";
  private sizeObserver: ResizeObserver | null = null;
  private heartbeatRequest = 0;
  private refreshViewGeneration = 0;
  private declare selectedObjective: string | null;
  private declare taskMode: "subagents" | "registered-tasks";
  private declare history: TaskPanelHistory | TaskPanelSourceHistory | null;
  private declare heartbeatHistory: TaskPanelHeartbeatHistory | null;
  private declare heartbeatBusy: boolean;
  private declare refreshViewBusy: boolean;
  private heartbeatHistoryContext: string | null = null;
  private heartbeatHistoryAttemptedContext: string | null = null;
  private heartbeatHistoryObservedContext: string | null | undefined;
  private heartbeatHistoryError: string | null = null;
  private heartbeatHistoryErrorContext: string | null = null;
  private heartbeatHistoryRetryContext: string | null = null;
  private historyRetryContext: string | null = null;
  private historyAutoRetries = 0;
  private heartbeatAutoRetries = 0;
  private heartbeatWakeExpansion = new Map<string, boolean>();
  private declare busy: boolean;
  private historyThread: string | null = null;
  private historyContext: string | null = null;
  private historyRequest = 0;
  private declare archiveOpen: boolean;
  private declare archiveBusy: boolean;
  private archiveGeneration = 0;
  private archiveContext: string | null = null;
  private archivePage: TaskArchiveTasksPage | null = null;
  private archiveDetails = new Map<string, TaskArchiveSubtasksPage>();
  private archiveExpanded = new Set<string>();
  private archiveError: string | null = null;
  private archiveRetry: { taskId?: string; cursor?: string } = {};

  constructor() {
    super();
    this.data = { task: null, heartbeat: null };
    this.observed = false;
    this.threadId = null;
    this.requester = null;
    this.refreshTask = null;
    this.refreshing = false;
    this.refreshViewGeneration = 0;
    this.connectionError = null;
    this.expanded = true;
    this.presentation = "panel";
    this.locale = "en";
    this.tab = "tasks";
    this.taskMode = "subagents";
    this.selectedObjective = null;
    this.history = null;
    this.heartbeatHistory = null;
    this.heartbeatBusy = false;
    this.refreshViewBusy = false;
    this.heartbeatHistoryContext = null;
    this.heartbeatHistoryAttemptedContext = null;
    this.heartbeatHistoryObservedContext = undefined;
    this.heartbeatHistoryError = null;
    this.heartbeatHistoryErrorContext = null;
    this.heartbeatHistoryRetryContext = null;
    this.historyRetryContext = null;
    this.historyAutoRetries = 0;
    this.heartbeatAutoRetries = 0;
    this.heartbeatWakeExpansion.clear();
    this.busy = false;
    this.archiveOpen = false;
    this.archiveBusy = false;
  }

  private t(en: string, zh: string): string {
    return this.locale.toLowerCase().startsWith("zh") ? zh : en;
  }

  private date(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return date.toLocaleString(this.locale || "en");
  }

  private time(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleTimeString(this.locale || "en", { hour: "2-digit", minute: "2-digit" })
      : "—";
  }

  private dateOnly(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString(this.locale || "en", {
          month: "short",
          day: "numeric",
        })
      : String(value);
  }

  private wakeHeading(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return String(value);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const today = new Date();
    const isToday =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    const datePart = isToday
      ? this.t("Today", "今天")
      : date.toLocaleDateString(this.locale || "en", { month: "short", day: "numeric" });
    const timePart = date.toLocaleTimeString(this.locale || "en", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${datePart} ${timePart}`;
  }

  private status(value: string): string {
    const labels: Record<string, string> = {
      pending: "待开始",
      active: "进行中",
      completed: "已完成",
      blocked: "阻塞",
      cancelled: "已取消",
    };
    return this.locale.startsWith("zh")
      ? (labels[value] ?? value)
      : value === "active"
        ? "Working"
        : value;
  }

  private currentTaskContext(): string {
    return JSON.stringify([
      this.threadId,
      this.data.presentation?.scope ?? null,
      this.data.task?.source?.path ?? this.data.taskSource?.path ?? null,
      this.data.task?.source?.contentHash ?? this.data.taskSource?.contentHash ?? null,
      this.data.task?.lifecycle ?? null,
    ]);
  }

  private cachedHistoryMatches(page: TaskPanelHistory | TaskPanelSourceHistory): boolean {
    const source = this.historySource();
    return source
      ? "source" in page &&
          !!source.path &&
          page.source.path === source.path &&
          page.source.contentHash === source.contentHash &&
          page.source.historyPath === source.historyPath &&
          page.source.kind === source.kind
      : !("source" in page);
  }

  private cachedHeartbeatMatches(page: TaskPanelHeartbeatHistory): boolean {
    const heartbeat = this.displayHeartbeat();
    return (
      !!heartbeat?.sourcePath &&
      page.sourcePath === heartbeat.sourcePath &&
      page.contentHash === heartbeat.contentHash
    );
  }

  private adoptCachedPages(): void {
    if (!this.threadId || !this.data.presentation?.cached) return;
    const historyContext = this.currentHistoryContext();
    if (
      this.data.history &&
      this.historyContext !== historyContext &&
      this.cachedHistoryMatches(this.data.history)
    ) {
      this.history = structuredClone(this.data.history);
      this.historyContext = historyContext;
      this.historyThread = null;
    }
    const heartbeatContext = this.currentHeartbeatHistoryContext();
    if (
      heartbeatContext &&
      this.data.heartbeatHistory &&
      this.heartbeatHistoryContext !== heartbeatContext &&
      this.cachedHeartbeatMatches(this.data.heartbeatHistory)
    ) {
      this.heartbeatHistory = structuredClone(this.data.heartbeatHistory);
      this.heartbeatHistoryContext = heartbeatContext;
      this.heartbeatHistoryObservedContext = heartbeatContext;
      this.heartbeatHistoryAttemptedContext = null;
    }
  }

  captureViewState(): TaskPanelViewState | null {
    if (!this.threadId) return null;
    return structuredClone({
      threadId: this.threadId,
      tab: this.tab,
      selectedObjective: this.selectedObjective,
      taskMode: this.taskMode,
      taskContext: this.currentTaskContext(),
      history: this.history,
      historyContext: this.historyContext,
      heartbeatHistory: this.heartbeatHistory,
      heartbeatHistoryContext:
        this.heartbeatHistoryContext ?? this.currentHeartbeatHistoryContext(),
      wakeExpansion: [...this.heartbeatWakeExpansion.entries()],
    });
  }

  restoreViewState(snapshot: TaskPanelViewState): void {
    if (!this.threadId || snapshot.threadId !== this.threadId) return;
    const taskMatches = snapshot.taskContext === this.currentTaskContext();
    this.tab = snapshot.tab;
    this.taskMode = taskMatches ? (snapshot.taskMode ?? "registered-tasks") : "subagents";
    this.selectedObjective =
      taskMatches &&
      this.data.task?.objectives.some((item) => item.id === snapshot.selectedObjective)
        ? snapshot.selectedObjective
        : null;
    if (
      taskMatches &&
      snapshot.history &&
      snapshot.historyContext === this.currentHistoryContext() &&
      this.cachedHistoryMatches(snapshot.history)
    ) {
      this.history = structuredClone(snapshot.history);
      this.historyContext = snapshot.historyContext;
      this.historyThread = null;
    }
    const heartbeatContext = this.currentHeartbeatHistoryContext();
    if (
      taskMatches &&
      heartbeatContext &&
      snapshot.heartbeatHistoryContext === heartbeatContext &&
      (!snapshot.heartbeatHistory || this.cachedHeartbeatMatches(snapshot.heartbeatHistory))
    ) {
      this.heartbeatHistory = structuredClone(snapshot.heartbeatHistory);
      this.heartbeatHistoryContext = heartbeatContext;
      this.heartbeatHistoryObservedContext = heartbeatContext;
      this.heartbeatHistoryAttemptedContext = null;
      this.heartbeatWakeExpansion = new Map(snapshot.wakeExpansion);
    }
    this.requestUpdate();
  }

  resetThread(threadId: string | null): void {
    this.refreshViewGeneration++;
    this.refreshViewBusy = false;
    this.clearArchive();
    this.archiveContext = null;
    this.threadId = threadId;
    this.data = { task: null, heartbeat: null };
    this.observed = false;
    this.history = null;
    this.heartbeatHistory = null;
    this.heartbeatBusy = false;
    this.heartbeatHistoryContext = null;
    this.heartbeatHistoryAttemptedContext = null;
    this.heartbeatHistoryObservedContext = undefined;
    this.heartbeatHistoryError = null;
    this.heartbeatHistoryErrorContext = null;
    this.heartbeatHistoryRetryContext = null;
    this.historyRetryContext = null;
    this.historyAutoRetries = 0;
    this.heartbeatAutoRetries = 0;
    this.heartbeatWakeExpansion.clear();
    this.heartbeatRequest++;
    this.historyThread = null;
    this.historyContext = null;
    this.historyRequest++;
    this.selectedObjective = null;
    this.taskMode = "subagents";
    this.connectionError = null;
    this.busy = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Native MCP Apps are always shown as the standalone panel.
    this.expanded = true;
    this.ownerDocument.addEventListener("keydown", this.escapeKey);
    this.sizeObserver = new ResizeObserver(() => {
      this.drawEdge();
    });
    this.sizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.ownerDocument.removeEventListener("keydown", this.escapeKey);
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues): void {
    this.drawEdge();
    this.loadHeartbeatHistoryOnOpen();
    if (!changed.has("data") || !this.expanded) return;
    if (
      this.tab === "history" &&
      !this.busy &&
      this.historyRetryContext === this.currentHistoryContext() &&
      this.historyAutoRetries < 2
    ) {
      this.historyAutoRetries++;
      void this.loadHistory();
    }
    if (
      this.tab === "heartbeat" &&
      !this.heartbeatBusy &&
      this.heartbeatHistoryRetryContext &&
      this.heartbeatHistoryRetryContext === this.currentHeartbeatHistoryContext() &&
      this.heartbeatAutoRetries < 2
    ) {
      this.heartbeatAutoRetries++;
      void this.loadHeartbeatHistory();
    }
  }

  private loadHeartbeatHistoryOnOpen(): void {
    if (!this.expanded || this.tab !== "heartbeat") return;
    const context = this.currentHeartbeatHistoryContext();
    if (this.heartbeatHistoryObservedContext !== context) {
      this.heartbeatHistoryObservedContext = context;
      this.heartbeatHistoryAttemptedContext = null;
      this.heartbeatHistoryContext = null;
      this.heartbeatHistory = null;
      this.heartbeatWakeExpansion.clear();
      this.heartbeatHistoryError = null;
      this.heartbeatHistoryErrorContext = null;
      this.heartbeatHistoryRetryContext = null;
      this.heartbeatAutoRetries = 0;
      this.heartbeatRequest++;
      this.heartbeatBusy = false;
    }
    if (
      !context ||
      !this.threadId ||
      !this.requester ||
      this.heartbeatBusy ||
      this.heartbeatHistoryAttemptedContext === context
    )
      return;
    this.heartbeatHistoryAttemptedContext = context;
    void this.loadHeartbeatHistory(false, context);
  }

  private currentHeartbeatHistoryContext(): string | null {
    const heartbeat = this.displayHeartbeat();
    if (!this.threadId || !heartbeat?.sourcePath) return null;
    return JSON.stringify([
      this.threadId,
      heartbeat.sourcePath,
      heartbeat.historyPath ?? null,
      heartbeat.contentHash ?? null,
      this.data.task?.lifecycle ?? null,
    ]);
  }

  private displayHeartbeat(): TaskPanelHeartbeat | null {
    return this.data.heartbeat;
  }

  private async openPanel(view: "tasks" | "history" | "heartbeat"): Promise<void> {
    if (this.tab !== view) {
      this.refreshViewGeneration++;
      this.refreshViewBusy = false;
    }
    this.tab = view;
    this.expanded = true;
    if (view === "history") void this.loadHistory();
    if (view === "heartbeat") this.loadHeartbeatHistoryOnOpen();
    await this.updateComplete;
    if (this.expanded && this.tab === view)
      this.renderRoot.querySelector<HTMLElement>(".panel-title")?.focus({ preventScroll: true });
  }

  private async refreshCurrentView(): Promise<void> {
    const refreshTask = this.refreshTask;
    const threadId = this.threadId;
    const view = this.tab;
    const generation = this.refreshViewGeneration;
    if (
      !refreshTask ||
      !threadId ||
      this.refreshing ||
      this.refreshViewBusy ||
      this.busy ||
      this.heartbeatBusy
    )
      return;
    this.refreshViewBusy = true;
    try {
      await refreshTask();
      if (
        this.threadId !== threadId ||
        this.tab !== view ||
        this.refreshViewGeneration !== generation ||
        this.refreshTask !== refreshTask
      )
        return;
      if (view === "history") await this.loadHistory();
      else if (view === "heartbeat") await this.loadHeartbeatHistory();
    } catch {
      // The native refresh bridge owns refresh failures and its visible diagnostics.
    } finally {
      if (
        this.refreshViewGeneration === generation &&
        this.threadId === threadId &&
        this.tab === view &&
        this.refreshTask === refreshTask
      )
        this.refreshViewBusy = false;
    }
  }

  private readonly escapeKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const active = this.shadowRoot?.activeElement;
    if (this.tab === "tasks" && this.selectedObjective && active?.closest(".modules")) {
      event.preventDefault();
      const row = [...this.renderRoot.querySelectorAll<HTMLButtonElement>(".row")].find(
        (element) => element.dataset.objective === this.selectedObjective,
      );
      this.selectedObjective = null;
      row?.focus({ preventScroll: true });
    }
  };

  private toggleExpanded(): void {
    void this.openPanel("tasks");
  }

  private drawEdge(): void {
    const main = this.renderRoot.querySelector<HTMLElement>(".main");
    const svg = this.renderRoot.querySelector<SVGSVGElement>(".edge-progress");
    if (!main || !svg) return;
    const width = main.getBoundingClientRect().width;
    svg.setAttribute("viewBox", `0 0 ${width} 44`);
    const path = `M 1.5 22 A 20.5 20.5 0 0 0 22 42.5 H ${Math.max(22, width - 22)} A 20.5 20.5 0 0 0 ${width - 1.5} 22`;
    for (const element of svg.querySelectorAll("path")) element.setAttribute("d", path);
  }

  private icon(name: string, className = "") {
    const paths: Record<string, string> = {
      layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
      history: "M3.5 10a8.5 8.5 0 1 1 1.8 7.4M3 4v6h6M12 7v5l3 2",
      heartbeat: "M3 12h4l3-7 4 14 3-7h4",
      chevron: "m8 5 7 7-7 7",
      down: "m6 9 6 6 6-6",
      check: "m5 12 4.5 4.5L19 7",
      close: "m6 6 12 12M6 18 18 6",
      shield: "m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6",
    };
    return html`<svg class=${className} viewBox="0 0 24 24" aria-hidden="true"><path d=${paths[name] ?? paths.layers}></path></svg>`;
  }

  private lucideIcon(icon: LucideIconData, className = "") {
    const renderNode = ([tag, attributes, children = []]: LucideIconNode): string => {
      const attrs = Object.entries(attributes)
        .filter(([name]) => name !== "key")
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ");
      return `<${tag} ${attrs}>${children.map(renderNode).join("")}</${tag}>`;
    };
    return unsafeSVG(
      `<svg class="lucide lucide-${icon.name} ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon.node.map(renderNode).join("")}</svg>`,
    );
  }

  private async loadHistory(more = false): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || !this.requester || this.busy) return;
    const context = this.currentHistoryContext();
    if (context !== this.historyContext) {
      this.history = null;
      this.historyContext = context;
    }
    const requestId = ++this.historyRequest;
    const expectedSource = this.historySource();
    if (expectedSource && !expectedSource.path) {
      this.history = {
        events: [],
        wakes: [],
        total: 0,
        nextCursor: null,
        source: {
          ...expectedSource,
          error: expectedSource.error ?? "The bound ledger path is unresolved.",
        },
      };
      this.historyThread = threadId;
      this.busy = false;
      return;
    }
    this.busy = true;
    try {
      const current = this.history as (TaskPanelHistory & Partial<TaskPanelSourceHistory>) | null;
      const cursor = more ? current?.nextCursor : null;
      const result = await this.requester({
        method: "history",
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      if (
        this.threadId !== threadId ||
        this.currentHistoryContext() !== context ||
        requestId !== this.historyRequest
      )
        return;
      const page = result.history as
        | (TaskPanelHistory & Partial<TaskPanelSourceHistory>)
        | undefined;
      const sourceMode = expectedSource !== null;
      if (
        page?.source?.retryable &&
        (page.source.path === null || page.source.path === expectedSource?.path) &&
        (page.source.contentHash === undefined ||
          page.source.contentHash === expectedSource?.contentHash)
      ) {
        this.historyRetryContext = context;
        this.historyThread = threadId;
        return;
      }
      this.historyRetryContext = null;
      this.historyAutoRetries = 0;
      const mismatch = expectedSource
        ? !(
            page?.source &&
            page.source.kind === "kit-heartbeat" &&
            page.source.path === expectedSource.path &&
            page.source.contentHash === expectedSource.contentHash
          )
        : Boolean(page?.source);
      if (mismatch) {
        if (
          this.data.presentation?.cached &&
          this.history &&
          this.cachedHistoryMatches(this.history)
        ) {
          this.historyThread = threadId;
          return;
        }
        this.history = expectedSource
          ? {
              events: [],
              wakes: [],
              total: 0,
              nextCursor: null,
              source: {
                ...expectedSource,
                error: "Ledger history response did not match the bound source. Refresh to retry.",
              },
            }
          : { events: [], nextCursor: null };
        this.historyThread = threadId;
        return;
      }
      this.history = page
        ? sourceMode
          ? {
              ...page,
              events: [],
              wakes: more ? [...(current?.wakes ?? []), ...(page.wakes ?? [])] : (page.wakes ?? []),
            }
          : {
              events: more ? [...(current?.events ?? []), ...page.events] : page.events,
              nextCursor: page.nextCursor,
            }
        : expectedSource
          ? {
              events: [],
              wakes: [],
              total: 0,
              nextCursor: null,
              source: {
                ...expectedSource,
                error: expectedSource.error ?? "The bound ledger history is unavailable.",
              },
            }
          : { events: [], nextCursor: null };
      this.historyThread = threadId;
    } catch (error) {
      if (
        requestId === this.historyRequest &&
        this.threadId === threadId &&
        this.currentHistoryContext() === context
      ) {
        this.historyRetryContext = null;
        this.historyAutoRetries = 0;
        if (
          this.data.presentation?.cached &&
          this.history &&
          this.cachedHistoryMatches(this.history)
        ) {
          this.historyThread = threadId;
          return;
        }
        if (expectedSource) {
          this.history = {
            events: [],
            wakes: [],
            total: 0,
            nextCursor: null,
            source: { ...expectedSource, error: String(error) },
          };
          this.historyThread = threadId;
        } else {
          this.history = { events: [], nextCursor: null, error: String(error) };
          this.historyThread = threadId;
        }
      }
    } finally {
      if (requestId === this.historyRequest) this.busy = false;
    }
  }

  private currentHistoryContext(): string {
    const source = this.historySource();
    const authority = source
      ? [
          this.data.taskSource?.status ?? null,
          this.data.taskSource?.error ?? null,
          source.error ?? null,
        ]
      : null;
    return JSON.stringify([
      this.threadId,
      source?.kind ?? "local",
      source?.path ?? null,
      source?.historyPath ?? null,
      source?.contentHash ?? null,
      authority,
      this.data.task?.lifecycle ?? null,
    ]);
  }

  private historySource(): TaskPanelSourceHistory["source"] | null {
    const taskSource = this.data.task?.source;
    if (taskSource?.kind === "kit-heartbeat") {
      const responseSource = this.data.taskSource;
      const contentHash =
        taskSource.contentHash ??
        (responseSource?.path === taskSource.path ? responseSource.contentHash : undefined);
      const itemStatuses = taskSource.itemStatuses ?? responseSource?.itemStatuses;
      return {
        kind: "kit-heartbeat",
        path: taskSource.path,
        ...(taskSource.historyPath ? { historyPath: taskSource.historyPath } : {}),
        readOnly: true,
        ...(contentHash !== undefined ? { contentHash } : {}),
        ...(taskSource.error ? { error: taskSource.error } : {}),
        ...(itemStatuses ? { itemStatuses } : {}),
      };
    }
    const source = this.data.taskSource;
    if (!source) return null;
    if (
      source.path ||
      source.error ||
      source.status === "stale" ||
      source.status === "error" ||
      source.status === "pending-selection"
    ) {
      return {
        kind: "kit-heartbeat",
        path: source.path ?? null,
        ...(source.historyPath ? { historyPath: source.historyPath } : {}),
        readOnly: true,
        ...(source.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
        ...(source.error ? { error: source.error } : {}),
        ...(source.itemStatuses ? { itemStatuses: source.itemStatuses } : {}),
      };
    }
    return null;
  }

  private async loadHeartbeatHistory(more = false, expectedContext?: string): Promise<void> {
    const threadId = this.threadId;
    const heartbeat = this.displayHeartbeat();
    const sourcePath = heartbeat?.sourcePath;
    const context = expectedContext ?? this.currentHeartbeatHistoryContext();
    if (
      !threadId ||
      !sourcePath ||
      !this.requester ||
      this.heartbeatBusy ||
      !context ||
      context !== this.currentHeartbeatHistoryContext()
    )
      return;
    const requestId = ++this.heartbeatRequest;
    this.heartbeatBusy = true;
    try {
      const cursor =
        more && this.heartbeatHistoryContext === context ? this.heartbeatHistory?.nextCursor : null;
      const result = await this.requester({
        method: "heartbeat-history",
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      if (
        requestId !== this.heartbeatRequest ||
        this.threadId !== threadId ||
        this.currentHeartbeatHistoryContext() !== context
      )
        return;
      const page = result.heartbeatHistory;
      if (
        page?.retryable &&
        (!page.sourcePath || page.sourcePath === sourcePath) &&
        (!page.contentHash || page.contentHash === this.displayHeartbeat()?.contentHash)
      ) {
        this.heartbeatHistoryRetryContext = context;
        this.heartbeatHistoryError = null;
        this.heartbeatHistoryErrorContext = null;
        return;
      }
      this.heartbeatHistoryRetryContext = null;
      this.heartbeatAutoRetries = 0;
      const currentHash = this.displayHeartbeat()?.contentHash;
      const hashMismatch = Boolean(
        page?.contentHash && currentHash && page.contentHash !== currentHash,
      );
      if (page?.error && hashMismatch) {
        this.heartbeatHistoryError = page.error;
        this.heartbeatHistoryErrorContext = context;
      }
      if (page && (!page.sourcePath || page.sourcePath === sourcePath) && !hashMismatch) {
        this.heartbeatHistory = {
          ...page,
          wakes:
            more && this.heartbeatHistoryContext === context
              ? [...(this.heartbeatHistory?.wakes ?? []), ...page.wakes]
              : page.wakes,
        };
        this.heartbeatHistoryContext = context;
        this.heartbeatHistoryError = null;
        this.heartbeatHistoryErrorContext = null;
      }
    } catch (error) {
      if (
        requestId === this.heartbeatRequest &&
        this.threadId === threadId &&
        this.currentHeartbeatHistoryContext() === context
      ) {
        this.heartbeatHistoryRetryContext = null;
        this.heartbeatAutoRetries = 0;
        this.connectionError = String(error);
      }
    } finally {
      if (
        requestId === this.heartbeatRequest &&
        this.threadId === threadId &&
        this.currentHeartbeatHistoryContext() === context
      )
        this.heartbeatBusy = false;
    }
  }

  private renderOrchestration(value: unknown, error: unknown) {
    if (typeof error === "string" && error.trim())
      return html`<p class="muted" role="status">${this.t("Invalid orchestration snapshot; metrics not recorded", "编排快照无效，指标未记录")}</p>`;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return html`<p class="muted">${this.t("Legacy record: orchestration snapshot not recorded", "旧记录未记录编排快照")}</p>`;
    const snapshot = value as HeartbeatOrchestrationProjection;
    const unknown = this.t("Not recorded", "未记录");
    const number = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? String(v) : unknown;
    const flag = (v: unknown) =>
      v === true ? this.t("Yes", "是") : v === false ? this.t("No", "否") : unknown;
    const agentCount = (v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? number((v as Record<string, unknown>).activeAgents)
        : unknown;
    const tasks = snapshot.blockedTasks ?? [];
    return html`
      <section class="info-card hb-record"><div class="info-card-head"><h3 class="info-card-title">${this.t("Agent flow", "Agent 编排")}</h3></div><div class="info-card-body hb-snapshot">
        <p class="muted">${this.t("Audit / task scope", "巡检 / 任务范围")}: ${typeof snapshot.scope === "string" && snapshot.scope ? snapshot.scope : unknown}</p>
        <p>${this.t("Active child agents", "活跃子 Agent")} <strong>${agentCount(snapshot.before)} → ${agentCount(snapshot.after)}</strong></p>
        <p class="muted">${this.t("Before audit / re-split → after dispatch", "巡检 / 重新拆分前 → 派发后")}</p>
      </div></section>
      <section class="info-card hb-record"><div class="info-card-head"><h3 class="info-card-title">${this.t("Blocked tasks and Owner actions", "阻塞任务与 Owner 操作")}</h3></div><div class="info-card-body hb-snapshot">
        <p>${this.t("Blocked tasks", "阻塞任务数")} <strong>${number(snapshot.blockedTaskCount)}</strong></p>
        <p>${this.t("Confirmed Owner actions", "已确认需你处理")} <strong>${number(snapshot.ownerInterventionCount)}</strong></p>
        <p>${this.t("Owner intervention required", "是否需要 Owner 介入")} <strong>${flag(snapshot.requiresOwner)}</strong></p>
        ${tasks.map((task) => html`<article class="hb-blocked-task"><strong>${String(task.title ?? task.id ?? unknown)}</strong><p>${this.t("Reason", "原因")}: ${typeof task.reason === "string" && task.reason ? task.reason : unknown}</p><p>${this.t("Requires Owner", "需要 Owner")}: ${flag(task.requiresOwner)}</p></article>`)}
        ${snapshot.truncated === true ? html`<p class="muted">${this.t("Showing", "当前显示")} ${tasks.length} / ${number(snapshot.blockedTaskCount)} ${this.t("blocked tasks", "项阻塞任务")}</p>` : nothing}
      </div></section>`;
  }

  private taskSourceIsPending(): boolean {
    const source = this.data.taskSource;
    if (this.data.presentation?.cached && (this.data.task || source?.path)) return false;
    if (source?.status === "error" && !source.retryable) return false;
    return this.data.taskSourcePending === true || source?.status === "pending";
  }

  private renderHeartbeatHistory(heartbeat: TaskPanelHeartbeat) {
    const history =
      this.heartbeatHistoryContext === this.currentHeartbeatHistoryContext()
        ? this.heartbeatHistory
        : null;
    const historyError =
      this.heartbeatHistoryErrorContext === this.currentHeartbeatHistoryContext()
        ? this.heartbeatHistoryError
        : history?.error;
    const wakes = history?.wakes ?? [...heartbeat.wakes].reverse();
    const count = history?.total ?? heartbeat.wakeCount ?? heartbeat.wakes.length;
    const body = html`
      ${
        !heartbeat.sourcePath
          ? html`<p class="empty">${this.t("Heartbeat history is unavailable without a current source.", "没有当前心跳来源，无法读取巡检历史。")}</p>`
          : nothing
      }
      ${wakes.map((wake, index) => {
        const key = `${String(wake.line ?? "")}:${String(wake.timeMs ?? "")}:${String(wake.heading ?? "")}:${index}`;
        const heading =
          wake.timeMs !== null && wake.timeMs !== undefined
            ? this.wakeHeading(wake.timeMs)
            : String(wake.heading ?? this.t("Untimed record", "时间未知的记录"));
        return html`<details class="event hb-wake" ?open=${this.heartbeatWakeExpansion.get(key) ?? index === 0} @toggle=${(
          event: Event,
        ) => {
          if (event.target === event.currentTarget)
            this.heartbeatWakeExpansion.set(key, (event.currentTarget as HTMLDetailsElement).open);
        }}>
          <summary><span class="hb-wake-time">${heading}</span>${this.lucideIcon(ChevronRight, "hb-wake-chevron")}</summary>
          <div class="hb-wake-body">
            ${this.renderOrchestration(wake.orchestration, wake.orchestrationError)}
          </div>
        </details>`;
      })}
      ${historyError ? html`<div class="info-card-error"><strong>${this.t("Heartbeat history error", "心跳历史错误")}</strong><pre class="diagnostic-text">${historyError}</pre></div>` : nothing}
      ${history?.nextCursor ? html`<button class="hb-older" ?disabled=${this.heartbeatBusy} @click=${() => void this.loadHeartbeatHistory(true)}>${this.t("Load older heartbeats", "加载更早心跳")}</button>` : nothing}
      ${!history && heartbeat.wakesTruncated ? html`<p class="muted">${this.t("Recent records shown; load history to browse older audits.", "当前仅展示近期记录，可分页查看更早巡检。")}</p>` : nothing}
      ${!wakes.length && !historyError && this.heartbeatHistoryRetryContext !== this.currentHeartbeatHistoryContext() && heartbeat.sourcePath && !this.heartbeatBusy ? html`<p class="empty">${this.t("No heartbeat records are available.", "暂无可用的巡检记录。")}</p>` : nothing}
    `;
    return this.framedCard(this.t("Heartbeat history", "巡检记录"), List, body, {
      count,
      className: "hb-history",
    });
  }

  private evidence(items: readonly TaskPanelEvidence[]) {
    return items.map(
      (item) =>
        html`<div class="evidence"><strong>${item.verification === "verified" ? this.t("Verified", "实际验证") : this.t("Reported", "模型报告")}</strong> · ${item.summary}</div>`,
    );
  }

  private objectiveDisplay(objective: TaskPanelObjective) {
    const effective =
      objective.status === "cancelled"
        ? []
        : objective.items.length
          ? objective.items.filter((item) => item.status !== "cancelled")
          : [objective];
    const done = effective.filter((item) => item.status === "completed").length;
    const percent = effective.length ? Math.round((done / effective.length) * 100) : 0;
    const displayedStatus =
      objective.status === "cancelled" || !effective.length
        ? objective.status
        : done === effective.length
          ? "completed"
          : effective.some((item) => item.status === "active")
            ? "active"
            : effective.some((item) => item.status === "blocked")
              ? "blocked"
              : done > 0
                ? "active"
                : "pending";
    return { effective, done, percent, status: displayedStatus };
  }

  private objectiveDomId(id: string): string {
    const key = Array.from(id, (character) => character.codePointAt(0)?.toString(16) ?? "").join(
      "-",
    );
    return `objective-${key || "empty"}`;
  }

  private objective(
    objective: TaskPanelObjective,
    index: number,
    display = this.objectiveDisplay(objective),
  ) {
    const { effective, done, percent, status: displayedStatus } = display;
    const rowId = this.objectiveDomId(objective.id);
    const detailId = `${rowId}-details`;
    const selected = this.selectedObjective === objective.id;
    return html`<button class="row" id=${rowId} data-objective=${objective.id} aria-expanded=${selected} aria-controls=${detailId} @click=${async () => {
      this.selectedObjective = selected ? null : objective.id;
      await this.updateComplete;
      const row = [
        ...this.renderRoot.querySelectorAll<HTMLButtonElement>(".row[data-objective]"),
      ].find((element) => element.dataset.objective === objective.id);
      const scroll = this.renderRoot.querySelector<HTMLElement>(".scroll");
      if (row && scroll) {
        const box = row.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        if (box.top < viewport.top || box.bottom > viewport.bottom)
          scroll.scrollTop += box.top - viewport.top;
      }
    }}>
      <span class="module-icon" data-status=${displayedStatus}>${displayedStatus === "completed" ? this.icon("check") : String(index + 1).padStart(2, "0")}</span>
      <span class="module-content"><span class="module-title-line"><span class="name">${objective.title}${!objective.required ? html` <span class="muted">${this.t("optional", "可选")}</span>` : nothing}</span><span class="module-percent">${percent}%</span></span>
      <span class="module-track" role="meter" aria-label=${objective.title} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent} aria-valuetext=${`${done}/${effective.length}`}><span class="module-fill" style=${`transform:scaleX(${percent / 100})`}></span></span>
      <span class="module-meta"><span>${done}/${effective.length}</span><span>${this.t("nodes completed", "节点完成")}</span><span class="status">${this.status(displayedStatus)}</span></span></span>${this.icon("chevron", "module-arrow")}
    </button>${
      selected
        ? html`<div class="detail" id=${detailId} role="group" aria-labelledby=${rowId}>
      <h3 class="objective-detail-title">${objective.title}</h3>${this.evidence(objective.evidence)}${objective.items.map((item) => html`<article class="check"><span class="node-symbol" data-status=${item.status} aria-hidden="true">${item.status === "completed" ? this.icon("check") : item.status === "blocked" ? "!" : item.status === "active" ? "·" : item.status === "cancelled" ? "−" : ""}</span><div class="node-head"><span class="node-title">${item.title}</span><span class="node-status" data-status=${item.status}>${this.status(item.status)}</span></div>${this.evidence(item.evidence)}${!item.evidence.length ? html`<p class="evidence">${this.t("No explanation or verification recorded yet.", "尚无说明或验证记录。")}</p>` : nothing}</article>`)}
    </div>`
        : nothing
    }`;
  }

  private renderHeartbeat() {
    const heartbeat = this.displayHeartbeat();
    if (!heartbeat) {
      const pending = this.data.heartbeatPending === true;
      const statusText = pending
        ? this.t("Reading project heartbeat…", "正在读取项目心跳…")
        : this.t(
            "No current project heartbeat source is available.",
            "当前项目没有可显示的心跳来源。",
          );
      const unavailableBody = html`<p class="empty">${pending ? this.t("Waiting for the heartbeat source before loading history.", "等待心跳来源后再读取历史。") : this.t("Heartbeat history is unavailable without a current source.", "没有当前心跳来源，无法读取巡检历史。")}</p>`;
      return html`<div class="heartbeat hb-panel"><p class="empty" role="status" aria-live="polite">${statusText}</p>${this.framedCard(this.t("Heartbeat history", "巡检记录"), List, unavailableBody, { count: 0, className: "hb-history" })}</div>`;
    }
    const sourcePath = heartbeat.sourcePath;
    const incompleteDiscoveryOnly = this.isIncompleteDiscoveryOnly(heartbeat);
    const hasAlert = Boolean(
      (heartbeat.warning && !incompleteDiscoveryOnly) || heartbeat.findings.length,
    );
    return html`<div class="heartbeat hb-panel">
      ${
        sourcePath
          ? html`<section class="hb-time-card" aria-label=${this.t("Heartbeat times", "心跳时间")}>
        <div class="hb-times">
          <div class="hb-time hb-time-latest">
            <div class="hb-time-label">${this.lucideIcon(Clock)}<span>${this.t("Latest record", "最近记录")}</span></div>
            <strong>${this.time(heartbeat.lastWakeAt)}</strong>
            <div class="hb-time-date">${heartbeat.lastWakeAt ? this.dateOnly(heartbeat.lastWakeAt) : this.t("No heartbeat time recorded", "尚无心跳时间记录")}</div>
          </div>
          <div class="hb-time hb-time-next" data-missing=${String(!heartbeat.nextWakeAt)}>
            <div class="hb-time-label">${this.lucideIcon(CalendarDays)}<span>${this.t("Next audit", "下次巡检")}</span></div>
            <strong>${heartbeat.nextWakeAt ? this.time(heartbeat.nextWakeAt) : this.t("Not recorded", "未记录")}</strong>
            ${
              heartbeat.nextWakeAt
                ? html`<div class="hb-time-date">${this.dateOnly(heartbeat.nextWakeAt)}</div>`
                : html`<div class="hb-time-caption">${this.t("Awaiting next audit time", "等待记录下次巡检时间")}</div>`
            }
          </div>
        </div>
      </section>`
          : html`<p class="empty" role="status">${heartbeat.status === "pending" || heartbeat.retryable || this.data.heartbeatPending ? this.t("Reading project heartbeat…", "正在读取项目心跳…") : this.t("No current project heartbeat source is available.", "当前项目没有可显示的心跳来源。")}</p>`
      }
      ${
        hasAlert
          ? this.framedCard(
              this.t("Validation notice", "校验提示"),
              AlertTriangle,
              html`<p>${heartbeat.findings.length ? (heartbeat.findingsTruncated ? this.t(`At least ${heartbeat.findings.length} validation issues need attention.`, `发现至少 ${heartbeat.findings.length} 项校验问题，需要关注。`) : this.t(`${heartbeat.findings.length} validation issues need attention.`, `发现 ${heartbeat.findings.length} 项校验问题，需要关注。`)) : this.t("The heartbeat record has a validation notice that needs attention.", "心跳记录存在校验提示，需要关注。")}</p>`,
              { tone: "warning", className: "hb-alert" },
            )
          : nothing
      }
      ${heartbeat.error && !heartbeat.retryable && heartbeat.status !== "pending" ? this.diagnostic(this.t("Project heartbeat error", "项目心跳错误"), heartbeat.error) : nothing}

      ${this.renderHeartbeatHistory(heartbeat)}

    </div>`;
  }

  private isIncompleteDiscoveryOnly(heartbeat: TaskPanelHeartbeat): boolean {
    if (heartbeat.discoveryComplete !== false || !heartbeat.warning) return false;
    const reasonText = heartbeat.discoveryReasons?.join(", ") || "scan limit";
    return (
      heartbeat.warning ===
      `Project heartbeat discovery was incomplete (${reasonText}); the displayed record is the best available result.`
    );
  }

  private renderHistory() {
    const context = this.currentHistoryContext();
    if (this.historyContext !== context) {
      this.historyContext = context;
      this.history = null;
      this.historyRetryContext = null;
      this.historyAutoRetries = 0;
      this.historyThread = null;
      this.historyRequest++;
      this.busy = false;
    }
    const source = this.historySource();
    if (this.taskSourceIsPending() && !source?.path) {
      return this.framedCard(
        this.t("Ledger records", "台账记录"),
        List,
        html`<p class="muted" role="status">${this.t("Refreshing task source…", "正在刷新任务来源…")}</p>`,
      );
    }
    if (source) {
      const sourceHistory = this.history && "source" in this.history ? this.history : null;
      if (!this.busy && this.historyThread !== this.threadId) void this.loadHistory();
      const wakes = sourceHistory?.wakes ?? [];
      const retrying =
        this.historyRetryContext === context && !(this.data.presentation?.cached && sourceHistory);
      const sourceError = retrying
        ? null
        : sourceHistory
          ? (sourceHistory.source.error ?? null)
          : (source.error ??
            (!this.taskSourceIsPending() &&
            (this.data.taskSource?.status === "stale" ||
              this.data.taskSource?.status === "error" ||
              this.data.taskSource?.status === "pending-selection")
              ? (this.data.taskSource.error ?? "The bound ledger is unavailable or stale.")
              : null));
      const body = html`${retrying ? html`<p class="muted" role="status">${this.t("Ledger history is refreshing. Refresh to try again.", "台账历史正在刷新，可再次点击刷新重试。")}</p>` : nothing}${
        sourceError
          ? html`<div class="info-card-error"><strong>${this.t("Ledger history unavailable", "台账历史不可用")}</strong><pre class="diagnostic-text">${sourceError}</pre></div>`
          : wakes.length
            ? wakes.map(
                (wake) =>
                  html`<div class="event"><strong>${String(wake.heading ?? this.date(wake.timeMs))}</strong>${this.renderOrchestration(wake.orchestration, wake.orchestrationError)}</div>`,
              )
            : retrying
              ? nothing
              : sourceHistory
                ? html`<p class="empty">${this.t("No recorded wake audits in this ledger.", "此台账暂无已记录的心跳巡检。")}</p>`
                : html`<p class="empty">${this.busy ? this.t("Loading ledger history…", "正在加载台账历史…") : this.t("Waiting for ledger history…", "等待台账历史…")}</p>`
      }${sourceHistory?.nextCursor ? html`<button class="info-card-more" ?disabled=${this.busy} @click=${() => void this.loadHistory(true)}>${this.t("Load older records", "加载更早记录")}</button>` : nothing}`;
      return this.framedCard(this.t("Ledger records", "台账记录"), List, body, {
        ...(sourceHistory && !sourceError ? { count: sourceHistory.total } : {}),
      });
    }
    if (this.historyThread !== this.threadId && !this.busy) void this.loadHistory();
    const localHistory = this.history && !("source" in this.history) ? this.history : null;
    const localBody = html`${this.historyRetryContext === context && !(this.data.presentation?.cached && localHistory) ? html`<p class="muted" role="status">${this.t("History is refreshing. Refresh to try again.", "历史记录正在刷新，可再次点击刷新重试。")}</p>` : nothing}${(localHistory?.events ?? []).map((event) => this.historyEvent(event))}${localHistory?.error && this.historyRetryContext !== context ? html`<div class="info-card-error"><strong>${this.t("History unavailable", "历史记录不可用")}</strong><pre class="diagnostic-text">${localHistory.error}</pre></div>` : !localHistory?.events.length && this.historyRetryContext !== context ? html`<p class="empty">${this.busy ? this.t("Loading…", "加载中…") : this.t("No recorded changes yet.", "暂无变更记录。")}</p>` : nothing}${localHistory?.nextCursor ? html`<button class="info-card-more" ?disabled=${this.busy} @click=${() => void this.loadHistory(true)}>${this.t("Load more", "加载更多")}</button>` : nothing}`;
    return this.framedCard(this.t("History", "历史记录"), List, localBody, {
      ...(localHistory && !localHistory.error ? { count: localHistory.events.length } : {}),
    });
  }

  private historyEvent(event: Record<string, unknown>) {
    return html`<div class="event"><span class="muted">${this.date(event.occurredAt ?? event.at)}</span><p>${String(event.reason ?? event.type ?? "")}</p>${event.reasonTruncated === true ? html`<p class="muted history-source-note">${this.t("Summary shortened", "记录摘要已缩略")}</p>` : nothing}${event.before && event.after ? html`<span class="muted">${this.progressText(event.before)} → ${this.progressText(event.after)}</span>` : nothing}</div>`;
  }

  private progressText(value: unknown): string {
    if (!value || typeof value !== "object") return "—";
    const progress = value as Record<string, unknown>;
    return `${String(progress.completed ?? 0)}/${String(progress.total ?? 0)}${typeof progress.percent === "number" ? ` (${progress.percent}%)` : ""}`;
  }

  private executionLabel(checklistComplete: boolean): string {
    switch (this.data.execution?.state) {
      case "working":
        return checklistComplete
          ? this.t("Currently still working", "当前仍在执行")
          : this.t("Working", "正在执行");
      case "waiting":
        return checklistComplete
          ? this.t("Waiting for input", "等待输入")
          : this.t("Waiting for input", "等待输入");
      case "idle":
        return this.t("Currently idle", "当前空闲");
      default:
        return this.t("Execution state unknown", "执行状态未知");
    }
  }

  private checklistLabel(): string {
    if (!this.observed)
      return this.connectionError
        ? this.t("Checklist unavailable", "清单暂不可用")
        : this.t("Reading checklist…", "正在读取清单…");
    if (this.connectionError) return this.t("Checklist unavailable", "清单暂不可用");
    if (this.taskSourceIsPending()) return this.t("Refreshing task source…", "正在刷新任务来源…");
    const progress = this.data.task?.progress;
    const sourceStatus = this.data.taskSource?.status;
    if (
      sourceStatus === "stale" ||
      sourceStatus === "error" ||
      sourceStatus === "pending-selection"
    ) {
      const label =
        sourceStatus === "stale"
          ? this.t("Heartbeat task source is stale", "心跳任务来源已过期")
          : sourceStatus === "pending-selection"
            ? this.t("Current task source is unresolved", "当前任务来源尚未解析")
            : this.t("Heartbeat task source is unavailable", "心跳任务来源暂不可用");
      return label;
    }
    const counts = `${this.data.completionBasis === "task-lifecycle" ? this.t("Task progress", "任务进度") : this.t("Registered checklist", "已登记清单")} ${progress?.completed ?? 0}/${progress?.total ?? 0}`;
    const source =
      this.data.task?.source?.kind === "kit-heartbeat"
        ? this.t("Read-only Kit heartbeat source", "只读 Kit 心跳来源")
        : "";
    if (!progress || progress.percent === null)
      return `${counts} · ${this.t("No task checklist", "尚未建立任务")}${source ? ` · ${source}` : ""}`;
    return progress.percent < 100
      ? `${counts} · ${this.t("Checklist progress", "清单进度")} ${progress.percent}%${source ? ` · ${source}` : ""}`
      : `${counts}${source ? ` · ${source}` : ""}`;
  }

  private framedCard(
    title: string,
    icon: LucideIconData,
    body: unknown,
    options: {
      count?: number;
      action?: unknown;
      tone?: "neutral" | "warning" | "error";
      className?: string;
    } = {},
  ) {
    const className = options.className ? `info-card ${options.className}` : "info-card";
    const headerClass =
      options.className === "hb-history" ? "info-card-head hb-history-head" : "info-card-head";
    return html`<section class=${className} data-tone=${options.tone ?? "neutral"} aria-label=${title}>
      <header class=${headerClass}><h3 class="info-card-title">${this.lucideIcon(icon)}<span>${title}</span>${options.count !== undefined ? html`<span class="info-card-count hb-count">${options.count}</span>` : nothing}</h3>${options.action ?? nothing}</header>
      <div class="info-card-body">${body}</div>
    </section>`;
  }

  private diagnostic(label: string, content: string) {
    return this.framedCard(
      label,
      AlertTriangle,
      html`<pre class="diagnostic-text">${content}</pre>`,
      { tone: "error" },
    );
  }

  private currentArchiveContext(): string {
    const source = this.data.taskSource;
    return JSON.stringify([
      this.threadId,
      this.data.task?.lifecycle?.id ?? null,
      this.data.task?.source?.path ?? this.data.taskSource?.path ?? null,
      this.data.task?.source?.contentHash ?? this.data.taskSource?.contentHash ?? null,
      source?.status ?? null,
      source?.path ?? null,
      source?.historyPath ?? null,
      source?.contentHash ?? null,
      this.data.taskSourcePending ?? false,
    ]);
  }

  private clearArchive(): void {
    this.archiveGeneration++;
    this.archiveOpen = false;
    this.archiveBusy = false;
    this.archivePage = null;
    this.archiveDetails.clear();
    this.archiveExpanded.clear();
    this.archiveError = null;
    this.archiveRetry = {};
  }

  private async loadArchive(taskId?: string, cursor?: string): Promise<void> {
    if (!this.threadId || !this.requester || this.archiveBusy) return;
    const generation = this.archiveGeneration;
    const context = this.currentArchiveContext();
    this.archiveBusy = true;
    this.archiveRetry = {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    this.archiveError = null;
    try {
      const result = await this.requester({
        method: "archive",
        threadId: this.threadId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 50,
      });
      if (generation !== this.archiveGeneration || context !== this.currentArchiveContext()) return;
      const page = result.archive;
      if (!page || page.available === false) {
        this.archiveError = page?.reason ?? this.t("Archive unavailable.", "归档暂不可用。");
      } else if (page.currentTaskId !== (this.data.task?.lifecycle?.id ?? null)) {
        this.archiveError = this.t(
          "Task changed. Reopen the archive.",
          "任务已变更，请重新打开归档。",
        );
      } else if (page.kind === "tasks" && !taskId) {
        this.archivePage =
          cursor && this.archivePage
            ? { ...page, tasks: [...this.archivePage.tasks, ...page.tasks] }
            : page;
      } else if (page.kind === "subtasks" && taskId === page.task.id) {
        const previous = this.archiveDetails.get(taskId);
        this.archiveDetails.set(
          taskId,
          cursor && previous ? { ...page, nodes: [...previous.nodes, ...page.nodes] } : page,
        );
      } else {
        this.archiveError = this.t(
          "Archive response did not match the request.",
          "归档响应与请求不匹配。",
        );
      }
    } catch (error) {
      if (generation === this.archiveGeneration && context === this.currentArchiveContext())
        this.archiveError =
          error instanceof Error ? error.message : this.t("Archive unavailable.", "归档暂不可用。");
    } finally {
      if (generation === this.archiveGeneration) {
        this.archiveBusy = false;
        this.requestUpdate();
      }
    }
  }

  private toggleArchive(): void {
    this.archiveOpen = !this.archiveOpen;
    if (this.archiveOpen && !this.archivePage) void this.loadArchive();
  }

  private toggleArchiveTask(id: string): void {
    if (this.archiveExpanded.has(id)) this.archiveExpanded.delete(id);
    else {
      this.archiveExpanded.add(id);
      if (!this.archiveDetails.has(id)) void this.loadArchive(id);
    }
    this.requestUpdate();
  }

  private renderCloseout() {
    const lifecycle = this.data.task?.lifecycle;
    if (!lifecycle || this.data.completionBasis !== "task-lifecycle") return nothing;
    const completion = lifecycle.completion;
    const receipt = completion?.receipt;
    return this.framedCard(
      this.t("Task closeout", "任务收尾"),
      FileText,
      html`<p class="archive-note">${
        completion ? this.t("Recorded", "已记录") : this.t("Closeout not recorded", "尚未记录收尾")
      } · ${completion ? "1/1" : "0/1"}</p>
        ${receipt ? html`<p class="archive-note">${this.t("Branch", "分支")}: ${receipt.branch.status} · ${this.t("Merge", "合并")}: ${receipt.merge.status} · ${this.t("Push", "推送")}: ${receipt.push.status}</p><p class="archive-note">${this.t("Remaining work", "剩余工作")}: ${receipt.remainingWork} · ${this.t("Owner actions", "Owner 待办")}: ${receipt.ownerActions} · ${this.date(completion?.completedAt)}</p>` : nothing}`,
      { className: "task-closeout" },
    );
  }

  private renderArchive() {
    if (
      !this.observed ||
      !this.threadId ||
      !this.data.task ||
      !(this.data.archiveCount && this.data.archiveCount > 0)
    )
      return nothing;
    const count =
      this.taskSourceIsPending() || this.data.task?.source || this.data.taskSource
        ? null
        : this.data.archiveCount;
    return html`<section class="info-card archive-card">
      <button class="archive-toggle" aria-expanded=${this.archiveOpen} aria-controls="archive-list" @click=${this.toggleArchive}>
        ${this.lucideIcon(ChevronRight, "archive-chevron")}<span>${this.t("Archive", "归档")}</span><span class="info-card-count">${typeof count === "number" ? count : "—"}</span>
      </button>
      ${
        this.archiveOpen
          ? html`<div class="info-card-body archive-list" id="archive-list">
        ${this.archiveError ? html`<p class="info-card-error" role="status">${this.archiveError}</p>` : nothing}
        ${this.archivePage?.tasks.map((task) => {
          const open = this.archiveExpanded.has(task.id);
          const detail = this.archiveDetails.get(task.id);
          const detailId = `archive-detail-${encodeURIComponent(task.id)}`;
          return html`<div class="archive-cycle"><button class="archive-cycle-toggle" ?disabled=${this.archiveBusy} aria-expanded=${open} aria-controls=${detailId} @click=${() => this.toggleArchiveTask(task.id)}>${this.lucideIcon(ChevronRight, "archive-chevron")}<span>${task.title}</span><span class="archive-date">${this.dateOnly(task.completedAt)}</span></button>
            ${
              open
                ? html`<div class="archive-nodes" id=${detailId}>${detail?.nodes.map((node) => html`<div class="archive-node" data-kind=${node.kind}><span>${node.title}</span><span>${this.status(node.status)}</span></div>`)}
              ${detail?.nextCursor ? html`<button class="info-card-action" ?disabled=${this.archiveBusy} @click=${() => void this.loadArchive(task.id, detail.nextCursor ?? undefined)}>${this.t("Load more", "加载更多")}</button>` : nothing}</div>`
                : nothing
            }</div>`;
        })}
        ${this.archivePage && !this.archivePage.tasks.length ? html`<p class="archive-note">${this.t("No archived tasks.", "暂无归档任务。")}</p>` : nothing}
        ${this.archiveBusy ? html`<p class="archive-note" role="status">${this.t("Loading archive…", "正在加载归档…")}</p>` : nothing}
        ${this.archivePage?.nextCursor ? html`<button class="info-card-action" ?disabled=${this.archiveBusy} @click=${() => void this.loadArchive(undefined, this.archivePage?.nextCursor ?? undefined)}>${this.t("Older tasks", "更早的任务")}</button>` : nothing}
        ${this.archiveError && !this.archiveBusy ? html`<button class="info-card-action" @click=${() => void this.loadArchive(this.archiveRetry.taskId, this.archiveRetry.cursor)}>${this.t("Retry", "重试")}</button>` : nothing}
      </div>`
          : nothing
      }
    </section>`;
  }

  private renderTaskSource() {
    const source = this.data.task?.source;
    const sourceInfo = this.data.taskSource;
    if (!source && !sourceInfo) return nothing;
    const risks = source?.linkRisks ?? [];
    const presentation = source?.presentation;
    const sourceError = this.taskSourceIsPending()
      ? undefined
      : sourceInfo?.status === "stale" ||
          sourceInfo?.status === "error" ||
          sourceInfo?.status === "pending-selection"
        ? (sourceInfo.error ?? this.t("Source could not be read.", "无法读取任务来源。"))
        : source?.error;
    const notice =
      presentation && presentation.displayedItemCount < presentation.sourceItemCount
        ? html`<p class="muted">${this.t("Showing", "当前显示")} ${presentation.displayedItemCount}/${presentation.sourceItemCount} ${this.t("items. Progress counts all items.", "项；进度按全部项目计算。")}</p>`
        : nothing;
    if (!sourceError && !risks.length) return notice;
    const body = html`${sourceError ? html`<div class="info-card-error"><strong>${this.t("Source error", "来源错误")}</strong><pre class="diagnostic-text">${sourceError}</pre></div>` : nothing}
      ${risks.length ? html`<div class="error">${this.t("Unsafe parent links remain separate items", "不安全的父子关联项将分别显示")}</div>` : nothing}`;
    return html`${notice}${this.framedCard(
      this.t("Task needs attention", "任务需要关注"),
      FileText,
      body,
      { tone: sourceError ? "error" : "neutral" },
    )}`;
  }

  private renderSubagents() {
    const snapshot =
      this.data.subagents?.parentThreadId === this.threadId ? this.data.subagents : null;
    const agents = snapshot?.agents ?? [];
    const ranked = [...agents].sort((a, b) => {
      const rank = (state: SubagentProgressEntry["state"]) =>
        state === "working" ? 0 : state === "completed" ? 2 : 1;
      return rank(a.state) - rank(b.state);
    });
    const count =
      snapshot?.runningBasis === "heartbeat" && !snapshot.observedAt
        ? null
        : snapshot?.runningCount;
    const running = typeof count === "number" ? String(count) : "—";
    const listed =
      snapshot && (snapshot.status === "ready" || snapshot.status === "partial")
        ? String(agents.length)
        : "—";
    const updated = snapshot?.observedAt ? this.date(snapshot.observedAt) : "—";
    const basis =
      snapshot?.runningBasis === "heartbeat"
        ? this.t("Heartbeat record", "心跳记录")
        : snapshot?.runningBasis === "runtime"
          ? this.t("Runtime", "运行状态")
          : this.t("Unknown", "未知");
    const labels: Record<SubagentProgressEntry["state"], string> = {
      working: this.t("Working", "正在执行"),
      waiting: this.t("Waiting", "等待中"),
      idle: this.t("Idle", "空闲"),
      completed: this.t("Completed", "已完成"),
      failed: this.t("Failed", "失败"),
      unknown: this.t("Unknown", "未知"),
    };
    return html`<section class="subagents" aria-label=${this.t("Subagents", "子 Agent")}>
      <div class="hb-times agent-counts">
        <div class="hb-time"><div class="hb-time-label">${this.t("Running", "正在执行")}</div><strong>${running}</strong><div class="hb-time-date">${basis} · ${this.t("Updated", "更新于")} ${updated}</div></div>
        <div class="hb-time"><div class="hb-time-label">${this.t("Listed agents", "已列出 Agent")}</div><strong>${listed}</strong></div>
      </div>
      ${
        ranked.length
          ? ranked.map((agent) => {
              const progress = agent.progress;
              const percent = progress?.percent;
              const known = typeof percent === "number" && Number.isFinite(percent);
              const bounded = known ? Math.max(0, Math.min(100, percent)) : null;
              return html`<article class="row agent-row" data-agent=${agent.id}>
          <span class="module-icon" data-status=${agent.state === "working" ? "active" : agent.state}>${agent.state === "completed" ? this.icon("check") : "·"}</span>
          <span class="module-content"><span class="module-title-line"><span class="name">${agent.name}</span><span class="module-percent">${known ? `${percent}%` : "—"}</span></span>
          ${known ? html`<span class="module-track" role="meter" aria-label=${agent.name} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${bounded as number} aria-valuetext=${`${progress?.completed}/${progress?.total}`}><span class="module-fill" style=${`transform:scaleX(${(bounded as number) / 100})`}></span></span>` : nothing}
          <span class="module-meta"><span>${progress ? `${progress.completed}/${progress.total}` : "—"}</span><span class="status">${labels[agent.state]}</span></span></span>
        </article>`;
            })
          : html`<p class="empty">${!snapshot || snapshot.status === "pending" ? this.t("Agent activity is not available yet.", "尚未获取 Agent 活动。") : snapshot.status === "unavailable" ? this.t("Agent activity is unavailable.", "Agent 活动暂不可用。") : snapshot.complete ? this.t("No subagents recorded.", "暂无子 Agent 记录。") : this.t("No subagents are currently listed.", "当前没有可显示的子 Agent。")}</p>`
      }
      ${snapshot?.truncated ? html`<p class="muted">${this.t("The agent list is incomplete.", "Agent 列表未完整显示。")}</p>` : nothing}
    </section>`;
  }

  protected override render() {
    const task = this.data.task;
    const progress = task?.progress;
    const fresh =
      this.observed &&
      this.data.enabled !== false &&
      !!this.threadId &&
      !this.connectionError &&
      !task &&
      !this.data.taskSource &&
      !this.data.heartbeatPending &&
      !this.taskSourceIsPending() &&
      (!this.data.heartbeat ||
        (this.data.heartbeat.status === "none" &&
          !this.data.heartbeat.error &&
          !this.data.heartbeat.warning &&
          this.data.heartbeat.discoveryComplete !== false &&
          !this.data.heartbeat.candidates.length &&
          !this.data.heartbeat.findings.length));
    const title =
      task?.title ??
      (fresh
        ? this.t("Start a new session", "开始新任务 / 新会话")
        : this.t("Task progress", "任务进度"));
    const checklistComplete =
      !!progress && progress.total > 0 && progress.completed === progress.total;
    const sourceUnavailable =
      !this.taskSourceIsPending() &&
      ["stale", "error", "pending-selection"].includes(this.data.taskSource?.status ?? "");
    const managedComplete =
      this.data.completionBasis === "task-lifecycle" && !!task?.lifecycle?.completion;
    const showProgressBar =
      this.observed &&
      !this.connectionError &&
      !sourceUnavailable &&
      progress &&
      progress.percent !== null &&
      (managedComplete || !checklistComplete || this.data.execution?.state === "idle");
    const countedPercent = Math.max(0, Math.min(100, progress?.percent ?? 0));
    const checklistTitle = `${this.t("Registered checklist", "已登记清单")}: ${title}`;
    const orderedObjectives = (task?.objectives ?? [])
      .map((objective, originalIndex) => ({
        objective,
        originalIndex,
        display: this.objectiveDisplay(objective),
      }))
      .sort((a, b) => {
        const aTerminal = a.display.status === "completed" || a.display.status === "cancelled";
        const bTerminal = b.display.status === "completed" || b.display.status === "cancelled";
        if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
        return aTerminal ? a.originalIndex - b.originalIndex : b.originalIndex - a.originalIndex;
      });
    const viewTitle =
      this.tab === "tasks"
        ? title
        : this.tab === "history"
          ? this.t("Task history", "任务历史")
          : this.t("Project heartbeat", "项目心跳");
    const execution = this.executionLabel(checklistComplete);
    const refreshBusy = this.refreshing || this.refreshViewBusy || this.busy || this.heartbeatBusy;
    const refreshLabel =
      this.tab === "tasks"
        ? this.t("Refresh task", "刷新当前任务")
        : this.tab === "history"
          ? this.historySource()
            ? this.t("Refresh ledger history", "刷新台账历史")
            : this.t("Refresh", "刷新")
          : this.t("Refresh heartbeat history", "刷新心跳历史");
    return html`<section class="panel" aria-label=${this.t("Task progress", "任务进度")}>
      <div class="summary">
        <button class="main" title=${title} aria-label=${`${title} · ${this.checklistLabel()} · ${execution}`} aria-expanded=${this.expanded && this.tab === "tasks"} aria-controls="task-panel-content" @click=${this.toggleExpanded}>
          ${this.icon("layers", "capsule-icon")}<span class="capsule-copy"><span class="title">${title}</span><span class="summary-state"><span class="execution" data-execution-state=${this.data.execution?.state ?? "unknown"}>${execution}</span> · ${this.checklistLabel()}</span></span>
          <span class="percent">${showProgressBar ? (checklistComplete && !managedComplete ? this.icon("check") : html`${countedPercent}<small>%</small>`) : nothing}</span>${this.icon("down", "capsule-chevron")}
          <svg class="edge-progress" viewBox="0 0 368 44" aria-hidden="true"><path class="edge-track" pathLength="100"></path>${showProgressBar ? svg`<path class="edge-fill" pathLength="100" stroke-dasharray=${`${countedPercent} 100`}></path>` : nothing}</svg>
          ${showProgressBar ? html`<span class="track sr-status" role="progressbar" aria-valuenow=${countedPercent} aria-valuemin="0" aria-valuemax="100" aria-label=${checklistTitle} aria-valuetext=${this.checklistLabel()}><span class="fill" style=${`width:${countedPercent}%`}></span></span>` : nothing}
        </button>
        <button class="orb history-trigger" aria-label=${this.t("History", "历史")} aria-expanded=${this.expanded && this.tab === "history"} aria-controls="task-panel-content" @click=${() => void this.openPanel("history")}>${this.icon("history")}</button>
        <button class="orb heartbeat-trigger" aria-label=${this.t("Heartbeat", "心跳")} aria-expanded=${this.expanded && this.tab === "heartbeat"} aria-controls="task-panel-content" @click=${() => void this.openPanel("heartbeat")}>${this.icon("heartbeat")}<span class="heartbeat-mark" data-status=${this.data.heartbeat?.status ?? "none"} aria-hidden="true"></span></button>
      </div>
      <div class="sr-status" role="status" aria-live="polite" aria-atomic="true">${this.connectionError ? this.t("Checklist unavailable", "清单暂不可用") : ""}</div>
      <div class="body" id="task-panel-content" role="region" aria-labelledby="panel-title" data-state="open">
        <header class="panel-head" data-view=${this.tab}>
          <div class="panel-topline"><div class="panel-kicker">${this.icon(this.tab === "tasks" ? "layers" : this.tab)}${this.tab === "tasks" ? this.t("Current task", "当前任务") : this.tab === "history" ? this.t("Recorded changes", "变更记录") : this.t("Project activity", "项目动态")}</div><button class="panel-refresh" aria-label=${refreshLabel} aria-busy=${String(refreshBusy)} ?disabled=${!this.refreshTask || !this.threadId || refreshBusy} @click=${() => void this.refreshCurrentView()}>${this.lucideIcon(RefreshCw)}</button></div>
          <div class="panel-heading"><h2 class="panel-title" id="panel-title" title=${viewTitle} tabindex="-1">${viewTitle}</h2></div>
          ${
            this.tab === "tasks"
              ? html`<div class="task-mode" role="group" aria-label=${this.t("Task view", "任务视图")}><button aria-pressed=${String(this.taskMode === "subagents")} @click=${() => {
                  this.taskMode = "subagents";
                }}>${this.t("Subagents", "子 Agent")}</button><button aria-pressed=${String(this.taskMode === "registered-tasks")} @click=${() => {
                  this.taskMode = "registered-tasks";
                }}>${this.t("Registered tasks", "已登记任务")}</button></div><div class="total-line"><span>${this.checklistLabel()}</span><span>${execution}</span></div>${showProgressBar ? html`<div class="track" aria-hidden="true"><div class="fill" style=${`transform:scaleX(${countedPercent / 100})`}></div></div>` : nothing}`
              : this.tab === "history"
                ? html`<p class="panel-subtitle">${this.t("Task changes and their recorded evidence.", "任务变更与已记录的依据。")}</p>`
                : this.tab === "heartbeat"
                  ? html`<p class="panel-subtitle">${this.t("Agent activity and tasks that need attention.", "Agent 活动与需要关注的任务。")}</p>`
                  : nothing
          }
        </header>
        <div class=${`scroll ${this.tab === "tasks" ? "modules" : ""}`}>
          ${this.connectionError ? this.diagnostic(this.t("Connection error details", "连接错误详情"), this.connectionError) : nothing}
          ${
            this.tab === "history"
              ? this.renderHistory()
              : this.tab === "heartbeat"
                ? this.renderHeartbeat()
                : this.taskMode === "subagents"
                  ? html`${this.renderSubagents()}${this.renderTaskSource()}`
                  : html`${
                      orderedObjectives.length
                        ? repeat(
                            orderedObjectives,
                            ({ objective }) => objective.id,
                            ({ objective, display }, index) =>
                              this.objective(objective, index, display),
                          )
                        : html`<p class="empty">${sourceUnavailable || this.taskSourceIsPending() ? this.checklistLabel() : !this.observed || this.connectionError ? this.checklistLabel() : fresh ? this.t("Start a task in this chat to see its progress here.", "在此会话中开始任务后，即可在这里查看进度。") : this.threadId ? this.t("A checklist appears when work is registered. Questions do not create tasks.", "登记实施需求后展示清单，普通问答不会创建任务。") : this.t("Waiting for this chat’s identity…", "等待此聊天的身份确认…")}</p>`
                    }${this.renderCloseout()}${this.renderArchive()}${this.renderTaskSource()}`
          }
        </div>
        <footer class="panel-foot">${this.icon(this.tab === "tasks" ? "layers" : this.tab)}<span>${this.tab === "tasks" ? (this.taskMode === "subagents" ? `${this.data.subagents?.parentThreadId === this.threadId && (this.data.subagents.status === "ready" || this.data.subagents.status === "partial") ? this.data.subagents.agents.length : "—"} ${this.t("agents listed", "个已列出 Agent")}` : `${task?.objectives.length ?? 0} ${this.t("subtasks · expand to inspect nodes", "个子任务 · 展开查看节点")}`) : this.tab === "history" ? this.t("Recorded history", "已记录历史") : this.t("Read only · separate from execution", "只读展示 · 与执行状态独立")}</span></footer>
      </div>
    </section>`;
  }
}

/** A new bundle cannot redefine a custom element already registered by an older build. */
export function registerTaskProgressElement(window: Window): string {
  const registry = window.customElements;
  if (registry.get(TASK_PROGRESS_ELEMENT_NAME) === TaskProgressElement)
    return TASK_PROGRESS_ELEMENT_NAME;
  if (!registry.get(TASK_PROGRESS_ELEMENT_NAME)) {
    registry.define(TASK_PROGRESS_ELEMENT_NAME, TaskProgressElement);
    return TASK_PROGRESS_ELEMENT_NAME;
  }
  const versioned = `${TASK_PROGRESS_ELEMENT_NAME}-v${GOAL_PROGRESS_RELEASE_VERSION.replaceAll(".", "-")}`;
  let name = versioned;
  let revision = 1;
  while (registry.get(name) && registry.get(name) !== TaskProgressElement)
    name = `${versioned}-r${++revision}`;
  if (!registry.get(name)) registry.define(name, TaskProgressElement);
  return name;
}
