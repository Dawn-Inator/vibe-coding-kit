import assert from "node:assert/strict";
import test from "node:test";
import type {
  MacosCommandName,
  MacosCommandResult,
} from "../../../platform/macos/src/command-protocol.js";
import type {
  InstallCommandDependencies,
  MacosCommandResultFactory,
} from "../../../platform/macos/src/install-command.js";
import type { HelperHealthInspection } from "../../../platform/macos/src/installed-inspection.js";
import type { MacosReleaseFile } from "../../../platform/macos/src/release.js";
import type { GoalProgressUpdateState } from "../../contracts/src/index.js";
import { GoalProgressUpdateCoordinator } from "../src/update-coordinator.js";

test("an unconfigured Kit release channel reports manual updates without network checks", async () => {
  let state: GoalProgressUpdateState | null = null;
  const store = {
    path: "/unused/update.json",
    async read() {
      return state;
    },
    async write(value: GoalProgressUpdateState) {
      state = value;
      return value;
    },
  };
  const coordinator = new GoalProgressUpdateCoordinator({ store, currentVersion: "0.4.4" });
  const initial = await coordinator.initialize();
  assert.equal(initial.lastErrorCode, "GOAL_PROGRESS_UPDATE_CHANNEL_UNCONFIGURED");
  assert.equal(await coordinator.beginAutomaticCheck(), null);
  const request = await coordinator.handleIntent({ type: "check" });
  const result = await request.afterResponse?.();
  assert.equal(result?.lastErrorCode, "GOAL_PROGRESS_UPDATE_CHANNEL_UNCONFIGURED");
});

test("startup recovery policy defaults off without creating preferences and persists explicit settings", async () => {
  const { mkdtemp, readFile, lstat, rm, symlink, writeFile, chmod } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveGoalProgressPaths } = await import("../../store/src/paths.js");
  const { readCodexStartupRecoveryPolicy, writeCodexStartupRecoveryPolicy } = await import(
    "../../../platform/macos/src/startup-recovery-policy.js"
  );
  const root = await mkdtemp(join(tmpdir(), "ctp-startup-policy-"));
  const paths = resolveGoalProgressPaths({ platform: "darwin", homeDirectory: root });
  try {
    assert.deepEqual(await readCodexStartupRecoveryPolicy(paths), {
      schemaVersion: 1,
      autoPrepareOnLaunch: false,
    });
    await assert.rejects(lstat(paths.preferencesRoot), { code: "ENOENT" });

    await writeCodexStartupRecoveryPolicy(paths, "enable");
    assert.deepEqual(await readCodexStartupRecoveryPolicy(paths), {
      schemaVersion: 1,
      autoPrepareOnLaunch: true,
    });
    const policyPath = join(paths.preferencesRoot, "startup-recovery.json");
    const firstBytes = await readFile(policyPath, "utf8");
    await writeCodexStartupRecoveryPolicy(paths, "enable");
    assert.equal(await readFile(policyPath, "utf8"), firstBytes);
    await writeCodexStartupRecoveryPolicy(paths, "disable");
    assert.equal((await readCodexStartupRecoveryPolicy(paths)).autoPrepareOnLaunch, false);

    await writeFile(policyPath, '{"schemaVersion":2,"autoPrepareOnLaunch":true}\n', {
      mode: 0o600,
    });
    await assert.rejects(readCodexStartupRecoveryPolicy(paths), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
    await writeFile(
      policyPath,
      `${JSON.stringify({ schemaVersion: 1, autoPrepareOnLaunch: true, extra: true })}\n`,
      {
        mode: 0o600,
      },
    );
    await assert.rejects(readCodexStartupRecoveryPolicy(paths), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
    await writeFile(policyPath, `${"x".repeat(4097)}\n`, { mode: 0o600 });
    await assert.rejects(readCodexStartupRecoveryPolicy(paths), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
    await rm(policyPath);
    const target = join(root, "target.json");
    await writeFile(target, '{"schemaVersion":1,"autoPrepareOnLaunch":true}\n', { mode: 0o600 });
    await symlink(target, policyPath);
    await assert.rejects(readCodexStartupRecoveryPolicy(paths), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
    await assert.rejects(writeCodexStartupRecoveryPolicy(paths, "enable"), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
    await rm(policyPath);
    await writeFile(policyPath, '{"schemaVersion":1,"autoPrepareOnLaunch":false}\n');
    await chmod(policyPath, 0o644);
    await assert.rejects(readCodexStartupRecoveryPolicy(paths), {
      message: "GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery CLI accepts one explicit action and configuration only writes policy", async () => {
  const { mkdtemp, rm, lstat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseMacosCommand, executeMacosCommand } = await import(
    "../../../platform/macos/src/command-protocol.js"
  );
  const { createMacosCommandHandlers } = await import("../../../platform/macos/src/installer.js");
  const root = await mkdtemp(join(tmpdir(), "ctp-startup-cli-"));
  const home = join(root, "home");
  const releaseRoot = join(root, "release");
  try {
    assert.equal(parseMacosCommand(["startup-recovery", "--status", "--json"]).ok, true);
    assert.equal(
      parseMacosCommand(["startup-recovery", "--enable", "--disable", "--json"]).ok,
      false,
    );
    assert.equal(
      parseMacosCommand(["startup-recovery", "--enable", "--json", "--unknown"]).ok,
      false,
    );
    await import("node:fs/promises").then(({ mkdir }) => mkdir(home));
    const handlers = createMacosCommandHandlers({ homeDirectory: home, releaseRoot });
    const status = await executeMacosCommand(["startup-recovery", "--status", "--json"], handlers);
    assert.equal(status.ok, true);
    assert.equal(status.details.configured, "disabled");
    const preferencesPath = join(
      home,
      "Library",
      "Application Support",
      "CodexTaskProgress",
      "preferences",
      "v1",
    );
    await assert.rejects(lstat(preferencesPath), { code: "ENOENT" });
    const enabled = await executeMacosCommand(["startup-recovery", "--enable", "--json"], handlers);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.details.autoPrepareOnLaunch, true);
    assert.equal(
      enabled.details.currentCodex,
      "The already-running Codex app is not changed by this setting.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable helper copy verifies content and restores old bytes after transaction failure", async () => {
  const { mkdtemp, writeFile, readFile, lstat, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { InstallTransaction } = await import("../../../platform/macos/src/install-transaction.js");
  const { captureStableHelper, installStableHelper, restoreStableHelper, stableHelperMatches } =
    await import("../../../platform/macos/src/stable-helper.js");
  const root = await mkdtemp(join(tmpdir(), "ctp-stable-helper-"));
  try {
    const path = join(root, "stable", "goal-progress"),
      first = join(root, "old"),
      second = join(root, "new");
    await writeFile(first, "old executable");
    await writeFile(second, "new executable");
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.equal(await installStableHelper(path, first, hash("old executable")), true);
    assert.equal(await installStableHelper(path, first, hash("old executable")), false);
    const snapshot = await captureStableHelper(path);
    const transaction = new InstallTransaction();
    await transaction.step(
      "stable",
      async () => ({
        changed: await installStableHelper(path, second, hash("new executable")),
        value: undefined,
      }),
      () => restoreStableHelper(path, snapshot),
    );
    await assert.rejects(
      transaction.step(
        "doctor",
        async () => {
          throw new Error("doctor failed");
        },
        async () => undefined,
      ),
    );
    assert.ok((await transaction.rollback()).every((item) => item.ok));
    assert.equal(await readFile(path, "utf8"), "old executable");
    assert.equal(await stableHelperMatches(path, hash("old executable")), true);
    assert.equal((await lstat(path)).nlink, 1);
    await assert.rejects(installStableHelper(path, second, hash("incorrect")), /HASH_MISMATCH/);
    assert.equal(await readFile(path, "utf8"), "old executable");
    await rm(path);
    await symlink(first, path);
    assert.equal(await stableHelperMatches(path, hash("old executable")), false);
    await assert.rejects(installStableHelper(path, second, hash("new executable")), /UNSAFE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first stable helper installation removes its new executable on rollback", async () => {
  const { mkdtemp, writeFile, lstat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { captureStableHelper, installStableHelper, restoreStableHelper } = await import(
    "../../../platform/macos/src/stable-helper.js"
  );
  const root = await mkdtemp(join(tmpdir(), "ctp-stable-first-"));
  try {
    const source = join(root, "candidate"),
      target = join(root, "bin", "goal-progress");
    await writeFile(source, "candidate");
    const snapshot = await captureStableHelper(target);
    await installStableHelper(
      target,
      source,
      createHash("sha256").update("candidate").digest("hex"),
    );
    await restoreStableHelper(target, snapshot);
    await assert.rejects(lstat(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable launch agent uses fixed physical helper and current assets", async () => {
  const { resolveMacosInstallationLayout } = await import(
    "../../../platform/macos/src/install-layout.js"
  );
  const { launchAgentPlist } = await import(
    "../../../platform/macos/src/launch-agent-controller.js"
  );
  const { resolveCliReleaseRoot } = await import("../../../platform/macos/src/cli.js");
  const { resolve } = await import("node:path");
  const home = resolve("/tmp/ctp-fixture-home");
  const layout = resolveMacosInstallationLayout({ homeDirectory: home, releaseVersion: "1.0.0" });
  const plist = launchAgentPlist(layout, {
    realAppPath: "/Applications/Codex.app",
    bundleId: "com.openai.codex",
    teamId: "test",
  });
  assert.ok(plist.includes(layout.stableHelperPath));
  assert.ok(plist.includes(resolve(layout.currentReleasePath, "renderer")));
  assert.ok(
    plist.includes(resolve(layout.currentReleasePath, "bin/goal-progress-startup-listener")),
  );
  assert.equal(resolveCliReleaseRoot(layout.stableHelperPath, home), layout.currentReleasePath);
  assert.equal(
    resolveCliReleaseRoot("/tmp/incoming-release/bin/goal-progress", home),
    "/tmp/incoming-release",
  );
});

test("stable installer rolls back transaction faults and upgrades in place", async () => {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createInstallCommand } = await import("../../../platform/macos/src/install-command.js");
  const { resolveGoalProgressPaths } = await import("../../../packages/store/src/paths.js");
  const { CODEX_BUNDLE_ID, CODEX_TEAM_ID } = await import(
    "../../../platform/macos/src/app-discovery.js"
  );
  const { GOAL_PROGRESS_STABLE_HOOK_COMMAND } = await import(
    "../../../platform/macos/src/plugin-release.js"
  );
  const { resolveMacosInstallationLayout } = await import(
    "../../../platform/macos/src/install-layout.js"
  );
  const { fileSha256, readInstalledManifest } = await import(
    "../../../platform/macos/src/verified-release.js"
  );
  const root = await fs.mkdtemp(join(tmpdir(), "ctp-stable-install-"));
  const priorRoot = process.env.GOAL_PROGRESS_ROOT;
  const applicationSupportRoot = join(root, "application-support");
  process.env.GOAL_PROGRESS_ROOT = applicationSupportRoot;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const codex = {
    realAppPath: "/Applications/Codex.app",
    bundleId: CODEX_BUNDLE_ID,
    teamId: CODEX_TEAM_ID,
  };
  const pluginTreeManifestSha256 = hash("plugin tree manifest");
  const releaseRoots = new Map<string, string>();

  const makeRelease = async (version: string, helperBytes: string) => {
    const releaseRoot = join(root, `release-${version}`);
    releaseRoots.set(version, releaseRoot);
    await fs.mkdir(releaseRoot, { recursive: true });
    const entries = [
      ["bin/goal-progress", helperBytes],
      ["bin/goal-progress-startup-listener", `startup ${version}`],
      ["renderer/index.js", `renderer ${version}`],
      ["renderer/manifest.json", JSON.stringify({ version })],
      ["plugin-marketplace.zip", `archive ${version}`],
      ["LICENSE", "license"],
      ["node.LICENSE", "node license"],
      ["THIRD-PARTY-NOTICES", "notices"],
      ["README.md", "readme"],
      ["INSTALL-FOR-AI.md", "install guide"],
      ["Install Goal Progress.command", "install command"],
      ["Repair Goal Progress.command", "repair command"],
      ["Disable Goal Progress.command", "disable command"],
      ["Uninstall Goal Progress.command", "uninstall command"],
    ] as const;
    const files = Object.fromEntries(
      await Promise.all(
        entries.map(async ([path, contents]) => {
          const target = join(releaseRoot, path);
          await fs.mkdir(resolve(target, ".."), { recursive: true });
          await fs.writeFile(target, contents);
          const file: MacosReleaseFile = {
            path,
            bytes: Buffer.byteLength(contents),
            sha256: hash(contents),
          };
          return [path, file] as const;
        }),
      ),
    ) satisfies Record<string, MacosReleaseFile>;
    const manifest = {
      schemaVersion: 1,
      releaseVersion: version,
      platform: "darwin",
      arch: "arm64",
      pluginTreeManifestSha256,
      runtime: { kind: "node-sea", nodeVersion: "v24.19.0" },
      files: {
        helper: files["bin/goal-progress"],
        startupListener: files["bin/goal-progress-startup-listener"],
        renderer: files["renderer/index.js"],
        rendererManifest: files["renderer/manifest.json"],
        pluginArchive: files["plugin-marketplace.zip"],
        license: files.LICENSE,
        nodeLicense: files["node.LICENSE"],
        thirdPartyNotices: files["THIRD-PARTY-NOTICES"],
        readme: files["README.md"],
        installGuide: files["INSTALL-FOR-AI.md"],
        installCommand: files["Install Goal Progress.command"],
        repairCommand: files["Repair Goal Progress.command"],
        disableCommand: files["Disable Goal Progress.command"],
        uninstallCommand: files["Uninstall Goal Progress.command"],
      },
    };
    await fs.writeFile(join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(
      join(releaseRoot, "SHA256SUMS"),
      Object.values(files)
        .map((file) => `${file.sha256}  ${file.path}\n`)
        .join(""),
    );
    return { releaseRoot, helperSha256: hash(helperBytes) };
  };

  const makeDependencies = (
    releaseRoot: string,
    options: { readonly fault?: "after-current"; readonly helperReady?: boolean } = {},
  ): InstallCommandDependencies => {
    const homeDirectory = join(root, "home");
    const goalPaths = resolveGoalProgressPaths({
      root: applicationSupportRoot,
      homeDirectory,
      platform: "darwin",
    });
    const launchAgent = {
      loaded: false,
      async isLoaded() {
        return this.loaded;
      },
      async ensure() {
        this.loaded = true;
        return true;
      },
      async remove() {
        this.loaded = false;
        return true;
      },
    };
    const plugin = {
      async ensure(_archive: string, marketplaceRoot: string) {
        const hookPath = join(marketplaceRoot, "plugins/codex-task-progress/hooks/hooks.json");
        await fs.mkdir(resolve(hookPath, ".."), { recursive: true });
        const hook = {
          hooks: {
            SessionStart: [{ hooks: [{ command: GOAL_PROGRESS_STABLE_HOOK_COMMAND }] }],
          },
        };
        await fs.writeFile(hookPath, JSON.stringify(hook));
        return true;
      },
      async remove() {
        return true;
      },
      async verify() {
        return true;
      },
    };
    const commandResult: MacosCommandResultFactory = (
      command: MacosCommandName,
      value,
    ): MacosCommandResult => ({
      schemaVersion: 1,
      command,
      ok: value.ok,
      code: value.code,
      changed: value.changed,
      nextStep: value.nextStep ?? null,
      details: value.details ?? {},
    });
    const dependencies: InstallCommandDependencies = {
      homeDirectory,
      releaseRoot,
      goalPaths,
      launchAgent,
      cdp: {
        async verify(_knownApp) {
          return true;
        },
        async ensure(_restartCodex) {
          return false;
        },
      },
      async inspectHelper() {
        const inspection: HelperHealthInspection = {
          ok: true,
          socketPathExists: true,
          socketIsSocket: true,
          socketMode: 0o600,
          pingOk: true,
          protocolVersion: 1,
          protocolMatches: true,
          pid: 123,
          identityPid: 123,
          pidMatches: true,
          ownerCount: 1,
          singleOwner: true,
          storeReadOnly: true,
          startupListenerRunning: true,
          startupListenerReady: true,
          startupListenerPid: 123,
          code: null,
        };
        return inspection;
      },
      async inspectHelperReadiness(_paths, _timeoutMs) {
        return { pingOk: true, ready: true, code: null };
      },
      async waitForHelperReady(inspect) {
        const readiness = await inspect(1_000);
        return (options.helperReady ?? true) && readiness.ready;
      },
      async discoverCodex() {
        return codex;
      },
      async pluginFor() {
        return plugin;
      },
      async restoreCdp(_restartCodex) {
        return { changed: false, scheduled: false, restartedCodex: false };
      },
      now() {
        return new Date("2026-11-14T00:00:00.000Z");
      },
      commandResult,
      ...(options.fault
        ? {
            installFaultForTest: async (point: string) => {
              if (point === options.fault) throw new Error(`fixture fault: ${point}`);
            },
          }
        : {}),
    };
    return dependencies;
  };

  try {
    await fs.mkdir(join(root, "home"), { recursive: true });
    const v1 = await makeRelease("1.0.0", "stable helper v1");
    const v2 = await makeRelease("1.1.0", "stable helper v2");
    const installV1 = makeDependencies(v1.releaseRoot);
    const invoke = async (
      dependencies: ReturnType<typeof makeDependencies>,
      command: "install" | "upgrade",
    ) =>
      createInstallCommand(dependencies)(command, {
        command,
        json: true,
        human: false,
        verbose: false,
        restartCodex: false,
        preserveHistory: true,
        startupRecoveryAction: null,
      });

    const initialInstall = await invoke(installV1, "install");
    assert.equal(initialInstall.ok, true, JSON.stringify(initialInstall));
    const layout = resolveMacosInstallationLayout({
      homeDirectory: installV1.homeDirectory,
      releaseVersion: "1.0.0",
    });
    const oldPlist = await fs.readFile(layout.launchAgentPath, "utf8");
    const historySentinel = join(applicationSupportRoot, "state", "history-sentinel.jsonl");
    await fs.mkdir(resolve(historySentinel, ".."), { recursive: true });
    await fs.writeFile(historySentinel, "retain history\n");
    const oldStableBytes = await fs.readFile(layout.stableHelperPath);
    const oldStableHash = await fileSha256(layout.stableHelperPath);

    const afterCurrent = await invoke(
      makeDependencies(v2.releaseRoot, { fault: "after-current" }),
      "upgrade",
    );
    assert.equal(afterCurrent.ok, false);
    assert.equal(afterCurrent.code, "INSTALL_ROLLED_BACK");
    assert.deepEqual(await fs.readFile(layout.stableHelperPath), oldStableBytes);
    assert.equal(await fileSha256(layout.stableHelperPath), oldStableHash);
    assert.equal(await fs.readlink(layout.currentReleasePath), layout.programReleaseRoot);
    assert.equal(await fs.readFile(layout.launchAgentPath, "utf8"), oldPlist);

    // Simulate an installed release predating migration to the stable helper path.
    const installedManifest = JSON.parse(
      await fs.readFile(layout.installManifestPath, "utf8"),
    ) as Record<string, unknown>;
    delete installedManifest.stableHelper;
    await fs.writeFile(layout.installManifestPath, JSON.stringify(installedManifest));
    await fs.unlink(layout.stableHelperPath);
    const doctorFailure = await invoke(
      makeDependencies(v2.releaseRoot, { helperReady: false }),
      "upgrade",
    );
    assert.equal(doctorFailure.ok, false);
    assert.equal(doctorFailure.code, "INSTALL_ROLLED_BACK");
    await assert.rejects(fs.lstat(layout.stableHelperPath), { code: "ENOENT" });
    assert.equal(await fs.readlink(layout.currentReleasePath), layout.programReleaseRoot);
    assert.equal(await fs.readFile(layout.launchAgentPath, "utf8"), oldPlist);
    assert.equal(await fs.readFile(historySentinel, "utf8"), "retain history\n");

    const success = await invoke(makeDependencies(v2.releaseRoot), "upgrade");
    assert.equal(success.ok, true);
    assert.equal(success.code, "UPGRADE_OK");
    const upgradedLayout = resolveMacosInstallationLayout({
      homeDirectory: installV1.homeDirectory,
      releaseVersion: "1.1.0",
    });
    assert.equal(await fs.readlink(layout.currentReleasePath), upgradedLayout.programReleaseRoot);
    assert.equal(await fileSha256(layout.stableHelperPath), v2.helperSha256);
    assert.notEqual(v1.helperSha256, v2.helperSha256);
    assert.equal(
      await fileSha256(join(layout.programReleasesRoot, "1.0.0", "bin/goal-progress")),
      v1.helperSha256,
    );
    assert.equal(
      await fileSha256(join(layout.programReleasesRoot, "1.1.0", "bin/goal-progress")),
      v2.helperSha256,
    );
    const manifest = await readInstalledManifest(layout.installManifestPath);
    assert.equal(manifest?.releaseVersion, "1.1.0");
    assert.equal(manifest?.stableHelper, true);
    assert.equal(await fs.readFile(historySentinel, "utf8"), "retain history\n");
    assert.equal((await fs.readdir(layout.programReleasesRoot)).sort().join(","), "1.0.0,1.1.0");
    assert.ok(releaseRoots.size === 2);
  } finally {
    if (priorRoot === undefined) delete process.env.GOAL_PROGRESS_ROOT;
    else process.env.GOAL_PROGRESS_ROOT = priorRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stable installer rejects unsafe bin parents without changing version executables", async () => {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { installStableHelper } = await import("../../../platform/macos/src/stable-helper.js");
  const root = await fs.mkdtemp(join(tmpdir(), "ctp-stable-parent-"));
  try {
    const versionDirectory = join(root, "releases", "1.0.0", "bin");
    const helper = join(versionDirectory, "goal-progress");
    const binDirectory = join(root, "install", "bin");
    await fs.mkdir(versionDirectory, { recursive: true });
    await fs.mkdir(join(root, "install"), { recursive: true });
    await fs.writeFile(helper, "immutable version helper");
    await fs.symlink(versionDirectory, binDirectory, "dir");
    await assert.rejects(
      installStableHelper(
        join(binDirectory, "goal-progress"),
        helper,
        createHash("sha256").update("immutable version helper").digest("hex"),
      ),
      /DIRECTORY_UNSAFE/,
    );
    assert.equal(await fs.readFile(helper, "utf8"), "immutable version helper");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stable helper accepts only an ordinary singly-linked mode-0700 executable", async () => {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { installStableHelper, stableHelperMatches } = await import(
    "../../../platform/macos/src/stable-helper.js"
  );
  const root = await fs.mkdtemp(join(tmpdir(), "ctp-stable-metadata-"));
  try {
    const directory = join(root, "bin");
    const source = join(root, "source");
    const target = join(directory, "goal-progress");
    await fs.mkdir(directory);
    await fs.writeFile(source, "candidate helper", { mode: 0o700 });
    const checksum = createHash("sha256").update("candidate helper").digest("hex");
    assert.equal(await installStableHelper(target, source, checksum), true);
    assert.equal(await stableHelperMatches(target, checksum), true);

    await fs.chmod(target, 0o1700);
    assert.equal(await stableHelperMatches(target, checksum), false);
    assert.equal(await installStableHelper(target, source, checksum), true);
    assert.equal((await fs.lstat(target)).mode & 0o7777, 0o700);

    const secondLink = join(directory, "other-name");
    await fs.link(target, secondLink);
    assert.equal(await stableHelperMatches(target, checksum), false);
    await assert.rejects(installStableHelper(target, source, checksum), /UNSAFE/);
    assert.equal(await fs.readFile(target, "utf8"), "candidate helper");
    assert.equal(await fs.readFile(secondLink, "utf8"), "candidate helper");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
