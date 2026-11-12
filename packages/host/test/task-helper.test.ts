import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServerRuntime, CodexThreadIdentity } from "../../codex-adapter/src/index.js";
import { GoalProgressIpcClient, GoalProgressIpcClientError } from "../../ipc/src/index.js";
import type {
  GoalProgressIpcAuthorization,
  GoalProgressIpcRequestInput,
} from "../../ipc/src/protocol.js";
import { resolveGoalProgressPaths } from "../../store/src/index.js";
import {
  type TaskHistoryPage,
  type TaskMutationResult,
  type TaskState,
  TaskStore,
} from "../../tasks/src/index.js";
import { GoalProgressHelper } from "../src/index.js";

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
    "events.jsonl",
  );
}
function hasCode(code: string) {
  return (error: unknown) => error instanceof GoalProgressIpcClientError && error.code === code;
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
    const empty = await request("get", {});
    const emptyState = empty.result as {
      task: TaskState | null;
      heartbeat: unknown;
      execution: { state: string; source: string; observedAt: string };
      completionBasis: string;
      storage: StorageDescriptor;
    };
    assert.equal(emptyState.task, null);
    assert.equal(emptyState.heartbeat, null);
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
    assert.equal(JSON.parse(recordedEvents.trim()).requestId, "init");
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
  const legacyBytes = await readFile(eventPath(paths.root, "legacy-chat"), "utf8");
  const expectedHistory = await legacy.history("legacy-chat", { limit: 100 });
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
    assert.deepEqual(migrated.task, await legacy.get("legacy-chat"));
    const history = (await request("history", { limit: 100 })).result as {
      history: TaskHistoryPage;
    };
    assert.deepEqual(history.history, expectedHistory);
    assert.equal(await readFile(eventPath(workspaceRoot, "legacy-chat"), "utf8"), legacyBytes);
    assert.equal(await readFile(eventPath(paths.root, "legacy-chat"), "utf8"), legacyBytes);
    await assert.rejects(access(eventPath(workspaceRoot, "unrelated-chat")), { code: "ENOENT" });
    await assert.rejects(access(join(forgedCwd, ".workspace", "codex-task-progress")), {
      code: "ENOENT",
    });
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});
