import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

let compiledBinary;
let compileRoot;
let compilePromise;
let nativeSkipReason;

function assertNativeSuccess(result, context) {
  assert.equal(
    result.status,
    0,
    `${context}: status=${result.status} signal=${result.signal ?? "none"}\nstdout=${String(result.stdout ?? "").slice(0, 1_000)}\nstderr=${String(result.stderr ?? "").slice(0, 1_000)}`,
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function cleanupLauncherFixture({ root, release, completion, openProcess }) {
  try {
    if (release) await writeFile(release, "release\n").catch(() => undefined);
    if (completion) {
      await Promise.race([
        completion.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }

    const fixtureExecutables = new Set();
    for (const appName of ["Progress Fixture.app", "Fast Progress Fixture.app"]) {
      try {
        fixtureExecutables.add(
          realpathSync(join(root, appName, "Contents/MacOS/CodexTaskProgressLauncher")),
        );
      } catch {}
    }
    const ownPids = new Set();
    if (process.platform === "darwin" && fixtureExecutables.size) {
      const processes = spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
      for (const line of String(processes.stdout ?? "").split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        try {
          const executable = realpathSync(match[2].trim());
          if (!fixtureExecutables.has(executable)) continue;
          ownPids.add(pid);
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    const cleanupDeadline = Date.now() + 5_000;
    while (ownPids.size && Date.now() < cleanupDeadline) {
      for (const pid of ownPids) {
        try {
          process.kill(pid, 0);
        } catch {
          ownPids.delete(pid);
        }
      }
      if (ownPids.size) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (openProcess && openProcess.exitCode === null) {
      await Promise.race([
        completion?.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (openProcess.exitCode === null) openProcess.kill("SIGTERM");
      await Promise.race([
        completion?.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function nativeLauncherFor(t) {
  if (process.env.GOAL_PROGRESS_DOCK_LAUNCHER_TEST_BINARY)
    return process.env.GOAL_PROGRESS_DOCK_LAUNCHER_TEST_BINARY;
  if (process.platform !== "darwin") {
    t.skip("The native Dock launcher fixture requires macOS and Swift.");
    return null;
  }
  compilePromise ??= (async () => {
    const probe = spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (probe.status !== 0) {
      nativeSkipReason = "Swift compiler is unavailable on this macOS host.";
      return null;
    }
    compileRoot = await mkdtemp(join(tmpdir(), "codex launcher native build "));
    compiledBinary = join(compileRoot, "goal-progress-launcher");
    const source = fileURLToPath(new URL("../platform/macos/launcher/main.swift", import.meta.url));
    const build = spawnSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        "-D",
        "TASK_PROGRESS_LAUNCHER_TESTING",
        "-framework",
        "AppKit",
        source,
        "-o",
        compiledBinary,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(build.status, 0, `${build.stderr}\n${build.stdout}`);
    await chmod(compiledBinary, 0o700);
    return compiledBinary;
  })();
  const binary = await compilePromise;
  if (!binary) {
    t.skip(nativeSkipReason ?? "Native launcher fixture is unavailable.");
    return null;
  }
  return binary;
}

function inspectDockFixture(nativeBinary, plistPath, context) {
  const result = spawnSync(nativeBinary, ["dock-fixture-inspect", "--plist", plistPath, "--json"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assertNativeSuccess(result, context);
  assert.ok(result.stdout.endsWith("\n"), `${context}: expected newline-framed JSON`);
  return JSON.parse(result.stdout);
}

after(async () => {
  if (compileRoot) await rm(compileRoot, { recursive: true, force: true });
});

test("launcher fixture cleanup handles partial app construction and preserves the originating failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex launcher partial fixture "));
  const firstExecutable = join(
    root,
    "Fast Progress Fixture.app",
    "Contents/MacOS/CodexTaskProgressLauncher",
  );
  await mkdir(join(root, "Fast Progress Fixture.app", "Contents/MacOS"), { recursive: true });
  await writeFile(firstExecutable, "partial fixture\n");
  await assert.rejects(async () => {
    try {
      throw new Error("fixture construction failed");
    } finally {
      await cleanupLauncherFixture({ root });
    }
  }, /fixture construction failed/);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("LaunchServices acknowledges the managed app and its main run loop stays responsive during helper startup", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const nativeBinary = await nativeLauncherFor(t);
  if (!nativeBinary) return;
  const root = await mkdtemp(join(tmpdir(), "codex launcher lifecycle "));
  let openProcess;
  let completion;
  let release;
  try {
    const createAgentApp = async (name, bundleSuffix, helper, status) => {
      const app = join(root, `${name}.app`);
      const contents = join(app, "Contents");
      const executable = join(contents, "MacOS", "CodexTaskProgressLauncher");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await copyFile(nativeBinary, executable);
      await chmod(executable, 0o700);
      await writeFile(
        join(contents, "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>CodexTaskProgressLauncher</string><key>CFBundleIdentifier</key><string>com.codextaskprogress.fixture.${process.pid}.${bundleSuffix}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>TaskProgressHelperPath</key><string>${helper}</string><key>TaskProgressLauncherTestStatusPath</key><string>${status}</string></dict></plist>`,
      );
      return app;
    };
    const fastHelper = join(root, "fast helper");
    await writeFile(fastHelper, "#!/bin/sh\nexit 0\n");
    await chmod(fastHelper, 0o700);
    const fastApp = await createAgentApp(
      "Fast Progress Fixture",
      "fast",
      fastHelper,
      join(root, "fast status"),
    );
    const fastOpen = spawnSync("/usr/bin/open", ["-W", "-n", "-a", fastApp], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assertNativeSuccess(fastOpen, "LaunchServices open with a fast helper");
    assert.match(
      await readFile(join(root, "fast status"), "utf8"),
      /^launched \d+\n/,
      "fast launch must reach applicationDidFinishLaunching",
    );

    const app = await createAgentApp(
      "Progress Fixture",
      "delayed",
      join(root, "delayed helper"),
      join(root, "lifecycle status"),
    );
    const helper = join(root, "delayed helper");
    release = join(root, "release helper");
    const status = join(root, "lifecycle status");
    const helperProgram = `const fs = require("node:fs");
const release = ${JSON.stringify(release)};
const deadline = Date.now() + 20_000;
const poll = () => fs.existsSync(release) ? process.exit(0) : Date.now() > deadline ? process.exit(9) : setTimeout(poll, 25);
poll();`;
    await writeFile(
      helper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(helperProgram)}\n`,
    );
    await chmod(helper, 0o700);
    const open = spawn("/usr/bin/open", ["-W", "-n", "-a", app], { stdio: "ignore" });
    openProcess = open;
    completion = new Promise((resolve, reject) => {
      open.once("error", reject);
      open.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 10_000;
    let statusText = "";
    while (Date.now() < deadline) {
      try {
        statusText = await readFile(status, "utf8");
        if (statusText.includes("responsive")) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(
      statusText,
      /^launched \d+\nresponsive\n$/,
      "NSApplication launch and main-loop timer should run before helper release",
    );
    await writeFile(release, "release\n");
    const result = await completion;
    openProcess = undefined;
    assert.deepEqual(
      result,
      { code: 0, signal: null },
      "LaunchServices should receive a successful open acknowledgement and wait for app exit",
    );
  } finally {
    await cleanupLauncherFixture({ root, release, completion, openProcess });
  }
});

test("native launcher forwards structured helper arguments without shell parsing", async (t) => {
  const nativeBinary = await nativeLauncherFor(t);
  if (!nativeBinary) return;
  const root = await mkdtemp(join(tmpdir(), "codex launcher fixture "));
  try {
    const helper = join(root, "helper with spaces");
    await writeFile(
      helper,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    await chmod(helper, 0o700);
    const result = spawnSync(nativeBinary, ["fixture-launch", "--helper", helper, "--json"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assertNativeSuccess(result, "native fixture launch");
    assert.deepEqual(JSON.parse(result.stdout), ["launch", "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Dock fixture preserves unknown preferences and removes bookmarks for replaced Codex tiles", async (t) => {
  const nativeBinary = await nativeLauncherFor(t);
  if (!nativeBinary) return;
  const root = await mkdtemp(join(tmpdir(), "codex dock fixture "));
  try {
    const original = join(root, "Applications", "Codex App.app");
    const managed = join(root, "Applications", "Codex Task Progress.app");
    const fixture = join(root, "Dock before.plist");
    const transformed = join(root, "Dock after.plist");
    const receipt = join(root, "Dock receipt.plist");
    const restored = join(root, "Dock restored.plist");
    const customized = join(root, "Dock customized.plist");
    const retained = join(root, "Dock retained.plist");
    const repeated = join(root, "Dock repeated.plist");
    const noCanonical = join(root, "Dock without original.plist");
    const appended = join(root, "Dock appended.plist");
    const appendedAgain = join(root, "Dock appended again.plist");
    const refreshed = join(root, "Dock refreshed.plist");
    const cacheRestored = join(root, "Dock cache restored.plist");
    const userInserted = join(root, "Dock user inserted.plist");
    const insertedRetained = join(root, "Dock inserted retained.plist");
    const seed = spawnSync(
      nativeBinary,
      [
        "dock-fixture-seed",
        "--plist",
        fixture,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(seed, "seed Dock plist fixture");
    assert.ok(
      seed.stdout.endsWith("\n"),
      "seed Dock fixture response should be newline-framed JSON",
    );
    const plan = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        fixture,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        transformed,
        "--receipt-output",
        receipt,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(plan, "transform Dock plist fixture");
    assert.ok(plan.stdout.endsWith("\n"), "Dock plan response should be newline-framed JSON");
    assert.equal(JSON.parse(plan.stdout).replaced, 2);
    assert.equal(JSON.parse(plan.stdout).managedBookmarksCurrent, true);
    const repeat = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        transformed,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        repeated,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(repeat, "repeat Dock plist transform");
    assert.equal(JSON.parse(repeat.stdout).changed, false);
    assert.equal(JSON.parse(repeat.stdout).appended, false);
    const value = inspectDockFixture(nativeBinary, transformed, "inspect transformed Dock fixture");
    assert.deepEqual(value.unknownPreference, { must: "round-trip" });
    assert.deepEqual(value.persistentApps[3].unknownEntryValue, ["preserve", 9]);
    const entries = value.persistentApps;
    const managedEntries = entries.filter(
      (entry) => entry.bundleId === "com.codextaskprogress.codexlauncher",
    );
    assert.equal(managedEntries.length, 2);
    for (const entry of managedEntries) {
      assert.equal(entry.fileLabel, "Codex");
      assert.equal(entry.fileURL, new URL(`file://${managed}/`).href);
      assert.ok(entry.bookmarkBytes > 0);
      assert.equal(entry.bookmarkPath, managed);
      assert.deepEqual(entry.dockExtra, { unmodified: "preserve" });
    }
    assert.equal(entries[2].bundleId, "com.openai.codex");
    const restore = spawnSync(
      nativeBinary,
      [
        "dock-fixture-remove",
        "--plist",
        transformed,
        "--managed-app",
        managed,
        "--receipt",
        receipt,
        "--output-plist",
        restored,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(restore, "restore Dock plist fixture");
    assert.equal(JSON.parse(restore.stdout).keepManagedApp, false);
    const restoredEntries = inspectDockFixture(
      nativeBinary,
      restored,
      "inspect restored Dock fixture",
    ).persistentApps;
    assert.equal(restoredEntries.length, 4);
    assert.equal(restoredEntries[0].fileLabel, "ChatGPT");
    assert.equal(restoredEntries[1].fileLabel, "ChatGPT");
    assert.deepEqual(restoredEntries[3].unknownEntryValue, ["preserve", 9]);

    const renamed = join(root, "Applications", "Codex.app");
    await mkdir(renamed, { recursive: true });
    const migrated = join(root, "Dock migrated.plist");
    const migratedReceipt = join(root, "Dock migrated receipt.plist");
    const migratedRestored = join(root, "Dock migrated restored.plist");
    const migrateArgs = [
      "dock-fixture-migrate",
      "--plist",
      transformed,
      "--original-app",
      managed,
      "--managed-app",
      renamed,
      "--receipt",
      receipt,
      "--output-plist",
      migrated,
      "--receipt-output",
      migratedReceipt,
      "--json",
    ];
    assertNativeSuccess(
      spawnSync(nativeBinary, migrateArgs, { encoding: "utf8" }),
      "migrate legacy Dock receipt",
    );
    const migratedEntries = inspectDockFixture(
      nativeBinary,
      migrated,
      "inspect migrated Dock fixture",
    ).persistentApps;
    assert.equal(migratedEntries.length, entries.length);
    for (const index of [0, 1]) {
      assert.equal(migratedEntries[index].fileURL, new URL(`file://${renamed}/`).href);
      assert.equal(migratedEntries[index].bookmarkPath, renamed);
    }
    assertNativeSuccess(
      spawnSync(
        nativeBinary,
        [
          "dock-fixture-remove",
          "--plist",
          migrated,
          "--managed-app",
          renamed,
          "--receipt",
          migratedReceipt,
          "--output-plist",
          migratedRestored,
          "--json",
        ],
        { encoding: "utf8" },
      ),
      "restore original after migration",
    );
    assert.deepEqual(
      inspectDockFixture(nativeBinary, migratedRestored, "inspect migrated restore").persistentApps,
      restoredEntries,
    );
    const retry = spawnSync(
      nativeBinary,
      [...migrateArgs.slice(0, 2), migrated, ...migrateArgs.slice(3)],
      { encoding: "utf8" },
    );
    assert.notEqual(
      retry.status,
      0,
      "a migrated Dock must not be migrated a second time using the legacy receipt",
    );

    const repinned = join(root, "Dock repinned.plist");
    const repinRestored = join(root, "Dock repin restored.plist");
    const repin = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        transformed,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        repinned,
        "--append-original",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(repin, "repin original Dock tile");
    const repinRestore = spawnSync(
      nativeBinary,
      [
        "dock-fixture-remove",
        "--plist",
        repinned,
        "--managed-app",
        managed,
        "--receipt",
        receipt,
        "--output-plist",
        repinRestored,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(repinRestore, "restore after original repin");
    const repinEntries = inspectDockFixture(
      nativeBinary,
      repinRestored,
      "inspect repinned Dock fixture",
    ).persistentApps;
    assert.equal(repinEntries.length, 4);
    assert.equal(
      repinEntries.filter((entry) => entry.fileURL === new URL(`file://${original}/`).href).length,
      2,
    );
    assert.ok(repinEntries.some((entry) => entry.fileLabel === "Repinned Codex"));

    const remoteFixture = join(root, "Dock remote.plist");
    const remoteOutput = join(root, "Dock remote output.plist");
    const remoteSeed = spawnSync(
      nativeBinary,
      [
        "dock-fixture-seed",
        "--plist",
        remoteFixture,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--include-remote-original",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(remoteSeed, "seed remote file URL fixture");
    const remotePlan = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        remoteFixture,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        remoteOutput,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(remotePlan, "plan remote file URL fixture");
    assert.equal(JSON.parse(remotePlan.stdout).replaced, 2);
    const remoteEntries = inspectDockFixture(
      nativeBinary,
      remoteOutput,
      "inspect remote file URL fixture",
    ).persistentApps;
    assert.equal(remoteEntries.at(-1).bundleId, "com.openai.codex");
    assert.match(remoteEntries.at(-1).fileURL, /^file:\/\/remote-host\//);

    const refresh = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        transformed,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        refreshed,
        "--refresh-managed-caches",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(refresh, "refresh Dock metadata fixture");
    const cacheRestore = spawnSync(
      nativeBinary,
      [
        "dock-fixture-remove",
        "--plist",
        refreshed,
        "--managed-app",
        managed,
        "--receipt",
        receipt,
        "--output-plist",
        cacheRestored,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(cacheRestore, "restore Dock metadata fixture");
    assert.equal(JSON.parse(cacheRestore.stdout).keepManagedApp, false);

    const customize = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        fixture,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        customized,
        "--receipt-output",
        receipt,
        "--customize-managed-label",
        "My Codex",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(customize, "customize Dock tile fixture");
    const editedMigration = spawnSync(
      nativeBinary,
      [
        "dock-fixture-migrate",
        "--plist",
        customized,
        "--original-app",
        managed,
        "--managed-app",
        renamed,
        "--receipt",
        receipt,
        "--output-plist",
        join(root, "rejected migration.plist"),
        "--receipt-output",
        join(root, "rejected receipt.plist"),
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(editedMigration.status, 0, "customized legacy tile must remain untouched");
    const preserve = spawnSync(
      nativeBinary,
      [
        "dock-fixture-remove",
        "--plist",
        customized,
        "--managed-app",
        managed,
        "--receipt",
        receipt,
        "--output-plist",
        retained,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(preserve, "preserve customized Dock fixture");
    assert.equal(JSON.parse(preserve.stdout).keepManagedApp, true);
    assert.equal(
      inspectDockFixture(nativeBinary, retained, "inspect retained customized Dock fixture")
        .persistentApps[0].fileLabel,
      "My Codex",
    );

    const insert = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        transformed,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        userInserted,
        "--insert-unrelated-before-managed",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(insert, "insert unrelated Dock tile fixture");
    const insertRestore = spawnSync(
      nativeBinary,
      [
        "dock-fixture-remove",
        "--plist",
        userInserted,
        "--managed-app",
        managed,
        "--receipt",
        receipt,
        "--output-plist",
        insertedRetained,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(insertRestore, "preserve reordered Dock fixture");
    assert.equal(JSON.parse(insertRestore.stdout).keepManagedApp, true);
    assert.equal(
      inspectDockFixture(nativeBinary, insertedRetained, "inspect retained user Dock fixture")
        .persistentApps[0].bundleId,
      "com.example.user.app",
    );

    const seedWithoutOriginal = spawnSync(
      nativeBinary,
      [
        "dock-fixture-seed",
        "--plist",
        noCanonical,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--without-canonical",
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(seedWithoutOriginal, "seed unpinned Codex Dock fixture");
    const append = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        noCanonical,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        appended,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(append, "append managed Dock fixture tile");
    assert.equal(JSON.parse(append.stdout).appended, true);
    const appendAgain = spawnSync(
      nativeBinary,
      [
        "dock-fixture",
        "--plist",
        appended,
        "--original-app",
        original,
        "--managed-app",
        managed,
        "--output-plist",
        appendedAgain,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(appendAgain, "repeat appended Dock fixture plan");
    assert.equal(JSON.parse(appendAgain.stdout).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native launcher rejects unknown, duplicate, and cross-mode options with framed JSON", async (t) => {
  const nativeBinary = await nativeLauncherFor(t);
  if (!nativeBinary) return;
  for (const args of [
    ["dock-status", "--json", "--unexpected", "value"],
    ["dock-status", "--json", "--json"],
    ["dock-fixture-inspect", "--json", "--helper", "/bin/echo"],
  ]) {
    const result = spawnSync(nativeBinary, args, { encoding: "utf8", timeout: 15_000 });
    assert.equal(
      result.status,
      1,
      `expected invalid argument rejection: ${args.join(" ")}\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.endsWith("\n"),
      "invalid argument response should be newline-framed JSON",
    );
    assert.deepEqual(JSON.parse(result.stdout), { code: "LAUNCHER_ARGUMENT_INVALID", ok: false });
  }
});

test("ad-hoc signing accepts the staged managed app bundle shape", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex managed app signature "));
  const app = join(root, "Codex Task Progress.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  const executable = join(contents, "MacOS", "CodexTaskProgressLauncher");
  try {
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await copyFile("/usr/bin/true", executable);
    await chmod(executable, 0o700);
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>CodexTaskProgressLauncher</string><key>CFBundleIdentifier</key><string>com.codextaskprogress.codexlauncher</string><key>CFBundleName</key><string>Codex</string><key>CFBundleDisplayName</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
    );
    await writeFile(
      join(resources, ".codex-task-progress-managed.json"),
      JSON.stringify({ owner: "codex-task-progress-managed-launcher-v1" }),
    );
    const sign = spawnSync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", "com.codextaskprogress.codexlauncher", app],
      { encoding: "utf8", timeout: 15_000 },
    );
    assertNativeSuccess(sign, "sign managed app fixture");
    const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assertNativeSuccess(verify, "verify managed app fixture signature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
