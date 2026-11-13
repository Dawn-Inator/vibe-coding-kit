import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist/renderer");
const bundlePath = resolve(outputDirectory, "goal-progress.js");
const manifestPath = resolve(outputDirectory, "goal-progress.manifest.json");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const pageHostVersionManifest = JSON.parse(
  await readFile(resolve(root, "packages/contracts/src/page-host-version.json"), "utf8"),
);
const rendererBundlePolicy = JSON.parse(
  await readFile(resolve(root, "packages/contracts/src/renderer-bundle-policy.json"), "utf8"),
);
const maxBundleBytes = rendererBundlePolicy.rendererBundleMaxBytes;
if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes < 1) {
  throw new Error("GOAL_PROGRESS_RENDERER_BUNDLE_POLICY_INVALID");
}
const pageHostVersion = pageHostVersionManifest.pageHostVersion;
if (!Number.isSafeInteger(pageHostVersion) || pageHostVersion < 1) {
  throw new Error("GOAL_PROGRESS_PAGE_HOST_VERSION_INVALID");
}

const result = await build({
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  entryPoints: ["packages/codex-adapter/src/browser-entry.ts"],
  format: "iife",
  legalComments: "none",
  minify: true,
  outfile: bundlePath,
  platform: "browser",
  target: "chrome120",
  write: false,
});

const bundle = result.outputFiles[0]?.contents;
if (!bundle || bundle.byteLength === 0 || bundle.byteLength > maxBundleBytes) {
  throw new Error(`GOAL_PROGRESS_RENDERER_BUNDLE_SIZE_INVALID: ${bundle?.byteLength ?? 0}`);
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(bundlePath, bundle);
const manifest = {
  schemaVersion: 1,
  releaseVersion: packageJson.version,
  pageHostVersion,
  file: "goal-progress.js",
  bytes: bundle.byteLength,
  sha256: createHash("sha256").update(bundle).digest("hex"),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
