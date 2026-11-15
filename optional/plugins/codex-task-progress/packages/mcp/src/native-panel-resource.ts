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

// Only previously shipped panel addresses may resolve to the current bundled HTML.
// Compare decimal components as strings so arbitrarily large inputs cannot overflow.
function compareReleaseVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined || b === undefined) throw new Error("Invalid release version");
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function isCompatibleTaskProgressPanelResourceUri(
  uri: string,
  currentVersion: string = GOAL_PROGRESS_RELEASE_VERSION,
): boolean {
  if (uri === "ui://codex-task-progress/panel-v1.html") return true;
  const match =
    /^ui:\/\/codex-task-progress\/panel-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.html$/.exec(
      uri,
    );
  if (
    !match?.[1] ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(currentVersion)
  ) {
    return false;
  }
  return (
    compareReleaseVersions(match[1], "0.5.16") >= 0 &&
    compareReleaseVersions(match[1], currentVersion) <= 0
  );
}

export type NativePanelHtmlLoader = () => Promise<string>;

export interface NativePanelSeaRuntime {
  isSea(): boolean;
  getAsset(key: string, encoding: "utf8"): string;
}

/**
 * SEA helpers read the exact release asset embedded at build time. Outside SEA,
 * the plugin launcher or source runtime supplies the asset root; no MCP request
 * argument can select a filesystem path.
 */
export async function loadNativePanelHtml(
  pluginRoot = process.env.GOAL_PROGRESS_PLUGIN_ROOT,
  seaRuntime: NativePanelSeaRuntime = { isSea, getAsset },
): Promise<string> {
  if (seaRuntime.isSea()) {
    // A packaged helper must serve the exact panel shipped with its release.
    // Never fall back to a host plugin tree that may belong to another version.
    return seaRuntime.getAsset(TASK_PROGRESS_PANEL_SEA_ASSET_KEY, "utf8");
  }
  const sourceRuntimeRoot = process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
  const resourcePath = sourceRuntimeRoot
    ? resolve(sourceRuntimeRoot, "assets/task-progress-panel.html")
    : pluginRoot
      ? resolve(pluginRoot, "assets/task-progress-panel.html")
      : fileURLToPath(new URL("./task-progress-panel.html", import.meta.url));
  return readFile(resourcePath, "utf8");
}
