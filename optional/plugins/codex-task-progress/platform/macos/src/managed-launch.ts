import { resolve } from "node:path";
import {
  acquireHelperInstanceLock,
  type GoalProgressPaths,
  GoalProgressStoreError,
  type HelperInstanceLock,
} from "../../../packages/store/src/index.js";
import {
  type CodexMacosAppIdentity,
  inspectCodexMacosApp,
  runSystemCommand,
} from "./app-discovery.js";
import type { CdpController } from "./cdp-controller.js";
import { cdpPaths, runCdpRestartWithFallback } from "./cdp-controller.js";
import {
  allocateRandomLoopbackPort,
  createCodexCdpRuntimeState,
  launchCodexNormally,
  launchCodexWithCdp,
  listCodexMainProcesses,
  waitForCodexCdpListenerOwnership,
  writeCodexCdpRuntimeState,
} from "./cdp-runtime.js";
import { waitForHelperReady } from "./helper-wait.js";
import { resolveMacosInstallationLayout } from "./install-layout.js";
import { inspectInstalledHelperReadiness } from "./installed-inspection.js";
import { type LaunchAgentController, launchDomain } from "./launch-agent-controller.js";
import type { CodexInstallIdentity } from "./verified-release.js";

export interface ManagedLaunchDependencies {
  readonly acquireLock: (paths: GoalProgressPaths) => Promise<Pick<HelperInstanceLock, "release">>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly inspectApp: (path: string) => Promise<CodexMacosAppIdentity>;
  readonly list: typeof listCodexMainProcesses;
  readonly allocate: typeof allocateRandomLoopbackPort;
  readonly launch: typeof launchCodexWithCdp;
  readonly ownership: typeof waitForCodexCdpListenerOwnership;
  readonly save: typeof writeCodexCdpRuntimeState;
  readonly activate: (app: CodexMacosAppIdentity) => Promise<void>;
  readonly normal: typeof launchCodexNormally;
  readonly ready: () => Promise<boolean>;
  readonly alive: () => Promise<boolean>;
  readonly waitReady: () => Promise<boolean>;
  readonly kickstart: (label: string) => Promise<void>;
}

export async function managedLaunch(input: {
  readonly homeDirectory: string;
  readonly codex: CodexInstallIdentity;
  readonly launchAgent: LaunchAgentController;
  readonly cdp: CdpController;
  readonly dependencies?: Partial<ManagedLaunchDependencies>;
}): Promise<{
  readonly changed: boolean;
  readonly cdpReady: boolean;
  readonly connectionRebuildPending: boolean;
}> {
  const paths = cdpPaths(input.homeDirectory);
  const layout = resolveMacosInstallationLayout({
    homeDirectory: input.homeDirectory,
    releaseVersion: "current",
  });
  const deps: ManagedLaunchDependencies = {
    acquireLock: acquireHelperInstanceLock,
    wait: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    inspectApp: inspectCodexMacosApp,
    list: listCodexMainProcesses,
    allocate: allocateRandomLoopbackPort,
    launch: launchCodexWithCdp,
    ownership: waitForCodexCdpListenerOwnership,
    save: writeCodexCdpRuntimeState,
    activate: async (app) => {
      const result = await runSystemCommand("/usr/bin/open", [app.realAppPath]);
      if (result.exitCode !== 0) throw new Error("GOAL_PROGRESS_CODEX_ACTIVATE_FAILED");
    },
    normal: launchCodexNormally,
    ready: async () => (await inspectInstalledHelperReadiness(paths)).ready,
    alive: async () => (await inspectInstalledHelperReadiness(paths)).pingOk,
    waitReady: () =>
      waitForHelperReady((timeout) => inspectInstalledHelperReadiness(paths, timeout)),
    kickstart: async (label) => {
      const result = await runSystemCommand("/bin/launchctl", [
        "kickstart",
        `${launchDomain()}/${label}`,
      ]);
      if (result.exitCode !== 0) throw new Error("GOAL_PROGRESS_HELPER_START_FAILED");
    },
    ...input.dependencies,
  };
  const lockRoot = resolve(paths.runtimeRoot, "managed-launch");
  const lockPaths: GoalProgressPaths = {
    ...paths,
    runtimeRoot: lockRoot,
    helperLocksRoot: resolve(lockRoot, "locks"),
    helperPidPath: resolve(lockRoot, "owner.json"),
  };
  let lock: Pick<HelperInstanceLock, "release"> | undefined;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      lock = await deps.acquireLock(lockPaths);
      break;
    } catch (error) {
      if (!(error instanceof GoalProgressStoreError) || error.code !== "HELPER_ALREADY_RUNNING")
        throw error;
      if (attempt === 149) throw new Error("GOAL_PROGRESS_MANAGED_LAUNCH_LOCKED");
      await deps.wait(100);
    }
  }
  if (!lock) throw new Error("GOAL_PROGRESS_MANAGED_LAUNCH_LOCKED");
  try {
    const app = await deps.inspectApp(input.codex.realAppPath);
    if (
      app.realAppPath !== input.codex.realAppPath ||
      app.bundleId !== input.codex.bundleId ||
      app.teamId !== input.codex.teamId ||
      (input.codex.realExecutablePath && app.realExecutablePath !== input.codex.realExecutablePath)
    )
      throw new Error("GOAL_PROGRESS_CODEX_IDENTITY_MISMATCH");
    let changed = false;
    if (!(await deps.ready())) {
      if (!(await deps.alive())) {
        if (await input.launchAgent.isLoaded(layout.launchAgentLabel))
          await deps.kickstart(layout.launchAgentLabel);
        else await input.launchAgent.ensure(layout.launchAgentLabel, layout.launchAgentPath, false);
        changed = true;
      }
      if (!(await deps.waitReady())) throw new Error("GOAL_PROGRESS_HELPER_NOT_READY");
    }
    const running = await deps.list(app);
    if (running.length > 1) throw new Error("GOAL_PROGRESS_CODEX_MAIN_PROCESS_AMBIGUOUS");
    const existing = running[0];
    if (existing) {
      const cdpReady = await input.cdp.verify(app);
      if (!cdpReady && /(?:^|\s)--remote-debugging-port(?:=|\s)/u.test(existing.command))
        throw new Error("GOAL_PROGRESS_CDP_OWNERSHIP_UNVERIFIED");
      await deps.activate(app);
      const afterActivation = await deps.list(app);
      if (afterActivation.length > 1) throw new Error("GOAL_PROGRESS_CODEX_MAIN_PROCESS_AMBIGUOUS");
      const after = afterActivation[0];
      const sameProcess =
        afterActivation.length === 1 &&
        after !== undefined &&
        after.pid === existing.pid &&
        after.startedAt === existing.startedAt &&
        after.command === existing.command;
      const stillReady = sameProcess && cdpReady && (await input.cdp.verify(app));
      return { changed, cdpReady: stillReady, connectionRebuildPending: !stillReady };
    }
    const port = await deps.allocate();
    // Recheck immediately before spawning; an external launch may have raced the lock.
    if ((await deps.list(app)).length !== 0) throw new Error("GOAL_PROGRESS_CODEX_LAUNCH_RACE");
    let spawned = false;
    await runCdpRestartWithFallback(
      async () => {
        const launched = await deps.launch(app, { port });
        spawned = true;
        const ownership = await deps.ownership(app, launched.pid, port);
        await deps.save(
          paths.cdpRuntimePath,
          createCodexCdpRuntimeState(app, launched, ownership, port),
        );
        if (!(await input.cdp.verify(app))) throw new Error("GOAL_PROGRESS_CDP_VERIFY_FAILED");
        launched.child.unref();
      },
      async () => {
        // A process or an uncertain lookup prevents fallback; never signal an app here.
        if (spawned && (await deps.list(app)).length === 0) await deps.normal(app);
      },
    );
    return { changed: true, cdpReady: true, connectionRebuildPending: false };
  } finally {
    await lock.release();
  }
}
