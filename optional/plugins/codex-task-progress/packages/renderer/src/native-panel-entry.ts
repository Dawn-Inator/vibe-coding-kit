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
} from "./task-progress-element.js";

type ToolEnvelope = { ok: true; result: TaskPanelResponse } | { ok: false; summary?: string };
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
let timer: ReturnType<typeof setInterval> | null = null;
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
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  app.ontoolresult = undefined;
  app.onhostcontextchanged = undefined;
  app.onerror = () => {};
  app.onteardown = undefined;
  element.remove();
}

function setIdentity(threadId: string | null): void {
  if (element.threadId === threadId) return;
  identityGeneration++;
  refreshSequence++;
  controller?.abort();
  controller = null;
  for (const active of activeToolControllers) active.abort();
  busy = false;
  element.refreshing = false;
  element.resetThread(threadId);
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
    throw new Error(summary);
  }
  const threadId = trustedThreadId(raw);
  if (!threadId)
    throw new Error(
      "Trusted conversation identity was not returned. Reload the current task to retry.",
    );
  if (parsed.result.task?.threadId && parsed.result.task.threadId !== threadId)
    throw new Error(
      "Task progress identity did not match the trusted conversation. Reload the current task to retry.",
    );
  return { response: parsed.result, threadId };
}

async function refresh(): Promise<void> {
  if (disposed || busy || document.visibilityState !== "visible") return;
  busy = true;
  element.refreshing = true;
  const requestGeneration = ++refreshSequence;
  controller?.abort();
  controller = new AbortController();
  try {
    const { response, threadId } = await readTaskResponse(controller.signal);
    if (disposed || requestGeneration !== refreshSequence) return;
    setIdentity(threadId);
    element.data = response;
    element.observed = true;
    element.connectionError = null;
    showError("");
  } catch (error) {
    if (disposed || requestGeneration !== refreshSequence) return;
    setIdentity(null);
    element.resetThread(null);
    element.data = { task: null, heartbeat: null };
    element.observed = true;
    const message = error instanceof Error ? error.message : "Task progress is unavailable.";
    element.connectionError = message;
    showError(message);
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
  const args = {
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  };
  const raw = await callTool(toolName, args);
  const parsed = envelope(raw);
  if (!parsed) throw new Error("Task history returned an unreadable response.");
  if (!parsed.ok) throw new Error(parsed.summary ?? "Task history is unavailable.");
  if (
    identityGeneration !== expectedIdentityGeneration ||
    element.threadId !== expectedThreadId ||
    trustedThreadId(raw) !== expectedThreadId ||
    (parsed.result.task?.threadId && parsed.result.task.threadId !== expectedThreadId)
  )
    throw new Error("Task history identity changed. Refresh the panel to continue.");
  return parsed.result;
};

app.ontoolresult = (result) => {
  const parsed = envelope(result);
  if (parsed?.ok) {
    // Host-delivered tool results are accepted only after the SDK validates the
    // MCP Apps protocol message; identity still comes from the tool response.
    const verifiedThreadId = trustedThreadId(result);
    const identityChanged = element.threadId !== verifiedThreadId;
    setIdentity(verifiedThreadId);
    if (
      !verifiedThreadId ||
      (parsed.result.task?.threadId && parsed.result.task.threadId !== verifiedThreadId)
    ) {
      element.data = { task: null, heartbeat: null };
      element.observed = true;
      element.connectionError =
        "Trusted conversation identity was not returned or did not match. Reload the current task to retry.";
      showError(element.connectionError);
      return;
    }
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
        element.data = { task: null, heartbeat: null };
        element.observed = true;
        void refresh();
      }
      return;
    }
    invalidatePendingRefresh();
    element.data = parsed.result;
    element.observed = true;
    element.connectionError = null;
    showError("");
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
    timer ??= setInterval(() => void refresh(), 5_000);
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
