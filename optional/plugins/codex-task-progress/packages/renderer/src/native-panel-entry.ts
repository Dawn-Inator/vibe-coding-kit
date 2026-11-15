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
    (response as ScopedResponse | undefined)?.presentation?.pending === true;
  const delay = pending ? (pendingDelays[pendingAttempts++] ?? 5_000) : 5_000;
  if (!pending) pendingAttempts = 0;
  timer = setTimeout(() => {
    timer = null;
    void refresh();
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

function applyVerifiedResponse(response: TaskPanelResponse, threadId: string): void {
  const scope = scopeOf(response);
  if (response.enabled === false) {
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
  if (parsed.result.task?.threadId && parsed.result.task.threadId !== threadId)
    throw new IdentityError(
      "Task progress identity did not match the trusted conversation. Reload the current task to retry.",
    );
  return { response: parsed.result, threadId };
}

async function refresh(): Promise<void> {
  if (disposed || busy || document.visibilityState !== "visible") return;
  clearTimer();
  busy = true;
  element.refreshing = true;
  const requestGeneration = ++refreshSequence;
  controller?.abort();
  controller = new AbortController();
  try {
    const { response, threadId } = await readTaskResponse(controller.signal);
    if (disposed || requestGeneration !== refreshSequence) return;
    applyVerifiedResponse(response, threadId);
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
  return parsed.result;
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
      (parsed.result.task?.threadId && parsed.result.task.threadId !== verifiedThreadId)
    ) {
      invalidateIdentity();
      element.connectionError =
        "Trusted conversation identity was not returned or did not match. Reload the current task to retry.";
      showError(element.connectionError);
      schedule();
      return;
    }
    const scope = scopeOf(parsed.result);
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
      }
      return;
    }
    invalidatePendingRefresh();
    applyVerifiedResponse(parsed.result, verifiedThreadId);
    schedule(parsed.result);
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
