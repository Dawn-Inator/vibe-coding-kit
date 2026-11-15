import { resolve } from "node:path";
import {
  type GoalProgressPaths,
  resolveGoalProgressPaths,
} from "../../../packages/store/src/index.js";
import { requireSingleCodexMacosApp } from "./app-discovery.js";
import type {
  MacosCommandHandlers,
  MacosCommandInput,
  MacosCommandName,
  MacosCommandResult,
} from "./command-protocol.js";
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
import { inspectNativeMcpFeature } from "./native-install-prerequisites.js";
import {
  createPluginController,
  type PluginController,
  resolveVerifiedCodexCli,
} from "./plugin-controller.js";
import type { CodexInstallIdentity } from "./verified-release.js";

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
  readonly launchAgent?: LaunchAgentController;
  readonly plugin?: PluginController;
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
  readonly now?: () => Date;
  readonly installFaultForTest?: (
    point:
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
  const goalPaths = resolveGoalProgressPaths({
    platform: "darwin",
    homeDirectory: options.homeDirectory,
  });
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
  const shared = {
    homeDirectory: options.homeDirectory,
    releaseRoot: options.releaseRoot,
    launchAgent,
    inspectHelper,
    inspectHelperReadiness,
    goalPaths,
    discoverCodex,
    pluginFor,
  };
  const installOrUpgrade = createInstallCommand({
    ...shared,
    inspectNativeMcpFeature: async (codex) =>
      inspectNativeMcpFeature(
        await resolveVerifiedCodexCli(codex),
        options.codexHomeDirectory ?? resolve(options.homeDirectory, ".codex"),
      ),
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
    commandResult,
    installOrUpgrade,
  });
  const maintenance = createMaintenanceCommands({
    homeDirectory: options.homeDirectory,
    releaseRoot: options.releaseRoot,
    launchAgent,
    discoverCodex,
    pluginFor,
    commandResult,
  });

  return {
    install: (input: MacosCommandInput) => installOrUpgrade("install", input),
    doctor: health.doctor,
    "emergency-disable": maintenance.emergencyDisable,
    repair: health.repair,
    verify: health.verify,
    uninstall: maintenance.uninstall,
    upgrade: (input: MacosCommandInput) => installOrUpgrade("upgrade", input),
  };
}
