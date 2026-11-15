import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function bundleModule(sourcePath, outputPath) {
  await build({
    bundle: true,
    entryPoints: [sourcePath],
    format: "esm",
    outfile: outputPath,
    platform: "node",
    target: "node20",
  });
  return import(pathToFileURL(outputPath).href);
}

test("release MCP launcher passes its fixed packaged plugin root", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "goal-progress-release-plugin-root-"));
  const pluginRoot = join(temporary, "release", "plugins", "codex-task-progress");
  const home = join(temporary, "home");
  const helper = join(
    home,
    "Library/Application Support/CodexTaskProgress/install/bin/goal-progress",
  );
  try {
    await mkdir(dirname(helper), { recursive: true });
    await writeFile(helper, '#!/bin/sh\nprintf "%s\\n%s\\n" "$GOAL_PROGRESS_PLUGIN_ROOT" "$*"\n');
    await chmod(helper, 0o700);

    const release = await bundleModule(
      join(root, "platform/macos/src/plugin-release.ts"),
      join(temporary, "plugin-release.mjs"),
    );
    const files = release.createReleasePluginRuntimeFiles(
      { goal_progress: { command: "ignored", args: [], cwd: ".", env: {} } },
      { hooks: {} },
    );
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await release.writeReleasePluginRuntimeFiles(pluginRoot, files);
    const canonicalPluginRoot = await realpath(pluginRoot);
    const result = spawnSync("/bin/sh", [join(pluginRoot, "bin/goal-progress-mcp")], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${canonicalPluginRoot}\nmcp-server\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("public release version agrees across plugin metadata", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "goal-progress-release-version-"));
  try {
    const workspaceManifestPaths = [
      "packages/core/package.json",
      "packages/tasks/package.json",
      "packages/store/package.json",
      "packages/mcp/package.json",
      "packages/ipc/package.json",
      "packages/renderer/package.json",
      "packages/contracts/package.json",
      "packages/codex-adapter/package.json",
      "packages/host/package.json",
      "platform/macos/package.json",
    ];
    const [
      version,
      packageJson,
      runtimePackageJson,
      pluginManifest,
      releaseVersionModule,
      ...workspaceManifests
    ] = await Promise.all([
      readFile(join(root, "VERSION"), "utf8"),
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
      readFile(join(root, "runtime/package.json"), "utf8").then(JSON.parse),
      readFile(join(root, ".codex-plugin/plugin.json"), "utf8").then(JSON.parse),
      bundleModule(
        join(root, "packages/contracts/src/release-version.ts"),
        join(temporary, "release-version.mjs"),
      ),
      ...workspaceManifestPaths.map((path) => readFile(join(root, path), "utf8").then(JSON.parse)),
    ]);
    assert.equal(version.trim(), packageJson.version);
    assert.equal(runtimePackageJson.version, packageJson.version);
    assert.equal(pluginManifest.version, packageJson.version);
    assert.equal(releaseVersionModule.GOAL_PROGRESS_RELEASE_VERSION, packageJson.version);
    for (const manifest of workspaceManifests) {
      assert.equal(manifest.version, packageJson.version);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
