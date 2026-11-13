import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyInstallerResult,
  createCommandPlan,
  installerNeedsRestart,
} from "../scripts/install-from-kit.mjs";
import {
  checksumFromOfficialFile,
  ensurePinnedNodeRuntime,
  inspectPinnedNodeRuntime,
  NODE_ARCHIVE_NAME,
  NODE_VERSION,
} from "../scripts/release-node-runtime.mjs";

const script = fileURLToPath(new URL("../scripts/install-from-kit.mjs", import.meta.url));

test("Kit installer check reports one JSON document without installing", () => {
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(["ready-to-build", "setup-required"].includes(report.status));
  assert.equal(typeof report.prerequisites.node, "boolean");
  assert.equal(report.prerequisites.releaseRebuildRequired, true);
});

test("pinned Node checksum is checked before tar extraction and temporary files are cleaned", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const temporaryRoot = resolve(sandbox, "temporary");
  await mkdir(temporaryRoot);
  let request = 0;
  let tarWasCalled = false;
  const archive = Buffer.from("not-the-official-archive");
  const fetchImpl = async (url) => {
    request += 1;
    const isChecksumFile = url.endsWith("/SHASUMS256.txt");
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        isChecksumFile ? Buffer.from(`${"0".repeat(64)}  ${NODE_ARCHIVE_NAME}\n`) : archive,
    };
  };
  try {
    await assert.rejects(
      ensurePinnedNodeRuntime({
        cacheRoot,
        temporaryRoot,
        fetchImpl,
        runner: (command) => {
          if (command === "/usr/bin/tar") tarWasCalled = true;
          return { status: 99, stdout: "", stderr: "" };
        },
      }),
      /SHA-256 mismatch/u,
    );
    assert.equal(request, 2);
    assert.equal(tarWasCalled, false);
    assert.deepEqual(await readdir(temporaryRoot), []);
    await assert.rejects(readFile(resolve(cacheRoot, "node-v24.19.0-darwin-arm64/bin/node")));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("matching cached Node runtime is reused without network access", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const runtimeRoot = resolve(cacheRoot, "node-v24.19.0-darwin-arm64");
  const binary = resolve(runtimeRoot, "bin/node");
  await mkdir(resolve(runtimeRoot, "bin"), { recursive: true });
  const runner = (command, args) => ({
    status: 0,
    stdout: command === binary && args[0] === "--version" ? `${NODE_VERSION}\n` : "",
    stderr: "",
  });
  try {
    const inspected = await inspectPinnedNodeRuntime({ cacheRoot, runner });
    assert.equal(inspected.cachedBinary, binary);
    const result = await ensurePinnedNodeRuntime({
      cacheRoot,
      runner,
      fetchImpl: async () => {
        throw new Error("cache hit must not fetch");
      },
    });
    assert.equal(result.nodeBinary, binary);
    assert.equal(result.source, "private-cache");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("official Node archive is extracted into one cache root and that exact binary is reused", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const temporaryRoot = resolve(sandbox, "temporary");
  await mkdir(temporaryRoot);
  const archive = Buffer.from("verified archive fixture");
  const digest = createHash("sha256").update(archive).digest("hex");
  let downloads = 0;
  const fetchImpl = async (url) => {
    downloads += 1;
    const body = url.endsWith("/SHASUMS256.txt")
      ? Buffer.from(`${digest}  ${NODE_ARCHIVE_NAME}\n`)
      : archive;
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
  const runner = (command, args) => {
    if (command === "/usr/bin/tar" && args[0] === "-tzf") {
      return {
        status: 0,
        stdout:
          "node-v24.19.0-darwin-arm64/\nnode-v24.19.0-darwin-arm64/bin/\nnode-v24.19.0-darwin-arm64/bin/node\n",
        stderr: "",
      };
    }
    if (command === "/usr/bin/tar" && args.includes("-xzf")) {
      const extractRoot = args[args.indexOf("-C") + 1];
      mkdirSync(resolve(extractRoot, "bin"), { recursive: true });
      writeFileSync(resolve(extractRoot, "bin/node"), "verified Node fixture");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--version" && existsSync(command)) {
      return { status: 0, stdout: `${NODE_VERSION}\n`, stderr: "" };
    }
    return { status: 98, stdout: "", stderr: "unexpected fixture command" };
  };
  try {
    const downloaded = await ensurePinnedNodeRuntime({
      cacheRoot,
      temporaryRoot,
      fetchImpl,
      runner,
    });
    const expectedRuntimeRoot = resolve(cacheRoot, "node-v24.19.0-darwin-arm64");
    const expectedBinary = resolve(expectedRuntimeRoot, "bin/node");
    assert.equal(downloaded.source, "downloaded-official");
    assert.equal(downloaded.runtimeRoot, expectedRuntimeRoot);
    assert.equal(downloaded.nodeBinary, expectedBinary);
    assert.equal(await readFile(expectedBinary, "utf8"), "verified Node fixture");
    assert.deepEqual(await readdir(temporaryRoot), []);

    const reused = await ensurePinnedNodeRuntime({
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("cached runtime must not download again");
      },
      runner,
    });
    assert.equal(reused.source, "private-cache");
    assert.equal(reused.nodeBinary, expectedBinary);
    assert.equal(downloads, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("missing component dependencies put frozen pnpm install before the build plan", () => {
  assert.deepEqual(createCommandPlan({ dependenciesInstalled: false }), [
    ["install", "--frozen-lockfile"],
    ["run", "build:code"],
    ["run", "build:renderer"],
    ["run", "build:plugin"],
    ["exec", "tsx", "scripts/build_macos_release.ts"],
  ]);
  assert.equal(
    createCommandPlan({ dependenciesInstalled: true }).some((step) => step[0] === "install"),
    false,
  );
});

test("installer reports success only for the explicit INSTALL_OK contract", () => {
  assert.deepEqual(classifyInstallerResult(0, { ok: true, code: "INSTALL_OK" }), {
    status: "installed",
  });
  assert.equal(classifyInstallerResult(0, { ok: false, code: "INSTALL_FAILED" }).status, "error");
  assert.equal(classifyInstallerResult(0, { ok: true, code: "OTHER" }).status, "error");
  assert.equal(classifyInstallerResult(1, { ok: true, code: "INSTALL_OK" }).status, "error");
});

test("restart-required or pending install responses remain setup-required without a Codex restart", () => {
  for (const output of [
    { code: "INSTALL_RESTART_REQUIRED" },
    { code: "INSTALL_PENDING" },
    { code: "INSTALL_RESTART_PENDING" },
    { details: { restartScheduled: true } },
    { details: { restartRequired: true } },
    { details: { needsRestart: true } },
  ]) {
    assert.equal(installerNeedsRestart(output), true);
    assert.equal(classifyInstallerResult(0, output).status, "setup-required");
  }
  assert.equal(classifyInstallerResult(0, { status: "installed" }).status, "error");
  const plan = createCommandPlan({ dependenciesInstalled: true }).flat().join(" ");
  assert.doesNotMatch(plan, /restart|quit|killall|open -a/u);
});

test("archive digest fixture uses the exact official filename", () => {
  const digest = createHash("sha256").update("fixture").digest("hex");
  assert.equal(
    checksumFromOfficialFile(`${digest}  ${NODE_ARCHIVE_NAME}\n`, NODE_ARCHIVE_NAME),
    digest,
  );
  assert.throws(
    () => checksumFromOfficialFile(`${digest}  other.tar.gz\n`, NODE_ARCHIVE_NAME),
    /no entry/u,
  );
});
