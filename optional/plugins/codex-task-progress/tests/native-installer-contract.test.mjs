import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { register } from "tsx/esm/api";

// Keep TypeScript resolution scoped to this suite, including imports made by fixtures.
const loader = register({ namespace: "native-installer-contract" });
after(async () => {
  await loader.unregister();
});
const [ipc, protocol, inspection, legacy, prerequisites, release] = await Promise.all([
  loader.import("../packages/ipc/src/index.ts", import.meta.url),
  loader.import("../platform/macos/src/command-protocol.ts", import.meta.url),
  loader.import("../platform/macos/src/installed-inspection.ts", import.meta.url),
  loader.import("../platform/macos/src/legacy-cleanup-preflight.ts", import.meta.url),
  loader.import("../platform/macos/src/native-install-prerequisites.ts", import.meta.url),
  loader.import("../platform/macos/src/release.ts", import.meta.url),
]);
const { GOAL_PROGRESS_IPC_PROTOCOL_VERSION } = ipc;
const { parseMacosCommand } = protocol;
const { evaluateHelperReadiness, nativeVerification } = inspection;
const { assertLegacyLauncherRemoved } = legacy;
const { parseNativeMcpFeatureStatus, retireLegacyControlFiles } = prerequisites;
const { createNodeSeaConfig } = release;

test("macOS release SEA embeds the packaged panel at the loader asset key", () => {
  const panelPath = "/release/plugins/codex-task-progress/assets/task-progress-panel.html";
  const config = createNodeSeaConfig(panelPath);
  assert.deepEqual(config.assets, { "task-progress-panel.html": panelPath });
  assert.throws(() => createNodeSeaConfig("relative/panel.html"), /PANEL_ASSET_PATH_INVALID/u);
});

test("native install accepts no legacy connection or Codex restart options", () => {
  const result = parseMacosCommand(["install", "--json"]);
  assert.equal(result.ok, true);
  for (const flag of ["--restart-codex", "--defer-connection", "--dock"]) {
    assert.equal(parseMacosCommand(["install", "--json", flag]).ok, false);
  }
  for (const command of ["launch", "launcher", "startup-recovery", "restore"]) {
    assert.equal(parseMacosCommand([command, "--json"]).ok, false);
  }
});

test("upgrade fails closed when any legacy ownership record remains", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-installer-"));
  try {
    await assertLegacyLauncherRemoved(home);
    for (const suffix of [
      "Applications/Codex.app/Contents/Resources/.codex-task-progress-managed.json",
      "Applications/Codex Task Progress.app/Contents/Resources/.codex-task-progress-managed.json",
      "Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist",
      "Library/Application Support/CodexTaskProgress/launcher/managed-app.json",
    ]) {
      const path = join(home, suffix);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "legacy user record");
      await assert.rejects(assertLegacyLauncherRemoved(home), /LEGACY_LAUNCHER_CLEANUP_REQUIRED/);
      assert.equal(await readFile(path, "utf8"), "legacy user record");
      await rm(path);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native readiness requires a valid ping, matching protocol, and ready helper", () => {
  const ping = { status: "ok", pid: 123, ready: true };
  assert.deepEqual(evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, ping), {
    pingOk: true,
    ready: true,
    code: null,
  });
  assert.equal(evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION + 1, ping).ready, false);
  assert.equal(
    evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, { ...ping, ready: false }).ready,
    false,
  );
  assert.equal(
    evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, { ...ping, pid: null }).ready,
    false,
  );
});

test("installation verification never claims the native panel is visible", () => {
  assert.deepEqual(nativeVerification(true), {
    installation: "pass",
    currentDisplay: "unverified",
    createAndUpdateFlow: "unverified",
  });
  assert.deepEqual(nativeVerification(false), {
    installation: "fail",
    currentDisplay: "unverified",
    createAndUpdateFlow: "unverified",
  });
});

test("feature check fails closed on missing, ambiguous or disabled CLI output", () => {
  assert.equal(
    parseNativeMcpFeatureStatus("enable_mcp_apps    under development  true\n"),
    "enabled",
  );
  assert.equal(parseNativeMcpFeatureStatus("enable_mcp_apps    experimental  false\n"), "disabled");
  for (const text of [
    "",
    "enable_mcp_apps experimental maybe",
    "enable_mcp_apps stable true\nenable_mcp_apps stable false",
  ]) {
    assert.equal(parseNativeMcpFeatureStatus(text), "unknown");
  }
});

test("legacy control retirement is bounded, idempotent and preserves user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cleanup-"));
  try {
    const controls = ["runtime/cdp.json", "preferences/v1/startup-recovery.json"];
    const preserved = [
      "state/v1/history.json",
      "release-signing.json",
      "preferences/v1/source-associations.json",
    ];
    for (const name of [...controls, ...preserved]) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, name);
    }
    assert.deepEqual(await retireLegacyControlFiles(root), controls);
    assert.deepEqual(await retireLegacyControlFiles(root), []);
    for (const name of preserved) assert.equal(await readFile(join(root, name), "utf8"), name);
    const target = join(root, preserved[0]);
    await symlink(target, join(root, controls[0]));
    await assert.rejects(retireLegacyControlFiles(root), /LEGACY_CONTROL_OWNERSHIP_INVALID/);
    assert.equal(await readFile(target, "utf8"), preserved[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function nativeInstallFixture(home, feature = "enabled", helperHealthy = true) {
  const { createHash } = await import("node:crypto");
  const { createInstallCommand } = await loader.import(
    "../platform/macos/src/install-command.ts",
    import.meta.url,
  );
  const { resolveGoalProgressPaths } = await loader.import(
    "../packages/store/src/index.ts",
    import.meta.url,
  );
  const { GOAL_PROGRESS_STABLE_HOOK_COMMAND } = await loader.import(
    "../platform/macos/src/plugin-release.ts",
    import.meta.url,
  );
  const releaseRoot = join(home, "fixture-release");
  const paths = resolveGoalProgressPaths({ platform: "darwin", homeDirectory: home });
  const files = {};
  for (const [key, path] of Object.entries({
    helper: "bin/goal-progress",
    pluginArchive: "plugin-marketplace.zip",
    license: "LICENSE",
    nodeLicense: "NODE-LICENSE.txt",
    thirdPartyNotices: "THIRD_PARTY_NOTICES.txt",
    readme: "README.md",
    installGuide: "INSTALL-FOR-AI.md",
    installCommand: "Install Goal Progress.command",
    repairCommand: "Repair Goal Progress.command",
    disableCommand: "Disable Goal Progress.command",
    uninstallCommand: "Uninstall Goal Progress.command",
  })) {
    const content = `fixture ${key}`;
    await mkdir(dirname(join(releaseRoot, path)), { recursive: true });
    await writeFile(join(releaseRoot, path), content);
    files[key] = {
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  await writeFile(
    join(releaseRoot, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseVersion: "0.5.99",
      platform: "darwin",
      arch: "arm64",
      runtime: { kind: "node-sea", nodeVersion: "v24.19.0" },
      pluginTreeManifestSha256: "a".repeat(64),
      files,
    }),
  );
  await writeFile(join(releaseRoot, "SHA256SUMS"), "fixture");
  let loaded = false;
  let installed = false;
  const plugin = {
    async ensure(_archive, marketplace) {
      const hook = join(marketplace, "plugins/codex-task-progress/hooks/hooks.json");
      await mkdir(dirname(hook), { recursive: true });
      await writeFile(
        hook,
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ command: GOAL_PROGRESS_STABLE_HOOK_COMMAND }] }] },
        }),
      );
      const changed = !installed;
      installed = true;
      return changed;
    },
    async verify() {
      return installed;
    },
    async remove() {
      const changed = installed;
      installed = false;
      return changed;
    },
  };
  const install = createInstallCommand({
    homeDirectory: home,
    releaseRoot,
    goalPaths: paths,
    launchAgent: {
      async isLoaded() {
        return loaded;
      },
      async ensure() {
        const changed = !loaded;
        loaded = true;
        return changed;
      },
      async remove() {
        const changed = loaded;
        loaded = false;
        return changed;
      },
    },
    inspectNativeMcpFeature: async () => feature,
    discoverCodex: async () => ({
      realAppPath: "/Applications/Codex.app",
      bundleId: "com.openai.codex",
      teamId: "2DC432GLL2",
    }),
    pluginFor: async () => plugin,
    inspectHelper: async () => ({ ok: helperHealthy }),
    inspectHelperReadiness: async () => ({ ready: true, pingOk: true, code: null }),
    waitForHelperReady: async (inspect) => (await inspect(1000)).ready,
    now: () => new Date("2026-01-01T00:00:00Z"),
    commandResult: (command, data) => ({
      schemaVersion: 1,
      command,
      nextStep: null,
      details: {},
      ...data,
    }),
  });
  return { install, paths, releaseRoot };
}

const nativeInstallInput = {
  command: "install",
  json: true,
  human: false,
  verbose: false,
  preserveHistory: true,
};

test("native install and manual upgrade commit real release, Helper and plugin state", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-install-flow-"));
  try {
    const { install, paths } = await nativeInstallFixture(home);
    const control = join(paths.root, "runtime/cdp.json");
    const history = join(paths.root, "state/v1/history.json");
    await mkdir(dirname(control), { recursive: true });
    await mkdir(dirname(history), { recursive: true });
    await writeFile(control, "legacy");
    await writeFile(history, "keep");
    const result = await install("install", nativeInstallInput);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, "INSTALL_OK");
    assert.equal(result.details.nativeMcpFeature, "enabled");
    assert.deepEqual(result.details.retiredLegacyControls, ["runtime/cdp.json"]);
    assert.equal(await readFile(history, "utf8"), "keep");
    assert.equal(
      JSON.parse(await readFile(paths.installManifestPath, "utf8")).releaseVersion,
      "0.5.99",
    );
    const upgrade = await install("upgrade", { ...nativeInstallInput, command: "upgrade" });
    assert.equal(upgrade.ok, true, JSON.stringify(upgrade));
    assert.equal(upgrade.code, "UPGRADE_ALREADY_CURRENT");
    assert.equal(upgrade.changed, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native install blocks missing feature and rolls back a failed Helper doctor", async () => {
  for (const [feature, healthy, expected] of [
    ["disabled", true, "NATIVE_MCP_SETUP_REQUIRED"],
    ["unknown", true, "NATIVE_MCP_SETUP_REQUIRED"],
    ["enabled", false, "INSTALL_ROLLED_BACK"],
  ]) {
    const home = await mkdtemp(join(tmpdir(), "native-install-failure-"));
    try {
      const { install, paths } = await nativeInstallFixture(home, feature, healthy);
      const result = await install("install", nativeInstallInput);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, expected);
      await assert.rejects(readFile(paths.installManifestPath), { code: "ENOENT" });
      if (feature !== "enabled") assert.match(result.nextStep, /enable_mcp_apps/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
