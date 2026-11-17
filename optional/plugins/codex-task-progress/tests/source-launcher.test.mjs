import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("source launcher builds and refreshes the native MCP resource without prebuilt assets", async () => {
  const requiredPackages = [
    "@modelcontextprotocol/sdk/client/index.js",
    "@modelcontextprotocol/sdk/client/stdio.js",
    "@modelcontextprotocol/ext-apps",
    "@lucide/icons",
    "esbuild",
    "lit",
    "zod",
  ];
  // Required dev dependencies: fail closed with install instructions instead of skipping.
  const missing = requiredPackages.filter((packageName) => {
    try { import.meta.resolve(packageName); return false; } catch { return true; }
  });
  assert.deepEqual(missing, [], `source-runtime dependencies are not installed; run \`pnpm install --frozen-lockfile\` in optional/plugins/codex-task-progress`);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const scratch = await mkdtemp(join(tmpdir(), "task-source-panel-"));
  const plugin = resolve(scratch, "kit/optional/plugins/codex-task-progress");
  const actualPlugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const actualKit = resolve(actualPlugin, "../../..");
  const data = resolve(scratch, "data");
  const home = resolve(scratch, "home");
  const pnpm = resolve(scratch, "pnpm");
  try {
    await mkdir(plugin, { recursive: true });
    for (const entry of [".codex-plugin", "runtime", "packages", "platform", "hooks", "scripts"]) {
      const target = resolve(plugin, entry);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(actualPlugin, entry), target, {
        recursive: true,
        filter: async (path) => {
          const parts = path.split(/[\\/]/u);
          if (parts.includes("node_modules")) return false;
          if (entry !== "scripts" || path === resolve(actualPlugin, "scripts")) return true;
          const name = basename(path);
          return (
            !name.startsWith(".") &&
            name !== "dist" &&
            ((await lstat(path)).isDirectory() || /\.(?:mjs|cjs|js|mts|ts|py|sh)$/u.test(path))
          );
        },
      });
    }
    await mkdir(resolve(scratch, "kit/src"), { recursive: true });
    await cp(resolve(actualKit, "src"), resolve(scratch, "kit/src"), { recursive: true });
    // Avoid network and use the already-installed development dependencies in the fixture.
    await writeFile(
      pnpm,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.19.0; else ln -s "$TEST_DEPENDENCIES" node_modules; fi\n',
    );
    await chmod(pnpm, 0o700);
    const env = {
      ...process.env,
      HOME: home,
      GOAL_PROGRESS_PLUGIN_DATA: data,
      GOAL_PROGRESS_CODEX_HOME: resolve(scratch, "codex"),
      GOAL_PROGRESS_PNPM: pnpm,
      GOAL_PROGRESS_NODE_BINARY: process.execPath,
      GOAL_PROGRESS_SOURCE_SKIP_SETUP: "1",
      TEST_DEPENDENCIES: resolve(actualPlugin, "node_modules"),
    };
    delete env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
    async function readResource() {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(plugin, "runtime/bootstrap.mjs"), "mcp-server"],
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "source-panel-test", version: "1" });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      try {
        await client.connect(transport);
        const manifest = JSON.parse(
          await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8"),
        );
        assert.deepEqual(client.getServerVersion(), {
          name: "codex-task-progress",
          version: manifest.version,
        });
        const tools = await client.listTools();
        assert.ok(
          tools.tools.some((tool) => tool.name === "task_progress_dashboard"),
          "native panel tool missing",
        );
        const panelTool = tools.tools.find((tool) => tool.name === "task_progress_dashboard");
        const resourceUri = panelTool?._meta?.ui?.resourceUri;
        assert.equal(typeof resourceUri, "string", "native panel resource URI missing");
        const result = await client.readResource({ uri: resourceUri });
        return result.contents[0].text;
      } catch (error) {
        const log = await readFile(resolve(data, "source-runtime/bootstrap.log"), "utf8").catch(
          () => "(no bootstrap log)",
        );
        throw new Error(
          `source MCP launcher failed: ${error instanceof Error ? error.stack : String(error)}\nstderr: ${stderr}\nbootstrap log: ${log}`,
        );
      } finally {
        await client.close();
      }
    }
    const first = await readResource();
    assert.match(first, /<script>/u);
    const runtimeManifest = resolve(
      data,
      "source-runtime/versions",
      JSON.parse(await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8")).version,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(runtimeManifest, "utf8"));
    assert.ok(manifest.files["assets/task-progress-panel.html"]);
    assert.ok(!Object.keys(manifest.files).some((path) => /renderer|listener|cdp/iu.test(path)));
    const firstHash = manifest.inputHash;
    const signingScript = resolve(plugin, "scripts/release-signing.mjs");
    await writeFile(
      signingScript,
      `${await readFile(signingScript, "utf8")}\n// source input change\n`,
    );
    await readResource();
    const secondHash = JSON.parse(await readFile(runtimeManifest, "utf8")).inputHash;
    assert.notEqual(secondHash, firstHash, "script changes must invalidate the source runtime");
    const kitContract = resolve(scratch, "kit/src/tasks/task-contract.mjs");
    await writeFile(
      kitContract,
      `${await readFile(kitContract, "utf8")}\n// kit source input change\n`,
    );
    await readResource();
    const kitHash = JSON.parse(await readFile(runtimeManifest, "utf8")).inputHash;
    assert.notEqual(kitHash, secondHash, "Kit source changes must invalidate the source runtime");
    const template = resolve(plugin, "packages/renderer/src/native-panel.html");
    await writeFile(
      template,
      `${await readFile(template, "utf8")}\n<!-- source-refresh-marker -->\n`,
    );
    const second = await readResource();
    assert.match(second, /source-refresh-marker/u);
    assert.doesNotMatch(first, /source-refresh-marker/u);

    const legacyMarker = resolve(
      home,
      "Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist",
    );
    await mkdir(dirname(legacyMarker), { recursive: true });
    await writeFile(legacyMarker, "fixture ownership record");
    const blockedEnv = { ...env };
    delete blockedEnv.GOAL_PROGRESS_SOURCE_SKIP_SETUP;
    for (const mode of ["mcp-server", "prepare"]) {
      await assert.rejects(
        execFileAsync(process.execPath, [resolve(plugin, "runtime/bootstrap.mjs"), mode], {
          env: blockedEnv,
        }),
        (error) =>
          /GOAL_PROGRESS_LEGACY_LAUNCHER_CLEANUP_REQUIRED/u.test(error.stderr) &&
          /previous version's CLI uninstall --keep-history --human/u.test(error.stderr),
      );
      assert.equal(await readFile(legacyMarker, "utf8"), "fixture ownership record");
      await assert.rejects(lstat(resolve(home, "Library/LaunchAgents")), { code: "ENOENT" });
      await assert.rejects(lstat(resolve(data, "runtime")), { code: "ENOENT" });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("source launcher fails closed with install instructions when the dev toolchain is missing", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "task-source-no-deps-"));
  const testDir = resolve(scratch, "tests");
  try {
    await mkdir(testDir, { recursive: true });
    await cp(fileURLToPath(import.meta.url), resolve(testDir, "source-launcher.test.mjs"));
    const childEnv = { ...process.env, NODE_PATH: "" };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    const failure = await execFileAsync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^source launcher builds",
        resolve(testDir, "source-launcher.test.mjs"),
      ],
      { cwd: scratch, env: childEnv },
    ).then(
      () => assert.fail("a missing toolchain must fail the suite, not pass or skip it"),
      (error) => error,
    );
    assert.doesNotMatch(failure.stdout, /# SKIP /u, `stdout: ${failure.stdout}`);
    assert.match(
      failure.stdout,
      /source-runtime dependencies are not installed; run `pnpm install --frozen-lockfile`/u,
      `stdout: ${failure.stdout}\nstderr: ${failure.stderr}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("source startup failure never falls back to an old installed helper", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "task-source-no-fallback-"));
  const plugin = resolve(scratch, "plugin");
  const home = resolve(scratch, "home");
  const marker = resolve(scratch, "legacy-started");
  const legacy = resolve(
    home,
    "Library/Application Support/CodexTaskProgress/install/current/bin/goal-progress",
  );
  try {
    const actualPlugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    await mkdir(plugin, { recursive: true });
    await cp(resolve(actualPlugin, ".codex-plugin"), resolve(plugin, ".codex-plugin"), {
      recursive: true,
    });
    await cp(resolve(actualPlugin, "runtime"), resolve(plugin, "runtime"), { recursive: true });
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, '#!/bin/sh\ntouch "$TEST_LEGACY_MARKER"\n');
    await chmod(legacy, 0o700);
    await assert.rejects(
      execFileAsync(process.execPath, [resolve(plugin, "runtime/bootstrap.mjs"), "mcp-server"], {
        env: {
          ...process.env,
          HOME: home,
          GOAL_PROGRESS_PLUGIN_DATA: resolve(scratch, "data"),
          GOAL_PROGRESS_CODEX_HOME: resolve(scratch, "codex"),
          GOAL_PROGRESS_SOURCE_SKIP_SETUP: "1",
          TEST_LEGACY_MARKER: marker,
        },
      }),
      (error) => error.code !== 0 && /GOAL_PROGRESS_SOURCE_TREE_MISSING/u.test(error.stderr),
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
