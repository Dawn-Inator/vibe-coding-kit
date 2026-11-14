import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCodesignArgs, resolveReleaseSigning } from "../../../scripts/release-signing.mjs";
import type { CodexInstallIdentity } from "./verified-release.js";
import { readVerifiedRelease } from "./verified-release.js";

export const CODEX_MANAGED_LAUNCHER_APP_NAME = "Codex Task Progress.app";
export const CODEX_MANAGED_LAUNCHER_BUNDLE_ID = "com.codextaskprogress.codexlauncher";
export const CODEX_MANAGED_LAUNCHER_MARKER = join(
  "Contents",
  "Resources",
  ".codex-task-progress-managed.json",
);

const OWNER_MARKER = "codex-task-progress-managed-launcher-v1";
const APP_RELATIVE_PATH = join("Contents", "MacOS", "CodexTaskProgressLauncher");
const ICON_RELATIVE_PATH = join("Contents", "Resources", "Codex.icns");
const DOCK_RECEIPT_PATH = "launcher/dock-receipt.plist";
const APP_INSTALL_RECEIPT_PATH = "launcher/managed-app.json";

export interface ManageCodexDockLauncherInput {
  readonly action: "status" | "install" | "remove";
  readonly homeDirectory: string;
  readonly releaseRoot: string;
  readonly codex: CodexInstallIdentity;
  readonly configureDock: boolean;
}

export interface ManageCodexDockLauncherResult {
  readonly ok: boolean;
  readonly code: string;
  readonly changed: boolean;
  readonly nextStep?: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export type DockLauncherRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface CodexDockLauncherPaths {
  readonly launcherAppPath: string;
  readonly markerPath: string;
  readonly dockReceiptPath: string;
  readonly appInstallReceiptPath: string;
  readonly helperPath: string;
}

export function resolveCodexDockLauncherPaths(homeDirectory: string): CodexDockLauncherPaths {
  if (!isAbsolute(homeDirectory)) throw new Error("DOCK_LAUNCHER_HOME_DIRECTORY_INVALID");
  const support = resolve(homeDirectory, "Library/Application Support/CodexTaskProgress");
  const launcherAppPath = resolve(homeDirectory, "Applications", CODEX_MANAGED_LAUNCHER_APP_NAME);
  return {
    launcherAppPath,
    markerPath: join(launcherAppPath, CODEX_MANAGED_LAUNCHER_MARKER),
    dockReceiptPath: resolve(support, DOCK_RECEIPT_PATH),
    appInstallReceiptPath: resolve(support, APP_INSTALL_RECEIPT_PATH),
    helperPath: resolve(
      homeDirectory,
      "Library/Application Support/CodexTaskProgress/install/bin/goal-progress",
    ),
  };
}

export function createDockLauncherInfoPlist(iconName = "Codex", helperPath = ""): string {
  const escaped = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleDevelopmentRegion</key><string>en</string><key>CFBundleExecutable</key><string>CodexTaskProgressLauncher</string><key>CFBundleIconFile</key><string>${escaped(iconName)}</string><key>CFBundleIdentifier</key><string>${CODEX_MANAGED_LAUNCHER_BUNDLE_ID}</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleName</key><string>Codex</string><key>CFBundleDisplayName</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>TaskProgressHelperPath</key><string>${escaped(helperPath)}</string></dict></plist>\n`;
}

const defaultRunner: DockLauncherRunner = (command, args) =>
  new Promise((done) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        done({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });

function parseNativeResult(stdout: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (isPlainRecord(value) && typeof value.ok === "boolean") return value;
  } catch {
    /* mapped below */
  }
  throw new Error("DOCK_LAUNCHER_NATIVE_RESPONSE_INVALID");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function safeIconPath(appPath: string, runner: DockLauncherRunner): Promise<string | null> {
  const info = resolve(appPath, "Contents/Info.plist");
  const result = await runner("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", info]);
  if (result.code !== 0) return null;
  let iconName = result.stdout.trim();
  if (!iconName) return null;
  if (!iconName.endsWith(".icns")) iconName += ".icns";
  const iconPath = resolve(appPath, "Contents/Resources", iconName);
  const inside = relative(resolve(appPath, "Contents/Resources"), iconPath);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  try {
    const metadata = await lstat(iconPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const [realBundle, realIcon] = await Promise.all([realpath(appPath), realpath(iconPath)]);
    const actualRelative = relative(resolve(realBundle, "Contents/Resources"), realIcon);
    if (
      actualRelative === ".." ||
      actualRelative.startsWith(`..${sep}`) ||
      isAbsolute(actualRelative)
    )
      return null;
    return realIcon;
  } catch {
    return null;
  }
}

async function isOwnedApp(appPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(appPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const marker = JSON.parse(
      await readFile(join(appPath, CODEX_MANAGED_LAUNCHER_MARKER), "utf8"),
    ) as Record<string, unknown>;
    return marker.owner === OWNER_MARKER && marker.bundleId === CODEX_MANAGED_LAUNCHER_BUNDLE_ID;
  } catch {
    return false;
  }
}

async function installedAppMatches(
  appPath: string,
  launcherSha256: string,
  helperPath: string,
  sourceAppPath: string,
  iconPath: string,
  installReceiptPath: string,
  runner: DockLauncherRunner,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(appPath, CODEX_MANAGED_LAUNCHER_MARKER), "utf8"),
    ) as Record<string, unknown>;
    if (
      marker.owner !== OWNER_MARKER ||
      marker.sourceAppPath !== sourceAppPath ||
      marker.launcherSha256 !== launcherSha256
    )
      return false;
    const receipt = JSON.parse(await readFile(installReceiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      receipt.owner !== OWNER_MARKER ||
      receipt.bundleId !== CODEX_MANAGED_LAUNCHER_BUNDLE_ID ||
      receipt.appPath !== appPath ||
      receipt.launcherSha256 !== launcherSha256
    )
      return false;
    const [installedBinary, installedInfo, installedIcon, expectedInfo] = await Promise.all([
      readFile(join(appPath, APP_RELATIVE_PATH)),
      readFile(join(appPath, "Contents/Info.plist"), "utf8"),
      readFile(join(appPath, ICON_RELATIVE_PATH)),
      Promise.resolve(createDockLauncherInfoPlist("Codex", helperPath)),
    ]);
    const executableMeta = await lstat(join(appPath, APP_RELATIVE_PATH));
    const sourceIcon = await readFile(iconPath);
    const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
    if (
      !executableMeta.isFile() ||
      executableMeta.isSymbolicLink() ||
      (executableMeta.mode & 0o111) === 0 ||
      installedInfo !== expectedInfo ||
      !installedIcon.equals(sourceIcon) ||
      receipt.installedBinarySha256 !== sha256(installedBinary) ||
      receipt.infoSha256 !== sha256(installedInfo) ||
      receipt.iconSha256 !== sha256(installedIcon)
    )
      return false;
    const signature = await runner("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      appPath,
    ]);
    return signature.code === 0;
  } catch {
    return false;
  }
}

async function writePrivateReceipt(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("DOCK_LAUNCHER_RECEIPT_PARENT_CONFLICT");
  await chmod(parent, 0o700);
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function result(
  ok: boolean,
  code: string,
  changed: boolean,
  launcherAppPath: string,
  launcherInstalled: boolean,
  dockConfigured: boolean,
  extra: Record<string, unknown> = {},
): ManageCodexDockLauncherResult {
  const nextStep = typeof extra.nextStep === "string" ? extra.nextStep : undefined;
  return {
    ok,
    code,
    changed,
    ...(nextStep ? { nextStep } : {}),
    details: {
      launcherInstalled,
      dockConfigured,
      launcherAppPath,
      currentCodex: "untouched",
      ...extra,
    },
  };
}

export async function manageCodexDockLauncher(
  input: ManageCodexDockLauncherInput,
  dependencies: { readonly runner?: DockLauncherRunner; readonly uuid?: () => string } = {},
): Promise<ManageCodexDockLauncherResult> {
  const runner = dependencies.runner ?? defaultRunner;
  const uuid = dependencies.uuid ?? randomUUID;
  if (
    !isAbsolute(input.homeDirectory) ||
    !isAbsolute(input.releaseRoot) ||
    !isAbsolute(input.codex.realAppPath)
  ) {
    return result(false, "DOCK_LAUNCHER_INPUT_INVALID", false, "", false, false);
  }
  let release: Awaited<ReturnType<typeof readVerifiedRelease>>;
  try {
    release = await readVerifiedRelease(input.releaseRoot);
  } catch (error) {
    return result(false, "DOCK_LAUNCHER_RELEASE_INVALID", false, "", false, false, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const dockLauncher = release.files.dockLauncher;
  if (!dockLauncher) return result(false, "DOCK_LAUNCHER_RELEASE_MISSING", false, "", false, false);
  const paths = resolveCodexDockLauncherPaths(input.homeDirectory);
  const {
    launcherAppPath: appPath,
    helperPath,
    dockReceiptPath: receiptPath,
    appInstallReceiptPath,
  } = paths;
  const releaseLauncher = resolve(input.releaseRoot, dockLauncher.path);
  const owned = await isOwnedApp(appPath);
  const applicationsMeta = await lstat(dirname(appPath)).catch(() => null);
  if (applicationsMeta && (!applicationsMeta.isDirectory() || applicationsMeta.isSymbolicLink())) {
    return result(false, "DOCK_LAUNCHER_DESTINATION_PARENT_CONFLICT", false, appPath, false, false);
  }
  if (input.action === "status") {
    const iconPath = await safeIconPath(input.codex.realAppPath, runner);
    const launcherInstalled =
      owned &&
      iconPath !== null &&
      (await installedAppMatches(
        appPath,
        dockLauncher.sha256,
        helperPath,
        input.codex.realAppPath,
        iconPath,
        appInstallReceiptPath,
        runner,
      ));
    const dock = await runner(releaseLauncher, ["dock-status", "--managed-app", appPath, "--json"]);
    if (dock.code !== 0)
      return result(
        false,
        "DOCK_LAUNCHER_DOCK_STATUS_FAILED",
        false,
        appPath,
        launcherInstalled,
        false,
        { reason: dock.stderr.trim().slice(0, 240) },
      );
    const dockConfigured = Boolean(parseNativeResult(dock.stdout).dockConfigured);
    return result(
      true,
      launcherInstalled
        ? "DOCK_LAUNCHER_STATUS"
        : owned
          ? "DOCK_LAUNCHER_REPAIR_REQUIRED"
          : "DOCK_LAUNCHER_NOT_INSTALLED",
      false,
      appPath,
      launcherInstalled,
      dockConfigured,
      {
        currentCodex: "untouched",
        ...(owned && !launcherInstalled
          ? { nextStep: "Run launcher --install to repair the managed app." }
          : {}),
      },
    );
  }
  if (input.action === "remove") {
    const appMeta = await lstat(appPath).catch(() => null);
    if (appMeta && !owned)
      return result(false, "DOCK_LAUNCHER_DESTINATION_CONFLICT", false, appPath, false, false);
    let dockConfigured = false;
    let keepApp = false;
    if (input.configureDock && (await exists(receiptPath))) {
      const dock = await runner(releaseLauncher, [
        "dock-remove",
        "--managed-app",
        appPath,
        "--receipt",
        receiptPath,
        "--json",
      ]);
      if (dock.code !== 0)
        return result(false, "DOCK_LAUNCHER_DOCK_RESTORE_FAILED", false, appPath, owned, true, {
          reason: dock.stderr.trim().slice(0, 240),
        });
      const native = parseNativeResult(dock.stdout);
      dockConfigured = Boolean(native.dockConfigured);
      keepApp = Boolean(native.keepManagedApp);
    }
    if (owned) {
      const dock = await runner(releaseLauncher, [
        "dock-status",
        "--managed-app",
        appPath,
        "--json",
      ]);
      if (dock.code !== 0)
        return result(false, "DOCK_LAUNCHER_DOCK_STATUS_FAILED", false, appPath, true, false, {
          reason: dock.stderr.trim().slice(0, 240),
        });
      dockConfigured = Boolean(parseNativeResult(dock.stdout).dockConfigured);
      if (dockConfigured && !input.configureDock)
        return result(false, "DOCK_LAUNCHER_DOCK_PINNED", false, appPath, true, true, {
          nextStep:
            "Run launcher --remove --dock to restore Dock preferences before removing the app.",
        });
      if (dockConfigured && input.configureDock && !(await exists(receiptPath)))
        return result(false, "DOCK_LAUNCHER_DOCK_RECEIPT_MISSING", false, appPath, true, true, {
          nextStep: "Keep the app pinned or repair its Dock receipt before removal.",
        });
    }
    if (keepApp)
      return result(true, "DOCK_LAUNCHER_USER_EDIT_PRESERVED", false, appPath, true, true, {
        retainedForUserEdit: true,
        currentCodex: "untouched",
      });
    if (owned && !keepApp) {
      await rm(appPath, { recursive: true });
      await rm(appInstallReceiptPath, { force: true });
      if (!dockConfigured) await rm(receiptPath, { force: true });
    }
    return result(true, "DOCK_LAUNCHER_REMOVED", owned, appPath, false, dockConfigured, {
      retainedForUserEdit: false,
      currentCodex: "untouched",
    });
  }

  const existingMeta = await lstat(appPath).catch(() => null);
  if (existingMeta && (!existingMeta.isDirectory() || existingMeta.isSymbolicLink() || !owned)) {
    return result(false, "DOCK_LAUNCHER_DESTINATION_CONFLICT", false, appPath, false, false);
  }
  const launcherSource = resolve(input.releaseRoot, dockLauncher.path);
  const iconPath = await safeIconPath(input.codex.realAppPath, runner);
  if (!iconPath)
    return result(false, "CODEX_ICON_MISSING", false, appPath, owned, false, {
      reason: "Codex's signed app icon could not be read safely.",
    });
  const alreadyCurrent =
    owned &&
    (await installedAppMatches(
      appPath,
      dockLauncher.sha256,
      helperPath,
      input.codex.realAppPath,
      iconPath,
      appInstallReceiptPath,
      runner,
    ));
  if (alreadyCurrent) {
    let dockConfigured = false;
    if (input.configureDock) {
      const dock = await runner(releaseLauncher, [
        "dock-install",
        "--original-app",
        input.codex.realAppPath,
        "--managed-app",
        appPath,
        "--receipt",
        receiptPath,
        "--json",
      ]);
      if (dock.code !== 0)
        return result(false, "DOCK_LAUNCHER_DOCK_CONFIGURE_FAILED", false, appPath, true, false, {
          reason: dock.stderr.trim().slice(0, 240),
        });
      const native = parseNativeResult(dock.stdout);
      dockConfigured = Boolean(native.dockConfigured);
      return result(
        true,
        "DOCK_LAUNCHER_INSTALLED",
        Boolean(native.changed),
        appPath,
        true,
        dockConfigured,
        { currentCodex: "untouched", configureDock: true },
      );
    }
    return result(true, "DOCK_LAUNCHER_INSTALLED", false, appPath, true, false, {
      currentCodex: "untouched",
      configureDock: false,
    });
  }
  const parent = dirname(appPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMeta = await lstat(parent);
  if (!parentMeta.isDirectory() || parentMeta.isSymbolicLink()) {
    return result(false, "DOCK_LAUNCHER_DESTINATION_PARENT_CONFLICT", false, appPath, false, false);
  }
  const stage = join(parent, `.${CODEX_MANAGED_LAUNCHER_APP_NAME}.${uuid()}.stage`);
  let changed = false;
  try {
    await mkdir(join(stage, "Contents/MacOS"), { recursive: true, mode: 0o700 });
    await mkdir(join(stage, "Contents/Resources"), { recursive: true, mode: 0o700 });
    await copyFile(launcherSource, join(stage, APP_RELATIVE_PATH));
    await chmod(join(stage, APP_RELATIVE_PATH), 0o700);
    await copyFile(iconPath, join(stage, ICON_RELATIVE_PATH));
    await writeFile(
      join(stage, "Contents/Info.plist"),
      createDockLauncherInfoPlist("Codex", helperPath),
      { mode: 0o600 },
    );
    await writeFile(
      join(stage, CODEX_MANAGED_LAUNCHER_MARKER),
      `${JSON.stringify({ owner: OWNER_MARKER, bundleId: CODEX_MANAGED_LAUNCHER_BUNDLE_ID, sourceBundleId: input.codex.bundleId, sourceAppPath: input.codex.realAppPath, launcherSha256: dockLauncher.sha256, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    let signing: Awaited<ReturnType<typeof resolveReleaseSigning>>;
    try {
      signing = await resolveReleaseSigning({ home: input.homeDirectory });
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      return result(false, "DOCK_LAUNCHER_SIGNING_UNAVAILABLE", false, appPath, owned, false, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const signed = await runner(
      "/usr/bin/codesign",
      createCodesignArgs(signing.identity, CODEX_MANAGED_LAUNCHER_BUNDLE_ID, stage),
    );
    if (signed.code !== 0) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      return result(false, "DOCK_LAUNCHER_SIGN_FAILED", false, appPath, owned, false, {
        reason: signed.stderr.trim().slice(0, 240),
      });
    }
    const verified = await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", stage]);
    if (verified.code !== 0) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      return result(false, "DOCK_LAUNCHER_SIGNATURE_INVALID", false, appPath, owned, false, {
        reason: verified.stderr.trim().slice(0, 240),
      });
    }
    const [installedBinary, installedInfo, installedIcon] = await Promise.all([
      readFile(join(stage, APP_RELATIVE_PATH)),
      readFile(join(stage, "Contents/Info.plist")),
      readFile(join(stage, ICON_RELATIVE_PATH)),
    ]);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const installReceipt = {
      owner: OWNER_MARKER,
      schemaVersion: 1,
      appPath,
      bundleId: CODEX_MANAGED_LAUNCHER_BUNDLE_ID,
      launcherSha256: dockLauncher.sha256,
      installedBinarySha256: digest(installedBinary),
      infoSha256: digest(installedInfo),
      iconSha256: digest(installedIcon),
    };
    if (existingMeta) {
      const backup = `${appPath}.${uuid()}.old`;
      await rename(appPath, backup);
      try {
        await rename(stage, appPath);
      } catch (error) {
        await rename(backup, appPath).catch(() => undefined);
        throw error;
      }
      changed = true;
      await rm(backup, { recursive: true });
    } else {
      await rename(stage, appPath);
      changed = true;
    }
    await writePrivateReceipt(appInstallReceiptPath, installReceipt);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    return result(
      false,
      "DOCK_LAUNCHER_INSTALL_FAILED",
      changed,
      appPath,
      await isOwnedApp(appPath),
      false,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  let dockConfigured = false;
  if (input.configureDock) {
    const dock = await runner(releaseLauncher, [
      "dock-install",
      "--original-app",
      input.codex.realAppPath,
      "--managed-app",
      appPath,
      "--receipt",
      receiptPath,
      "--json",
    ]);
    if (dock.code !== 0)
      return result(false, "DOCK_LAUNCHER_DOCK_CONFIGURE_FAILED", changed, appPath, true, false, {
        reason: dock.stderr.trim().slice(0, 240),
      });
    const native = parseNativeResult(dock.stdout);
    dockConfigured = Boolean(native.dockConfigured);
    if (native.changed) changed = true;
  }
  return result(true, "DOCK_LAUNCHER_INSTALLED", changed, appPath, true, dockConfigured, {
    currentCodex: "untouched",
    configureDock: input.configureDock,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
