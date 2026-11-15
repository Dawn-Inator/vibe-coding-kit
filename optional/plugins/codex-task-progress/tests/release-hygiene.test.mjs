import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertMacosReleaseTree, MACOS_RELEASE_FILES } from "../scripts/check_release_hygiene.mjs";

test("native release excludes legacy launchers, startup listener and injected assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-release-"));
  try {
    for (const path of MACOS_RELEASE_FILES) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, path === "manifest.json" ? "{}" : "fixture");
    }
    await assertMacosReleaseTree(root);
    for (const path of [
      "bin/goal-progress-launcher",
      "bin/goal-progress-startup-listener",
      "renderer/goal-progress.js",
    ]) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "legacy");
      await assert.rejects(assertMacosReleaseTree(root), /unexpected release file/);
      await rm(target);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
