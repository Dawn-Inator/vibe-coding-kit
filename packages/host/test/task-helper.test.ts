import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    const projectHeartbeat = (await request("get", {}, "inventory-chat")).result as {
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
      `export function inspectHeartbeatLedger(text, {mode}) { const items=text.includes('large-source')?Array.from({length:2500},(_,i)=>({id:i===0?'H'+('x'.repeat(200)):'H'+i,item:'Source item '+i,status:i%2?'blocked':'done',evidence:'Evidence '+i,line:i+1})): [{id:'H1',item:'Source task',status:'blocked',evidence:'Waiting',line:7}]; return {mode, certifiesCurrent: mode==='current', passed:true, wakeCount:1, itemCount:items.length, wakes:[{heading:'wake',timeMs:1794391200000,rows:[]}], items, findings:[]}; }`,
    );
    await writeFile(ledgerPath, ledger);
    const canonicalLedgerPath = await realpath(ledgerPath);
    await request("bind-heartbeat", { path: ledgerPath });
    const localEventsPath = eventPath(
      join(await realpath(root), ".workspace", "codex-task-progress"),
      "source-chat",
    );
    const before = await readFile(localEventsPath, "utf8");
    const projected = (await request("get", {})).result as {
      task: TaskState & {
        source: {
          itemStatusCount: number;
          itemStatuses: Record<string, string>;
          presentation: { truncated: boolean; sourceItemCount: number; displayedItemCount: number };
        };
      };
      taskSource: { status: string; path: string; readOnly: boolean };
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
    assert.equal(await readFile(localEventsPath, "utf8"), before);
    const history = (await request("history", {})).result as {
      history: { events: unknown[]; source: { path: string; readOnly: boolean } };
    };
    assert.deepEqual(history.history.events, []);
    assert.equal(history.history.source.path, canonicalLedgerPath);
    assert.equal(history.history.source.readOnly, true);
    await request("bind-heartbeat", { path: null });
    const restored = (await request("get", {})).result as { task: TaskState };
    assert.equal(restored.task.title, "Dormant local task");
    assert.equal(await readFile(localEventsPath, "utf8"), before);
    assert.equal(await readFile(ledgerPath, "utf8"), ledger);

    await rm(ledgerPath);
    const ambiguousLedger = ledger
      .replaceAll("source-chat", "ambiguous-chat")
      .replace("<!-- large-source -->\n", "");
    await writeFile(join(root, "heartbeat-one.md"), ambiguousLedger);
    await writeFile(join(root, "heartbeat-two.md"), ambiguousLedger);
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
    const ambiguous = (await request("get", {}, "ambiguous-chat")).result as {
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
      JSON.stringify({ heartbeat: { kitPath: "kit/heartbeat-ledger-api.mjs", maxFiles: 1 } }),
    );
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
    assert.ok(
      bounded.heartbeat.sourcePath,
      "project Heartbeat displays independently of ambiguous chat-task association",
    );
    assert.match(bounded.heartbeat.warning ?? "", /discovery was incomplete/);
    assert.match(bounded.taskSource.error ?? "", /incomplete/);
  } finally {
    await helper.stop();
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
    action: "initialize" | "update" | "get" | "bind-heartbeat" | "heartbeat-history",
    input: unknown,
    threadId = "sticky-chat",
  ) {
    const toolNames = {
      initialize: "task_progress_initialize",
      update: "task_progress_update",
      get: "task_progress_get",
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
  const localEvents = eventPath(
    join(await realpath(root), ".workspace", "codex-task-progress"),
    "sticky-chat",
  );
  const original =
    "# Supervision\nthread: sticky-chat\n## 2026-11-11T10:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| H1 | request | Source task | blocked | Waiting |\n";
  let reopened: GoalProgressHelper | undefined;
  let canonicalSourcePath: string | undefined;
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
      `export function inspectHeartbeatLedger(text,{mode}) { return { mode, certifiesCurrent:true, passed:true, wakes:[{heading:"wake",timeMs:1794391200000,rows:[]}], items:[{id:"H1",source:"request",item:"Source task",status:"blocked",evidence:"Waiting",line:6}], findings:[]}; }`,
    );
    await writeFile(join(root, "heartbeat-A.md"), original);
    await writeFile(
      join(root, "heartbeat-B.md"),
      original.replace("sticky-chat", "unrelated-chat"),
    );
    await helper.start();
    const initial = (await request("get", {})).result as {
      taskSource: { status: string; path: string };
      heartbeat: { status: string; sourcePath: string | null; basis?: string };
    };
    assert.equal(initial.taskSource.status, "ready");
    assert.equal(initial.heartbeat.status, "ready");
    canonicalSourcePath = await realpath(join(root, "heartbeat-A.md"));
    assert.equal(initial.taskSource.path, canonicalSourcePath);
    assert.equal(
      await readFile(join(root, ".workspace", "codex-task-progress", ".gitignore"), "utf8"),
      "*\n",
    );
    const before = await readFile(localEvents, "utf8");
    const projectHistory = (await request("heartbeat-history", { limit: 1 })).result as {
      heartbeatHistory: { sourcePath: string | null };
    };
    assert.equal(projectHistory.heartbeatHistory.sourcePath, canonicalSourcePath);
    await writeFile(join(root, "heartbeat-A.md"), original.replace("sticky-chat", "other-chat"));
    await writeFile(join(root, "heartbeat-C.md"), original);
    const stale = (await request("get", {})).result as {
      task: TaskState | null;
      taskSource: { status: string; path: string };
    };
    assert.equal(stale.task, null);
    assert.equal(stale.taskSource.status, "stale");
    assert.equal(stale.taskSource.path, canonicalSourcePath);
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
    assert.equal(await readFile(localEvents, "utf8"), before);
    await rm(join(root, ".workspace", "codex-task-progress", ".gitignore"));
    await writeFile(
      join(root, "heartbeat-fresh.md"),
      original.replaceAll("sticky-chat", "fresh-chat"),
    );
    const fresh = (await request("get", {}, "fresh-chat")).result as {
      task: (TaskState & { source?: { kind: string; path: string; readOnly: boolean } }) | null;
      taskSource: { status: string };
    };
    assert.equal(fresh.task?.source?.kind, "kit-heartbeat");
    assert.equal(fresh.task?.source?.readOnly, true);
    assert.equal(fresh.task?.source?.path, await realpath(join(root, "heartbeat-fresh.md")));
    assert.equal(fresh.taskSource.status, "ready");
    await assert.rejects(
      readFile(
        eventPath(join(await realpath(root), ".workspace", "codex-task-progress"), "fresh-chat"),
      ),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(join(root, ".workspace", "codex-task-progress", ".gitignore"), "utf8"),
      "*\n",
    );
    await restartHelper.stop();
  } finally {
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
