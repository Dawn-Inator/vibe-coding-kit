import { css, html, LitElement, nothing } from "lit";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/release-version.js";

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
}
export interface TaskPanelExecution {
  state: "working" | "waiting" | "idle" | "unknown";
  observedAt: string;
  source: "codex-app-server" | "codex-ui";
  activeFlags?: readonly string[];
}
export interface TaskPanelResponse {
  task: TaskPanelState | null;
  heartbeat: TaskPanelHeartbeat | null;
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
    tab: { state: true },
    selectedObjective: { state: true },
    history: { state: true },
    heartbeatHistory: { state: true },
    heartbeatBusy: { state: true },
    busy: { state: true },
    floating: { type: Boolean, reflect: true },
    locale: { attribute: false },
  };

  static override styles = css`
    :host { display: block; font: inherit; color: var(--ctp-text, #222); color-scheme: light dark; }
    * { box-sizing: border-box; }
    section.panel { max-height: var(--ctp-panel-max-height, calc(100vh - 24px)); border: 1px solid var(--ctp-border, #ddd); border-radius: 12px; background: var(--ctp-surface, #fff); box-shadow: 0 3px 16px #00000012; overflow: hidden; }
    button { font: inherit; color: inherit; }
    button { cursor: pointer; border: 0; border-radius: 6px; background: transparent; padding: .35em .6em; }
    button:hover { background: var(--ctp-hover, #88888815); }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--ctp-accent, #2977d4); outline-offset: -2px; }
    button:disabled { opacity: .55; cursor: default; }
    .summary { display: flex; align-items: center; min-height: 36px; gap: 6px; padding: 3px 7px; }
    .main { flex: 1; display: grid; grid-template-columns: minmax(70px, 1fr) auto; align-items: center; text-align: start; gap: 2px 12px; min-width: 0; }
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: var(--ctp-muted, #707070); font-size: .88em; overflow-wrap: anywhere; }
    .main .muted { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { grid-column: 1 / -1; height: 3px; border-radius: 3px; background: var(--ctp-track, #88888825); overflow: hidden; }
    .fill { height: 100%; background: var(--ctp-accent, #2977d4); transition: width 180ms ease; }
    .body { border-top: 1px solid var(--ctp-border, #ddd); }
    nav { display: flex; gap: 3px; padding: 5px 8px; }
    nav button[aria-selected="true"] { background: var(--ctp-hover, #88888815); font-weight: 600; }
    .scroll { max-height: min(44vh, 340px, var(--ctp-scroll-max-height, 340px)); overflow: auto; overscroll-behavior: contain; padding: 3px 12px 12px; }
    .row { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: start; padding: 8px 2px; border-bottom: 1px solid var(--ctp-border, #ddd); }
    .row .name { flex: 1; }
    .row[aria-expanded="true"] { color: var(--ctp-accent, #2977d4); }
    .status { font-size: .8em; border: 1px solid var(--ctp-border, #ddd); padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
    .detail { padding: 4px 6px 8px 15px; }
    .check { padding: 6px 0; }
    .check > div { display: flex; gap: 7px; align-items: baseline; }
    .evidence { margin: 4px 0 2px 19px; font-size: .86em; color: var(--ctp-muted, #707070); overflow-wrap: anywhere; }
    .evidence strong { font-weight: 500; }
    .empty { margin: 10px 0; color: var(--ctp-muted, #707070); }
    .heartbeat { margin-top: 10px; border-top: 1px solid var(--ctp-border, #ddd); padding-top: 10px; }
    h3 { font-size: 1em; margin: 0 0 7px; font-weight: 600; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 5px 0; font-size: .88em; }
    dt { color: var(--ctp-muted, #707070); } dd { margin: 0; overflow-wrap: anywhere; }
    .event { border-bottom: 1px solid var(--ctp-border, #ddd); padding: 7px 0; overflow-wrap: anywhere; }
    .event p { margin: 3px 0; } .error { color: var(--ctp-error, #bd4d3a); font-size: .88em; padding: 5px 10px; overflow-wrap: anywhere; }
    .path-value { overflow-wrap: anywhere; word-break: break-word; }
    .diagnostic { margin: 6px 0; overflow-wrap: anywhere; }
    .diagnostic-text { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; user-select: text; padding: 7px; border: 1px solid var(--ctp-border, #ddd); border-radius: 6px; background: var(--ctp-hover, #8888880a); font: .82em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .grip { cursor: move; touch-action: none; user-select: none; color: var(--ctp-muted, #707070); }
    details { margin-top: 7px; } summary { cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
  `;

  declare data: TaskPanelResponse;
  declare observed: boolean;
  declare threadId: string | null;
  declare requester: TaskPanelRequester | null;
  declare connectionError: string | null;
  declare expanded: boolean;
  declare floating: boolean;
  declare locale: string;
  private declare tab: "tasks" | "history";
  private declare selectedObjective: string | null;
  private declare history: TaskPanelHistory | TaskPanelSourceHistory | null;
  private declare heartbeatHistory: TaskPanelHeartbeatHistory | null;
  private declare heartbeatBusy: boolean;
  private heartbeatHistorySource: string | null = null;
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
    this.floating = persisted("floating") === "true";
    this.locale = "en";
    this.tab = "tasks";
    this.selectedObjective = null;
    this.history = null;
    this.heartbeatHistory = null;
    this.heartbeatBusy = false;
    this.heartbeatHistorySource = null;
    this.busy = false;
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
    this.heartbeatHistorySource = null;
    this.historyThread = null;
    this.historyContext = null;
    this.historyRequest++;
    this.selectedObjective = null;
    this.connectionError = null;
    this.busy = false;
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    persist("expanded", String(this.expanded));
    this.dispatchEvent(new CustomEvent("task-progress-layout", { bubbles: true, composed: true }));
  }

  private toggleFloating(): void {
    this.floating = !this.floating;
    persist("floating", String(this.floating));
    this.dispatchEvent(new CustomEvent("task-progress-layout", { bubbles: true, composed: true }));
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

  private async loadHeartbeatHistory(more = false): Promise<void> {
    const threadId = this.threadId;
    const sourcePath = this.data.heartbeat?.sourcePath;
    if (!threadId || !sourcePath || !this.requester || this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    try {
      const cursor =
        more && this.heartbeatHistorySource === sourcePath
          ? this.heartbeatHistory?.nextCursor
          : null;
      const result = await this.requester({
        method: "heartbeat-history",
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      if (this.threadId !== threadId || this.data.heartbeat?.sourcePath !== sourcePath) return;
      const page = result.heartbeatHistory;
      if (page && (!page.sourcePath || page.sourcePath === sourcePath)) {
        this.heartbeatHistory = {
          ...page,
          wakes:
            more && this.heartbeatHistorySource === sourcePath
              ? [...(this.heartbeatHistory?.wakes ?? []), ...page.wakes]
              : page.wakes,
        };
        this.heartbeatHistorySource = sourcePath;
      }
    } catch (error) {
      if (this.threadId === threadId && this.data.heartbeat?.sourcePath === sourcePath) {
        this.connectionError = String(error);
      }
    } finally {
      if (this.threadId === threadId) this.heartbeatBusy = false;
    }
  }

  private renderHeartbeatHistory(heartbeat: TaskPanelHeartbeat) {
    const history =
      this.heartbeatHistorySource === heartbeat.sourcePath ? this.heartbeatHistory : null;
    const wakes = history?.wakes ?? [...heartbeat.wakes].reverse();
    return html`<details @toggle=${(event: Event) => {
      if ((event.target as HTMLDetailsElement).open && !history && !this.heartbeatBusy) {
        void this.loadHeartbeatHistory();
      }
    }}><summary>${this.t("Heartbeat history", "心跳历史")} (${history?.total ?? heartbeat.wakeCount ?? heartbeat.wakes.length})</summary>
      ${wakes.map(
        (wake) =>
          html`<div class="event"><strong>${String(wake.heading ?? this.date(wake.timeMs))}</strong>${typeof wake.line === "number" ? html`<div class="muted">${this.t("Source line", "来源行号")} ${wake.line}</div>` : nothing}${
            Array.isArray(wake.rows)
              ? wake.rows.map((raw) => {
                  const row = raw as Record<string, unknown>;
                  return html`<p class="muted">${String(row.category ?? "")} · ${String(row.state ?? "")}</p>`;
                })
              : nothing
          }</div>`,
      )}
      ${history?.nextCursor ? html`<button ?disabled=${this.heartbeatBusy} @click=${() => void this.loadHeartbeatHistory(true)}>${this.t("Load older heartbeats", "加载更早心跳")}</button>` : nothing}
      ${!history && heartbeat.wakesTruncated ? html`<p class="muted">${this.t("Recent records shown; load history to browse older audits.", "当前仅展示近期记录，可分页查看更早巡检。")}</p>` : nothing}
      <button ?disabled=${this.heartbeatBusy} @click=${() => void this.loadHeartbeatHistory()}>${this.heartbeatBusy ? this.t("Loading…", "加载中…") : this.t("Refresh heartbeat history", "刷新心跳历史")}</button>
    </details>`;
  }

  private evidence(items: readonly TaskPanelEvidence[]) {
    return items.map(
      (item) =>
        html`<div class="evidence"><strong>${item.verification === "verified" ? this.t("Verified", "实际验证") : this.t("Reported", "模型报告")}</strong> · ${item.summary}${item.reference ? html`<div>${item.reference}</div>` : nothing}</div>`,
    );
  }

  private objective(objective: TaskPanelObjective) {
    const effective = objective.items.length
      ? objective.items.filter((item) => item.status !== "cancelled")
      : [objective];
    const done = effective.filter((item) => item.status === "completed").length;
    const displayedStatus =
      objective.status === "cancelled" || objective.items.length === 0 || effective.length === 0
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
    const selected = this.selectedObjective === objective.id;
    return html`<button class="row" aria-expanded=${selected} @click=${() => {
      this.selectedObjective = selected ? null : objective.id;
    }}><span>${selected ? "▾" : "▸"}</span><span class="name">${objective.title}${!objective.required ? html` <span class="muted">${this.t("optional", "可选")}</span>` : nothing}</span><span class="muted">${done}/${effective.length}</span><span class="status">${this.status(displayedStatus)}</span></button>
      ${selected ? html`<div class="detail">${this.evidence(objective.evidence)}${objective.items.map((item) => html`<div class="check"><div><span>${item.status === "completed" ? "✓" : item.status === "cancelled" ? "−" : "○"}</span><span>${item.title}</span><span class="muted">${this.status(item.status)}</span></div>${this.evidence(item.evidence)}</div>`)}</div>` : nothing}`;
  }

  private renderHeartbeat() {
    const heartbeat = this.data.heartbeat;
    if (!heartbeat) return nothing;
    if (
      heartbeat.status === "none" ||
      heartbeat.status === "candidates" ||
      (heartbeat.status === "error" && !heartbeat.sourcePath)
    )
      return html`<div class="heartbeat"><h3>${this.t("Project heartbeat", "项目心跳")}</h3>${heartbeat.error ? this.diagnostic(this.t("Project heartbeat error", "项目心跳错误"), heartbeat.error) : heartbeat.warning ? this.diagnostic(this.t("Project heartbeat warning", "项目心跳提示"), heartbeat.warning) : html`<p class="muted">${this.t("No current project heartbeat source is available.", "当前项目没有可显示的心跳来源。")}</p>`}</div>`;
    return html`<div class="heartbeat"><h3>${this.t("Project heartbeat", "项目心跳")} <span class="status">${heartbeat.status === "stale" ? this.t("Stale", "已过期") : heartbeat.certifiesCurrent ? this.t("Current audit certified", "当前审计已认证") : this.t("Not certified", "当前未认证")}</span></h3>
      ${heartbeat.error ? this.diagnostic(this.t("Project heartbeat error", "项目心跳错误"), heartbeat.error) : nothing}
      ${heartbeat.warning ? this.diagnostic(this.t("Project heartbeat warning", "项目心跳提示"), heartbeat.warning) : nothing}
      <dl><dt>${this.t("Source path", "来源路径")}</dt><dd>${heartbeat.sourcePath}</dd><dt>${this.t("Access", "访问方式")}</dt><dd>${this.t("Read only", "只读")}</dd>${heartbeat.basis ? html`<dt>${this.t("Source basis", "来源依据")}</dt><dd>${this.heartbeatBasisLabel(heartbeat.basis)}</dd>` : nothing}<dt>${this.t("Latest heartbeat record", "最近心跳记录")}</dt><dd>${this.date(heartbeat.lastWakeAt)}</dd>${heartbeat.nextWakeAt ? html`<dt>${this.t("Expected next audit", "预期下次巡检")}</dt><dd>${this.date(heartbeat.nextWakeAt)}</dd>` : nothing}<dt>${this.t("Ledger modified", "台账更新时间")}</dt><dd>${this.date(heartbeat.modifiedAt)}</dd><dt>${this.t("Refreshed", "刷新时间")}</dt><dd>${this.date(heartbeat.refreshedAt)}</dd><dt>${this.t("Items", "登记项")}</dt><dd>${heartbeat.itemCount ?? heartbeat.items.length} · ${
        heartbeat.itemStatusCounts
          ? Object.entries(heartbeat.itemStatusCounts)
              .map(([status, count]) => `${this.status(status)} ${count}`)
              .join(" · ")
          : this.itemSummary(heartbeat.items)
      }${heartbeat.itemsTruncated && !heartbeat.itemStatusCounts ? this.t(" (counts from visible sample)", "（状态统计为当前样本）") : nothing}</dd></dl>
      ${heartbeat.findings.length ? html`<details><summary>${this.t("Audit findings", "审计结果")} (${heartbeat.findings.length})</summary>${heartbeat.findings.map((finding) => html`<p class="muted">${finding.severity}: ${finding.message}</p>`)}</details>` : nothing}
      <details><summary>${this.t("Items and blockers", "登记项与阻塞")}</summary>${heartbeat.items.map((item) => html`<div class="event"><span class="status">${String(item.status ?? "")}</span> ${String(item.item ?? item.id ?? "")}<p class="muted">${String(item.evidence ?? "")}</p></div>`)}</details>
      ${this.renderHeartbeatHistory(heartbeat)}
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
    const showProgressBar =
      progress &&
      progress.percent !== null &&
      (!checklistComplete || this.data.execution?.state === "idle");
    const countedPercent = progress?.percent ?? 0;
    const checklistTitle = `${this.t("Registered checklist", "已登记清单")}: ${title}`;
    return html`<section class="panel" aria-label=${this.t("Task progress", "任务进度")}><div class="summary">${this.floating ? html`<span class="grip" title=${this.t("Drag panel", "拖动面板")} @pointerdown=${(event: PointerEvent) => this.dispatchEvent(new CustomEvent("task-progress-drag", { detail: { x: event.clientX, y: event.clientY }, bubbles: true, composed: true }))}>⠿</span>` : nothing}<button class="main" aria-expanded=${this.expanded} @click=${this.toggleExpanded}><span class="title">${this.expanded ? "▾" : "▸"} ${title}</span><span class="muted">${this.checklistLabel()} · <span class="execution" data-execution-state=${this.data.execution?.state ?? "unknown"}>${this.executionLabel(checklistComplete)}</span></span>${showProgressBar ? html`<div class="track" role="progressbar" aria-valuenow=${countedPercent} aria-valuemin="0" aria-valuemax="100" aria-label=${checklistTitle} aria-valuetext=${this.checklistLabel()}><div class="fill" style=${`width:${Math.max(0, Math.min(100, countedPercent))}%`}></div></div>` : nothing}</button><button title=${this.floating ? this.t("Dock at top of chat", "固定在聊天顶部") : this.t("Float panel", "浮动面板")} aria-label=${this.floating ? this.t("Dock panel", "固定面板") : this.t("Float panel", "浮动面板")} @click=${this.toggleFloating}>${this.floating ? "↙" : "↗"}</button></div><div class="sr-status" role="status" aria-live="polite" aria-atomic="true">${this.connectionError ? this.t("Checklist unavailable", "清单暂不可用") : ""}</div>${
      this.expanded
        ? html`<div class="body"><nav role="tablist"><button role="tab" aria-selected=${this.tab === "tasks"} @click=${() => {
            this.tab = "tasks";
          }}>${this.t("Subtasks", "子任务")}</button><button role="tab" aria-selected=${this.tab === "history"} @click=${() => {
            this.tab = "history";
            void this.loadHistory();
          }}>${this.t("History", "历史")}</button></nav><div class="scroll" role="tabpanel">${this.connectionError ? this.diagnostic(this.t("Connection error details", "连接错误详情"), this.connectionError) : nothing}${this.tab === "history" ? this.renderHistory() : html`${task?.objectives.length ? task.objectives.map((objective) => this.objective(objective)) : html`<p class="empty">${this.data.taskSource?.status === "stale" || this.data.taskSource?.status === "error" || this.data.taskSource?.status === "pending-selection" ? this.checklistLabel() : !this.observed ? this.checklistLabel() : this.threadId ? this.t("A checklist appears when work is registered. Questions do not create tasks.", "登记实施需求后展示清单，普通问答不会创建任务。") : this.t("Waiting for this chat’s identity…", "等待此聊天的身份确认…")}</p>`}${this.renderTaskSource()}${this.renderHeartbeat()}`}</div></div>`
        : nothing
    }</section>`;
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
