import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export const NODE_VERSION = "v24.19.0";
export const NODE_ARCHIVE_NAME = "node-v24.19.0-darwin-arm64.tar.gz";
const NODE_DIST = "https://nodejs.org/dist/v24.19.0";

function defaultCacheRoot() {
  return resolve(homedir(), ".cache/codex-task-progress");
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...options });
}

function binaryPath(runtimeRoot) {
  return resolve(runtimeRoot, "bin/node");
}

function checkVersion(binary, runner) {
  const result = runner(binary, ["--version"]);
  return result.status === 0 && result.stdout.trim() === NODE_VERSION;
}

async function responseBytes(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Official Node download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function checksumFromOfficialFile(contents, archiveName) {
  const line = contents.split(/\r?\n/u).find((candidate) => {
    const match = candidate.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/u);
    return match?.[2] === archiveName;
  });
  const digest = line?.match(/^([a-fA-F0-9]{64})\s+\*?/u)?.[1];
  if (!digest) throw new Error(`Official SHASUMS256.txt has no entry for ${archiveName}`);
  return digest.toLowerCase();
}

function assertSafeTarListing(listing) {
  const prefix = "node-v24.19.0-darwin-arm64/";
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("Verified Node archive is empty");
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")) {
      throw new Error(`Unsafe Node archive entry: ${entry}`);
    }
    const parts = entry.replace(/\/$/u, "").split("/");
    if (
      parts[0] !== "node-v24.19.0-darwin-arm64" ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe Node archive entry: ${entry}`);
    }
    if (!entry.startsWith(prefix) && entry !== "node-v24.19.0-darwin-arm64/") {
      throw new Error(`Unexpected Node archive root: ${entry}`);
    }
  }
}

export async function inspectPinnedNodeRuntime({
  suppliedBinary,
  cacheRoot,
  runner = defaultRun,
} = {}) {
  const runtimeRoot = resolve(
    cacheRoot ?? process.env.GOAL_PROGRESS_CACHE_ROOT ?? defaultCacheRoot(),
    "node-v24.19.0-darwin-arm64",
  );
  const suppliedValid = suppliedBinary ? checkVersion(suppliedBinary, runner) : false;
  const cached = binaryPath(runtimeRoot);
  const cachedBinary = checkVersion(cached, runner) ? cached : null;
  return {
    runtimeRoot,
    suppliedValid,
    cachedBinary,
    downloadAvailable: typeof fetch === "function",
  };
}

export async function ensurePinnedNodeRuntime({
  suppliedBinary,
  cacheRoot,
  fetchImpl = globalThis.fetch,
  runner = defaultRun,
  temporaryRoot = tmpdir(),
} = {}) {
  const inspection = await inspectPinnedNodeRuntime({ suppliedBinary, cacheRoot, runner });
  if (suppliedBinary && inspection.suppliedValid) {
    return {
      nodeBinary: resolve(suppliedBinary),
      runtimeRoot: inspection.runtimeRoot,
      source: "provided",
    };
  }
  if (!suppliedBinary && inspection.cachedBinary) {
    return {
      nodeBinary: inspection.cachedBinary,
      runtimeRoot: inspection.runtimeRoot,
      source: "private-cache",
    };
  }
  if (suppliedBinary) throw new Error(`GOAL_PROGRESS_NODE_BINARY must report ${NODE_VERSION}`);
  if (typeof fetchImpl !== "function")
    throw new Error("Fetching official Node runtime is unavailable");

  const cacheBase = dirname(inspection.runtimeRoot);
  await mkdir(cacheBase, { recursive: true, mode: 0o700 });
  const tempRoot = await mkdtemp(resolve(temporaryRoot, "goal-progress-node-"));
  const archivePath = resolve(tempRoot, NODE_ARCHIVE_NAME);
  const extractRoot = resolve(tempRoot, "extract");
  try {
    const [checksums, archive] = await Promise.all([
      responseBytes(fetchImpl, `${NODE_DIST}/SHASUMS256.txt`),
      responseBytes(fetchImpl, `${NODE_DIST}/${NODE_ARCHIVE_NAME}`),
    ]);
    const expected = checksumFromOfficialFile(checksums.toString("utf8"), NODE_ARCHIVE_NAME);
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expected)
      throw new Error(
        `Official Node archive SHA-256 mismatch: expected ${expected}; received ${actual}`,
      );
    await writeFile(archivePath, archive, { mode: 0o600 });
    await mkdir(extractRoot, { mode: 0o700 });
    const listing = runner("/usr/bin/tar", ["-tzf", archivePath]);
    if (listing.status !== 0)
      throw new Error(`Verified Node archive listing failed (${listing.status})`);
    assertSafeTarListing(listing.stdout);
    const extracted = runner("/usr/bin/tar", [
      "--no-same-owner",
      "--no-same-permissions",
      "-xzf",
      archivePath,
      "-C",
      extractRoot,
      "--strip-components=1",
    ]);
    if (extracted.status !== 0)
      throw new Error(`Verified Node archive extraction failed (${extracted.status})`);
    const stagedBinary = resolve(extractRoot, "bin/node");
    if (!checkVersion(stagedBinary, runner))
      throw new Error(`Downloaded Node binary did not report ${NODE_VERSION}`);
    await chmod(stagedBinary, 0o755);
    const stagedRoot = resolve(tempRoot, "node-v24.19.0-darwin-arm64");
    await rename(extractRoot, stagedRoot);
    const previous = resolve(tempRoot, "previous-runtime");
    try {
      await rename(inspection.runtimeRoot, previous);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagedRoot, inspection.runtimeRoot);
    } catch (error) {
      try {
        await rename(previous, inspection.runtimeRoot);
      } catch {
        /* preserve original failure */
      }
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    const finalBinary = binaryPath(inspection.runtimeRoot);
    if (!checkVersion(finalBinary, runner))
      throw new Error(`Cached Node binary did not report ${NODE_VERSION}`);
    return {
      nodeBinary: finalBinary,
      runtimeRoot: inspection.runtimeRoot,
      source: "downloaded-official",
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export { assertSafeTarListing, checksumFromOfficialFile };
