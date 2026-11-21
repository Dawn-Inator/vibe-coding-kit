import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  migrateHeartbeatLedgerPair,
  readHeartbeatLedgerPair,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs";
import { projectAgentTaskProgress } from "vibe-coding-kit/src/tasks/agent-task-associations.mjs";
import {
  HeartbeatDiscoveryIndex,
  HeartbeatDiscoveryInvalidatedError,
} from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import type { TaskHistorySummaryPage as KitTaskHistorySummaryPage } from "vibe-coding-kit/src/tasks/task-contract.mjs";
import { TaskStore as KitTaskStore } from "vibe-coding-kit/src/tasks/task-store.mjs";
import type { CodexAppServerRuntime, CodexThreadIdentity } from "../../codex-adapter/src/index.js";
import {
  GoalProgressIpcClient,
  GoalProgressIpcClientError,
  TASK_PROGRESS_REQUEST_TIMEOUT_MS,
} from "../../ipc/src/index.js";
import {
  type GoalProgressIpcAuthorization,
  type GoalProgressIpcRequestInput,
  GoalProgressIpcRequestSchema,
} from "../../ipc/src/protocol.js";
import { resolveGoalProgressPaths } from "../../store/src/index.js";
import { HeartbeatService } from "../../tasks/src/heartbeat.js";
import {
  type TaskCloseoutReceipt,
  type TaskEvidence,
  type TaskHistoryPage,
  type TaskMutationResult,
  type TaskState,
  TaskStore,
} from "../../tasks/src/index.js";
import { GoalProgressSessionCoordinator } from "../src/helper-session-coordinator.js";
import {
  assignmentProjectionAgents,
  GoalProgressHelper,
  overlayAgentAssignment,
} from "../src/index.js";

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
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let callNumber = 0;
  const request = (
    action: "get" | "initialize" | "update" | "history" | "archive" | "complete",
    threadId = "disabled-chat",
  ) =>
    client.request({
      method: "task.request",
      params: {
        action,
        auth: {
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
    assert.deepEqual((await request("archive")).result, {
      enabled: false,
      task: null,
      heartbeat: null,
    });
    await assert.rejects(request("complete"), hasCode("TASK_PROGRESS_DISABLED"));
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
    let visibleError:
      | {
          heartbeat: { status: string; error?: string } | null;
          taskSource: unknown;
          heartbeatPending?: boolean;
          task: TaskState | null;
        }
      | undefined;
    const errorDeadline = Date.now() + 2_000;
    for (let attempt = 0; attempt < 50 && Date.now() < errorDeadline; attempt += 1) {
      await refreshDone;
      visibleError = (await request("get", {})).result as typeof visibleError;
      assert.equal(visibleError?.task?.title, "Local checklist");
      if (visibleError?.heartbeat?.status === "error") break;
    }
    assert.equal(visibleError?.heartbeat?.status, "error");
    assert.match(visibleError?.heartbeat?.error ?? "", /heartbeat-unrelated/i);
    assert.deepEqual(visibleError?.taskSource, { status: "candidates", readOnly: true });
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
type TaskHistorySummaryPage = {
  events: Array<{
    revision: number;
    kind: string;
    occurredAt: string;
    reason: string;
    reasonTruncated: boolean;
    before: { completed: number; total: number; percent: number | null } | null;
    after: { completed: number; total: number; percent: number | null };
  }>;
  nextCursor: string | null;
  canonicalHistoryPath: string;
};

function assertHistorySummary(
  event: TaskHistorySummaryPage["events"][number] | undefined,
  expected: Omit<TaskHistorySummaryPage["events"][number], "occurredAt" | "reasonTruncated">,
) {
  assert.ok(event);
  assert.deepEqual(Object.keys(event).sort(), [
    "after",
    "before",
    "kind",
    "occurredAt",
    "reason",
    "reasonTruncated",
    "revision",
  ]);
  assert.equal(Number.isNaN(Date.parse(event.occurredAt)), false);
  assert.equal(event.reasonTruncated, false);
  assert.equal(event.revision, expected.revision);
  assert.equal(event.kind, expected.kind);
  assert.equal(event.reason, expected.reason);
  assert.deepEqual(event.before, expected.before);
  assert.deepEqual(event.after, expected.after);
}

async function taskEvents(root: string, threadId: string) {
  const store = new TaskStore(join(root, ".workspace", "codex-task-progress"));
  return (await store.history(threadId, { limit: 100 })).events;
}

async function seedDormantArchive(store: TaskStore, threadId: string) {
  const proof: TaskEvidence[] = [
    { summary: "Verified", verification: "verified", reference: "test:dormant" },
  ];
  const check: TaskCloseoutReceipt["branch"] = { status: "done", evidence: proof };
  const closeout: TaskCloseoutReceipt = {
    branch: check,
    merge: check,
    push: check,
    remainingWork: 0,
    ownerActions: 0,
    auditEvidence: proof,
  };
  await store.initialize(threadId, {
    requestId: "seed",
    expectedRevision: 0,
    lifecycle: true,
    title: "Secret archived task",
    reason: "Seed",
    objectives: [
      { id: "old", title: "Secret archived objective", status: "completed", evidence: proof },
    ],
  });
  await store.complete(threadId, {
    requestId: "seed-close",
    expectedRevision: 1,
    reason: "Delivered",
    closeout,
  });
  await store.rescope(threadId, {
    requestId: "seed-next",
    expectedRevision: 2,
    reason: "Next",
    objectives: [{ id: "new", title: "Current" }],
  });
  assert.equal((await store.archives(threadId)).total, 1);
  return closeout;
}

test("real Helper IPC supports ordinary task completion, regression, pagination, isolated chats and restart", async () => {
  const root = await mkdtemp("/tmp/ctph-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const options = {
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  };
  let helper = new GoalProgressHelper(options);
  let callNumber = 0;
  const projectReads = trackProjectViewReads();
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  async function request(
    action: "get" | "initialize" | "update" | "rescope" | "history" | "complete" | "archive",
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
        { targetId: "C1", status: "completed" },
        {
          targetId: "C1.1",
          status: "completed",
          evidence: [{ summary: "Build succeeded", verification: "verified", kind: "build" }],
        },
      ],
    });
    const done = (completed.result as TaskMutationResult).state;
    assert.equal(done.progress.percent, 50);
    const proof = [
      { summary: "Verified delivery", verification: "verified", reference: "test:delivery" },
    ];
    const check = { status: "done", evidence: proof };
    const closeout = {
      branch: check,
      merge: check,
      push: check,
      remainingWork: 0,
      ownerActions: 0,
      auditEvidence: proof,
    };
    for (const invalid of [
      { ...closeout, remainingWork: 1 },
      { ...closeout, ownerActions: 1 },
      { ...closeout, auditEvidence: [{ ...proof[0], verification: "reported" }] },
    ]) {
      await assert.rejects(
        request("complete", {
          requestId: `invalid-${JSON.stringify(invalid)}`,
          expectedRevision: 2,
          reason: "Close",
          closeout: invalid,
        }),
      );
    }
    await assert.rejects(
      request("complete", {
        requestId: "stale-close",
        expectedRevision: 1,
        reason: "Close",
        closeout,
      }),
    );
    const closeInput = { requestId: "close", expectedRevision: 2, reason: "Delivered", closeout };
    const closed = (await request("complete", closeInput)).result as TaskMutationResult;
    assert.equal(closed.state.progress.percent, 100);
    assert.equal(
      ((await request("complete", closeInput)).result as TaskMutationResult).duplicate,
      true,
    );
    await assert.rejects(
      request("update", {
        requestId: "closed-update",
        expectedRevision: 3,
        reason: "Late change",
        changes: [{ targetId: "C1.1", status: "pending" }],
      }),
    );
    const expanded = await request("rescope", {
      requestId: "expand",
      expectedRevision: 3,
      reason: "User added delivery verification",
      objectives: [...done.objectives, { id: "C2", title: "Verify delivery" }],
    });
    assert.equal((expanded.result as TaskMutationResult).state.progress.percent, 0);
    assert.deepEqual(
      (expanded.result as TaskMutationResult).state.objectives.map((objective) => objective.id),
      ["C2"],
    );
    const archive = (await request("archive", { limit: 1 })).result as {
      archive: { total: number; tasks: Array<{ id: string }>; currentTaskId: string };
    };
    assert.equal(archive.archive.total, 1);
    const detail = (await request("archive", { taskId: archive.archive.tasks[0]?.id, limit: 1 }))
      .result as { archive: { nodes: unknown[]; nextCursor: string | null; totalNodes: number } };
    assert.equal(detail.archive.nodes.length, 1);
    assert.ok(detail.archive.nextCursor);
    assert.equal(detail.archive.totalNodes, 2);
    const detailNext = (
      await request("archive", {
        taskId: archive.archive.tasks[0]?.id,
        limit: 1,
        cursor: detail.archive.nextCursor,
      })
    ).result as { archive: { nodes: unknown[] } };
    assert.equal(detailNext.archive.nodes.length, 1);
    await assert.rejects(
      request(
        "archive",
        { taskId: archive.archive.tasks[0]?.id, cursor: detail.archive.nextCursor },
        "another-chat",
      ),
    );
    assert.equal((expanded.result as TaskMutationResult).state.phase, "active");
    const history = await request("history", { limit: 1 });
    const page = (history.result as { history: TaskHistoryPage }).history;
    assert.equal(page.events[0]?.before?.percent, 100);
    assert.equal(page.events[0]?.after.percent, 0);
    assert.equal(page.events[0]?.reason, "User added delivery verification");
    assert.ok(page.nextCursor);
    const older = await request("history", { cursor: page.nextCursor, limit: 2 });
    assert.deepEqual(
      (older.result as { history: TaskHistoryPage }).history.events.map((event) => event.revision),
      [3, 2],
    );
    const otherChat = (await request("get", {}, "another-chat")).result as {
      task: TaskState | null;
    };
    assert.equal(otherChat.task, null);
    await request(
      "initialize",
      {
        requestId: "in-cycle-init",
        expectedRevision: 0,
        title: "In-cycle scope",
        reason: "Start",
        objectives: [{ id: "A", title: "First" }],
      },
      "scope-chat",
    );
    const scopeProof = [{ summary: "Verified", verification: "verified", reference: "test:scope" }];
    const scopeDone = (
      await request(
        "update",
        {
          requestId: "in-cycle-done",
          expectedRevision: 1,
          reason: "Verified",
          changes: [{ targetId: "A", status: "completed", evidence: scopeProof }],
        },
        "scope-chat",
      )
    ).result as TaskMutationResult;
    assert.equal(scopeDone.state.progress.percent, 50);
    const scopeExpanded = (
      await request(
        "rescope",
        {
          requestId: "in-cycle-add",
          expectedRevision: 2,
          reason: "More work",
          objectives: [...scopeDone.state.objectives, { id: "B", title: "Second" }],
        },
        "scope-chat",
      )
    ).result as TaskMutationResult;
    assert.equal(scopeExpanded.state.progress.total, 3);
    assert.ok((scopeExpanded.state.progress.percent ?? 100) < 50);
    await assert.rejects(
      request(
        "complete",
        { requestId: "open-close", expectedRevision: 3, reason: "Premature", closeout },
        "scope-chat",
      ),
      hasCode("TASK_OPEN_WORK"),
    );
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
    assert.equal(restored.task.revision, 4);
    assert.equal(restored.task.progress.percent, 0);
    assert.equal(
      ((await request("archive", {})).result as { archive: { total: number } }).archive.total,
      1,
    );
    const duplicate = await request("rescope", {
      requestId: "expand",
      expectedRevision: 3,
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

test("authorized task requests read the exact thread once per request", async () => {
  const root = await mkdtemp("/tmp/ctph-auth-read-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const mocked = runtime(root);
  let reads = 0;
  mocked.readThreadIdentity = async (threadId) => {
    reads++;
    return identity(threadId, root);
  };
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  try {
    await helper.start();
    for (const callId of ["first", "second"]) {
      await client.request({
        method: "task.request",
        params: {
          action: "get",
          auth: {
            kind: "codex-request",
            toolName: "task_progress_get",
            identity: {
              threadId: "chat",
              sessionId: "chat",
              turnId: "turn",
              callId,
              model: "test",
              threadSource: "user",
              cwd: root,
            },
          },
          input: {},
        },
      });
    }
    assert.equal(reads, 2);
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex authorization does not wait for or fail on informational logging", async () => {
  for (const log of [
    () => new Promise<void>(() => {}),
    async () => {
      throw new Error("log failed");
    },
  ]) {
    let reads = 0;
    const coordinator = new GoalProgressSessionCoordinator({
      store: null as never,
      resolveNativeGoal: async () => null,
      resolveCurrentThread: async () => {
        throw new Error("unexpected hook resolution");
      },
      readThreadIdentity: async (threadId) => {
        reads++;
        return identity(threadId, "/tmp");
      },
      consumeRuntimeProof: async () => false,
      log,
    });
    const auth = {
      kind: "codex-request" as const,
      toolName: "task_progress_get",
      identity: {
        threadId: "chat",
        sessionId: "chat",
        turnId: "turn",
        callId: "call",
        model: "test",
        threadSource: "user" as const,
        cwd: "/tmp",
      },
    } satisfies GoalProgressIpcAuthorization;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        coordinator.authorizeSessionRequestWithThread(auth),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("logging blocked authorization")), 500);
        }),
      ]);
      assert.equal(result.thread?.status.type, "idle");
      assert.equal(reads, 1);
      await assert.rejects(coordinator.authorizeSessionRequest(auth), {
        code: "CODEX_REQUEST_REPLAYED",
      });
      await assert.rejects(
        coordinator.authorizeSessionRequest(
          { ...auth, identity: { ...auth.identity, callId: "bad" } },
          "different",
        ),
        { code: "THREAD_MISMATCH" },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
});

test("Codex authorization still rejects conflicting and untrusted thread records", async () => {
  const base = identity("chat", "/tmp");
  const cases: Array<[Partial<CodexThreadIdentity>, string]> = [
    [{ id: "other" }, "CODEX_REQUEST_IDENTITY_CONFLICT"],
    [{ sessionId: "other" }, "CODEX_REQUEST_IDENTITY_CONFLICT"],
    [{ cwd: "/other" }, "CODEX_REQUEST_IDENTITY_CONFLICT"],
    [{ threadSource: "system" }, "CODEX_REQUEST_IDENTITY_CONFLICT"],
    [{ threadSource: null }, "CODEX_REQUEST_IDENTITY_CONFLICT"],
    [{ agentRole: "worker" }, "CODEX_REQUEST_THREAD_UNTRUSTED"],
    [{ ephemeral: true }, "CODEX_REQUEST_THREAD_UNTRUSTED"],
  ];
  for (const [change, code] of cases) {
    const coordinator = new GoalProgressSessionCoordinator({
      store: null as never,
      resolveNativeGoal: async () => null,
      resolveCurrentThread: async () => {
        throw new Error("unexpected hook resolution");
      },
      readThreadIdentity: async () => ({ ...base, ...change }),
      consumeRuntimeProof: async () => false,
      log: async () => {},
    });
    const auth = {
      kind: "codex-request" as const,
      toolName: "task_progress_get",
      identity: {
        threadId: "chat",
        sessionId: "chat",
        turnId: "turn",
        callId: "call",
        model: "test",
        threadSource: "user" as const,
        cwd: "/tmp",
      },
    } satisfies GoalProgressIpcAuthorization;
    await assert.rejects(coordinator.authorizeSessionRequest(auth), { code });
    await assert.rejects(coordinator.authorizeSessionRequest(auth), {
      code: "CODEX_REQUEST_REPLAYED",
    });
  }
});

test("child task authorization accepts native null source and role only after direct ancestry checks", async () => {
  for (const nativeSessionId of ["child", "parent"]) {
    for (const requestSessionId of ["child", "parent"]) {
      for (const role of ["worker", null, undefined]) {
        const child = {
          ...identity("child", "/tmp"),
          sessionId: nativeSessionId,
          threadSource: role === "worker" ? "subagent" : null,
          agentRole: role ?? null,
          path: "/tmp/child.jsonl",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent",
                depth: 1,
                ...(role === undefined ? {} : { agent_role: role }),
              },
            },
          },
        };
        const reads: string[] = [];
        const coordinator = new GoalProgressSessionCoordinator({
          store: null as never,
          resolveNativeGoal: async () => null,
          resolveCurrentThread: async () => {
            throw new Error("unexpected hook resolution");
          },
          readThreadIdentity: async (threadId) => {
            reads.push(threadId);
            return threadId === "child" ? child : identity(threadId, "/tmp");
          },
          consumeRuntimeProof: async () => false,
          log: async () => {},
        });
        const result = await coordinator.authorizeTaskRequest({
          kind: "codex-request",
          toolName: "task_progress_get",
          identity: {
            threadId: "child",
            sessionId: requestSessionId,
            turnId: "turn",
            callId: "call",
            model: "test",
            threadSource: "subagent",
            cwd: "/tmp",
            parentThreadId: "parent",
            ...(role == null ? {} : { agentRole: role }),
          },
        });
        assert.equal(result.identity.threadId, "child");
        assert.deepEqual(reads, ["child", "parent"]);
      }
    }
  }
});

test("native null child labels cannot bypass source, role, parent, or task-only authorization", async () => {
  const source = (parent = "parent", role: string | null = null, depth = 1) => ({
    subAgent: { thread_spawn: { parent_thread_id: parent, depth, agent_role: role } },
  });
  const child = {
    ...identity("child", "/tmp"),
    threadSource: null,
    agentRole: null,
    path: "/tmp/child.jsonl",
    source: source(),
  };
  const request = {
    threadId: "child",
    sessionId: "child",
    turnId: "turn",
    callId: "call",
    model: "test",
    threadSource: "subagent" as const,
    cwd: "/tmp",
    parentThreadId: "parent",
  };
  const cases: Array<{
    child?: Partial<CodexThreadIdentity>;
    request?: Partial<typeof request> & { agentRole?: string };
    parent?: Partial<CodexThreadIdentity>;
    ordinaryAuthorization?: boolean;
    code: string;
  }> = [
    { child: { threadSource: "user" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { source: null }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { child: { source: { subAgent: "compact" } }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { child: { source: source("parent", null, 2) }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { child: { source: source("foreign") }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { source: source("child") }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { source: source("parent", "worker") }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { agentRole: "worker" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { request: { agentRole: "worker" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { request: { sessionId: "foreign" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { sessionId: "foreign" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { cwd: "/other" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { parentThreadId: "foreign" }, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
    { child: { path: "relative.jsonl" }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { child: { ephemeral: true }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { parent: { threadSource: null }, code: "CODEX_REQUEST_THREAD_UNTRUSTED" },
    { ordinaryAuthorization: true, code: "CODEX_REQUEST_IDENTITY_CONFLICT" },
  ];
  for (const entry of cases) {
    const coordinator = new GoalProgressSessionCoordinator({
      store: null as never,
      resolveNativeGoal: async () => null,
      resolveCurrentThread: async () => {
        throw new Error("unexpected hook resolution");
      },
      readThreadIdentity: async (threadId) =>
        threadId === "child"
          ? { ...child, ...entry.child }
          : { ...identity(threadId, "/tmp"), ...entry.parent },
      consumeRuntimeProof: async () => false,
      log: async () => {},
    });
    const auth = {
      kind: "codex-request" as const,
      toolName: "task_progress_get",
      identity: { ...request, ...entry.request },
    } satisfies GoalProgressIpcAuthorization;
    await assert.rejects(
      entry.ordinaryAuthorization
        ? coordinator.authorizeSessionRequest(auth)
        : coordinator.authorizeTaskRequest(auth),
      { code: entry.code },
    );
  }
});

test("native null child records keep task reads and mutations in their own journal", async () => {
  const root = await mkdtemp("/tmp/ctph-null-child-");
  await mkdir(join(root, ".git"));
  const mocked = runtime(root);
  const parent = "parent-chat";
  const child = "child-chat";
  mocked.readThreadIdentity = async (threadId) => ({
    ...identity(threadId, root),
    ...(threadId === child
      ? {
          threadSource: null,
          agentRole: null,
          path: join(root, "child.jsonl"),
          source: {
            subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_role: null } },
          },
        }
      : {}),
  });
  mocked.listDirectSubagents = async () => {
    assert.fail("child journal must not load an agent roster");
  };
  mocked.listSubagentTurns = async () => {
    assert.fail("child journal must not load parent activity");
  };
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let calls = 0;
  const request = (action: "get" | "initialize" | "update" | "rescope", input = {}) =>
    client.request({
      method: "task.request",
      params: {
        action,
        input,
        auth: {
          kind: "codex-request",
          toolName: `task_progress_${action}`,
          identity: {
            threadId: child,
            sessionId: child,
            turnId: "child-turn",
            callId: `child-${++calls}`,
            model: "test",
            threadSource: "subagent",
            parentThreadId: parent,
            cwd: root,
          },
        },
      },
    });
  try {
    await helper.start();
    const empty = (await request("get")).result as Record<string, unknown>;
    assert.equal(empty.task, null);
    await request("initialize", {
      requestId: "child-init",
      expectedRevision: 0,
      reason: "Register child milestones",
      title: "Child module",
      objectives: [{ id: "module", title: "Implement module" }],
    });
    await request("update", {
      requestId: "child-update",
      expectedRevision: 1,
      reason: "Record module progress",
      changes: [{ targetId: "module", status: "active" }],
    });
    await request("rescope", {
      requestId: "child-rescope",
      expectedRevision: 2,
      reason: "Include module evidence review",
      objectives: [
        { id: "module", title: "Implement module", status: "active" },
        { id: "evidence", title: "Review module evidence" },
      ],
    });
    const own = (await request("get")).result as Record<string, unknown> & { task: TaskState };
    assert.equal(own.task.threadId, child);
    assert.equal(own.task.title, "Child module");
    assert.equal(own.task.revision, 3);
    for (const value of [empty, own])
      for (const field of ["heartbeat", "subagents", "presentation", "storage", "archiveCount"])
        assert.equal(Object.hasOwn(value, field), false, field);
    await assert.rejects(
      client.request({
        method: "task.native-read",
        params: { action: "get", threadId: child, input: {} },
      }),
      hasCode("TASK_THREAD_UNTRUSTED"),
    );
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Helper rejects mismatched tool identity, mismatched exact chat record", async () => {
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
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
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
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native read IPC stays read-only and resolves each exact user chat independently", async () => {
  const root = await mkdtemp("/tmp/ctph-native-read-");
  const firstCwd = join(root, "first");
  const secondCwd = join(root, "second");
  await Promise.all([
    mkdir(join(firstCwd, ".git"), { recursive: true }),
    mkdir(join(secondCwd, ".git"), { recursive: true }),
  ]);
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const mocked = runtime(firstCwd);
  mocked.readThreadIdentity = async (threadId) => {
    if (threadId === "unknown-chat") throw new Error("thread not found");
    const cwd = threadId === "second-chat" ? secondCwd : firstCwd;
    return {
      ...identity(threadId, cwd),
      ...(threadId === "worker-chat" ? { agentRole: "worker" } : {}),
      ...(threadId === "ephemeral-chat" ? { ephemeral: true } : {}),
      ...(threadId === "conflicting-chat" ? { sessionId: "other-session" } : {}),
      ...(threadId === "wrong-id-chat" ? { id: "different-chat" } : {}),
      ...(threadId === "non-user-chat" ? { threadSource: "system" } : {}),
    };
  };
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const initialize = (threadId: string, title: string) =>
    client.request({
      method: "task.request",
      params: {
        action: "initialize",
        auth: {
          kind: "codex-request",
          toolName: "task_progress_initialize",
          identity: {
            threadId,
            sessionId: threadId,
            turnId: "turn-1",
            callId: `native-init-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: threadId === "second-chat" ? secondCwd : firstCwd,
          },
        },
        input: {
          requestId: `native-init-${threadId}`,
          expectedRevision: 0,
          title,
          reason: "Seed exact thread read isolation",
          objectives: [{ id: "N1", title: "Read only" }],
        },
      },
    });
  const nativeRead = (threadId: string, action: "get" | "history" | "heartbeat-history") =>
    client.request({
      method: "task.native-read",
      params: {
        threadId,
        action,
        input: action === "get" ? {} : { limit: 1 },
      },
    });
  try {
    await helper.start();
    await initialize("first-chat", "First exact task");
    await initialize("second-chat", "Second exact task");

    // A cold native presentation returns immediately; canonical history reads remain awaited.
    await nativeRead("first-chat", "history");
    await nativeRead("second-chat", "history");
    const first = (await nativeRead("first-chat", "get")).result as { task: TaskState | null };
    const second = (await nativeRead("second-chat", "get")).result as { task: TaskState | null };
    const firstHistory = (await nativeRead("first-chat", "history")).result as {
      history: { events: unknown[] };
    };
    const secondHeartbeatHistory = (await nativeRead("second-chat", "heartbeat-history"))
      .result as {
      heartbeatHistory: { wakes: unknown[] };
    };
    const firstHistoryAgain = (await nativeRead("first-chat", "history")).result as {
      history: { events: unknown[] };
    };
    assert.ok(first.task === null || first.task.title === "First exact task");
    assert.ok(second.task === null || second.task.title === "Second exact task");
    assert.ok(firstHistory.history.events.length > 0);
    assert.deepEqual(firstHistoryAgain.history.events, firstHistory.history.events);
    assert.ok(Array.isArray(secondHeartbeatHistory.heartbeatHistory.wakes));

    for (const threadId of [
      "unknown-chat",
      "worker-chat",
      "ephemeral-chat",
      "conflicting-chat",
      "wrong-id-chat",
      "non-user-chat",
    ])
      await assert.rejects(nativeRead(threadId, "get"));
    for (const action of ["initialize", "update", "rescope", "complete", "bind-heartbeat"])
      assert.equal(
        GoalProgressIpcRequestSchema.safeParse({
          protocolVersion: 4,
          requestId: "native-write-rejected",
          method: "task.native-read",
          params: { threadId: "first-chat", action, input: {} },
        }).success,
        false,
      );
    assert.equal(
      GoalProgressIpcRequestSchema.safeParse({
        protocolVersion: 4,
        requestId: "native-input-required",
        method: "task.native-read",
        params: { threadId: "first-chat", action: "get" },
      }).success,
      false,
    );
    assert.equal(
      GoalProgressIpcRequestSchema.safeParse({
        protocolVersion: 4,
        requestId: "task-request-proof-required",
        method: "task.request",
        params: { action: "get", input: {} },
      }).success,
      false,
    );
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native task IPC reads retain the shared 30-second socket deadline", async () => {
  const root = await mkdtemp("/tmp/ctph-native-read-deadline-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const mocked = runtime(root);
  mocked.readThreadIdentity = async (threadId) => {
    if (threadId === "slow-native-chat")
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_200));
    return identity(threadId, root);
  };
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  try {
    await helper.start();
    const response = await client.request(
      {
        method: "task.native-read",
        params: { threadId: "slow-native-chat", action: "get", input: {} },
      },
      { timeoutMs: TASK_PROGRESS_REQUEST_TIMEOUT_MS },
    );
    assert.equal((response.result as { task: unknown }).task, null);
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
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const projectReads = trackProjectViewReads();
  async function request(
    action: "initialize" | "update" | "get" | "history" | "bind-heartbeat" | "archive" | "complete",
    input: unknown,
    threadId = "source-chat",
  ) {
    const toolNames = {
      initialize: "task_progress_initialize",
      update: "task_progress_update",
      get: "task_progress_get",
      history: "task_progress_history",
      "bind-heartbeat": "task_progress_bind_heartbeat",
      archive: "task_progress_archive",
      complete: "task_progress_complete",
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
    const sourceArchive = (await request("archive", {})).result as {
      archive: { available: boolean; tasks: unknown[] };
    };
    assert.equal(sourceArchive.archive.available, false);
    assert.deepEqual(sourceArchive.archive.tasks, []);
    const proof = [{ summary: "Verified", verification: "verified", reference: "test:delivery" }];
    const check = { status: "done", evidence: proof };
    await assert.rejects(
      request("complete", {
        requestId: "source-close",
        expectedRevision: 1,
        reason: "Close",
        closeout: {
          branch: check,
          merge: check,
          push: check,
          remainingWork: 0,
          ownerActions: 0,
          auditEvidence: proof,
        },
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
    const knownHistory = (await request("history", { limit: 1 }, "known-local-chat")).result as {
      history: TaskHistorySummaryPage;
    };
    const knownHistoryPath = eventPath(
      join(await realpath(root), ".workspace", "codex-task-progress"),
      "known-local-chat",
    );
    assert.equal(knownHistory.history.canonicalHistoryPath, knownHistoryPath);
    assert.equal(knownHistory.history.nextCursor, "2");
    assert.equal(knownHistory.history.events.length, 1);
    assertHistorySummary(knownHistory.history.events[0], {
      revision: 2,
      kind: "task.updated",
      reason: "Start the known task",
      before: { completed: 0, total: 2, percent: 0 },
      after: { completed: 0, total: 2, percent: 0 },
    });
    const knownOlder = (await request("history", { limit: 1, cursor: "2" })).result as {
      history: TaskHistorySummaryPage;
    };
    assert.equal(knownOlder.history.canonicalHistoryPath, knownHistoryPath);
    assert.equal(knownOlder.history.nextCursor, null);
    assertHistorySummary(knownOlder.history.events[0], {
      revision: 1,
      kind: "task.initialized",
      reason: "Create durable local task history before bounded discovery",
      before: null,
      after: { completed: 0, total: 2, percent: 0 },
    });
    assert.deepEqual(await taskEvents(root, "known-local-chat"), knownEventsBefore);
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
      history: TaskHistorySummaryPage;
    };
    assert.equal(historyAfterUpdate.history.canonicalHistoryPath, knownHistoryPath);
    assert.equal(historyAfterUpdate.history.nextCursor, null);
    assert.deepEqual(
      historyAfterUpdate.history.events.map((event) => event.revision),
      [3, 2, 1],
    );
    assertHistorySummary(historyAfterUpdate.history.events[0], {
      revision: 3,
      kind: "task.updated",
      reason: "Continue the known task despite incomplete discovery",
      before: { completed: 0, total: 2, percent: 0 },
      after: { completed: 0, total: 2, percent: 0 },
    });

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
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  async function request(
    action:
      | "initialize"
      | "update"
      | "get"
      | "history"
      | "bind-heartbeat"
      | "heartbeat-history"
      | "archive"
      | "complete",
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
      archive: "task_progress_archive",
      complete: "task_progress_complete",
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
    "# Supervision\nthread: sticky-chat\n## 2026-11-11T10:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| H1 | request | Source task | blocked | Waiting |\n## 2026-11-11T11:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n| # | category | state |\n| --- | --- | --- |\n| 1 | task | done |\n";
  let reopened: GoalProgressHelper | undefined;
  let canonicalSourcePath: string | undefined;
  const projectReads = trackProjectViewReads();
  try {
    const localStore = new TaskStore(join(root, ".workspace", "codex-task-progress"));
    const closeout = await seedDormantArchive(localStore, "sticky-chat");
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
      line: original.split("\n").indexOf("| 1 | task | done |") + 1,
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
    const staleArchive = (await request("archive", {})).result as {
      archive: { available: boolean; tasks: unknown[] };
    };
    assert.equal(staleArchive.archive.available, false);
    assert.deepEqual(staleArchive.archive.tasks, []);
    await assert.rejects(
      request("complete", {
        requestId: "stale-close",
        expectedRevision: 3,
        reason: "Close",
        closeout,
      }),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
    assert.deepEqual(await taskEvents(root, "sticky-chat"), before);
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
    await seedDormantArchive(localStore, pendingThreadId);
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
    const pendingArchive = (await request("archive", {}, pendingThreadId)).result as {
      archive: { available: boolean; tasks: unknown[] };
    };
    assert.equal(pendingArchive.archive.available, false);
    assert.deepEqual(pendingArchive.archive.tasks, []);
    await assert.rejects(
      request(
        "complete",
        { requestId: "pending-close", expectedRevision: 3, reason: "Close", closeout },
        pendingThreadId,
      ),
      hasCode("TASK_SOURCE_SELECTION_REQUIRED"),
    );
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
    const restartedArchive = (await request("archive", {})).result as {
      archive: { available: boolean; tasks: unknown[] };
    };
    assert.equal(restartedArchive.archive.available, false);
    assert.deepEqual(restartedArchive.archive.tasks, []);
    await assert.rejects(
      request("complete", {
        requestId: "restart-close",
        expectedRevision: 3,
        reason: "Close",
        closeout,
      }),
      hasCode("TASK_SOURCE_READ_ONLY"),
    );
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
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let callNumber = 0;
  async function request(action: "get" | "initialize" | "complete", input: unknown) {
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
    assert.equal(initial.task.progress.percent, 50);
    assert.equal(initial.execution.state, "idle");
    const proof = [{ summary: "Verified", verification: "verified", reference: "test:delivery" }];
    const check = { status: "done", evidence: proof };
    await request("complete", {
      requestId: "close",
      expectedRevision: initial.task.revision,
      reason: "Delivered",
      closeout: {
        branch: check,
        merge: check,
        push: check,
        remainingWork: 0,
        ownerActions: 0,
        auditEvidence: proof,
      },
    });
    const originalRevision = initial.task.revision + 1;

    // A later turn is working, but has not written or rescoped the checklist yet.
    status = { type: "active", activeFlags: [] };
    const active = (await request("get", {})).result as ObservedTask;
    assert.equal(active.task.revision, originalRevision);
    assert.equal(active.task.progress.percent, 100);
    assert.equal(active.execution.state, "working");
    assert.equal(active.execution.source, "codex-app-server");
    assert.equal(active.completionBasis, "task-lifecycle");
    const nativeActive = (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId: "ordinary-chat", input: {} },
      })
    ).result as ObservedTask;
    assert.equal(nativeActive.execution.state, "working");
    assert.equal(nativeActive.task.revision, originalRevision);

    // App-server notLoaded is not positive evidence that the UI's running turn finished.
    status = { type: "notLoaded" };
    const unavailable = (await request("get", {})).result as ObservedTask;
    assert.equal(unavailable.task.revision, originalRevision);
    assert.equal(unavailable.task.progress.percent, 100);
    assert.equal(unavailable.execution.state, "unknown");
    assert.equal(unavailable.completionBasis, "task-lifecycle");
    const nativeUnknown = (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId: "ordinary-chat", input: {} },
      })
    ).result as ObservedTask;
    assert.equal(nativeUnknown.execution.state, "unknown");
    assert.equal(nativeUnknown.task.revision, originalRevision);
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
    const history = (await request("history", { limit: 1 })).result as {
      history: TaskHistorySummaryPage;
    };
    assert.equal(history.history.canonicalHistoryPath, eventPath(workspaceRoot, "legacy-chat"));
    assert.equal(history.history.nextCursor, "2");
    assert.equal(history.history.events.length, 1);
    assertHistorySummary(history.history.events[0], {
      revision: 2,
      kind: "task.updated",
      reason: "Existing meaningful evidence",
      before: { completed: 0, total: 1, percent: 0 },
      after: { completed: 1, total: 1, percent: 100 },
    });
    const older = (await request("history", { limit: 1, cursor: "2" })).result as {
      history: TaskHistorySummaryPage;
    };
    assert.equal(older.history.canonicalHistoryPath, history.history.canonicalHistoryPath);
    assert.equal(older.history.nextCursor, null);
    assert.equal(older.history.events.length, 1);
    assertHistorySummary(older.history.events[0], {
      revision: 1,
      kind: "task.initialized",
      reason: "Prior plugin version",
      before: null,
      after: { completed: 0, total: 1, percent: 0 },
    });
    // The public summary must not alter the complete canonical migration records.
    assert.deepEqual(
      await new TaskStore(workspaceRoot).history("legacy-chat", { limit: 100 }),
      expectedHistory,
    );
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

test("model Goal initialization and retrieval remain available without a desktop renderer", async () => {
  const root = await mkdtemp("/tmp/ctph-goal-native-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async (threadId) => ({
      threadId,
      objective: "Deliver the intended result",
      status: "active",
      createdAt: 100,
    }),
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const auth = (toolName: "goal_progress_initialize" | "goal_progress_get", callId: string) => ({
    kind: "codex-request" as const,
    toolName,
    identity: {
      threadId: "goal-chat",
      sessionId: "goal-chat",
      turnId: "turn-1",
      callId,
      model: "test",
      threadSource: "user" as const,
      cwd: root,
    },
  });
  try {
    await helper.start();
    const initialized = await client.request({
      method: "store.initialize",
      params: {
        auth: auth("goal_progress_initialize", "goal-init"),
        initialization: {
          contractId: "gp_goaltest01",
          source: "model-generated",
          objectives: [
            {
              id: "C1",
              title: "Deliver",
              requirement: "required",
              contributionBps: 10000,
              contributionReason: "Complete scope",
              status: "pending",
              evidence: [],
              items: [],
            },
          ],
        },
        metadata: {
          eventId: "evt-init",
          requestId: "req-init",
          turnId: "turn-1",
          occurredAt: new Date().toISOString(),
          source: "model",
        },
      },
    });
    assert.equal(initialized.revision, 1);
    const loaded = await client.request({
      method: "store.load",
      params: { sessionId: "goal-chat", auth: auth("goal_progress_get", "goal-get") },
    });
    assert.equal(loaded.revision, 1);
    assert.equal(
      (loaded.result as { viewModel: { objective: string } }).viewModel.objective,
      "Deliver the intended result",
    );
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("retryable discovery blocks writes and exposes pending reads until recovery", async () => {
  const root = await mkdtemp("/tmp/ctph-retry-discovery-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const original = HeartbeatDiscoveryIndex.prototype.discover;
  let invalidated = true;
  HeartbeatDiscoveryIndex.prototype.discover = async function (...args) {
    if (invalidated) throw new HeartbeatDiscoveryInvalidatedError();
    return original.apply(this, args);
  };
  let call = 0;
  const toolNames = {
    get: "task_progress_get",
    archive: "task_progress_archive",
    complete: "task_progress_complete",
    initialize: "task_progress_initialize",
    history: "task_progress_history",
    "heartbeat-history": "task_progress_heartbeat_history",
  } as const;
  const request = (
    action: "get" | "initialize" | "history" | "heartbeat-history" | "archive" | "complete",
    input: unknown = {},
  ) =>
    client.request({
      method: "task.request",
      params: {
        action,
        input,
        auth: {
          kind: "codex-request",
          toolName: toolNames[action],
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: `retry-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  try {
    await helper.start();
    const pending = (await request("get")).result as {
      task: unknown;
      taskSourcePending?: boolean;
      taskSource: { status: string; retryable?: boolean; error?: string };
    };
    assert.equal(pending.task, null);
    assert.equal(pending.taskSourcePending, true);
    assert.equal(pending.taskSource.status, "pending");
    assert.equal(pending.taskSource.retryable, true);
    assert.equal(pending.taskSource.error, undefined);
    const history = (await request("history")).result as {
      history: { source: { retryable?: boolean } };
    };
    assert.equal(history.history.source.retryable, true);
    const archive = (await request("archive")).result as {
      archive: { available: boolean; tasks: unknown[] };
    };
    assert.equal(archive.archive.available, false);
    assert.deepEqual(archive.archive.tasks, []);
    await assert.rejects(
      request("complete", {
        requestId: "pending-close",
        expectedRevision: 1,
        reason: "Close",
        closeout: {},
      }),
      hasCode("TASK_SOURCE_UNAVAILABLE"),
    );
    const projectHistory = (await request("heartbeat-history")).result as {
      heartbeatHistory: { retryable?: boolean; error?: string };
    };
    assert.equal(projectHistory.heartbeatHistory.retryable, true);
    assert.equal(projectHistory.heartbeatHistory.error, undefined);
    await assert.rejects(
      request("initialize", {
        requestId: "blocked",
        expectedRevision: 0,
        title: "Local",
        reason: "test",
        objectives: [{ id: "A", title: "A" }],
      }),
      hasCode("TASK_SOURCE_UNAVAILABLE"),
    );
    invalidated = false;
    const recovered = (await request("get")).result as {
      taskSourcePending?: boolean;
      taskSource: unknown;
    };
    assert.equal(recovered.taskSourcePending, undefined);
    assert.equal(recovered.taskSource, null);
  } finally {
    HeartbeatDiscoveryIndex.prototype.discover = original;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending history uses first resolution and the next request resolves ordinary history", async (t) => {
  const root = await mkdtemp("/tmp/ctph-history-invalidation-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const discover = HeartbeatDiscoveryIndex.prototype.discover;
  const heartbeatHistory = HeartbeatService.prototype.history;
  const localHistory = t.mock.method(KitTaskStore.prototype, "history");
  let invalidate = true;
  let heartbeatReads = 0;
  HeartbeatDiscoveryIndex.prototype.discover = async function (options, context) {
    if (options.threadId && invalidate) {
      invalidate = false;
      throw new HeartbeatDiscoveryInvalidatedError();
    }
    return discover.call(this, options, context);
  };
  HeartbeatService.prototype.history = function (...args) {
    heartbeatReads++;
    return heartbeatHistory.apply(this, args);
  };
  let call = 0;
  const request = (input: unknown) =>
    client.request({
      method: "task.request",
      params: {
        action: "history",
        input,
        auth: {
          kind: "codex-request",
          toolName: "task_progress_history",
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: `history-race-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  try {
    await helper.start();
    const pending = (await request({ limit: 25 })).result as {
      taskSourcePending?: boolean;
      history: {
        events: unknown[];
        source: { path: string | null; readOnly: boolean; retryable?: boolean; error?: string };
      };
    };
    assert.equal(pending.taskSourcePending, true);
    assert.deepEqual(pending.history.events, []);
    assert.equal(pending.history.source.path, null);
    assert.equal(pending.history.source.readOnly, true);
    assert.equal(pending.history.source.retryable, true);
    assert.equal(pending.history.source.error, undefined);
    assert.equal(heartbeatReads, 0);
    assert.equal(localHistory.mock.callCount(), 0);
    invalidate = true;
    await assert.rejects(request({ limit: 101 }));
    invalidate = true;
    await assert.rejects(request({ cursor: 123 }));
    assert.equal(heartbeatReads, 0);
    assert.equal(localHistory.mock.callCount(), 0);
    const recovered = (await request({ limit: 25 })).result as {
      taskSourcePending?: boolean;
      history: { events: unknown[]; source?: unknown };
    };
    assert.equal(recovered.taskSourcePending, undefined);
    assert.deepEqual(recovered.history.events, []);
    assert.equal(recovered.history.source, undefined);
    assert.equal(heartbeatReads, 0);
    assert.equal(localHistory.mock.callCount(), 1);
  } finally {
    HeartbeatDiscoveryIndex.prototype.discover = discover;
    HeartbeatService.prototype.history = heartbeatHistory;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native presentation returns a verified snapshot while canonical reads deduplicate and model reads wait", async () => {
  const root = await mkdtemp("/tmp/ctph-display-cache-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const original = HeartbeatService.prototype.taskProjection;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let held = false;
  let count = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  HeartbeatService.prototype.taskProjection = async function (threadId, cwd, options) {
    if (held) {
      count++;
      await gate;
    }
    return original.call(this, threadId, cwd, options);
  };
  let call = 0;
  const model = () =>
    client.request({
      method: "task.request",
      params: {
        action: "get",
        input: {},
        auth: {
          kind: "codex-request",
          toolName: "task_progress_get",
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: `display-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    await model();
    held = true;
    now += 5_001;
    const first = (await native()).result as {
      presentation: { cached: boolean; pending: boolean };
    };
    const second = (await native()).result as {
      presentation: { cached: boolean; pending: boolean };
    };
    assert.equal(first.presentation.cached, true);
    assert.equal(first.presentation.pending, true);
    assert.equal(second.presentation.cached, true);
    assert.equal(count, 1);
    let modelDone = false;
    const pendingModel = model().then((value) => {
      modelDone = true;
      return value;
    });
    // A third native request proves the event loop handled more IPC while the model is held.
    await native();
    assert.equal(modelDone, false);
    release();
    await pendingModel;
    const readsAfterCompletion = count;
    const fresh = (await native()).result as {
      presentation: { cached: boolean; pending: boolean };
    };
    assert.equal(fresh.presentation.cached, true);
    assert.equal(fresh.presentation.pending, false);
    assert.equal(count, readsAfterCompletion);
  } finally {
    release();
    Date.now = originalNow;
    HeartbeatService.prototype.taskProjection = original;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native cached presentation rechecks identity, project preference and canonical cwd", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-boundary-");
  const moved = await mkdtemp("/tmp/ctph-cache-moved-");
  await mkdir(join(root, ".git"));
  await mkdir(join(moved, ".git"));
  await mkdir(join(root, ".vibe-coding"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const mocked = runtime(root);
  let cwd = root;
  let untrusted = false;
  mocked.readThreadIdentity = async (threadId) => ({
    ...identity(threadId, cwd),
    agentRole: untrusted ? "worker" : null,
  });
  const helper = new GoalProgressHelper({
    paths,
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const model = (action: "get" | "initialize", input: unknown) =>
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
            callId: `boundary-${++call}`,
            model: "test",
            threadSource: "user",
            cwd,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    const cold = (await native()).result as {
      task: TaskState | null;
      taskSourcePending?: boolean;
      heartbeatPending?: boolean;
      presentation: { pending: boolean; cached: boolean };
    };
    assert.equal(cold.task, null);
    assert.equal(cold.presentation.pending, true);
    assert.equal(cold.presentation.cached, false);
    assert.equal(cold.taskSourcePending, true);
    assert.equal(cold.heartbeatPending, true);
    const canonicalEmpty = (await model("get", {})).result as {
      taskSourcePending?: boolean;
      heartbeatPending?: boolean;
    };
    const empty = (await native()).result as {
      task: TaskState | null;
      taskSourcePending?: boolean;
      heartbeatPending?: boolean;
      presentation: { cached: boolean };
    };
    assert.equal(empty.task, null);
    assert.equal(empty.presentation.cached, true);
    assert.equal(empty.taskSourcePending, canonicalEmpty.taskSourcePending);
    assert.equal(empty.heartbeatPending, canonicalEmpty.heartbeatPending);
    await model("initialize", {
      requestId: "seed",
      expectedRevision: 0,
      title: "Private first project",
      reason: "Boundary test",
      objectives: [{ id: "I1", title: "One" }],
    });
    await model("get", {});
    const initial = (await native()).result as { task: TaskState; presentation: { scope: string } };
    assert.equal(initial.task.title, "Private first project");
    untrusted = true;
    await assert.rejects(native(), hasCode("TASK_THREAD_UNTRUSTED"));
    untrusted = false;
    await writeFile(
      join(root, ".vibe-coding", "project.config.json"),
      JSON.stringify({ optional: { "task-progress": false } }),
    );
    assert.deepEqual((await native()).result, { enabled: false, task: null, heartbeat: null });
    await writeFile(
      join(root, ".vibe-coding", "project.config.json"),
      JSON.stringify({ optional: { "task-progress": true } }),
    );
    const reenabled = (await native()).result as {
      task: TaskState | null;
      presentation: { cached: boolean };
    };
    assert.equal(reenabled.task, null);
    assert.equal(reenabled.presentation.cached, false);
    cwd = moved;
    const afterMove = (await native()).result as {
      task: TaskState | null;
      presentation: { scope: string; cached: boolean };
    };
    assert.notEqual(afterMove.presentation.scope, initial.presentation.scope);
    assert.equal(afterMove.task, null);
    assert.equal(afterMove.presentation.cached, false);
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("a newer mutation wins an older pending display read and writes still validate the journal", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-write-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const originalGet = KitTaskStore.prototype.get;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const capturedRead = new Promise<void>((resolveCapture) => {
    captured = resolveCapture;
  });
  let holdNext = false;
  KitTaskStore.prototype.get = async function (threadId) {
    const value = await originalGet.call(this, threadId);
    if (holdNext) {
      holdNext = false;
      captured();
      await gate;
    }
    return value;
  };
  let call = 0;
  const model = (action: "get" | "initialize" | "update", input: unknown) =>
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
            callId: `race-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    await model("initialize", {
      requestId: "seed",
      expectedRevision: 0,
      title: "Original",
      reason: "Race test",
      objectives: [{ id: "I1", title: "One" }],
    });
    const before = (await model("get", {})).result as { task: TaskState };
    now += 5_001;
    holdNext = true;
    await native();
    await capturedRead;
    await model("update", {
      requestId: "newer",
      expectedRevision: before.task.revision,
      reason: "Newer",
      changes: [{ targetId: "I1", status: "active" }],
    });
    release();
    const current = (await native()).result as { task: TaskState };
    assert.equal(current.task.revision, before.task.revision + 1);
    await assert.rejects(
      model("update", {
        requestId: "stale",
        expectedRevision: before.task.revision,
        reason: "Stale",
        changes: [{ targetId: "I1", status: "active" }],
      }),
      hasCode("TASK_REVISION_CONFLICT"),
    );
    await writeFile(
      eventPath(join(root, ".workspace", "codex-task-progress"), "chat-A"),
      "corrupt\n",
    );
    await assert.rejects(
      model("update", {
        requestId: "corrupt",
        expectedRevision: current.task.revision,
        reason: "Corrupt journal",
        changes: [{ targetId: "I1", status: "active" }],
      }),
    );
  } finally {
    release();
    Date.now = originalNow;
    KitTaskStore.prototype.get = originalGet;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native cached pending and source errors refresh to ready without waiting for the lease", async () => {
  const root = await mkdtemp("/tmp/ctph-pending-cache-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const originalProjection = HeartbeatService.prototype.taskProjection;
  const originalSnapshot = HeartbeatService.prototype.projectViewSnapshot;
  let source: "pending" | "error" | "none" = "pending";
  let heartbeatPending = false;
  let reads = 0;
  HeartbeatService.prototype.taskProjection = async () => {
    reads++;
    return {
      status: source,
      task: null,
      sourcePath: null,
      ...(source === "error" ? { error: "source unavailable", retryable: true as const } : {}),
    };
  };
  HeartbeatService.prototype.projectViewSnapshot = async () => ({
    view: null,
    pending: heartbeatPending,
  });
  let call = 0;
  const model = () =>
    client.request({
      method: "task.request",
      params: {
        action: "get",
        input: {},
        auth: {
          kind: "codex-request",
          toolName: "task_progress_get",
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: `refresh-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    for (const condition of ["pending", "error", "heartbeat"] as const) {
      source = condition === "heartbeat" ? "none" : condition;
      heartbeatPending = condition === "heartbeat";
      await model(); // Canonical result primes the same cache without waiting for the lease.
      const before = reads;
      source = "none";
      heartbeatPending = false;
      const first = (await native()).result as { presentation: { pending: boolean } };
      assert.equal(first.presentation.pending, true);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = (await native()).result as {
          taskSourcePending?: boolean;
          heartbeatPending?: boolean;
          taskSource: { status?: string } | null;
          presentation: { pending: boolean };
        };
        if (
          !response.presentation.pending &&
          !response.taskSourcePending &&
          !response.heartbeatPending &&
          !response.taskSource
        ) {
          ready = true;
          break;
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
      assert.equal(ready, true, `${condition} should refresh promptly`);
      assert.ok(reads > before);
    }
  } finally {
    HeartbeatService.prototype.taskProjection = originalProjection;
    HeartbeatService.prototype.projectViewSnapshot = originalSnapshot;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("late canonical history and model reads cannot roll back a newer mutation", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-late-reads-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const originalGet = KitTaskStore.prototype.get;
  const originalHistory = KitTaskStore.prototype.history;
  let hold: "get" | "history" | null = null;
  let release = () => {};
  let notifyCaptured = () => {};
  let gate = Promise.resolve();
  let captured = Promise.resolve();
  const arm = (kind: "get" | "history") => {
    hold = kind;
    gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    captured = new Promise<void>((resolveCaptured) => {
      notifyCaptured = resolveCaptured;
    });
  };
  KitTaskStore.prototype.get = async function (threadId) {
    const value = await originalGet.call(this, threadId);
    if (hold === "get") {
      hold = null;
      notifyCaptured();
      await gate;
    }
    return value;
  };
  function delayedHistory(
    this: KitTaskStore,
    threadId: string,
    options: { cursor?: string; limit?: number; projection: "summary" },
  ): Promise<KitTaskHistorySummaryPage>;
  function delayedHistory(
    this: KitTaskStore,
    threadId: string,
    options?: { cursor?: string; limit?: number; projection?: "raw" },
  ): Promise<TaskHistoryPage>;
  async function delayedHistory(
    this: KitTaskStore,
    threadId: string,
    options?: { cursor?: string; limit?: number; projection?: "raw" | "summary" },
  ): Promise<TaskHistoryPage | KitTaskHistorySummaryPage> {
    const value = (await Reflect.apply(originalHistory, this, [threadId, options])) as
      | TaskHistoryPage
      | KitTaskHistorySummaryPage;
    if (hold === "history") {
      hold = null;
      notifyCaptured();
      await gate;
    }
    return value;
  }
  KitTaskStore.prototype.history = delayedHistory;
  let call = 0;
  const model = (action: "get" | "history" | "initialize" | "update", input: unknown) =>
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
            callId: `late-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    await model("initialize", {
      requestId: "seed",
      expectedRevision: 0,
      title: "Race",
      reason: "Test",
      objectives: [{ id: "I1", title: "One" }],
    });
    const initial = (await model("get", {})).result as { task: TaskState };
    let revision = initial.task.revision;
    for (const kind of ["history", "get"] as const) {
      arm(kind);
      const oldRead = model(kind, {});
      await captured;
      await model("update", {
        requestId: `advance-${kind}`,
        expectedRevision: revision,
        reason: "Advance",
        changes: [{ targetId: "I1", status: kind === "history" ? "active" : "pending" }],
      });
      revision++;
      release();
      await oldRead;
      const displayed = (await native()).result as { task: TaskState; history?: unknown };
      assert.equal(displayed.task.revision, revision);
      assert.equal(displayed.history, undefined);
    }
  } finally {
    release();
    KitTaskStore.prototype.get = originalGet;
    KitTaskStore.prototype.history = originalHistory;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("helper stop drains an active presentation read before closing workspace storage", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-stop-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const original = HeartbeatService.prototype.taskProjection;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const running = new Promise<void>((resolveRunning) => {
    started = resolveRunning;
  });
  let hold = true;
  HeartbeatService.prototype.taskProjection = async function (threadId, cwd, options) {
    if (hold) {
      hold = false;
      started();
      await gate;
      await writeFile(join(root, "background-finished"), "done");
    }
    return original.call(this, threadId, cwd, options);
  };
  let stopped = false;
  let replacement: GoalProgressHelper | undefined;
  try {
    await helper.start();
    await client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
    await running;
    const stopping = helper.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(await readFile(join(root, "background-finished"), "utf8"), "done");
    replacement = new GoalProgressHelper({
      paths,
      runtime: runtime(root),
      resolveNativeGoal: async () => null,
    });
    await replacement.start();
    const response = await client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
    assert.equal((response.result as { task: unknown }).task, null);
    await replacement.stop();
    replacement = undefined;
  } finally {
    release();
    HeartbeatService.prototype.taskProjection = original;
    await replacement?.stop();
    if (!stopped) await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabling a project fences an in-flight model read and its response", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-disable-race-");
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".vibe-coding"));
  const config = join(root, ".vibe-coding", "project.config.json");
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const original = KitTaskStore.prototype.get;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const running = new Promise<void>((resolveRunning) => {
    started = resolveRunning;
  });
  KitTaskStore.prototype.get = async function (threadId) {
    const value = await original.call(this, threadId);
    started();
    await gate;
    return value;
  };
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  try {
    await helper.start();
    const model = client.request({
      method: "task.request",
      params: {
        action: "get",
        input: {},
        auth: {
          kind: "codex-request",
          toolName: "task_progress_get",
          identity: {
            threadId: "chat-A",
            sessionId: "chat-A",
            turnId: "turn-1",
            callId: "disable-race",
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
    await running;
    await writeFile(config, JSON.stringify({ optional: { "task-progress": false } }));
    assert.deepEqual((await native()).result, { enabled: false, task: null, heartbeat: null });
    release();
    assert.deepEqual((await model).result, { enabled: false, task: null, heartbeat: null });
    await writeFile(config, JSON.stringify({ optional: { "task-progress": true } }));
    const after = (await native()).result as {
      presentation: { cached: boolean; pending: boolean };
    };
    assert.equal(after.presentation.cached, false);
    assert.equal(after.presentation.pending, true);
  } finally {
    release();
    KitTaskStore.prototype.get = original;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native cache keeps the last task during source discovery and replaces it on resolution", async () => {
  const root = await mkdtemp("/tmp/ctph-cache-source-pending-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const originalProjection = HeartbeatService.prototype.taskProjection;
  const originalSnapshot = HeartbeatService.prototype.projectViewSnapshot;
  const originalGet = KitTaskStore.prototype.get;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let pending = false;
  let override: TaskState | null | undefined;
  HeartbeatService.prototype.taskProjection = async () => ({
    status: pending ? "pending" : "none",
    task: null,
    sourcePath: null,
  });
  HeartbeatService.prototype.projectViewSnapshot = async () => ({ view: null, pending: false });
  KitTaskStore.prototype.get = async function (threadId) {
    return override === undefined ? originalGet.call(this, threadId) : override;
  };
  let call = 0;
  const model = (action: "get" | "initialize", input: unknown) =>
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
            callId: `preserve-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: root,
          },
        },
      },
    });
  const native = () =>
    client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "chat-A", input: {} },
    });
  type Display = {
    task: TaskState | null;
    taskSourcePending?: boolean;
    presentation: { pending: boolean };
  };
  const waitFor = async (condition: (value: Display) => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = (await native()).result as Display;
      if (condition(value)) return value;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    assert.fail("presentation did not converge");
  };
  try {
    await helper.start();
    await model("initialize", {
      requestId: "seed",
      expectedRevision: 0,
      title: "Known task",
      reason: "Preserve while refreshing",
      objectives: [{ id: "I1", title: "One" }],
    });
    const initial = (await model("get", {})).result as { task: TaskState };
    pending = true;
    now += 5_001;
    await native();
    const held = await waitFor((value) => value.taskSourcePending === true);
    assert.equal(held.task?.title, "Known task");
    assert.equal(held.task?.revision, initial.task.revision);
    override = { ...initial.task, title: "Updated task", revision: initial.task.revision + 1 };
    pending = false;
    const updated = await waitFor((value) => value.task?.title === "Updated task");
    assert.notEqual(updated.taskSourcePending, true);
    override = null;
    now += 5_001;
    await native();
    const empty = await waitFor((value) => value.task === null && !value.presentation.pending);
    assert.equal(empty.task, null);
  } finally {
    Date.now = originalNow;
    HeartbeatService.prototype.taskProjection = originalProjection;
    HeartbeatService.prototype.projectViewSnapshot = originalSnapshot;
    KitTaskStore.prototype.get = originalGet;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent snapshot is background, scoped to its parent, and reports the known runtime count", async () => {
  const root = await mkdtemp("/tmp/ctph-subagents-");
  await mkdir(join(root, ".git"));
  const testRuntime = runtime(root);
  const readerRuntime = runtime(root);
  let readers = 0;
  let closedReaders = 0;
  testRuntime.createSubagentReader = () => {
    readers++;
    return {
      ...readerRuntime,
      close: async () => {
        closedReaders++;
      },
    };
  };
  testRuntime.listDirectSubagents = async () => {
    throw new Error("the long-lived session has stale child history");
  };
  testRuntime.listSubagentTurns = async () => {
    throw new Error("the long-lived session has stale parent history");
  };
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const calls: string[] = [];
  readerRuntime.listDirectSubagents = async (parentThreadId) => {
    calls.push(parentThreadId);
    await gate;
    return {
      data: [
        {
          id: `${parentThreadId}-child`,
          parentThreadId,
          cwd: root,
          source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId } } },
          status: { type: "active", activeFlags: [] },
        },
      ],
      nextCursor: null,
    };
  };
  readerRuntime.listSubagentTurns = async (threadId) => ({
    data: [
      {
        id: "turn",
        rootTurnId: "turn",
        startedAt: 1794830401,
        itemsView: "full",
        items: [
          {
            type: "collabAgentToolCall",
            senderThreadId: threadId,
            receiverThreadIds: [`${threadId}-child`],
            tool: "spawnAgent",
            status: "completed",
          },
        ],
      },
    ],
    nextCursor: null,
  });
  const originalGet = KitTaskStore.prototype.get;
  KitTaskStore.prototype.get = async (threadId) => ({
    schemaVersion: 4,
    kind: "task",
    threadId,
    title: "Test",
    revision: 1,
    createdAt: "2026-11-16T12:00:00Z",
    updatedAt: "2026-11-16T12:00:00Z",
    objectives: [],
    progress: { completed: 0, total: 0, percent: null },
    phase: "active",
    lifecycle: { id: "cycle", sequence: 1, startedAt: "2026-11-16T12:00:00Z", completion: null },
  });
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const native = async (threadId: string) =>
    (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId, input: {} },
      })
    ).result as {
      subagents: {
        status: string;
        parentThreadId: string;
        runningCount: number | null;
        agents: { id: string; state: string }[];
      };
    };
  try {
    await helper.start();
    let a = await native("chat-A");
    for (let i = 0; i < 100 && calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      a = await native("chat-A");
    }
    assert.equal(a.subagents.status, "pending");
    assert.deepEqual(a.subagents.agents, []);
    release();
    for (let i = 0; i < 100 && a.subagents.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      a = await native("chat-A");
    }
    assert.equal(a.subagents.status, "ready");
    assert.equal(a.subagents.runningCount, 1);
    assert.deepEqual(
      a.subagents.agents.map((agent) => [agent.id, agent.state]),
      [["chat-A-child", "working"]],
    );
    let b = await native("chat-B");
    for (let i = 0; i < 100 && b.subagents.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      b = await native("chat-B");
    }
    assert.deepEqual(
      b.subagents.agents.map((agent) => agent.id),
      ["chat-B-child"],
    );
    assert.equal(readers, 2);
    assert.equal(closedReaders, readers);
  } finally {
    release();
    KitTaskStore.prototype.get = originalGet;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("partial nonempty agent catalog advances without the complete snapshot lease", async () => {
  const root = await mkdtemp("/tmp/ctph-subagent-pages-");
  await mkdir(join(root, ".git"));
  const testRuntime = runtime(root);
  let reads = 0;
  testRuntime.listDirectSubagents = async (threadId, cursor) => {
    reads++;
    const page = cursor ? Number(cursor) : 0;
    return {
      data: [
        {
          id: `${threadId}-child-${page}`,
          cwd: root,
          source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } },
          status: { type: "active", activeFlags: [] },
        },
      ],
      nextCursor: page < 4 ? String(page + 1) : null,
    };
  };
  testRuntime.listSubagentTurns = async () => ({
    data: [{ id: "turn", rootTurnId: "turn", startedAt: 1794830401, itemsView: "full", items: [] }],
    nextCursor: null,
  });
  const originalGet = KitTaskStore.prototype.get;
  const originalNow = Date.now;
  const frozen = originalNow();
  Date.now = () => frozen;
  KitTaskStore.prototype.get = async (threadId) => ({
    schemaVersion: 4,
    kind: "task",
    threadId,
    title: "Test",
    revision: 1,
    createdAt: "2026-11-16T12:00:00Z",
    updatedAt: "2026-11-16T12:00:00Z",
    objectives: [],
    progress: { completed: 0, total: 0, percent: null },
    phase: "active",
    lifecycle: { id: "cycle", sequence: 1, startedAt: "2026-11-16T12:00:00Z", completion: null },
  });
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const native = async () =>
    (
      await client.request({
        method: "task.native-read",
        params: {
          action: "get",
          threadId: "chat-A",
          input: {},
        },
      })
    ).result as { subagents: { status: string; complete: boolean; agents: { id: string }[] } };
  try {
    await helper.start();
    let snapshot = await native();
    for (
      let i = 0;
      i < 100 && !(snapshot.subagents.status === "partial" && snapshot.subagents.agents.length);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
      snapshot = await native();
    }
    assert.equal(snapshot.subagents.status, "partial");
    assert.ok(snapshot.subagents.agents.length > 0);
    const readsAtPartial = reads;
    for (let i = 0; i < 100 && !snapshot.subagents.complete; i++) {
      await new Promise((r) => setTimeout(r, 10));
      snapshot = await native();
    }
    assert.equal(snapshot.subagents.complete, true);
    assert.equal(snapshot.subagents.agents.length, 5);
    assert.ok(reads > readsAtPartial);
    const readsAtComplete = reads;
    for (let i = 0; i < 3; i++) await native();
    assert.equal(reads, readsAtComplete, "complete snapshot uses its five-second lease");
    assert.equal(Date.now(), frozen);
  } finally {
    Date.now = originalNow;
    KitTaskStore.prototype.get = originalGet;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native get uses a ready bound Kit heartbeat source when no task lifecycle exists", async () => {
  const root = await mkdtemp("/tmp/ctph-subagents-kit-source-");
  await mkdir(join(root, ".git"));
  let sourcePath = join(root, "heartbeat.md");
  let sourceStatus: "ready" | "pending" | "pending-selection" | "error" | "stale" = "ready";
  let childId = "source-chat-child";
  let canonicalTitle = "Bound task";
  let sourceRevision = 1;
  let leafDone = true;
  let projectionReads = 0;
  let pathOnly = false;
  let currentRoot = "root-turn-current";
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  await writeFile(sourcePath, "bound heartbeat source");
  const testRuntime = runtime(root);
  const turnCollections: string[] = [];
  testRuntime.listDirectSubagents = async (parentThreadId) => ({
    data: [
      {
        id: childId,
        parentThreadId,
        cwd: root,
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: parentThreadId, agent_path: "/root/current" },
          },
        },
        status: { type: "active", activeFlags: [] },
      },
      ...(parentThreadId === "source-chat-stale"
        ? Array.from({ length: 26 }, (_, i) => ({
            id: `stale-active-${i}`,
            parentThreadId,
            cwd: root,
            source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId } } },
            status: { type: "active", activeFlags: [] },
          }))
        : []),
      {
        id: "foreign-child",
        parentThreadId: "different-chat",
        cwd: root,
        source: { subAgent: { thread_spawn: { parent_thread_id: "different-chat" } } },
        status: { type: "active", activeFlags: [] },
      },
    ],
    nextCursor: null,
  });
  testRuntime.listSubagentTurns = async (threadId) => {
    turnCollections.push(threadId);
    return {
      data: [
        {
          id: currentRoot,
          rootTurnId: currentRoot,
          startedAt: 1794830400,
          itemsView: "full",
          items: [
            {
              type: "collabAgentToolCall",
              senderThreadId: threadId,
              receiverThreadIds: [childId],
              tool: "spawnAgent",
              status: "completed",
            },
          ],
        },
      ],
      nextCursor: null,
    };
  };
  const originalProjection = HeartbeatService.prototype.taskProjection;
  const originalAssignments = HeartbeatService.prototype.agentTaskProgress;
  const fullTasks = new Map<string, Parameters<typeof projectAgentTaskProgress>[0]["task"]>();
  HeartbeatService.prototype.agentTaskProgress = (options) => {
    const task = fullTasks.get(
      JSON.stringify([options.threadId, options.sourcePath, options.contentHash]),
    );
    if (!task) return null;
    if (!pathOnly) return projectAgentTaskProgress({ task, agents: options.agents });
    const pathTask = {
      ...task,
      objectives: task.objectives.map(({ agent: _agent, ...objective }) => objective),
      source: { ...task.source, itemOwners: { assigned: { owner: "/root/current" } } },
    };
    return projectAgentTaskProgress({ task: pathTask as never, agents: options.agents });
  };
  HeartbeatService.prototype.taskProjection = async (threadId) => {
    projectionReads++;
    if (threadId === "source-chat-no-scope")
      return { status: "none", sourcePath: null, task: null };
    const task = {
      schemaVersion: 3 as const,
      kind: "task" as const,
      threadId,
      title: canonicalTitle,
      revision: 0,
      createdAt: "2026-11-16T12:00:00Z",
      updatedAt: "2026-11-16T12:00:00Z",
      objectives: [
        {
          id: "assigned",
          title: "Assigned work",
          status: leafDone ? ("completed" as const) : ("pending" as const),
          evidence: [],
          required: true,
          items: [],
          agent: { threadId: childId },
        },
      ],
      progress: { completed: leafDone ? 1 : 0, total: 1, percent: leafDone ? 100 : 0 },
      phase: "active" as const,
      source: {
        kind: "kit-heartbeat" as const,
        path: sourcePath,
        readOnly: true as const,
        contentHash:
          threadId === "source-chat-mismatch"
            ? "mismatched-hash"
            : `hash:${sourcePath}:${sourceRevision}`,
        itemStatuses: {},
        linkRisks: [],
        presentation: {
          truncated: false,
          sourceItemCount: 1,
          displayedItemCount: 1,
          itemStatusesTruncated: false,
          linkRisksTruncated: false,
        },
        itemStatusCount: 1,
        linkRiskCount: 0,
      },
    };
    const contentHash = `hash:${sourcePath}:${sourceRevision}`;
    if (sourceStatus === "ready")
      fullTasks.set(JSON.stringify([threadId, sourcePath, contentHash]), task);
    return {
      status: sourceStatus,
      sourcePath,
      contentHash,
      task: sourceStatus === "ready" ? task : null,
    };
  };
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const native = async (threadId = "source-chat") =>
    (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId, input: {} },
      })
    ).result as {
      taskSource?: { status: string; kind?: string; path?: string; readOnly?: boolean } | null;
      taskSourcePending?: boolean;
      presentation?: { pending?: boolean };
      subagents: {
        status: string;
        parentThreadId: string;
        taskCycleId?: string | null;
        taskSourcePath?: string | null;
        rootTurnId?: string;
        agents: {
          id: string;
          progress?: { completed: number; total: number; percent: number | null } | null;
          progressBasis?: string | null;
        }[];
      };
    };
  let modelCall = 0;
  const modelGet = async (threadId = "source-chat") =>
    (
      await client.request({
        method: "task.request",
        params: {
          action: "get",
          auth: {
            kind: "codex-request",
            toolName: "task_progress_get",
            identity: {
              threadId,
              sessionId: threadId,
              turnId: "turn-1",
              callId: `model-${++modelCall}`,
              model: "test",
              threadSource: "user",
              cwd: root,
            },
          },
          input: {},
        },
      })
    ).result as Awaited<ReturnType<typeof native>> & { task: { title: string } | null };
  const waitForProjection = async (
    threadId: string,
    expectedStatus: string,
    expectedPath: string,
    requireReadySubagents: boolean,
    observe?: (value: Awaited<ReturnType<typeof native>>) => void,
  ) => {
    let result = await native(threadId);
    let lastObserved = "initial response not observed";
    for (let i = 0; i < 100; i++) {
      observe?.(result);
      lastObserved = JSON.stringify({
        parentThreadId: result.subagents.parentThreadId,
        taskSourceStatus: result.taskSource?.status ?? null,
        taskSourcePath: result.taskSource?.path ?? null,
        subagentsStatus: result.subagents.status,
        subagentsSourcePath: result.subagents.taskSourcePath ?? null,
      });
      if (
        result.subagents.parentThreadId === threadId &&
        result.taskSource?.status === expectedStatus &&
        result.taskSource.path === expectedPath &&
        (!requireReadySubagents ||
          (result.subagents.status === "ready" && result.subagents.taskSourcePath === expectedPath))
      )
        return result;
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
      result = await native(threadId);
    }
    assert.fail(
      `projection did not converge for ${threadId} (${expectedStatus}, ${expectedPath}); last=${lastObserved}`,
    );
  };
  try {
    await helper.start();
    let result = await waitForProjection("source-chat", "ready", sourcePath, true);
    assert.deepEqual(result.taskSource, {
      kind: "kit-heartbeat",
      status: "ready",
      path: sourcePath,
      readOnly: true,
      contentHash: `hash:${sourcePath}:${sourceRevision}`,
    });
    assert.equal(result.subagents.status, "ready");
    assert.equal(result.subagents.taskCycleId, null);
    assert.equal(result.subagents.taskSourcePath, sourcePath);
    assert.equal(result.subagents.rootTurnId, "root-turn-current");
    assert.deepEqual(
      result.subagents.agents.map((agent) => agent.id),
      ["source-chat-child"],
    );
    // Full-auth GET keeps task authority canonical while sharing the scoped observation.
    canonicalTitle = "Canonical model title";
    const readsBeforeModel = projectionReads;
    let model = await modelGet();
    assert.ok(projectionReads > readsBeforeModel);
    assert.equal(model.task?.title, canonicalTitle);
    for (let i = 0; i < 100 && model.subagents.status !== "ready"; i++) {
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
      model = await modelGet();
    }
    assert.equal(model.taskSource?.path, sourcePath);
    assert.equal(model.subagents.parentThreadId, "source-chat");
    assert.equal(model.subagents.taskSourcePath, sourcePath);
    assert.equal(model.subagents.taskCycleId, null);
    assert.equal(model.subagents.rootTurnId, "root-turn-current");
    assert.equal(model.subagents.status, "ready");
    assert.deepEqual(
      model.subagents.agents.map((agent) => agent.id),
      [childId],
    );
    assert.equal(model.presentation?.pending, false);
    assert.deepEqual(model.subagents.agents[0]?.progress, { completed: 1, total: 1, percent: 100 });
    assert.equal(model.subagents.agents[0]?.progressBasis, "module-delivery");
    // A revision of the same source reuses membership but recomputes assigned work.
    const membershipBeforeRevision = turnCollections.filter(
      (thread) => thread === "source-chat",
    ).length;
    leafDone = false;
    sourceRevision++;
    const revised = await modelGet();
    assert.deepEqual(revised.subagents.agents[0]?.progress, { completed: 0, total: 1, percent: 0 });
    assert.equal(revised.subagents.agents[0]?.progressBasis, "module-delivery");
    assert.equal(
      turnCollections.filter((thread) => thread === "source-chat").length,
      membershipBeforeRevision,
    );

    // A new root may arrive inside the same source/cycle cache lease. No
    // parent-thread path-only assignment may inherit the cached eligibility.
    pathOnly = true;
    currentRoot = "next-root";
    const beforeRootChange = turnCollections.filter((thread) => thread === "source-chat").length;
    const nextRootModel = await modelGet();
    assert.equal(
      turnCollections.filter((thread) => thread === "source-chat").length,
      beforeRootChange,
    );
    assert.equal(nextRootModel.subagents.agents[0]?.progress, null);
    pathOnly = false;
    currentRoot = "root-turn-current";

    const firstScopeCalls = turnCollections.filter((thread) => thread === "source-chat").length;
    assert.ok(firstScopeCalls > 0);

    // A changed bound source gets a distinct child-list cache entry.
    const previousPath = sourcePath;
    const previousChild = childId;
    sourcePath = join(root, "heartbeat-next.md");
    childId = "source-chat-next-child";
    await writeFile(sourcePath, "next bound heartbeat source");
    now += 5_001;
    result = await waitForProjection("source-chat", "ready", sourcePath, true, (observed) => {
      if (observed.taskSource?.status === "ready" && observed.taskSource.path === previousPath) {
        assert.ok(
          observed.presentation?.pending || observed.taskSourcePending,
          "the previous verified source may only be retained while canonical refresh is pending",
        );
        if (observed.subagents.status === "ready") {
          assert.equal(observed.subagents.taskSourcePath, previousPath);
          assert.deepEqual(
            observed.subagents.agents.map((agent) => agent.id),
            [previousChild],
          );
        }
      }
    });
    assert.equal(result.taskSource?.path, sourcePath);
    assert.equal(result.subagents.taskSourcePath, sourcePath);
    assert.deepEqual(
      result.subagents.agents.map((agent) => agent.id),
      [childId],
    );
    assert.ok(
      turnCollections.filter((thread) => thread === "source-chat").length > firstScopeCalls,
    );

    const expectActivity = async (threadId: string, expectedCount: number) => {
      let snapshot = await native(threadId);
      for (let i = 0; i < 150 && snapshot.subagents.agents.length !== expectedCount; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        snapshot = await native(threadId);
      }
      assert.equal(snapshot.subagents.parentThreadId, threadId);
      assert.equal(snapshot.subagents.agents.length, expectedCount);
      assert.equal(
        snapshot.subagents.agents.some((agent) => agent.id === "foreign-child"),
        false,
      );
      assert.ok(
        snapshot.subagents.agents.every(
          (agent) => agent.progress == null && agent.progressBasis == null,
        ),
      );
      const model = await modelGet(threadId);
      assert.equal(model.subagents.agents.length, expectedCount);
      assert.ok(model.subagents.agents.every((agent) => agent.progress == null));
      return snapshot;
    };
    for (const status of ["pending", "pending-selection", "error", "stale"] as const) {
      sourceStatus = status;
      now += 5_001;
      const threadId = `source-chat-${status}`;
      await waitForProjection(threadId, status, sourcePath, false);
      const snapshot = await expectActivity(threadId, status === "stale" ? 27 : 1);
      assert.equal(snapshot.taskSource?.status, status);
    }
    sourceStatus = "ready";
    now += 5_001;
    await waitForProjection("source-chat-mismatch", "ready", sourcePath, false);
    const mismatch = await expectActivity("source-chat-mismatch", 1);
    assert.equal(mismatch.taskSource?.status, "ready");
    now += 5_001;
    const noScope = await expectActivity("source-chat-no-scope", 1);
    assert.equal(noScope.taskSource, null);
  } finally {
    Date.now = originalNow;
    HeartbeatService.prototype.taskProjection = originalProjection;
    HeartbeatService.prototype.agentTaskProgress = originalAssignments;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent-thread activity never reuses root-scoped allocation and rejects old-cycle child lists", async () => {
  const root = await mkdtemp("/tmp/ctph-agent-allocation-");
  await mkdir(join(root, ".git"));
  const testRuntime = runtime(root);
  let release!: () => void;
  let gate = new Promise<void>((done) => {
    release = done;
  });
  let turn = "turn-1";
  const childReads: string[] = [];
  let resolveOldRead!: () => void;
  const oldReadReleased = new Promise<void>((resolve) => {
    resolveOldRead = resolve;
  });
  let trackHeldRead = false;
  testRuntime.listDirectSubagents = async (threadId) => {
    const capturedTurn = turn;
    childReads.push(`${threadId}:${capturedTurn}`);
    const heldRead = trackHeldRead && threadId === "chat-A" && capturedTurn === "turn-2";
    await gate;
    if (heldRead) resolveOldRead();
    return {
      data: [
        {
          id: `${threadId}-${capturedTurn}-child`,
          cwd: root,
          source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } },
          status: { type: "active", activeFlags: [] },
        },
        ...(capturedTurn === "turn-1"
          ? [
              {
                id: `${threadId}-older-turn-child`,
                cwd: root,
                source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } },
                status: { type: "active", activeFlags: [] },
              },
            ]
          : []),
      ],
      nextCursor: null,
    };
  };
  testRuntime.listSubagentTurns = async (threadId) => ({
    data: [
      {
        id: turn,
        rootTurnId: turn,
        startedAt: turn === "turn-1" ? 1794830400 : 1794830460,
        itemsView: "full",
        items: [
          {
            type: "collabAgentToolCall",
            senderThreadId: threadId,
            receiverThreadIds: [`${threadId}-${turn}-child`],
            tool: "spawnAgent",
            status: "completed",
          },
        ],
      },
    ],
    nextCursor: null,
  });
  // Both the cache and the host must observe the same controllable clock.
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const helper = new GoalProgressHelper({
    paths: resolveGoalProgressPaths({ root: join(root, "data") }),
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(helper.paths.helperSocketPath, { clientKind: "mcp" });
  const originalProjection = HeartbeatService.prototype.taskProjection;
  const originalSnapshot = HeartbeatService.prototype.projectViewSnapshot;
  const originalGet = KitTaskStore.prototype.get;
  let cycle = "cycle-1";
  let heartbeatMode: "empty" | "ready" | "error" = "empty";
  HeartbeatService.prototype.taskProjection = async () => ({
    status: "none",
    sourcePath: null,
    task: null,
  });
  HeartbeatService.prototype.projectViewSnapshot = async () => ({
    view:
      heartbeatMode === "empty"
        ? null
        : heartbeatMode === "error"
          ? ({ status: "error", wakes: [] } as never)
          : ({
              status: "ready",
              wakes: [
                {
                  orchestration: {
                    after: {
                      activeAgents: 3,
                      observedAt: "2026-11-16T12:00:00Z",
                      evidence: "recorded",
                    },
                    agentPlan: {
                      parentThreadId: "chat-A",
                      planId: "plan",
                      revision: 1,
                      plannedAgents: 6,
                      taskCycleId: "cycle-1",
                    },
                  },
                },
              ],
            } as never),
    pending: heartbeatMode !== "error",
  });
  KitTaskStore.prototype.get = async () => ({
    schemaVersion: 4,
    kind: "task",
    threadId: "chat-A",
    title: "Test",
    revision: 1,
    createdAt: "2026-11-16T12:00:00Z",
    updatedAt: "2026-11-16T12:00:00Z",
    objectives: [],
    progress: { completed: 0, total: 0, percent: null },
    phase: "active",
    lifecycle: {
      id: cycle,
      sequence: cycle === "cycle-1" ? 1 : 2,
      startedAt: "2026-11-16T12:00:00Z",
      completion: null,
    },
  });
  const native = async (threadId: string) =>
    (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId, input: {} },
      })
    ).result as {
      task: { lifecycle: { id: string } } | null;
      heartbeat: { status: string } | null;
      heartbeatPending?: boolean;
      subagents: {
        status: string;
        taskCycleId?: string;
        scopeBasis?: string;
        agents: { id: string }[];
        allocation: { status: string; ratio: number | null };
      };
    };
  try {
    await helper.start();
    let a = await native("chat-A");
    for (let i = 0; i < 100 && !a.task; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.heartbeatPending, true);
    assert.equal(a.heartbeat, null);
    assert.equal(a.subagents.allocation.ratio, null);
    heartbeatMode = "ready";
    release();
    for (
      let i = 0;
      i < 100 && (a.subagents.status !== "ready" || a.subagents.agents.length !== 2);
      i++
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.subagents.status, "ready");
    assert.equal(a.heartbeatPending, true);
    assert.equal(a.subagents.scopeBasis, "parent-thread");
    assert.deepEqual(a.subagents.agents.map((agent) => agent.id).sort(), [
      "chat-A-older-turn-child",
      "chat-A-turn-1-child",
    ]);
    // The wake plan can describe only the current root; the parent-thread
    // snapshot includes a child from another root, so the ratio is unproven.
    assert.equal(a.subagents.allocation.ratio, null);
    let b = await native("chat-B");
    for (let i = 0; i < 100 && !b.task; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      b = await native("chat-B");
    }
    assert.equal(b.subagents.allocation.ratio, null);
    turn = "turn-2";
    now += 5_001;
    for (let i = 0; i < 100 && a.subagents.allocation.ratio !== null; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.subagents.allocation.ratio, null); // No root-scope allocation proof.
    heartbeatMode = "error";
    for (let i = 0; i < 100 && a.heartbeat?.status !== "error"; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.heartbeat?.status, "error");
    assert.equal(a.subagents.allocation.ratio, null);
    heartbeatMode = "ready";
    gate = new Promise<void>((done) => {
      release = done;
    });
    now += 5_001;
    trackHeldRead = true;
    const oldReads = childReads.filter((read) => read === "chat-A:turn-2").length;
    await native("chat-A"); // Start an old-cycle child read which stays in flight.
    for (
      let i = 0;
      i < 100 && childReads.filter((read) => read === "chat-A:turn-2").length === oldReads;
      i++
    ) {
      await native("chat-A");
    }
    assert.ok(childReads.filter((read) => read === "chat-A:turn-2").length > oldReads);
    cycle = "cycle-2";
    turn = "turn-3";
    now += 5_001;
    for (let i = 0; i < 100 && a.task?.lifecycle.id !== cycle; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.task?.lifecycle.id, "cycle-2");
    assert.equal(a.subagents.allocation.ratio, null);
    // The shared parent catalog is still locked by the old-cycle read. The
    // new cycle therefore receives a partial result instead of old data.
    for (let i = 0; i < 100 && a.subagents.status !== "partial"; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      a = await native("chat-A");
    }
    assert.equal(a.subagents.status, "partial");
    assert.deepEqual(a.subagents.agents, []);
    assert.equal(childReads.filter((read) => read === "chat-A:turn-3").length, 0);
    release();
    await oldReadReleased;
    // The catalog may reuse a complete one-page sweep and skip a head recheck.
    // Drive the next GET instead of waiting for an event that may never occur.
    // The mocked clock stays fixed throughout recovery.
    const recoveryClock = Date.now();
    for (
      let i = 0;
      i < 100 &&
      (a.subagents.status !== "ready" ||
        !a.subagents.agents.some((agent) => agent.id === "chat-A-turn-3-child"));
      i++
    ) {
      a = await native("chat-A");
    }
    assert.ok(childReads.includes("chat-A:turn-3"));
    assert.equal(Date.now(), recoveryClock);
    assert.equal(a.subagents.allocation.ratio, null);
    assert.equal(a.subagents.taskCycleId, "cycle-2");
    assert.deepEqual(
      a.subagents.agents.map((agent) => agent.id),
      ["chat-A-turn-3-child"],
    );
  } finally {
    release();
    Date.now = originalNow;
    HeartbeatService.prototype.taskProjection = originalProjection;
    HeartbeatService.prototype.projectViewSnapshot = originalSnapshot;
    KitTaskStore.prototype.get = originalGet;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("large canonical orchestration history fits each real IPC response and preserves every cursor record", async () => {
  const root = await mkdtemp("/tmp/ctph-heartbeat-wire-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: runtime(root),
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  try {
    const blockedTasks = Array.from({ length: 20 }, (_, i) => ({
      id: `B${i}`,
      title: "T".repeat(500),
      reason: "R".repeat(2_000),
      evidence: "E".repeat(1_000),
      requiresOwner: true,
    }));
    const snapshot = {
      scope: "session",
      before: null,
      after: null,
      blockedTasks,
      blockersEvidence: "checked",
    };
    const start = Date.parse("2026-11-11T10:00:00Z");
    const wakes = Array.from(
      { length: 12 },
      (_, i) =>
        `## ${new Date(start + i * 60_000).toISOString()} wake (10-row ledger)\norchestration: ${JSON.stringify(snapshot)}\n| # | category | state |\n| --- | --- | --- |\n| 1 | audit | done |\n`,
    ).join("");
    await writeFile(
      join(root, "heartbeat.md"),
      `# Supervision\n${wakes}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | report:test | task | done | receipt |\n`,
    );
    await helper.start();
    let cursor: string | undefined;
    let call = 0;
    const seen: number[] = [];
    do {
      const response = await client.request({
        method: "task.request",
        params: {
          action: "heartbeat-history",
          auth: {
            kind: "codex-request",
            toolName: "task_progress_heartbeat_history",
            identity: {
              threadId: "wire-chat",
              sessionId: "wire-chat",
              turnId: "turn-1",
              callId: `wire-${++call}`,
              model: "test",
              threadSource: "user",
              cwd: root,
            },
          },
          input: { limit: 10, ...(cursor === undefined ? {} : { cursor }) },
        },
      });
      const page = (
        response.result as {
          heartbeatHistory: {
            wakes: { timeMs: number }[];
            nextCursor: string | null;
            total: number;
            error?: string;
          };
        }
      ).heartbeatHistory;
      assert.equal(page.error, undefined);
      assert.equal(page.total, 12);
      assert.ok(page.wakes.length > 0 && page.wakes.length < 10);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 192 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024);
      seen.push(...page.wakes.map((wake) => wake.timeMs));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(
      seen,
      Array.from({ length: 12 }, (_, i) => start + (11 - i) * 60_000),
    );
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native and authenticated GET use full verified heartbeat assignments across source revisions", async () => {
  const root = await realpath(await mkdtemp("/tmp/ctph-full-agent-task-"));
  await mkdir(join(root, ".git"));
  const childId = "verified-child";
  const ids = Array.from({ length: 300 }, (_, i) => `L${i}`);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let wakeMode: "valid" | "foreign" | "future" | "cycle" | "invalid" = "valid";
  const observedAt = "2026-11-16T12:00:00.000Z";
  const source = (done: number, assignedId: string | null) =>
    [
      "# Supervision",
      "thread: source-chat",
      "task_root: ROOT",
      "## Items",
      `| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref | children |${assignedId === null ? "" : " agent_thread_id |"}`,
      `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |${assignedId === null ? "" : " --- |"}`,
      `| ROOT | report:root | Root | tracking | coordinated | agent:lead | repo-a | worktrees/lead | read-only | [] | - | ${JSON.stringify(ids)} |${assignedId === null ? "" : " - |"}`,
      ...ids.map(
        (id, i) =>
          `| ${id} | report:${id} | ${id} | ${i < done ? "done" : `blocked <- resource-${i}`} | receipt | ${childId} | - | - | - | - | - | - |${assignedId === null ? "" : ` ${assignedId} |`}`,
      ),
      "",
      "## 2026-11-16T11:00:00.000Z wake (10-row ledger)",
      `orchestration: ${JSON.stringify({ scope: "session", before: null, after: { activeAgents: 2, observedAt: "2026-11-16T10:59:00.000Z", evidence: "older" }, blockedTasks: null, blockersEvidence: null })}`,
      "| # | category | state |",
      "| --- | --- | --- |",
      "| 1 | audit | done |",
      "",
      `## 2026-11-16T12:01:00.000Z wake (10-row ledger)`,
      `orchestration: ${
        wakeMode === "invalid"
          ? "{invalid"
          : JSON.stringify({
              scope: "session",
              before: null,
              after: {
                activeAgents: 18,
                observedAt:
                  wakeMode === "future" ? new Date(now + 60_000).toISOString() : observedAt,
                evidence: "verified observation",
              },
              blockedTasks: null,
              blockersEvidence: null,
              agentPlan: {
                parentThreadId: wakeMode === "foreign" ? "other-chat" : "source-chat",
                planId: "plan",
                revision: 1,
                plannedAgents: 20,
                ...(wakeMode === "cycle" ? { taskCycleId: "old-cycle" } : {}),
              },
            })
      }`,
      "| # | category | state |",
      "| --- | --- | --- |",
      "| 1 | audit | done |",
      "",
    ].join("\n");
  await writeFile(join(root, "heartbeat.md"), source(150, null));
  let currentRoot = "root-turn";
  let dispatchPresent = true;
  const testRuntime = runtime(root);
  testRuntime.listDirectSubagents = async () => ({
    data: [
      {
        id: childId,
        cwd: root,
        status: { type: "active", activeFlags: [] },
        source: { subAgent: { thread_spawn: { parent_thread_id: "source-chat" } } },
      },
    ],
    nextCursor: null,
  });
  testRuntime.listSubagentTurns = async () => ({
    data: [
      {
        id: currentRoot,
        rootTurnId: currentRoot,
        startedAt: 1794830400,
        itemsView: "full",
        items: dispatchPresent
          ? [
              {
                type: "collabAgentToolCall",
                senderThreadId: "source-chat",
                receiverThreadIds: [childId],
                tool: "spawnAgent",
                status: "completed",
                startedAtMs: 1794830400000,
              },
            ]
          : [],
      },
    ],
    nextCursor: null,
  });
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const get = async (native: boolean) =>
    (
      await client.request(
        native
          ? {
              method: "task.native-read",
              params: { action: "get", threadId: "source-chat", input: {} },
            }
          : {
              method: "task.request",
              params: {
                action: "get",
                auth: {
                  kind: "codex-request",
                  toolName: "task_progress_get",
                  identity: {
                    threadId: "source-chat",
                    sessionId: "source-chat",
                    turnId: "turn-1",
                    callId: `assignment-${++call}`,
                    model: "test",
                    threadSource: "user",
                    cwd: root,
                  },
                },
                input: {},
              },
            },
      )
    ).result as {
      task: { source?: Record<string, unknown> } | null;
      taskSource?: {
        status: string;
        contentHash?: string;
        recordedAgentObservation?: { activeAgents: number; observedAt: string };
      };
      subagents: {
        status: string;
        rootTurnId?: string;
        agents: {
          id: string;
          progress: { completed: number; total: number; percent: number } | null;
          progressBasis: string | null;
        }[];
      };
    };
  const until = async (
    native: boolean,
    matches: (result: Awaited<ReturnType<typeof get>>) => boolean,
  ) => {
    let result = await get(native);
    for (let i = 0; i < 150; i++) {
      if (matches(result)) return result;
      await new Promise((resume) => setTimeout(resume, 10));
      result = await get(native);
    }
    assert.fail(`assignment did not converge for ${native ? "native" : "model"}`);
  };
  const has =
    (completed: number, differentHash?: string, expectedRoot?: string) =>
    (result: Awaited<ReturnType<typeof get>>) =>
      result.taskSource?.status === "ready" &&
      (!differentHash ||
        (!!result.taskSource.contentHash && result.taskSource.contentHash !== differentHash)) &&
      (!expectedRoot || result.subagents?.rootTurnId === expectedRoot) &&
      result.subagents?.agents.find((agent) => agent.id === childId)?.progress?.completed ===
        completed;
  const unlinked = (differentHash?: string) => (result: Awaited<ReturnType<typeof get>>) =>
    result.taskSource?.status === "ready" &&
    (!differentHash ||
      (!!result.taskSource.contentHash && result.taskSource.contentHash !== differentHash)) &&
    result.subagents?.agents.some((agent) => agent.id === childId && agent.progress === null);
  try {
    await helper.start();
    const initial = await until(false, unlinked());
    assert.deepEqual(initial.taskSource?.recordedAgentObservation, {
      activeAgents: 18,
      observedAt,
    });
    assert.equal(
      initial.subagents.agents.find((agent) => agent.id === childId)?.progressBasis,
      null,
    );
    assert.equal(Object.hasOwn(initial.task?.source ?? {}, "itemOwners"), false);
    await until(true, unlinked());

    // The same persistent current agent becomes attributable only once the source
    // writer supplies the exact canonical thread ID, not from its display name.
    await writeFile(join(root, "heartbeat.md"), source(150, childId));
    now += 5_001;
    const first = await until(false, has(150, initial.taskSource?.contentHash));
    assert.equal(
      first.subagents.agents.find((agent) => agent.id === childId)?.progressBasis,
      "module-delivery",
    );
    assert.deepEqual(first.subagents.agents.find((agent) => agent.id === childId)?.progress, {
      completed: 150,
      total: 300,
      percent: 50,
    });
    assert.equal(Object.hasOwn(first.task?.source ?? {}, "itemOwners"), false);
    const presentation = first.task?.source?.presentation as {
      truncated: boolean;
      sourceItemCount: number;
      displayedItemCount: number;
    };
    assert.equal(presentation.truncated, true);
    assert.equal(presentation.sourceItemCount, 301);
    assert.ok(presentation.displayedItemCount < presentation.sourceItemCount);
    const nativeFirst = await until(true, has(150, initial.taskSource?.contentHash));
    assert.deepEqual(nativeFirst.taskSource?.recordedAgentObservation, {
      activeAgents: 18,
      observedAt,
    });
    assert.deepEqual(
      nativeFirst.subagents.agents.find((agent) => agent.id === childId)?.progress,
      first.subagents.agents.find((agent) => agent.id === childId)?.progress,
    );

    // A new parent turn has no fresh dispatch; verified persistent membership and
    // the source's exact ID still bind this canonical responsibility.
    currentRoot = "new-root-turn";
    dispatchPresent = false;
    await writeFile(join(root, "heartbeat.md"), source(200, childId));
    now += 5_001;
    const second = await until(false, has(200, first.taskSource?.contentHash, currentRoot));
    assert.deepEqual(second.subagents.agents.find((agent) => agent.id === childId)?.progress, {
      completed: 200,
      total: 300,
      percent: 66.67,
    });
    const nativeSecond = await until(true, has(200, first.taskSource?.contentHash, currentRoot));
    assert.equal(nativeSecond.taskSource?.contentHash, second.taskSource?.contentHash);
    assert.deepEqual(
      nativeSecond.subagents.agents.find((agent) => agent.id === childId)?.progress,
      second.subagents.agents.find((agent) => agent.id === childId)?.progress,
    );

    await writeFile(join(root, "heartbeat.md"), source(200, "different-child"));
    now += 5_001;
    const reassigned = await until(false, unlinked(second.taskSource?.contentHash));
    assert.equal(
      reassigned.subagents.agents.find((agent) => agent.id === childId)?.progressBasis,
      null,
    );
    await until(true, unlinked(second.taskSource?.contentHash));
    await writeFile(join(root, "heartbeat.md"), source(200, ""));
    now += 5_001;
    const removed = await until(false, unlinked(reassigned.taskSource?.contentHash));
    assert.equal(
      removed.subagents.agents.find((agent) => agent.id === childId)?.progressBasis,
      null,
    );
    await until(true, unlinked(reassigned.taskSource?.contentHash));
    let oldHash = removed.taskSource?.contentHash;
    for (const mode of ["foreign", "future", "cycle", "invalid"] as const) {
      wakeMode = mode;
      await writeFile(join(root, "heartbeat.md"), source(200, ""));
      now += 5_001;
      const next = await until(
        false,
        (result) =>
          unlinked(oldHash)(result) && result.taskSource?.recordedAgentObservation === undefined,
      );
      assert.equal(next.taskSource?.recordedAgentObservation, undefined);
      oldHash = next.taskSource?.contentHash;
    }
  } finally {
    Date.now = originalNow;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent-thread activity overlays a verified child checklist on a single assigned item", async () => {
  const root = await realpath(await mkdtemp("/tmp/ctph-child-revision-"));
  await mkdir(join(root, ".git"));
  const threadId = "parent";
  const childId = "child";
  const testRuntime = runtime(root);
  let collections = 0;
  let itemsView: "full" | "partial" = "full";
  let verifyPartialTurn = false;
  testRuntime.listDirectSubagents = async () => {
    collections++;
    return {
      data: [
        {
          id: childId,
          cwd: root,
          parentThreadId: threadId,
          source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } },
          status: { type: "active", activeFlags: [] },
        },
      ],
      nextCursor: null,
    };
  };
  testRuntime.listSubagentTurns = async () => ({
    data: [
      {
        id: "turn",
        rootTurnId: "turn",
        startedAt: 1794830400,
        itemsView,
        items:
          itemsView === "partial"
            ? [{ type: "subAgentActivity", agentThreadId: childId, kind: "started" }]
            : [
                {
                  type: "collabAgentToolCall",
                  senderThreadId: threadId,
                  receiverThreadIds: [childId],
                  tool: "spawnAgent",
                  status: "completed",
                  startedAtMs: 1794830401000,
                },
              ],
      },
    ],
    nextCursor: null,
  });
  testRuntime.verifyDirectSubagent = async (id, context) => {
    assert.equal(id, childId);
    assert.equal(context.parentThreadId, threadId);
    return verifyPartialTurn
      ? {
          verdict: "in-scope",
          parentThreadId: threadId,
          cwd: root,
          rootTurnId: "turn",
          turnStartedAt: "2026-11-16T12:00:01Z",
        }
      : { verdict: "unknown" };
  };
  const originalGet = KitTaskStore.prototype.get;
  const originalRead = KitTaskStore.prototype.getReadOnly;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  let revision = 1;
  let assignmentId = "old";
  let assignmentSize = 3;
  let explicitlyAssigned = true;
  let childStartedAt = "2026-11-16T12:00:00Z";
  let childProgress = { completed: 2, total: 2, percent: 100 };
  KitTaskStore.prototype.get = async (id) => ({
    schemaVersion: 4,
    kind: "task",
    threadId: id,
    title: "Parent",
    revision,
    createdAt: "2026-11-16T12:00:00Z",
    updatedAt: "2026-11-16T12:00:00Z",
    objectives: [
      {
        id: assignmentId,
        title: "Assigned",
        required: true,
        status: "active",
        evidence: [],
        items: Array.from({ length: assignmentSize }, (_, index) => ({
          id: `${assignmentId}-${index}`,
          title: `Leaf ${index}`,
          status: revision === 1 && index < 2 ? ("completed" as const) : ("pending" as const),
          evidence: [],
        })),
        ...(explicitlyAssigned ? { agent: { threadId: childId } } : {}),
      },
    ],
    progress: { completed: 0, total: 1, percent: 0 },
    phase: "active",
    lifecycle: { id: "cycle", sequence: 1, startedAt: "2026-11-16T12:00:00Z", completion: null },
  });
  let childReadCount = 0;
  KitTaskStore.prototype.getReadOnly = async (id) => {
    if (id === childId) childReadCount++;
    return {
      sourceBound: false,
      uncertain: false,
      state:
        id === childId
          ? ({
              schemaVersion: 4,
              kind: "task",
              threadId: id,
              title: "Prior child",
              revision: 1,
              createdAt: childStartedAt,
              updatedAt: "2026-11-16T12:00:02Z",
              objectives: [
                {
                  id: "child-milestones",
                  title: "Child milestones",
                  required: true,
                  status: "active",
                  evidence: [],
                  items: Array.from({ length: childProgress.total }, (_, index) => ({
                    id: `child-item-${index}`,
                    title: `Milestone ${index + 1}`,
                    status: index < childProgress.completed ? "completed" : "pending",
                    evidence:
                      index < childProgress.completed
                        ? [{ summary: "verified", verification: "verified" }]
                        : [],
                  })),
                },
              ],
              progress: {
                completed: childProgress.completed,
                total: childProgress.total + 1,
                percent:
                  Math.floor((childProgress.completed / (childProgress.total + 1)) * 10_000) / 100,
              },
              phase: "active",
              lifecycle: {
                id: "child-cycle",
                sequence: 1,
                startedAt: childStartedAt,
                completion: null,
              },
            } as never)
          : null,
    };
  };
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const get = async (native = false) =>
    (
      await client.request(
        native
          ? {
              method: "task.native-read",
              params: { action: "get", threadId, input: {} },
            }
          : {
              method: "task.request",
              params: {
                action: "get",
                auth: {
                  kind: "codex-request",
                  toolName: "task_progress_get",
                  identity: {
                    threadId,
                    sessionId: threadId,
                    turnId: "turn",
                    callId: `call-${++call}`,
                    model: "test",
                    threadSource: "user",
                    cwd: root,
                  },
                },
                input: {},
              },
            },
      )
    ).result as {
      subagents: {
        agents: {
          id: string;
          progress: { completed: number; total: number; percent: number | null } | null;
          progressBasis: string | null;
          assignmentTitle?: string | null;
        }[];
      };
    };
  const waitForChildProgress = async (completed: number, native = false) => {
    for (let i = 0; i < 100; i++) {
      const agent = (await get(native)).subagents.agents[0];
      if (
        agent?.progressBasis === "registered-checklist" &&
        agent.progress?.completed === completed
      )
        return agent;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Exact child checklist did not reach the parent presentation");
  };
  try {
    await helper.start();
    let before = await get();
    for (let i = 0; i < 100 && before.subagents.agents[0]?.progress?.total !== 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      before = await get();
    }
    assert.deepEqual(before.subagents.agents[0]?.progress, {
      completed: 2,
      total: 3,
      percent: 66.67,
    });
    assert.equal(before.subagents.agents[0]?.progressBasis, "module-delivery");
    assert.equal(childReadCount, 1);
    const collected = collections;
    const same = await get();
    assert.deepEqual(same.subagents.agents[0]?.progress, before.subagents.agents[0]?.progress);
    assert.equal(collections, collected);
    revision = 2;
    assignmentId = "new";
    const changed = await get();
    assert.equal(collections, collected);
    assert.equal(changed.subagents.agents[0]?.id, childId);
    assert.deepEqual(changed.subagents.agents[0]?.progress, { completed: 0, total: 3, percent: 0 });
    assert.equal(changed.subagents.agents[0]?.progressBasis, "module-delivery");
    assignmentId = "newer";
    const sameRevisionChangedAssignment = await get();
    assert.deepEqual(sameRevisionChangedAssignment.subagents.agents[0]?.progress, {
      completed: 0,
      total: 3,
      percent: 0,
    });
    assert.equal(childReadCount, 1);

    revision++;
    assignmentSize = 1;
    const coarse = (await get()).subagents.agents[0];
    assert.deepEqual(coarse?.progress, { completed: 0, total: 1, percent: 0 });
    assert.equal(coarse?.progressBasis, "module-delivery");

    childStartedAt = "2026-11-16T12:00:02Z";
    childProgress = { completed: 1, total: 3, percent: 33.33 };
    now += 5_001;
    const fine = await waitForChildProgress(1);
    assert.deepEqual(fine.progress, childProgress);
    assert.equal(fine.assignmentTitle, "Leaf 0");

    revision++;
    explicitlyAssigned = false;
    childProgress = { completed: 2, total: 3, percent: 66.67 };
    now += 5_001;
    const unlinked = await waitForChildProgress(2, true);
    assert.deepEqual(unlinked.progress, childProgress);
    assert.equal(unlinked.assignmentTitle, undefined);

    itemsView = "partial";
    now += 5_001;
    const expired = (await get()).subagents.agents[0];
    assert.equal(expired?.id, childId);
    assert.equal(expired?.progress, null);
    const collectedBeforePartial = childReadCount;
    for (let i = 0; i < 5; i++) {
      const partial = (await get(true)).subagents.agents[0];
      assert.equal(partial?.id, childId);
      assert.equal(partial?.progress, null);
    }
    assert.equal(childReadCount, collectedBeforePartial);
    verifyPartialTurn = true;
    now += 5_001;
    const verifiedPartial = await waitForChildProgress(2, true);
    assert.deepEqual(verifiedPartial.progress, childProgress);
  } finally {
    Date.now = originalNow;
    KitTaskStore.prototype.get = originalGet;
    KitTaskStore.prototype.getReadOnly = originalRead;
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent-thread projection requires IDs and verifies paths across root changes", () => {
  const entry = {
    name: "worker",
    state: "working" as const,
    observedAt: null,
    progress: null,
    progressBasis: null,
  };
  const members = [
    { ...entry, id: "old", assignmentEligible: false, agentPath: "/root/old" },
    { ...entry, id: "current", assignmentEligible: true, agentPath: "/root/current" },
    { ...entry, id: "unverified", agentPath: "/root/unknown" },
  ];
  const agents = assignmentProjectionAgents(members, "parent-thread");
  assert.deepEqual(agents, [
    { threadId: "old", path: "/root/old", allowPathOnlyAssignment: false },
    { threadId: "current", path: "/root/current", allowPathOnlyAssignment: false },
  ]);
  const task = {
    objectives: [
      {
        id: "root",
        title: "Assigned",
        required: true,
        status: "active",
        items: [
          { id: "path", title: "Path only", status: "completed", agent: { path: "/root/current" } },
          {
            id: "old",
            title: "Persistent owner",
            status: "pending",
            agent: { threadId: "old", path: "/root/old" },
          },
          {
            id: "conflict",
            title: "Conflicting path",
            status: "completed",
            agent: { threadId: "current", path: "/root/old" },
          },
          {
            id: "foreign",
            title: "Foreign owner",
            status: "completed",
            agent: { threadId: "foreign" },
          },
        ],
      },
    ],
  };
  const projected = projectAgentTaskProgress({ task: task as never, agents });
  assert.deepEqual(projected.find((agent) => agent.threadId === "old")?.assignedTaskIds, ["old"]);
  assert.equal(projected.find((agent) => agent.threadId === "current")?.progress, null);
  // Cached membership may survive a new root: path-only remains disabled even
  // for the member that was eligible in the prior root.
  const afterRootChange = assignmentProjectionAgents(members, "parent-thread");
  assert.deepEqual(afterRootChange, agents);
  assert.equal(
    projectAgentTaskProgress({ task: task as never, agents: afterRootChange }).find(
      (agent) => agent.threadId === "current",
    )?.progress,
    null,
  );
  const strictAgents = assignmentProjectionAgents(members, "parent-root-turn");
  assert.deepEqual(strictAgents, [{ threadId: "current", path: "/root/current" }]);
  assert.deepEqual(
    projectAgentTaskProgress({ task: task as never, agents: strictAgents }).find(
      (agent) => agent.threadId === "current",
    )?.assignedTaskIds,
    ["path"],
  );
  // Even with two active members advertising the same path, neither receives
  // a path-only assignment in a parent-thread snapshot.
  const shared = assignmentProjectionAgents(
    members.slice(0, 2).map((member) => ({ ...member, agentPath: "/root/current" })),
    "parent-thread",
  );
  const objective = task.objectives[0];
  assert.ok(objective);
  const pathItem = objective.items[0];
  assert.ok(pathItem);
  assert.ok(
    projectAgentTaskProgress({
      task: {
        objectives: [{ ...objective, items: [pathItem] }],
      } as never,
      agents: shared,
    }).every((agent) => agent.progress === null),
  );
});

test("assignment overlay prefers only collector-fenced finer child checklists", () => {
  const assignment = {
    threadId: "child",
    progress: { completed: 0, total: 1, percent: 0 },
    basis: "assigned-canonical-leaves" as const,
    assignedTaskIds: ["module"],
    assignmentTitle: "API/UI 修复",
    granularity: "single-item" as const,
  };
  const base = {
    id: "child",
    name: "Display name",
    state: "working" as const,
    observedAt: null,
    progress: null,
    progressBasis: null,
  };
  const coarse = overlayAgentAssignment(base, assignment);
  assert.equal(coarse.progressGranularity, "single-item");
  assert.equal(coarse.assignmentTitle, "API/UI 修复");
  assert.equal(coarse.progressBasis, "module-delivery");
  const fine = overlayAgentAssignment(
    {
      ...base,
      progress: { completed: 2, total: 3, percent: 66.67 },
      progressBasis: "registered-checklist",
    },
    assignment,
  );
  assert.deepEqual(fine.progress, { completed: 2, total: 3, percent: 66.67 });
  assert.equal(fine.progressBasis, "registered-checklist");
  assert.equal(fine.progressGranularity, "checklist");
  assert.equal(fine.assignmentTitle, "API/UI 修复");
  const unverified = overlayAgentAssignment(
    { ...base, progress: { completed: 2, total: 3, percent: 66.67 }, progressBasis: null },
    assignment,
  );
  assert.deepEqual(unverified.progress, assignment.progress);
  assert.equal(unverified.progressGranularity, "single-item");
  assert.equal(overlayAgentAssignment(base, undefined), base);
});

test("parent activity IDs use direct identity lookup during an incomplete catalog", async () => {
  const root = await mkdtemp("/tmp/ctph-direct-agents-");
  await mkdir(join(root, ".git"));
  const testRuntime = runtime(root);
  const children = (parent: string) =>
    Array.from({ length: 18 }, (_, index) => `${parent}-child-${index}`);
  const childIdentity = (parent: string, child: string) => ({
    ...identity(child, root),
    parentThreadId: parent,
    source: {
      subAgent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${child}` } },
    },
    status: { type: "active" as const, activeFlags: [] },
  });
  const lookupCalls: string[] = [];
  testRuntime.readThreadIdentity = async (threadId) => {
    const match = /^(good|bad)-child-(\d+)$/.exec(threadId);
    if (!match) return identity(threadId, root);
    lookupCalls.push(threadId);
    return childIdentity(
      match[1] === "bad" && match[2] === "17" ? "foreign" : (match[1] ?? ""),
      threadId,
    );
  };
  testRuntime.listDirectSubagents = async (parent, cursor) => ({
    data: cursor
      ? []
      : children(parent)
          .slice(0, 12)
          .map((id) => childIdentity(parent, id)),
    nextCursor: cursor ? `${cursor}-next` : "more",
  });
  testRuntime.listSubagentTurns = async (parent) => ({
    data: [
      {
        id: "root-turn",
        rootTurnId: "root-turn",
        startedAt: 1794830400,
        itemsView: "full",
        items: [
          {
            type: "collabAgentToolCall",
            senderThreadId: parent,
            receiverThreadIds: children(parent),
            tool: "spawnAgent",
            status: "completed",
          },
        ],
      },
    ],
    nextCursor: null,
  });
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  type Result = {
    subagents: {
      complete: boolean;
      observedRunningCount?: number | null;
      agents: { id: string; state: string }[];
    };
  };
  let call = 0;
  const read = async (parent: string, native: boolean): Promise<Result> =>
    (
      await client.request(
        native
          ? { method: "task.native-read", params: { action: "get", threadId: parent, input: {} } }
          : {
              method: "task.request",
              params: {
                action: "get",
                input: {},
                auth: {
                  kind: "codex-request",
                  toolName: "task_progress_get",
                  identity: {
                    threadId: parent,
                    sessionId: parent,
                    turnId: "turn-1",
                    callId: `direct-${++call}`,
                    model: "test",
                    threadSource: "user",
                    cwd: root,
                  },
                },
              },
            },
      )
    ).result as Result;
  const waitFor = async (parent: string, native: boolean, expected: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await read(parent, native);
      if (result.subagents.agents.length === expected) return result;
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
    }
    assert.fail(`expected ${expected} admitted agents`);
  };
  try {
    await helper.start();
    const native = await waitFor("good", true, 18);
    assert.equal(native.subagents.complete, false);
    assert.equal(native.subagents.observedRunningCount, 18);
    assert.ok(native.subagents.agents.every((agent) => agent.state === "working"));
    const full = await waitFor("good", false, 18);
    assert.equal(full.subagents.observedRunningCount, 18);
    assert.ok(
      children("good")
        .slice(12)
        .every((id) => lookupCalls.includes(id)),
    );
    const rejected = await waitFor("bad", true, 17);
    assert.equal(rejected.subagents.complete, false);
    assert.equal(rejected.subagents.observedRunningCount, 17);
    assert.ok(!rejected.subagents.agents.some((agent) => agent.id === "bad-child-17"));
  } finally {
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("another chat's writes and disabled polls preserve a warm agent snapshot during refresh", async () => {
  const rootA = await mkdtemp("/tmp/ctph-scope-a-");
  const rootB = await mkdtemp("/tmp/ctph-scope-b-");
  await Promise.all([
    mkdir(join(rootA, ".git")),
    mkdir(join(rootB, ".git")),
    mkdir(join(rootB, ".vibe-coding")),
  ]);
  const mocked = runtime(rootA);
  mocked.readThreadIdentity = async (id) => identity(id, id === "chat-B" ? rootB : rootA);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let aCollections = 0;
  let holdA = false;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  mocked.listDirectSubagents = async (parent) => {
    if (parent === "chat-A") {
      aCollections++;
      if (holdA) await gate;
    }
    return {
      data: [
        {
          id: `${parent}-child`,
          cwd: parent === "chat-A" ? rootA : rootB,
          source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
          status: { type: "active", activeFlags: [] },
        },
      ],
      nextCursor: null,
    };
  };
  mocked.listSubagentTurns = async (parent) => ({
    data: [
      {
        id: "turn",
        rootTurnId: "turn",
        startedAt: 1794830401,
        itemsView: "full",
        items: [
          {
            type: "collabAgentToolCall",
            senderThreadId: parent,
            receiverThreadIds: [`${parent}-child`],
            tool: "spawnAgent",
            status: "completed",
          },
        ],
      },
    ],
    nextCursor: null,
  });
  const helper = new GoalProgressHelper({
    paths: resolveGoalProgressPaths({ root: join(rootA, "data") }),
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(helper.paths.helperSocketPath, { clientKind: "mcp" });
  let call = 0;
  const model = async (action: "initialize" | "update", input: unknown) =>
    client.request({
      method: "task.request",
      params: {
        action,
        input,
        auth: {
          kind: "codex-request",
          toolName: `task_progress_${action}`,
          identity: {
            threadId: "chat-B",
            sessionId: "chat-B",
            turnId: "turn",
            callId: `b-${++call}`,
            model: "test",
            threadSource: "user",
            cwd: rootB,
          },
        },
      },
    });
  type View = {
    enabled?: boolean;
    subagents?: { status?: string; complete?: boolean; agents: { id: string }[] };
  };
  const native = async (threadId: string) =>
    (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId, input: {} },
      })
    ).result as View;
  try {
    await helper.start();
    await model("initialize", {
      requestId: "init",
      expectedRevision: 0,
      reason: "start",
      title: "B",
      objectives: [{ id: "b", title: "B" }],
    });
    let warmed: View = {};
    for (let i = 0; i < 100; i++) {
      warmed = await native("chat-A");
      if (
        warmed.subagents?.status === "ready" &&
        warmed.subagents.complete &&
        warmed.subagents.agents.some((entry) => entry.id === "chat-A-child")
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(
      warmed.subagents?.agents.map((entry) => entry.id),
      ["chat-A-child"],
    );
    assert.equal(warmed.subagents?.complete, true);
    holdA = true;
    now += 5_001;
    const warmCalls = aCollections;
    assert.deepEqual(
      (await native("chat-A")).subagents?.agents.map((entry) => entry.id),
      ["chat-A-child"],
    );
    for (let i = 0; i < 100 && aCollections === warmCalls; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(aCollections > warmCalls);
    await model("update", {
      requestId: "update",
      expectedRevision: 1,
      reason: "start work",
      changes: [{ targetId: "b", status: "active" }],
    });
    assert.deepEqual(
      (await native("chat-A")).subagents?.agents.map((entry) => entry.id),
      ["chat-A-child"],
    );
    await writeFile(
      join(rootB, ".vibe-coding", "project.config.json"),
      JSON.stringify({ optional: { "task-progress": false } }),
    );
    for (let i = 0; i < 3; i++) {
      assert.equal((await native("chat-B")).enabled, false);
      assert.deepEqual(
        (await native("chat-A")).subagents?.agents.map((entry) => entry.id),
        ["chat-A-child"],
      );
    }
    release();
    let a: View = {};
    for (let i = 0; i < 100; i++) {
      a = await native("chat-A");
      if (a.subagents?.agents.some((entry) => entry.id === "chat-A-child")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(
      a.subagents?.agents.map((entry) => entry.id),
      ["chat-A-child"],
    );
  } finally {
    release();
    Date.now = realNow;
    await helper.stop();
    await Promise.all([
      rm(rootA, { recursive: true, force: true }),
      rm(rootB, { recursive: true, force: true }),
    ]);
  }
});

test("disabling the same chat fences its older in-flight agent result", async () => {
  const root = await mkdtemp("/tmp/ctph-scope-own-");
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".vibe-coding"));
  const mocked = runtime(root);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  mocked.listDirectSubagents = async (parent) => {
    const first = calls++ === 0;
    if (first) await gate;
    return {
      data: [
        {
          id: first ? "stale-child" : "fresh-child",
          cwd: root,
          source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
          status: { type: "active", activeFlags: [] },
        },
      ],
      nextCursor: null,
    };
  };
  mocked.listSubagentTurns = async () => ({
    data: [{ id: "turn", rootTurnId: "turn", startedAt: 1794830401, itemsView: "full", items: [] }],
    nextCursor: null,
  });
  const helper = new GoalProgressHelper({
    paths: resolveGoalProgressPaths({ root: join(root, "data") }),
    runtime: mocked,
    resolveNativeGoal: async () => null,
  });
  const client = new GoalProgressIpcClient(helper.paths.helperSocketPath, { clientKind: "mcp" });
  type View = { enabled?: boolean; subagents?: { agents: { id: string }[] } };
  const native = async () =>
    (
      await client.request({
        method: "task.native-read",
        params: { action: "get", threadId: "chat", input: {} },
      })
    ).result as View;
  try {
    await helper.start();
    for (let i = 0; i < 100 && calls === 0; i++) {
      await native();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls, 1);
    await writeFile(
      join(root, ".vibe-coding", "project.config.json"),
      JSON.stringify({ optional: { "task-progress": false } }),
    );
    assert.equal((await native()).enabled, false);
    await writeFile(
      join(root, ".vibe-coding", "project.config.json"),
      JSON.stringify({ optional: { "task-progress": true } }),
    );
    release();
    let result: View = {};
    for (let i = 0; i < 100; i++) {
      result = await native();
      if (result.subagents?.agents.some((entry) => entry.id === "fresh-child")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(
      result.subagents?.agents.map((entry) => entry.id),
      ["fresh-child"],
    );
  } finally {
    release();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});
