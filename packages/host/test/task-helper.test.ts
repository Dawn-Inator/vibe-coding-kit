import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServerRuntime, CodexThreadIdentity } from "../../codex-adapter/src/index.js";
import { GoalProgressIpcClient, GoalProgressIpcClientError } from "../../ipc/src/index.js";
import type {
  GoalProgressIpcAuthorization,
  GoalProgressIpcRequestInput,
} from "../../ipc/src/protocol.js";
import { resolveGoalProgressPaths } from "../../store/src/index.js";
import type { TaskHistoryPage, TaskMutationResult, TaskState } from "../../tasks/src/index.js";
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
    assert.deepEqual(empty.result, { task: null, heartbeat: null });
    const initialized = await request("initialize", {
      requestId: "init",
      expectedRevision: 0,
      title: "Deliver ordinary task",
      reason: "User requested implementation",
      objectives: [{ id: "C1", title: "Deliver", items: [{ id: "C1.1", title: "Build" }] }],
    });
    assert.equal((initialized.result as TaskMutationResult).state.progress.percent, 0);
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
    const restored = (await request("get", {})).result as { task: TaskState };
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
