import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../../packages/contracts/src/index.js";
import { GoalProgressIpcClient } from "../../../packages/ipc/src/index.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  resolveGoalProgressPaths,
} from "../../../packages/store/src/index.js";
import { requireSingleCodexMacosApp } from "./app-discovery.js";
import type { MacosCommandName, MacosCommandResult } from "./command-protocol.js";
import { GOAL_PROGRESS_LAUNCH_AGENT_LABEL } from "./install-layout.js";
import { inspectInstalledHelper, nativeVerification } from "./installed-inspection.js";
import {
  createLaunchAgentController,
  launchdPlist,
  writeIfChanged,
} from "./launch-agent-controller.js";
import { stableErrorCode } from "./macos-errors.js";
import {
  inspectNativeMcpFeature,
  retireLegacyControlFiles,
} from "./native-install-prerequisites.js";
import { resolveVerifiedCodexCli } from "./plugin-controller.js";

const SOURCE_RUNTIME_ENSURE_COMMAND = "__source-runtime-ensure";

interface SourceRuntimeConfiguration {
  readonly pluginDataRoot: string;
  readonly codexHome: string;
  readonly marketplace: string | null;
  readonly pluginRoot: string | null;
  readonly sourceRuntimeRoot: string;
  readonly helperLauncherPath: string;
  readonly bundlePath: string;
}

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error(`GOAL_PROGRESS_SOURCE_RUNTIME_ENV_INVALID: ${name}`);
  }
  return resolve(value);
}

function optionalEnvironment(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function optionalAbsoluteEnvironment(name: string): string | null {
  const value = optionalEnvironment(name);
  if (value === null) {
    return null;
  }
  if (!isAbsolute(value)) {
    throw new Error(`GOAL_PROGRESS_SOURCE_RUNTIME_ENV_INVALID: ${name}`);
  }
  return resolve(value);
}

function sourceRuntimeConfiguration(): SourceRuntimeConfiguration {
  const pluginDataRoot = requiredAbsoluteEnvironment("GOAL_PROGRESS_PLUGIN_DATA");
  const goalProgressRoot = requiredAbsoluteEnvironment("GOAL_PROGRESS_ROOT");
  const codexHome = requiredAbsoluteEnvironment("GOAL_PROGRESS_CODEX_HOME");
  const sourceRuntimeRoot = requiredAbsoluteEnvironment("GOAL_PROGRESS_SOURCE_RUNTIME_ROOT");
  const helperLauncherPath = requiredAbsoluteEnvironment("GOAL_PROGRESS_SOURCE_LAUNCHER");
  const bundlePath = requiredAbsoluteEnvironment("GOAL_PROGRESS_SOURCE_BUNDLE");
  if (
    goalProgressRoot !== pluginDataRoot ||
    !isInside(pluginDataRoot, sourceRuntimeRoot) ||
    !isInside(sourceRuntimeRoot, helperLauncherPath) ||
    !isInside(sourceRuntimeRoot, bundlePath)
  ) {
    throw new Error("GOAL_PROGRESS_SOURCE_RUNTIME_PATH_MISMATCH");
  }
  return {
    pluginDataRoot,
    codexHome,
    marketplace: optionalEnvironment("GOAL_PROGRESS_PLUGIN_MARKETPLACE"),
    pluginRoot: optionalAbsoluteEnvironment("GOAL_PROGRESS_PLUGIN_ROOT"),
    sourceRuntimeRoot,
    helperLauncherPath,
    bundlePath,
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return (
    child === parent || (child.startsWith(`${parent}${sep}`) && !relative.includes(`..${sep}`))
  );
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function copyLegacyDirectoryIfTargetEmpty(source: string, target: string): Promise<boolean> {
  if (await directoryHasEntries(target)) {
    return false;
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(source);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  if (!metadata.isDirectory()) {
    return false;
  }
  const staging = resolve(
    dirname(target),
    `.${basename(target)}.migration-${process.pid}-${randomUUID()}`,
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    await chmod(staging, 0o700);
    if (await directoryHasEntries(target)) {
      return false;
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function replaceWithLegacyDirectory(source: string, target: string): Promise<boolean> {
  try {
    const metadata = await stat(source);
    if (!metadata.isDirectory()) {
      return false;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, { recursive: true, force: true });
  return true;
}

function launchAgentService(): string {
  return `gui/${process.getuid?.() ?? 0}/${GOAL_PROGRESS_LAUNCH_AGENT_LABEL}`;
}

function currentLaunchAgentText(): string {
  const result = spawnSync("/bin/launchctl", ["print", launchAgentService()], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0
    ? `${result.stdout ?? ""}
${result.stderr ?? ""}`
    : "";
}

function bootoutCurrentLaunchAgent(): void {
  const result = spawnSync("/bin/launchctl", ["bootout", launchAgentService()], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 && currentLaunchAgentText()) {
    throw new Error("GOAL_PROGRESS_SOURCE_LEGACY_HELPER_STOP_FAILED");
  }
}

async function waitForSocketRemoval(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(socketPath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("GOAL_PROGRESS_SOURCE_LEGACY_HELPER_STOP_TIMEOUT");
}

async function helperIsReady(socketPath: string): Promise<boolean> {
  try {
    const client = new GoalProgressIpcClient(socketPath, {
      clientKind: "doctor",
      timeoutMs: 750,
    });
    const response = await client.request({ method: "ping", params: {} });
    return (
      response.result !== null &&
      typeof response.result === "object" &&
      "status" in response.result &&
      response.result.status === "ok" &&
      "ready" in response.result &&
      response.result.ready === true
    );
  } catch {
    return false;
  }
}

async function waitForHelper(socketPath: string): Promise<void> {
  for (const delayMs of [0, 100, 250, 500, 1_000, 2_000, 4_000]) {
    if (delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    if (await helperIsReady(socketPath)) {
      return;
    }
  }
  throw new Error("GOAL_PROGRESS_SOURCE_HELPER_START_TIMEOUT");
}

export interface SourceRuntimeEnsureResult {
  readonly schemaVersion: 1;
  readonly command: typeof SOURCE_RUNTIME_ENSURE_COMMAND;
  readonly ok: true;
  readonly migratedState: boolean;
  readonly migratedPreferences: boolean;
  readonly launchAgentChanged: boolean;
}

export async function ensureSourceRuntime(): Promise<SourceRuntimeEnsureResult> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("GOAL_PROGRESS_SOURCE_RUNTIME_MACOS_ARM64_REQUIRED");
  }
  const configuration = sourceRuntimeConfiguration();
  const {
    pluginDataRoot,
    codexHome,
    marketplace,
    sourceRuntimeRoot,
    helperLauncherPath,
    bundlePath,
  } = configuration;
  const goalProgressRoot = pluginDataRoot;
  await Promise.all([
    access(helperLauncherPath, constants.X_OK),
    access(bundlePath, constants.R_OK),
  ]);

  const paths = resolveGoalProgressPaths({ root: goalProgressRoot });
  await Promise.all([
    ensurePrivateDirectory(pluginDataRoot),
    ensurePrivateDirectory(paths.runtimeRoot),
    ensurePrivateDirectory(paths.logsRoot),
    ensurePrivateDirectory(paths.preferencesRoot),
  ]);

  const legacyRoot = resolve(homedir(), "Library/Application Support/CodexTaskProgress");
  const legacyPaths = resolveGoalProgressPaths({ root: legacyRoot });
  const legacyBinary = resolve(legacyRoot, "install/current/bin/goal-progress");
  const launchAgentPath = resolve(
    homedir(),
    "Library/LaunchAgents",
    `${GOAL_PROGRESS_LAUNCH_AGENT_LABEL}.plist`,
  );
  const launchAgentBefore = currentLaunchAgentText();
  const switchingFromLegacy = launchAgentBefore.includes(legacyBinary);
  let previousLaunchAgent: string | null = null;
  try {
    previousLaunchAgent = await readFile(launchAgentPath, "utf8");
  } catch {
    previousLaunchAgent = null;
  }
  const launchAgent = createLaunchAgentController();
  const restorePreviousLaunchAgent = async (): Promise<void> => {
    // The previous owner can be either a SEA release or a source-built release.
    if (previousLaunchAgent === null) {
      await launchAgent.remove(GOAL_PROGRESS_LAUNCH_AGENT_LABEL, launchAgentPath);
      await rm(launchAgentPath, { force: true });
      return;
    }
    await atomicWriteFile(launchAgentPath, previousLaunchAgent);
    await chmod(launchAgentPath, 0o600);
    if (launchAgentBefore) {
      await launchAgent.ensure(GOAL_PROGRESS_LAUNCH_AGENT_LABEL, launchAgentPath, true);
    } else {
      await launchAgent.remove(GOAL_PROGRESS_LAUNCH_AGENT_LABEL, launchAgentPath);
    }
  };
  const rollback = async (cause: unknown): Promise<never> => {
    try {
      await restorePreviousLaunchAgent();
    } catch (restoreError) {
      throw new Error(`GOAL_PROGRESS_SOURCE_ROLLBACK_FAILED: ${stableErrorCode(restoreError)}`, {
        cause,
      });
    }
    throw cause;
  };
  let migratedState = false;
  let migratedPreferences = false;
  try {
    if (switchingFromLegacy) {
      bootoutCurrentLaunchAgent();
      await waitForSocketRemoval(legacyPaths.helperSocketPath);
    }
    [migratedState, migratedPreferences] = switchingFromLegacy
      ? await Promise.all([
          replaceWithLegacyDirectory(legacyPaths.stateRoot, paths.stateRoot),
          replaceWithLegacyDirectory(legacyPaths.preferencesRoot, paths.preferencesRoot),
        ])
      : await Promise.all([
          copyLegacyDirectoryIfTargetEmpty(legacyPaths.stateRoot, paths.stateRoot),
          copyLegacyDirectoryIfTargetEmpty(legacyPaths.preferencesRoot, paths.preferencesRoot),
        ]);
  } catch (error) {
    return rollback(error);
  }
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o700 });
  const plist = launchdPlist({
    label: GOAL_PROGRESS_LAUNCH_AGENT_LABEL,
    programArguments: [helperLauncherPath, "serve"],
    environment: {
      HOME: homedir(),
      GOAL_PROGRESS_ROOT: goalProgressRoot,
      GOAL_PROGRESS_PLUGIN_DATA: pluginDataRoot,
      GOAL_PROGRESS_SOURCE_RUNTIME: "1",
      GOAL_PROGRESS_SOURCE_RUNTIME_ROOT: sourceRuntimeRoot,
      GOAL_PROGRESS_SOURCE_LAUNCHER: helperLauncherPath,
      GOAL_PROGRESS_SOURCE_BUNDLE: bundlePath,
      GOAL_PROGRESS_CODEX_HOME: codexHome,
      ...(marketplace ? { GOAL_PROGRESS_PLUGIN_MARKETPLACE: marketplace } : {}),
      ...(configuration.pluginRoot ? { GOAL_PROGRESS_PLUGIN_ROOT: configuration.pluginRoot } : {}),
    },
    runAtLoad: true,
    keepAlive: true,
    standardOutPath: paths.helperLogPath,
    standardErrorPath: resolve(paths.logsRoot, "helper-error.log"),
  });
  let launchAgentChanged = false;
  try {
    launchAgentChanged = await writeIfChanged(launchAgentPath, plist);
    await chmod(launchAgentPath, 0o600);
    const helperReadyBefore = await helperIsReady(paths.helperSocketPath);
    await launchAgent.ensure(
      GOAL_PROGRESS_LAUNCH_AGENT_LABEL,
      launchAgentPath,
      launchAgentChanged || !helperReadyBefore,
    );
    await waitForHelper(paths.helperSocketPath);
  } catch (error) {
    return rollback(error);
  }
  await retireLegacyControlFiles(pluginDataRoot);
  if (legacyRoot !== pluginDataRoot) await retireLegacyControlFiles(legacyRoot);
  return {
    schemaVersion: 1,
    command: SOURCE_RUNTIME_ENSURE_COMMAND,
    ok: true,
    migratedState,
    migratedPreferences,
    launchAgentChanged,
  };
}

interface SourceRuntimeFileRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface SourceRuntimeManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly nodeVersion: string;
  readonly builtAt: string;
  readonly files: Readonly<Record<string, SourceRuntimeFileRecord>>;
}

const SOURCE_RUNTIME_REQUIRED_FILES = [
  "bin/goal-progress",
  "bin/goal-progress.cjs",
  "bin/node-runtime.sh",
  "assets/task-progress-panel.html",
] as const;

function validSourceRuntimeRecord(value: unknown): value is SourceRuntimeFileRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    !isAbsolute(value.path) &&
    !value.path.split(/[\\/]/u).includes("..") &&
    "bytes" in value &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 0 &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256)
  );
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifySourceRuntimeFiles(
  configuration: SourceRuntimeConfiguration,
): Promise<{ readonly ok: boolean; readonly manifest: SourceRuntimeManifest | null }> {
  try {
    const parsed = JSON.parse(
      await readFile(resolve(configuration.sourceRuntimeRoot, "manifest.json"), "utf8"),
    ) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("schemaVersion" in parsed) ||
      parsed.schemaVersion !== 1 ||
      !("releaseVersion" in parsed) ||
      parsed.releaseVersion !== GOAL_PROGRESS_RELEASE_VERSION ||
      !("nodeVersion" in parsed) ||
      typeof parsed.nodeVersion !== "string" ||
      !("builtAt" in parsed) ||
      typeof parsed.builtAt !== "string" ||
      Number.isNaN(Date.parse(parsed.builtAt)) ||
      !("files" in parsed) ||
      parsed.files === null ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    ) {
      return { ok: false, manifest: null };
    }
    const manifest = parsed as SourceRuntimeManifest;
    for (const required of SOURCE_RUNTIME_REQUIRED_FILES) {
      const record = manifest.files[required];
      if (!validSourceRuntimeRecord(record) || record.path !== required) {
        return { ok: false, manifest: null };
      }
    }
    for (const record of Object.values(manifest.files)) {
      if (!validSourceRuntimeRecord(record)) {
        return { ok: false, manifest: null };
      }
      const path = resolve(configuration.sourceRuntimeRoot, record.path);
      const relation = relative(configuration.sourceRuntimeRoot, path);
      if (relation === "" || relation.startsWith(`..${sep}`) || relation === "..") {
        return { ok: false, manifest: null };
      }
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== record.bytes ||
        (await fileSha256(path)) !== record.sha256
      ) {
        return { ok: false, manifest: null };
      }
    }
    for (const executable of [configuration.helperLauncherPath]) {
      const metadata = await stat(executable);
      if ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
        return { ok: false, manifest: null };
      }
    }
    return { ok: true, manifest };
  } catch {
    return { ok: false, manifest: null };
  }
}

export interface SourceRuntimeHealthResult {
  readonly schemaVersion: 1;
  readonly command: "doctor" | "verify";
  readonly ok: boolean;
  readonly code: string;
  readonly changed: false;
  readonly nextStep: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export async function inspectSourceRuntime(
  command: "doctor" | "verify",
  _installationOnly = false,
): Promise<SourceRuntimeHealthResult> {
  const configuration = sourceRuntimeConfiguration();
  const paths = resolveGoalProgressPaths({ root: configuration.pluginDataRoot });
  const runtimeInspection = await verifySourceRuntimeFiles(configuration);
  const runtimeFilesReady = runtimeInspection.ok;
  const runtimeManifest = runtimeInspection.manifest;

  const launchAgent = createLaunchAgentController();
  const [helperJobLoaded, helper] = await Promise.all([
    launchAgent.isLoaded(GOAL_PROGRESS_LAUNCH_AGENT_LABEL),
    inspectInstalledHelper(paths),
  ]);
  const ok = runtimeFilesReady && helperJobLoaded && helper.ok;
  // Native panel visibility is verified in Codex, not inferred from helper health.
  const verification = nativeVerification(ok);
  const code = ok
    ? command === "doctor"
      ? "DOCTOR_OK"
      : "VERIFY_OK"
    : !runtimeFilesReady
      ? "SOURCE_RUNTIME_FILES_INVALID"
      : !helperJobLoaded
        ? "HELPER_JOB_NOT_LOADED"
        : !helper.ok
          ? (helper.code ?? "HELPER_UNHEALTHY")
          : "HELPER_UNHEALTHY";
  return {
    schemaVersion: 1,
    command,
    ok,
    code,
    changed: false,
    nextStep: ok ? null : "Run the source Plugin again to repair its local runtime.",
    details: {
      verification,
      releaseVersion: GOAL_PROGRESS_RELEASE_VERSION,
      sourceRuntimeRoot: configuration.sourceRuntimeRoot,
      helperLauncherPath: configuration.helperLauncherPath,
      runtimeFilesReady,
      runtimeManifest,
      helperJobLoaded,
      helper,
      marketplace: configuration.marketplace,
      pluginRoot: configuration.pluginRoot,
    },
  };
}

// Remove this source installation only. The marketplace and other plugins remain registered.
export async function uninstallSourceRuntime(): Promise<MacosCommandResult> {
  const configuration = sourceRuntimeConfiguration();
  const { pluginDataRoot, codexHome, marketplace } = configuration;
  if (
    !marketplace ||
    /[/\\\s]/u.test(marketplace) ||
    pluginDataRoot !== resolve(codexHome, "plugins/data", `codex-task-progress-${marketplace}`)
  ) {
    throw new Error("GOAL_PROGRESS_SOURCE_UNINSTALL_PATH_INVALID");
  }
  const pluginCache = resolve(codexHome, "plugins/cache", marketplace, "codex-task-progress");
  const pluginId = `codex-task-progress@${marketplace}`;
  const app = await requireSingleCodexMacosApp();
  const codexCommand = await resolveVerifiedCodexCli(app);
  const run = (args: string[]) => {
    const result = spawnSync(codexCommand, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    if (result.status !== 0) throw new Error("GOAL_PROGRESS_SOURCE_PLUGIN_REMOVE_FAILED");
    return JSON.parse(result.stdout) as {
      installed?: Array<{ pluginId?: string; installed?: boolean }>;
    };
  };
  const listed = run(["plugin", "list", "--json"]);
  if (!Array.isArray(listed.installed)) throw new Error("GOAL_PROGRESS_SOURCE_PLUGIN_LIST_INVALID");
  const installed = listed.installed.some((item) => item.pluginId === pluginId && item.installed);
  if (installed) run(["plugin", "remove", pluginId, "--json"]);

  const launchAgentPath = resolve(
    homedir(),
    "Library/LaunchAgents",
    `${GOAL_PROGRESS_LAUNCH_AGENT_LABEL}.plist`,
  );
  const ownRuntime = resolve(pluginDataRoot, "source-runtime") + sep;
  const job = currentLaunchAgentText();
  const ownJob = job.includes(ownRuntime);
  if (ownJob) {
    bootoutCurrentLaunchAgent();
    await waitForSocketRemoval(resolveGoalProgressPaths({ root: pluginDataRoot }).helperSocketPath);
  }
  // Never remove a launchd definition currently owned by a different installation.
  let plist: string | null = null;
  try {
    plist = await readFile(launchAgentPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if ((!job || ownJob) && plist?.includes(ownRuntime)) await rm(launchAgentPath, { force: true });
  await rm(pluginCache, { recursive: true, force: true });
  await rm(pluginDataRoot, { recursive: true, force: true });
  return {
    schemaVersion: 1,
    command: "uninstall",
    ok: true,
    code: "UNINSTALL_OK",
    changed: true,
    nextStep: null,
    details: {
      pluginRemoved: true,
      dataDeleted: true,
      helperStopped: ownJob,
      nativeGoalsPreserved: true,
    },
  };
}

function sourceCommandResult(
  command: MacosCommandName,
  input: Omit<MacosCommandResult, "schemaVersion" | "command">,
): MacosCommandResult {
  return {
    schemaVersion: 1,
    command,
    ...input,
  };
}

export async function executeSourceRuntimeCommand(
  command: Extract<
    MacosCommandName,
    "install" | "doctor" | "verify" | "upgrade" | "repair" | "uninstall"
  >,
): Promise<MacosCommandResult> {
  if (command === "doctor" || command === "verify") {
    return inspectSourceRuntime(command);
  }
  if (command === "uninstall") return uninstallSourceRuntime();
  let nativeMcpFeature: "enabled" | "disabled" | "unknown" = "unknown";
  try {
    const configuration = sourceRuntimeConfiguration();
    const codex = await requireSingleCodexMacosApp();
    nativeMcpFeature = inspectNativeMcpFeature(
      await resolveVerifiedCodexCli(codex),
      configuration.codexHome,
    );
  } catch {
    /* Unsupported or unavailable CLI is setup-required. */
  }
  if (nativeMcpFeature !== "enabled")
    return sourceCommandResult(command, {
      ok: false,
      code: "NATIVE_MCP_SETUP_REQUIRED",
      changed: false,
      nextStep:
        nativeMcpFeature === "disabled"
          ? "Enable native MCP Apps with codex features enable enable_mcp_apps, then retry."
          : "Check that codex features list reports enable_mcp_apps as true, then retry.",
      details: { nativeMcpFeature },
    });
  if (command === "upgrade") {
    return sourceCommandResult(command, {
      ok: true,
      code: "UPGRADE_MANAGED_BY_PLUGIN_MARKETPLACE",
      changed: false,
      nextStep: "Update Goal Progress from its Codex Plugin marketplace.",
      details: {
        distribution: "source-plugin",
        nativeMcpFeature,
        marketplace: optionalEnvironment("GOAL_PROGRESS_PLUGIN_MARKETPLACE"),
      },
    });
  }
  const ensured = await ensureSourceRuntime();
  const verified = await inspectSourceRuntime("verify", true);
  if (!verified.ok) {
    return sourceCommandResult(command, {
      ok: false,
      code: verified.code,
      changed: ensured.launchAgentChanged,
      nextStep: verified.nextStep,
      details: verified.details,
    });
  }
  return sourceCommandResult(command, {
    ok: true,
    code: command === "install" ? "INSTALL_OK" : "REPAIR_OK",
    changed: ensured.migratedState || ensured.migratedPreferences || ensured.launchAgentChanged,
    nextStep: null,
    details: { ...ensured, nativeMcpFeature },
  });
}
