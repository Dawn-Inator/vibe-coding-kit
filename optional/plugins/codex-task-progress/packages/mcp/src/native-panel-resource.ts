import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";

export const TASK_PROGRESS_PANEL_TOOL_NAME = "task_progress_panel";

export function createTaskProgressPanelResourceUri(releaseVersion: string): string {
  return `ui://codex-task-progress/panel-${encodeURIComponent(releaseVersion.trim())}.html`;
}

export const TASK_PROGRESS_PANEL_RESOURCE_URI = createTaskProgressPanelResourceUri(
  GOAL_PROGRESS_RELEASE_VERSION,
);

export type NativePanelHtmlLoader = () => Promise<string>;

/**
 * Read the packaged static panel document. The root is supplied by the plugin
 * launcher; no MCP request argument can select a filesystem path.
 */
export async function loadNativePanelHtml(
  pluginRoot = process.env.GOAL_PROGRESS_PLUGIN_ROOT,
): Promise<string> {
  const sourceRuntimeRoot = process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
  const resourcePath = sourceRuntimeRoot
    ? resolve(sourceRuntimeRoot, "assets/task-progress-panel.html")
    : pluginRoot
      ? resolve(pluginRoot, "assets/task-progress-panel.html")
      : fileURLToPath(new URL("./task-progress-panel.html", import.meta.url));
  return readFile(resourcePath, "utf8");
}
