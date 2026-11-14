import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  migrateHeartbeatLedgerPair,
  readHeartbeatLedgerPair,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs";
import { HeartbeatDiscoveryIndex } from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import type {
  CodexCdpListenerOwnership,
  CodexCdpRuntimeState,
} from "../../../platform/macos/src/index.js";
import type { CodexAppServerRuntime, CodexThreadIdentity } from "../../codex-adapter/src/index.js";
import { GoalProgressIpcClient, GoalProgressIpcClientError } from "../../ipc/src/index.js";
import type {
  GoalProgressIpcAuthorization,
  GoalProgressIpcRequestInput,
} from "../../ipc/src/protocol.js";
import { GoalProgressLogger, resolveGoalProgressPaths } from "../../store/src/index.js";
import { HeartbeatService } from "../../tasks/src/heartbeat.js";
import {
  type TaskHistoryPage,
  type TaskMutationResult,
  type TaskState,
  TaskStore,
} from "../../tasks/src/index.js";
import { GoalProgressHelper } from "../src/index.js";
import {
  hasRecoverableStartupProgress,
  type MacosCodexStartupEvent,
  type MacosCodexStartupResponse,
  MacosStartupHandoffController,
  MacosStartupListenerSupervisor,
} from "../src/startup-listener.js";

test("disabled project task progress returns inert reads and rejects writes before workspace storage opens", async () => {
  const root = await mkdtemp("/tmp/ctph-optional-");
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".vibe-coding"));
  await writeFile(
    join(root, ".vibe-coding", "project.config.json"),
    JSON.stringify({ optional: { "task-progress": false } }),
  );
  const otherRoot = await mkdtemp("/tmp/ctph-optional-other-");
  await mkdir(join(otherRoot, ".git"));
  const testRuntime = runtime(root);
  testRuntime.readThreadIdentity = async (threadId) =>
    identity(threadId, threadId === "other-chat" ? otherRoot : root);
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let callNumber = 0;
  const request = (
    action: "get" | "initialize" | "update" | "history",
    threadId = "disabled-chat",
  ) =>
    client.request({
      method: "task.request",
      params: {
        action,
        auth: {
          kind: "codex-request",
          toolName:
            action === "get"
              ? "task_progress_get"
              : action === "initialize"
                ? "task_progress_initialize"
                : action === "update"
                  ? "task_progress_update"
                  : "task_progress_history",
          identity: {
            threadId,
            sessionId: threadId,
            turnId: "turn-1",
            callId: `call-${++callNumber}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
        input:
          action === "initialize"
            ? {
                requestId: "disabled-init",
                expectedRevision: 0,
                title: "Must not persist",
                reason: "Disabled project",
                objectives: [{ id: "I1", title: "No storage" }],
              }
            : {},
      },
    });
  try {
    await helper.start();
    const disabled = (await request("get")).result as {
      enabled: boolean;
      task: TaskState | null;
      heartbeat: unknown;
    };
    assert.deepEqual(disabled, { enabled: false, task: null, heartbeat: null });
    await assert.rejects(request("initialize"), hasCode("TASK_PROGRESS_DISABLED"));
    await assert.rejects(access(join(root, ".workspace", "codex-task-progress")), {
      code: "ENOENT",
    });
    // The preference belongs to the project root; an unrelated project remains fully usable.
    const auth = {
      kind: "codex-request" as const,
      toolName: "task_progress_initialize",
      identity: {
        threadId: "other-chat",
        sessionId: "other-chat",
        turnId: "turn-1",
        callId: `call-${++callNumber}`,
        model: "test",
        threadSource: "user" as const,
        cwd: otherRoot,
      },
    } as const;
    const ordinary = await client.request({
      method: "task.request",
      params: {
        action: "initialize",
        auth,
        input: {
          requestId: "other-init",
          expectedRevision: 0,
          title: "Enabled project",
          reason: "Preference absent",
          objectives: [{ id: "O1", title: "Persists" }],
        },
      },
    });
    assert.equal((ordinary.result as TaskMutationResult).state.title, "Enabled project");
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

function identity(threadId: string, cwd: string): CodexThreadIdentity {
  return {
    id: threadId,
    sessionId: threadId,
    cwd,
    threadSource: "user",
    agentRole: null,
    ephemeral: false,
    status: { type: "idle" },
  };
}
function runtime(cwd: string): CodexAppServerRuntime {
  return {
    async getGoal() {
      return null;
    },
    async readThreadIdentity(threadId) {
      return identity(threadId, cwd);
    },
    async resolveCurrentThread(input) {
      return {
        threadId: input.sessionTreeId,
        sessionTreeId: input.sessionTreeId,
        turnId: input.turnId,
        cwd,
        model: "test",
      };
    },
    async refreshGoalUsage() {
      throw new Error("ordinary task must not require Goal usage");
    },
    watchGoalUsage() {},
    unwatchGoalUsage() {},
    setPollingMode() {},
    async close() {},
  };
}
interface StorageDescriptor {
  mode: "workspace" | "legacy-read-only";
  root: string;
  taskDirectory: string;
}
function eventPath(root: string, threadId: string) {
  return join(
    root,
    "tasks",
    "v3",
    createHash("sha256").update(threadId).digest("hex"),
    "taskhistory.md",
  );
}
function legacyEventPath(root: string, threadId: string) {
  return join(
    root,
    "tasks",
    "v3",
    createHash("sha256").update(threadId).digest("hex"),
    "events.jsonl",
  );
}
function hasCode(code: string) {
  return (error: unknown) => error instanceof GoalProgressIpcClientError && error.code === code;
}
function trackProjectViewReads() {
  const original = HeartbeatService.prototype.projectView;
  const pending = new Set<Promise<unknown>>();
  HeartbeatService.prototype.projectView = function (cwd) {
    const read = original.call(this, cwd);
    pending.add(read);
    void read.then(
      () => pending.delete(read),
      () => pending.delete(read),
    );
    return read;
  };
  return {
    async wait(): Promise<void> {
      while (pending.size) await Promise.all([...pending]);
    },
    restore(): void {
      HeartbeatService.prototype.projectView = original;
    },
  };
}
async function getAfterProjectViewRefresh<T>(
  request: () => Promise<T>,
  tracker: ReturnType<typeof trackProjectViewReads>,
): Promise<T> {
  let response = await request();
  while (
    (response as unknown as { result?: { heartbeatPending?: boolean } }).result?.heartbeatPending
  ) {
    await tracker.wait();
    response = await request();
  }
  return response;
}

test("ordinary get returns local task while a deduplicated project heartbeat refresh is pending", async () => {
  const root = await mkdtemp("/tmp/ctph-heartbeat-pending-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const request = (action: "initialize" | "get", input: unknown) =>
    client.request({
      method: "task.request",
      params: {
        action,
        auth: {
          kind: "codex-request",
          toolName: action === "get" ? "task_progress_get" : "task_progress_initialize",
          identity: {
            threadId: "pending-chat",
            sessionId: "pending-chat",
            turnId: "turn-1",
            callId: `pending-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
        input,
      },
    });
  const originalProjectView = HeartbeatService.prototype.projectView;
  let releaseRefresh: (() => void) | undefined;
  let refreshDone: Promise<void> | undefined;
  let holdNextProjectRead = false;
  try {
    await helper.start();
    await request("initialize", {
      requestId: "pending-init",
      expectedRevision: 0,
      title: "Local checklist",
      reason: "Exercise nonblocking project summary",
      objectives: [{ id: "L1", title: "Persisted locally" }],
    });
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { maxFiles: 499 } }),
    );
    await writeFile(
      join(root, "heartbeat-unrelated.md"),
      "## 2026-01-01T10:00Z wake (10-row ledger)\nthread: another-chat\n",
    );
    await writeFile(join(root, "heartbeat-unrelated.taskhistory.md"), "corrupt companion");
    holdNextProjectRead = true;
    HeartbeatService.prototype.projectView = function (cwd) {
      if (holdNextProjectRead) {
        holdNextProjectRead = false;
        return new Promise((resolve) => {
          refreshDone = new Promise<void>((done) => {
            releaseRefresh = () => {
              void originalProjectView.call(this, cwd).then(resolve).finally(done);
            };
          });
        });
      }
      const refresh = originalProjectView.call(this, cwd);
      refreshDone = refresh.then(() => undefined);
      return refresh;
    };

    const pending = await request("get", {});
    const pendingResult = pending.result as {
      task: TaskState | null;
      taskSource: unknown;
      heartbeat: unknown;
      heartbeatPending?: boolean;
    };
    assert.equal(pendingResult.task?.title, "Local checklist");
    assert.deepEqual(pendingResult.taskSource, { status: "candidates", readOnly: true });
    assert.equal(pendingResult.heartbeat, null);
    assert.equal(pendingResult.heartbeatPending, true);
    assert.equal(pending.revision, 1);

    assert.ok(releaseRefresh);
    releaseRefresh();
    await refreshDone;
    const visibleError = (await request("get", {})).result as {
      heartbeat: { status: string; error?: string } | null;
      taskSource: unknown;
      heartbeatPending?: boolean;
    };
    assert.equal(visibleError.heartbeat?.status, "error");
    assert.match(visibleError.heartbeat?.error ?? "", /heartbeat-unrelated/i);
    assert.deepEqual(visibleError.taskSource, { status: "candidates", readOnly: true });
    await rm(join(root, "heartbeat-unrelated.md"));
    await rm(join(root, "heartbeat-unrelated.taskhistory.md"));

    const retry = (await request("get", {})).result as {
      heartbeat: { status: string; error?: string } | null;
      heartbeatPending?: boolean;
    };
    assert.equal(retry.heartbeat?.status, "error");
    assert.equal(retry.heartbeatPending, true);
    let recovered:
      | { heartbeat: { status: string } | null; heartbeatPending?: boolean; task: TaskState | null }
      | undefined;
    const deadline = Date.now() + 2_000;
    for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt += 1) {
      await refreshDone;
      recovered = (await request("get", {})).result as typeof recovered;
      assert.equal(recovered?.task?.title, "Local checklist");
      if (recovered?.heartbeat?.status === "none" && recovered.heartbeatPending === undefined)
        break;
    }
    assert.equal(recovered?.heartbeat?.status, "none");
    assert.equal(recovered?.heartbeatPending, undefined);
  } finally {
    HeartbeatService.prototype.projectView = originalProjectView;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("slow task diagnostics record bounded stage timings without changing get results", async () => {
  const root = await mkdtemp("/tmp/ctph-task-diagnostics-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const testRuntime = runtime(root);
  testRuntime.readThreadIdentity = async (threadId) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 520));
    return identity(threadId, root);
  };
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  try {
    await helper.start();
    const response = await client.request({
      method: "task.request",
      params: {
        action: "get",
        auth: {
          kind: "codex-request",
          toolName: "task_progress_get",
          identity: {
            threadId: "private-thread-id",
            sessionId: "private-thread-id",
            turnId: "turn-1",
            callId: "call-1",
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
        input: {},
      },
    });
    const result = response.result as {
      task: TaskState | null;
      heartbeat: unknown;
      taskSource: unknown;
      completionBasis: string;
      execution: { state: string };
      storage: { mode: string; root: string };
    };
    assert.equal(result.task, null);
    assert.equal(result.heartbeat, null);
    assert.equal(result.taskSource, null);
    assert.equal(result.completionBasis, "registered-checklist");
    assert.equal(result.execution.state, "idle");
    assert.equal(result.storage.mode, "workspace");
    assert.ok(result.storage.root.endsWith("/.workspace/codex-task-progress"));
  } finally {
    await helper.stop();
  }

  try {
    const log = (await readFile(paths.helperLogPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { code?: string; durationMs?: number; threadKey?: string },
      );
    const diagnostics = log.filter((entry) => entry.code?.startsWith("TASK_PERF_"));
    assert.ok(diagnostics.length >= 5);
    assert.ok(
      diagnostics.every(
        (entry) =>
          typeof entry.durationMs === "number" &&
          Number.isInteger(entry.durationMs) &&
          entry.durationMs >= 0,
      ),
    );
    assert.ok(diagnostics.every((entry) => /^[0-9a-f]{64}$/.test(entry.threadKey ?? "")));
    assert.ok(
      diagnostics.some(
        (entry) => entry.code === "TASK_PERF_TOTAL" && (entry.durationMs ?? -1) >= 500,
      ),
    );
    assert.ok(
      diagnostics.some(
        (entry) => entry.code === "TASK_PERF_NATIVE_IDENTITY" && (entry.durationMs ?? -1) >= 500,
      ),
    );
    assert.ok(diagnostics.some((entry) => entry.code === "TASK_PERF_TASK_PROJECTION"));
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /private-thread-id|private-session-id|cwd|sourcePath|evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function taskEvents(root: string, threadId: string) {
  const store = new TaskStore(join(root, ".workspace", "codex-task-progress"));
  return (await store.history(threadId, { limit: 100 })).events;
}

test("real Helper IPC supports ordinary task completion, regression, pagination, isolated chats and restart", async () => {
  const root = await mkdtemp("/tmp/ctph-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const options = {
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  };
  let helper = new GoalProgressHelper(options);
  let callNumber = 0;
  const projectReads = trackProjectViewReads();
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  async function request(
    action: "get" | "initialize" | "update" | "rescope" | "history",
    input: unknown,
    threadId = "ordinary-chat",
  ) {
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: `task_progress_${action}`,
      identity: {
        threadId,
        sessionId: threadId,
        turnId: "turn-1",
        callId: `call-${++callNumber}`,
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  try {
    await helper.start();
    const empty = await getAfterProjectViewRefresh(() => request("get", {}), projectReads);
    const emptyState = empty.result as {
      task: TaskState | null;
      heartbeat: { status: string; sourcePath: string | null; itemCount: number };
      execution: { state: string; source: string; observedAt: string };
      completionBasis: string;
      storage: StorageDescriptor;
    };
    assert.equal(emptyState.task, null);
    assert.equal(emptyState.heartbeat.status, "none");
    assert.equal(emptyState.heartbeat.sourcePath, null);
    assert.equal(emptyState.heartbeat.itemCount, 0);
    assert.equal(emptyState.execution.state, "idle");
    assert.equal(emptyState.execution.source, "codex-app-server");
    assert.ok(Number.isFinite(Date.parse(emptyState.execution.observedAt)));
    assert.equal(emptyState.completionBasis, "registered-checklist");
    const workspaceRoot = join(await realpath(root), ".workspace", "codex-task-progress");
    assert.equal(emptyState.storage.mode, "workspace");
    assert.equal(emptyState.storage.root, workspaceRoot);
    assert.ok(emptyState.storage.taskDirectory.startsWith(`${workspaceRoot}/`));
    const initialized = await request("initialize", {
      requestId: "init",
      expectedRevision: 0,
      title: "Deliver ordinary task",
      reason: "User requested implementation",
      objectives: [{ id: "C1", title: "Deliver", items: [{ id: "C1.1", title: "Build" }] }],
    });
    assert.equal((initialized.result as TaskMutationResult).state.progress.percent, 0);
    const initializedStorage = (
      initialized.result as TaskMutationResult & { storage: StorageDescriptor }
    ).storage;
    assert.equal(initializedStorage.mode, "workspace");
    assert.equal(initializedStorage.root, workspaceRoot);
    const recordedEvents = await readFile(eventPath(workspaceRoot, "ordinary-chat"), "utf8");
    assert.match(recordedEvents, /"requestId": "init"/);
    await assert.rejects(access(eventPath(paths.root, "ordinary-chat")), { code: "ENOENT" });
    await assert.rejects(access(eventPath(join(paths.root, "tasks"), "ordinary-chat")), {
      code: "ENOENT",
    });
    const completed = await request("update", {
      requestId: "complete",
      expectedRevision: 1,
      reason: "Build verified",
      changes: [
        {
          targetId: "C1.1",
          status: "completed",
          evidence: [{ summary: "Build succeeded", verification: "verified", kind: "build" }],
        },
      ],
    });
    const done = (completed.result as TaskMutationResult).state;
    assert.equal(done.progress.percent, 100);
    assert.equal(done.phase, "completed");
    const expanded = await request("rescope", {
      requestId: "expand",
      expectedRevision: 2,
      reason: "User added delivery verification",
      objectives: [...done.objectives, { id: "C2", title: "Verify delivery" }],
    });
    assert.equal((expanded.result as TaskMutationResult).state.progress.percent, 50);
    assert.equal((expanded.result as TaskMutationResult).state.phase, "active");
    const history = await request("history", { limit: 1 });
    const page = (history.result as { history: TaskHistoryPage }).history;
    assert.equal(page.events[0]?.before?.percent, 100);
    assert.equal(page.events[0]?.after.percent, 50);
    assert.equal(page.events[0]?.reason, "User added delivery verification");
    assert.ok(page.nextCursor);
    const older = await request("history", { cursor: page.nextCursor, limit: 2 });
    assert.deepEqual(
      (older.result as { history: TaskHistoryPage }).history.events.map((event) => event.revision),
      [2, 1],
    );
    const otherChat = (await request("get", {}, "another-chat")).result as {
      task: TaskState | null;
    };
    assert.equal(otherChat.task, null);
    const inventoryCount = 4_000;
    const inventoryLines = Array.from(
      { length: inventoryCount },
      (_, index) =>
        `| I${index} | request | Inventory ${index} | custom-status-${index} | Evidence ${index} |`,
    );
    await mkdir(join(root, "kit"), { recursive: true });
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs" } }),
    );
    await writeFile(
      join(root, "kit/heartbeat-ledger-api.mjs"),
      `export function inspectHeartbeatLedger(text,{mode}) {
        const rows=text.split('\\n').map((line,index)=>({line,index})).filter(({line})=>line.startsWith('| I'));
        const items=rows.map(({line,index})=>{const cells=line.slice(1,-1).split('|').map(cell=>cell.trim());return {id:cells[0],source:cells[1],item:cells[2],status:cells[3],evidence:cells[4],line:index+1};});
        const findings=mode==='items'?items.map(item=>({severity:'error',rule:'invalid-status',message:'invalid status '+item.status+' at item '+item.id})):[];
        return {mode,certifiesCurrent:false,passed:false,wakes:[],items,findings};
      }`,
    );
    await writeFile(
      join(root, "heartbeat.md"),
      [
        "# Supervision",
        "thread: inventory-chat",
        "## Items",
        "| id | source | item | status | evidence |",
        "| --- | --- | --- | --- | --- |",
        ...inventoryLines,
        "",
      ].join("\n"),
    );
    const projectHeartbeat = (
      await getAfterProjectViewRefresh(() => request("get", {}, "inventory-chat"), projectReads)
    ).result as {
      heartbeat: { status: string; itemCount: number; itemStatusCounts: Record<string, number> };
      task: TaskState | null;
      taskSource: { status: string; path: string; error: string };
    };
    assert.equal(projectHeartbeat.heartbeat.status, "ready");
    assert.equal(projectHeartbeat.heartbeat.itemCount, inventoryCount);
    assert.deepEqual(projectHeartbeat.heartbeat.itemStatusCounts, { unknown: inventoryCount });
    assert.equal(projectHeartbeat.task, null);
    assert.equal(projectHeartbeat.taskSource.status, "error");
    assert.ok(projectHeartbeat.taskSource.path.endsWith("/heartbeat.md"));
    assert.ok(projectHeartbeat.taskSource.error.length <= 2_001);
    assert.ok(Buffer.byteLength(JSON.stringify(projectHeartbeat)) < 192 * 1024);
    await helper.stop();
    helper = new GoalProgressHelper({ ...options, runtime: runtime(root) });
    await helper.start();
    const restored = (await request("get", {})).result as {
      task: TaskState;
      storage: StorageDescriptor;
    };
    assert.equal(restored.storage.mode, "workspace");
    assert.equal(restored.storage.root, workspaceRoot);
    assert.equal(restored.task.revision, 3);
    assert.equal(restored.task.progress.percent, 50);
    const duplicate = await request("rescope", {
      requestId: "expand",
      expectedRevision: 2,
      reason: "User added delivery verification",
      objectives: [...done.objectives, { id: "C2", title: "Verify delivery" }],
    });
    assert.equal((duplicate.result as TaskMutationResult).duplicate, true);
    await assert.rejects(
      request("update", {
        requestId: "stale",
        expectedRevision: 1,
        reason: "Stale update",
        changes: [{ targetId: "C1.1", status: "active" }],
      }),
      hasCode("TASK_REVISION_CONFLICT"),
    );
  } finally {
    projectReads.restore();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Helper rejects mismatched tool identity, mismatched exact chat record and untrusted panel chat", async () => {
  const root = await mkdtemp("/tmp/ctph-auth-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const mocked = runtime(root);
  mocked.readThreadIdentity = async (threadId) => ({
    ...identity(threadId, root),
    ...(threadId === "worker-chat" ? { agentRole: "worker" } : {}),
  });
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const cdp = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "cdp" });
  try {
    await helper.start();
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: "task_progress_get",
      identity: {
        threadId: "ordinary-chat",
        sessionId: "ordinary-chat",
        turnId: "turn-1",
        callId: "bad-tool",
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    await assert.rejects(
      client.request({ method: "task.request", params: { action: "history", auth, input: {} } }),
      hasCode("TASK_TOOL_MISMATCH"),
    );
    await assert.rejects(
      client.request({
        method: "task.request",
        params: {
          action: "get",
          auth: {
            ...auth,
            identity: { ...auth.identity, callId: "bad-session", sessionId: "someone-else" },
          },
          input: {},
        },
      } as GoalProgressIpcRequestInput),
      hasCode("CODEX_REQUEST_IDENTITY_CONFLICT"),
    );
    await assert.rejects(
      cdp.request({ method: "task.view", params: { action: "get", threadId: "worker-chat" } }),
      hasCode("TASK_THREAD_UNTRUSTED"),
    );
    await assert.rejects(
      client.request({ method: "task.view", params: { action: "get", threadId: "ordinary-chat" } }),
      hasCode("IPC_METHOD_FORBIDDEN"),
    );
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("associated Kit heartbeat is authoritative, read-only and restores dormant local task on unbind", async () => {
  const root = await mkdtemp("/tmp/ctph-heartbeat-source-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const projectReads = trackProjectViewReads();
  async function request(
    action: "initialize" | "update" | "get" | "history" | "bind-heartbeat",
    input: unknown,
    threadId = "source-chat",
  ) {
    const toolNames = {
      initialize: "task_progress_initialize",
      update: "task_progress_update",
      get: "task_progress_get",
      history: "task_progress_history",
      "bind-heartbeat": "task_progress_bind_heartbeat",
    } as const;
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: toolNames[action],
      identity: {
        threadId,
        sessionId: threadId,
        turnId: "turn-1",
        callId: `source-${++call}`,
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  const ledgerPath = join(root, "heartbeat.md");
  const ledger =
    "# Supervision\nthread: source-chat\n## 2026-11-11T10:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n<!-- large-source -->\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| H1 | request | Source task | blocked | Waiting |\n";
  try {
    await helper.start();
    await request("initialize", {
      requestId: "dormant-init",
      expectedRevision: 0,
      title: "Dormant local task",
      reason: "Record local history before source association",
      objectives: [{ id: "L1", title: "Local item" }],
    });
    await mkdir(join(root, "kit"), { recursive: true });
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs" } }),
    );
    await writeFile(
      join(root, "kit/heartbeat-ledger-api.mjs"),
      `export function inspectHeartbeatLedger(text, {mode}) { const lines=text.split('\\n'); const headings=lines.filter(line=>/^#{1,6}\\s+.* wake \\(/i.test(line)); const selected=mode==='history'?headings:headings.slice(-1); const wakes=selected.map((heading,index)=>({heading:heading.trim(),timeMs:1794391200000+index,line:lines.indexOf(heading)+1,rows:[]})); const items=text.includes('large-source')?Array.from({length:2500},(_,i)=>({id:i===0?'H'+('x'.repeat(200)):'H'+i,item:'Source item '+i,status:i%2?'blocked':'done',evidence:'Evidence '+i,line:i+1})): [{id:'H1',item:'Source task',status:'blocked',evidence:'Waiting',line:7}]; return {mode, certifiesCurrent: mode==='current', passed:true, wakeCount:wakes.length, itemCount:items.length, wakes, items, findings:[]}; }`,
    );
    await writeFile(ledgerPath, ledger);
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs", maxFiles: 100 } }),
    );
    const canonicalLedgerPath = await realpath(ledgerPath);
    const canonicalRoot = await realpath(root);
    const legacyPair = readHeartbeatLedgerPair({ root: canonicalRoot, path: canonicalLedgerPath });
    const paired = migrateHeartbeatLedgerPair({
      root: canonicalRoot,
      path: canonicalLedgerPath,
      legacyWritersQuiescent: true,
      expectedContentHash: legacyPair.contentHash,
    });
    const migratedHead = await readFile(canonicalLedgerPath, "utf8");
    const migratedHistory = await readFile(paired.historyPath, "utf8");
    const expectedWakeLine =
      migratedHistory.split("\n").findIndex((line) => line.includes("2026-11-11T10:00:00Z wake")) +
      1;
    assert.equal(await readFile(`${canonicalLedgerPath}.legacy`, "utf8"), ledger);
    await request("bind-heartbeat", { path: ledgerPath });
    const before = await taskEvents(root, "source-chat");
    const projected = (await getAfterProjectViewRefresh(() => request("get", {}), projectReads))
      .result as {
      task: TaskState & {
        source: {
          itemStatusCount: number;
          itemStatuses: Record<string, string>;
          presentation: { truncated: boolean; sourceItemCount: number; displayedItemCount: number };
        };
      };
      taskSource: { status: string; path: string; historyPath?: string; readOnly: boolean };
    };
    assert.equal(projected.task.title, "Heartbeat ledger task");
    assert.equal(projected.task.objectives[0]?.status, "completed");
    assert.equal(projected.task.progress.total, 2500);
    assert.equal(projected.task.source.itemStatusCount, 2500);
    const longSourceId = `H${"x".repeat(200)}`;
    assert.equal(projected.task.objectives[0]?.id, longSourceId);
    assert.equal(projected.task.source.itemStatuses[longSourceId], "done");
    assert.equal(projected.task.source.presentation.truncated, true);
    assert.equal(projected.task.source.presentation.sourceItemCount, 2500);
    assert.ok(projected.task.source.presentation.displayedItemCount < 2500);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 192 * 1024);
    assert.equal(projected.taskSource.status, "ready");
    assert.equal(projected.taskSource.path, canonicalLedgerPath);
    assert.equal(projected.taskSource.historyPath, paired.historyPath);
    assert.equal(projected.taskSource.readOnly, true);
    await assert.rejects(
      request("update", {
        requestId: "parallel-update",
        expectedRevision: 1,
        reason: "Attempt to duplicate source task",
        changes: [{ targetId: "H1", status: "completed" }],
      }),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
    assert.deepEqual(await taskEvents(root, "source-chat"), before);
    const history = (await request("history", {})).result as {
      history: {
        events: unknown[];
        wakes: {
          heading: string;
          sourcePath: string;
          line: number;
          rows: { num: number; state: string }[];
        }[];
        source: { path: string; historyPath: string; readOnly: boolean };
      };
    };
    assert.deepEqual(history.history.events, []);
    assert.equal(history.history.source.path, canonicalLedgerPath);
    assert.equal(history.history.source.historyPath, paired.historyPath);
    assert.equal(history.history.source.readOnly, true);
    assert.equal(history.history.wakes.length, 1);
    assert.match(history.history.wakes[0]?.heading ?? "", /2026-11-11T10:00:00Z wake/);
    assert.equal(history.history.wakes[0]?.sourcePath, paired.historyPath);
    assert.equal(history.history.wakes[0]?.line, expectedWakeLine);
    await request("bind-heartbeat", { path: null });
    const restored = (await request("get", {})).result as { task: TaskState };
    assert.equal(restored.task.title, "Dormant local task");
    assert.deepEqual(await taskEvents(root, "source-chat"), before);
    assert.equal(await readFile(canonicalLedgerPath, "utf8"), migratedHead);
    assert.equal(await readFile(paired.historyPath, "utf8"), migratedHistory);

    await rm(ledgerPath);
    const ambiguousLedger = ledger
      .replaceAll("source-chat", "ambiguous-chat")
      .replace("<!-- large-source -->\n", "");
    await writeFile(join(root, "heartbeat-one.md"), ambiguousLedger);
    await writeFile(join(root, "heartbeat-two.md"), ambiguousLedger);
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs", maxFiles: 101 } }),
    );
    await assert.rejects(
      request(
        "initialize",
        {
          requestId: "ambiguous-init",
          expectedRevision: 0,
          title: "Must wait for source selection",
          reason: "Two heartbeat ledgers match",
          objectives: [{ id: "A1", title: "Do not create parallel scope" }],
        },
        "ambiguous-chat",
      ),
      hasCode("TASK_SOURCE_SELECTION_REQUIRED"),
    );
    const ambiguous = (
      await getAfterProjectViewRefresh(() => request("get", {}, "ambiguous-chat"), projectReads)
    ).result as {
      task: TaskState | null;
      taskSource: { status: string; error?: string };
      heartbeat: { status: string; sourcePath: string | null; candidates: readonly unknown[] };
    };
    assert.equal(ambiguous.task, null);
    assert.equal(ambiguous.taskSource.status, "pending-selection");
    assert.equal(ambiguous.heartbeat.status, "ready");
    assert.equal(ambiguous.heartbeat.sourcePath, await realpath(join(root, "heartbeat-one.md")));
    assert.equal(ambiguous.heartbeat.candidates.length, 0);
    assert.match(ambiguous.taskSource.error ?? "", /Multiple heartbeat ledgers/);
    const ambiguousEventsPath = eventPath(
      join(await realpath(root), ".workspace", "codex-task-progress"),
      "ambiguous-chat",
    );
    await assert.rejects(access(ambiguousEventsPath), { code: "ENOENT" });
    const ambiguousHistory = (await request("history", {}, "ambiguous-chat")).result as {
      history: { events: unknown[] };
    };
    assert.deepEqual(ambiguousHistory.history.events, []);

    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({
        heartbeat: {
          kitPath: "kit/heartbeat-ledger-api.mjs",
          maxFiles: 1,
          ledgerPath: "heartbeat-one.md",
        },
      }),
    );
    // Keep these discovered ledgers unrelated to bounded-chat. The configured explicit
    // project source is intentionally separate, and the bounded scan must report its
    // incompleteness without turning this fixture into a genuine multi-association case.
    const boundedLedger = ambiguousLedger.replaceAll("ambiguous-chat", "bounded-chat");
    await writeFile(join(root, "heartbeat-bounded-a.md"), boundedLedger);
    await writeFile(join(root, "heartbeat-bounded-b.md"), boundedLedger);
    await assert.rejects(
      request(
        "initialize",
        {
          requestId: "bounded-init",
          expectedRevision: 0,
          title: "Wait for complete discovery",
          reason: "Bounded discovery is inconclusive",
          objectives: [{ id: "B1", title: "Do not create local scope" }],
        },
        "bounded-chat",
      ),
      hasCode("TASK_SOURCE_SELECTION_REQUIRED"),
    );
    const bounded = (await request("get", {}, "bounded-chat")).result as {
      task: TaskState | null;
      taskSource: { status: string; error?: string };
      heartbeat: {
        status: string;
        sourcePath: string | null;
        warning?: string;
        discoveryComplete?: boolean;
      };
    };
    assert.equal(bounded.task, null);
    assert.equal(bounded.taskSource.status, "pending-selection");
    assert.equal(bounded.heartbeat.discoveryComplete, false);
    assert.equal(bounded.heartbeat.status, "ready");
    assert.equal(bounded.heartbeat.sourcePath, await realpath(join(root, "heartbeat-one.md")));
    assert.ok(
      bounded.heartbeat.sourcePath,
      "project Heartbeat displays independently of ambiguous chat-task association",
    );
    assert.match(bounded.heartbeat.warning ?? "", /discovery was incomplete/);
    assert.match(bounded.taskSource.error ?? "", /incomplete/);
  } finally {
    projectReads.restore();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete discovery preserves known local history but still guards new and stale-source chats", async () => {
  const root = await mkdtemp("/tmp/ctph-incomplete-known-task-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  let call = 0;
  async function request(
    action: "get" | "initialize" | "update" | "history" | "bind-heartbeat",
    input: unknown,
    threadId = "known-local-chat",
  ) {
    const toolNames = {
      get: "task_progress_get",
      initialize: "task_progress_initialize",
      update: "task_progress_update",
      history: "task_progress_history",
      "bind-heartbeat": "task_progress_bind_heartbeat",
    } as const;
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: toolNames[action],
      identity: {
        threadId,
        sessionId: threadId,
        turnId: "turn-1",
        callId: `bounded-known-${++call}`,
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  const kitPath = join(root, "kit", "heartbeat-ledger-api.mjs");
  const configPath = join(root, ".codex-task-progress.json");
  const projectLedgerPath = join(root, "heartbeat-project.md");
  const boundLedgerPath = join(root, "heartbeat-bound.md");
  const ledger = (threadId: string, title: string) =>
    `# Supervision\nthread: ${threadId}\n## 2026-11-11T10:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| H1 | request | ${title} | pending | - |\n`;
  let helperStarted = false;
  const projectReads = trackProjectViewReads();
  try {
    await mkdir(join(root, "kit"), { recursive: true });
    await writeFile(
      kitPath,
      `export function inspectHeartbeatLedger(text,{mode}) {
        const lines=text.split('\\n');
        const headings=lines.filter(line=>/^#{1,6}\\s+.* wake \\(/i.test(line));
        const selected=mode==='history'?headings:headings.slice(-1);
        const wakes=selected.map((heading,index)=>({heading:heading.trim(),timeMs:1794391200000+index,line:lines.indexOf(heading)+1,rows:[]}));
        const items=lines.flatMap((line,index)=>{if(!/^\\| H/.test(line))return [];const cells=line.slice(1,-1).split('|').map(cell=>cell.trim());return [{id:cells[0],source:cells[1],item:cells[2],status:cells[3],evidence:cells[4],line:index+1}];});
        return {mode,certifiesCurrent:mode==='current',passed:true,wakeCount:wakes.length,itemCount:items.length,wakes,items,findings:[]};
      }`,
    );
    await writeFile(
      configPath,
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs" } }),
    );
    await helper.start();
    helperStarted = true;

    await request("initialize", {
      requestId: "known-init",
      expectedRevision: 0,
      title: "Known local task",
      reason: "Create durable local task history before bounded discovery",
      objectives: [{ id: "K1", title: "Known objective" }],
    });
    await request("update", {
      requestId: "known-active",
      expectedRevision: 1,
      reason: "Start the known task",
      changes: [{ targetId: "K1", status: "active" }],
    });
    await request(
      "initialize",
      {
        requestId: "bound-init",
        expectedRevision: 0,
        title: "Local task before source binding",
        reason: "Retain local events behind source authority",
        objectives: [{ id: "B1", title: "Dormant objective" }],
      },
      "invalid-bound-chat",
    );
    await writeFile(boundLedgerPath, ledger("invalid-bound-chat", "Bound source"));
    const bound = (await request("bind-heartbeat", { path: boundLedgerPath }, "invalid-bound-chat"))
      .result as { taskSource: { status: string; path?: string } };
    assert.equal(bound.taskSource.status, "ready");
    assert.equal(bound.taskSource.path, await realpath(boundLedgerPath));
    const canonicalBoundLedgerPath = bound.taskSource.path;

    const knownEventsBefore = await taskEvents(root, "known-local-chat");
    const boundEventsBefore = await taskEvents(root, "invalid-bound-chat");
    assert.equal(knownEventsBefore.length, 2);
    assert.equal(boundEventsBefore.length, 1);
    await helper.stop();
    helperStarted = false;

    await writeFile(projectLedgerPath, ledger("unrelated-project-chat", "Project Heartbeat"));
    await writeFile(
      configPath,
      JSON.stringify({
        heartbeat: {
          kitPath: "kit/heartbeat-ledger-api.mjs",
          maxFiles: 1,
          maxDepth: 0,
          ledgerPath: "heartbeat-project.md",
        },
      }),
    );
    helper = new GoalProgressHelper({
      paths,
      runtime: runtime(root),
      resolveNativeGoal: async () => null,
      visibleThreadRecoveryDelaysMs: [],
    });
    await helper.start();
    helperStarted = true;

    const known = (await getAfterProjectViewRefresh(() => request("get", {}), projectReads))
      .result as {
      task: TaskState | null;
      taskSource: unknown;
      heartbeat: {
        status: string;
        sourcePath: string | null;
        discoveryComplete?: boolean;
        warning?: string;
      };
    };
    assert.equal(known.task?.title, "Known local task");
    assert.equal(known.task?.revision, 2);
    assert.equal(known.taskSource, null);
    assert.equal(known.heartbeat.status, "ready");
    assert.equal(known.heartbeat.sourcePath, await realpath(projectLedgerPath));
    assert.equal(known.heartbeat.discoveryComplete, false);
    assert.match(known.heartbeat.warning ?? "", /discovery was incomplete/);
    const knownHistory = (await request("history", {}, "known-local-chat")).result as {
      history: { events: unknown[] };
    };
    assert.deepEqual(knownHistory.history.events, knownEventsBefore);
    assert.doesNotMatch(
      await readFile(
        eventPath(
          join(await realpath(root), ".workspace", "codex-task-progress"),
          "known-local-chat",
        ),
        "utf8",
      ),
      /source-binding/,
      "known local task history must not gain an inferred source binding",
    );
    const updated = (
      await request("update", {
        requestId: "known-blocked",
        expectedRevision: 2,
        reason: "Continue the known task despite incomplete discovery",
        changes: [{ targetId: "K1", status: "blocked" }],
      })
    ).result as TaskMutationResult;
    assert.equal(updated.state.revision, 3);
    const knownEventsAfter = await taskEvents(root, "known-local-chat");
    assert.equal(knownEventsAfter.length, 3);
    assert.deepEqual(knownEventsAfter.slice(1), knownEventsBefore);
    const historyAfterUpdate = (await request("history", {}, "known-local-chat")).result as {
      history: { events: unknown[] };
    };
    assert.deepEqual(historyAfterUpdate.history.events, knownEventsAfter);

    const freshChat = "new-incomplete-chat";
    const fresh = (await request("get", {}, freshChat)).result as {
      task: TaskState | null;
      taskSource: { status: string; error?: string };
    };
    assert.equal(fresh.task, null);
    assert.equal(fresh.taskSource.status, "pending-selection");
    assert.match(fresh.taskSource.error ?? "", /incomplete/);
    await assert.rejects(
      request(
        "initialize",
        {
          requestId: "fresh-init",
          expectedRevision: 0,
          title: "Must wait for complete discovery",
          reason: "Do not bypass incomplete source selection",
          objectives: [{ id: "N1", title: "New objective" }],
        },
        freshChat,
      ),
      hasCode("TASK_SOURCE_SELECTION_REQUIRED"),
    );
    await assert.rejects(
      access(eventPath(join(await realpath(root), ".workspace", "codex-task-progress"), freshChat)),
      { code: "ENOENT" },
    );

    await rm(boundLedgerPath);
    const invalidBound = (await request("get", {}, "invalid-bound-chat")).result as {
      task: TaskState | null;
      taskSource: { status: string; path?: string; error?: string; readOnly?: boolean };
    };
    assert.equal(invalidBound.task, null);
    assert.equal(invalidBound.taskSource.status, "stale");
    assert.equal(invalidBound.taskSource.path, canonicalBoundLedgerPath);
    assert.equal(invalidBound.taskSource.readOnly, true);
    assert.ok(invalidBound.taskSource.error);
    await assert.rejects(
      request(
        "update",
        {
          requestId: "invalid-source-update",
          expectedRevision: 1,
          reason: "Cannot update a task hidden by a stale source binding",
          changes: [{ targetId: "B1", status: "active" }],
        },
        "invalid-bound-chat",
      ),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
    const invalidHistory = (await request("history", {}, "invalid-bound-chat")).result as {
      history: { events: unknown[]; source: { error?: string; readOnly: boolean } };
    };
    assert.deepEqual(invalidHistory.history.events, []);
    assert.equal(invalidHistory.history.source.readOnly, true);
    assert.ok(invalidHistory.history.source.error);
    assert.deepEqual(await taskEvents(root, "invalid-bound-chat"), boundEventsBefore);
    assert.deepEqual(await taskEvents(root, "known-local-chat"), knownEventsAfter);
  } finally {
    projectReads.restore();
    if (helperStarted) await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic heartbeat authority stays latched through association loss and restart", async () => {
  const root = await mkdtemp("/tmp/ctph-heartbeat-latched-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  async function request(
    action: "initialize" | "update" | "get" | "history" | "bind-heartbeat" | "heartbeat-history",
    input: unknown,
    threadId = "sticky-chat",
  ) {
    const toolNames = {
      initialize: "task_progress_initialize",
      update: "task_progress_update",
      get: "task_progress_get",
      history: "task_progress_history",
      "bind-heartbeat": "task_progress_bind_heartbeat",
      "heartbeat-history": "task_progress_heartbeat_history",
    } as const;
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: toolNames[action],
      identity: {
        threadId,
        sessionId: threadId,
        turnId: "turn-1",
        callId: `sticky-${++call}`,
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  const original =
    "# Supervision\nthread: sticky-chat\n## 2026-11-11T10:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| H1 | request | Source task | blocked | Waiting |\n## 2026-11-11T11:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n";
  let reopened: GoalProgressHelper | undefined;
  let canonicalSourcePath: string | undefined;
  const projectReads = trackProjectViewReads();
  try {
    const localStore = new TaskStore(join(root, ".workspace", "codex-task-progress"));
    await localStore.initialize("sticky-chat", {
      requestId: "dormant",
      expectedRevision: 0,
      title: "Dormant",
      reason: "Keep prior local record",
      objectives: [{ id: "L1", title: "Local" }],
    });
    await mkdir(join(root, "kit"), { recursive: true });
    await writeFile(
      join(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs" } }),
    );
    await writeFile(
      join(root, "kit/heartbeat-ledger-api.mjs"),
      `export function inspectHeartbeatLedger(text,{mode}) { const lines=text.split('\\n'); const headings=lines.filter(line=>/^#{1,6}\\s+.* wake \\(/i.test(line)); const selected=mode==='history'?headings:headings.slice(-1); const wakes=selected.map((heading,index)=>({heading:heading.trim(),timeMs:1794304800000+index*86400000,line:lines.indexOf(heading)+1,rows:[{num:index?1:2,category:'task',state:index?'done':'active',line:lines.indexOf(heading)+2}]})); return { mode, certifiesCurrent:true, passed:true, wakes, items:[{id:"H1",source:"request",item:"Source task",status:"blocked",evidence:"Waiting",line:6}], findings:[]}; }`,
    );
    await writeFile(join(root, "heartbeat-A.md"), original);
    await writeFile(
      join(root, "heartbeat-B.md"),
      original.replace("sticky-chat", "unrelated-chat"),
    );
    await helper.start();
    const initial = (await getAfterProjectViewRefresh(() => request("get", {}), projectReads))
      .result as {
      taskSource: { status: string; path: string; historyPath?: string };
      heartbeat: { status: string; sourcePath: string | null; basis?: string };
    };
    assert.equal(initial.taskSource.status, "ready");
    assert.equal(initial.heartbeat.status, "ready");
    canonicalSourcePath = await realpath(join(root, "heartbeat-A.md"));
    assert.equal(initial.taskSource.path, canonicalSourcePath);
    assert.equal(initial.taskSource.historyPath, canonicalSourcePath);
    assert.equal(await readFile(canonicalSourcePath, "utf8"), original);
    await assert.rejects(access(join(root, "heartbeat-A.taskhistory.md")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(root, ".workspace", "codex-task-progress", ".gitignore"), "utf8"),
      "*\n",
    );
    const before = await taskEvents(root, "sticky-chat");
    const projectHistory = (await request("heartbeat-history", { limit: 1 })).result as {
      heartbeatHistory: { sourcePath: string | null };
    };
    assert.equal(projectHistory.heartbeatHistory.sourcePath, canonicalSourcePath);
    const firstAuditPage = (await request("history", { limit: 1 })).result as {
      history: {
        wakes: {
          heading: string;
          sourcePath: string;
          line: number;
          rows: { num: number; state: string; line: number; sourcePath: string }[];
        }[];
        nextCursor: string | null;
        total: number;
        source: { path: string; historyPath: string };
      };
    };
    assert.equal(firstAuditPage.history.total, 2);
    assert.match(firstAuditPage.history.wakes[0]?.heading ?? "", /2026-11-11T11:00:00Z wake/);
    assert.equal(firstAuditPage.history.wakes[0]?.sourcePath, canonicalSourcePath);
    assert.deepEqual(firstAuditPage.history.wakes[0]?.rows[0], {
      num: 1,
      category: "task",
      state: "done",
      line: firstAuditPage.history.wakes[0]?.line + 1,
      sourcePath: canonicalSourcePath,
    });
    assert.equal(firstAuditPage.history.source.path, canonicalSourcePath);
    assert.equal(firstAuditPage.history.source.historyPath, canonicalSourcePath);
    const expectedNewestLine =
      original.split("\n").findIndex((line) => line.includes("2026-11-11T11:00:00Z wake")) + 1;
    assert.equal(firstAuditPage.history.wakes[0]?.line, expectedNewestLine);
    assert.equal(await readFile(canonicalSourcePath, "utf8"), original);
    await assert.rejects(access(join(root, "heartbeat-A.taskhistory.md")), { code: "ENOENT" });
    const firstAuditCursor = firstAuditPage.history.nextCursor;
    assert.ok(firstAuditCursor);
    const secondAuditPage = (await request("history", { cursor: firstAuditCursor, limit: 1 }))
      .result as {
      history: { wakes: { heading: string }[]; nextCursor: string | null };
    };
    assert.match(secondAuditPage.history.wakes[0]?.heading ?? "", /2026-11-11T10:00:00Z wake/);
    assert.equal(secondAuditPage.history.nextCursor, null);
    const refreshedAudit = (await request("history", {})).result as {
      history: { wakes: { heading: string }[]; total: number };
    };
    assert.equal(refreshedAudit.history.total, 2);
    assert.match(refreshedAudit.history.wakes[0]?.heading ?? "", /2026-11-11T11:00:00Z wake/);
    await writeFile(join(root, "heartbeat-A.md"), original.replace("sticky-chat", "other-chat"));
    await writeFile(join(root, "heartbeat-C.md"), original);
    const stale = (await request("get", {})).result as {
      task: TaskState | null;
      taskSource: { status: string; path: string };
    };
    assert.equal(stale.task, null);
    assert.equal(stale.taskSource.status, "stale");
    assert.equal(stale.taskSource.path, canonicalSourcePath);
    const staleHistory = (await request("history", {})).result as {
      history: { events: unknown[]; wakes: unknown[]; source: { path: string; error?: string } };
    };
    assert.deepEqual(staleHistory.history.events, []);
    assert.deepEqual(staleHistory.history.wakes, []);
    assert.equal(staleHistory.history.source.path, canonicalSourcePath);
    assert.ok(staleHistory.history.source.error);
    await localStore.initialize("unresolved-chat", {
      requestId: "unresolved-local",
      expectedRevision: 0,
      title: "Keep a dormant local task",
      reason: "Preexisting ordinary task history",
      objectives: [{ id: "U1", title: "Local task" }],
    });
    const unresolvedEvents = await taskEvents(root, "unresolved-chat");
    const unrelatedCandidate = original.replaceAll("sticky-chat", "another-chat");
    await writeFile(join(root, "heartbeat-unrelated.md"), unrelatedCandidate);
    const unresolvedSource = (await request("get", {}, "unresolved-chat")).result as {
      taskSource: { status: string };
    };
    assert.equal(unresolvedSource.taskSource.status, "candidates");
    const unrelatedHistory = (await request("history", {}, "unresolved-chat")).result as {
      history: { events: unknown[] };
    };
    assert.equal(unrelatedHistory.history.events.length, 1);
    const pendingThreadId = "pending-history-chat";
    await localStore.initialize(pendingThreadId, {
      requestId: "pending-local",
      expectedRevision: 0,
      title: "Keep dormant history until source selection",
      reason: "Preexisting local task history",
      objectives: [{ id: "P1", title: "Local task" }],
    });
    const pendingEvents = await taskEvents(root, pendingThreadId);
    const ambiguousSource = original.replaceAll("sticky-chat", pendingThreadId);
    await writeFile(join(root, "heartbeat-pending-one.md"), ambiguousSource);
    await writeFile(join(root, "heartbeat-pending-two.md"), ambiguousSource);
    const pendingSource = (await request("get", {}, pendingThreadId)).result as {
      taskSource: { status: string };
    };
    assert.equal(pendingSource.taskSource.status, "pending-selection");
    const pendingHistory = (await request("history", {}, pendingThreadId)).result as {
      history: {
        events: unknown[];
        wakes: unknown[];
        source: { path: string | null; error?: string };
      };
    };
    assert.deepEqual(pendingHistory.history.events, []);
    assert.deepEqual(pendingHistory.history.wakes, []);
    assert.equal(pendingHistory.history.source.path, null);
    assert.ok(pendingHistory.history.source.error);
    assert.deepEqual(await taskEvents(root, "unresolved-chat"), unresolvedEvents);
    assert.deepEqual(await taskEvents(root, pendingThreadId), pendingEvents);
    await assert.rejects(
      request("initialize", {
        requestId: "parallel",
        expectedRevision: 0,
        title: "Forbidden",
        reason: "No duplicate checklist",
        objectives: [{ id: "X", title: "X" }],
      }),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
    await rm(join(root, "heartbeat-A.md"));
    await helper.stop();
    const restartHelper = new GoalProgressHelper({
      paths,
      runtime: runtime(root),
      resolveNativeGoal: async () => null,
      visibleThreadRecoveryDelaysMs: [],
    });
    reopened = restartHelper;
    await restartHelper.start();
    const afterRestart = (
      await client.request({
        method: "task.request",
        params: {
          action: "get",
          auth: {
            kind: "codex-request",
            toolName: "task_progress_get",
            identity: {
              threadId: "sticky-chat",
              sessionId: "sticky-chat",
              turnId: "turn-2",
              callId: `sticky-${++call}`,
              model: "test",
              threadSource: "user",
              cwd: root,
            },
          },
          input: {},
        },
      })
    ).result as { task: TaskState | null; taskSource: { status: string; path: string } };
    assert.equal(afterRestart.task, null);
    assert.equal(afterRestart.taskSource.status, "stale");
    assert.equal(afterRestart.taskSource.path, canonicalSourcePath);
    assert.deepEqual(await taskEvents(root, "sticky-chat"), before);
    await rm(join(root, ".workspace", "codex-task-progress", ".gitignore"));
    await writeFile(
      join(root, "heartbeat-fresh.md"),
      original.replaceAll("sticky-chat", "fresh-chat"),
    );
    type FreshResult = {
      task: (TaskState & { source?: { kind: string; path: string; readOnly: boolean } }) | null;
      taskSource: { status: string };
    };
    let fresh: FreshResult | undefined;
    // The recursive watcher may deliver the newly created source after the first
    // read. Wait for the observable association, never for a fixed time interval.
    const deadline = Date.now() + 5_000;
    for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt += 1) {
      fresh = (await request("get", {}, "fresh-chat")).result as FreshResult;
      if (fresh.taskSource.status === "ready") break;
      assert.equal(fresh.taskSource.status, "candidates");
      assert.equal(fresh.task, null);
    }
    assert.equal(fresh?.task?.source?.kind, "kit-heartbeat");
    assert.equal(fresh?.task?.source?.readOnly, true);
    assert.equal(fresh?.task?.source?.path, await realpath(join(root, "heartbeat-fresh.md")));
    assert.equal(fresh?.taskSource.status, "ready");
    assert.deepEqual(await taskEvents(root, "fresh-chat"), []);
    assert.equal(
      await readFile(join(root, ".workspace", "codex-task-progress", ".gitignore"), "utf8"),
      "*\n",
    );
    await restartHelper.stop();
  } finally {
    projectReads.restore();
    await reopened?.stop();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed checklist does not imply runtime completion when a later turn is active or unavailable", async () => {
  const root = await mkdtemp("/tmp/ctph-execution-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  let status: CodexThreadIdentity["status"] = { type: "idle" };
  const mocked = runtime(root);
  mocked.readThreadIdentity = async (threadId) => ({ ...identity(threadId, root), status });
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const cdp = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "cdp" });
  let callNumber = 0;
  async function request(action: "get" | "initialize", input: unknown) {
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: `task_progress_${action}`,
      identity: {
        threadId: "ordinary-chat",
        sessionId: "ordinary-chat",
        turnId: "turn-1",
        callId: `execution-${++callNumber}`,
        model: "test",
        threadSource: "user",
        cwd: root,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  type ObservedTask = {
    task: TaskState;
    execution: { state: string; source: string; activeFlags?: string[] };
    completionBasis: string;
  };
  try {
    await helper.start();
    await request("initialize", {
      requestId: "registered-checklist-done",
      expectedRevision: 0,
      title: "Previous delivery",
      reason: "Record completed and verified work",
      objectives: [
        {
          id: "C1",
          title: "Verified item",
          status: "completed",
          evidence: [{ summary: "Meaningful test passed", verification: "verified", kind: "test" }],
        },
      ],
    });
    const initial = (await request("get", {})).result as ObservedTask;
    assert.equal(initial.task.progress.percent, 100);
    assert.equal(initial.task.phase, "completed");
    assert.equal(initial.execution.state, "idle");
    const originalRevision = initial.task.revision;

    // A later turn is working, but has not written or rescoped the checklist yet.
    status = { type: "active", activeFlags: [] };
    const active = (await request("get", {})).result as ObservedTask;
    assert.equal(active.task.revision, originalRevision);
    assert.equal(active.task.progress.percent, 100);
    assert.equal(active.execution.state, "working");
    assert.equal(active.execution.source, "codex-app-server");
    assert.equal(active.completionBasis, "registered-checklist");
    const panelActive = (
      await cdp.request({
        method: "task.view",
        params: { action: "get", threadId: "ordinary-chat" },
      })
    ).result as ObservedTask;
    assert.equal(panelActive.task.revision, originalRevision);
    assert.equal(panelActive.execution.state, "working");
    assert.equal(panelActive.completionBasis, "registered-checklist");

    // App-server notLoaded is not positive evidence that the UI's running turn finished.
    status = { type: "notLoaded" };
    const unavailable = (await request("get", {})).result as ObservedTask;
    assert.equal(unavailable.task.revision, originalRevision);
    assert.equal(unavailable.task.progress.percent, 100);
    assert.equal(unavailable.execution.state, "unknown");
    assert.equal(unavailable.completionBasis, "registered-checklist");
    const panelUnknown = (
      await cdp.request({
        method: "task.view",
        params: { action: "get", threadId: "ordinary-chat" },
      })
    ).result as ObservedTask;
    assert.equal(panelUnknown.execution.state, "unknown");
    assert.equal(panelUnknown.task.revision, originalRevision);
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Helper migrates only the trusted chat's legacy record into its workspace and retains source history", async () => {
  const root = await mkdtemp("/tmp/ctph-migrate-");
  const workspaceCwd = join(root, "project");
  await mkdir(join(workspaceCwd, ".git"), { recursive: true });
  const paths = resolveGoalProgressPaths({ root: join(root, "app-data") });
  const legacy = new TaskStore(paths.root);
  const initialized = await legacy.initialize("legacy-chat", {
    requestId: "legacy-init",
    expectedRevision: 0,
    reason: "Prior plugin version",
    title: "Legacy work",
    objectives: [{ id: "L1", title: "Verify migration" }],
  });
  await legacy.update("legacy-chat", {
    requestId: "legacy-complete",
    expectedRevision: initialized.state.revision,
    reason: "Existing meaningful evidence",
    changes: [
      {
        targetId: "L1",
        status: "completed",
        evidence: [{ summary: "Existing test passed", verification: "verified", kind: "test" }],
      },
    ],
  });
  await legacy.initialize("unrelated-chat", {
    requestId: "unrelated-init",
    expectedRevision: 0,
    reason: "Other chat must stay separate",
    title: "Other work",
    objectives: [{ id: "O1", title: "Unrelated delivery" }],
  });
  const legacyEvents = (await legacy.history("legacy-chat", { limit: 100 })).events;
  const expectedHistory = await legacy.history("legacy-chat", { limit: 100 });
  const expectedTask = await legacy.get("legacy-chat");
  const legacyBytes = `${[...legacyEvents]
    .reverse()
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;
  await writeFile(legacyEventPath(paths.root, "legacy-chat"), legacyBytes);
  await rm(eventPath(paths.root, "legacy-chat"));
  await rm(
    join(
      paths.root,
      "tasks",
      "v3",
      createHash("sha256").update("legacy-chat").digest("hex"),
      "heartbeat.md",
    ),
  );
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(workspaceCwd),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  async function request(action: "get" | "history", input: unknown) {
    const auth: GoalProgressIpcAuthorization = {
      kind: "codex-request",
      toolName: `task_progress_${action}`,
      identity: {
        threadId: "legacy-chat",
        sessionId: "legacy-chat",
        turnId: "turn-1",
        callId: `migrate-${++call}`,
        model: "test",
        threadSource: "user",
        cwd: workspaceCwd,
      },
    };
    return client.request({ method: "task.request", params: { action, auth, input } });
  }
  try {
    await helper.start();
    // Business payload paths cannot override the verified app-server working directory.
    const forgedCwd = join(root, "forged-project");
    const migrated = (await request("get", { cwd: forgedCwd })).result as {
      task: TaskState;
      storage: StorageDescriptor;
    };
    const workspaceRoot = join(await realpath(workspaceCwd), ".workspace", "codex-task-progress");
    assert.equal(migrated.storage.mode, "workspace");
    assert.equal(migrated.storage.root, workspaceRoot);
    assert.equal(migrated.task.revision, 2);
    assert.equal(migrated.task.progress.percent, 100);
    assert.deepEqual(migrated.task, expectedTask);
    const history = (await request("history", { limit: 100 })).result as {
      history: TaskHistoryPage;
    };
    assert.deepEqual(history.history, expectedHistory);
    assert.ok(
      (await readFile(eventPath(workspaceRoot, "legacy-chat"), "utf8")).includes(
        '"requestId": "legacy-init"',
      ),
    );
    assert.equal(await readFile(legacyEventPath(paths.root, "legacy-chat"), "utf8"), legacyBytes);
    await assert.rejects(access(eventPath(workspaceRoot, "unrelated-chat")), { code: "ENOENT" });
    await assert.rejects(access(join(forgedCwd, ".workspace", "codex-task-progress")), {
      code: "ENOENT",
    });
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});
const startupExecutablePath = "/Applications/Codex.app/Contents/MacOS/Codex";
const startupAppPath = "/Applications/Codex.app";
const startupStartedAt = "2026-11-13T12:00:00.000Z";
const startupPort = 9222;

function startupEvent(_command: string, pid = 4242): MacosCodexStartupEvent {
  return {
    schemaVersion: 1,
    event: "codex.willLaunch",
    pid,
    bundleId: "com.openai.codex",
    appPath: startupAppPath,
    executablePath: startupExecutablePath,
    launchedAt: startupStartedAt,
    deadlineAtMs: Date.parse(startupStartedAt) + 30_000,
  };
}

function startupAppIdentity() {
  return {
    appPath: startupAppPath,
    realAppPath: startupAppPath,
    executablePath: startupExecutablePath,
    realExecutablePath: startupExecutablePath,
    bundleId: "com.openai.codex",
    teamId: "7P5S3ZLCN7",
    version: "1.0",
  } as const;
}

function startupProcessSnapshot(pid: number, command: string, start = startupStartedAt) {
  return { pid, parentPid: 1, startedAt: start, command };
}

function startupOwnership(
  pid: number,
  command: string,
  start = startupStartedAt,
): CodexCdpListenerOwnership {
  return {
    mainProcess: startupProcessSnapshot(pid, command, start),
    listeners: [{ pid: pid + 1, commandName: "Codex Helper", address: `127.0.0.1:${startupPort}` }],
    listenerPids: [pid + 1],
  };
}

function startupController(
  root: string,
  overrides: Partial<ConstructorParameters<typeof MacosStartupHandoffController>[0]> = {},
) {
  const paths = resolveGoalProgressPaths({ root });
  let signals = 0;
  let launches = 0;
  let allocations = 0;
  let writes = 0;
  const instance = new MacosStartupHandoffController({
    paths,
    inspectApp: async () => startupAppIdentity() as never,
    inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, startupExecutablePath),
    listMainProcesses: async () => [],
    readRuntimeState: async () => {
      throw new Error("ENOENT");
    },
    verifyExistingOwnership: async (_app, pid) => startupOwnership(pid, startupExecutablePath),
    allocatePort: async () => {
      allocations += 1;
      return startupPort;
    },
    launchWithCdp: async () => {
      launches += 1;
      throw new Error("unexpected launch");
    },
    waitForOwnership: async () => startupOwnership(4242, startupExecutablePath),
    createRuntimeState: () => ({}) as CodexCdpRuntimeState,
    writeRuntimeState: async () => {
      writes += 1;
    },
    signalProcess: () => {
      signals += 1;
    },
    now: () => Date.parse(startupStartedAt) + 1,
    sleep: async () => undefined,
    ...overrides,
  });
  return {
    instance,
    paths,
    counts: () => ({ signals, launches, allocations, writes }),
  };
}

test("ordinary task recovery makes startup eligible without creating task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const paths = resolveGoalProgressPaths({ root });
    let detections = 0;
    assert.equal(
      await hasRecoverableStartupProgress(paths, {
        async hasRecoverableTasks() {
          detections += 1;
          return true;
        },
      }),
      true,
    );
    assert.equal(detections, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Helper startup handler admits a real ordinary task without restarting Codex", async () => {
  const root = await mkdtemp("/tmp/ctph-startup-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  assert.ok(
    paths.helperSocketPath.length < 100,
    `Helper IPC socket path exceeds the macOS UNIX socket path limit: ${paths.helperSocketPath}`,
  );
  let startupHandler:
    | ((event: MacosCodexStartupEvent) => Promise<MacosCodexStartupResponse>)
    | undefined;
  const startupListener = {
    start(handler: typeof startupHandler) {
      startupHandler = handler;
    },
    health: () => ({ running: true, ready: true, pid: 1, pendingPid: 4242 }),
    isPending: (pid: number) => pid === 4242,
    waitUntilReady: async () => true,
    stop: async () => undefined,
  };
  const setup = startupController(paths.root);
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
    startupListener: startupListener as never,
    startupHandoff: setup.instance,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  try {
    await helper.start();
    await client.request({
      method: "task.request",
      params: {
        action: "initialize",
        auth: {
          kind: "codex-request",
          toolName: "task_progress_initialize",
          identity: {
            threadId: "startup-ordinary-chat",
            sessionId: "startup-ordinary-chat",
            turnId: "turn-1",
            callId: "startup-init",
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
        input: {
          requestId: "startup-init",
          expectedRevision: 0,
          title: "Recover ordinary task",
          reason: "User requested recovery",
          objectives: [{ id: "C1", title: "Build" }],
        },
      },
    });
    assert.ok(startupHandler);
    const response = await startupHandler(startupEvent(startupExecutablePath));
    assert.equal(response.code, "STARTUP_HANDOFF_PENDING_CDP_UNAVAILABLE");
    assert.equal(response.action, "continue");
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("eligible ordinary tasks never kill or relaunch Codex when no verified CDP exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const { instance, counts } = startupController(root);
    const response = await instance.handle(startupEvent(startupExecutablePath), true);
    assert.equal(response.code, "STARTUP_HANDOFF_PENDING_CDP_UNAVAILABLE");
    assert.deepEqual(counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid CDP startup is reattached and runtime identity is rebuilt from verified ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, pid, requestedPort) => {
        assert.equal(requestedPort, startupPort);
        return startupOwnership(pid, command);
      },
    });
    const response = await setup.instance.handle(startupEvent(command), true);
    assert.equal(response.action, "continue");
    assert.equal(response.code, "STARTUP_EVENT_EXISTING_CDP");
    assert.equal(response.mainPid, 4242);
    assert.equal(response.port, startupPort);
    assert.ok(response.launchId);
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CDP command with stale process ownership fails closed without side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, pid) =>
        startupOwnership(pid, command, "2026-11-13T11:00:00.000Z"),
    });
    const response = await setup.instance.handle(startupEvent(command), true);
    assert.equal(response.code, "STARTUP_EVENT_PENDING_CDP_UNAVAILABLE");
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("superseded CDP ownership check returns continue and does not rewrite runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    let releaseOwnership: ((value: CodexCdpListenerOwnership) => void) | undefined;
    let ownershipStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      ownershipStarted = resolveStarted;
    });
    let verifyCount = 0;
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, _pid) => {
        if (verifyCount++ > 0) throw new Error("no second verified CDP owner");
        ownershipStarted?.();
        return new Promise<CodexCdpListenerOwnership>((resolveOwnership) => {
          releaseOwnership = resolveOwnership;
        });
      },
    });
    const first = setup.instance.handle(startupEvent(command), true);
    await started;
    await setup.instance.handle(startupEvent(startupExecutablePath, 4243), true);
    releaseOwnership?.(startupOwnership(4242, command));
    const response = await first;
    assert.equal(response.action, "continue");
    assert.equal(response.code, "STARTUP_EVENT_RELEASED");
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopped Helper during CDP ownership check returns continue without runtime writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    let releaseOwnership: ((value: CodexCdpListenerOwnership) => void) | undefined;
    let ownershipStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      ownershipStarted = resolveStarted;
    });
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, _pid) => {
        ownershipStarted?.();
        return new Promise<CodexCdpListenerOwnership>((resolveOwnership) => {
          releaseOwnership = resolveOwnership;
        });
      },
    });
    let stopped = false;
    const pending = setup.instance.handle(startupEvent(command), true, {
      isPending: () => true,
      isStopped: () => stopped,
    });
    await started;
    stopped = true;
    releaseOwnership?.(startupOwnership(4242, command));
    const response = await pending;
    assert.equal(response.action, "continue");
    assert.equal(response.code, "STARTUP_EVENT_RELEASED");
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed CDP startup retries after the listener becomes ready without restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    let ready = false;
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, pid) => {
        if (!ready) throw new Error("listener not ready");
        return startupOwnership(pid, command);
      },
    });
    const event = { ...startupEvent(command), event: "codex.didLaunch" as const };
    assert.equal(
      (await setup.instance.handle(event, true)).code,
      "STARTUP_EVENT_PENDING_CDP_UNAVAILABLE",
    );
    ready = true;
    assert.equal(
      (await setup.instance.retryObservedStartup(event, () => true)).code,
      "STARTUP_EVENT_EXISTING_CDP",
    );
    assert.deepEqual(setup.counts(), { signals: 0, launches: 0, allocations: 0, writes: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed startup retry rejects cancellation and changed process identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    let start = startupStartedAt;
    const event = { ...startupEvent(command), event: "codex.didLaunch" as const };
    // Simulate a listener that becomes unavailable during the initial observation.
    const unavailable = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command, start),
      verifyExistingOwnership: async () => {
        throw new Error("not ready");
      },
    });
    assert.equal(
      (await unavailable.instance.handle(event, true)).code,
      "STARTUP_EVENT_PENDING_CDP_UNAVAILABLE",
    );
    assert.equal(
      (await unavailable.instance.retryObservedStartup(event, () => false)).code,
      "STARTUP_EVENT_RELEASED",
    );
    start = "2026-11-13T12:00:01.000Z";
    assert.equal(
      (await unavailable.instance.retryObservedStartup(event, () => true)).code,
      "STARTUP_EVENT_PROCESS_MISMATCH",
    );
    assert.deepEqual(unavailable.counts(), { signals: 0, launches: 0, allocations: 0, writes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForStartupTest(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for startup recovery");
}

async function startupHelperFixture(options: {
  readonly verify: (pid: number, command: string) => Promise<ReturnType<typeof startupOwnership>>;
  readonly delays?: readonly number[];
  readonly visibleDelays?: readonly number[];
  readonly recoverTargets?: () => Promise<readonly { targetId: string; threadId: string | null }[]>;
}) {
  const root = await mkdtemp("/tmp/ctph-startup-wiring-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
  let handler: ((event: MacosCodexStartupEvent) => Promise<MacosCodexStartupResponse>) | undefined;
  let reconnects = 0;
  const setup = startupController(paths.root, {
    inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
    verifyExistingOwnership: async (_app, pid) => options.verify(pid, command),
  });
  const listener = {
    start(value: typeof handler) {
      handler = value;
    },
    health: () => ({ running: true, ready: true, pid: 1, pendingPid: 4242 }),
    isPending: () => true,
    waitUntilReady: async () => true,
    stop: async () => undefined,
  };
  const sink = {
    clear: async () => undefined,
    clearTarget: async () => undefined,
    publish: async () => undefined,
    publishTarget: async () => undefined,
    hasTarget: () => true,
    setTargetThread: async () => undefined,
    reconnect: async () => {
      reconnects += 1;
      return undefined;
    },
    recoverVisibleTargets: async () =>
      reconnects === 0 ? [] : ((await options.recoverTargets?.()) ?? []),
  };
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: options.visibleDelays ?? [],
    startupReattachDelaysMs: options.delays ?? [1, 1],
    startupListener: listener as never,
    startupHandoff: setup.instance,
    viewModelSink: sink,
  });
  try {
    await helper.start();
    const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
    await client.request({
      method: "task.request",
      params: {
        action: "initialize",
        auth: {
          kind: "codex-request",
          toolName: "task_progress_initialize",
          identity: {
            threadId: "startup-chat",
            sessionId: "startup-chat",
            turnId: "turn-1",
            callId: "startup-init",
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
        input: {
          requestId: "startup-init",
          expectedRevision: 0,
          title: "Recover",
          reason: "Requested",
          objectives: [{ id: "C1", title: "Build" }],
        },
      },
    });
    assert.ok(handler);
    const onStartup = handler;
    return {
      root,
      paths,
      helper,
      setup,
      command,
      reconnects: () => reconnects,
      fire: (pid = 4242) => onStartup({ ...startupEvent(command, pid), event: "codex.didLaunch" }),
      close: async () => {
        await helper.stop();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("startup handoff dispatch does not wait for observational log persistence", async () => {
  let dispatch!: () => void;
  const dispatched = new Promise<void>((resolveDispatch) => {
    dispatch = resolveDispatch;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const fixture = await startupHelperFixture({
    verify: async (pid, command) => {
      dispatch();
      return startupOwnership(pid, command);
    },
  });
  const originalWrite = GoalProgressLogger.prototype.write;
  let observationBlocked = false;
  GoalProgressLogger.prototype.write = async function (input) {
    if (input.event === "startup.event") {
      observationBlocked = true;
      await gate;
    }
    return originalWrite.call(this, input);
  };
  let response: Promise<MacosCodexStartupResponse> | undefined;
  try {
    response = fixture.fire();
    await dispatched;
    assert.equal(observationBlocked, true);
  } finally {
    release();
    GoalProgressLogger.prototype.write = originalWrite;
    try {
      await response;
    } finally {
      await fixture.close();
    }
  }
});

test("Helper retries delayed CDP and reconnects visible targets", async () => {
  let attempts = 0;
  let targetReads = 0;
  const fixture = await startupHelperFixture({
    verify: async (pid, command) => {
      attempts += 1;
      if (attempts < 2) throw new Error("not listening yet");
      return startupOwnership(pid, command);
    },
    visibleDelays: [1, 1],
    recoverTargets: async () => {
      targetReads += 1;
      // Startup and handoff both initially see no renderer; the scheduled retry finds it.
      return targetReads < 2 ? [] : [{ targetId: "window", threadId: "startup-chat" }];
    },
  });
  try {
    assert.equal((await fixture.fire()).code, "STARTUP_EVENT_PENDING_CDP_UNAVAILABLE");
    await waitForStartupTest(() => fixture.reconnects() === 1 && targetReads >= 2);
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.setup.counts(), {
      signals: 0,
      launches: 0,
      allocations: 0,
      writes: 1,
    });
  } finally {
    await fixture.close();
  }
});

test("Helper bounds unavailable CDP retries without a restart", async () => {
  let attempts = 0;
  const fixture = await startupHelperFixture({
    verify: async () => {
      attempts += 1;
      throw new Error("not ready");
    },
  });
  try {
    await fixture.fire();
    await waitForStartupTest(() => attempts === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempts, 3);
    assert.equal(fixture.reconnects(), 0);
    assert.deepEqual(fixture.setup.counts(), {
      signals: 0,
      launches: 0,
      allocations: 0,
      writes: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("Helper stop and newer observations cancel pending CDP reattachment", async () => {
  const inspected: number[] = [];
  const fixture = await startupHelperFixture({
    delays: [60],
    verify: async (pid) => {
      inspected.push(pid);
      throw new Error("not ready");
    },
  });
  try {
    await fixture.fire(4242);
    await fixture.fire(4243);
    await waitForStartupTest(() => inspected.length === 3);
    assert.deepEqual(inspected, [4242, 4243, 4243]);
    await fixture.fire(4244);
    await fixture.helper.stop();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.deepEqual(inspected, [4242, 4243, 4243, 4244]);
    assert.deepEqual(fixture.setup.counts(), {
      signals: 0,
      launches: 0,
      allocations: 0,
      writes: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("multi-target handoff retries a transient visible-thread restore failure", async () => {
  let targetReads = 0;
  let stateBlocker = "";
  const fixture = await startupHelperFixture({
    verify: async (pid, command) => startupOwnership(pid, command),
    visibleDelays: [1, 1],
    recoverTargets: async () => {
      targetReads += 1;
      if (targetReads === 2) await rm(stateBlocker);
      return [{ targetId: "window", threadId: "transient-chat" }];
    },
  });
  try {
    await mkdir(fixture.paths.stateRoot, { recursive: true });
    stateBlocker = join(
      fixture.paths.stateRoot,
      createHash("sha256").update("transient-chat").digest("hex"),
    );
    // A file at the session-directory path makes the first restore fail with a store I/O error.
    await writeFile(stateBlocker, "temporary");
    assert.equal((await fixture.fire()).code, "STARTUP_EVENT_EXISTING_CDP");
    await waitForStartupTest(() => targetReads >= 2);
    await waitForStartupTest(
      async () => (await stat(stateBlocker).catch(() => undefined))?.isDirectory() === true,
    );
    await waitForStartupTest(() => fixture.reconnects() === 1);
    assert.deepEqual(fixture.setup.counts(), {
      signals: 0,
      launches: 0,
      allocations: 0,
      writes: 1,
    });
  } finally {
    await fixture.close();
  }
});

function legacyListenerChild(failWrite = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    exitCode: number | null;
    signalCode: string | null;
    kill: (signal: string) => boolean;
  };
  let suspended = false;
  const actions: string[] = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (failWrite) {
        callback(new Error("broken pipe"));
        return;
      }
      const response = JSON.parse(chunk.toString()) as { action: string };
      actions.push(response.action);
      if (response.action === "continue") suspended = false;
      callback();
    },
    final(callback) {
      // Legacy Swift resumes on stdin EOF.
      suspended = false;
      callback();
    },
  });
  child.kill = (signal) => {
    // Legacy Swift catches SIGTERM and resumes its pending process before exiting.
    if (signal === "SIGTERM") suspended = false;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close"));
    return true;
  };
  return {
    child,
    actions,
    suspended: () => suspended,
    ready: () =>
      child.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, event: "listener.ready", pid: 99 })}\n`,
      ),
    launch: (deadlineAtMs: number) => {
      suspended = true;
      child.stdout.write(
        `${JSON.stringify({ ...startupEvent(startupExecutablePath), deadlineAtMs })}\n`,
      );
    },
  };
}

test("supervisor releases a legacy suspended launch on continue, failure, timeout, stop and write failure", async () => {
  for (const scenario of ["continue", "failure", "timeout", "stop", "write-failure"] as const) {
    const fake = legacyListenerChild(scenario === "write-failure");
    let supervisorSignals = 0;
    const supervisor = new MacosStartupListenerSupervisor({
      executablePath: "/fake/listener",
      bundleId: "com.openai.codex",
      appPath: startupAppPath,
      appExecutablePath: startupExecutablePath,
      spawnProcess: (() => fake.child) as never,
      restartDelaysMs: [],
      signalProcess: () => {
        supervisorSignals += 1;
      },
    });
    supervisor.start(async (event) => {
      if (scenario === "timeout" || scenario === "stop") return new Promise(() => undefined);
      if (scenario === "failure") throw new Error("handler failed");
      return { schemaVersion: 1, pid: event.pid, action: "continue", code: "TEST" };
    });
    fake.ready();
    await waitForStartupTest(() => supervisor.health().ready);
    fake.launch(Date.now() + (scenario === "timeout" ? 20 : 1_000));
    await waitForStartupTest(() => supervisor.isPending(4242) || !fake.suspended());
    if (scenario === "stop") await supervisor.stop();
    await waitForStartupTest(() => !fake.suspended());
    if (scenario === "continue" || scenario === "failure" || scenario === "timeout") {
      assert.deepEqual(fake.actions, ["continue"], scenario);
    }
    assert.equal(supervisorSignals, 0, scenario);
    await supervisor.stop();
  }
});

test("multi-target recovery retries unknown thread identity and stops after bounded exhaustion", async () => {
  for (const becomesKnown of [true, false]) {
    let reads = 0;
    const fixture = await startupHelperFixture({
      verify: async (pid, command) => startupOwnership(pid, command),
      visibleDelays: [1, 1],
      recoverTargets: async () => {
        reads += 1;
        return [{ targetId: "window", threadId: becomesKnown && reads >= 3 ? "known-chat" : null }];
      },
    });
    try {
      assert.equal((await fixture.fire()).code, "STARTUP_EVENT_EXISTING_CDP");
      await waitForStartupTest(() => reads === 3);
      if (becomesKnown) {
        const directory = join(
          fixture.paths.stateRoot,
          createHash("sha256").update("known-chat").digest("hex"),
        );
        await waitForStartupTest(
          async () => (await stat(directory).catch(() => undefined))?.isDirectory() === true,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(reads, 3);
      assert.deepEqual(fixture.setup.counts(), {
        signals: 0,
        launches: 0,
        allocations: 0,
        writes: 1,
      });
    } finally {
      await fixture.close();
    }
  }
});

test("Helper remains ready and task IPC works through stale renderer bootstrap, then recovers", async () => {
  for (const failure of [
    "target-discovery",
    "target-initialize",
    "target-activation",
    "thread-discovery",
  ] as const) {
    const root = await mkdtemp("/tmp/ctph-renderer-offline-");
    await mkdir(join(root, ".git"));
    const paths = resolveGoalProgressPaths({ root: join(root, "data") });
    let available = false;
    let lookups = 0;
    let signals = 0;
    let listenerStarted = false;
    const missing = () => {
      throw new Error("GOAL_PROGRESS_CDP_PROCESS_LOOKUP_FAILED");
    };
    const sink = {
      clear: async () => undefined,
      publish: async () => undefined,
      ...(failure === "thread-discovery"
        ? {
            recoverVisibleThreadId: async () => {
              lookups += 1;
              return available ? "recovered-chat" : missing();
            },
          }
        : {
            clearTarget: async () => undefined,
            publishTarget: async () => undefined,
            setTargetThread: async () => undefined,
            hasTarget: () => (failure === "target-activation" && !available ? missing() : true),
            recoverVisibleTargets: async () => {
              lookups += 1;
              if (
                !available &&
                (failure === "target-discovery" ||
                  (failure === "target-initialize" && lookups >= 2))
              )
                return missing();
              return failure === "target-activation" || available
                ? [{ targetId: "window", threadId: "recovered-chat" }]
                : [];
            },
          }),
    };
    const helper = new GoalProgressHelper({
      paths,
      runtime: runtime(root),
      resolveNativeGoal: async () => null,
      viewModelSink: sink,
      visibleThreadRecoveryDelaysMs: Array.from({ length: 10 }, () => 100),
      startupListener: {
        start: () => {
          listenerStarted = true;
        },
        health: () => ({ running: true, ready: true, pid: 1, pendingPid: null }),
        isPending: () => false,
        canReplaceStartingApp: async () => false,
        waitUntilReady: async () => true,
        stop: async () => undefined,
      },
      startupHandoff: startupController(paths.root, {
        signalProcess: () => {
          signals += 1;
        },
      }).instance,
    });
    const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
    let call = 0;
    const request = (action: "get" | "initialize" | "history", input: unknown) =>
      client.request({
        method: "task.request",
        params: {
          action,
          auth: {
            kind: "codex-request",
            toolName: `task_progress_${action}`,
            identity: {
              threadId: "ordinary-chat",
              sessionId: "ordinary-chat",
              turnId: "turn-1",
              callId: `call-${++call}`,
              model: "test",
              threadSource: "user",
              cwd: root,
            },
          },
          input,
        },
      });
    try {
      await helper.start();
      assert.equal(listenerStarted, true, failure);
      const ping = await client.request({ method: "ping", params: {} });
      assert.equal((ping.result as { ready: boolean }).ready, true, failure);
      assert.equal(((await request("get", {})).result as { task: unknown }).task, null);
      await request("initialize", {
        requestId: "init",
        expectedRevision: 0,
        title: "Offline task",
        reason: "Requested",
        objectives: [{ id: "C1", title: "Build" }],
      });
      assert.equal(
        ((await request("get", {})).result as { task: TaskState }).task.title,
        "Offline task",
      );
      const history = (await request("history", {})).result as { history: TaskHistoryPage };
      assert.equal(history.history.events.length, 1);
      available = true;
      const recoveredDirectory = join(
        paths.stateRoot,
        createHash("sha256").update("recovered-chat").digest("hex"),
      );
      await waitForStartupTest(
        async () => (await stat(recoveredDirectory).catch(() => undefined))?.isDirectory() === true,
      );
      const laterPing = await client.request({ method: "ping", params: {} });
      assert.equal(
        (laterPing.result as { instanceId: string }).instanceId,
        (ping.result as { instanceId: string }).instanceId,
      );
      assert.equal(signals, 0);
      assert.equal(
        ((await request("history", {})).result as { history: TaskHistoryPage }).history.events
          .length,
        1,
      );
    } finally {
      await helper.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("task mutation forces discovery before writing a local checklist", async () => {
  const root = await mkdtemp("/tmp/ctph-force-source-");
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "kit"));
  await writeFile(
    join(root, "kit", "heartbeat-ledger-api.mjs"),
    `export function inspectHeartbeatLedger(text,{mode}) { return {mode,certifiesCurrent:true,passed:true,wakes:[],items:[],tables:[],findings:[]}; }`,
  );
  await writeFile(
    join(root, ".codex-task-progress.json"),
    JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs" } }),
  );
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    visibleThreadRecoveryDelaysMs: [],
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const original = HeartbeatService.prototype.taskProjection;
  const originalDiscover = HeartbeatDiscoveryIndex.prototype.discover;
  const originalGeneration = HeartbeatDiscoveryIndex.prototype.generation;
  let holdEvents = false;
  let staleDiscovery: Awaited<ReturnType<typeof originalDiscover>> | undefined;
  let shadowGeneration: number | null = null;
  HeartbeatDiscoveryIndex.prototype.discover = async function (options, context) {
    if (holdEvents && !context?.force && staleDiscovery) return staleDiscovery;
    const report = await originalDiscover.call(this, options, context);
    if (!holdEvents && report.candidates.length === 0 && report.indexGeneration !== undefined) {
      staleDiscovery = report;
      shadowGeneration = report.indexGeneration;
    }
    if (holdEvents && context?.force) shadowGeneration = report.indexGeneration ?? null;
    return report;
  };
  HeartbeatDiscoveryIndex.prototype.generation = function (projectRoot) {
    return holdEvents
      ? Promise.resolve(shadowGeneration)
      : originalGeneration.call(this, projectRoot);
  };
  const forced: boolean[] = [];
  HeartbeatService.prototype.taskProjection = function (threadId, cwd, options) {
    forced.push(options?.forceDiscovery === true);
    return original.call(this, threadId, cwd, options);
  };
  let call = 0;
  const request = (action: "get" | "initialize" | "update", input: unknown) =>
    client.request({
      method: "task.request",
      params: {
        action,
        input,
        auth: {
          kind: "codex-request",
          toolName: `task_progress_${action}`,
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: `force-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  try {
    await helper.start();
    await request("initialize", {
      requestId: "initial",
      expectedRevision: 0,
      title: "Local",
      reason: "Initial local task",
      objectives: [{ id: "I1", title: "One" }],
    });
    await request("get", {});
    assert.ok(staleDiscovery);
    holdEvents = true;
    await writeFile(
      join(root, "heartbeat.md"),
      "## Items\n| id | source | item | status | evidence |\n| -- | -- | -- | -- | -- |\n| H1 | request | canonical | pending | - |\nthread: chat-A\n",
    );
    const cached = (await request("get", {})).result as { task: TaskState | null };
    assert.equal(cached.task?.title, "Local");
    await assert.rejects(
      request("update", {
        requestId: "blocked",
        expectedRevision: 1,
        reason: "Should use source",
        changes: [{ targetId: "I1", status: "active" }],
      }),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
    assert.equal(forced.at(-1), true);
  } finally {
    HeartbeatService.prototype.taskProjection = original;
    HeartbeatDiscoveryIndex.prototype.discover = originalDiscover;
    HeartbeatDiscoveryIndex.prototype.generation = originalGeneration;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("two fresh ordinary launches within cooldown each hand off once", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  let originalAlive = true;
  let originalPid = 4242;
  let launches = 0;
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    const options: Partial<ConstructorParameters<typeof MacosStartupHandoffController>[0]> = {
      inspectTargetProcess: async (pid) => {
        if (pid === originalPid && !originalAlive) throw new Error("exited");
        return startupProcessSnapshot(pid, pid === originalPid ? startupExecutablePath : command);
      },
      signalProcess: (_pid, signal) => {
        if (signal === "SIGTERM") originalAlive = false;
      },
      launchWithCdp: async () => {
        launches += 1;
        return { pid: originalPid + 1, processStartedAt: startupStartedAt, command } as never;
      },
      waitForOwnership: async () => startupOwnership(originalPid + 1, command),
      createRuntimeState: () =>
        ({
          mainPid: originalPid + 1,
          port: startupPort,
          launchId: "00000000-0000-4000-8000-000000000001",
        }) as CodexCdpRuntimeState,
    };
    const event = { ...startupEvent(startupExecutablePath), event: "codex.didLaunch" as const };
    const context = {
      isPending: () => true,
      allowRestart: true,
      restartStillAllowedNow: () => true,
      canReplaceStartingApp: async () => true,
    };
    const first = startupController(root, options);
    assert.equal(
      (await first.instance.handle(event, true, context)).code,
      "STARTUP_HANDOFF_COMPLETE",
    );
    assert.equal(
      (await first.instance.handle(event, true, context)).code,
      "STARTUP_HANDOFF_COMPLETE",
    );
    originalPid = 4244;
    originalAlive = true;
    const second = startupController(root, options);
    assert.equal(
      (await second.instance.handle({ ...event, pid: originalPid }, true, context)).code,
      "STARTUP_HANDOFF_COMPLETE",
    );
    assert.equal(launches, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("denied native proof releases only its own reservation for next fresh launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  let alive = true;
  let launches = 0;
  try {
    const command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    const options: Partial<ConstructorParameters<typeof MacosStartupHandoffController>[0]> = {
      inspectTargetProcess: async (pid) => {
        if (pid === 4244 && !alive) throw new Error("exited");
        return startupProcessSnapshot(pid, pid === 4245 ? command : startupExecutablePath);
      },
      signalProcess: (_pid, signal) => {
        if (signal === "SIGTERM") alive = false;
      },
      launchWithCdp: async () => {
        launches += 1;
        return { pid: 4245, processStartedAt: startupStartedAt, command } as never;
      },
      waitForOwnership: async () => startupOwnership(4245, command),
      createRuntimeState: () =>
        ({
          mainPid: 4245,
          port: startupPort,
          launchId: "00000000-0000-4000-8000-000000000001",
        }) as CodexCdpRuntimeState,
    };
    const event = { ...startupEvent(startupExecutablePath), event: "codex.didLaunch" as const };
    const first = startupController(root, options);
    assert.equal(
      (
        await first.instance.handle(event, true, {
          isPending: () => true,
          allowRestart: true,
          restartStillAllowedNow: () => true,
          canReplaceStartingApp: async () => false,
        })
      ).code,
      "STARTUP_RECOVERY_ACTIVITY_UNVERIFIED",
    );
    assert.equal(launches, 0);
    const second = startupController(root, options);
    assert.equal(
      (
        await second.instance.handle({ ...event, pid: 4244 }, true, {
          isPending: () => true,
          allowRestart: true,
          restartStillAllowedNow: () => true,
          canReplaceStartingApp: async () => true,
        })
      ).code,
      "STARTUP_HANDOFF_COMPLETE",
    );
    assert.equal(launches, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic recovery rejects late, synthetic, active, disabled, and changed processes", async () => {
  for (const scenario of ["late", "will-launch", "activity", "disabled", "changed"] as const) {
    const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
    let inspections = 0;
    try {
      const setup = startupController(root, {
        now: () => Date.parse(startupStartedAt) + (scenario === "late" ? 6_000 : 1),
        inspectTargetProcess: async (pid) =>
          startupProcessSnapshot(
            pid,
            scenario === "changed" && ++inspections > 1
              ? `${startupExecutablePath} --new-argument`
              : startupExecutablePath,
          ),
      });
      const event = {
        ...startupEvent(startupExecutablePath),
        event:
          scenario === "will-launch" ? ("codex.willLaunch" as const) : ("codex.didLaunch" as const),
      };
      const response = await setup.instance.handle(event, true, {
        isPending: () => true,
        allowRestart: true,
        restartStillAllowedNow: () => true,
        restartStillAllowed: async () => scenario !== "disabled",
        hasObservedTaskActivity: () => scenario === "activity",
      });
      assert.ok(
        [
          "STARTUP_RECOVERY_EXPIRED",
          "STARTUP_RECOVERY_ACTIVITY",
          "STARTUP_RECOVERY_DISABLED",
          "STARTUP_RECOVERY_ACTIVITY_UNVERIFIED",
          "STARTUP_EVENT_PROCESS_MISMATCH",
        ].includes(response.code),
        `${scenario}: ${response.code}`,
      );
      assert.equal(setup.counts().signals, 0, scenario);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("failed automatic launch restores normal Codex and blocks immediate repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  let originalAlive = true;
  let normalLaunches = 0;
  try {
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => {
        if (!originalAlive) throw new Error("exited");
        return startupProcessSnapshot(pid, startupExecutablePath);
      },
      signalProcess: (_pid, signal) => {
        if (signal === "SIGTERM") originalAlive = false;
      },
      launchNormal: async () => {
        normalLaunches += 1;
      },
    });
    const event = { ...startupEvent(startupExecutablePath), event: "codex.didLaunch" as const };
    assert.equal(
      (
        await setup.instance.handle(event, true, {
          isPending: () => true,
          allowRestart: true,
          restartStillAllowedNow: () => true,
          canReplaceStartingApp: async () => true,
        })
      ).code,
      "STARTUP_HANDOFF_FALLBACK_NORMAL",
    );
    assert.equal(normalLaunches, 1);
    const next = startupController(root);
    assert.equal(
      (
        await next.instance.handle({ ...event, pid: 4244 }, true, {
          isPending: () => true,
          allowRestart: true,
          restartStillAllowedNow: () => true,
        })
      ).code,
      "STARTUP_RECOVERY_COOLDOWN",
    );
    assert.equal(next.counts().signals, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native replacement proof binds listener generation, pid, deadline and fresh acknowledgement", async () => {
  for (const scenario of [
    "allowed",
    "finished",
    "has-window",
    "wrong-pid",
    "stale",
    "late",
    "child-restart",
  ] as const) {
    const fake = legacyListenerChild();
    let inspect: { requestId: string; pid: number; deadlineAtMs: number } | undefined;
    fake.child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString());
        if (message.event === "startup.inspect-replacement") inspect = message;
        callback();
      },
    });
    const supervisor = new MacosStartupListenerSupervisor({
      executablePath: "/fake/listener",
      bundleId: "com.openai.codex",
      appPath: startupAppPath,
      appExecutablePath: startupExecutablePath,
      spawnProcess: (() => fake.child) as never,
      restartDelaysMs: [],
    });
    let result: boolean | undefined;
    supervisor.start(async (event) => {
      result = await supervisor.canReplaceStartingApp(event);
      return { schemaVersion: 1, pid: event.pid, action: "continue", code: "TEST" };
    });
    try {
      fake.ready();
      await waitForStartupTest(() => supervisor.health().ready);
      fake.launch(Date.now() + 2_000);
      await waitForStartupTest(() => inspect !== undefined);
      if (scenario === "child-restart") {
        fake.child.emit("close");
      } else {
        const observed = inspect as
          | { requestId: string; pid: number; deadlineAtMs: number }
          | undefined;
        assert.ok(observed);
        if (scenario === "late") await new Promise((resolveDelay) => setTimeout(resolveDelay, 320));
        fake.child.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            event: "startup.replacement-check",
            requestId: observed.requestId,
            pid: scenario === "wrong-pid" ? observed.pid + 1 : observed.pid,
            allowed: scenario !== "finished" && scenario !== "has-window",
            checkedAtMs: Date.now() - (scenario === "stale" ? 200 : 0),
            reason: scenario,
          })}\n`,
        );
      }
      await waitForStartupTest(() => result !== undefined);
      assert.equal(result, scenario === "allowed", scenario);
    } finally {
      await supervisor.stop();
    }
  }
});

test("disabling startup recovery while native proof is pending prevents signalling", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  let requestProof!: () => void;
  let releaseProof!: () => void;
  const requested = new Promise<void>((resolveRequested) => {
    requestProof = resolveRequested;
  });
  const gate = new Promise<void>((resolveGate) => {
    releaseProof = resolveGate;
  });
  let enabled = true;
  try {
    const setup = startupController(root);
    const pending = setup.instance.handle(
      { ...startupEvent(startupExecutablePath), event: "codex.didLaunch" },
      true,
      {
        isPending: () => true,
        allowRestart: true,
        restartStillAllowed: async () => true,
        restartStillAllowedNow: () => enabled,
        canReplaceStartingApp: async () => {
          requestProof();
          await gate;
          return true;
        },
      },
    );
    await requested;
    enabled = false;
    releaseProof();
    assert.equal((await pending).code, "STARTUP_RECOVERY_DISABLED");
    assert.equal(setup.counts().signals, 0);
  } finally {
    releaseProof();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop and supersession after original exit restore a usable app and drain recovery", async () => {
  for (const scenario of ["stop", "supersede"] as const) {
    const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
    let signalled!: () => void;
    let releaseExit!: () => void;
    const signalledGate = new Promise<void>((resolveSignal) => {
      signalled = resolveSignal;
    });
    const exitGate = new Promise<void>((resolveExit) => {
      releaseExit = resolveExit;
    });
    let stopped = false;
    let alive = true;
    let restores = 0;
    try {
      const setup = startupController(root, {
        inspectTargetProcess: async (pid) => {
          if (pid === 4242 && !alive) {
            await exitGate;
            throw new Error("exited");
          }
          return startupProcessSnapshot(pid, startupExecutablePath);
        },
        signalProcess: () => {
          alive = false;
          signalled();
        },
        launchNormal: async () => {
          restores += 1;
        },
      });
      const event = { ...startupEvent(startupExecutablePath), event: "codex.didLaunch" as const };
      const pending = setup.instance.handle(event, true, {
        isPending: () => true,
        isStopped: () => stopped,
        allowRestart: true,
        restartStillAllowedNow: () => true,
        canReplaceStartingApp: async () => true,
      });
      await signalledGate;
      if (scenario === "stop") stopped = true;
      else await setup.instance.handle({ ...event, pid: 4244 }, false);
      let drained = false;
      const idle = setup.instance.whenIdle().then(() => {
        drained = true;
      });
      await Promise.resolve();
      assert.equal(drained, false);
      releaseExit();
      assert.equal((await pending).code, "STARTUP_HANDOFF_FALLBACK_NORMAL");
      await idle;
      assert.equal(restores, 1);
      assert.equal(setup.counts().launches, 0);
    } finally {
      releaseExit();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("failed willLaunch observation does not suppress didLaunch CDP reattachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-progress-startup-"));
  try {
    let command = `${startupExecutablePath} --unsupported`;
    const setup = startupController(root, {
      inspectTargetProcess: async (pid) => startupProcessSnapshot(pid, command),
      verifyExistingOwnership: async (_app, pid) => startupOwnership(pid, command),
    });
    const will = startupEvent(startupExecutablePath);
    assert.equal((await setup.instance.handle(will, true)).code, "STARTUP_EVENT_PROCESS_MISMATCH");
    command = `${startupExecutablePath} --remote-debugging-port=${startupPort}`;
    assert.equal(
      (await setup.instance.handle({ ...will, event: "codex.didLaunch" }, true)).code,
      "STARTUP_EVENT_EXISTING_CDP",
    );
    assert.equal(setup.counts().signals, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cheap Helper ping follows late startup listener readiness without requiring CDP", async () => {
  const { inspectInstalledHelperReadiness } = await import(
    "../../../platform/macos/src/installed-inspection.js"
  );
  const root = await mkdtemp("/tmp/ctph-listener-readiness-");
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  let listenerReady = false;
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
    startupListener: {
      start: () => undefined,
      health: () => ({ running: true, ready: listenerReady, pid: 42, pendingPid: null }),
      isPending: () => false,
      canReplaceStartingApp: async () => false,
      waitUntilReady: async () => false,
      stop: async () => undefined,
    },
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "doctor" });
  try {
    await helper.start();
    const pending = await client.request({ method: "ping", params: {} });
    assert.deepEqual((pending.result as { startupListener: unknown }).startupListener, {
      running: true,
      ready: false,
    });
    assert.equal((await inspectInstalledHelperReadiness(paths)).ready, false);
    listenerReady = true;
    const ready = await inspectInstalledHelperReadiness(paths);
    assert.equal(ready.pingOk, true);
    assert.equal(ready.ready, true);
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});
