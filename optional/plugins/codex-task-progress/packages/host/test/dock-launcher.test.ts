import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { DockLauncherRunner } from "../../../platform/macos/src/dock-launcher.js";
import {
  CODEX_MANAGED_LAUNCHER_APP_NAME,
  CODEX_MANAGED_LAUNCHER_BUNDLE_ID,
  CODEX_MANAGED_LAUNCHER_MARKER,
  createDockLauncherInfoPlist,
  manageCodexDockLauncher,
  resolveCodexDockLauncherPaths,
} from "../../../platform/macos/src/dock-launcher.js";

const releaseNames = [
  "helper",
  "startupListener",
  "renderer",
  "rendererManifest",
  "pluginArchive",
  "license",
  "nodeLicense",
  "thirdPartyNotices",
  "readme",
  "installGuide",
  "installCommand",
  "repairCommand",
  "disableCommand",
  "uninstallCommand",
  "dockLauncher",
] as const;

async function makeFixture(
  root: string,
): Promise<{ home: string; release: string; codex: string }> {
  const home = join(root, "home with spaces");
  const release = join(root, "release with spaces");
  const codex = join(root, "Codex Source.app");
  await mkdir(join(codex, "Contents/Resources"), { recursive: true });
  await writeFile(join(codex, "Contents/Info.plist"), "fixture plist");
  await writeFile(join(codex, "Contents/Resources/electron.icns"), Buffer.from([0, 1, 2, 3]));
  const files: Record<string, unknown> = {};
  for (const name of releaseNames) {
    const filePath = name === "dockLauncher" ? "bin/goal-progress-launcher" : `fixture/${name}`;
    const fileContents = Buffer.from(`fixture:${name}`);
    await mkdir(join(release, filePath, ".."), { recursive: true });
    await writeFile(join(release, filePath), fileContents);
    files[name] = {
      path: filePath,
      bytes: fileContents.byteLength,
      sha256: createHash("sha256").update(fileContents).digest("hex"),
    };
  }
  await writeFile(
    join(release, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseVersion: "0.5.13",
      platform: "darwin",
      arch: "arm64",
      pluginTreeManifestSha256: "a".repeat(64),
      runtime: { kind: "node-sea", nodeVersion: "v24.19.0" },
      files,
    }),
  );
  return { home, release, codex };
}

const fixtureRunner: DockLauncherRunner = async (command, args) => {
  if (command === "/usr/bin/plutil" && args.includes("CFBundleIconFile"))
    return { code: 0, stdout: "electron.icns\n", stderr: "" };
  if (command === "/usr/bin/codesign") return { code: 0, stdout: "", stderr: "" };
  if (command.endsWith("goal-progress-launcher") && args[0] === "dock-status")
    return { code: 0, stdout: JSON.stringify({ ok: true, dockConfigured: false }), stderr: "" };
  throw new Error(`Unexpected fixture process: ${command} ${args.join(" ")}`);
};

test("launcher paths keep the Dock app, signed ownership marker, helper and receipts together", () => {
  const home = resolve("dock-launcher-fixture-home");
  const paths = resolveCodexDockLauncherPaths(home);
  assert.equal(paths.launcherAppPath, join(home, "Applications", CODEX_MANAGED_LAUNCHER_APP_NAME));
  assert.equal(paths.markerPath, join(paths.launcherAppPath, CODEX_MANAGED_LAUNCHER_MARKER));
  assert.equal(
    paths.markerPath,
    join(paths.launcherAppPath, "Contents/Resources/.codex-task-progress-managed.json"),
  );
  assert.equal(
    paths.helperPath,
    join(home, "Library/Application Support/CodexTaskProgress/install/bin/goal-progress"),
  );
  assert.equal(
    paths.dockReceiptPath,
    join(home, "Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist"),
  );
  assert.equal(
    paths.appInstallReceiptPath,
    join(home, "Library/Application Support/CodexTaskProgress/launcher/managed-app.json"),
  );
});

test("managed app metadata keeps Codex branding, a distinct bundle identity, and hidden app-switcher state", () => {
  const helper =
    "/Users/test/Library/Application Support/CodexTaskProgress/install/bin/goal-progress";
  const plist = createDockLauncherInfoPlist("Codex", helper);
  assert.match(plist, /<key>CFBundleName<\/key><string>Codex<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Codex<\/string>/);
  assert.match(
    plist,
    new RegExp(
      `<key>CFBundleIdentifier<\\/key><string>${CODEX_MANAGED_LAUNCHER_BUNDLE_ID}<\\/string>`,
    ),
  );
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>Codex<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
  assert.match(
    plist,
    /<key>TaskProgressHelperPath<\/key><string>\/Users\/test\/Library\/Application Support\/CodexTaskProgress\/install\/bin\/goal-progress<\/string>/,
  );
});

test("managed app installation uses checksummed release bytes and is idempotent without Dock changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock launcher manager fixture "));
  try {
    const fixture = await makeFixture(root);
    const input = {
      action: "install" as const,
      homeDirectory: fixture.home,
      releaseRoot: fixture.release,
      codex: { realAppPath: fixture.codex, bundleId: "com.openai.codex", teamId: "2DC432GLL2" },
      configureDock: false,
    };
    const first = await manageCodexDockLauncher(input, { runner: fixtureRunner });
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.equal(first.details.launcherInstalled, true);
    assert.equal(first.details.dockConfigured, false);
    const second = await manageCodexDockLauncher(input, { runner: fixtureRunner });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    const paths = resolveCodexDockLauncherPaths(fixture.home);
    assert.deepEqual(
      await readFile(join(paths.launcherAppPath, "Contents/Resources/Codex.icns")),
      Buffer.from([0, 1, 2, 3]),
    );
    const status = await manageCodexDockLauncher(
      { ...input, action: "status" },
      { runner: fixtureRunner },
    );
    assert.equal(status.details.launcherInstalled, true);
    assert.equal(status.details.currentCodex, "untouched");
    const removed = await manageCodexDockLauncher(
      { ...input, action: "remove" },
      { runner: fixtureRunner },
    );
    assert.equal(removed.ok, true);
    assert.equal(removed.details.launcherInstalled, false);
    await assert.rejects(lstat(paths.launcherAppPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed launcher refuses a symlinked Applications parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dock launcher symlink fixture "));
  try {
    const fixture = await makeFixture(root);
    const external = join(root, "external apps");
    await mkdir(external);
    await mkdir(fixture.home, { recursive: true });
    try {
      await symlink(
        external,
        join(fixture.home, "Applications"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (process.platform === "win32") {
        t.skip("Directory symlinks are unavailable on this Windows host.");
        return;
      }
      throw error;
    }
    const result = await manageCodexDockLauncher(
      {
        action: "install",
        homeDirectory: fixture.home,
        releaseRoot: fixture.release,
        codex: { realAppPath: fixture.codex, bundleId: "com.openai.codex", teamId: "2DC432GLL2" },
        configureDock: false,
      },
      { runner: fixtureRunner },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "DOCK_LAUNCHER_DESTINATION_PARENT_CONFLICT");
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy launcher migration preserves the old app when Dock migration fails and rejects conflicting paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock launcher migration "));
  try {
    const fixture = await makeFixture(root);
    const paths = resolveCodexDockLauncherPaths(fixture.home);
    const legacy = join(fixture.home, "Applications", "Codex Task Progress.app");
    await mkdir(join(legacy, "Contents/Resources"), { recursive: true });
    await writeFile(
      join(legacy, CODEX_MANAGED_LAUNCHER_MARKER),
      JSON.stringify({
        owner: "codex-task-progress-managed-launcher-v1",
        bundleId: CODEX_MANAGED_LAUNCHER_BUNDLE_ID,
      }),
    );
    const input = {
      action: "install" as const,
      homeDirectory: fixture.home,
      releaseRoot: fixture.release,
      codex: { realAppPath: fixture.codex, bundleId: "com.openai.codex", teamId: "2DC432GLL2" },
      configureDock: true,
    };
    const failingRunner: DockLauncherRunner = async (command, args) => {
      if (args[0] === "dock-install") return { code: 1, stdout: "", stderr: "migration rejected" };
      return fixtureRunner(command, args);
    };
    const failed = await manageCodexDockLauncher(input, { runner: failingRunner });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "DOCK_LAUNCHER_DOCK_CONFIGURE_FAILED");
    assert.equal((await lstat(legacy)).isDirectory(), true);
    assert.equal((await lstat(paths.launcherAppPath)).isDirectory(), true);
    await rm(paths.launcherAppPath, { recursive: true });
    await mkdir(paths.launcherAppPath);
    await writeFile(join(paths.launcherAppPath, "user-file"), "preserve");
    const conflict = await manageCodexDockLauncher(input, { runner: fixtureRunner });
    assert.equal(conflict.code, "DOCK_LAUNCHER_DESTINATION_CONFLICT");
    assert.equal(await readFile(join(paths.launcherAppPath, "user-file"), "utf8"), "preserve");
    assert.equal((await lstat(legacy)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Dock removal failure keeps the owned app and receipts and does not report success", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock launcher remove transaction "));
  try {
    const fixture = await makeFixture(root);
    const paths = resolveCodexDockLauncherPaths(fixture.home);
    await mkdir(join(paths.launcherAppPath, "Contents/Resources"), { recursive: true });
    await writeFile(
      join(paths.launcherAppPath, CODEX_MANAGED_LAUNCHER_MARKER),
      JSON.stringify({
        owner: "codex-task-progress-managed-launcher-v1",
        bundleId: CODEX_MANAGED_LAUNCHER_BUNDLE_ID,
      }),
    );
    await mkdir(join(paths.dockReceiptPath, ".."), { recursive: true });
    await writeFile(paths.dockReceiptPath, "fixture Dock receipt");
    await writeFile(paths.appInstallReceiptPath, "fixture app receipt");

    const failingRunner: DockLauncherRunner = async (command, args) => {
      if (args[0] === "dock-remove")
        return {
          code: 1,
          stdout: '{"ok":false,"code":"DOCK_RELOAD_FAILED","detail":"reload refused"}\n',
          stderr: "",
        };
      if (args[0] === "dock-status")
        return { code: 0, stdout: JSON.stringify({ ok: true, dockConfigured: true }), stderr: "" };
      return fixtureRunner(command, args);
    };
    const removed = await manageCodexDockLauncher(
      {
        action: "remove",
        homeDirectory: fixture.home,
        releaseRoot: fixture.release,
        codex: { realAppPath: fixture.codex, bundleId: "com.openai.codex", teamId: "2DC432GLL2" },
        configureDock: true,
      },
      { runner: failingRunner },
    );

    assert.equal(removed.ok, false);
    assert.equal(removed.code, "DOCK_LAUNCHER_DOCK_RESTORE_FAILED");
    assert.match(String(removed.details.reason), /DOCK_RELOAD_FAILED/);
    assert.match(String(removed.details.reason), /reload refused/);
    assert.equal((await lstat(paths.launcherAppPath)).isDirectory(), true);
    assert.equal(await readFile(paths.dockReceiptPath, "utf8"), "fixture Dock receipt");
    assert.equal(await readFile(paths.appInstallReceiptPath, "utf8"), "fixture app receipt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
