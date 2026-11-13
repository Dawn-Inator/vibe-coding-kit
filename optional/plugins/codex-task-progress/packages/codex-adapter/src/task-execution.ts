import type { TaskPanelExecution } from "../../renderer/src/task-progress-element.js";

/** Positive, visible composer controls are local evidence; missing/unknown labels prove nothing. */
export function readTaskComposerExecution(composer: HTMLElement | null): TaskPanelExecution | null {
  if (!composer) return null;
  const window = composer.ownerDocument.defaultView;
  if (!window) return null;
  const labels = Array.from(composer.querySelectorAll<HTMLElement>("button[aria-label]")).flatMap(
    (button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];
      for (let ancestor: HTMLElement | null = button; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        if (
          ancestor.hidden ||
          ancestor.hasAttribute("inert") ||
          ancestor.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          return [];
      }
      return [(button.getAttribute("aria-label") ?? "").trim().toLowerCase()];
    },
  );
  const stop = labels.some((label) => /^(stop|stop generating|停止|停止生成)$/u.test(label));
  const send = labels.some((label) =>
    /^(send|send prompt|send message|发送|发送消息)$/u.test(label),
  );
  if (!stop && !send) return null;
  return {
    state: stop ? "working" : "idle",
    source: "codex-ui",
    observedAt: new Date().toISOString(),
  };
}

export function mergeTaskExecution(
  backend: TaskPanelExecution | undefined,
  composer: TaskPanelExecution | null,
): TaskPanelExecution {
  if (composer?.state === "working") return backend?.state === "waiting" ? backend : composer;
  if (backend?.state === "working" || backend?.state === "waiting") return backend;
  return (
    composer ??
    backend ?? {
      state: "unknown",
      source: "codex-app-server",
      observedAt: new Date().toISOString(),
    }
  );
}
