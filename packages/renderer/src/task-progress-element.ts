import { css, html, LitElement, nothing } from "lit";

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
}
export interface TaskPanelHeartbeat {
  status: "candidates" | "ready" | "stale" | "error";
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
  findings: readonly { severity: string; message: string; rule?: string }[];
  error?: string;
}
export interface TaskPanelHistory {
  events: readonly Record<string, unknown>[];
  nextCursor: string | null;
}
export interface TaskPanelResponse {
  task: TaskPanelState | null;
  heartbeat: TaskPanelHeartbeat | null;
  history?: TaskPanelHistory;
}
export interface TaskPanelRequest {
  method: "get" | "history" | "bind-heartbeat";
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
    threadId: { attribute: false },
    requester: { attribute: false },
    connectionError: { attribute: false },
    expanded: { state: true },
    tab: { state: true },
    selectedObjective: { state: true },
    history: { state: true },
    busy: { state: true },
    floating: { type: Boolean, reflect: true },
    locale: { attribute: false },
  };

  static override styles = css`
    :host { display: block; font: inherit; color: var(--ctp-text, #222); color-scheme: light dark; }
    * { box-sizing: border-box; }
    section.panel { max-height: var(--ctp-panel-max-height, calc(100vh - 24px)); border: 1px solid var(--ctp-border, #ddd); border-radius: 12px; background: var(--ctp-surface, #fff); box-shadow: 0 3px 16px #00000012; overflow: hidden; }
    button, select { font: inherit; color: inherit; }
    button { cursor: pointer; border: 0; border-radius: 6px; background: transparent; padding: .35em .6em; }
    button:hover { background: var(--ctp-hover, #88888815); }
    button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--ctp-accent, #2977d4); outline-offset: -2px; }
    button:disabled { opacity: .55; cursor: default; }
    .summary { display: flex; align-items: center; min-height: 36px; gap: 6px; padding: 3px 7px; }
    .main { flex: 1; display: grid; grid-template-columns: minmax(70px, 1fr) auto; align-items: center; text-align: start; gap: 2px 12px; min-width: 0; }
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: var(--ctp-muted, #707070); font-size: .88em; }
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
    select { max-width: 100%; padding: 6px; border: 1px solid var(--ctp-border, #ddd); border-radius: 6px; background: var(--ctp-surface, #fff); }
    .event { border-bottom: 1px solid var(--ctp-border, #ddd); padding: 7px 0; overflow-wrap: anywhere; }
    .event p { margin: 3px 0; } .error { color: var(--ctp-error, #bd4d3a); font-size: .88em; padding: 5px 10px; overflow-wrap: anywhere; }
    .grip { cursor: move; touch-action: none; user-select: none; color: var(--ctp-muted, #707070); }
    details { margin-top: 7px; } summary { cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
  `;

  declare data: TaskPanelResponse;
  declare threadId: string | null;
  declare requester: TaskPanelRequester | null;
  declare connectionError: string | null;
  declare expanded: boolean;
  declare floating: boolean;
  declare locale: string;
  private declare tab: "tasks" | "history";
  private declare selectedObjective: string | null;
  private declare history: TaskPanelHistory | null;
  private declare busy: boolean;
  private historyThread: string | null = null;

  constructor() {
    super();
    this.data = { task: null, heartbeat: null };
    this.threadId = null;
    this.requester = null;
    this.connectionError = null;
    this.expanded = persisted("expanded") === "true";
    this.floating = persisted("floating") === "true";
    this.locale = "en";
    this.tab = "tasks";
    this.selectedObjective = null;
    this.history = null;
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
    this.history = null;
    this.historyThread = null;
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
    this.busy = true;
    try {
      const cursor = more ? this.history?.nextCursor : null;
      const result = await this.requester({
        method: "history",
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      if (this.threadId !== threadId) return;
      this.history = result.history
        ? {
            events: more
              ? [...(this.history?.events ?? []), ...result.history.events]
              : result.history.events,
            nextCursor: result.history.nextCursor,
          }
        : { events: [], nextCursor: null };
      this.historyThread = threadId;
    } catch (error) {
      if (this.threadId === threadId) this.connectionError = String(error);
    } finally {
      if (this.threadId === threadId) this.busy = false;
    }
  }

  private async bindHeartbeat(path: string | null): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || !this.requester || this.busy) return;
    this.busy = true;
    try {
      const result = await this.requester({ method: "bind-heartbeat", threadId, path });
      if (this.threadId === threadId) this.data = result;
    } catch (error) {
      if (this.threadId === threadId) this.connectionError = String(error);
    } finally {
      if (this.threadId === threadId) this.busy = false;
    }
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
    const selected = this.selectedObjective === objective.id;
    return html`<button class="row" aria-expanded=${selected} @click=${() => {
      this.selectedObjective = selected ? null : objective.id;
    }}><span>${selected ? "▾" : "▸"}</span><span class="name">${objective.title}${!objective.required ? html` <span class="muted">${this.t("optional", "可选")}</span>` : nothing}</span><span class="muted">${done}/${effective.length}</span><span class="status">${this.status(objective.status)}</span></button>
      ${selected ? html`<div class="detail">${this.evidence(objective.evidence)}${objective.items.map((item) => html`<div class="check"><div><span>${item.status === "completed" ? "✓" : item.status === "cancelled" ? "−" : "○"}</span><span>${item.title}</span><span class="muted">${this.status(item.status)}</span></div>${this.evidence(item.evidence)}</div>`)}</div>` : nothing}`;
  }

  private renderHeartbeat() {
    const heartbeat = this.data.heartbeat;
    if (!heartbeat) return nothing;
    if (heartbeat.status === "candidates")
      return html`<div class="heartbeat"><h3>${this.t("Heartbeat source", "心跳来源")}</h3><p class="muted">${this.t("Choose the ledger associated with this chat.", "请选择与此聊天关联的心跳台账。")}</p><select aria-label=${this.t("Heartbeat ledger", "心跳台账")} ?disabled=${this.busy} @change=${(
        event: Event,
      ) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value) void this.bindHeartbeat(value);
      }}><option value="">${this.t("Select a ledger…", "选择台账…")}</option>${heartbeat.candidates.map((candidate) => html`<option value=${candidate.path}>${candidate.path}</option>`)}</select><button @click=${() => void this.bindHeartbeat(null)}>${this.t("Hide", "隐藏")}</button></div>`;
    return html`<div class="heartbeat"><h3>${this.t("Heartbeat", "心跳")} <span class="status">${heartbeat.status === "stale" ? this.t("Stale", "已过期") : heartbeat.certifiesCurrent ? this.t("Current audit certified", "当前审计已认证") : this.t("Not certified", "当前未认证")}</span></h3>
      ${heartbeat.error ? html`<p class="error">${heartbeat.error}</p>` : nothing}
      <dl><dt>${this.t("Latest audit", "最近巡检")}</dt><dd>${this.date(heartbeat.lastWakeAt)}</dd>${heartbeat.nextWakeAt ? html`<dt>${this.t("Expected next audit", "预期下次巡检")}</dt><dd>${this.date(heartbeat.nextWakeAt)}</dd>` : nothing}<dt>${this.t("Ledger modified", "台账更新时间")}</dt><dd>${this.date(heartbeat.modifiedAt)}</dd><dt>${this.t("Refreshed", "刷新时间")}</dt><dd>${this.date(heartbeat.refreshedAt)}</dd><dt>${this.t("Items", "登记项")}</dt><dd>${heartbeat.items.length} · ${this.itemSummary(heartbeat.items)}</dd></dl>
      ${heartbeat.findings.length ? html`<details><summary>${this.t("Audit findings", "审计结果")} (${heartbeat.findings.length})</summary>${heartbeat.findings.map((finding) => html`<p class="muted">${finding.severity}: ${finding.message}</p>`)}</details>` : nothing}
      <details><summary>${this.t("Items and blockers", "登记项与阻塞")}</summary>${heartbeat.items.map((item) => html`<div class="event"><span class="status">${String(item.status ?? "")}</span> ${String(item.item ?? item.id ?? "")}<p class="muted">${String(item.evidence ?? "")}</p></div>`)}</details>
      <details><summary>${this.t("Heartbeat history", "心跳历史")} (${heartbeat.wakes.length})</summary>${[
        ...heartbeat.wakes,
      ]
        .reverse()
        .map(
          (wake) =>
            html`<div class="event"><strong>${String(wake.heading ?? this.date(wake.timeMs))}</strong>${
              Array.isArray(wake.rows)
                ? wake.rows.map((raw) => {
                    const row = raw as Record<string, unknown>;
                    return html`<p class="muted">${String(row.category ?? "")} · ${String(row.state ?? "")}</p>`;
                  })
                : nothing
            }</div>`,
        )}</details>
      <details><summary class="muted">${this.t("Source", "来源")}</summary><p class="muted">${heartbeat.sourcePath}</p><button ?disabled=${this.busy} @click=${() => void this.bindHeartbeat(null)}>${this.t("Unbind and hide heartbeat", "解除关联并隐藏心跳")}</button></details>
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

  private renderHistory() {
    if (this.historyThread !== this.threadId && !this.busy) void this.loadHistory();
    return html`${(this.history?.events ?? []).map((event) => html`<div class="event"><span class="muted">${this.date(event.occurredAt ?? event.at)}</span><p>${String(event.reason ?? event.type ?? "")}</p>${event.before && event.after ? html`<span class="muted">${this.progressText(event.before)} → ${this.progressText(event.after)}</span>` : nothing}</div>`)}${!this.history?.events.length ? html`<p class="empty">${this.busy ? this.t("Loading…", "加载中…") : this.t("No recorded changes yet.", "暂无变更记录。")}</p>` : nothing}${this.history?.nextCursor ? html`<button ?disabled=${this.busy} @click=${() => void this.loadHistory(true)}>${this.t("Load more", "加载更多")}</button>` : nothing}<button ?disabled=${this.busy} @click=${() => void this.loadHistory()}>${this.t("Refresh", "刷新")}</button>`;
  }

  private progressText(value: unknown): string {
    if (!value || typeof value !== "object") return "—";
    const progress = value as Record<string, unknown>;
    return `${String(progress.completed ?? 0)}/${String(progress.total ?? 0)}${typeof progress.percent === "number" ? ` (${progress.percent}%)` : ""}`;
  }

  protected override render() {
    const task = this.data.task;
    const progress = task?.progress;
    const title = task?.title ?? this.t("Task progress", "任务进度");
    return html`<section class="panel" aria-label=${this.t("Task progress", "任务进度")}><div class="summary">${this.floating ? html`<span class="grip" title=${this.t("Drag panel", "拖动面板")} @pointerdown=${(event: PointerEvent) => this.dispatchEvent(new CustomEvent("task-progress-drag", { detail: { x: event.clientX, y: event.clientY }, bubbles: true, composed: true }))}>⠿</span>` : nothing}<button class="main" aria-expanded=${this.expanded} @click=${this.toggleExpanded}><span class="title">${this.expanded ? "▾" : "▸"} ${title}</span><span class="muted">${progress && progress.percent !== null ? `${progress.completed}/${progress.total} · ${progress.percent}%` : this.t("No task checklist", "尚未建立任务")}</span>${progress && progress.percent !== null ? html`<div class="track" role="progressbar" aria-valuenow=${progress.percent} aria-valuemin="0" aria-valuemax="100" aria-label=${title}><div class="fill" style=${`width:${Math.max(0, Math.min(100, progress.percent))}%`}></div></div>` : nothing}</button><button title=${this.floating ? this.t("Dock above composer", "固定在输入框上方") : this.t("Float panel", "浮动面板")} aria-label=${this.floating ? this.t("Dock panel", "固定面板") : this.t("Float panel", "浮动面板")} @click=${this.toggleFloating}>${this.floating ? "↙" : "↗"}</button></div>${this.connectionError ? html`<div role="status" class="error">${this.connectionError}</div>` : nothing}${
      this.expanded
        ? html`<div class="body"><nav role="tablist"><button role="tab" aria-selected=${this.tab === "tasks"} @click=${() => {
            this.tab = "tasks";
          }}>${this.t("Subtasks", "子任务")}</button><button role="tab" aria-selected=${this.tab === "history"} @click=${() => {
            this.tab = "history";
            void this.loadHistory();
          }}>${this.t("History", "历史")}</button></nav><div class="scroll" role="tabpanel">${this.tab === "history" ? this.renderHistory() : html`${task?.objectives.length ? task.objectives.map((objective) => this.objective(objective)) : html`<p class="empty">${this.threadId ? this.t("A checklist appears when work is registered. Questions do not create tasks.", "登记实施需求后展示清单，普通问答不会创建任务。") : this.t("Waiting for this chat’s identity…", "等待此聊天的身份确认…")}</p>`}${this.renderHeartbeat()}`}</div></div>`
        : nothing
    }</section>`;
  }
}

export function registerTaskProgressElement(window: Window): void {
  if (!window.customElements.get(TASK_PROGRESS_ELEMENT_NAME)) {
    window.customElements.define(TASK_PROGRESS_ELEMENT_NAME, TaskProgressElement);
  }
}
