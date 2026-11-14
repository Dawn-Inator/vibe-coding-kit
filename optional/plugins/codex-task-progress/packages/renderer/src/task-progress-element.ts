import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers3,
  List,
  type LucideIconData,
  type LucideIconNode,
  RefreshCw,
} from "@lucide/icons";
import { html, LitElement, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/release-version.js";
import {
  GOAL_PROGRESS_ELEMENT_NAME,
  GOAL_PROGRESS_HOT_ELEMENT_NAME,
} from "../../contracts/src/renderer-events.js";
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
  status: "none" | "candidates" | "ready" | "stale" | "error";
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
  items: readonly Record<string, unknown>[];
  wakes: readonly Record<string, unknown>[];
  itemCount?: number;
  wakeCount?: number;
  itemsTruncated?: boolean;
  wakesTruncated?: boolean;
  itemStatusCounts?: Readonly<Record<string, number>>;
  findings: readonly { severity: string; message: string; rule?: string }[];
  error?: string;
  warning?: string;
  basis?: "configured" | "latest-recorded-wake" | "items-inventory" | "none";
}
export interface TaskPanelHistory {
  events: readonly Record<string, unknown>[];
  nextCursor: string | null;
  error?: string;
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
}
export interface TaskPanelExecution {
  state: "working" | "waiting" | "idle" | "unknown";
  observedAt: string;
  source: "codex-app-server" | "codex-ui";
  activeFlags?: readonly string[];
}
export interface TaskPanelResponse {
  enabled?: boolean;
  task: TaskPanelState | null;
  heartbeat: TaskPanelHeartbeat | null;
  heartbeatPending?: boolean;
  taskSource?: {
    status: "candidates" | "pending-selection" | "ready" | "stale" | "error";
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
  completionBasis?: "registered-checklist";
}
export interface TaskPanelRequest {
  method: "get" | "history" | "bind-heartbeat" | "heartbeat-history";
  threadId: string;
  cursor?: string;
  path?: string | null;
}
export type TaskPanelRequester = (input: TaskPanelRequest) => Promise<TaskPanelResponse>;

export const TASK_PROGRESS_ELEMENT_NAME = "codex-task-panel";
const persisted = (key: string): string | null => {
  try {
    return localStorage.getItem(`codex-task-progress:${key}`);
  } catch {
    return null;
  }
};
const persist = (key: string, value: string): void => {
  try {
    localStorage.setItem(`codex-task-progress:${key}`, value);
  } catch {
    // Display preferences are optional when browser storage is unavailable.
  }
};

export class TaskProgressElement extends LitElement {
  static override properties = {
    data: { attribute: false },
    observed: { attribute: false },
    threadId: { attribute: false },
    requester: { attribute: false },
    connectionError: { attribute: false },
    expanded: { state: true },
    closing: { state: true },
    tab: { state: true },
    selectedObjective: { state: true },
    history: { state: true },
    heartbeatHistory: { state: true },
    heartbeatBusy: { state: true },
    busy: { state: true },
    locale: { attribute: false },
  };

  static override styles = taskPanelStyles;

  declare data: TaskPanelResponse;
  declare observed: boolean;
  declare threadId: string | null;
  declare requester: TaskPanelRequester | null;
  declare connectionError: string | null;
  declare expanded: boolean;
  declare locale: string;
  private declare tab: "tasks" | "history" | "heartbeat";
  private declare closing: boolean;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private sizeObserver: ResizeObserver | null = null;
  private heartbeatRequest = 0;
  private declare selectedObjective: string | null;
  private declare history: TaskPanelHistory | TaskPanelSourceHistory | null;
  private declare heartbeatHistory: TaskPanelHeartbeatHistory | null;
  private declare heartbeatBusy: boolean;
  private heartbeatHistoryContext: string | null = null;
  private heartbeatHistoryAttemptedContext: string | null = null;
  private heartbeatHistoryObservedContext: string | null | undefined;
  private heartbeatHistoryError: string | null = null;
  private heartbeatHistoryErrorContext: string | null = null;
  private heartbeatWakeExpansion = new Map<string, boolean>();
  private declare busy: boolean;
  private historyThread: string | null = null;
  private historyContext: string | null = null;
  private historyRequest = 0;

  constructor() {
    super();
    this.data = { task: null, heartbeat: null };
    this.observed = false;
    this.threadId = null;
    this.requester = null;
    this.connectionError = null;
    this.expanded = persisted("expanded") === "true";
    this.locale = "en";
    this.tab = "tasks";
    this.closing = false;
    this.selectedObjective = null;
    this.history = null;
    this.heartbeatHistory = null;
    this.heartbeatBusy = false;
    this.heartbeatHistoryContext = null;
    this.heartbeatHistoryAttemptedContext = null;
    this.heartbeatHistoryObservedContext = undefined;
    this.heartbeatHistoryError = null;
    this.heartbeatHistoryErrorContext = null;
    this.heartbeatWakeExpansion.clear();
    this.busy = false;
  }

  private t(en: string, zh: string): string {
    return this.locale.toLowerCase().startsWith("zh") ? zh : en;
  }

  get floating(): boolean {
    return false;
  }

  set floating(_value: boolean) {
    // The ordinary task panel remains docked; ignore persisted and external requests.
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
    return this.locale.startsWith("zh") ? (labels[value] ?? value) : value;
  }

  resetThread(threadId: string | null): void {
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
    this.heartbeatWakeExpansion.clear();
    this.heartbeatRequest++;
    this.historyThread = null;
    this.historyContext = null;
    this.historyRequest++;
    this.selectedObjective = null;
    this.connectionError = null;
    this.busy = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.ownerDocument.addEventListener("click", this.outsideClick);
    this.ownerDocument.addEventListener("focusin", this.outsideFocus);
    this.ownerDocument.addEventListener("keydown", this.escapeKey);
    this.ownerDocument.defaultView?.addEventListener("resize", this.positionPopover);
    this.ownerDocument.defaultView?.addEventListener("scroll", this.positionPopover, true);
    this.addEventListener("task-progress-position", this.positionPopover);
    this.sizeObserver = new ResizeObserver(() => {
      this.drawEdge();
      this.positionPopover();
    });
    this.sizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.ownerDocument.removeEventListener("click", this.outsideClick);
    this.ownerDocument.removeEventListener("focusin", this.outsideFocus);
    this.ownerDocument.removeEventListener("keydown", this.escapeKey);
    this.ownerDocument.defaultView?.removeEventListener("resize", this.positionPopover);
    this.ownerDocument.defaultView?.removeEventListener("scroll", this.positionPopover, true);
    this.removeEventListener("task-progress-position", this.positionPopover);
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    super.disconnectedCallback();
  }

  protected override updated(): void {
    this.drawEdge();
    this.positionPopover();
    this.loadHeartbeatHistoryOnOpen();
  }

  private loadHeartbeatHistoryOnOpen(): void {
    if (!this.expanded || this.tab !== "heartbeat") return;
    const context = this.currentHeartbeatHistoryContext();
    if (this.heartbeatHistoryObservedContext !== context) {
      this.heartbeatHistoryObservedContext = context;
      this.heartbeatHistoryAttemptedContext = null;
      this.heartbeatHistoryContext = null;
      this.heartbeatHistory = null;
      this.heartbeatHistoryError = null;
      this.heartbeatHistoryErrorContext = null;
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
    const heartbeat = this.data.heartbeat;
    if (!this.threadId || !heartbeat?.sourcePath) return null;
    return JSON.stringify([this.threadId, heartbeat.sourcePath, heartbeat.contentHash ?? null]);
  }

  private readonly outsideClick = (event: Event): void => {
    if (!this.expanded || event.composedPath().includes(this)) return;
    const target = event.composedPath()[0];
    const focusable =
      target instanceof Element &&
      target.closest("button,a[href],input,textarea,select,[tabindex]");
    this.closePanel(!focusable);
  };

  private readonly outsideFocus = (event: Event): void => {
    if (this.expanded && !event.composedPath().includes(this)) this.closePanel(false);
  };

  private readonly escapeKey = (event: KeyboardEvent): void => {
    if (!this.expanded || event.key !== "Escape") return;
    event.preventDefault();
    const active = this.shadowRoot?.activeElement;
    if (this.tab === "tasks" && this.selectedObjective && active?.closest(".modules")) {
      const row = [...this.renderRoot.querySelectorAll<HTMLButtonElement>(".row")].find(
        (element) => element.dataset.objective === this.selectedObjective,
      );
      this.selectedObjective = null;
      row?.focus({ preventScroll: true });
    } else this.closePanel();
  };

  private closePanel(restoreFocus = true): void {
    if (!this.expanded) return;
    const trigger = this.renderRoot.querySelector<HTMLButtonElement>(
      this.tab === "tasks" ? ".main" : `.${this.tab}-trigger`,
    );
    this.expanded = false;
    this.closing = !this.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    persist("expanded", "false");
    if (restoreFocus) trigger?.focus({ preventScroll: true });
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.closing)
      this.closeTimer = setTimeout(() => {
        this.closing = false;
      }, 130);
  }

  private async openPanel(view: "tasks" | "history" | "heartbeat"): Promise<void> {
    if (this.expanded && this.tab === view) {
      this.closePanel();
      return;
    }
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closing = false;
    this.tab = view;
    this.expanded = true;
    persist("expanded", "true");
    if (view === "history") void this.loadHistory();
    if (view === "heartbeat") this.loadHeartbeatHistoryOnOpen();
    await this.updateComplete;
    if (this.expanded && this.tab === view)
      this.renderRoot.querySelector<HTMLElement>(".panel-title")?.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent("task-progress-layout", { bubbles: true, composed: true }));
  }

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

  private readonly positionPopover = (): void => {
    const body = this.renderRoot.querySelector<HTMLElement>(".body");
    const window = this.ownerDocument.defaultView;
    if (!body || !window) return;
    const rect = this.getBoundingClientRect();
    const style = window.getComputedStyle(this);
    const composerTop = Number.parseFloat(style.getPropertyValue("--ctp-composer-top"));
    const budget = Number.parseFloat(style.getPropertyValue("--ctp-panel-max-height")) || 496;
    const occupied = [
      ...this.ownerDocument.querySelectorAll<HTMLElement>(
        `${GOAL_PROGRESS_ELEMENT_NAME},${GOAL_PROGRESS_HOT_ELEMENT_NAME}`,
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter(
        (box) =>
          box.width > 0 &&
          box.height > 0 &&
          box.top > rect.bottom &&
          box.right > rect.left &&
          box.left < rect.right,
      )
      .map((box) => box.top - 8);
    const bottom = Math.min(
      window.innerHeight - 12,
      Number.isFinite(composerTop) ? composerTop - 12 : window.innerHeight - 12,
      ...occupied,
    );
    const available = bottom - rect.top - 55;
    const compact = available < 230;
    body.classList.toggle("compact", compact);
    const top = compact ? 12 : rect.top + 55;
    const width = Math.min(464, window.innerWidth - 24);
    body.style.setProperty("--ctp-popover-top", `${top}px`);
    body.style.setProperty(
      "--ctp-popover-left",
      `${Math.min(Math.max(12, rect.left), window.innerWidth - width - 12)}px`,
    );
    body.style.setProperty("--ctp-popover-width", `${width}px`);
    body.style.maxHeight = `${Math.max(0, Math.min(budget, bottom - top))}px`;
  };

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

  private basename(path: string | null | undefined): string | null {
    if (!path) return null;
    const name = path.split(/[\\/]/).filter(Boolean).at(-1);
    return name || null;
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
      const mismatch = expectedSource
        ? !(
            page?.source &&
            page.source.kind === "kit-heartbeat" &&
            page.source.path === expectedSource.path &&
            page.source.contentHash === expectedSource.contentHash
          )
        : Boolean(page?.source);
      if (mismatch) {
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
      source?.contentHash ?? null,
      authority,
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
    const heartbeat = this.data.heartbeat;
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
      const currentHash = this.data.heartbeat?.contentHash;
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
    return html`<section class="hb-history" aria-label=${this.t("Heartbeat history", "巡检记录")}>
      <header class="hb-history-head">
        <h3>${this.lucideIcon(List)}<span>${this.t("Heartbeat history", "巡检记录")}</span><span class="hb-count">${count}</span></h3>
        <button class="hb-refresh" aria-label=${this.t("Refresh heartbeat history", "刷新心跳历史")} ?disabled=${this.heartbeatBusy || !heartbeat.sourcePath} @click=${() => void this.loadHeartbeatHistory()}>
          ${this.lucideIcon(RefreshCw)}<span>${this.heartbeatBusy ? this.t("Loading…", "加载中…") : this.t("Refresh", "刷新")}</span>
        </button>
      </header>
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
        const rowCount =
          typeof wake.rowCount === "number"
            ? wake.rowCount
            : Array.isArray(wake.rows)
              ? wake.rows.length
              : 0;
        const rows = Array.isArray(wake.rows)
          ? wake.rows.filter(
              (row): row is Record<string, unknown> =>
                typeof row === "object" && row !== null && !Array.isArray(row),
            )
          : [];
        const renderRow = (row: Record<string, unknown>) => {
          const label = String(row.category ?? row.item ?? row.id ?? "");
          const state = String(row.state ?? row.status ?? "");
          const wakeSourcePath = wake.sourcePath ?? heartbeat.sourcePath;
          const wakeLocation =
            typeof wake.line === "number"
              ? wakeSourcePath
                ? `${String(wakeSourcePath)}:${wake.line}`
                : `#${wake.line}`
              : "";
          const rowSourcePath = row.sourcePath ?? wake.sourcePath ?? heartbeat.sourcePath;
          const rowLocation =
            typeof row.line === "number"
              ? rowSourcePath
                ? `${String(rowSourcePath)}:${row.line}`
                : `#${row.line}`
              : "";
          const provenance =
            wakeLocation && rowLocation && wakeLocation !== rowLocation
              ? html`<p><strong>${this.t("Record source", "记录来源")}</strong><code>${wakeLocation}</code></p><p><strong>${this.t("Row source", "行来源")}</strong><code>${rowLocation}</code></p>`
              : wakeLocation || rowLocation
                ? html`<p><strong>${this.t("Source", "来源")}</strong><code>${rowLocation || wakeLocation}</code></p>`
                : nothing;
          return html`<div class="hb-record">
            <div class="hb-record-preview"><strong>${label}</strong><span>${state}</span></div>
            <details class="hb-record-raw hb-wake-raw"><summary>${this.t("View original", "查看原文")}</summary><div class="hb-row-original">
              ${wake.timeMs !== null && wake.timeMs !== undefined ? html`<p><strong>${this.t("Recorded time", "记录时间")}</strong><code>${this.date(wake.timeMs)}</code></p>` : nothing}
              ${typeof wake.heading === "string" ? html`<p><strong>${this.t("Heading", "标题")}</strong><code>${wake.heading}</code></p>` : nothing}
              ${row.category !== undefined ? html`<p><strong>${this.t("Category", "分类")}</strong><span>${String(row.category)}</span></p>` : nothing}
              ${row.state !== undefined ? html`<p><strong>${this.t("State", "状态")}</strong><span>${String(row.state)}</span></p>` : nothing}
              ${row.heading !== undefined ? html`<p><strong>${this.t("Heading", "标题")}</strong><span>${String(row.heading)}</span></p>` : nothing}
              ${provenance}
            </div></details>
          </div>`;
        };
        return html`<details class="hb-wake" ?open=${this.heartbeatWakeExpansion.get(key) ?? index === 0} @toggle=${(
          event: Event,
        ) => {
          if (event.target === event.currentTarget)
            this.heartbeatWakeExpansion.set(key, (event.currentTarget as HTMLDetailsElement).open);
        }}>
          <summary><span class="hb-wake-time">${heading}</span><span class="hb-wake-count">${this.t(`${rowCount} records`, `${rowCount}项记录`)}</span>${this.lucideIcon(ChevronRight, "hb-wake-chevron")}</summary>
          <div class="hb-wake-body">
            ${
              !rows.length
                ? html`<details class="hb-wake-raw"><summary>${this.t("View original", "查看原文")}</summary><div class="hb-wake-original">
              ${wake.timeMs !== null && wake.timeMs !== undefined ? html`<p><strong>${this.t("Recorded time", "记录时间")}</strong><code>${this.date(wake.timeMs)}</code></p>` : nothing}
              ${typeof wake.heading === "string" ? html`<p><strong>${this.t("Heading", "标题")}</strong><code>${wake.heading}</code></p>` : nothing}
              ${typeof wake.line === "number" ? html`<p><strong>${this.t("Source", "来源")}</strong><code>${(wake.sourcePath ?? heartbeat.sourcePath) ? `${String(wake.sourcePath ?? heartbeat.sourcePath)}:${wake.line}` : `#${wake.line}`}</code></p>` : nothing}
            </div></details>`
                : nothing
            }
            ${rows.slice(0, 2).map(renderRow)}
            ${rows.length > 2 ? html`<details class="hb-more-records"><summary>${this.t(`Show ${rows.length - 2} more records`, `查看其余 ${rows.length - 2} 项记录`)}</summary>${rows.slice(2).map(renderRow)}</details>` : nothing}
            ${wake.truncated === true ? html`<p class="hb-truncated">${this.t("This is a record preview. See the source file for full content.", "当前为记录预览，完整内容见来源文件。")}</p>` : nothing}
          </div>
        </details>`;
      })}
      ${historyError ? this.diagnostic(this.t("Heartbeat history error", "心跳历史错误"), historyError) : nothing}
      ${history?.nextCursor ? html`<button class="hb-older" ?disabled=${this.heartbeatBusy} @click=${() => void this.loadHeartbeatHistory(true)}>${this.t("Load older heartbeats", "加载更早心跳")}</button>` : nothing}
      ${!history && heartbeat.wakesTruncated ? html`<p class="muted">${this.t("Recent records shown; load history to browse older audits.", "当前仅展示近期记录，可分页查看更早巡检。")}</p>` : nothing}
      ${!wakes.length && !historyError && heartbeat.sourcePath && !this.heartbeatBusy ? html`<p class="empty">${this.t("No heartbeat records are available.", "暂无可用的巡检记录。")}</p>` : nothing}
    </section>`;
  }

  private evidence(items: readonly TaskPanelEvidence[]) {
    return items.map(
      (item) =>
        html`<div class="evidence"><strong>${item.verification === "verified" ? this.t("Verified", "实际验证") : this.t("Reported", "模型报告")}</strong> · ${item.summary}${item.reference ? html`<div>${item.reference}</div>` : nothing}</div>`,
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
    const heartbeat = this.data.heartbeat;
    if (!heartbeat) {
      const pending = this.data.heartbeatPending === true;
      const statusText = pending
        ? this.t("Reading project heartbeat…", "正在读取项目心跳…")
        : this.t(
            "No current project heartbeat source is available.",
            "当前项目没有可显示的心跳来源。",
          );
      return html`<div class="heartbeat hb-panel"><p class="empty" role="status" aria-live="polite">${statusText}</p><section class="hb-history" aria-label=${this.t("Heartbeat history", "巡检记录")}><header class="hb-history-head"><h3>${this.lucideIcon(List)}<span>${this.t("Heartbeat history", "巡检记录")}</span><span class="hb-count">0</span></h3><button class="hb-refresh" aria-label=${this.t("Refresh heartbeat history", "刷新心跳历史")} disabled>${this.lucideIcon(RefreshCw)}<span>${this.t("Refresh", "刷新")}</span></button></header><p class="empty">${pending ? this.t("Waiting for the heartbeat source before loading history.", "等待心跳来源后再读取历史。") : this.t("Heartbeat history is unavailable without a current source.", "没有当前心跳来源，无法读取巡检历史。")}</p></section></div>`;
    }
    const sourcePath = heartbeat.sourcePath;
    const sourceName = this.basename(sourcePath);
    const historyName = this.basename(heartbeat.historyPath);
    const hasAlert = Boolean(heartbeat.warning || heartbeat.findings.length);
    return html`<div class="heartbeat hb-panel">
      ${
        sourcePath
          ? html`<section class="hb-time-card" aria-label=${this.t("Heartbeat times", "心跳时间")}>
        <div class="hb-times"><div class="hb-time"><div class="hb-time-label">${this.lucideIcon(CalendarDays)}<span>${this.t("Latest record", "最近记录")}</span></div><strong>${this.time(heartbeat.lastWakeAt)}</strong></div><div class="hb-time"><div class="hb-time-label">${this.lucideIcon(CalendarDays)}<span>${this.t("Next audit", "下次巡检")}</span></div><strong>${heartbeat.nextWakeAt ? this.time(heartbeat.nextWakeAt) : "—"}</strong></div></div>
        <div class="hb-time-date">${heartbeat.lastWakeAt ? this.dateOnly(heartbeat.lastWakeAt) : this.t("No heartbeat time recorded", "尚无心跳时间记录")}${sourceName ? html`<span> · ${sourceName}</span>` : nothing}</div>
      </section>`
          : html`<p class="empty">${this.t("No current project heartbeat source is available.", "当前项目没有可显示的心跳来源。")}</p>`
      }
      ${hasAlert ? html`<details class="hb-alert"><summary>${this.lucideIcon(AlertTriangle)}<span>${this.t("Validation notice", "校验提示")}</span>${this.lucideIcon(ChevronDown, "hb-alert-chevron")}</summary>${heartbeat.warning ? html`<p>${heartbeat.warning}</p>` : nothing}${heartbeat.findings.map((finding) => html`<p><strong>${finding.severity}</strong>${finding.rule ? ` · ${finding.rule}` : ""} · ${finding.message}</p>`)}</details>` : nothing}
      ${heartbeat.error ? this.diagnostic(this.t("Project heartbeat error", "项目心跳错误"), heartbeat.error) : nothing}
      <details class="hb-items"><summary>${this.lucideIcon(Layers3)}<span>${this.t("Items and blockers", "登记项与阻塞")}</span><span class="hb-count">${heartbeat.itemCount ?? heartbeat.items.length}</span>${this.lucideIcon(ChevronRight, "hb-disclosure-chevron")}</summary><div class="hb-items-body">${heartbeat.items.map((item) => html`<article class="hb-item"><div><span class="status">${String(item.status ?? "")}</span> <strong>${String(item.item ?? item.id ?? "")}</strong></div>${item.evidence !== undefined ? html`<p>${String(item.evidence)}</p>` : nothing}</article>`)}</div></details>
      ${this.renderHeartbeatHistory(heartbeat)}
      <details class="hb-source"><summary>${this.lucideIcon(FileText)}<span>${sourceName ?? this.t("Heartbeat source", "心跳来源")}${heartbeat.historyPath && heartbeat.historyPath !== sourcePath && historyName ? ` / ${historyName}` : ""}</span>${this.lucideIcon(ChevronRight, "hb-disclosure-chevron")}</summary><div class="hb-source-list">
        ${sourcePath ? html`<div><span>${this.t("Heartbeat", "心跳")}</span><code>${sourcePath}</code></div>` : nothing}
        ${heartbeat.historyPath && heartbeat.historyPath !== sourcePath ? html`<div><span>${this.t("History", "历史")}</span><code>${heartbeat.historyPath}</code></div>` : nothing}
        <div><span>${this.t("Access", "访问方式")}</span><span>${this.t("Read only", "只读")}</span></div>
        ${heartbeat.basis ? html`<div><span>${this.t("Source basis", "来源依据")}</span><span>${this.heartbeatBasisLabel(heartbeat.basis)}</span></div>` : nothing}
        <div><span>${this.t("Latest record", "最近记录")}</span><span>${this.date(heartbeat.lastWakeAt)}</span></div>
        ${heartbeat.nextWakeAt ? html`<div><span>${this.t("Next audit", "下次巡检")}</span><span>${this.date(heartbeat.nextWakeAt)}</span></div>` : nothing}
        <div><span>${this.t("Ledger modified", "台账更新时间")}</span><span>${this.date(heartbeat.modifiedAt)}</span></div>
        <div><span>${this.t("Refreshed", "刷新时间")}</span><span>${this.date(heartbeat.refreshedAt)}</span></div>
        <div><span>${this.t("Items", "登记项")}</span><span>${heartbeat.itemCount ?? heartbeat.items.length} · ${
          heartbeat.itemStatusCounts
            ? Object.entries(heartbeat.itemStatusCounts)
                .map(([status, count]) => `${this.status(status)} ${count}`)
                .join(" · ")
            : this.itemSummary(heartbeat.items)
        }${heartbeat.itemsTruncated && !heartbeat.itemStatusCounts ? this.t(" (counts from visible sample)", "（状态统计为当前样本）") : nothing}</span></div>
        ${heartbeat.error ? html`<div><span>${this.t("Error", "错误")}</span><span>${heartbeat.error}</span></div>` : nothing}
        ${heartbeat.warning ? html`<div><span>${this.t("Warning", "警告")}</span><span>${heartbeat.warning}</span></div>` : nothing}
        ${heartbeat.findings.map((finding) => html`<div><span>${finding.severity}</span><span>${finding.rule ? `${finding.rule} · ` : ""}${finding.message}</span></div>`)}
      </div></details>
    </div>`;
  }

  private itemSummary(items: readonly Record<string, unknown>[]): string {
    const counts = new Map<string, number>();
    for (const item of items) {
      const status = String(item.status ?? "unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts].map(([status, count]) => `${this.status(status)} ${count}`).join(" · ");
  }

  private heartbeatBasisLabel(basis: NonNullable<TaskPanelHeartbeat["basis"]>): string {
    switch (basis) {
      case "configured":
        return this.t("Project configuration", "项目配置");
      case "latest-recorded-wake":
        return this.t("Latest heartbeat record", "最近心跳记录");
      case "items-inventory":
        return this.t("Project ledger (no heartbeat record yet)", "项目台账（暂无心跳记录）");
      default:
        return this.t("Automatic resolution", "自动定位");
    }
  }

  private renderHistory() {
    const context = this.currentHistoryContext();
    if (this.historyContext !== context) {
      this.historyContext = context;
      this.history = null;
      this.historyThread = null;
      this.historyRequest++;
      this.busy = false;
    }
    const source = this.historySource();
    if (source) {
      const sourceHistory = this.history && "source" in this.history ? this.history : null;
      if (!sourceHistory && !this.busy) void this.loadHistory();
      const wakes = sourceHistory?.wakes ?? [];
      const sourceError = sourceHistory
        ? (sourceHistory.source.error ?? null)
        : (source.error ??
          (this.data.taskSource?.status === "stale" ||
          this.data.taskSource?.status === "error" ||
          this.data.taskSource?.status === "pending-selection"
            ? (this.data.taskSource.error ?? "The bound ledger is unavailable or stale.")
            : null));
      const historyPath = sourceHistory?.source.historyPath ?? source.historyPath;
      const pairedHistoryPath = historyPath ?? null;
      return html`${
        source?.path
          ? pairedHistoryPath
            ? html`<p class="muted">${this.t("Read-only heartbeat source", "只读心跳来源")}: ${source.path}</p><p class="muted">${this.t("History ledger", "历史台账")}: ${pairedHistoryPath}</p>`
            : html`<p class="muted">${this.t("Read-only ledger", "只读台账")}: ${source.path}</p>`
          : nothing
      }${sourceHistory ? html`<p class="muted">${this.t("Ledger records", "台账记录")}: ${sourceHistory.total}</p>` : nothing}${
        sourceError
          ? this.diagnostic(this.t("Ledger history unavailable", "台账历史不可用"), sourceError)
          : wakes.length
            ? wakes.map(
                (wake) =>
                  html`<div class="event"><strong>${String(wake.heading ?? this.date(wake.timeMs))}</strong>${typeof wake.line === "number" ? html`<div class="muted">${this.t("Source line", "来源行号")} ${wake.sourcePath ? `${String(wake.sourcePath)}:${wake.line}` : wake.line}</div>` : nothing}${
                    Array.isArray(wake.rows)
                      ? wake.rows.map((raw) => {
                          const row = raw as Record<string, unknown>;
                          const sourcePath =
                            typeof row.sourcePath === "string" ? row.sourcePath : wake.sourcePath;
                          const location =
                            typeof row.line === "number" && sourcePath
                              ? html`<span> · ${this.t("Source", "来源位置")} ${String(sourcePath)}:${row.line}</span>`
                              : nothing;
                          return html`<p class="muted">${String(row.category ?? "")} · ${String(row.state ?? "")}${location}</p>`;
                        })
                      : nothing
                  }</div>`,
              )
            : sourceHistory
              ? html`<p class="empty">${this.t("No recorded wake audits in this ledger.", "此台账暂无已记录的心跳巡检。")}</p>`
              : html`<p class="empty">${this.busy ? this.t("Loading ledger history…", "正在加载台账历史…") : this.t("Waiting for ledger history…", "等待台账历史…")}</p>`
      }${sourceHistory?.nextCursor ? html`<button ?disabled=${this.busy} @click=${() => void this.loadHistory(true)}>${this.t("Load older records", "加载更早记录")}</button>` : nothing}<button ?disabled=${this.busy} @click=${() => void this.loadHistory()}>${this.busy ? this.t("Loading…", "加载中…") : this.t("Refresh ledger history", "刷新台账历史")}</button>`;
    }
    if (this.historyThread !== this.threadId && !this.busy) void this.loadHistory();
    const localHistory = this.history && !("source" in this.history) ? this.history : null;
    return html`${(localHistory?.events ?? []).map((event) => html`<div class="event"><span class="muted">${this.date(event.occurredAt ?? event.at)}</span><p>${String(event.reason ?? event.type ?? "")}</p>${event.before && event.after ? html`<span class="muted">${this.progressText(event.before)} → ${this.progressText(event.after)}</span>` : nothing}</div>`)}${localHistory?.error ? this.diagnostic(this.t("History unavailable", "历史记录不可用"), localHistory.error) : !localHistory?.events.length ? html`<p class="empty">${this.busy ? this.t("Loading…", "加载中…") : this.t("No recorded changes yet.", "暂无变更记录。")}</p>` : nothing}${localHistory?.nextCursor ? html`<button ?disabled=${this.busy} @click=${() => void this.loadHistory(true)}>${this.t("Load more", "加载更多")}</button>` : nothing}<button ?disabled=${this.busy} @click=${() => void this.loadHistory()}>${this.t("Refresh", "刷新")}</button>`;
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
    const counts = `${this.t("Registered checklist", "已登记清单")} ${progress?.completed ?? 0}/${progress?.total ?? 0}`;
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

  private diagnostic(label: string, content: string) {
    return html`<details class="diagnostic"><summary>${label}</summary><pre class="diagnostic-text">${content}</pre></details>`;
  }

  private renderTaskSource() {
    const source = this.data.task?.source;
    const sourceInfo = this.data.taskSource;
    if (!source && !sourceInfo) return nothing;
    const path = source?.path ?? sourceInfo?.path;
    const statuses = source?.itemStatuses ?? sourceInfo?.itemStatuses;
    const risks = source?.linkRisks ?? [];
    const presentation = source?.presentation;
    return html`<details class="heartbeat"><summary>${this.t("Read-only Kit task source", "只读 Kit 任务来源")}</summary>
      ${path ? html`<p class="muted path-value">${path}</p>` : nothing}
      ${sourceInfo?.status === "stale" || sourceInfo?.status === "error" || sourceInfo?.status === "pending-selection" ? this.diagnostic(this.t("Source error details", "来源错误详情"), sourceInfo.error ?? this.t("Source could not be read.", "无法读取任务来源。")) : nothing}
      ${presentation?.truncated ? html`<p class="muted">${this.t("Showing", "当前显示")} ${presentation.displayedItemCount}/${presentation.sourceItemCount} ${this.t("source items. Progress counts the full source.", "个来源项；进度按全部来源项计算。")}</p>` : nothing}
      ${
        statuses
          ? html`<dl><dt>${this.t("Source item statuses", "来源项状态")}</dt><dd>${Object.entries(
              statuses,
            )
              .map(([id, status]) => `${id}: ${status}`)
              .join(
                " · ",
              )}${presentation?.itemStatusesTruncated ? ` · ${this.t("status list truncated", "状态列表已截断")}` : nothing}</dd></dl>`
          : nothing
      }
      ${risks.length ? html`<div class="error">${this.t("Unsafe parent links remain separate items", "不安全的父子关联项将分别显示")}: ${risks.join(" · ")}${presentation?.linkRisksTruncated ? ` · ${this.t("more link risks omitted", "其余关联风险已省略")}` : nothing}</div>` : nothing}
    </details>`;
  }

  protected override render() {
    const task = this.data.task;
    const progress = task?.progress;
    const title = task?.title ?? this.t("Task progress", "任务进度");
    const checklistComplete =
      !!progress && progress.total > 0 && progress.completed === progress.total;
    const sourceUnavailable = ["stale", "error", "pending-selection"].includes(
      this.data.taskSource?.status ?? "",
    );
    const showProgressBar =
      this.observed &&
      !this.connectionError &&
      !sourceUnavailable &&
      progress &&
      progress.percent !== null &&
      (!checklistComplete || this.data.execution?.state === "idle");
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
    return html`<section class="panel" aria-label=${this.t("Task progress", "任务进度")}>
      <div class="summary">
        <button class="main" title=${title} aria-label=${`${title} · ${this.checklistLabel()} · ${execution}`} aria-expanded=${this.expanded && this.tab === "tasks"} aria-controls="task-popover" @click=${this.toggleExpanded}>
          ${this.icon("layers", "capsule-icon")}<span class="capsule-copy"><span class="title">${title}</span><span class="summary-state"><span class="execution" data-execution-state=${this.data.execution?.state ?? "unknown"}>${execution}</span> · ${this.checklistLabel()}</span></span>
          <span class="percent">${showProgressBar ? (checklistComplete ? this.icon("check") : html`${countedPercent}<small>%</small>`) : nothing}</span>${this.icon("down", "capsule-chevron")}
          <svg class="edge-progress" viewBox="0 0 368 44" aria-hidden="true"><path class="edge-track" pathLength="100"></path>${showProgressBar ? svg`<path class="edge-fill" pathLength="100" stroke-dasharray=${`${countedPercent} 100`}></path>` : nothing}</svg>
          ${showProgressBar ? html`<span class="track sr-status" role="progressbar" aria-valuenow=${countedPercent} aria-valuemin="0" aria-valuemax="100" aria-label=${checklistTitle} aria-valuetext=${this.checklistLabel()}><span class="fill" style=${`width:${countedPercent}%`}></span></span>` : nothing}
        </button>
        <span class="orb-wrap"><button class="orb history-trigger" aria-label=${this.t("History", "历史")} aria-expanded=${this.expanded && this.tab === "history"} aria-controls="task-popover" @click=${() => void this.openPanel("history")}>${this.icon("history")}</button><span class="tooltip" aria-hidden="true">${this.t("History", "历史")}</span></span>
        <span class="orb-wrap"><button class="orb heartbeat-trigger" aria-label=${this.t("Heartbeat", "心跳")} aria-expanded=${this.expanded && this.tab === "heartbeat"} aria-controls="task-popover" @click=${() => void this.openPanel("heartbeat")}>${this.icon("heartbeat")}<span class="heartbeat-mark" data-status=${this.data.heartbeat?.status ?? "none"} aria-hidden="true"></span></button><span class="tooltip" aria-hidden="true">${this.t("Heartbeat", "心跳")}</span></span>
      </div>
      <div class="sr-status" role="status" aria-live="polite" aria-atomic="true">${this.connectionError ? this.t("Checklist unavailable", "清单暂不可用") : ""}</div>
      ${
        this.expanded || this.closing
          ? html`<div class="body" id="task-popover" role="region" aria-labelledby="panel-title" data-state=${this.closing ? "closing" : "open"} ?inert=${this.closing}>
        <header class="panel-head" data-view=${this.tab}>
          ${this.tab === "heartbeat" ? nothing : html`<div class="panel-kicker">${this.icon(this.tab === "tasks" ? "layers" : this.tab)}${this.tab === "tasks" ? this.t("Current task", "当前任务") : this.t("Recorded changes", "变更记录")}</div>`}
          <div class="panel-heading">${this.tab === "heartbeat" ? html`<span class="heartbeat-heading-icon">${this.icon("heartbeat")}</span>` : nothing}<h2 class="panel-title" id="panel-title" title=${viewTitle} tabindex="-1">${viewTitle}</h2>${this.tab === "heartbeat" && this.data.heartbeat ? html`<span class="hb-status" data-status=${this.data.heartbeat.status}>${this.data.heartbeat.status === "stale" ? this.t("Stale", "已过期") : this.data.heartbeat.status === "error" ? this.t("Error", "错误") : this.data.heartbeat.status === "none" ? this.t("Not available", "不可用") : this.data.heartbeat.status === "candidates" ? this.t("Candidate source", "候选来源") : this.data.heartbeat.certifiesCurrent ? this.t("Certified", "已认证") : this.t("Not certified", "未认证")}</span>` : nothing}<button class="close-panel" aria-label=${this.t("Close panel", "关闭面板")} @click=${() => this.closePanel()}>${this.icon("close")}</button></div>
          ${this.tab === "tasks" ? html`<div class="total-line"><span>${this.checklistLabel()}</span><span>${execution}</span></div>${showProgressBar ? html`<div class="track" aria-hidden="true"><div class="fill" style=${`transform:scaleX(${countedPercent / 100})`}></div></div>` : nothing}` : this.tab === "history" ? html`<p class="panel-subtitle">${this.t("Task changes and their recorded evidence.", "任务变更与已记录的依据。")}</p>` : nothing}
        </header>
        <div class=${`scroll ${this.tab === "tasks" ? "modules" : ""}`}>
          ${this.connectionError ? this.diagnostic(this.t("Connection error details", "连接错误详情"), this.connectionError) : nothing}
          ${
            this.tab === "history"
              ? this.renderHistory()
              : this.tab === "heartbeat"
                ? this.renderHeartbeat()
                : html`${
                    orderedObjectives.length
                      ? repeat(
                          orderedObjectives,
                          ({ objective }) => objective.id,
                          ({ objective, display }, index) =>
                            this.objective(objective, index, display),
                        )
                      : html`<p class="empty">${sourceUnavailable ? this.checklistLabel() : !this.observed ? this.checklistLabel() : this.threadId ? this.t("A checklist appears when work is registered. Questions do not create tasks.", "登记实施需求后展示清单，普通问答不会创建任务。") : this.t("Waiting for this chat’s identity…", "等待此聊天的身份确认…")}</p>`
                  }${this.renderTaskSource()}`
          }
        </div>
        <footer class="panel-foot">${this.icon(this.tab === "tasks" ? "layers" : this.tab)}<span>${this.tab === "tasks" ? `${task?.objectives.length ?? 0} ${this.t("subtasks · expand to inspect nodes", "个子任务 · 展开查看节点")}` : this.tab === "history" ? this.t("Recorded history", "已记录历史") : this.t("Read only · separate from execution", "只读展示 · 与执行状态独立")}</span></footer>
      </div>`
          : nothing
      }
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
