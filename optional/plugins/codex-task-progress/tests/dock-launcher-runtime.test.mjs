import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      ["swiftc", "-O", "-framework", "AppKit", source, "-o", compiledBinary],
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
