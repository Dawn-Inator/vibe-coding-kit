import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readOptionalGroupPreference } from "vibe-coding-kit/src/optional/preferences.mjs";
import { z } from "zod";
import { inspectCodexMacosApp } from "../../../platform/macos/src/app-discovery.js";
import { resolveVerifiedCodexCli } from "../../../platform/macos/src/plugin-controller.js";
import {
  type CodexAppServerRuntime,
  createCodexAppServerRuntime,
  type GoalUsageSnapshot,
} from "../../codex-adapter/src/index.js";
import {
  DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
  type GoalContract,
  type GoalContractAny,
  type GoalProgressCommand,
  type GoalProgressTrackingOverlay,
  type GoalProgressUiPreference,
  type GoalProgressViewModel,
  issueRuntimeProof,
  type RuntimeContext,
  type RuntimeIdentity,
  type RuntimeProof,
  verifyRuntimeProof,
} from "../../contracts/src/index.js";
import { selectProgressTarget } from "../../contracts/src/progress-focus.js";
import {
  hashNativeGoalObjective,
  type ProjectViewModelOptions,
  planGoalProgressActivation,
  projectGoalProgressViewModel,
} from "../../core/src/index.js";
import {
  consumeRuntimeProofOnce,
  type GoalProgressActivationResumeResult,
  type GoalProgressIpcAuthorization,
  type GoalProgressIpcConnectionContext,
  type GoalProgressIpcHandler,
  GoalProgressIpcHandlerError,
  type GoalProgressIpcHandlerResult,
  GoalProgressIpcServer,
  loadOrCreateRuntimeProofKey,
} from "../../ipc/src/index.js";
import {
  acquireHelperInstanceLock,
  GoalEventStore,
  type GoalEventStoreOptions,
  type GoalEventStoreWriteSuccess,
  GoalProgressLogger,
  type GoalProgressLoggerOptions,
  type GoalProgressLogInput,
  type GoalProgressPaths,
  type HelperInstanceLock,
  type HelperLockOptions,
  hashGoalProgressIdentity,
  readGoalProgressTrackingOverlay,
  readGoalProgressUiPreference,
  resolveGoalProgressPaths,
  resolveGoalProgressSessionPaths,
  writeGoalProgressTrackingOverlay,
} from "../../store/src/index.js";
import {
  getTaskArchiveCount,
  TaskArchiveInputSchema,
  TaskCompleteInputSchema,
  TaskInitializeInputSchema,
  TaskRescopeInputSchema,
  TaskUpdateInputSchema,
} from "../../tasks/src/index.js";
import { projectTaskExecution } from "../../tasks/src/task-execution.js";
import { WorkspaceTaskStorage } from "../../tasks/src/workspace-storage.js";
import {
  type GoalProgressDoctorResult,
  inspectGoalProgress,
  inspectGoalProgressLocal,
  inspectGoalProgressRuntime,
} from "./helper-doctor.js";
import { helperDiagnosticCauseCode, helperErrorCode } from "./helper-errors.js";
import {
  type HelperActivationIpcRequest,
  type HelperDoctorIpcRequest,
  type HelperHookIpcRequest,
  HelperIpcRouter,
  type HelperStoreIpcRequest,
  type HelperSystemIpcRequest,
  type HelperTaskIpcRequest,
} from "./helper-ipc-router.js";
import {
  assertBoundNativeGoal,
  contractNativeGoal,
  createModelContract,
  DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
  detachReasonForNativeGoalError,
  type GoalProgressActivationState,
  type GoalProgressDetachReason,
  GoalProgressSessionCoordinator,
  identityLogFields,
  isUserDetachedActivationState,
  type NativeGoalResolver,
  nativeGoalErrorDetachesContract,
  type ReadThreadIdentity,
  type ResolveCurrentThread,
  readGoalProgressActivationState,
  readGoalProgressActivationStateSnapshot,
  sanitizeModelEvidence,
  sanitizeModelObjective,
  type TrustedNativeGoal,
  trustedNativeGoalFromThreadGoal,
  writeGoalProgressActivationState,
} from "./helper-session-coordinator.js";

export { type GoalProgressDoctorResult, inspectGoalProgress } from "./helper-doctor.js";
export type {
  NativeGoalResolver,
  ResolveCurrentThread,
  TrustedNativeGoal,
} from "./helper-session-coordinator.js";

type TaskDiagnosticStage =
  | "native-identity"
  | "project-preferences"
  | "workspace-routing"
  | "task-projection"
  | "project-view"
  | "project-view-snapshot"
  | "local-task-store"
  | "history";

const TASK_DIAGNOSTIC_STAGES: readonly TaskDiagnosticStage[] = [
  "native-identity",
  "project-preferences",
  "workspace-routing",
  "task-projection",
  "project-view",
  "project-view-snapshot",
  "local-task-store",
  "history",
];
const TASK_SLOW_DIAGNOSTIC_THRESHOLD_MS = 500;

export interface GoalProgressHelperOptions {
  readonly paths?: GoalProgressPaths;
  readonly lock?: HelperLockOptions;
  readonly store?: GoalEventStoreOptions;
  readonly logger?: GoalProgressLoggerOptions;
  readonly runtime?: CodexAppServerRuntime;
  readonly resolveNativeGoal?: NativeGoalResolver;
  readonly resolveCurrentThread?: ResolveCurrentThread;
  readonly readThreadIdentity?: ReadThreadIdentity;
}

function requestAuthorization(
  params:
    | { readonly auth: GoalProgressIpcAuthorization }
    | {
        readonly runtimeContext: RuntimeContext;
        readonly runtimeProof: RuntimeProof;
      },
): GoalProgressIpcAuthorization {
  return "auth" in params
    ? params.auth
    : {
        kind: "hook-proof",
        runtimeContext: params.runtimeContext,
        runtimeProof: params.runtimeProof,
      };
}

export function resolveGoalProgressCodexCommand(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | (() => Promise<string>) | undefined {
  const appPath = environment.GOAL_PROGRESS_CODEX_APP_PATH?.trim();
  if (appPath) {
    return async () => resolveVerifiedCodexCli(await inspectCodexMacosApp(appPath));
  }
  const command = environment.GOAL_PROGRESS_CODEX_COMMAND?.trim();
  return command ? command : undefined;
}

function projectContract(
  contract: GoalContractAny,
  usage?: GoalUsageSnapshot,
  overlay: GoalProgressTrackingOverlay = DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
): GoalProgressViewModel {
  const projected = projectGoalProgressViewModel(contract, {
    ...viewModelOptionsFromUsage(usage, contract.sessionId),
    ...(overlay.detached ? { detached: true } : {}),
  });
  if (!projected.ok) {
    throw new GoalProgressIpcHandlerError(projected.code, projected.message, contract.revision);
  }
  return projected.viewModel;
}

function viewModelOptionsFromUsage(
  usage: GoalUsageSnapshot | undefined,
  sessionId: string,
): ProjectViewModelOptions {
  if (!usage || usage.threadId !== sessionId) {
    return {};
  }
  return {
    tokenUsage: usage.tokenUsage,
    ...(usage.stale ? { tokenStale: true } : {}),
    ...(usage.unavailable ? { tokenUnavailable: true } : {}),
  };
}

function projectContractState(
  contract: GoalContractAny,
  usage?: GoalUsageSnapshot,
  overlay: GoalProgressTrackingOverlay = DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
): {
  readonly viewModel: GoalProgressViewModel;
  readonly nextTargetId: string | null;
} {
  const viewModel = projectContract(contract, usage, overlay);
  if (viewModel.trackingPhase === "detached") {
    return { viewModel, nextTargetId: null };
  }
  const objectiveView = selectProgressTarget(viewModel.objectives);
  if (!objectiveView) {
    return { viewModel, nextTargetId: null };
  }
  if (objectiveView.status === "blocked") {
    return { viewModel, nextTargetId: objectiveView.id };
  }
  const objective = contract.objectives.find((candidate) => candidate.id === objectiveView.id);
  const item = selectProgressTarget(objective?.items ?? []);
  return { viewModel, nextTargetId: item?.id ?? objectiveView.id };
}

function sanitizeModelCommand(
  command: GoalProgressCommand,
  previous?: GoalContract,
): GoalProgressCommand {
  if (command.type === "update-items") {
    return {
      ...command,
      source: "model",
      changes: command.changes.map((change) => ({
        ...change,
        ...(change.evidence ? { evidence: change.evidence.map(sanitizeModelEvidence) } : {}),
      })),
    };
  }
  if (command.type === "rescope") {
    return {
      ...command,
      source: "model",
      objectives: command.objectives.map((objective) =>
        sanitizeModelObjective(
          objective,
          previous?.objectives.find((stored) => stored.id === objective.id),
        ),
      ),
    };
  }
  return { ...command, source: "model" };
}

export class GoalProgressHelper {
  readonly paths: GoalProgressPaths;
  readonly #lockOptions: HelperLockOptions;
  readonly #logger: GoalProgressLogger;
  readonly #store: GoalEventStore;
  readonly #workspaceStorage: WorkspaceTaskStorage;
  readonly #runtime: CodexAppServerRuntime;
  readonly #sessionCoordinator: GoalProgressSessionCoordinator;
  readonly #enableGoalWatch: boolean;
  readonly #goalUsage = new Map<string, GoalUsageSnapshot>();
  readonly #preparingObjectives = new Map<string, string>();
  #lock: HelperInstanceLock | undefined;
  #server: GoalProgressIpcServer | undefined;
  #runtimeProofKey: Uint8Array | undefined;
  #ready = false;

  constructor(options: GoalProgressHelperOptions = {}) {
    this.paths = options.paths ?? resolveGoalProgressPaths();
    this.#workspaceStorage = new WorkspaceTaskStorage(this.paths.root);
    this.#lockOptions = options.lock ?? {};
    this.#logger = new GoalProgressLogger(this.paths.helperLogPath, options.logger);
    this.#store = new GoalEventStore(this.paths, {
      ...options.store,
      logger: this.#logger,
    });
    const codexCommand = resolveGoalProgressCodexCommand();
    this.#runtime =
      options.runtime ??
      createCodexAppServerRuntime(codexCommand === undefined ? {} : { command: codexCommand });
    this.#enableGoalWatch = options.resolveNativeGoal === undefined;
    const resolveNativeGoal =
      options.resolveNativeGoal ??
      (async (threadId) => trustedNativeGoalFromThreadGoal(await this.#runtime.getGoal(threadId)));
    const resolveCurrentThread =
      options.resolveCurrentThread ?? ((input) => this.#runtime.resolveCurrentThread(input));
    const readThreadIdentity =
      options.readThreadIdentity ?? ((threadId) => this.#runtime.readThreadIdentity(threadId));
    this.#sessionCoordinator = new GoalProgressSessionCoordinator({
      store: this.#store,
      resolveNativeGoal,
      resolveCurrentThread,
      readThreadIdentity,
      consumeRuntimeProof: (runtimeContext, runtimeProof) =>
        this.#consumeRuntimeProof(runtimeContext, runtimeProof),
      log: (input) => this.#log(input),
    });
  }

  async #log(input: GoalProgressLogInput): Promise<void> {
    await this.#logger.write(input).catch(() => undefined);
  }

  #usageFor(contract: GoalContractAny): GoalUsageSnapshot | undefined {
    const threadId = contract.schemaVersion === 2 ? contract.threadId : contract.sessionId;
    return this.#goalUsage.get(threadId);
  }

  #project(
    contract: GoalContractAny,
    overlay: GoalProgressTrackingOverlay = DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
  ): GoalProgressViewModel {
    return projectContract(contract, this.#usageFor(contract), overlay);
  }

  #projectState(
    contract: GoalContractAny,
    overlay: GoalProgressTrackingOverlay = DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
  ): {
    readonly viewModel: GoalProgressViewModel;
    readonly nextTargetId: string | null;
  } {
    return projectContractState(contract, this.#usageFor(contract), overlay);
  }

  #threadIdOf(contract: GoalContractAny): string {
    return contract.schemaVersion === 2 ? contract.threadId : contract.sessionId;
  }

  async #overlayFor(threadId: string): Promise<GoalProgressTrackingOverlay> {
    return readGoalProgressTrackingOverlay(resolveGoalProgressSessionPaths(this.paths, threadId));
  }

  async #activationStateForOverlay(
    threadId: string,
    overlay: GoalProgressTrackingOverlay,
  ): Promise<GoalProgressActivationState> {
    const snapshot = await readGoalProgressActivationStateSnapshot(threadId, this.paths);
    if (!overlay.detached || snapshot.exists) {
      return snapshot.state;
    }
    return writeGoalProgressActivationState(threadId, this.paths, {
      schemaVersion: 1,
      detachReason: "user-detached-tracking",
    });
  }

  async #detachTracking(
    threadId: string,
    detachReason: GoalProgressDetachReason,
  ): Promise<GoalProgressTrackingOverlay> {
    const sessionPaths = resolveGoalProgressSessionPaths(this.paths, threadId);
    const current = await readGoalProgressTrackingOverlay(sessionPaths);
    const activationState = await readGoalProgressActivationState(threadId, this.paths);
    if (
      current.detached &&
      (activationState.detachReason === detachReason ||
        activationState.detachReason === "user-dismissed-preparation" ||
        activationState.detachReason === "user-detached-tracking")
    ) {
      return current;
    }
    await writeGoalProgressActivationState(threadId, this.paths, {
      schemaVersion: 1,
      detachReason,
    });
    const detached = await writeGoalProgressTrackingOverlay(sessionPaths, {
      ...DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
      detached: true,
    });
    if (this.#enableGoalWatch) {
      this.#runtime.setPollingMode(
        this.#preparingObjectives.has(threadId) ? "collapsed-or-background" : "stopped",
        threadId,
      );
    }
    return detached;
  }

  #rememberChangedGoalPreparation(
    threadId: string,
    nativeGoal: TrustedNativeGoal | null,
    error: unknown,
  ): void {
    if (
      nativeGoal?.threadId === threadId &&
      error instanceof GoalProgressIpcHandlerError &&
      (error.code === "NATIVE_GOAL_REPLACED" || error.code === "NATIVE_GOAL_OBJECTIVE_CHANGED")
    ) {
      this.#preparingObjectives.set(threadId, nativeGoal.objective);
    }
  }

  async #reconcileDetachedPreparation(
    contract: GoalContract,
    nativeGoal: TrustedNativeGoal | null,
    overlay: GoalProgressTrackingOverlay,
  ): Promise<GoalProgressTrackingOverlay> {
    const activationState = await this.#activationStateForOverlay(contract.threadId, overlay);
    if (isUserDetachedActivationState(activationState) || !nativeGoal) {
      return overlay;
    }
    try {
      assertBoundNativeGoal(contract, nativeGoal, contract.revision);
      this.#preparingObjectives.delete(contract.threadId);
      await writeGoalProgressActivationState(
        contract.threadId,
        this.paths,
        DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
      );
      return writeGoalProgressTrackingOverlay(
        resolveGoalProgressSessionPaths(this.paths, contract.threadId),
        DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
      );
    } catch (error) {
      if (nativeGoalErrorDetachesContract(error)) {
        this.#rememberChangedGoalPreparation(contract.threadId, nativeGoal, error);
        return this.#detachTracking(contract.threadId, detachReasonForNativeGoalError(error));
      }
      return overlay;
    }
  }

  async #assertBoundNativeGoalOrDetach(
    contract: GoalContract,
    nativeGoal: TrustedNativeGoal | null,
  ): Promise<TrustedNativeGoal> {
    try {
      return assertBoundNativeGoal(contract, nativeGoal, contract.revision);
    } catch (error) {
      if (nativeGoalErrorDetachesContract(error)) {
        this.#rememberChangedGoalPreparation(contract.threadId, nativeGoal, error);
        await this.#detachTracking(contract.threadId, detachReasonForNativeGoalError(error));
      }
      throw error;
    }
  }

  async #overlayForCurrentNativeGoal(
    contract: GoalContractAny,
    usage?: GoalUsageSnapshot,
  ): Promise<GoalProgressTrackingOverlay> {
    const threadId = this.#threadIdOf(contract);
    const overlay = await this.#overlayFor(threadId);
    if (contract.schemaVersion !== 2 || usage?.stale) {
      return overlay;
    }
    if (contract.nativeGoal.status === "complete" && usage && !usage.goal) {
      return overlay;
    }
    let nativeGoal: TrustedNativeGoal | null;
    if (usage) {
      nativeGoal = trustedNativeGoalFromThreadGoal(usage.goal);
    } else {
      try {
        nativeGoal = await this.#sessionCoordinator.readNativeGoal(threadId, contract.revision);
      } catch {
        return overlay;
      }
    }
    if (contract.nativeGoal.status === "complete" && !nativeGoal) {
      return overlay;
    }
    if (overlay.detached) {
      return this.#reconcileDetachedPreparation(contract, nativeGoal, overlay);
    }
    try {
      assertBoundNativeGoal(contract, nativeGoal, contract.revision);
      return overlay;
    } catch (error) {
      this.#rememberChangedGoalPreparation(threadId, nativeGoal, error);
      return nativeGoalErrorDetachesContract(error)
        ? this.#detachTracking(threadId, detachReasonForNativeGoalError(error))
        : overlay;
    }
  }

  async #applyPollingMode(
    threadId: string,
    preference: GoalProgressUiPreference,
    overlay: GoalProgressTrackingOverlay,
    contract?: GoalContractAny,
  ): Promise<void> {
    if (!this.#enableGoalWatch) {
      return;
    }
    const usage = this.#goalUsage.get(threadId);
    if (preference.hidden) {
      this.#runtime.setPollingMode("stopped", threadId);
      return;
    }
    if (overlay.detached) {
      this.#runtime.setPollingMode(
        this.#preparingObjectives.has(threadId) ? "collapsed-or-background" : "stopped",
        threadId,
      );
      return;
    }
    if (!usage?.goal) {
      this.#runtime.setPollingMode("stopped", threadId);
      return;
    }
    if (usage.goal.status === "complete") {
      this.#runtime.setPollingMode("stopped", threadId);
      return;
    }
    if (
      contract?.phase === "paused" ||
      usage.goal.status === "paused" ||
      usage.goal.status === "blocked" ||
      usage.goal.status === "usageLimited" ||
      usage.goal.status === "budgetLimited"
    ) {
      this.#runtime.setPollingMode("paused", threadId);
      return;
    }
    if (preference.collapsed) {
      this.#runtime.setPollingMode("collapsed-or-background", threadId);
      return;
    }
    this.#runtime.setPollingMode("active", threadId);
  }

  #watchThread(threadId: string): void {
    if (!this.#enableGoalWatch) {
      return;
    }
    this.#runtime.watchGoalUsage(threadId, (snapshot) => {
      this.#goalUsage.set(snapshot.threadId, snapshot);
      void this.#syncNativeGoalStatus(snapshot).catch(() => undefined);
    });
  }

  async #syncNativeGoalStatus(snapshot: GoalUsageSnapshot): Promise<GoalContractAny | null> {
    const loaded = await this.#store.load(snapshot.threadId);
    const contract = loaded.contract;
    if (contract?.schemaVersion !== 2 || snapshot.stale) {
      return contract;
    }
    if (contract.nativeGoal.status === "complete" && !snapshot.goal) {
      return contract;
    }
    const overlay = await this.#overlayFor(snapshot.threadId);
    if (overlay.detached || !snapshot.goal) {
      return contract;
    }
    const nativeGoal = trustedNativeGoalFromThreadGoal(snapshot.goal);
    try {
      assertBoundNativeGoal(contract, nativeGoal, contract.revision);
    } catch (error) {
      if (nativeGoalErrorDetachesContract(error)) {
        this.#rememberChangedGoalPreparation(snapshot.threadId, nativeGoal, error);
        await this.#detachTracking(snapshot.threadId, detachReasonForNativeGoalError(error));
      }
      return contract;
    }
    if (!nativeGoal) {
      return contract;
    }
    const nextNativeGoal = contractNativeGoal(nativeGoal);
    if (JSON.stringify(nextNativeGoal) === JSON.stringify(contract.nativeGoal)) {
      return contract;
    }
    const syncKey = hashGoalProgressIdentity(
      `${contract.contractId}:${contract.revision}:${snapshot.goal.status}:${snapshot.goal.updatedAt}`,
    ).slice(0, 24);
    const occurredAt = new Date(
      Math.max(Date.parse(contract.updatedAt), snapshot.goal.updatedAt * 1_000),
    ).toISOString();
    const applied = await this.#store.apply({
      contractId: contract.contractId,
      sessionId: contract.sessionId,
      expectedRevision: contract.revision,
      eventId: `evt-native-sync-${syncKey}`,
      requestId: `req-native-sync-${syncKey}`,
      turnId: "system-native-goal-watch",
      occurredAt,
      source: "system",
      type: "sync-native-goal",
      nativeGoal: nextNativeGoal,
    });
    if (applied.ok) {
      return applied.contract;
    }
    return (await this.#store.load(snapshot.threadId)).contract;
  }

  async #resumeTracking(threadId: string): Promise<GoalProgressActivationResumeResult> {
    const loaded = await this.#store.load(threadId);
    const contract = loaded.contract;
    if (!contract || contract.phase === "completed") {
      return { status: "inactive" };
    }
    const contractThreadId = contract.schemaVersion === 2 ? contract.threadId : contract.sessionId;
    if (contractThreadId !== threadId) {
      return { status: "inactive" };
    }
    const persistedOverlay = await this.#overlayFor(threadId);
    const activationState = await this.#activationStateForOverlay(threadId, persistedOverlay);
    if (isUserDetachedActivationState(activationState)) {
      if (!persistedOverlay.detached && activationState.detachReason) {
        await this.#detachTracking(threadId, activationState.detachReason);
      }
      return { status: "inactive" };
    }
    let nativeGoal: TrustedNativeGoal | null = null;
    try {
      nativeGoal = await this.#sessionCoordinator.readNativeGoal(threadId);
      if (!nativeGoal) {
        if (contract.schemaVersion === 2) {
          await this.#detachTracking(threadId, "native-goal-ended");
        }
        return { status: "inactive" };
      }
      if (contract.schemaVersion === 2) {
        assertBoundNativeGoal(contract, nativeGoal, contract.revision);
      } else if (nativeGoal.objective !== contract.nativeGoal.objective) {
        return { status: "inactive" };
      }
    } catch (error) {
      if (
        nativeGoalErrorDetachesContract(error) ||
        (error instanceof GoalProgressIpcHandlerError &&
          error.code === "NATIVE_GOAL_OBJECTIVE_TOO_LONG")
      ) {
        if (nativeGoalErrorDetachesContract(error)) {
          this.#rememberChangedGoalPreparation(threadId, nativeGoal, error);
          await this.#detachTracking(threadId, detachReasonForNativeGoalError(error));
        }
        return { status: "inactive" };
      }
      const causeCode = helperDiagnosticCauseCode(error);
      return {
        status: "temporarily_unavailable",
        reasonCode: causeCode,
      };
    }
    this.#watchThread(threadId);
    await this.#refreshUsage(threadId);
    const latest = (await this.#store.load(threadId)).contract ?? contract;
    return {
      status: "active",
      contractId: latest.contractId,
      revision: latest.revision,
    };
  }

  async #refreshUsage(threadId: string): Promise<GoalUsageSnapshot | undefined> {
    if (!this.#enableGoalWatch) {
      return this.#goalUsage.get(threadId);
    }
    try {
      const snapshot = await this.#runtime.refreshGoalUsage(threadId);
      this.#goalUsage.set(threadId, snapshot);
      const contract = await this.#syncNativeGoalStatus(snapshot);
      if (contract) {
        await this.#applyPollingMode(
          threadId,
          await readGoalProgressUiPreference(this.paths),
          await this.#overlayForCurrentNativeGoal(contract, snapshot),
          contract,
        );
      } else if (!snapshot.goal || snapshot.goal.status === "complete") {
        this.#runtime.setPollingMode("stopped", threadId);
      }
      return snapshot;
    } catch {
      return this.#goalUsage.get(threadId);
    }
  }

  async #inspectRuntimeDoctor(sessionId?: string): Promise<GoalProgressDoctorResult["runtime"]> {
    return inspectGoalProgressRuntime(sessionId, {
      store: this.#store,
      refreshUsage: (threadId) => this.#refreshUsage(threadId),
      readNativeGoal: (threadId, revision) =>
        this.#sessionCoordinator.readNativeGoal(threadId, revision),
    });
  }

  async #key(): Promise<Uint8Array> {
    this.#runtimeProofKey ??= await loadOrCreateRuntimeProofKey(this.paths.runtimeRoot);
    return this.#runtimeProofKey;
  }

  async #consumeRuntimeProof(
    runtimeContext: RuntimeContext,
    runtimeProof: RuntimeProof,
  ): Promise<boolean> {
    const nowMs = Date.now();
    return (
      (await verifyRuntimeProof(runtimeContext, runtimeProof, await this.#key(), nowMs)) &&
      (await consumeRuntimeProofOnce(this.paths.runtimeRoot, runtimeProof, nowMs))
    );
  }

  async #handleSystemIpc(request: HelperSystemIpcRequest): Promise<GoalProgressIpcHandlerResult> {
    if (request.method === "ping") {
      return {
        revision: null,
        result: {
          status: "ok",
          pid: this.#lock?.identity.pid ?? process.pid,
          instanceId: this.#lock?.identity.instanceId ?? null,
          ready: this.#ready,
        },
      };
    }
    if (request.method === "runtime-proof.issue") {
      const proof = await issueRuntimeProof(
        request.params.runtimeContext,
        request.params.toolUseId,
        await this.#key(),
      );
      return { revision: null, result: { runtimeProof: proof } };
    }
    const consumed = await this.#consumeRuntimeProof(
      request.params.runtimeContext,
      request.params.runtimeProof,
    );
    return { revision: null, result: { valid: consumed } };
  }

  async #handleHookIpc(request: HelperHookIpcRequest): Promise<GoalProgressIpcHandlerResult> {
    if (request.method === "activation.resume") {
      const resumed = await this.#resumeTracking(request.params.hookSessionId);
      if (resumed.status === "active") {
        await this.#log({
          level: "info",
          event: "hook.resume",
          sessionKey: hashGoalProgressIdentity(request.params.hookSessionId),
          sessionTreeKey: hashGoalProgressIdentity(request.params.hookSessionId),
          threadKey: hashGoalProgressIdentity(request.params.hookSessionId),
          contractId: resumed.contractId,
          revision: resumed.revision,
        });
      }
      const responseRevision =
        resumed.status === "active"
          ? resumed.revision
          : ((await this.#store.load(request.params.hookSessionId)).contract?.revision ?? null);
      return {
        revision: responseRevision,
        result: resumed,
      };
    }
    if (request.params.event === "ResumeTemporarilyUnavailable") {
      const loaded = await this.#store.load(request.params.hookSessionId);
      if (!loaded.contract || loaded.contract.phase === "completed") {
        return { revision: loaded.contract?.revision ?? null, result: { accepted: false } };
      }
      await this.#log({
        level: "warn",
        event: "hook.resume-unavailable",
        sessionKey: hashGoalProgressIdentity(request.params.hookSessionId),
        sessionTreeKey: hashGoalProgressIdentity(request.params.hookSessionId),
        threadKey: hashGoalProgressIdentity(request.params.hookSessionId),
        contractId: loaded.contract.contractId,
        revision: loaded.contract.revision,
        causeCode: request.params.reasonCode,
        count: 1,
      });
      return { revision: loaded.contract.revision, result: { accepted: true } };
    }
    if (request.params.event === "NativeGoalCompleted") {
      let identity: RuntimeIdentity;
      try {
        identity = await this.#sessionCoordinator.resolveCurrentThread({
          sessionTreeId: request.params.hookSessionId,
          turnId: request.params.turnId,
          cwd: request.params.cwd,
          model: request.params.model,
        });
      } catch {
        return { revision: null, result: { accepted: false } };
      }
      const loaded = await this.#store.load(identity.threadId);
      const contract = loaded.contract;
      if (!contract) {
        return { revision: null, result: { accepted: false } };
      }
      if (contract.nativeGoal.status === "complete") {
        return { revision: contract.revision, result: { accepted: true } };
      }
      const requestKey = hashGoalProgressIdentity(request.params.toolUseId);
      const applied = await this.#store.apply({
        contractId: contract.contractId,
        sessionId: identity.threadId,
        expectedRevision: contract.revision,
        eventId: `evt-native-complete-${requestKey}`,
        requestId: `req-native-complete-${requestKey}`,
        turnId: identity.turnId,
        occurredAt: new Date().toISOString(),
        source: "system",
        type: "sync-native-goal",
        nativeGoal: {
          objective: contract.nativeGoal.objective,
          status: "complete",
          ...(contract.nativeGoal.tokenBudget === undefined
            ? {}
            : { tokenBudget: contract.nativeGoal.tokenBudget }),
        },
      });
      if (!applied.ok) {
        return {
          revision: applied.currentRevision,
          result: { accepted: false },
        };
      }
      const sessionPaths = resolveGoalProgressSessionPaths(this.paths, identity.threadId);
      const existingOverlay = await this.#overlayFor(identity.threadId);
      const activationState = await this.#activationStateForOverlay(
        identity.threadId,
        existingOverlay,
      );
      if (isUserDetachedActivationState(activationState)) {
        if (this.#enableGoalWatch) {
          this.#runtime.setPollingMode("collapsed-or-background", identity.threadId);
        }
        await this.#log({
          level: "info",
          event: "hook.native-goal-complete",
          ...identityLogFields(identity),
          contractId: applied.contract.contractId,
          revision: applied.contract.revision,
        });
        return {
          revision: applied.contract.revision,
          result: { accepted: true },
        };
      }
      await writeGoalProgressActivationState(
        identity.threadId,
        this.paths,
        DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
      );
      await writeGoalProgressTrackingOverlay(sessionPaths, {
        ...DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
        detached: false,
      });
      if (this.#enableGoalWatch) {
        this.#runtime.setPollingMode("collapsed-or-background", identity.threadId);
      }
      await this.#log({
        level: "info",
        event: "hook.native-goal-complete",
        ...identityLogFields(identity),
        contractId: applied.contract.contractId,
        revision: applied.contract.revision,
      });
      return {
        revision: applied.contract.revision,
        result: { accepted: true },
      };
    }
    return { revision: null, result: { accepted: false } };
  }

  async #handleActivationIpc(
    request: HelperActivationIpcRequest,
  ): Promise<GoalProgressIpcHandlerResult> {
    const identity = await this.#sessionCoordinator.authorizeSessionRequest(
      requestAuthorization(request.params),
    );
    await this.#log({
      level: "info",
      event: "activation.requested",
      ...identityLogFields(identity),
    });
    const nativeGoal = await this.#sessionCoordinator.readNativeGoal(identity.threadId);
    const loaded = await this.#store.load(identity.threadId);
    const current = await this.#sessionCoordinator.contractForWrite(
      identity,
      loaded.contract,
      loaded.contract?.revision ?? null,
      nativeGoal,
    );
    let contractId: string | null = null;
    let revision: number | null = null;
    let contractState: "none" | "matched" | "changed" = "none";
    if (current && nativeGoal) {
      contractId = current.contractId;
      revision = current.revision;
      try {
        assertBoundNativeGoal(current, nativeGoal, current.revision);
        contractState = "matched";
      } catch (error) {
        if (!nativeGoalErrorDetachesContract(error)) {
          throw error;
        }
        contractState = "changed";
        this.#rememberChangedGoalPreparation(identity.threadId, nativeGoal, error);
      }
    }
    const plan = planGoalProgressActivation({
      nativeGoalPresent: nativeGoal !== null,
      contractState,
    });
    if (current && plan.progressAction === "get") {
      const sessionPaths = resolveGoalProgressSessionPaths(this.paths, identity.threadId);
      const overlay = await this.#overlayFor(identity.threadId);
      const activationState = await this.#activationStateForOverlay(identity.threadId, overlay);
      if (isUserDetachedActivationState(activationState)) {
        await writeGoalProgressActivationState(
          identity.threadId,
          this.paths,
          DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
        );
        await writeGoalProgressTrackingOverlay(sessionPaths, {
          ...DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
          detached: false,
        });
      }
    }
    if (plan.preparing) {
      if (nativeGoal) {
        const sessionPaths = resolveGoalProgressSessionPaths(this.paths, identity.threadId);
        await writeGoalProgressActivationState(
          identity.threadId,
          this.paths,
          DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
        );
        await writeGoalProgressTrackingOverlay(sessionPaths, {
          ...DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
          detached: false,
        });
        if (plan.progressAction === "rescope-or-replace") {
          await this.#detachTracking(identity.threadId, "stale-contract");
        }
        this.#preparingObjectives.set(identity.threadId, nativeGoal.objective);
      }
    }
    return {
      revision,
      result: {
        ...plan,
        contractId,
        revision,
        ...(nativeGoal ? { currentNativeGoal: nativeGoal.objective } : {}),
      },
    };
  }

  async #handleStoreLoad(
    request: Extract<HelperStoreIpcRequest, { method: "store.load" }>,
  ): Promise<GoalProgressIpcHandlerResult> {
    const identity = await this.#sessionCoordinator.authorizeSessionRequest(
      requestAuthorization(request.params),
      request.params.sessionId,
    );
    let loaded = await this.#store.load(identity.threadId);
    const recovery = {
      snapshotRecovered: loaded.snapshotRecovered,
      tornTailRepaired: loaded.tornTailRepaired,
    };
    let contract = loaded.contract;
    if (contract?.schemaVersion === 1) {
      try {
        contract = await this.#sessionCoordinator.contractForWrite(
          identity,
          contract,
          contract.revision,
        );
      } catch {
        contract = loaded.contract;
      }
    }
    if (contract) {
      this.#watchThread(identity.threadId);
      const usage = await this.#refreshUsage(identity.threadId);
      loaded = await this.#store.load(identity.threadId);
      contract = loaded.contract ?? contract;
      const overlay = await this.#overlayForCurrentNativeGoal(contract, usage);
      const { contract: _ignored, ...latestDiagnostics } = loaded;
      const diagnostics = {
        ...latestDiagnostics,
        snapshotRecovered: recovery.snapshotRecovered || latestDiagnostics.snapshotRecovered,
        tornTailRepaired: recovery.tornTailRepaired || latestDiagnostics.tornTailRepaired,
      };
      const preparingObjective = this.#preparingObjectives.get(identity.threadId);
      if (overlay.detached && preparingObjective) {
        return {
          revision: contract.revision,
          result: {
            ...diagnostics,
            viewModel: null,
            nextTargetId: null,
            previousContractId: contract.contractId,
            previousRevision: contract.revision,
            currentNativeGoal: preparingObjective,
          },
        };
      }
      const projected = this.#projectState(contract, overlay);
      return {
        revision: contract.revision,
        result: {
          ...diagnostics,
          ...projected,
        },
      };
    }
    const { contract: _ignored, ...diagnostics } = loaded;
    return {
      revision: null,
      result: {
        ...diagnostics,
        viewModel: null,
        nextTargetId: null,
      },
    };
  }

  async #handleStoreInitialize(
    request: Extract<HelperStoreIpcRequest, { method: "store.initialize" }>,
    context: GoalProgressIpcConnectionContext,
  ): Promise<GoalProgressIpcHandlerResult> {
    const identity = await this.#sessionCoordinator.authorizeSessionRequest(
      requestAuthorization(request.params),
      undefined,
      request.params.metadata.turnId,
    );
    {
      const overlay = await this.#overlayFor(identity.threadId);
      const activationState = await this.#activationStateForOverlay(identity.threadId, overlay);
      if (activationState.detachReason === "user-dismissed-preparation") {
        throw new GoalProgressIpcHandlerError(
          "ACTIVATION_CANCELLED",
          "Goal Progress preparation was closed by the user before initialization",
        );
      }
      if (activationState.detachReason === "user-detached-tracking") {
        throw new GoalProgressIpcHandlerError(
          "TRACKING_DETACHED_BY_USER",
          "Goal Progress tracking was closed by the user",
        );
      }
      const nativeGoal = await this.#sessionCoordinator.trustedNativeGoal(identity.threadId);
      const current = await this.#store.load(identity.threadId);
      const currentContract = current.contract?.schemaVersion === 2 ? current.contract : null;
      const contract = createModelContract(
        request.params.initialization,
        nativeGoal,
        identity,
        request.params.metadata.occurredAt,
      );
      const metadata =
        context.clientKind === "mcp"
          ? { ...request.params.metadata, source: "model" as const }
          : request.params.metadata;
      let initialized: GoalEventStoreWriteSuccess;
      const currentBinding = currentContract?.nativeGoalBinding ?? null;
      const objectiveChangedInPlace =
        currentBinding !== null &&
        currentBinding.createdAt === nativeGoal.createdAt &&
        currentBinding.objectiveHash !== hashNativeGoalObjective(nativeGoal.objective);
      if (
        currentContract &&
        (currentContract.nativeGoalBinding.createdAt !== nativeGoal.createdAt ||
          objectiveChangedInPlace)
      ) {
        initialized = await this.#store.replace(contract, metadata, {
          contractId: currentContract.contractId,
          revision: currentContract.revision,
        });
      } else {
        if (currentContract) {
          assertBoundNativeGoal(currentContract, nativeGoal, currentContract.revision);
        }
        initialized = await this.#store.initialize(contract, metadata);
      }
      this.#preparingObjectives.delete(identity.threadId);
      this.#watchThread(identity.threadId);
      await this.#refreshUsage(identity.threadId);
      const latest = (await this.#store.load(identity.threadId)).contract ?? initialized.contract;
      await writeGoalProgressActivationState(
        identity.threadId,
        this.paths,
        DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
      );
      const activeOverlay = overlay.detached
        ? await writeGoalProgressTrackingOverlay(
            resolveGoalProgressSessionPaths(this.paths, identity.threadId),
            DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
          )
        : overlay;
      const projected = this.#projectState(latest, activeOverlay);
      return {
        revision: latest.revision,
        result: {
          ...projected,
          duplicate: initialized.duplicate,
        },
      };
    }
  }

  async #handleStoreApply(
    request: Extract<HelperStoreIpcRequest, { method: "store.apply" }>,
    context: GoalProgressIpcConnectionContext,
  ): Promise<GoalProgressIpcHandlerResult> {
    const identity = await this.#sessionCoordinator.authorizeSessionRequest(
      requestAuthorization(request.params),
      request.params.command.sessionId,
      request.params.command.turnId,
    );
    const persistedOverlay = await this.#overlayFor(identity.threadId);
    const activationState = await this.#activationStateForOverlay(
      identity.threadId,
      persistedOverlay,
    );
    if (isUserDetachedActivationState(activationState)) {
      throw new GoalProgressIpcHandlerError(
        "TRACKING_DETACHED_BY_USER",
        "Goal Progress tracking was closed by the user",
      );
    }
    const command = { ...request.params.command, sessionId: identity.threadId };
    if (command.type === "sync-native-goal" || command.type === "retarget-rescope") {
      throw new GoalProgressIpcHandlerError(
        "NATIVE_GOAL_SOURCE_UNVERIFIED",
        "Only the trusted native Goal adapter can synchronize or retarget native Goal state",
      );
    }
    const current = await this.#store.load(identity.threadId);
    const contract = await this.#sessionCoordinator.contractForWrite(
      identity,
      current.contract,
      current.contract?.revision ?? null,
    );
    let commandForStore: GoalProgressCommand =
      context.clientKind === "mcp" ? sanitizeModelCommand(command, contract ?? undefined) : command;
    let retargeted = false;
    if (contract && (command.type === "rescope" || contract.nativeGoal.status !== "complete")) {
      const nativeGoal = await this.#sessionCoordinator.readNativeGoal(
        identity.threadId,
        contract.revision,
      );
      if (command.type === "rescope" && nativeGoal) {
        try {
          assertBoundNativeGoal(contract, nativeGoal, contract.revision);
        } catch (error) {
          if (!nativeGoalErrorDetachesContract(error)) {
            throw error;
          }
          const sanitized = (
            context.clientKind === "mcp"
              ? sanitizeModelCommand(command, contract ?? undefined)
              : command
          ) as Extract<GoalProgressCommand, { type: "rescope" }>;
          commandForStore = {
            ...sanitized,
            type: "retarget-rescope",
            source: "system",
            nativeGoalBinding: {
              threadId: identity.threadId,
              createdAt: nativeGoal.createdAt,
              objectiveHash: hashNativeGoalObjective(nativeGoal.objective),
            },
            nativeGoal: contractNativeGoal(nativeGoal),
          };
          retargeted = true;
        }
      } else {
        await this.#assertBoundNativeGoalOrDetach(contract, nativeGoal);
      }
    }
    const applied = await this.#store.apply(commandForStore);
    if (!applied.ok) {
      if (applied.code === "REVISION_CONFLICT") {
        const latest = await this.#store.load(identity.threadId);
        if (latest.contract) {
          const currentViewModel = this.#project(
            latest.contract,
            await this.#overlayFor(identity.threadId),
          );
          throw new GoalProgressIpcHandlerError(
            applied.code,
            applied.message,
            currentViewModel.revision,
            currentViewModel,
          );
        }
      }
      throw new GoalProgressIpcHandlerError(applied.code, applied.message, applied.currentRevision);
    }
    const overlay = retargeted
      ? await (async () => {
          await writeGoalProgressActivationState(
            identity.threadId,
            this.paths,
            DEFAULT_GOAL_PROGRESS_ACTIVATION_STATE,
          );
          return writeGoalProgressTrackingOverlay(
            resolveGoalProgressSessionPaths(this.paths, identity.threadId),
            {
              ...DEFAULT_GOAL_PROGRESS_TRACKING_OVERLAY,
              detached: false,
            },
          );
        })()
      : await this.#overlayFor(identity.threadId);
    if (retargeted) {
      this.#preparingObjectives.delete(identity.threadId);
    }
    this.#watchThread(identity.threadId);
    await this.#refreshUsage(identity.threadId);
    await this.#applyPollingMode(
      identity.threadId,
      await readGoalProgressUiPreference(this.paths),
      overlay,
      applied.contract,
    );
    const projected = this.#projectState(applied.contract, overlay);
    return {
      revision: applied.contract.revision,
      result: {
        ...projected,
        duplicate: applied.duplicate,
      },
    };
  }

  async #handleStoreIpc(
    request: HelperStoreIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ): Promise<GoalProgressIpcHandlerResult> {
    if (request.method === "store.load") {
      return this.#handleStoreLoad(request);
    }
    if (request.method === "store.initialize") {
      return this.#handleStoreInitialize(request, context);
    }
    return this.#handleStoreApply(request, context);
  }

  async #handleDoctorIpc(request: HelperDoctorIpcRequest): Promise<GoalProgressIpcHandlerResult> {
    const [doctor, runtime] = await Promise.all([
      inspectGoalProgressLocal(this.paths, request.params.sessionId, true, this.#store),
      this.#inspectRuntimeDoctor(request.params.sessionId),
    ]);
    return {
      revision:
        doctor.store.checked && doctor.store.revision !== null ? doctor.store.revision : null,
      result: { ...doctor, runtime },
    };
  }

  async #handleTaskIpc(
    request: HelperTaskIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ): Promise<GoalProgressIpcHandlerResult> {
    const action = request.params.action;
    const nativeRead = request.method === "task.native-read";
    if (
      nativeRead &&
      (context.clientKind !== "mcp" ||
        !["get", "history", "heartbeat-history", "archive"].includes(action))
    )
      throw new GoalProgressIpcHandlerError(
        "IPC_METHOD_FORBIDDEN",
        "Native task reads are available only to MCP clients",
      );
    const diagnosticStartedAt = performance.now();
    const stageDurations: Partial<Record<TaskDiagnosticStage, number>> = {};
    const measureStage = async <T>(stage: TaskDiagnosticStage, work: () => Promise<T>) => {
      const startedAt = performance.now();
      try {
        return await work();
      } finally {
        stageDurations[stage] = Math.min(
          60_000,
          Math.round((stageDurations[stage] ?? 0) + performance.now() - startedAt),
        );
      }
    };
    const logSlowTask = (threadId: string) => {
      const durationMs = Math.min(60_000, Math.round(performance.now() - diagnosticStartedAt));
      if (durationMs < TASK_SLOW_DIAGNOSTIC_THRESHOLD_MS) return;
      const threadKey = hashGoalProgressIdentity(threadId);
      void this.#log({
        level: "info",
        event: "ipc.response",
        code: "TASK_PERF_TOTAL",
        durationMs,
        threadKey,
      });
      for (const stage of TASK_DIAGNOSTIC_STAGES) {
        const stageDuration = stageDurations[stage];
        if (stageDuration === undefined) continue;
        void this.#log({
          level: "info",
          event: "ipc.response",
          code: `TASK_PERF_${stage.toUpperCase().replaceAll("-", "_")}`,
          durationMs: stageDuration,
          threadKey,
        });
      }
    };
    let threadId: string;
    let cwd: string;
    let input: unknown;
    let nativeStatus: unknown;
    if (request.method === "task.request") {
      const expectedTool = `task_progress_${action.replaceAll("-", "_")}`;
      if (
        request.params.auth.kind === "codex-request" &&
        request.params.auth.toolName !== expectedTool
      )
        throw new GoalProgressIpcHandlerError(
          "TASK_TOOL_MISMATCH",
          "Task action does not match tool identity",
        );
      const authorized = await measureStage("native-identity", () =>
        this.#sessionCoordinator.authorizeSessionRequestWithThread(request.params.auth),
      );
      threadId = authorized.identity.threadId;
      cwd = authorized.identity.cwd;
      input = request.params.input;
      nativeStatus = authorized.thread
        ? authorized.thread.status
        : await measureStage("native-identity", () =>
            this.#runtime
              .readThreadIdentity(threadId)
              .then((thread) => thread.status)
              .catch(() => undefined),
          );
    } else {
      threadId = request.params.threadId;
      const identity = await measureStage("native-identity", () =>
        this.#runtime.readThreadIdentity(threadId),
      );
      if (
        identity.id !== threadId ||
        identity.sessionId !== threadId ||
        identity.threadSource !== "user" ||
        identity.ephemeral ||
        identity.agentRole !== null
      )
        throw new GoalProgressIpcHandlerError(
          "TASK_THREAD_UNTRUSTED",
          "Native task read requires a verified user chat",
        );
      cwd = identity.cwd;
      nativeStatus = identity.status;
      input = request.params.input;
    }
    // Use the same nearest-Git-boundary rule as heartbeat discovery, before storage is opened.
    const projectEnabled = await measureStage("project-preferences", async () => {
      const initial = resolve(cwd);
      let project = initial;
      while (true) {
        if (
          await stat(resolve(project, ".git")).then(
            () => true,
            () => false,
          )
        )
          break;
        const parent = dirname(project);
        if (parent === project || project === homedir()) {
          project = initial;
          break;
        }
        project = parent;
      }
      project = await realpath(project);
      return readOptionalGroupPreference(project, "task-progress") !== false;
    });
    if (!projectEnabled) {
      if (!["get", "history", "heartbeat-history", "archive"].includes(action))
        throw new GoalProgressIpcHandlerError(
          "TASK_PROGRESS_DISABLED",
          "Task progress is disabled for this project",
        );
      logSlowTask(threadId);
      return { revision: null, result: { enabled: false, task: null, heartbeat: null } };
    }
    const workspace = await measureStage("workspace-routing", () =>
      this.#workspaceStorage.forThread(threadId, cwd),
    );
    const { taskStore, heartbeat: heartbeatService } = workspace;
    const execution = projectTaskExecution(nativeStatus);
    let result: unknown;
    let sourceTask: Awaited<ReturnType<typeof heartbeatService.taskProjection>>;
    let heartbeat: Awaited<ReturnType<typeof heartbeatService.projectView>> | null = null;
    let heartbeatPending = false;
    if (action === "get")
      sourceTask = await measureStage("task-projection", () =>
        heartbeatService.taskProjection(threadId, cwd, { maxWaitMs: 200 }),
      );
    else {
      [sourceTask, heartbeat] = await Promise.all([
        measureStage("task-projection", () =>
          heartbeatService.taskProjection(threadId, cwd, {
            forceDiscovery: [
              "initialize",
              "update",
              "rescope",
              "complete",
              "bind-heartbeat",
            ].includes(action),
          }),
        ),
        measureStage("project-view", () => heartbeatService.projectView(cwd)),
      ]);
    }
    let localTaskState: Awaited<ReturnType<typeof taskStore.get>> | undefined;
    let localTaskRead = false;
    if (
      ["initialize", "update", "rescope", "complete", "bind-heartbeat"].includes(action) &&
      sourceTask.status === "pending"
    )
      throw new GoalProgressIpcHandlerError(
        "TASK_SOURCE_UNAVAILABLE",
        "The Kit task source is refreshing. Retry after discovery completes.",
      );
    if (action === "bind-heartbeat") {
      await workspace.ensureWritable();
      const bind = z.object({ path: z.string().max(4096).nullable() }).parse(input);
      await measureStage("local-task-store", () => heartbeatService.bind(threadId, bind.path, cwd));
      sourceTask = await measureStage("task-projection", () =>
        heartbeatService.taskProjection(threadId, cwd, { forceDiscovery: true }),
      );
    }
    if (
      ["initialize", "update", "rescope", "complete"].includes(action) &&
      sourceTask.status === "error" &&
      !sourceTask.sourcePath
    )
      throw new GoalProgressIpcHandlerError(
        "TASK_SOURCE_UNAVAILABLE",
        `The Kit heartbeat task source could not be checked${sourceTask.error ? `: ${sourceTask.error}` : ""}. Restore the Kit source helpers or resolve the heartbeat read error before writing a local checklist.`,
      );
    if (
      ["initialize", "update", "rescope", "complete"].includes(action) &&
      sourceTask.status === "pending-selection"
    )
      throw new GoalProgressIpcHandlerError(
        "TASK_SOURCE_SELECTION_REQUIRED",
        `${sourceTask.error ?? "The current-task Kit source relation is unresolved."} Do not create or change a parallel local checklist until the runtime resolves the task-source relation.`,
      );
    if (["initialize", "update", "rescope", "complete"].includes(action) && sourceTask.sourcePath)
      throw new GoalProgressIpcHandlerError(
        "TASK_SOURCE_READ_ONLY",
        `This task is projected from read-only current-task Kit source ${sourceTask.sourcePath}. Update that canonical source through the project workflow; do not create a parallel local checklist.`,
      );
    if (["initialize", "update", "rescope", "complete"].includes(action)) {
      if (
        typeof taskStore.complete !== "function" ||
        typeof taskStore.archives !== "function" ||
        typeof taskStore.archive !== "function"
      )
        throw new GoalProgressIpcHandlerError(
          "TASK_LIFECYCLE_UNAVAILABLE",
          "Task lifecycle support is unavailable",
        );
      await workspace.ensureWritable();
    }
    if (action === "initialize")
      result = await measureStage("local-task-store", () =>
        taskStore.initialize(threadId, {
          ...TaskInitializeInputSchema.parse({ ...(input as object), lifecycle: true }),
          lifecycle: true as const,
        }),
      );
    else if (action === "update")
      result = await measureStage("local-task-store", () =>
        taskStore.update(threadId, {
          ...TaskUpdateInputSchema.parse({ ...(input as object), lifecycle: true }),
          lifecycle: true as const,
        }),
      );
    else if (action === "rescope") {
      const parsed = TaskRescopeInputSchema.parse({ ...(input as object), lifecycle: true });
      const rescopeInput = {
        lifecycle: true as const,
        requestId: parsed.requestId,
        expectedRevision: parsed.expectedRevision,
        reason: parsed.reason,
        objectives: parsed.objectives,
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
      };
      result = await measureStage("local-task-store", () =>
        taskStore.rescope(threadId, rescopeInput),
      );
    } else if (action === "complete") {
      if (typeof taskStore.complete !== "function")
        throw new GoalProgressIpcHandlerError(
          "TASK_LIFECYCLE_UNAVAILABLE",
          "Task lifecycle support is unavailable",
        );
      result = await measureStage("local-task-store", () =>
        taskStore.complete(threadId, TaskCompleteInputSchema.parse(input)),
      );
    } else {
      if (action === "get") {
        if (sourceTask.status === "pending") {
          heartbeatPending = true;
        } else {
          const snapshot = await measureStage("project-view-snapshot", () =>
            heartbeatService.projectViewSnapshot(cwd),
          );
          heartbeat = snapshot.view;
          heartbeatPending = snapshot.pending;
        }
      }
      localTaskRead = !(
        sourceTask.sourcePath ||
        sourceTask.status === "error" ||
        sourceTask.status === "pending" ||
        sourceTask.status === "pending-selection"
      );
      localTaskState = localTaskRead
        ? await measureStage("local-task-store", () => taskStore.get(threadId))
        : null;
      const task = sourceTask.sourcePath
        ? sourceTask.task
        : sourceTask.status === "error" ||
            sourceTask.status === "pending" ||
            sourceTask.status === "pending-selection"
          ? null
          : localTaskState;
      const history =
        action === "history"
          ? sourceTask.status === "pending"
            ? (() => {
                // Until the initial source resolution succeeds, neither a second scan nor a
                // local-history read can determine which authority owns this request.
                z.object({
                  cursor: z.string().optional(),
                  limit: z.number().int().min(1).max(100).optional(),
                }).parse(input ?? {});
                return {
                  events: [],
                  nextCursor: null,
                  wakes: [],
                  total: 0,
                  source: { kind: "kit-heartbeat", path: null, readOnly: true, retryable: true },
                };
              })()
            : sourceTask.sourcePath ||
                sourceTask.status === "error" ||
                sourceTask.status === "pending-selection"
              ? await (async () => {
                  const options = z
                    .object({
                      cursor: z.string().optional(),
                      limit: z.number().int().min(1).max(10).optional(),
                    })
                    .parse(input ?? {});
                  const page = await heartbeatService.history(threadId, cwd, {
                    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                    ...(options.limit === undefined ? {} : { limit: options.limit }),
                  });
                  return {
                    events: [],
                    nextCursor: page.nextCursor,
                    wakes: page.wakes,
                    total: page.total,
                    source: {
                      kind: "kit-heartbeat",
                      path: page.sourcePath,
                      readOnly: true,
                      ...(page.historyPath ? { historyPath: page.historyPath } : {}),
                      ...(page.contentHash ? { contentHash: page.contentHash } : {}),
                      ...(page.itemStatuses ? { itemStatuses: page.itemStatuses } : {}),
                      ...(page.error ? { error: page.error } : {}),
                      ...(page.retryable ? { retryable: true } : {}),
                    },
                  };
                })()
              : await taskStore.history(
                  threadId,
                  (() => {
                    const options = z
                      .object({
                        cursor: z.string().optional(),
                        limit: z.number().int().min(1).max(100).optional(),
                      })
                      .parse(input ?? {});
                    return {
                      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                      ...(options.limit === undefined ? {} : { limit: options.limit }),
                    };
                  })(),
                )
          : undefined;
      const archive =
        action === "archive"
          ? await (async () => {
              const options = TaskArchiveInputSchema.parse(input ?? {});
              if (!localTaskRead)
                return {
                  available: false,
                  kind: "tasks" as const,
                  tasks: [],
                  total: 0,
                  nextCursor: null,
                  threadId,
                  currentTaskId: null,
                  reason: "Formal task cycle archives are unavailable for this task source.",
                };
              if (
                typeof taskStore.archives !== "function" ||
                typeof taskStore.archive !== "function"
              )
                throw new GoalProgressIpcHandlerError(
                  "TASK_LIFECYCLE_UNAVAILABLE",
                  "Task archive support is unavailable",
                );
              const { taskId } = options;
              const pageOptions = {
                ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                ...(options.limit === undefined ? {} : { limit: options.limit }),
              };
              const page = taskId
                ? await taskStore.archive(threadId, taskId, pageOptions)
                : await taskStore.archives(threadId, pageOptions);
              return { ...page, available: true, threadId };
            })()
          : undefined;
      const heartbeatHistory =
        action === "heartbeat-history"
          ? await heartbeatService.projectHistory(
              cwd,
              (() => {
                const options = z
                  .object({
                    cursor: z.string().optional(),
                    limit: z.number().int().min(1).max(10).optional(),
                  })
                  .parse(input ?? {});
                return {
                  ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
                  ...(options.limit === undefined ? {} : { limit: options.limit }),
                };
              })(),
            )
          : undefined;
      result = {
        task,
        heartbeat,
        ...(heartbeatPending ? { heartbeatPending: true } : {}),
        ...(sourceTask.status === "pending" ? { taskSourcePending: true } : {}),
        taskSource:
          sourceTask.sourcePath ||
          sourceTask.status === "error" ||
          sourceTask.status === "pending" ||
          sourceTask.status === "pending-selection"
            ? {
                status: sourceTask.status,
                ...(sourceTask.sourcePath ? { path: sourceTask.sourcePath } : {}),
                readOnly: true,
                ...(sourceTask.historyPath ? { historyPath: sourceTask.historyPath } : {}),
                ...(sourceTask.contentHash ? { contentHash: sourceTask.contentHash } : {}),
                ...(sourceTask.itemStatuses ? { itemStatuses: sourceTask.itemStatuses } : {}),
                ...(sourceTask.error ? { error: sourceTask.error } : {}),
                ...(sourceTask.retryable ? { retryable: true } : {}),
              }
            : sourceTask.status === "candidates"
              ? { status: "candidates", readOnly: true }
              : null,
        execution,
        ...(history ? { history } : {}),
        ...(archive ? { archive } : {}),
        ...(heartbeatHistory ? { heartbeatHistory } : {}),
      };
    }
    const state =
      sourceTask.sourcePath ||
      sourceTask.status === "error" ||
      sourceTask.status === "pending" ||
      sourceTask.status === "pending-selection"
        ? null
        : localTaskRead
          ? localTaskState
          : await measureStage("local-task-store", () => taskStore.get(threadId));
    logSlowTask(threadId);
    return {
      revision: sourceTask.sourcePath
        ? (sourceTask.task?.revision ?? null)
        : sourceTask.status === "error" ||
            sourceTask.status === "pending" ||
            sourceTask.status === "pending-selection"
          ? null
          : (state?.revision ?? null),
      result: {
        ...(result as Record<string, unknown>),
        execution,
        completionBasis: state && "lifecycle" in state ? "task-lifecycle" : "registered-checklist",
        archiveCount:
          sourceTask.sourcePath ||
          sourceTask.status === "error" ||
          sourceTask.status === "pending" ||
          sourceTask.status === "pending-selection"
            ? null
            : getTaskArchiveCount(state ?? null),
        storage: workspace.storage,
      },
    };
  }

  #handler(): GoalProgressIpcHandler {
    return new HelperIpcRouter({
      routes: {
        task: (request, context) => this.#handleTaskIpc(request, context),
        system: (request) => this.#handleSystemIpc(request),
        hook: (request) => this.#handleHookIpc(request),
        activation: (request) => this.#handleActivationIpc(request),
        store: (request, context) => this.#handleStoreIpc(request, context),
        doctor: (request) => this.#handleDoctorIpc(request),
      },
      log: (input) => this.#log(input),
    }).handler();
  }

  async start(): Promise<void> {
    if (this.#lock || this.#server) {
      throw new GoalProgressIpcHandlerError(
        "HELPER_ALREADY_RUNNING",
        "This Helper instance is already running",
      );
    }
    this.#ready = false;
    const lock = await acquireHelperInstanceLock(this.paths, this.#lockOptions);
    const server = new GoalProgressIpcServer(this.paths.helperSocketPath, this.#handler());
    try {
      await this.#key();
      await server.start({ removeStaleSocket: true });
    } catch (error) {
      await lock.release();
      throw error;
    }
    this.#lock = lock;
    this.#server = server;
    if (this.#server !== server) return;
    this.#ready = true;
    await this.#log({
      level: "info",
      event: "helper.started",
    });
  }

  async stop(): Promise<void> {
    this.#workspaceStorage.close();
    this.#ready = false;
    const server = this.#server;
    const lock = this.#lock;
    this.#server = undefined;
    this.#lock = undefined;
    await server?.stop();
    await this.#runtime.close();
    await this.#log({
      level: "info",
      event: "helper.stopped",
    });
    await lock?.release();
  }
}

export async function runHelperCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const root = process.env.GOAL_PROGRESS_ROOT;
  const paths = resolveGoalProgressPaths(root === undefined ? {} : { root: resolve(root) });
  if (argv[0] === "doctor") {
    const sessionFlag = argv.indexOf("--session-id");
    const sessionId = sessionFlag >= 0 && argv[sessionFlag + 1] ? argv[sessionFlag + 1] : undefined;
    const result = await inspectGoalProgress(paths, sessionId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (argv.length > 0 && argv[0] !== "serve") {
    throw new Error("Usage: goal-progress-helper [serve|doctor --json]");
  }
  const helper = new GoalProgressHelper({ paths });
  await helper.start();
  const stop = async () => {
    await helper.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  runHelperCli().catch((error: unknown) => {
    process.stderr.write(`${helperErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
