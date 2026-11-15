import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";

export const TASK_PROGRESS_PANEL_TOOL_NAME = "task_progress_panel";
export const TASK_PROGRESS_PANEL_SEA_ASSET_KEY = "task-progress-panel.html";

export function createTaskProgressPanelResourceUri(releaseVersion: string): string {
  return `ui://codex-task-progress/panel-${encodeURIComponent(releaseVersion.trim())}.html`;
}

export const TASK_PROGRESS_PANEL_RESOURCE_URI = createTaskProgressPanelResourceUri(
  GOAL_PROGRESS_RELEASE_VERSION,
);

export type NativePanelHtmlLoader = () => Promise<string>;

export interface NativePanelSeaRuntime {
  isSea(): boolean;
  getAsset(key: string): Buffer | string;
}

/**
 * Read the packaged static panel document. The root is supplied by the plugin
 * launcher; no MCP request argument can select a filesystem path.
 */
export async function loadNativePanelHtml(
  pluginRoot = process.env.GOAL_PROGRESS_PLUGIN_ROOT,
  seaRuntime: NativePanelSeaRuntime = { isSea, getAsset },
): Promise<string> {
  if (seaRuntime.isSea()) {
    // A packaged helper must serve the exact panel shipped with its release.
    // Never fall back to a host plugin tree that may belong to another version.
    const embedded = seaRuntime.getAsset(TASK_PROGRESS_PANEL_SEA_ASSET_KEY);
    return Buffer.isBuffer(embedded) ? embedded.toString("utf8") : embedded;
  }
  const sourceRuntimeRoot = process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
  const resourcePath = sourceRuntimeRoot
    ? resolve(sourceRuntimeRoot, "assets/task-progress-panel.html")
    : pluginRoot
      ? resolve(pluginRoot, "assets/task-progress-panel.html")
      : fileURLToPath(new URL("./task-progress-panel.html", import.meta.url));
  return readFile(resourcePath, "utf8");
}
