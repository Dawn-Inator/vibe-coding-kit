import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file is located in optional/plugins/codex-task-progress/scripts in the Kit checkout.
export const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export function kitRevision(root = kitRoot) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const revision = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/u.test(revision ?? ""))
    throw new Error("Kit checkout must have an exact Git HEAD");
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src", "skills/task-progress"], {
    cwd: root,
    encoding: "utf8",
  });
  if (dirty.status !== 0 || dirty.stdout.trim())
    throw new Error("Commit Kit sources before producing a release with HEAD provenance");
  return revision;
}
