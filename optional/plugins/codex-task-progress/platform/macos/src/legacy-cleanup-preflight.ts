import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

// The old signed installer owns receipt validation and Dock restoration. Never guess ownership here.
export async function assertLegacyLauncherRemoved(homeDirectory: string): Promise<void> {
  const paths = [
    resolve(
      homeDirectory,
      "Applications/Codex.app/Contents/Resources/.codex-task-progress-managed.json",
    ),
    resolve(
      homeDirectory,
      "Applications/Codex Task Progress.app/Contents/Resources/.codex-task-progress-managed.json",
    ),
    resolve(
      homeDirectory,
      "Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist",
    ),
    resolve(
      homeDirectory,
      "Library/Application Support/CodexTaskProgress/launcher/managed-app.json",
    ),
  ];
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error("GOAL_PROGRESS_LEGACY_LAUNCHER_CLEANUP_REQUIRED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
