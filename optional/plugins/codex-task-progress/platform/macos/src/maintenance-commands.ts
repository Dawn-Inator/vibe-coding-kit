import { access, readlink, rm } from "node:fs/promises";
import { resolveGoalProgressPaths } from "../../../packages/store/src/index.js";
import type { MacosCommandInput, MacosCommandResult } from "./command-protocol.js";
import { waitForHelperStopped } from "./helper-wait.js";
import type { MacosCommandResultFactory } from "./install-command.js";
import { resolveMacosInstallationLayout } from "./install-layout.js";
import type { LaunchAgentController } from "./launch-agent-controller.js";
import { assertLegacyLauncherRemoved } from "./legacy-cleanup-preflight.js";
import { isNotFound, stableErrorCode } from "./macos-errors.js";
import type { PluginController } from "./plugin-controller.js";
import {
  type CodexInstallIdentity,
  readInstalledManifest,
  readReleaseManifest,
  validateCodexIdentity,
} from "./verified-release.js";

export interface MaintenanceCommandDependencies {
  readonly homeDirectory: string;
  readonly releaseRoot: string;
  readonly launchAgent: LaunchAgentController;
  readonly discoverCodex: () => Promise<CodexInstallIdentity>;
  readonly pluginFor: (codex: CodexInstallIdentity) => Promise<PluginController>;
  readonly commandResult: MacosCommandResultFactory;
}

async function currentLinkExists(path: string): Promise<boolean> {
  try {
    await readlink(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export function createMaintenanceCommands(dependencies: MaintenanceCommandDependencies) {
  const uninstall = async (input: MacosCommandInput): Promise<MacosCommandResult> => {
    await assertLegacyLauncherRemoved(dependencies.homeDirectory);
    const basePaths = resolveGoalProgressPaths({
      platform: "darwin",
      homeDirectory: dependencies.homeDirectory,
    });
    const installed = await readInstalledManifest(basePaths.installManifestPath);
    let releaseVersion = installed?.releaseVersion;
    if (!releaseVersion) {
      try {
        releaseVersion = (await readReleaseManifest(dependencies.releaseRoot)).releaseVersion;
      } catch {
        releaseVersion = "uninstalled";
      }
    }
    const layout = resolveMacosInstallationLayout({
      homeDirectory: dependencies.homeDirectory,
      releaseVersion,
    });
    let pluginChanged = false;
    let pluginError: string | null = null;
    try {
      const codex = await dependencies.discoverCodex();
      validateCodexIdentity(codex);
      pluginChanged = await (await dependencies.pluginFor(codex)).remove();
    } catch (error) {
      pluginError = stableErrorCode(error);
    }
    const jobChanged = await dependencies.launchAgent.remove(
      layout.launchAgentLabel,
      layout.launchAgentPath,
    );
    await waitForHelperStopped(basePaths);
    let filesChanged = false;
    for (const path of [layout.launchAgentPath, layout.installRoot, layout.runtimeRoot]) {
      try {
        await access(path);
        await rm(path, { recursive: true, force: true });
        filesChanged = true;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
    if (!input.preserveHistory) {
      await rm(layout.applicationSupportRoot, { recursive: true, force: true });
      filesChanged = true;
    }
    const changed = pluginChanged || jobChanged || filesChanged;
    if (pluginError) {
      return dependencies.commandResult("uninstall", {
        ok: false,
        code: "UNINSTALL_PARTIAL",
        changed,
        nextStep: "Remove the Goal Progress Plugin in Codex, then retry uninstall.",
        details: {
          historyPreserved: input.preserveHistory,
          pluginRemoved: false,
          pluginError,
          helperStopped: true,
        },
      });
    }
    return dependencies.commandResult("uninstall", {
      ok: true,
      code: changed ? "UNINSTALL_OK" : "UNINSTALL_NOT_INSTALLED",
      changed,
      details: {
        historyPreserved: input.preserveHistory,
        pluginRemoved: true,
        helperStopped: true,
      },
    });
  };

  const emergencyDisable = async (): Promise<MacosCommandResult> => {
    const basePaths = resolveGoalProgressPaths({
      platform: "darwin",
      homeDirectory: dependencies.homeDirectory,
    });
    const installed = await readInstalledManifest(basePaths.installManifestPath);
    const releaseVersion = installed?.releaseVersion ?? "disabled";
    const layout = resolveMacosInstallationLayout({
      homeDirectory: dependencies.homeDirectory,
      releaseVersion,
    });
    let pluginChanged = false;
    let pluginError: string | null = null;
    try {
      const codex = await dependencies.discoverCodex();
      validateCodexIdentity(codex);
      pluginChanged = await (await dependencies.pluginFor(codex)).remove();
    } catch (error) {
      pluginError = stableErrorCode(error);
    }
    const jobChanged = await dependencies.launchAgent.remove(
      layout.launchAgentLabel,
      layout.launchAgentPath,
    );
    await waitForHelperStopped(basePaths);
    const currentExisted = await currentLinkExists(layout.currentReleasePath);
    await rm(layout.currentReleasePath, { recursive: true, force: true });
    const changed = pluginChanged || jobChanged || currentExisted;
    return dependencies.commandResult("emergency-disable", {
      ok: pluginError === null,
      code: pluginError === null ? "EMERGENCY_DISABLE_OK" : "EMERGENCY_DISABLE_PARTIAL",
      changed,
      nextStep:
        "Open /hooks, disable only the Goal Progress Hook if it is still listed, then run repair --json to re-enable.",
      details: {
        pluginRemoved: pluginError === null,
        pluginError,
        helperStopped: true,
        stableHookDisabled: true,
        historyPreserved: true,
      },
    });
  };

  return { emergencyDisable, uninstall };
}
