import { spawnSync } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export type NativeMcpFeatureStatus = "enabled" | "disabled" | "unknown";

export function parseNativeMcpFeatureStatus(output: string): NativeMcpFeatureStatus {
  const lines = output.split(/\r?\n/u).filter((line) => /^\s*enable_mcp_apps\s/u.test(line));
  if (lines.length !== 1) return "unknown";
  const match = /^\s*enable_mcp_apps\s+.+?\s+(true|false)\s*$/u.exec(lines[0] ?? "");
  return match?.[1] === "true" ? "enabled" : match?.[1] === "false" ? "disabled" : "unknown";
}

export function inspectNativeMcpFeature(
  command: string,
  codexHomeDirectory: string,
): NativeMcpFeatureStatus {
  const result = spawnSync(command, ["features", "list"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: codexHomeDirectory },
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? parseNativeMcpFeatureStatus(result.stdout)
    : "unknown";
}

// Exact legacy controls only; never follow symlinks or touch state, credentials, or associations.
export async function retireLegacyControlFiles(root: string): Promise<readonly string[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of ["runtime/cdp.json", "preferences/v1/startup-recovery.json"]) {
    const target = resolve(root, name);
    const relativeParent = name.slice(0, name.lastIndexOf("/"));
    try {
      const actualParent = await realpath(resolve(root, relativeParent));
      if (actualParent !== resolve(realRoot, relativeParent))
        throw new Error("GOAL_PROGRESS_LEGACY_CONTROL_PATH_INVALID");
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("GOAL_PROGRESS_LEGACY_CONTROL_OWNERSHIP_INVALID");
      await unlink(target);
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
