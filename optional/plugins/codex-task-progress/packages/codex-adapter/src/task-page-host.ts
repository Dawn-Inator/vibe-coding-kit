import {
  registerTaskProgressElement,
  type TaskPanelExecution,
  type TaskPanelRequest,
  type TaskPanelResponse,
  type TaskProgressElement,
} from "../../renderer/src/task-progress-element.js";
import { readCurrentCodexPage } from "./anchor-adapter.js";
import { mergeTaskExecution, readTaskComposerExecution } from "./task-execution.js";

export interface TaskPageHostDiagnostics {
  version: 1;
  elementName: string;
  threadId: string | null;
  visible: boolean;
  connected: boolean;
  count: number;
  threadMatched: boolean;
  composerCount: number;
  textboxCount: number;
  threadCandidateCount: number;
  rejectionReason: ReturnType<typeof readCurrentCodexPage>["rejectionReason"];
  threadRejectionReason: ReturnType<typeof readCurrentCodexPage>["threadRejectionReason"];
  bounds: { x: number; y: number; width: number; height: number } | null;
  status: "waiting" | "connected" | "error";
  lastError: string | null;
  lastRefreshAt: string | null;
  revision: number | null;
}
export interface TaskPageHost {
  diagnostics(): TaskPageHostDiagnostics;
  refresh(): Promise<void>;
  destroy(): void;
}
declare global {
  interface Window {
    __codexTaskProgressRequest?: (input: TaskPanelRequest) => Promise<TaskPanelResponse>;
    __CODEX_TASK_PROGRESS__?: TaskPageHost;
  }
}

/** Uses the same visible-thread proof as the Goal adapter. It never infers identity from recency. */
export function installTaskProgressPageHost(window: Window): TaskPageHost {
  window.__CODEX_TASK_PROGRESS__?.destroy();
  const elementName = registerTaskProgressElement(window);
  const document = window.document;
  const element = document.createElement(elementName) as TaskProgressElement;
  element.dataset.codexTaskPanel = "true";
  element.style.cssText = "position:fixed;z-index:50;display:none;max-width:calc(100vw - 24px);";
  document.body.append(element);
  let destroyed = false;
  let busy = false;
  let generation = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let backendExecution: TaskPanelExecution | undefined;
  let projectEnabled: boolean | undefined;
  let floatPosition: { x: number; y: number } | null = null;
  let diagnostic: TaskPageHostDiagnostics = {
    version: 1,
    elementName,
    threadId: null,
    visible: false,
    connected: false,
    count: 0,
    threadMatched: false,
    composerCount: 0,
    textboxCount: 0,
    threadCandidateCount: 0,
    rejectionReason: null,
    threadRejectionReason: null,
    bounds: null,
    status: "waiting",
    lastError: null,
    lastRefreshAt: null,
    revision: null,
  };

  let reservation: {
    target: HTMLElement;
    paddingTop: string;
    paddingPriority: string;
    boxSizing: string;
    boxPriority: string;
    basePadding: number;
  } | null = null;
  const releaseReservation = (): void => {
    if (!reservation) return;
    const { target, paddingTop, paddingPriority, boxSizing, boxPriority } = reservation;
    if (paddingTop) target.style.setProperty("padding-top", paddingTop, paddingPriority);
    else target.style.removeProperty("padding-top");
    if (boxSizing) target.style.setProperty("box-sizing", boxSizing, boxPriority);
    else target.style.removeProperty("box-sizing");
    reservation = null;
  };
  const reserveTop = (target: HTMLElement, height: number): void => {
    if (reservation?.target !== target) {
      releaseReservation();
      reservation = {
        target,
        paddingTop: target.style.getPropertyValue("padding-top"),
        paddingPriority: target.style.getPropertyPriority("padding-top"),
        boxSizing: target.style.getPropertyValue("box-sizing"),
        boxPriority: target.style.getPropertyPriority("box-sizing"),
        basePadding: Number.parseFloat(window.getComputedStyle(target).paddingTop) || 0,
      };
    }
    target.style.boxSizing = "border-box";
    // The panel lives outside Codex's zoomed page surface. Convert its measured
    // viewport height to the content root's CSS units before reserving space.
    const physicalHeight = target.getBoundingClientRect().height;
    const scale = target.offsetHeight > 0 ? physicalHeight / target.offsetHeight : 1;
    const scaleY = Number.isFinite(scale) && scale > 0 ? scale : 1;
    target.style.paddingTop = `${reservation.basePadding + (height + 16) / scaleY}px`;
  };

  const synchronizeThread = (): ReturnType<typeof readCurrentCodexPage> => {
    const page = readCurrentCodexPage(document);
    if (page.threadId !== diagnostic.threadId) {
      generation++;
      releaseReservation();
      element.resetThread(page.threadId);
      backendExecution = undefined;
      projectEnabled = undefined;
      diagnostic = {
        ...diagnostic,
        threadId: page.threadId,
        revision: null,
        lastError: null,
        status: "waiting",
      };
    }
    return page;
  };

  const layout = (): void => {
    if (destroyed) return;
    const page = synchronizeThread();
    const execution = mergeTaskExecution(
      backendExecution,
      readTaskComposerExecution(page.composer),
    );
    if (
      execution.state !== element.data.execution?.state ||
      execution.source !== element.data.execution?.source
    ) {
      element.data = { ...element.data, execution };
    }
    // Empty drafts use the "default" content mode; conversations use
    // "thread-edge-scroll". Both belong below the measured native titlebar.
    // The outer page surface also includes that titlebar and cannot be an anchor.
    const contentRoot = page.composer?.closest<HTMLElement>("[data-app-shell-main-content-layout]");
    const mainRoot = page.composer?.closest<HTMLElement>("[data-app-shell-main-surface]");
    const layoutRoot = [contentRoot, mainRoot].find((root) => {
      if (!root || root === page.composer) return false;
      const box = root.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    if (reservation && (element.floating || reservation.target !== layoutRoot))
      releaseReservation();
    const rect = page.composer?.getBoundingClientRect();
    const visible =
      projectEnabled !== false && !!rect && rect.width > 0 && !!layoutRoot && !page.rejectionReason;
    diagnostic.visible = visible;
    element.style.display = visible ? "block" : "none";
    if (!rect || !visible || !layoutRoot) {
      releaseReservation();
      return;
    }
    const computed = window.getComputedStyle(page.composer ?? document.body);
    const dark =
      document.documentElement.classList.contains("dark") ||
      document.documentElement.dataset.theme === "dark" ||
      computed.colorScheme === "dark";
    element.style.setProperty(
      "--ctp-surface",
      computed.getPropertyValue("--color-token-main-surface-primary").trim() ||
        (dark ? "#252525" : "#ffffff"),
    );
    element.style.setProperty("--ctp-text", computed.color || (dark ? "#eee" : "#222"));
    element.style.setProperty("--ctp-border", dark ? "#ffffff20" : "#00000020");
    element.style.setProperty("--ctp-muted", dark ? "#b0b0b0" : "#666");
    element.style.setProperty("--ctp-hover", dark ? "#ffffff12" : "#00000009");
    const accent =
      computed.getPropertyValue("--color-token-primary") ||
      computed.getPropertyValue("--color-text-accent") ||
      computed.getPropertyValue("--color-accent") ||
      computed.getPropertyValue("--accent-color");
    if (accent.trim()) element.style.setProperty("--ctp-accent", accent.trim());
    element.style.fontSize = computed.fontSize;
    element.style.fontFamily = computed.fontFamily;
    element.locale = document.documentElement.lang || window.navigator.language || "en";
    element.dir = document.documentElement.dir || "auto";
    const layoutRect = layoutRoot.getBoundingClientRect();
    const dockTop = Math.max(0, layoutRect.top) + 8;
    // The dock remains a single 44px row. Its independently positioned popover
    // uses the viewport budget rather than growing the reserved content space.
    const availableHeight = Math.max(0, Math.min(496, window.innerHeight - 24));
    element.style.setProperty("--ctp-panel-max-height", `${availableHeight}px`);
    element.style.setProperty("--ctp-scroll-max-height", `${Math.max(0, availableHeight - 170)}px`);
    element.style.setProperty("--ctp-composer-top", `${rect.top}px`);
    const width = Math.max(0, Math.min(464, rect.width, window.innerWidth - 24));
    element.style.width = `${width}px`;
    const height = element.getBoundingClientRect().height || 44;
    const dockLeft = Math.max(
      12,
      Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 12),
    );
    if (element.floating) {
      const position = floatPosition ?? { x: dockLeft, y: Math.max(12, dockTop) };
      element.style.left = `${Math.max(12, Math.min(position.x, window.innerWidth - width - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(position.y, window.innerHeight - height - 12))}px`;
    } else {
      element.style.left = `${dockLeft}px`;
      element.style.top = `${dockTop}px`;
      reserveTop(layoutRoot, height);
    }
    element.dispatchEvent(new CustomEvent("task-progress-position"));
  };

  const request = async (input: TaskPanelRequest): Promise<TaskPanelResponse> => {
    const page = synchronizeThread();
    const binding = window.__codexTaskProgressRequest;
    if (!page.threadId || page.threadId !== input.threadId)
      throw new Error("TASK_VISIBLE_THREAD_CHANGED");
    if (!binding) throw new Error("TASK_PROGRESS_BRIDGE_UNAVAILABLE");
    const expectedGeneration = generation;
    const result = await binding(input);
    if (
      destroyed ||
      expectedGeneration !== generation ||
      readCurrentCodexPage(document).threadId !== input.threadId
    ) {
      throw new Error("TASK_VISIBLE_THREAD_CHANGED");
    }
    if (result.enabled === false) {
      projectEnabled = false;
      backendExecution = undefined;
      element.resetThread(input.threadId);
      diagnostic.revision = null;
      layout();
      return { enabled: false, task: null, heartbeat: null };
    }
    if (result.task && result.task.threadId !== input.threadId) {
      throw new Error("TASK_RESPONSE_THREAD_MISMATCH");
    }
    return result;
  };
  element.requester = request;

  const refresh = async (): Promise<void> => {
    layout();
    if (destroyed || busy || !diagnostic.threadId) return;
    if (!window.__codexTaskProgressRequest) return;
    busy = true;
    const threadId = diagnostic.threadId;
    const expectedGeneration = generation;
    try {
      const result = await request({ method: "get", threadId });
      projectEnabled = result.enabled !== false;
      backendExecution = result.execution;
      element.data = {
        ...result,
        execution: mergeTaskExecution(
          backendExecution,
          readTaskComposerExecution(readCurrentCodexPage(document).composer),
        ),
      };
      element.observed = true;
      element.connectionError = null;
      diagnostic.status = "connected";
      diagnostic.lastError = null;
      diagnostic.revision = result.task?.revision ?? null;
      diagnostic.lastRefreshAt = new Date().toISOString();
      await element.updateComplete;
      layout();
    } catch (error) {
      if (
        !destroyed &&
        generation === expectedGeneration &&
        diagnostic.threadId === threadId &&
        readCurrentCodexPage(document).threadId === threadId
      ) {
        diagnostic.status = "error";
        diagnostic.lastError = error instanceof Error ? error.message : String(error);
        element.connectionError = diagnostic.lastError;
      }
    } finally {
      busy = false;
    }
  };

  const schedule = (): void => {
    if (destroyed || debounce !== undefined) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      void refresh();
    }, 120);
  };
  const observer = new MutationObserver((records) => {
    // Ignore our own DOM/style changes to avoid an observer feedback loop.
    if (records.some((record) => record.target !== element && !element.contains(record.target))) {
      // Observe active controls before the debounce/network round trip can leave an idle bar onscreen.
      layout();
      schedule();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "aria-label",
      "aria-current",
      "aria-hidden",
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-thread-selected",
      "data-app-action-sidebar-thread-id",
      "data-response-annotation-conversation",
      "data-app-shell-main-content-layout",
      "data-app-shell-main-surface",
      "hidden",
      "inert",
    ],
  });
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(element);
  const interval = window.setInterval(() => void refresh(), 2_000);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  element.addEventListener("task-progress-layout", () => {
    void element.updateComplete.then(layout);
  });
  let removeDrag: (() => void) | null = null;
  element.addEventListener("task-progress-drag", (raw: Event) => {
    removeDrag?.();
    const event = raw as CustomEvent<{ x: number; y: number }>;
    const rect = element.getBoundingClientRect();
    const move = (eventMove: PointerEvent): void => {
      floatPosition = {
        x: rect.left + eventMove.clientX - event.detail.x,
        y: rect.top + eventMove.clientY - event.detail.y,
      };
      layout();
    };
    const stop = (): void => {
      removeDrag?.();
      removeDrag = null;
    };
    removeDrag = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });
  const host: TaskPageHost = {
    diagnostics: () => {
      const page = readCurrentCodexPage(document);
      const connected = !destroyed && element.isConnected;
      const threadMatched =
        !!diagnostic.threadId && page.threadId === diagnostic.threadId && !page.rejectionReason;
      const rect = connected ? element.getBoundingClientRect() : null;
      let stylesVisible = connected;
      for (
        let node: HTMLElement | null = connected ? element : null;
        node;
        node = node.parentElement
      ) {
        const style = window.getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility !== "visible" ||
          Number(style.opacity) <= 0
        ) {
          stylesVisible = false;
          break;
        }
      }
      const visible =
        connected &&
        threadMatched &&
        diagnostic.visible &&
        !!rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        stylesVisible;
      const lastError =
        diagnostic.lastError && /^[A-Z][A-Z0-9_]{1,127}$/u.test(diagnostic.lastError)
          ? diagnostic.lastError
          : diagnostic.lastError
            ? "TASK_PROGRESS_ERROR"
            : null;
      return {
        ...diagnostic,
        connected,
        count: document.querySelectorAll('[data-codex-task-panel="true"]').length,
        threadMatched,
        composerCount: page.composerCount,
        textboxCount: page.textboxCount,
        threadCandidateCount: page.threadCandidateCount,
        rejectionReason: page.rejectionReason,
        threadRejectionReason: page.threadRejectionReason,
        visible,
        bounds:
          visible && rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        lastError,
      };
    },
    refresh,
    destroy: () => {
      destroyed = true;
      generation++;
      releaseReservation();
      observer.disconnect();
      resizeObserver.disconnect();
      window.clearInterval(interval);
      if (debounce !== undefined) clearTimeout(debounce);
      removeDrag?.();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      element.remove();
    },
  };
  window.__CODEX_TASK_PROGRESS__ = host;
  void refresh();
  return host;
}
