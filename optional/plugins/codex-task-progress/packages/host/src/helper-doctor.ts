import { lstat, readdir } from "node:fs/promises";
import type { GoalUsageSnapshot } from "../../codex-adapter/src/index.js";
import {
  GOAL_PROGRESS_IPC_PROTOCOL_VERSION,
  GoalProgressIpcClient,
  GoalProgressIpcHandlerError,
} from "../../ipc/src/index.js";
import {
  type GoalEventStore,
  type GoalProgressPaths,
  readCurrentHelperIdentity,
  resolveGoalProgressSessionPaths,
} from "../../store/src/index.js";
import { helperDiagnosticCauseCode, helperErrorCode } from "./helper-errors.js";
import {
  assertBoundNativeGoal,
  type TrustedNativeGoal,
  trustedNativeGoalFromThreadGoal,
} from "./helper-session-coordinator.js";

export interface GoalProgressDoctorResult {
  readonly schemaVersion: 1;
  readonly protocolVersion: typeof GOAL_PROGRESS_IPC_PROTOCOL_VERSION;
  readonly root: string;
  readonly helper: {
    readonly running: boolean;
    readonly pid: number | null;
    readonly instanceId: string | null;
  };
  readonly ipc: {
    readonly socketExists: boolean;
    readonly socketMode: number | null;
    readonly reachable: boolean;
    readonly code: string | null;
  };
  readonly store:
    | {
        readonly checked: false;
      }
    | {
        readonly checked: true;
        readonly sessionKey: string;
        readonly revision: number | null;
        readonly eventCount: number | null;
        readonly code: string | null;
      };
  readonly storeSmoke:
    | {
        readonly checked: false;
      }
    | {
        readonly checked: true;
        readonly readable: boolean;
        readonly sessionCount: number | null;
        readonly code: string | null;
      };
  readonly runtime: {
    readonly goal: {
      readonly actualThreadProven: boolean | null;
      readonly nativeGoalBindingMatches: boolean | null;
      readonly tokenAvailability: "available" | "stale" | "unavailable" | "unknown";
    };
    readonly lastErrorCode: string | null;
  };
}

function emptyDoctorRuntime(lastErrorCode: string | null): GoalProgressDoctorResult["runtime"] {
  return {
    goal: {
      actualThreadProven: null,
      nativeGoalBindingMatches: null,
      tokenAvailability: "unknown",
    },
    lastErrorCode,
  };
}

async function inspectSocket(path: string): Promise<{
  readonly exists: boolean;
  readonly mode: number | null;
}> {
  try {
    const metadata = await lstat(path);
    return {
      exists: metadata.isSocket(),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { exists: false, mode: null };
    }
    throw error;
  }
}

async function inspectStoreReadOnly(
  paths: GoalProgressPaths,
): Promise<Extract<GoalProgressDoctorResult["storeSmoke"], { checked: true }>> {
  try {
    const entries = await readdir(paths.stateRoot, { withFileTypes: true });
    return {
      checked: true,
      readable: true,
      sessionCount: entries.filter(
        (entry) => entry.isDirectory() && /^[0-9a-f]{64}$/u.test(entry.name),
      ).length,
      code: null,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { checked: true, readable: true, sessionCount: 0, code: null };
    }
    return {
      checked: true,
      readable: false,
      sessionCount: null,
      code: helperErrorCode(error),
    };
  }
}

export async function inspectGoalProgressLocal(
  paths: GoalProgressPaths,
  sessionId?: string,
  assumeReachable = false,
  storeInstance?: GoalEventStore,
): Promise<GoalProgressDoctorResult> {
  const identity = await readCurrentHelperIdentity(paths).catch(() => null);
  const socket = await inspectSocket(paths.helperSocketPath).catch(() => ({
    exists: false,
    mode: null,
  }));
  let reachable = assumeReachable;
  let ipcCode: string | null = null;
  if (socket.exists && !assumeReachable) {
    try {
      await new GoalProgressIpcClient(paths.helperSocketPath, {
        clientKind: "doctor",
        timeoutMs: 1_000,
      }).request({ method: "ping", params: {} });
      reachable = true;
    } catch (error) {
      ipcCode = helperErrorCode(error);
    }
  }

  let store: GoalProgressDoctorResult["store"] = { checked: false };
  if (sessionId) {
    const sessionPaths = resolveGoalProgressSessionPaths(paths, sessionId);
    try {
      if (!storeInstance) {
        throw new GoalProgressIpcHandlerError(
          "HELPER_UNAVAILABLE",
          "Store inspection requires the running Helper",
        );
      }
      const loaded = await storeInstance.load(sessionId);
      store = {
        checked: true,
        sessionKey: sessionPaths.sessionKey,
        revision: loaded.contract?.revision ?? null,
        eventCount: loaded.eventCount,
        code: null,
      };
    } catch (error) {
      store = {
        checked: true,
        sessionKey: sessionPaths.sessionKey,
        revision: null,
        eventCount: null,
        code: helperErrorCode(error),
      };
    }
  }

  return {
    schemaVersion: 1,
    protocolVersion: GOAL_PROGRESS_IPC_PROTOCOL_VERSION,
    root: paths.root,
    helper: {
      running: identity !== null,
      pid: identity?.pid ?? null,
      instanceId: identity?.instanceId ?? null,
    },
    ipc: {
      socketExists: socket.exists,
      socketMode: socket.mode,
      reachable,
      code: ipcCode,
    },
    store,
    storeSmoke:
      assumeReachable && storeInstance ? await inspectStoreReadOnly(paths) : { checked: false },
    runtime: emptyDoctorRuntime(reachable ? null : "HELPER_UNAVAILABLE"),
  };
}

export async function inspectGoalProgress(
  paths: GoalProgressPaths,
  sessionId?: string,
): Promise<GoalProgressDoctorResult> {
  const base = await inspectGoalProgressLocal(paths);
  if (base.ipc.reachable) {
    try {
      const response = await new GoalProgressIpcClient(paths.helperSocketPath, {
        clientKind: "doctor",
        timeoutMs: 1_000,
      }).request({
        method: "doctor",
        params: sessionId === undefined ? {} : { sessionId },
      });
      if (
        response.result !== null &&
        typeof response.result === "object" &&
        "schemaVersion" in response.result &&
        response.result.schemaVersion === 1
      ) {
        return response.result as GoalProgressDoctorResult;
      }
    } catch {
      // Fall through to a read-only offline result.
    }
  }
  return {
    ...base,
    store:
      sessionId === undefined
        ? { checked: false }
        : {
            checked: true,
            sessionKey: resolveGoalProgressSessionPaths(paths, sessionId).sessionKey,
            revision: null,
            eventCount: null,
            code: "HELPER_UNAVAILABLE",
          },
  };
}

export interface RuntimeDoctorDependencies {
  readonly store: GoalEventStore;
  readonly refreshUsage: (threadId: string) => Promise<GoalUsageSnapshot | undefined>;
  readonly readNativeGoal: (
    threadId: string,
    revision: number | null,
  ) => Promise<TrustedNativeGoal | null>;
}

export async function inspectGoalProgressRuntime(
  sessionId: string | undefined,
  dependencies: RuntimeDoctorDependencies,
): Promise<GoalProgressDoctorResult["runtime"]> {
  let lastErrorCode: string | null = null;
  let actualThreadProven: boolean | null = null;
  let nativeGoalBindingMatches: boolean | null = null;
  let tokenAvailability: GoalProgressDoctorResult["runtime"]["goal"]["tokenAvailability"] =
    "unknown";
  if (sessionId) {
    const loaded = await dependencies.store.load(sessionId).catch(() => null);
    const contract = loaded?.contract;
    if (contract?.schemaVersion === 2) {
      actualThreadProven =
        contract.threadId === sessionId &&
        contract.sessionId === sessionId &&
        contract.nativeGoalBinding.threadId === sessionId;
      const usage = await dependencies.refreshUsage(sessionId);
      tokenAvailability =
        usage?.tokenUsage.availability === "available"
          ? usage.stale
            ? "stale"
            : "available"
          : usage?.tokenUsage.availability === "unavailable"
            ? "unavailable"
            : "unknown";
      try {
        assertBoundNativeGoal(
          contract,
          usage
            ? trustedNativeGoalFromThreadGoal(usage.goal)
            : await dependencies.readNativeGoal(sessionId, contract.revision),
          contract.revision,
        );
        nativeGoalBindingMatches = true;
      } catch (error) {
        nativeGoalBindingMatches = false;
        lastErrorCode ??= helperDiagnosticCauseCode(error);
      }
    }
  }

  return {
    goal: {
      actualThreadProven,
      nativeGoalBindingMatches,
      tokenAvailability,
    },
    lastErrorCode,
  };
}
