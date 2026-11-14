import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePinnedNodeRuntime, inspectPinnedNodeRuntime } from "./release-node-runtime.mjs";
import {
  configureReleaseSigning,
  defaultReleaseSigningConfigPath,
  inspectReleaseSigning,
} from "./release-signing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = resolve(root, "dist/release/macos-arm64/bin/goal-progress");
const pnpmVersion = "11.19.0";
const cliArgs = process.argv.slice(2);
const check = cliArgs.includes("--check");
const configureSigning = cliArgs.includes("--configure-signing");
const configureIdentityIndex = cliArgs.indexOf("--identity");
const configureIdentity =
  configureIdentityIndex < 0 ? undefined : cliArgs[configureIdentityIndex + 1];
const replaceSigning = cliArgs.includes("--replace-signing");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function logResult(label, result) {
  if (result.stdout) process.stderr.write(`${label} stdout:\n${result.stdout}`);
  if (result.stderr) process.stderr.write(`${label} stderr:\n${result.stderr}`);
}

function emit(value, code = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = code;
}

function resultError(result) {
  return result.error?.message ?? `exit ${result.status ?? "unknown"}`;
}

export function createCommandPlan({ dependenciesInstalled }) {
  return [
    ...(!dependenciesInstalled ? [["install", "--frozen-lockfile"]] : []),
    ["run", "build:code"],
    ["run", "build:renderer"],
    ["run", "build:plugin"],
    ["exec", "tsx", "scripts/build_macos_release.ts"],
  ];
}

export function installerNeedsRestart(output) {
  return (
    output?.code === "INSTALL_RESTART_REQUIRED" ||
    output?.code === "INSTALL_PENDING" ||
    output?.code === "INSTALL_RESTART_PENDING" ||
    output?.restartRequired === true ||
    output?.needsRestart === true ||
    output?.details?.restartScheduled === true ||
    output?.details?.restartRequired === true ||
    output?.details?.needsRestart === true
  );
}

export function classifyInstallerResult(exitCode, output) {
  if (exitCode !== 0) return { status: "error", reason: `Installer exited with code ${exitCode}` };
  if (installerNeedsRestart(output)) {
    return { status: "setup-required", reason: "Installation is pending a Codex restart." };
  }
  if (output?.ok === true && output?.code === "INSTALL_OK") return { status: "installed" };
  return { status: "error", reason: "Installer response did not confirm INSTALL_OK." };
}

function validNode(binary, runner = run) {
  if (!binary) return false;
  const result = runner(binary, ["--version"]);
  return result.status === 0 && result.stdout.trim() === "v24.19.0";
}

function componentDependenciesInstalled() {
  return ["esbuild", "tsx", "postject"].every((name) =>
    existsSync(resolve(root, "node_modules", name)),
  );
}

async function resolvePnpm(nodeBinary, runtimeRoot, runner = run, baseEnv = process.env) {
  const privatePrefix = resolve(runtimeRoot, "pnpm");
  const pnpmCli = resolve(privatePrefix, "node_modules/pnpm/bin/pnpm.cjs");
  if (!existsSync(pnpmCli)) {
    const npmCli = resolve(dirname(nodeBinary), "..", "lib/node_modules/npm/bin/npm-cli.js");
    if (!existsSync(npmCli))
      throw new Error("Private Node runtime does not include npm for pinned pnpm bootstrap");
    await mkdir(privatePrefix, { recursive: true });
    const installed = runner(
      nodeBinary,
      [
        npmCli,
        "install",
        "--prefix",
        privatePrefix,
        "--no-save",
        "--package-lock=false",
        `pnpm@${pnpmVersion}`,
      ],
      {
        env: {
          ...baseEnv,
          PATH: `${dirname(nodeBinary)}:${baseEnv.PATH ?? ""}`,
          npm_config_cache: resolve(runtimeRoot, "npm-cache"),
        },
      },
    );
    logResult("Pinned pnpm bootstrap", installed);
    if (installed.status !== 0 || !existsSync(pnpmCli))
      throw new Error(`Pinned pnpm bootstrap failed (${resultError(installed)})`);
  }
  const env = {
    ...baseEnv,
    PATH: `${dirname(nodeBinary)}:${baseEnv.PATH ?? ""}`,
    PNPM_HOME: resolve(runtimeRoot, "pnpm-home"),
    npm_config_cache: resolve(runtimeRoot, "npm-cache"),
    COREPACK_HOME: resolve(runtimeRoot, "corepack"),
    GOAL_PROGRESS_NODE_BINARY: nodeBinary,
    GOAL_PROGRESS_RELEASE_NODE_BINARY: nodeBinary,
  };
  const version = runner(nodeBinary, [pnpmCli, "--version"], { env });
  if (version.status !== 0 || version.stdout.trim() !== pnpmVersion) {
    throw new Error(
      `Pinned pnpm version check failed: expected ${pnpmVersion}; ${resultError(version)} ${version.stdout.trim()}`,
    );
  }
  return { pnpmCli, env };
}

async function main(options = {}) {
  const runner = options.run ?? run;
  const emitResult = options.emit ?? emit;
  const env = options.env ?? process.env;
  const home = options.home;
  const isCheck = options.check ?? check;
  if (options.configureSigning ?? configureSigning) {
    try {
      if (!options.identity && !configureIdentity) {
        throw new Error("GOAL_PROGRESS_CODESIGN_FINGERPRINT_REQUIRED");
      }
      const configured = await configureReleaseSigning({
        identity: options.identity ?? configureIdentity,
        replace: options.replaceSigning ?? replaceSigning,
        home,
        runner: options.signingRunner ?? runner,
        readFileImpl: options.readFileImpl,
        mkdirImpl: options.mkdirImpl,
        writeFileImpl: options.writeFileImpl,
        renameImpl: options.renameImpl,
        rmImpl: options.rmImpl,
      });
      emitResult({
        ...configured,
        signing: await inspectReleaseSigning({
          env: {},
          home,
          runner: options.signingRunner ?? runner,
          readFileImpl: options.readFileImpl,
        }),
      });
    } catch (error) {
      emitResult(
        {
          status: "setup-required",
          reason: error instanceof Error ? error.message : String(error),
        },
        1,
      );
    }
    return;
  }

  let signing;
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      signing = await inspectReleaseSigning({
        env,
        home,
        runner: options.signingRunner ?? runner,
        readFileImpl: options.readFileImpl,
      });
    } catch (error) {
      signing = {
        status: "unavailable",
        candidates: [],
        configPath: defaultReleaseSigningConfigPath(home),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    signing = {
      status: "unavailable",
      candidates: [],
      configPath: defaultReleaseSigningConfigPath(home),
    };
  }

  if (!isCheck && signing.status !== "ready") {
    emitResult(
      {
        status: "setup-required",
        signing,
        reason:
          signing.status === "confirmation-required"
            ? "Choose an eligible Apple signing identity before installing the macOS release."
            : "No eligible configured Apple signing identity is available.",
        configureCommand:
          "node scripts/install-from-kit.mjs --configure-signing --identity <40HEX>",
      },
      1,
    );
    return;
  }

  const inspectRuntime = options.inspectPinnedNodeRuntime ?? inspectPinnedNodeRuntime;
  const ensureRuntime = options.ensurePinnedNodeRuntime ?? ensurePinnedNodeRuntime;
  const runtimeInspection = await inspectRuntime({
    suppliedBinary: env.GOAL_PROGRESS_NODE_BINARY,
    cacheRoot: options.cacheRoot ?? env.GOAL_PROGRESS_CACHE_ROOT,
    runner,
  });
  const supplied = env.GOAL_PROGRESS_NODE_BINARY;
  const nodeReady = supplied
    ? validNode(supplied, runner)
    : runtimeInspection.cachedBinary !== null;
  const pnpmCli = resolve(runtimeInspection.runtimeRoot, "pnpm/node_modules/pnpm/bin/pnpm.cjs");
  const checkNode = runtimeInspection.suppliedValid ? supplied : runtimeInspection.cachedBinary;
  const checkPnpm =
    checkNode && existsSync(pnpmCli)
      ? runner(checkNode, [pnpmCli, "--version"], {
          env: { ...env, PATH: `${dirname(checkNode)}:${env.PATH ?? ""}` },
        })
      : null;
  const pnpmReady = checkPnpm?.status === 0 && checkPnpm.stdout.trim() === pnpmVersion;
  const prerequisites = {
    platform: process.platform === "darwin" && process.arch === "arm64",
    node: nodeReady,
    pnpm: pnpmReady,
    pnpmVersion: pnpmReady ? pnpmVersion : null,
    dependencies: componentDependenciesInstalled(),
    releaseRebuildRequired: true,
    releaseReuseReason:
      "A release is reusable only when its source manifest proves the current tree; no matching provenance is available.",
  };

  if (!prerequisites.platform) {
    emitResult(
      {
        status: "setup-required",
        prerequisites,
        signing,
        reason: "The Goal Progress release installer requires macOS arm64.",
      },
      isCheck ? 0 : 1,
    );
    return;
  }
  if (isCheck) {
    emitResult({
      status:
        prerequisites.dependencies && prerequisites.pnpm && nodeReady && signing.status === "ready"
          ? "ready-to-build"
          : "setup-required",
      prerequisites,
      signing,
      node: runtimeInspection.suppliedValid
        ? "provided"
        : runtimeInspection.cachedBinary
          ? "private-cache"
          : "will-download-official-node-24.19.0",
      command: "node scripts/install-from-kit.mjs",
    });
    return;
  }

  try {
    const runtime = await ensureRuntime({
      suppliedBinary: supplied,
      cacheRoot: options.cacheRoot ?? env.GOAL_PROGRESS_CACHE_ROOT,
      fetchImpl: options.fetchImpl,
      runner,
    });
    const nodeBinary = runtime.nodeBinary;
    const resolveBuildPnpm = options.resolvePnpm ?? resolvePnpm;
    const { pnpmCli, env: buildEnv } = await resolveBuildPnpm(
      nodeBinary,
      runtime.runtimeRoot,
      runner,
      env,
    );
    const hasDependencies =
      options.componentDependenciesInstalled ?? componentDependenciesInstalled;
    if (!hasDependencies()) {
      const installed = runner(nodeBinary, [pnpmCli, "install", "--frozen-lockfile"], {
        env: buildEnv,
      });
      logResult("Component dependency install", installed);
      if (installed.status !== 0)
        throw new Error(`Component pnpm install failed (${resultError(installed)})`);
    }
    for (const step of createCommandPlan({
      dependenciesInstalled: hasDependencies(),
    }).filter((item) => item[0] !== "install")) {
      const args = [pnpmCli, ...step];
      const built = runner(nodeBinary, args, { env: buildEnv });
      logResult(`Build ${args.slice(1).join(" ")}`, built);
      if (built.status !== 0)
        throw new Error(
          `Release build command failed (${resultError(built)}): ${args.slice(1).join(" ")}`,
        );
    }
    if (!(options.installerExists ?? existsSync(installer)))
      throw new Error("Release build completed without producing the installer binary");
    const installed = runner(installer, ["install", "--json"]);
    logResult("Release installer", { ...installed, stdout: "" });
    let output;
    try {
      output = JSON.parse(installed.stdout);
    } catch {
      throw new Error(
        `Installer did not return JSON (${resultError(installed)}): ${(installed.stderr || installed.stdout || "").slice(-3000)}`,
      );
    }
    const installResult = classifyInstallerResult(installed.status, output);
    if (installResult.status !== "installed") {
      emitResult({ ...installResult, output }, 1);
      return;
    }
    emitResult({ status: "installed", output });
  } catch (error) {
    emitResult(
      { status: "setup-required", reason: error instanceof Error ? error.message : String(error) },
      1,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { main, resolvePnpm };
