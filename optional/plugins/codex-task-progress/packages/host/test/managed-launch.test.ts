import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_BUNDLE_ID,
  CODEX_TEAM_ID,
  type CodexMacosAppIdentity,
} from "../../../platform/macos/src/app-discovery.js";
import type { CodexCdpProcessSnapshot } from "../../../platform/macos/src/cdp-runtime.js";
import { parseMacosCommand } from "../../../platform/macos/src/command-protocol.js";
import {
  type ManagedLaunchDependencies,
  managedLaunch,
} from "../../../platform/macos/src/managed-launch.js";

const app: CodexMacosAppIdentity = {
  appPath: "/Applications/Codex App.app",
  realAppPath: "/Applications/Codex App.app",
  executableName: "Codex",
  executablePath: "/Applications/Codex App.app/Contents/MacOS/Codex",
  realExecutablePath: "/Applications/Codex App.app/Contents/MacOS/Codex",
  bundleId: CODEX_BUNDLE_ID,
  teamId: CODEX_TEAM_ID,
  shortVersion: "1.0.0",
  bundleVersion: "1",
  signingAuthority: "Developer ID Application",
  architectures: ["arm64"],
  hostArchitecture: "arm64",
  fileDescription: "Mach-O arm64 executable",
  signatureValid: true,
};
const processSnapshot: CodexCdpProcessSnapshot = {
  pid: 43,
  parentPid: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  command: app.realExecutablePath,
};

async function fixture(
  run: (context: {
    input: Parameters<typeof managedLaunch>[0];
    events: string[];
    running: CodexCdpProcessSnapshot[];
    setReady: (value: boolean) => void;
    setCdp: (value: boolean) => void;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "managed-launch-"));
  const previousRoot = process.env.GOAL_PROGRESS_ROOT;
  process.env.GOAL_PROGRESS_ROOT = join(home, "isolated-data");
  const events: string[] = [];
  const running: CodexCdpProcessSnapshot[] = [];
  let ready = true,
    cdp = true;
  const deps: Partial<ManagedLaunchDependencies> = {
    inspectApp: async () => app,
    list: async () => [...running],
    allocate: async () => 23456,
    launch: async (_app, options) => {
      events.push(`launch:${options.port}`);
      running.push(processSnapshot);
      return {
        pid: 43,
        processStartedAt: processSnapshot.startedAt,
        command: processSnapshot.command,
        launchedAt: processSnapshot.startedAt,
        args: [],
        child: { unref: () => events.push("unref") },
      } as never;
    },
    ownership: async () => ({ mainProcess: processSnapshot, listeners: [], listenerPids: [43] }),
    save: async (_path, state) => {
      assert.equal(state.mainPid, 43);
      assert.equal(state.port, 23456);
      events.push("save");
    },
    activate: async () => {
      events.push("activate");
    },
    normal: async () => {
      events.push("normal");
    },
    ready: async () => ready,
    alive: async () => false,
    waitReady: async () => {
      events.push("wait");
      return true;
    },
    kickstart: async () => {
      events.push("kickstart");
    },
  };
  const input: Parameters<typeof managedLaunch>[0] = {
    homeDirectory: home,
    codex: app,
    dependencies: deps,
    launchAgent: {
      isLoaded: async () => false,
      ensure: async (_label, _path, restart) => {
        assert.equal(restart, false);
        events.push("ensure");
        return true;
      },
      remove: async () => false,
    },
    cdp: { verify: async () => cdp, ensure: async () => false },
  };
  try {
    await run({
      input,
      events,
      running,
      setReady: (v) => {
        ready = v;
      },
      setCdp: (v) => {
        cdp = v;
      },
    });
  } finally {
    if (previousRoot === undefined) delete process.env.GOAL_PROGRESS_ROOT;
    else process.env.GOAL_PROGRESS_ROOT = previousRoot;
    await rm(home, { recursive: true, force: true });
  }
}

test("launch command only accepts JSON and launcher actions are exclusive", () => {
  assert.equal(parseMacosCommand(["install", "--defer-connection", "--json"]).ok, true);
  assert.equal(
    parseMacosCommand(["install", "--defer-connection", "--json", "--restart-codex"]).ok,
    false,
  );
  assert.equal(parseMacosCommand(["install", "--defer-connection", "--human"]).ok, false);
  assert.equal(parseMacosCommand(["upgrade", "--defer-connection", "--json"]).ok, false);
  assert.equal(parseMacosCommand(["launch", "--defer-connection", "--json"]).ok, false);
  assert.equal(parseMacosCommand(["launch", "--json"]).ok, true);
  assert.equal(parseMacosCommand(["launch", "--json", "--restart-codex"]).ok, false);
  assert.equal(parseMacosCommand(["launcher", "--install", "--dock", "--json"]).ok, true);
  assert.equal(parseMacosCommand(["launcher", "--status", "--dock", "--json"]).ok, false);
});

test("bootstraps stopped helper and records verified new app identity", async () =>
  fixture(async ({ input, events, setReady }) => {
    setReady(false);
    assert.equal((await managedLaunch(input)).cdpReady, true);
    assert.deepEqual(events, ["ensure", "wait", "launch:23456", "save", "unref"]);
  }));

test("existing app is activated without restart and reports pending when CDP absent", async () =>
  fixture(async ({ input, events, running, setCdp }) => {
    running.push(processSnapshot);
    setCdp(false);
    assert.deepEqual(await managedLaunch(input), {
      changed: false,
      cdpReady: false,
      connectionRebuildPending: true,
    });
    assert.deepEqual(events, ["activate"]);
  }));

test("existing verified CDP is reused and helper is untouched", async () =>
  fixture(async ({ input, events, running }) => {
    running.push(processSnapshot);
    assert.equal((await managedLaunch(input)).cdpReady, true);
    assert.deepEqual(events, ["activate"]);
  }));

test("ambiguous apps and unverified CDP fail closed", async () =>
  fixture(async ({ input, events, running, setCdp }) => {
    running.push(processSnapshot, { ...processSnapshot, pid: 44 });
    await assert.rejects(managedLaunch(input), /AMBIGUOUS/);
    running.splice(0, 2, {
      ...processSnapshot,
      command: `${app.realExecutablePath} --remote-debugging-port=23456`,
    });
    setCdp(false);
    await assert.rejects(managedLaunch(input), /OWNERSHIP_UNVERIFIED/);
    assert.deepEqual(events, []);
  }));

test("concurrent launches serialize and second reuses first app", async () =>
  fixture(async ({ input, events }) => {
    await Promise.all([managedLaunch(input), managedLaunch(input)]);
    assert.deepEqual(events, ["launch:23456", "save", "unref", "activate"]);
  }));

test("loaded but stopped helper is kickstarted without restart", async () =>
  fixture(async ({ input, events, setReady }) => {
    setReady(false);
    const loaded = { ...input, launchAgent: { ...input.launchAgent, isLoaded: async () => true } };
    await managedLaunch(loaded);
    assert.deepEqual(events.slice(0, 2), ["kickstart", "wait"]);
  }));

test("launcher install disables legacy startup recovery only on success", async () => {
  const { createMacosCommandHandlers } = await import("../../../platform/macos/src/installer.js");
  const { cdpPaths } = await import("../../../platform/macos/src/cdp-controller.js");
  const { readCodexStartupRecoveryPolicy, writeCodexStartupRecoveryPolicy } = await import(
    "../../../platform/macos/src/startup-recovery-policy.js"
  );
  const home = await mkdtemp(join(tmpdir(), "launcher-policy-"));
  const previousRoot = process.env.GOAL_PROGRESS_ROOT;
  process.env.GOAL_PROGRESS_ROOT = join(home, "isolated-data");
  try {
    const paths = cdpPaths(home);
    await writeCodexStartupRecoveryPolicy(paths, "enable");
    let succeeds = false;
    const handlers = createMacosCommandHandlers({
      homeDirectory: home,
      releaseRoot: home,
      discoverCodex: async () => app,
      manageLauncher: async () => ({ ok: succeeds, code: "TEST", changed: succeeds, details: {} }),
    });
    const input = {
      command: "launcher" as const,
      launcherAction: "install" as const,
      configureDock: true,
      json: true,
      human: false,
      verbose: false,
      restartCodex: false,
      preserveHistory: true,
      startupRecoveryAction: null,
    };
    await handlers.launcher(input);
    assert.equal((await readCodexStartupRecoveryPolicy(paths)).autoPrepareOnLaunch, true);
    succeeds = true;
    await handlers.launcher(input);
    assert.equal((await readCodexStartupRecoveryPolicy(paths)).autoPrepareOnLaunch, false);
  } finally {
    if (previousRoot === undefined) delete process.env.GOAL_PROGRESS_ROOT;
    else process.env.GOAL_PROGRESS_ROOT = previousRoot;
    await rm(home, { recursive: true, force: true });
  }
});

test("stale launch owner is reclaimed using the shared instance lock", async () =>
  fixture(async ({ input, events }) => {
    const { acquireHelperInstanceLock } = await import("../../store/src/index.js");
    let planted = false;
    const dependencies = {
      ...input.dependencies,
      acquireLock: async (paths: Parameters<typeof acquireHelperInstanceLock>[0]) => {
        if (!planted) {
          planted = true;
          await acquireHelperInstanceLock(paths, {
            pid: 999999,
            isProcessIdentityCurrent: () => true,
          });
        }
        return acquireHelperInstanceLock(paths, {
          isProcessIdentityCurrent: (identity) => identity.pid !== 999999,
        });
      },
    };
    await managedLaunch({ ...input, dependencies });
    assert.ok(events.includes("save"));
  }));

test("live launch owner receives bounded wait and fails closed", async () =>
  fixture(async ({ input, events }) => {
    const { GoalProgressStoreError } = await import("../../store/src/index.js");
    let attempts = 0;
    const dependencies = {
      ...input.dependencies,
      acquireLock: async () => {
        attempts += 1;
        throw new GoalProgressStoreError("HELPER_ALREADY_RUNNING", "busy");
      },
      wait: async () => {},
    };
    await assert.rejects(managedLaunch({ ...input, dependencies }), /MANAGED_LAUNCH_LOCKED/);
    assert.equal(attempts, 150);
    assert.deepEqual(events, []);
  }));

test("lock release failure is reported instead of hidden", async () =>
  fixture(async ({ input }) => {
    const dependencies = {
      ...input.dependencies,
      acquireLock: async () => ({
        release: async () => {
          throw new Error("release failed");
        },
      }),
    };
    await assert.rejects(managedLaunch({ ...input, dependencies }), /release failed/);
  }));

test("app exit during activation does not report a ready connection", async () =>
  fixture(async ({ input, running }) => {
    running.push(processSnapshot);
    const dependencies = {
      ...input.dependencies,
      activate: async () => {
        running.length = 0;
      },
    };
    const result = await managedLaunch({ ...input, dependencies });
    assert.equal(result.cdpReady, false);
    assert.equal(result.connectionRebuildPending, true);
  }));

test("failed ownership and failed normal fallback are reported", async () =>
  fixture(async ({ input, running }) => {
    const dependencies = {
      ...input.dependencies,
      ownership: async () => {
        running.length = 0;
        throw new Error("listener failed");
      },
      normal: async () => {
        throw new Error("normal failed");
      },
    };
    await assert.rejects(managedLaunch({ ...input, dependencies }), /FALLBACK_RESTART_FAILED/);
  }));

test("uninstall cleans the owned launcher before plugin and Helper, and preserves retained entries", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { createMacosCommandHandlers } = await import("../../../platform/macos/src/installer.js");
  const { resolveCodexDockLauncherPaths } = await import(
    "../../../platform/macos/src/dock-launcher.js"
  );
  for (const mode of ["removed", "failed", "retained", "legacy"] as const) {
    const home = await mkdtemp(join(tmpdir(), "uninstall-launcher-"));
    const previousRoot = process.env.GOAL_PROGRESS_ROOT;
    process.env.GOAL_PROGRESS_ROOT = join(home, "data");
    const events: string[] = [];
    try {
      if (mode !== "legacy") {
        const { markerPath } = resolveCodexDockLauncherPaths(home);
        await mkdir(join(markerPath, ".."), { recursive: true });
        await writeFile(markerPath, "fixture");
      }
      const handlers = createMacosCommandHandlers({
        homeDirectory: home,
        releaseRoot: home,
        discoverCodex: async () => app,
        launchAgent: {
          isLoaded: async () => false,
          ensure: async () => false,
          remove: async () => {
            events.push("helper");
            return true;
          },
        },
        plugin: {
          ensure: async () => false,
          verify: async () => true,
          remove: async () => {
            events.push("plugin");
            return true;
          },
        },
        restoreCdp: async () => ({ changed: false, scheduled: false, restartedCodex: false }),
        manageLauncher: async (input) => {
          events.push("launcher");
          assert.equal(input.action, "remove");
          assert.equal(input.configureDock, true);
          return {
            ok: mode !== "failed",
            code: mode,
            changed: mode === "removed",
            details: {
              launcherInstalled: mode === "retained",
              dockConfigured: mode === "retained",
              retainedForUserEdit: mode === "retained",
            },
          };
        },
      });
      const result = await handlers.uninstall({
        command: "uninstall",
        json: true,
        human: false,
        verbose: false,
        restartCodex: false,
        preserveHistory: true,
        startupRecoveryAction: null,
      });
      if (mode === "failed" || mode === "retained") {
        assert.equal(result.ok, false);
        assert.equal(result.code, "UNINSTALL_LAUNCHER_CLEANUP_BLOCKED");
        assert.deepEqual(events, ["launcher"]);
      } else {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(
          events,
          mode === "legacy" ? ["plugin", "helper"] : ["launcher", "plugin", "helper"],
        );
      }
    } finally {
      if (previousRoot === undefined) delete process.env.GOAL_PROGRESS_ROOT;
      else process.env.GOAL_PROGRESS_ROOT = previousRoot;
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("alive Helper with a late listener is awaited without churn", async () =>
  fixture(async ({ input, events, setReady, running }) => {
    setReady(false);
    running.push(processSnapshot);
    const result = await managedLaunch({
      ...input,
      dependencies: { ...input.dependencies, alive: async () => true },
    });
    assert.equal(result.changed, false);
    assert.deepEqual(events, ["wait", "activate"]);
  }));

test("readiness waits for listener and supports old or listener-free Helper pings", async () => {
  const { evaluateHelperReadiness } = await import(
    "../../../platform/macos/src/installed-inspection.js"
  );
  const { waitForHelperReady, HELPER_READY_TIMEOUT_MS } = await import(
    "../../../platform/macos/src/helper-wait.js"
  );
  const { GOAL_PROGRESS_IPC_PROTOCOL_VERSION } = await import("../../ipc/src/index.js");
  const ping = { status: "ok", pid: 10, ready: true };
  assert.equal(evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, ping).ready, true);
  assert.equal(
    evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, {
      ...ping,
      startupListener: { running: false, ready: true },
    }).ready,
    false,
  );
  assert.equal(
    evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, {
      ...ping,
      startupListener: { running: true, ready: false },
    }).ready,
    false,
  );
  let now = 0,
    calls = 0;
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
  const delayed = await waitForHelperReady(
    async () =>
      evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, {
        ...ping,
        startupListener: { running: true, ready: ++calls >= 3 },
      }),
    clock,
  );
  assert.equal(delayed, true);
  assert.equal(calls, 3);
  now = 0;
  const never = await waitForHelperReady(
    async () =>
      evaluateHelperReadiness(GOAL_PROGRESS_IPC_PROTOCOL_VERSION, {
        ...ping,
        startupListener: { running: true, ready: false },
      }),
    clock,
  );
  assert.equal(never, false);
  assert.equal(now, HELPER_READY_TIMEOUT_MS);
});
