import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/release-version.js";
import { TASK_PROGRESS_REQUEST_TIMEOUT_MS } from "../../contracts/src/task-request-policy.js";
import {
  registerTaskProgressElement,
  type TaskPanelRequest,
  type TaskPanelResponse,
  type TaskPanelViewState,
} from "./task-progress-element.js";

type ToolEnvelope =
  | { ok: true; result: TaskPanelResponse }
  | { ok: false; code?: string; summary?: string };
type PanelElement = HTMLElement & {
  data: TaskPanelResponse;
  observed: boolean;
  threadId: string | null;
  requester: (request: TaskPanelRequest) => Promise<TaskPanelResponse>;
  refreshTask: (() => Promise<void>) | null;
  refreshing: boolean;
  connectionError: string | null;
  locale: string;
  presentation: "panel";
  resetThread(threadId: string | null): void;
  captureViewState(): TaskPanelViewState | null;
  restoreViewState(state: TaskPanelViewState): void;
};

const READ_ONLY_TOOL_NAMES: Partial<Record<TaskPanelRequest["method"], string>> = {
  get: "task_progress_get",
  history: "task_progress_history",
  archive: "task_progress_archive",
  "heartbeat-history": "task_progress_heartbeat_history",
};

function envelope(result: unknown): ToolEnvelope | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === "object") {
    const structured = record.structuredContent as Record<string, unknown>;
    if (structured.ok === true && structured.result && typeof structured.result === "object") {
      return structured as ToolEnvelope;
    }
    if (structured.ok === false) return structured as ToolEnvelope;
  }
  for (const block of Array.isArray(record.content) ? record.content : []) {
    if (!block || typeof block !== "object") continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") continue;
      const parsedRecord = parsed as Record<string, unknown>;
      if (
        parsedRecord.ok === true &&
        parsedRecord.result &&
        typeof parsedRecord.result === "object"
      ) {
        return parsed as ToolEnvelope;
      }
      if (parsedRecord.ok === false) return parsed as ToolEnvelope;
    } catch {
      // Non-JSON tool messages are surfaced below as a generic connection error.
    }
  }
  return null;
}

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.locale) element.locale = context.locale;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  // Keep the panel's progress tone on its foreground token even if the host
  // includes a branded --ctp-accent in its style variables.
  element.style.setProperty("--ctp-accent", "var(--ctp-text)");
  const shell = document.getElementById("native-panel-shell");
  if (shell && context.safeAreaInsets) {
    shell.style.setProperty("--safe-top", `${context.safeAreaInsets.top}px`);
    shell.style.setProperty("--safe-right", `${context.safeAreaInsets.right}px`);
    shell.style.setProperty("--safe-bottom", `${context.safeAreaInsets.bottom}px`);
    shell.style.setProperty("--safe-left", `${context.safeAreaInsets.left}px`);
  }
}

function trustedThreadId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const meta = (result as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return null;
  const threadId = (meta as Record<string, unknown>)["codex-task-progress/threadId"];
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

function showError(message: string): void {
  const status = document.getElementById("native-panel-error");
  const retry = document.getElementById("native-panel-retry");
  if (status) {
    status.hidden = !message;
    status.textContent = message;
  }
  if (retry) retry.toggleAttribute("hidden", !message);
}

const elementName = registerTaskProgressElement(window);
const element = document.createElement(elementName) as PanelElement;
element.presentation = "panel";
element.setAttribute("data-task-progress-version", GOAL_PROGRESS_RELEASE_VERSION);
element.setAttribute("presentation", "panel");
element.locale = navigator.language || "en";
element.data = { task: null, heartbeat: null };
element.observed = false;
element.refreshTask = null;
element.refreshing = false;
document.getElementById("native-panel-shell")?.append(element);

const app = new App(
  { name: "Codex Task Progress Panel", version: GOAL_PROGRESS_RELEASE_VERSION },
  {},
  { autoResize: true, strict: true },
);
let connected = false;
let disposed = false;
let refreshSequence = 0;
let identityGeneration = 0;
// Once trust has been revoked, unordered host pushes cannot prove they were
// produced after revocation. Only a new native read may update the panel.
let hostPushRequiresRead = false;
let busy = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const pendingDelays = [150, 250, 500, 1_000];
let pendingAttempts = 0;

type Presentation = {
  scope: string;
  pending: boolean;
  cached: boolean;
  updatedAt: number | null;
  error?: string;
};
type ScopedResponse = TaskPanelResponse & { presentation?: Presentation };
type RetainedView = { data: TaskPanelResponse; view: TaskPanelViewState | null; bytes: number };
const retained = new Map<string, RetainedView>();
const MAX_VIEWS = 16;
const MAX_BYTES = 4 * 1024 * 1024;
let activeScope: string | null = null;
let activeKey: string | null = null;

function scopeOf(response: TaskPanelResponse): string | null {
  const scope = (response as ScopedResponse).presentation?.scope;
  return typeof scope === "string" && scope.length > 0 ? scope : null;
}
function cacheKey(threadId: string | null, scope: string | null): string | null {
  return threadId && scope ? JSON.stringify([threadId, scope]) : null;
}
function rememberCurrent(): void {
  if (!activeKey || !element.observed || element.data.enabled === false || element.connectionError)
    return;
  const presentation = (element.data as ScopedResponse).presentation;
  if (
    presentation?.error ||
    (presentation?.pending && !element.data.task && !element.data.heartbeat)
  )
    return;
  const view = element.captureViewState();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ data: element.data, view })).byteLength;
    if (bytes > MAX_BYTES) {
      retained.delete(activeKey);
      return;
    }
    retained.delete(activeKey);
    retained.set(activeKey, {
      data: structuredClone(element.data),
      view: structuredClone(view),
      bytes,
    });
    let total = Array.from(retained.values()).reduce((sum, item) => sum + item.bytes, 0);
    while (retained.size > MAX_VIEWS || total > MAX_BYTES) {
      const oldest = retained.entries().next();
      if (oldest.done) break;
      const [key, entry] = oldest.value;
      total -= entry.bytes;
      retained.delete(key);
    }
  } catch {
    retained.delete(activeKey);
  }
}
function clearPresentationAttributes(): void {
  element.removeAttribute("data-presentation-cached");
  element.removeAttribute("data-presentation-pending");
  element.removeAttribute("data-presentation-updated-at");
}
function invalidateIdentity(): void {
  hostPushRequiresRead = true;
  clearPresentationAttributes();
  retained.clear();
  invalidatePendingRefresh();
  for (const active of activeToolControllers) active.abort();
  setIdentity(null, null, false);
  element.data = { task: null, heartbeat: null };
  element.observed = true;
}
class IdentityError extends Error {}
function isIdentityFailure(message: string): boolean {
  return /identity|unauthori[sz]ed|forbidden|authentication|access denied|disabled/i.test(message);
}
function failureInvalidatesIdentity(
  failure: Extract<ToolEnvelope, { ok: false }>,
  raw: unknown,
  expectedThread: string | null,
): boolean {
  const code = typeof failure.code === "string" ? failure.code : "";
  return (
    /(?:IDENTITY|THREAD|AUTH|UNTRUSTED|METADATA|HOOK_CONTEXT|HOOK_PROOF|DISABLED|FORBIDDEN)/i.test(
      code,
    ) ||
    isIdentityFailure(failure.summary ?? "") ||
    !expectedThread ||
    trustedThreadId(raw) !== expectedThread
  );
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(response?: TaskPanelResponse): void {
  clearTimer();
  if (disposed || !connected || document.visibilityState !== "visible") return;
  const pending =
    response?.heartbeatPending === true ||
    response?.taskSourcePending === true ||
    response?.subagents?.status === "pending" ||
    response?.subagents?.status === "partial" ||
    (response as ScopedResponse | undefined)?.presentation?.pending === true;
  const delay = pending ? (pendingDelays[pendingAttempts++] ?? 5_000) : 5_000;
  if (!pending) pendingAttempts = 0;
  timer = setTimeout(() => {
    timer = null;
    void refresh(response?.subagents?.status === "partial");
  }, delay);
}
let controller: AbortController | null = null;
const activeToolControllers = new Set<AbortController>();

function dispose(): void {
  if (disposed) return;
  disposed = true;
  refreshSequence++;
  identityGeneration++;
  busy = false;
  element.refreshing = false;
  controller?.abort();
  controller = null;
  for (const active of activeToolControllers) active.abort();
  activeToolControllers.clear();
  clearTimer();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  app.ontoolresult = undefined;
  app.onhostcontextchanged = undefined;
  app.onerror = () => {};
  app.onteardown = undefined;
  element.remove();
}

function setIdentity(threadId: string | null, scope: string | null, capture = true): boolean {
  if (element.threadId === threadId && activeScope === scope) return false;
  if (capture) rememberCurrent();
  clearPresentationAttributes();
  identityGeneration++;
  refreshSequence++;
  pendingAttempts = 0;
  clearTimer();
  controller?.abort();
  controller = null;
  for (const active of activeToolControllers) active.abort();
  busy = false;
  element.refreshing = false;
  activeScope = scope;
  activeKey = cacheKey(threadId, scope);
  element.resetThread(threadId);
  return true;
}

// Local task revisions are global to a verified thread and scope, including
// lifecycle changes. Bound-source projections have independent versioning.
function taskRecord(response: TaskPanelResponse): string | null {
  if (!response.task) return null;
  return JSON.stringify([
    response.task.source?.path ?? null,
    response.taskSource?.path ?? null,
    response.taskSource?.status ?? null,
    response.task.lifecycle?.id ?? null,
  ]);
}
function isOlderTask(response: TaskPanelResponse, current: TaskPanelResponse): boolean {
  const incoming = response.task?.revision;
  const existing = current.task?.revision;
  return (
    activeScope !== null &&
    scopeOf(response) === activeScope &&
    scopeOf(current) === activeScope &&
    !!response.task &&
    !!current.task &&
    !response.task.source?.path &&
    !response.taskSource?.path &&
    !current.task.source?.path &&
    !current.taskSource?.path &&
    typeof incoming === "number" &&
    Number.isFinite(incoming) &&
    typeof existing === "number" &&
    Number.isFinite(existing) &&
    incoming < existing
  );
}
// Old model-side tool results can omit agent metadata. Retain it only when
// both complete task identities prove the same conversation and task source.
function retainMissingAgents(
  response: TaskPanelResponse,
  current: TaskPanelResponse,
  threadId: string,
): TaskPanelResponse {
  if (
    (Object.hasOwn(response, "subagents") &&
      response.subagents?.status !== "pending" &&
      !(
        response.subagents?.status === "partial" &&
        !response.subagents.complete &&
        response.subagents.agents.length === 0 &&
        !!current.subagents?.agents.length
      )) ||
    (response.subagents?.taskCycleId !== undefined &&
      response.subagents.taskCycleId !== current.subagents?.taskCycleId) ||
    (response.subagents?.taskSourcePath !== undefined &&
      response.subagents.taskSourcePath !== current.subagents?.taskSourcePath) ||
    response.enabled === false ||
    (response as ScopedResponse).presentation?.error ||
    !scopeOf(response) ||
    scopeOf(response) !== scopeOf(current) ||
    !response.task ||
    !current.task ||
    response.task.threadId !== threadId ||
    current.task.threadId !== threadId ||
    !current.subagents ||
    current.subagents.parentThreadId !== threadId ||
    !["ready", "partial"].includes(current.subagents.status) ||
    typeof current.subagents.observedAt !== "string" ||
    !Number.isFinite(Date.parse(current.subagents.observedAt)) ||
    Date.parse(current.subagents.observedAt) > Date.now() ||
    (current.subagents.scopeBasis !== "parent-thread" &&
      (current.subagents.scopeBasis !== "parent-root-turn" ||
        !current.subagents.rootTurnId?.trim() ||
        !current.subagents.rootTurnStartedAt ||
        !Number.isFinite(Date.parse(current.subagents.rootTurnStartedAt)) ||
        Date.parse(current.subagents.rootTurnStartedAt) > Date.parse(current.subagents.observedAt)))
  )
    return response;
  const incomingCycle = response.task.lifecycle?.id;
  const currentCycle = current.task.lifecycle?.id;
  const sameCycle =
    !!incomingCycle &&
    incomingCycle === currentCycle &&
    current.subagents.taskCycleId === incomingCycle &&
    response.task.lifecycle?.startedAt === current.task.lifecycle?.startedAt &&
    (response.task.source?.path ?? null) === (current.task.source?.path ?? null);
  const incomingSource = response.taskSource;
  const currentSource = current.taskSource;
  const sameSource =
    !incomingCycle &&
    !currentCycle &&
    incomingSource?.status === "ready" &&
    currentSource?.status === "ready" &&
    !!incomingSource.path &&
    incomingSource.path === currentSource.path &&
    response.task.source?.kind === "kit-heartbeat" &&
    response.task.source.readOnly === true &&
    response.task.source.path === incomingSource.path &&
    !!incomingSource.contentHash &&
    response.task.source.contentHash === incomingSource.contentHash &&
    current.task.source?.kind === "kit-heartbeat" &&
    current.task.source.readOnly === true &&
    current.task.source.path === incomingSource.path &&
    !!currentSource.contentHash &&
    current.task.source.contentHash === currentSource.contentHash &&
    current.subagents.taskCycleId === null &&
    current.subagents.taskSourcePath === incomingSource.path;
  if (!sameCycle && !sameSource) return response;
  const revisionChanged =
    response.task.revision !== current.task.revision ||
    response.task.source?.contentHash !== current.task.source?.contentHash;
  if (!revisionChanged) return { ...response, subagents: current.subagents };
  // Assignment and allocation are tied to a specific task revision. Keep the
  // independently observed membership while the native GET recomputes them.
  const agents = current.subagents.agents.map((agent) => ({
    ...agent,
    assignmentTitle: null,
    progress: null,
    progressBasis: null,
    progressGranularity: "none" as const,
  }));
  const { allocation: _allocation, ...membership } = current.subagents;
  return { ...response, subagents: { ...membership, agents } };
}
function taskVersion(response: TaskPanelResponse): string {
  return JSON.stringify([taskRecord(response), response.task?.revision ?? null]);
}

function applyVerifiedResponse(response: TaskPanelResponse, threadId: string): void {
  const scope = scopeOf(response);
  if (response.enabled === false) {
    hostPushRequiresRead = true;
    retained.clear();
    invalidatePendingRefresh();
    for (const active of activeToolControllers) active.abort();
    if (!setIdentity(threadId, scope, false)) element.resetThread(threadId);
    clearPresentationAttributes();
    element.data = response;
    element.observed = true;
    element.connectionError = null;
    showError("");
    return;
  }
  const changed = setIdentity(threadId, scope);
  const presentation = (response as ScopedResponse).presentation;
  clearPresentationAttributes();
  if (presentation) {
    element.setAttribute("data-presentation-cached", String(presentation.cached === true));
    element.setAttribute("data-presentation-pending", String(presentation.pending === true));
    if (typeof presentation.updatedAt === "number" && Number.isFinite(presentation.updatedAt)) {
      element.setAttribute("data-presentation-updated-at", String(presentation.updatedAt));
    }
  }
  const saved = activeKey ? retained.get(activeKey) : undefined;
  const emptyPending = presentation?.pending && !response.task && !response.heartbeat;
  const emptyError = presentation?.error && !response.task && !response.heartbeat;
  const previous =
    !changed && element.observed && element.data.enabled !== false ? element.data : null;
  const fallback = saved?.data ?? previous;
  element.data = (emptyPending || emptyError) && fallback ? fallback : response;
  element.observed = true;
  // Data setters may reset view state, so restore only after installing base data.
  if (changed && saved?.view) element.restoreViewState(saved.view);
  const message = presentation?.error ?? "";
  element.connectionError = message || null;
  showError(message);
  if (!presentation?.error && !(emptyPending && fallback)) rememberCurrent();
}

function invalidatePendingRefresh(): void {
  refreshSequence++;
  controller?.abort();
  controller = null;
  busy = false;
  element.refreshing = false;
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void refresh();
  else {
    clearTimer();
    invalidatePendingRefresh();
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  if (!connected || disposed) throw new Error("MCP Apps connection is unavailable.");
  const requestController = new AbortController();
  activeToolControllers.add(requestController);
  const timeout = AbortSignal.timeout(TASK_PROGRESS_REQUEST_TIMEOUT_MS);
  const signals = [requestController.signal, timeout];
  if (signal) signals.push(signal);
  try {
    return await app.callServerTool(
      { name, arguments: args },
      { signal: AbortSignal.any(signals) },
    );
  } finally {
    activeToolControllers.delete(requestController);
  }
}

async function readTaskResponse(
  signal: AbortSignal,
): Promise<{ response: TaskPanelResponse; threadId: string }> {
  const raw = await callTool("task_progress_get", {}, signal);
  const parsed = envelope(raw);
  if (!parsed) throw new Error("Task progress returned an unreadable response.");
  if (!parsed.ok) {
    const summary =
      typeof parsed.summary === "string" ? parsed.summary : "Task progress is unavailable.";
    throw failureInvalidatesIdentity(parsed, raw, element.threadId)
      ? new IdentityError(summary)
      : new Error(summary);
  }
  const threadId = trustedThreadId(raw);
  if (!threadId)
    throw new IdentityError(
      "Trusted conversation identity was not returned. Reload the current task to retry.",
    );
  if (
    (parsed.result.task?.threadId && parsed.result.task.threadId !== threadId) ||
    (parsed.result.subagents && parsed.result.subagents.parentThreadId !== threadId)
  )
    throw new IdentityError(
      "Task progress identity did not match the trusted conversation. Reload the current task to retry.",
    );
  return { response: parsed.result, threadId };
}

async function refresh(silent = false): Promise<void> {
  if (disposed || busy || document.visibilityState !== "visible") return;
  clearTimer();
  busy = true;
  element.refreshing = !silent;
  const requestGeneration = ++refreshSequence;
  controller?.abort();
  controller = new AbortController();
  try {
    const { response, threadId } = await readTaskResponse(controller.signal);
    if (disposed || requestGeneration !== refreshSequence) return;
    if (
      threadId === element.threadId &&
      scopeOf(response) === activeScope &&
      isOlderTask(response, element.data)
    ) {
      schedule(element.data);
      return;
    }
    const merged =
      threadId === element.threadId
        ? retainMissingAgents(response, element.data, threadId)
        : response;
    applyVerifiedResponse(merged, threadId);
    schedule(response);
  } catch (error) {
    if (disposed || requestGeneration !== refreshSequence) return;
    const message = error instanceof Error ? error.message : "Task progress is unavailable.";
    if (error instanceof IdentityError || isIdentityFailure(message)) invalidateIdentity();
    else element.observed = true;
    element.connectionError = message;
    showError(message);
    schedule();
  } finally {
    if (requestGeneration === refreshSequence) {
      busy = false;
      element.refreshing = false;
      controller = null;
    }
  }
}

element.refreshTask = refresh;

element.requester = async (request: TaskPanelRequest): Promise<TaskPanelResponse> => {
  if (disposed || !element.threadId)
    throw new Error("Trusted conversation identity is unavailable.");
  const toolName = READ_ONLY_TOOL_NAMES[request.method];
  if (!toolName) throw new Error("This panel only supports read-only task requests.");
  const expectedThreadId = element.threadId;
  const expectedIdentityGeneration = identityGeneration;
  const expectedScope = activeScope;
  const args = {
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const expectedTaskVersion = taskVersion(element.data);
    const raw = await callTool(toolName, args);
    const parsed = envelope(raw);
    if (!parsed) throw new Error("Task history returned an unreadable response.");
    if (!parsed.ok) {
      const message = parsed.summary ?? "Task history is unavailable.";
      if (
        identityGeneration === expectedIdentityGeneration &&
        failureInvalidatesIdentity(parsed, raw, expectedThreadId)
      ) {
        invalidateIdentity();
        element.connectionError = message;
        showError(message);
        schedule();
      }
      throw new Error(message);
    }
    if (
      identityGeneration !== expectedIdentityGeneration ||
      element.threadId !== expectedThreadId ||
      trustedThreadId(raw) !== expectedThreadId ||
      (scopeOf(parsed.result) !== null && scopeOf(parsed.result) !== expectedScope) ||
      (parsed.result.task?.threadId && parsed.result.task.threadId !== expectedThreadId)
    )
      throw new Error("Task history identity changed. Refresh the panel to continue.");
    if (
      expectedTaskVersion === taskVersion(element.data) &&
      !isOlderTask(parsed.result, element.data)
    )
      return parsed.result;
    // A cursor belongs to the old task snapshot and cannot be replayed safely.
    if (request.cursor) break;
  }
  throw new Error("Task history became stale. Refresh the panel to continue.");
};

app.ontoolresult = (result) => {
  const parsed = envelope(result);
  if (parsed && !parsed.ok && failureInvalidatesIdentity(parsed, result, element.threadId)) {
    invalidateIdentity();
    element.connectionError = parsed.summary ?? "Task progress is unavailable.";
    showError(element.connectionError);
    schedule();
    return;
  }
  if (parsed?.ok) {
    // Host-delivered tool results are accepted only after the SDK validates the
    // MCP Apps protocol message; identity still comes from the tool response.
    const verifiedThreadId = trustedThreadId(result);
    if (
      !verifiedThreadId ||
      (parsed.result.task?.threadId && parsed.result.task.threadId !== verifiedThreadId) ||
      (parsed.result.subagents && parsed.result.subagents.parentThreadId !== verifiedThreadId)
    ) {
      invalidateIdentity();
      element.connectionError =
        "Trusted conversation identity was not returned or did not match. Reload the current task to retry.";
      showError(element.connectionError);
      schedule();
      return;
    }
    if (hostPushRequiresRead && parsed.result.enabled !== false) {
      void refresh();
      return;
    }
    const scope = scopeOf(parsed.result);
    // Legacy tool pushes have no scope proof. They can request a native read,
    // but cannot themselves replace any part of an already verified view.
    // Explicit identity/source changes and revocations still clear immediately.
    if (
      scope === null &&
      activeScope !== null &&
      element.threadId === verifiedThreadId &&
      parsed.result.enabled !== false &&
      !(parsed.result as ScopedResponse).presentation?.error
    ) {
      const incoming = parsed.result;
      const current = element.data;
      const sourceChanged =
        (incoming.task === null && Object.hasOwn(incoming, "task")) ||
        (incoming.taskSource === null && Object.hasOwn(incoming, "taskSource")) ||
        (incoming.task &&
          Object.hasOwn(incoming.task, "source") &&
          incoming.task.source === null &&
          !!current.task?.source) ||
        (incoming.task &&
          Object.hasOwn(incoming.task, "lifecycle") &&
          incoming.task.lifecycle === null &&
          !!current.task?.lifecycle) ||
        (incoming.task?.source?.path !== undefined &&
          incoming.task.source.path !== current.task?.source?.path) ||
        (incoming.taskSource?.path !== undefined &&
          incoming.taskSource.path !== current.taskSource?.path) ||
        (incoming.taskSource?.status !== undefined && incoming.taskSource.status !== "ready") ||
        (incoming.task?.lifecycle?.id !== undefined &&
          incoming.task.lifecycle.id !== current.task?.lifecycle?.id) ||
        (incoming.task?.lifecycle?.startedAt !== undefined &&
          incoming.task.lifecycle.startedAt !== current.task?.lifecycle?.startedAt) ||
        (Object.hasOwn(incoming, "subagents") && incoming.subagents === null) ||
        incoming.subagents?.status === "unavailable" ||
        (incoming.subagents?.taskCycleId !== undefined &&
          incoming.subagents.taskCycleId !== current.subagents?.taskCycleId) ||
        (incoming.subagents?.taskSourcePath !== undefined &&
          incoming.subagents.taskSourcePath !== current.subagents?.taskSourcePath);
      if (!sourceChanged) {
        invalidatePendingRefresh();
        void refresh();
        return;
      }
    }
    const identityChanged = element.threadId !== verifiedThreadId || activeScope !== scope;
    const hasBaseResponse = [
      "task",
      "heartbeat",
      "taskSource",
      "execution",
      "enabled",
      "heartbeatPending",
      "taskSourcePending",
    ].some((key) => Object.hasOwn(parsed.result, key));
    if (!hasBaseResponse) {
      if (identityChanged) {
        setIdentity(verifiedThreadId, scope);
        element.data = { task: null, heartbeat: null };
        element.observed = true;
        void refresh();
      } else if (Object.hasOwn(parsed.result, "subagents")) {
        // Partial pushes have no generation proof. Read the complete snapshot rather
        // than replacing the trusted task or accepting a late agent-only packet.
        invalidatePendingRefresh();
        void refresh();
      }
      return;
    }
    if (!identityChanged && isOlderTask(parsed.result, element.data)) return;
    invalidatePendingRefresh();
    const merged = !identityChanged
      ? retainMissingAgents(parsed.result, element.data, verifiedThreadId)
      : parsed.result;
    applyVerifiedResponse(merged, verifiedThreadId);
    if (merged !== parsed.result) void refresh();
    else schedule(parsed.result);
  }
};
app.onhostcontextchanged = applyContext;
app.onteardown = async () => {
  dispose();
  return {};
};
async function connectApp(): Promise<void> {
  if (disposed || connected) return;
  try {
    await app.connect(undefined, { timeout: 5_000 });
    if (disposed) return;
    connected = true;
    applyContext(app.getHostContext());
    const hostContext = app.getHostContext();
    if (hostContext?.platform && hostContext.platform !== "desktop") {
      element.observed = true;
      element.connectionError = "The native task panel requires a desktop MCP Apps host.";
      showError(element.connectionError);
      document.getElementById("native-panel-retry")?.setAttribute("hidden", "");
      return;
    }
    if (!app.getHostCapabilities()?.serverTools) {
      element.observed = true;
      element.connectionError = "This host does not expose MCP server tools to the panel.";
      showError(element.connectionError);
      document.getElementById("native-panel-retry")?.setAttribute("hidden", "");
      return;
    }
    void refresh();
  } catch (error) {
    if (disposed) return;
    element.observed = true;
    const message = error instanceof Error ? error.message : "MCP Apps connection failed.";
    element.connectionError = message;
    showError(message);
  }
}

app.onerror = (error) => {
  if (!disposed) {
    const message = error instanceof Error ? error.message : "MCP Apps connection failed.";
    element.observed = true;
    element.connectionError = message;
    showError(message);
  }
};

document.getElementById("native-panel-retry")?.addEventListener("click", () => {
  if (connected) void refresh();
  else void connectApp();
});
document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("pagehide", dispose, { once: true });
void connectApp();
