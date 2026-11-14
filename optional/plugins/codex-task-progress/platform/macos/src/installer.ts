import { resolve } from "node:path";
import type { GoalProgressPaths } from "../../../packages/store/src/index.js";
import { requireSingleCodexMacosApp } from "./app-discovery.js";
import {
  type CdpController,
  cdpPaths,
  createCdpController,
  createDefaultRestoreCdp,
  type RestoreCdpResult,
} from "./cdp-controller.js";
import type {
  MacosCommandHandlers,
  MacosCommandInput,
  MacosCommandName,
  MacosCommandResult,
} from "./command-protocol.js";
import { manageCodexDockLauncher } from "./dock-launcher.js";
import { createHealthCommands } from "./health-commands.js";
import { waitForHelperReady } from "./helper-wait.js";
import { createInstallCommand, type MacosCommandResultFactory } from "./install-command.js";
import { InstallationState } from "./installation-state.js";
import {
  type HelperHealthInspection,
  type HelperReadinessInspection,
  inspectInstalledHelper,
  inspectInstalledHelperReadiness,
} from "./installed-inspection.js";
import {
  createLaunchAgentController,
  type LaunchAgentController,
} from "./launch-agent-controller.js";
import { createMaintenanceCommands } from "./maintenance-commands.js";
import { type ManagedLaunchDependencies, managedLaunch } from "./managed-launch.js";
import {
  createPluginController,
  type PluginController,
  resolveVerifiedCodexCli,
} from "./plugin-controller.js";
import {
  readCodexStartupRecoveryPolicy,
  writeCodexStartupRecoveryPolicy,
} from "./startup-recovery-policy.js";
import type { CodexInstallIdentity } from "./verified-release.js";

export {
  type CdpController,
  createCdpController,
  createCodexCdpHandoffInvocation,
  createCodexNormalRelaunchInvocation,
  createCodexRestoreHandoffInvocation,
  decideCodexCdpRestart,
  GOAL_PROGRESS_CDP_HANDOFF_COMMAND,
  GOAL_PROGRESS_CDP_HANDOFF_LABEL,
  GOAL_PROGRESS_CDP_SCHEDULE_COMMAND,
  GOAL_PROGRESS_RESTORE_HANDOFF_COMMAND,
  GOAL_PROGRESS_RESTORE_HANDOFF_LABEL,
  type RestoreCdpResult,
  recordCdpHandoffFailure,
  runCdpRestartWithFallback,
  runCodexCdpHandoff,
  runCodexRestoreHandoff,
  scheduleCodexCdpHandoff,
} from "./cdp-controller.js";
export {
  type HelperHealthInspection,
  inspectInstalledHelper,
} from "./installed-inspection.js";
export {
  createLaunchAgentController,
  type LaunchAgentController,
  restartLoadedLaunchAgent,
} from "./launch-agent-controller.js";
export {
  createPluginController,
  type PluginController,
  resolveVerifiedCodexCli,
} from "./plugin-controller.js";

export interface CreateMacosCommandHandlersOptions {
  readonly homeDirectory: string;
  readonly releaseRoot: string;
  readonly managedLaunchDependencies?: Partial<ManagedLaunchDependencies>;
  readonly manageLauncher?: typeof manageCodexDockLauncher;
  readonly launchAgent?: LaunchAgentController;
  readonly plugin?: PluginController;
  readonly cdp?: CdpController;
  readonly inspectHelper?: (paths: GoalProgressPaths) => Promise<HelperHealthInspection>;
  readonly inspectHelperReadiness?: (
    paths: GoalProgressPaths,
    timeoutMs: number,
  ) => Promise<HelperReadinessInspection>;
  readonly waitForHelperReadyForTest?: (
    inspect: (timeoutMs: number) => Promise<HelperReadinessInspection>,
  ) => Promise<boolean>;
  readonly codexHomeDirectory?: string;
  readonly discoverCodex?: () => Promise<CodexInstallIdentity>;
  readonly restoreCdp?: (restartCodex: boolean) => Promise<RestoreCdpResult>;
  readonly now?: () => Date;
  readonly installFaultForTest?: (
    point:
      | "after-cdp"
      | "after-copy-release"
      | "after-plist"
      | "after-plugin"
      | "after-current"
      | "after-helper"
      | "after-manifest"
      | "before-backup-cleanup",
  ) => void | Promise<void>;
}

const commandResult: MacosCommandResultFactory = (
  command: MacosCommandName,
  input: {
    readonly ok: boolean;
    readonly code: string;
    readonly changed: boolean;
    readonly nextStep?: string | null;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): MacosCommandResult => ({
  schemaVersion: 1,
  command,
  ok: input.ok,
  code: input.code,
  changed: input.changed,
  nextStep: input.nextStep ?? null,
  details: input.details ?? {},
});

export function createMacosCommandHandlers(
  options: CreateMacosCommandHandlersOptions,
): MacosCommandHandlers {
  const launchAgent = options.launchAgent ?? createLaunchAgentController();
  const pluginFor = async (codex: CodexInstallIdentity): Promise<PluginController> =>
    options.plugin ??
    createPluginController({
      codexHomeDirectory: options.codexHomeDirectory ?? resolve(options.homeDirectory, ".codex"),
      codexCommand: await resolveVerifiedCodexCli(codex),
    });
  const cdp = options.cdp ?? createCdpController(options.homeDirectory);
  const inspectHelper = options.inspectHelper ?? inspectInstalledHelper;
  const inspectHelperReadiness =
    options.inspectHelperReadiness ??
    (options.inspectHelper
      ? async (): Promise<HelperReadinessInspection> => ({
          pingOk: true,
          ready: true,
          code: null,
        })
      : inspectInstalledHelperReadiness);
  const goalPaths = cdpPaths(options.homeDirectory);
  const discoverCodex =
    options.discoverCodex ??
    (async () => {
      const app = await requireSingleCodexMacosApp();
      return {
        realAppPath: app.realAppPath,
        realExecutablePath: app.realExecutablePath,
        bundleId: app.bundleId,
        teamId: app.teamId,
      };
    });
  const restoreCdp = options.restoreCdp ?? createDefaultRestoreCdp(options.homeDirectory);
  const shared = {
    homeDirectory: options.homeDirectory,
    releaseRoot: options.releaseRoot,
    launchAgent,
    cdp,
    inspectHelper,
    inspectHelperReadiness,
    goalPaths,
    discoverCodex,
    pluginFor,
  };
  const installOrUpgrade = createInstallCommand({
    ...shared,
    restoreCdp,
    now: options.now ?? (() => new Date()),
    commandResult,
    waitForHelperReady: options.waitForHelperReadyForTest ?? waitForHelperReady,
    ...(options.installFaultForTest === undefined
      ? {}
      : { installFaultForTest: options.installFaultForTest }),
  });
  const state = () => new InstallationState(shared);
  const health = createHealthCommands({
    state,
    launchAgent,
    cdp,
    commandResult,
    installOrUpgrade,
    startupRecoveryPolicy: () => readCodexStartupRecoveryPolicy(goalPaths),
  });
  const maintenance = createMaintenanceCommands({
    homeDirectory: options.homeDirectory,
    releaseRoot: options.releaseRoot,
    launchAgent,
    discoverCodex,
    pluginFor,
    restoreCdp,
    commandResult,
    manageLauncher: options.manageLauncher ?? manageCodexDockLauncher,
  });

  return {
    launch: async () => {
      const result = await managedLaunch({
        homeDirectory: options.homeDirectory,
        codex: await discoverCodex(),
        launchAgent,
        cdp,
        ...(options.managedLaunchDependencies
          ? { dependencies: options.managedLaunchDependencies }
          : {}),
      });
      return commandResult("launch", {
        ok: true,
        code: result.connectionRebuildPending
          ? "CODEX_CONNECTION_REBUILD_PENDING"
          : "CODEX_LAUNCHED",
        changed: result.changed,
        details: result,
      });
    },
    launcher: async (input: MacosCommandInput) => {
      if (!input.launcherAction) throw new Error("GOAL_PROGRESS_LAUNCHER_ACTION_INVALID");
      const result = await (options.manageLauncher ?? manageCodexDockLauncher)({
        action: input.launcherAction,
        homeDirectory: options.homeDirectory,
        releaseRoot: options.releaseRoot,
        codex: await discoverCodex(),
        configureDock: input.configureDock ?? false,
      });
      let policyChanged = false;
      if (result.ok && input.launcherAction === "install") {
        policyChanged = (await readCodexStartupRecoveryPolicy(goalPaths)).autoPrepareOnLaunch;
        await writeCodexStartupRecoveryPolicy(goalPaths, "disable");
      }
      return commandResult("launcher", {
        ...result,
        changed: result.changed || policyChanged,
        details: {
          ...result.details,
          ...(result.ok && input.launcherAction === "install"
            ? { startupRecovery: "disabled", currentCodexRestarted: false }
            : {}),
        },
      });
    },
    install: (input: MacosCommandInput) => installOrUpgrade("install", input),
    doctor: health.doctor,
    "emergency-disable": maintenance.emergencyDisable,
    "startup-recovery": async (input: MacosCommandInput) => {
      const action = input.startupRecoveryAction;
      if (action === null) throw new Error("GOAL_PROGRESS_STARTUP_RECOVERY_ACTION_INVALID");
      const previous = await readCodexStartupRecoveryPolicy(goalPaths);
      const policy =
        action === "status"
          ? await readCodexStartupRecoveryPolicy(goalPaths)
          : await writeCodexStartupRecoveryPolicy(goalPaths, action);
      return commandResult("startup-recovery", {
        ok: true,
        code: action === "status" ? "STARTUP_RECOVERY_STATUS" : "STARTUP_RECOVERY_UPDATED",
        changed: action !== "status" && previous.autoPrepareOnLaunch !== policy.autoPrepareOnLaunch,
        details: {
          configured: policy.autoPrepareOnLaunch ? "enabled" : "disabled",
          autoPrepareOnLaunch: policy.autoPrepareOnLaunch,
          action,
          nextLaunchBehavior: policy.autoPrepareOnLaunch
            ? "The original Codex launch will prepare the Dock entry on the next launch."
            : "Automatic startup recovery is off.",
          currentCodex: "The already-running Codex app is not changed by this setting.",
        },
      });
    },
    repair: health.repair,
    verify: health.verify,
    restore: maintenance.restore,
    uninstall: maintenance.uninstall,
    upgrade: (input: MacosCommandInput) => installOrUpgrade("upgrade", input),
  };
}
