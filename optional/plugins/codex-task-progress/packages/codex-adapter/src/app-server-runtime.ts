import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CodexAgentObservation,
  readCodexAgentObservation,
} from "vibe-coding-kit/src/tasks/codex-agent-runtime.mjs";
import type {
  NativeGoalTokenUsage,
  RuntimeIdentity,
  ThreadGoal,
} from "../../contracts/src/index.js";
import type {
  AppServerNotificationSummary,
  CodexAppServerClientOptions,
  CodexThreadIdentity,
} from "./index.js";
import {
  type CurrentThreadResolver,
  type CurrentThreadResolverInput,
  createCurrentThreadResolver,
  type ThreadCatalogEntry,
} from "./thread-resolver.js";

export const APP_SERVER_RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export const TOKEN_POLLING_INTERVALS_MS = Object.freeze({
  active: 1_750,
  collapsedOrBackground: 5_000,
  paused: 10_000,
});

export const TOKEN_POLLING_FAILURE_THRESHOLD = 3;
export const TOKEN_POLLING_JITTER_RATIO = 0.1;

export type TokenPollingMode = "active" | "collapsed-or-background" | "paused" | "stopped";

export interface GoalUsageSnapshot {
  readonly threadId: string;
  readonly goal: ThreadGoal | null;
  readonly tokenUsage: NativeGoalTokenUsage;
  readonly stale: boolean;
  readonly unavailable: boolean;
}

export interface DirectSubagentContext {
  parentThreadId: string;
  cwd: string;
  rootTurnId?: string;
  rootTurnStartedAt?: string;
}
export interface DirectSubagentMetadata {
  path: string | null;
  cwd: string;
  turnId: string;
  rootTurnId: string;
  turnStartedAt: string;
}
export interface DirectSubagentProof {
  parentThreadId: string;
  cwd: string;
  rootTurnId: string;
  turnStartedAt: string;
}

export interface CodexAppServerSession {
  readonly closed: Promise<void>;
  readonly requestMethods: readonly string[];
  getGoal(threadId: string): Promise<ThreadGoal | null>;
  readThreadIdentity(threadId: string): Promise<CodexThreadIdentity>;
  listLoadedThreads(): Promise<readonly ThreadCatalogEntry[]>;
  listThreads(filter?: { readonly cwd?: string }): Promise<readonly ThreadCatalogEntry[]>;
  listTurnIds(threadId: string): Promise<readonly string[]>;
  listSubagentTurns?(
    threadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }>;
  listDirectSubagents?(
    parentThreadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }>;
  readSubagentObservationMetadata?(
    threadId: string,
    parentThreadId: string,
  ): Promise<DirectSubagentMetadata | null>;
  close(): Promise<void>;
}

export interface CodexAppServerRuntime {
  verifyDirectSubagent?(
    threadId: string,
    context: DirectSubagentContext,
  ): Promise<DirectSubagentProof | null>;
  observeDirectSubagent?(
    threadId: string,
    context: DirectSubagentContext,
  ): Promise<CodexAgentObservation>;
  listSubagentTurns?(
    threadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }>;
  listDirectSubagents?(
    parentThreadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }>;
  getGoal(threadId: string): Promise<ThreadGoal | null>;
  readThreadIdentity(threadId: string): Promise<CodexThreadIdentity>;
  resolveCurrentThread(input: CurrentThreadResolverInput): Promise<RuntimeIdentity>;
  refreshGoalUsage(threadId: string): Promise<GoalUsageSnapshot>;
  watchGoalUsage(threadId: string, listener: (snapshot: GoalUsageSnapshot) => void): void;
  unwatchGoalUsage?(threadId: string): void;
  setPollingMode(mode: TokenPollingMode, threadId?: string): void;
  close(): Promise<void>;
}

export interface CodexAppServerRuntimeOptions extends Omit<CodexAppServerClientOptions, "command"> {
  readonly command?: string | (() => Promise<string>);
  readonly connect?: () => Promise<CodexAppServerSession>;
  readonly reconnectDelaysMs?: readonly number[];
  readonly tokenPolling?: {
    readonly activeMs?: number;
    readonly collapsedOrBackgroundMs?: number;
    readonly pausedMs?: number;
    readonly failureThreshold?: number;
    readonly jitterRatio?: number;
  };
  readonly random?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly setTimeout?: (handler: () => void, timeout: number) => unknown;
  readonly clearTimeout?: (id: unknown) => void;
}

export function selectReconnectDelayMs(
  consecutiveFailures: number,
  delays: readonly number[] = APP_SERVER_RECONNECT_DELAYS_MS,
): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  const index = Math.min(consecutiveFailures - 1, delays.length - 1);
  return delays[index] ?? 30_000;
}

export function selectTokenPollingIntervalMs(
  mode: TokenPollingMode,
  intervals: {
    readonly active: number;
    readonly collapsedOrBackground: number;
    readonly paused: number;
  } = TOKEN_POLLING_INTERVALS_MS,
): number | null {
  if (mode === "stopped") {
    return null;
  }
  if (mode === "active") {
    return intervals.active;
  }
  if (mode === "collapsed-or-background") {
    return intervals.collapsedOrBackground;
  }
  return intervals.paused;
}

export function applyJitter(
  delayMs: number,
  random: () => number = Math.random,
  ratio: number = TOKEN_POLLING_JITTER_RATIO,
): number {
  const delta = (random() * 2 - 1) * ratio;
  return Math.max(0, Math.round(delayMs * (1 + delta)));
}

function tokenUsageFromGoal(
  goal: ThreadGoal | null,
  threadId: string,
  splitUsage?: { readonly inputTokens: number; readonly outputTokens: number },
): NativeGoalTokenUsage {
  if (!goal) {
    return {
      schemaVersion: 1,
      availability: "unavailable",
      source: "unavailable",
      threadId,
      reason: "goal-not-found",
    };
  }
  if (goal.threadId !== threadId) {
    return {
      schemaVersion: 1,
      availability: "unavailable",
      source: "unavailable",
      threadId,
      reason: "thread-mismatch",
    };
  }
  return {
    schemaVersion: 1,
    availability: "available",
    source: "native-goal",
    threadId,
    tokensUsed: goal.tokensUsed,
    ...(splitUsage ?? {}),
    tokenBudget: goal.tokenBudget ?? null,
    goalUpdatedAt: goal.updatedAt,
  };
}

function usageFingerprint(snapshot: GoalUsageSnapshot): string {
  const token =
    snapshot.tokenUsage.availability === "available"
      ? {
          used: snapshot.tokenUsage.tokensUsed,
          input: snapshot.tokenUsage.inputTokens,
          output: snapshot.tokenUsage.outputTokens,
          budget: snapshot.tokenUsage.tokenBudget,
        }
      : { availability: snapshot.tokenUsage.availability, reason: snapshot.tokenUsage.reason };
  return JSON.stringify({
    threadId: snapshot.threadId,
    stale: snapshot.stale,
    unavailable: snapshot.unavailable,
    token,
    status: snapshot.goal?.status ?? null,
    createdAt: snapshot.goal?.createdAt ?? null,
    objective: snapshot.goal?.objective ?? null,
  });
}

function effectivePollingMode(
  requested: TokenPollingMode,
  goal: ThreadGoal | null | undefined,
): TokenPollingMode {
  if (requested === "stopped") {
    return "stopped";
  }
  if (goal === undefined) {
    return requested;
  }
  if (goal === null || goal.status === "complete") {
    return "stopped";
  }
  if (goal.status === "paused") {
    return "paused";
  }
  return requested;
}

class CodexAppServerRuntimeImpl implements CodexAppServerRuntime {
  readonly #options: CodexAppServerRuntimeOptions;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #pollingIntervals: {
    readonly active: number;
    readonly collapsedOrBackground: number;
    readonly paused: number;
  };
  readonly #failureThreshold: number;
  readonly #jitterRatio: number;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #setTimeout: (handler: () => void, timeout: number) => unknown;
  readonly #clearTimeout: (id: unknown) => void;
  #queue: Promise<void> = Promise.resolve();
  #client: CodexAppServerSession | undefined;
  #resolver: CurrentThreadResolver | undefined;
  #consecutiveConnectFailures = 0;
  #closing = false;
  #requestedMode: TokenPollingMode = "active";
  readonly #requestedModeByThread = new Map<string, TokenPollingMode>();
  readonly #listenersByThread = new Map<string, (snapshot: GoalUsageSnapshot) => void>();
  readonly #nextPollAtByThread = new Map<string, number>();
  #pollTimer: unknown;
  #consecutiveReadFailuresByThread = new Map<string, number>();
  #lastGoalByThread = new Map<string, ThreadGoal | null>();
  #lastTrustedByThread = new Map<string, NativeGoalTokenUsage>();
  #splitUsageByThread = new Map<
    string,
    { readonly inputTokens: number; readonly outputTokens: number }
  >();
  #lastFingerprintByThread = new Map<string, string>();
  readonly #agentObservations = new Map<string, CodexAgentObservation>();

  constructor(options: CodexAppServerRuntimeOptions) {
    this.#options = options;
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? APP_SERVER_RECONNECT_DELAYS_MS;
    this.#pollingIntervals = {
      active: options.tokenPolling?.activeMs ?? TOKEN_POLLING_INTERVALS_MS.active,
      collapsedOrBackground:
        options.tokenPolling?.collapsedOrBackgroundMs ??
        TOKEN_POLLING_INTERVALS_MS.collapsedOrBackground,
      paused: options.tokenPolling?.pausedMs ?? TOKEN_POLLING_INTERVALS_MS.paused,
    };
    this.#failureThreshold =
      options.tokenPolling?.failureThreshold ?? TOKEN_POLLING_FAILURE_THRESHOLD;
    this.#jitterRatio = options.tokenPolling?.jitterRatio ?? TOKEN_POLLING_JITTER_RATIO;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#setTimeout = options.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout));
    this.#clearTimeout = options.clearTimeout ?? ((id) => clearTimeout(id as NodeJS.Timeout));
  }

  async listSubagentTurns(
    threadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const client = await this.#enqueue(() => this.#ensureClient());
    if (!client.listSubagentTurns) throw new Error("Subagent turn history unavailable");
    return client.listSubagentTurns(threadId, cursor);
  }

  async listDirectSubagents(
    parentThreadId: string,
    cursor?: string,
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const client = await this.#enqueue(() => this.#ensureClient());
    if (!client.listDirectSubagents) throw new Error("Subagent listing unavailable");
    return client.listDirectSubagents(parentThreadId, cursor);
  }

  async #verifiedAgentMetadata(
    threadId: string,
    context: DirectSubagentContext,
  ): Promise<DirectSubagentMetadata | null> {
    try {
      if (
        !context.rootTurnId ||
        !context.rootTurnStartedAt ||
        !Number.isFinite(Date.parse(context.rootTurnStartedAt))
      )
        return null;
      const client = await this.#enqueue(() => this.#ensureClient());
      if (!client.readSubagentObservationMetadata) return null;
      const metadata = await client.readSubagentObservationMetadata(
        threadId,
        context.parentThreadId,
      );
      if (
        !metadata ||
        metadata.rootTurnId !== context.rootTurnId ||
        !Number.isFinite(Date.parse(metadata.turnStartedAt)) ||
        Date.parse(metadata.turnStartedAt) < Date.parse(context.rootTurnStartedAt)
      )
        return null;
      const [project, childCwd] = await Promise.all([
        realpath(context.cwd),
        realpath(metadata.cwd),
      ]);
      if (project !== childCwd) return null;
      return { ...metadata, cwd: childCwd };
    } catch {
      return null;
    }
  }

  async verifyDirectSubagent(
    threadId: string,
    context: DirectSubagentContext,
  ): Promise<DirectSubagentProof | null> {
    const metadata = await this.#verifiedAgentMetadata(threadId, context);
    if (!metadata) return null;
    return {
      parentThreadId: context.parentThreadId,
      cwd: metadata.cwd,
      rootTurnId: metadata.rootTurnId,
      turnStartedAt: metadata.turnStartedAt,
    };
  }

  async observeDirectSubagent(
    threadId: string,
    context: DirectSubagentContext,
  ): Promise<CodexAgentObservation> {
    const unknown = (): CodexAgentObservation => ({
      state: "unknown",
      basis: "codex-rollout",
      observedAt: null,
      eventTurnId: null,
      eventType: null,
      complete: false,
      readStable: false,
      reason: "unverified-metadata",
    });
    const metadata = await this.#verifiedAgentMetadata(threadId, context);
    if (!metadata?.path) return unknown();
    try {
      const env = this.#options.env ?? process.env;
      const configuredHome = env.CODEX_HOME;
      const home =
        configuredHome ||
        (env.HOME && isAbsolute(env.HOME)
          ? resolve(env.HOME, ".codex")
          : resolve(homedir(), ".codex"));
      if (!isAbsolute(home)) return unknown();
      const [trustedRoot, target] = await Promise.all([
        realpath(resolve(home, "sessions")),
        realpath(metadata.path),
      ]);
      const rel = relative(trustedRoot, target);
      if (
        target !== resolve(metadata.path) ||
        !rel ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        return unknown();
      const before = await lstat(metadata.path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) return unknown();
      const fingerprint = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs]
        .map(String)
        .join(":");
      const key = JSON.stringify([
        threadId,
        context.parentThreadId,
        metadata.cwd,
        metadata.path,
        metadata.turnId,
        metadata.rootTurnId,
        metadata.turnStartedAt,
        fingerprint,
      ]);
      const cached = this.#agentObservations.get(key);
      if (cached) {
        const current = await lstat(metadata.path, { bigint: true });
        const currentFingerprint = [
          current.dev,
          current.ino,
          current.size,
          current.mtimeNs,
          current.ctimeNs,
        ]
          .map(String)
          .join(":");
        if (current.isFile() && !current.isSymbolicLink() && currentFingerprint === fingerprint)
          return cached;
        return unknown();
      }
      const observed = await readCodexAgentObservation({
        path: metadata.path,
        trustedRoot,
        threadId,
        cwd: metadata.cwd,
        parentThreadId: context.parentThreadId,
        turnId: metadata.turnId,
        rootTurnId: metadata.rootTurnId,
        turnStartedAt: metadata.turnStartedAt,
      });
      const after = await lstat(metadata.path, { bigint: true });
      const afterFingerprint = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]
        .map(String)
        .join(":");
      if (!after.isFile() || after.isSymbolicLink() || afterFingerprint !== fingerprint)
        return unknown();
      if (observed.readStable && observed.complete) {
        this.#agentObservations.set(key, observed);
        if (this.#agentObservations.size > 100) {
          const oldest = this.#agentObservations.keys().next().value;
          if (oldest !== undefined) this.#agentObservations.delete(oldest);
        }
      }
      return observed;
    } catch {
      return unknown();
    }
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.#enqueue(() => this.#getGoalUnlocked(threadId));
  }

  async readThreadIdentity(threadId: string): Promise<CodexThreadIdentity> {
    return this.#enqueue(async () => {
      const client = await this.#ensureClient();
      return client.readThreadIdentity(threadId);
    });
  }

  async resolveCurrentThread(input: CurrentThreadResolverInput): Promise<RuntimeIdentity> {
    return this.#enqueue(async () => {
      const client = await this.#ensureClient();
      this.#resolver ??= createCurrentThreadResolver(client);
      return this.#resolver.resolve(input);
    });
  }

  async refreshGoalUsage(threadId: string): Promise<GoalUsageSnapshot> {
    return this.#enqueue(() => this.#refreshUnlocked(threadId));
  }

  watchGoalUsage(threadId: string, listener: (snapshot: GoalUsageSnapshot) => void): void {
    if (!this.#listenersByThread.has(threadId)) {
      this.#lastFingerprintByThread.delete(threadId);
    }
    this.#listenersByThread.set(threadId, listener);
    void this.refreshGoalUsage(threadId).catch(() => undefined);
  }

  unwatchGoalUsage(threadId: string): void {
    this.#listenersByThread.delete(threadId);
    this.#requestedModeByThread.delete(threadId);
    this.#nextPollAtByThread.delete(threadId);
    this.#lastFingerprintByThread.delete(threadId);
    this.#armPoll();
  }

  setPollingMode(mode: TokenPollingMode, threadId?: string): void {
    if (threadId === undefined) {
      this.#requestedMode = mode;
      for (const watchedThreadId of this.#listenersByThread.keys()) {
        this.#resetNextPoll(watchedThreadId);
      }
    } else {
      this.#requestedModeByThread.set(threadId, mode);
      this.#resetNextPoll(threadId);
    }
    this.#armPoll();
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#clearPoll();
    this.#agentObservations.clear();
    this.#listenersByThread.clear();
    this.#requestedModeByThread.clear();
    this.#nextPollAtByThread.clear();
    await this.#enqueue(async () => {
      const client = this.#client;
      this.#client = undefined;
      this.#resolver = undefined;
      if (client) {
        await client.close().catch(() => undefined);
      }
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #getGoalUnlocked(threadId: string): Promise<ThreadGoal | null> {
    const client = await this.#ensureClient();
    return client.getGoal(threadId);
  }

  async #refreshUnlocked(threadId: string): Promise<GoalUsageSnapshot> {
    try {
      const goal = await this.#getGoalUnlocked(threadId);
      this.#consecutiveReadFailuresByThread.delete(threadId);
      if (!goal) {
        this.#lastGoalByThread.set(threadId, null);
        this.#lastTrustedByThread.delete(threadId);
        this.#splitUsageByThread.delete(threadId);
        const snapshot: GoalUsageSnapshot = {
          threadId,
          goal: null,
          tokenUsage: {
            schemaVersion: 1,
            availability: "unavailable",
            source: "unavailable",
            threadId,
            reason: "goal-not-found",
          },
          stale: false,
          unavailable: false,
        };
        this.#publish(snapshot);
        this.#armPoll();
        return snapshot;
      }
      const tokenUsage = tokenUsageFromGoal(goal, threadId, this.#splitUsageByThread.get(threadId));
      if (tokenUsage.availability === "available") {
        this.#lastTrustedByThread.set(threadId, tokenUsage);
      } else {
        this.#lastTrustedByThread.delete(threadId);
      }
      const trustedGoal = tokenUsage.availability === "available" ? goal : null;
      this.#lastGoalByThread.set(threadId, trustedGoal);
      const snapshot: GoalUsageSnapshot = {
        threadId,
        goal: trustedGoal,
        tokenUsage,
        stale: false,
        unavailable: false,
      };
      this.#publish(snapshot);
      this.#armPoll();
      return snapshot;
    } catch {
      const consecutiveReadFailures =
        (this.#consecutiveReadFailuresByThread.get(threadId) ?? 0) + 1;
      this.#consecutiveReadFailuresByThread.set(threadId, consecutiveReadFailures);
      const lastTrusted = this.#lastTrustedByThread.get(threadId);
      const snapshot: GoalUsageSnapshot = {
        threadId,
        goal: this.#lastGoalByThread.get(threadId) ?? null,
        tokenUsage: lastTrusted ?? {
          schemaVersion: 1,
          availability: "unavailable",
          source: "unavailable",
          threadId,
          reason: "read-failed",
        },
        stale: true,
        unavailable: consecutiveReadFailures >= this.#failureThreshold,
      };
      this.#publish(snapshot);
      this.#armPoll();
      return snapshot;
    }
  }

  async #ensureClient(): Promise<CodexAppServerSession> {
    if (this.#closing) {
      throw new Error("GOAL_PROGRESS_APP_SERVER_CLOSING");
    }
    if (this.#client) {
      return this.#client;
    }
    const delayMs = selectReconnectDelayMs(
      this.#consecutiveConnectFailures,
      this.#reconnectDelaysMs,
    );
    if (delayMs > 0) {
      await this.#sleep(delayMs);
      if (this.#closing) {
        throw new Error("GOAL_PROGRESS_APP_SERVER_CLOSING");
      }
    }
    try {
      const client = await this.#connect();
      this.#client = client;
      this.#resolver = createCurrentThreadResolver(client);
      this.#consecutiveConnectFailures = 0;
      void client.closed.then(() => {
        if (this.#client !== client || this.#closing) {
          return;
        }
        this.#client = undefined;
        this.#resolver = undefined;
        this.#consecutiveConnectFailures += 1;
      });
      return client;
    } catch (error) {
      this.#consecutiveConnectFailures += 1;
      throw error;
    }
  }

  async #connect(): Promise<CodexAppServerSession> {
    if (this.#options.connect) {
      return this.#options.connect();
    }
    const { CodexAppServerClient } = await import("./index.js");
    const command =
      typeof this.#options.command === "function"
        ? await this.#options.command()
        : this.#options.command;
    return CodexAppServerClient.connect({
      outputMode: "stream",
      onNotification: (notification) => this.#onNotification(notification),
      ...(command === undefined ? {} : { command }),
      ...(this.#options.args === undefined ? {} : { args: this.#options.args }),
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.#options.requestTimeoutMs }),
    });
  }

  #onNotification(notification: AppServerNotificationSummary): void {
    if (
      notification.method !== "thread/tokenUsage/updated" ||
      notification.threadId === undefined ||
      !this.#listenersByThread.has(notification.threadId) ||
      notification.tokenUsage === undefined
    ) {
      return;
    }
    this.#splitUsageByThread.set(notification.threadId, {
      inputTokens: notification.tokenUsage.tokenUsage.total.inputTokens,
      outputTokens: notification.tokenUsage.tokenUsage.total.outputTokens,
    });
    void this.refreshGoalUsage(notification.threadId).catch(() => undefined);
  }

  #publish(snapshot: GoalUsageSnapshot): void {
    const fingerprint = usageFingerprint(snapshot);
    if (this.#lastFingerprintByThread.get(snapshot.threadId) === fingerprint) {
      return;
    }
    this.#lastFingerprintByThread.set(snapshot.threadId, fingerprint);
    this.#listenersByThread.get(snapshot.threadId)?.(snapshot);
  }

  #armPoll(): void {
    this.#clearPoll();
    if (this.#closing || this.#listenersByThread.size === 0) {
      return;
    }
    const now = this.#now();
    const dueTimes: number[] = [];
    for (const threadId of this.#listenersByThread.keys()) {
      const interval = this.#pollingInterval(threadId);
      if (interval === null) {
        this.#nextPollAtByThread.delete(threadId);
        continue;
      }
      let dueAt = this.#nextPollAtByThread.get(threadId);
      if (dueAt === undefined) {
        dueAt = now + applyJitter(interval, this.#random, this.#jitterRatio);
        this.#nextPollAtByThread.set(threadId, dueAt);
      }
      dueTimes.push(dueAt);
    }
    if (dueTimes.length === 0) {
      return;
    }
    const delayMs = Math.max(0, Math.min(...dueTimes) - now);
    this.#pollTimer = this.#setTimeout(() => {
      void this.#pollOnce();
    }, delayMs);
  }

  async #pollOnce(): Promise<void> {
    this.#pollTimer = undefined;
    if (this.#listenersByThread.size === 0 || this.#closing) {
      return;
    }
    const now = this.#now();
    const dueThreadIds = [...this.#listenersByThread.keys()].filter(
      (threadId) => (this.#nextPollAtByThread.get(threadId) ?? Number.POSITIVE_INFINITY) <= now,
    );
    for (const threadId of dueThreadIds) {
      const interval = this.#pollingInterval(threadId);
      if (interval === null || !this.#listenersByThread.has(threadId) || this.#closing) {
        this.#nextPollAtByThread.delete(threadId);
        continue;
      }
      this.#nextPollAtByThread.set(
        threadId,
        now + applyJitter(interval, this.#random, this.#jitterRatio),
      );
      await this.refreshGoalUsage(threadId).catch(() => undefined);
    }
    this.#armPoll();
  }

  #pollingInterval(threadId: string): number | null {
    return selectTokenPollingIntervalMs(
      effectivePollingMode(
        this.#requestedModeByThread.get(threadId) ?? this.#requestedMode,
        this.#lastGoalByThread.get(threadId),
      ),
      this.#pollingIntervals,
    );
  }

  #resetNextPoll(threadId: string): void {
    if (!this.#listenersByThread.has(threadId)) {
      return;
    }
    const interval = this.#pollingInterval(threadId);
    if (interval === null) {
      this.#nextPollAtByThread.delete(threadId);
      return;
    }
    this.#nextPollAtByThread.set(
      threadId,
      this.#now() + applyJitter(interval, this.#random, this.#jitterRatio),
    );
  }

  #clearPoll(): void {
    if (this.#pollTimer === undefined) {
      return;
    }
    this.#clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }
}

export function createCodexAppServerRuntime(
  options: CodexAppServerRuntimeOptions = {},
): CodexAppServerRuntime {
  return new CodexAppServerRuntimeImpl(options);
}
