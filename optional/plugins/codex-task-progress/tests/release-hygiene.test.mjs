import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertMacosReleaseTree, MACOS_RELEASE_FILES } from "../scripts/check_release_hygiene.mjs";

const launcherPath = "bin/goal-progress-launcher";

async function createReleaseFixture(root, { managedLauncher = false } = {}) {
  const files = MACOS_RELEASE_FILES.filter(
    (path) => path !== "manifest.json" && (managedLauncher || path !== launcherPath),
  );
  for (const path of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture");
  }
  const manifest = {
    schemaVersion: 1,
    files: managedLauncher
      ? { dockLauncher: { path: launcherPath } }
      : { helper: { path: "bin/goal-progress" } },
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
}

test("macOS release hygiene accepts the declared managed launcher artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-task-progress-release-hygiene-"));
  try {
    await createReleaseFixture(root, { managedLauncher: true });
    await assert.doesNotReject(assertMacosReleaseTree(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS release hygiene remains compatible with older manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-task-progress-legacy-release-"));
  try {
    await createReleaseFixture(root);
    await assert.doesNotReject(assertMacosReleaseTree(root));

    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, launcherPath), "unexpected for a legacy manifest");
    await assert.rejects(
      assertMacosReleaseTree(root),
      /macOS release contains unexpected release file: bin\/goal-progress-launcher/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS release hygiene keeps the allowlist strict and validates the manifest path", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-task-progress-release-strict-"));
  try {
    await createReleaseFixture(root, { managedLauncher: true });
    await writeFile(join(root, "unexpected-artifact"), "unexpected");
    await assert.rejects(
      assertMacosReleaseTree(root),
      /macOS release contains unexpected release file: unexpected-artifact/u,
    );

    await rm(join(root, "unexpected-artifact"));
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, files: { dockLauncher: { path: "bin/wrong" } } }),
    );
    await assert.rejects(assertMacosReleaseTree(root), /invalid Dock launcher path/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
