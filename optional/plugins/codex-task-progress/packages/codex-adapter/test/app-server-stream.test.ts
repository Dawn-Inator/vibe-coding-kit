import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  CodexAppServerClient,
  type CodexAppServerSession,
  createCodexAppServerRuntime,
} from "../src/index.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function clientFor(
  script: string,
  options: { requestTimeoutMs?: number; outputMode?: "bounded" | "stream" } = {},
) {
  return CodexAppServerClient.connect({
    command: process.execPath,
    args: ["-e", script],
    ...(options.outputMode === undefined ? {} : { outputMode: options.outputMode }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

function responderScript(body: string): string {
  return `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
      } else if (request.method === "initialized") {
        ${body}
      }
    });
  `;
}

test("stream mode accepts multiple complete messages whose total exceeds 4 MiB", async () => {
  const script = responderScript(`
    const payload = "x".repeat(60_000);
    for (let index = 0; index < 72; index += 1) {
      process.stdout.write(JSON.stringify({ method: "test/notice", params: { payload } }) + "\\n");
    }
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "thread/turns/list") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  try {
    assert.ok(72 * 60_000 > MAX_OUTPUT_BYTES);
    assert.deepEqual(await client.listTurnIds("thread-a"), []);
    assert.equal(client.failed, undefined);
    assert.equal(client.notificationMethods.length, 72);
  } finally {
    await client.close();
  }
});

test("stream mode keeps retained notification history bounded", async () => {
  const script = responderScript(`
    for (let index = 0; index < 300; index += 1) {
      process.stdout.write(JSON.stringify({ method: "test/notice", params: { index } }) + "\\n");
    }
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "thread/turns/list") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  try {
    assert.deepEqual(await client.listTurnIds("thread-a"), []);
    assert.equal(client.notificationMethods.length, 256);
    assert.equal(client.notificationMethods.at(-1), "test/notice");
  } finally {
    await client.close();
  }
});

test("large notification fields obey history byte budgets while callbacks keep full values", async () => {
  const script = responderScript(`
    const total = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 };
    for (let index = 0; index < 8; index += 1) {
      const suffix = String(index);
      const method = "m".repeat(48_000) + suffix;
      const threadId = "t".repeat(48_000) + suffix;
      process.stdout.write(JSON.stringify({ method, params: { threadId } }) + "\\n");
    }
    for (let index = 0; index < 8; index += 1) {
      const suffix = String(index);
      const threadId = "T".repeat(40_000) + suffix;
      const turnId = "u".repeat(40_000) + suffix;
      process.stdout.write(JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: { total, last: total } },
      }) + "\\n");
    }
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "thread/turns/list") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\\n");
      }
    });
  `);
  const callbacks: { method: string; threadId?: string }[] = [];
  const client = await CodexAppServerClient.connect({
    command: process.execPath,
    args: ["-e", script],
    outputMode: "stream",
    onNotification: (notification) => callbacks.push(notification),
  });
  try {
    assert.deepEqual(await client.listTurnIds("thread-a"), []);
    assert.ok(Buffer.byteLength(JSON.stringify(client.notifications)) <= 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(client.tokenUsageNotifications)) <= 256 * 1024);
    assert.equal(callbacks.length, 16);
    const largeMethodCallback = callbacks.find((notification) =>
      notification.method.startsWith("m"),
    );
    assert.equal(largeMethodCallback?.method.length, 48_001);
    assert.equal(largeMethodCallback?.threadId?.length, 48_001);
    assert.equal(client.tokenUsageNotifications.at(-1)?.threadId.length, 40_001);
  } finally {
    await client.close();
  }
});

test("stream mode rejects an oversized complete frame", async () => {
  const script = responderScript(`
    process.stdout.write(JSON.stringify({ method: "test/notice", params: { payload: "x".repeat(${MAX_OUTPUT_BYTES}) } }) + "\\n");
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_OUTPUT_LIMIT");
});

test("stream mode rejects an oversized frame that never closes", async () => {
  const script = responderScript(`
    process.stdout.write('{"method":"test/notice","params":{"payload":"' + "x".repeat(${MAX_OUTPUT_BYTES}) );
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_OUTPUT_LIMIT");
});

test("stream decoder preserves UTF-8 characters split across child writes", async () => {
  const script = responderScript(`
    const message = Buffer.from(JSON.stringify({ method: "test/utf8", params: { value: "emoji 😀" } }) + "\\n");
    const split = message.indexOf(Buffer.from("😀")) + 2;
    process.stdout.write(message.subarray(0, split));
    process.stdout.write(message.subarray(split));
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "thread/turns/list") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  try {
    assert.deepEqual(await client.listTurnIds("thread-a"), []);
    assert.deepEqual(client.notificationMethods, ["test/utf8"]);
    assert.equal(client.failed, undefined);
  } finally {
    await client.close();
  }
});

test("late response after timeout is ignored and a later response still resolves", async () => {
  const notifications = new Map<string, () => void>();
  const waitForNotification = (method: string) =>
    new Promise<void>((resolve) => notifications.set(method, resolve));
  const firstRequestReceived = waitForNotification("test/first-request-received");
  const lateResponseSent = waitForNotification("test/late-response-sent");
  const script = responderScript(`
    let count = 0;
    let timedOutRequest;
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method !== "thread/turns/list") return;
      count += 1;
      if (count === 1) {
        timedOutRequest = request;
        process.stdout.write(JSON.stringify({ method: "test/first-request-received" }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ id: "turn-b" }] } }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ id: timedOutRequest.id, result: { data: [] } }) + "\\n");
          process.stdout.write(JSON.stringify({ method: "test/late-response-sent" }) + "\\n");
        }, 25);
      }
    });
  `);
  const client = await CodexAppServerClient.connect({
    command: process.execPath,
    args: ["-e", script],
    outputMode: "stream",
    onNotification: (notification) => notifications.get(notification.method)?.(),
  });
  let fakeTimersEnabled = false;
  try {
    // Initialization uses the real default timeout. Fake time begins only after
    // the child confirms the targeted request is in flight.
    mock.timers.enable({ apis: ["setTimeout"] });
    fakeTimersEnabled = true;
    const firstRequest = client.listTurnIds("thread-a");
    await firstRequestReceived;
    mock.timers.tick(10_000);
    await assert.rejects(firstRequest, /GOAL_PROGRESS_APP_SERVER_TIMEOUT/);
    assert.deepEqual(await client.listTurnIds("thread-a"), ["turn-b"]);
    await lateResponseSent;
    assert.equal(client.failed, undefined);
  } finally {
    if (fakeTimersEnabled) mock.timers.reset();
    await client.close();
  }
});

test("fully unknown response id still fails closed", async () => {
  const script = responderScript(`
    process.stdout.write(JSON.stringify({ id: 999, result: {} }) + "\\n");
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_UNEXPECTED_MESSAGE");
});

test("invalid JSON still fails closed", async () => {
  const script = responderScript(`
    process.stdout.write("not-json\\n");
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_INVALID_JSON");
});

test("unapproved server request still fails closed", async () => {
  const script = responderScript(`
    process.stdout.write(JSON.stringify({ id: "server-1", method: "thread/start", params: {} }) + "\\n");
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_UNEXPECTED_REQUEST: thread/start");
});

test("default bounded mode retains the cumulative 4 MiB output cap", async () => {
  const script = responderScript(`
    const payload = "x".repeat(60_000);
    for (let index = 0; index < 72; index += 1) {
      process.stdout.write(JSON.stringify({ method: "test/notice", params: { payload } }) + "\\n");
    }
  `);
  const client = await clientFor(script);
  await client.closed;
  assert.equal(client.failed?.message, "GOAL_PROGRESS_APP_SERVER_OUTPUT_LIMIT");
});

test("direct subagent listing requests bounded parent-scoped children by latest update", async () => {
  const script = responderScript(`
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "thread/list") {
        const p = request.params;
        const valid = p.parentThreadId === "parent" && p.cursor === "next" && p.limit === 50 && p.useStateDbOnly === true && p.sortKey === "updated_at" && p.sortDirection === "desc" &&
          JSON.stringify(p.sourceKinds) === JSON.stringify(["subAgentThreadSpawn"]);
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: valid ? [{ id: "older-active", createdAt: 100, updatedAt: 300 }, { id: "newer-idle", createdAt: 200, updatedAt: 200 }] : [], nextCursor: null } }) + "\\n");
      }
    });
  `);
  const client = await clientFor(script);
  try {
    assert.deepEqual(await client.listDirectSubagents("parent", "next"), {
      data: [
        { id: "older-active", createdAt: 100, updatedAt: 300 },
        { id: "newer-idle", createdAt: 200, updatedAt: 200 },
      ],
      nextCursor: null,
    });
  } finally {
    await client.close();
  }
});

test("parent turn summaries hydrate bounded deferred item pages in chronological order", async () => {
  const script = responderScript(`
    input.on("line", (line) => {
      const request = JSON.parse(line); const p = request.params;
      if (request.method === "thread/turns/list") {
        if (p.itemsView !== "summary" || p.limit !== 2 || p.cursor !== "outer") process.exit(2);
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [
          { id: "continuation", rootTurnId: "root", startedAt: 124, itemsView: "summary", items: [] },
          { id: "older-root", rootTurnId: "older-root", startedAt: 120, itemsView: "summary", items: [] }
        ], nextCursor: "next-turns" } }) + "\\n");
      } else if (request.method === "thread/items/list") {
        if (p.threadId !== "p" || p.turnId !== "continuation" || p.limit !== 30 || p.sortDirection !== "desc" || !p.deferOutput.commandExecution || !p.deferOutput.mcpToolCall) process.exit(3);
        const newer = [
          {turnId:"continuation", startedAtMs:3000, item:{id:"b",type:"subAgentActivity",agentThreadId:"c",kind:"completed",agentPath:"/root/c"}},
          {turnId:"continuation", startedAtMs:2500, item:{id:"huge",type:"commandExecution",aggregatedOutput:"private".repeat(500000)}}
        ];
        const older = [{turnId:"continuation",startedAtMs:2000,item:{id:"a",type:"collabAgentToolCall",senderThreadId:"p",receiverThreadIds:["c"],tool:"spawnAgent",status:"completed",prompt:"private"}}];
        // The server honors deferred output instead of returning the huge text.
        if (!p.cursor) newer[1].item.aggregatedOutput = null;
        process.stdout.write(JSON.stringify({id:request.id,result:{data:p.cursor ? older : newer,nextCursor:p.cursor ? null : "older",backwardsCursor:null}})+"\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  try {
    const result = await client.listSubagentTurns("p", "outer");
    assert.equal(result.nextCursor, "next-turns");
    assert.equal(result.data.length, 2);
    const [current, differentRoot] = result.data as Array<{
      itemsView: string;
      items: Array<Record<string, unknown>>;
    }>;
    assert.ok(current);
    assert.ok(differentRoot);
    assert.equal(current.itemsView, "full");
    assert.deepEqual(
      current.items.map((item) => [item.type, item.startedAtMs]),
      [
        ["collabAgentToolCall", 2000],
        ["subAgentActivity", 3000],
      ],
    );
    assert.equal(current.items[1]?.agentPath, "/root/c");
    const firstItem = current.items[0];
    assert.ok(firstItem);
    assert.deepEqual(firstItem.receiverThreadIds, ["c"]);
    assert.equal(differentRoot.itemsView, "partial");
    assert.deepEqual(differentRoot.items, []);
    assert.equal(JSON.stringify(result).includes("private"), false);
  } finally {
    await client.close();
  }
});

test("item page budget returns a partial view without pretending older items were read", async () => {
  const script = responderScript(`
    input.on("line", line => {
      const q=JSON.parse(line);
      if(q.method === "thread/turns/list") process.stdout.write(JSON.stringify({id:q.id,result:{data:[{id:"t",rootTurnId:"t",startedAt:1}],nextCursor:null}})+"\\n");
      if(q.method === "thread/items/list") {
        const n=q.params.cursor ? Number(q.params.cursor) : 0;
        if(n>=16) process.exit(2);
        process.stdout.write(JSON.stringify({id:q.id,result:{data:[{turnId:"t",startedAtMs:100-n,item:{id:"i"+n,type:"subAgentActivity",agentThreadId:"c",kind:"interacted"}}],nextCursor:String(n+1)}})+"\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream" });
  try {
    const result = await client.listSubagentTurns("p");
    const turn = result.data[0] as { itemsView: string; items: Array<{ startedAtMs: number }> };
    assert.equal(turn.itemsView, "partial");
    assert.deepEqual(
      turn.items.map((item) => item.startedAtMs),
      Array.from({ length: 16 }, (_, i) => 85 + i),
    );
  } finally {
    await client.close();
  }
});

test("item identity, cursor loops and unsupported methods fail closed", async () => {
  for (const mode of ["wrong-turn", "duplicate-id", "repeated-cursor", "unsupported"]) {
    const script = responderScript(`
      const mode=${JSON.stringify(mode)};
      input.on("line", line => {
        const q=JSON.parse(line);
        if(q.method === "thread/turns/list") process.stdout.write(JSON.stringify({id:q.id,result:{data:[{id:"t",rootTurnId:"t",startedAt:1}],nextCursor:null}})+"\\n");
        if(q.method === "thread/items/list") {
          if(mode === "unsupported") return void process.stdout.write(JSON.stringify({id:q.id,error:{code:-32601,message:"method not found"}})+"\\n");
          const item={id:mode === "duplicate-id" ? "same" : (q.params.cursor ? "second" : "first"),type:"subAgentActivity",agentThreadId:"c",kind:"started"};
          process.stdout.write(JSON.stringify({id:q.id,result:{data:[{turnId:mode === "wrong-turn" ? "foreign" : "t",item}],nextCursor:mode === "wrong-turn" ? null : "again"}})+"\\n");
        }
      });
    `);
    const client = await clientFor(script, { outputMode: "stream" });
    try {
      await assert.rejects(client.listSubagentTurns("p"));
    } finally {
      await client.close();
    }
  }
});

test("child observation metadata uses only public thread identity and latest turn summary", async () => {
  const script = responderScript(`
    input.on("line", line => {
      const q=JSON.parse(line);
      if(q.method === "thread/read") {
        if(q.params.includeTurns !== false) process.exit(2);
        process.stdout.write(JSON.stringify({id:q.id,result:{thread:{id:q.params.threadId,path:"/codex/sessions/child.jsonl",cwd:"/workspace",...(q.params.threadId === "mismatch" ? {parentThreadId:"other"} : q.params.threadId === "malformed" ? {parentThreadId:42} : q.params.threadId === "padded" ? {parentThreadId:" parent "} : {parentThreadId:"parent"}),source:{subAgent:{thread_spawn:{parent_thread_id:q.params.threadId === "wrong" ? "other" : "parent"}}},privateText:"must not escape"}}})+"\\n");
      } else if(q.method === "thread/turns/list") {
        if(q.params.threadId !== "child" || q.params.limit !== 1 || q.params.itemsView !== "summary" || q.params.sortDirection !== "desc") process.exit(3);
        process.stdout.write(JSON.stringify({id:q.id,result:{data:[{id:"turn",rootTurnId:"root",startedAt:1794830400,items:[{privateText:"must not escape"}]}],nextCursor:null}})+"\\n");
      } else process.exit(4);
    });
  `);
  const client = await clientFor(script);
  try {
    const result = await client.readSubagentObservationMetadata("child", "parent");
    assert.deepEqual(result, {
      path: "/codex/sessions/child.jsonl",
      cwd: "/workspace",
      turnId: "turn",
      rootTurnId: "root",
      turnStartedAt: new Date(1794830400000).toISOString(),
    });
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(await client.readSubagentObservationMetadata("wrong", "parent"), null);
    for (const id of ["mismatch", "malformed", "padded"])
      assert.equal(await client.readSubagentObservationMetadata(id, "parent"), null);
  } finally {
    await client.close();
  }
});

test("runtime wraps verified child metadata and records exact current-turn rollout events", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-wrapper-")));
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project);
  await mkdir(sessions);
  const path = join(sessions, "child.jsonl");
  const timestamp = "2026-11-16T12:00:00.000Z";
  const metadata = {
    path,
    cwd: project,
    turnId: "child-turn",
    rootTurnId: "parent-root",
    turnStartedAt: timestamp,
  };
  const header = {
    type: "session_meta",
    payload: {
      id: "child",
      cwd: project,
      source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
    },
  };
  const event = (type: string, at: string) => ({
    type: "event_msg",
    timestamp: at,
    payload: { type, turn_id: "child-turn", root_turn_id: "parent-root" },
  });
  const write = async (events: unknown[]) =>
    writeFile(path, `${[header, ...events].map((item) => JSON.stringify(item)).join("\n")}\n`);
  await write([event("task_started", "2026-11-16T12:00:01.000Z")]);
  const session = {
    closed: new Promise<void>(() => {}),
    requestMethods: [],
    readSubagentObservationMetadata: async (id: string, parent: string) =>
      id === "child" && parent === "parent" ? metadata : null,
    close: async () => {},
  } as unknown as CodexAppServerSession;
  const runtime = createCodexAppServerRuntime({
    env: { CODEX_HOME: root },
    connect: async () => session,
  });
  const context = {
    parentThreadId: "parent",
    cwd: project,
    rootTurnId: "parent-root",
    rootTurnStartedAt: timestamp,
  };
  try {
    assert.deepEqual(await runtime.verifyDirectSubagent?.("child", context), {
      verdict: "in-scope",
      parentThreadId: "parent",
      cwd: project,
      rootTurnId: "parent-root",
      turnStartedAt: timestamp,
    });
    const working = await runtime.observeDirectSubagent?.("child", context);
    assert.equal(working?.state, "working");
    assert.equal(working?.basis, "codex-rollout");
    assert.equal(
      (
        await runtime.observeDirectSubagent?.("child", {
          parentThreadId: "parent",
          cwd: project,
          activityScope: "parent-thread",
        })
      )?.state,
      "working",
    );
    assert.equal(
      (await runtime.observeDirectSubagent?.("child", { ...context, rootTurnId: "another-root" }))
        ?.state,
      "unknown",
    );
    await write([
      event("task_started", "2026-11-16T12:00:01.000Z"),
      event("task_complete", "2026-11-16T12:00:02.000Z"),
    ]);
    assert.equal((await runtime.observeDirectSubagent?.("child", context))?.state, "completed");
    assert.equal(
      (await runtime.verifyDirectSubagent?.("child", { ...context, rootTurnId: "older-root" }))
        ?.verdict,
      "out-of-scope",
    );
    assert.equal(
      (await runtime.observeDirectSubagent?.("child", { ...context, parentThreadId: "wrong" }))
        ?.state,
      "unknown",
    );
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, "{}");
    metadata.path = outside;
    assert.ok(await runtime.verifyDirectSubagent?.("child", context));
    assert.equal((await runtime.observeDirectSubagent?.("child", context))?.state, "unknown");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("production runtime observes a verified rollout through public app-server transport", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-public-runtime-")));
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessions);
  const path = join(sessions, "child.jsonl");
  const start = "2026-11-16T12:00:00.000Z";
  const header = {
    type: "session_meta",
    payload: {
      id: "child",
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
    },
  };
  const event = {
    type: "event_msg",
    timestamp: "2026-11-16T12:00:01.000Z",
    payload: { type: "task_started", turn_id: "child-turn", root_turn_id: "parent-root" },
  };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`);
  const script = responderScript(`
    input.on("line", (line) => {
      const q = JSON.parse(line);
      if (q.method === "thread/read") {
        if (q.params.threadId !== "child" || q.params.includeTurns !== false) process.exit(2);
        process.stdout.write(JSON.stringify({ id:q.id, result:{ thread:{ id:"child", path:${JSON.stringify(path)}, cwd:${JSON.stringify(cwd)}, source:{subAgent:{thread_spawn:{parent_thread_id:"parent"}}} } } }) + "\\n");
      } else if (q.method === "thread/turns/list") {
        if (q.params.threadId !== "child" || q.params.limit !== 1 || q.params.itemsView !== "summary") process.exit(3);
        process.stdout.write(JSON.stringify({ id:q.id, result:{ data:[{id:"child-turn",rootTurnId:"parent-root",startedAt:1794830400}], nextCursor:null } }) + "\\n");
      } else process.exit(4);
    });
  `);
  const runtime = createCodexAppServerRuntime({
    command: process.execPath,
    args: ["-e", script],
    env: { ...process.env, CODEX_HOME: root },
  });
  const context = {
    parentThreadId: "parent",
    cwd,
    rootTurnId: "parent-root",
    rootTurnStartedAt: start,
  };
  try {
    const proof = await runtime.verifyDirectSubagent?.("child", context);
    assert.equal(proof?.verdict, "in-scope");
    assert.equal(proof && "rootTurnId" in proof ? proof.rootTurnId : null, "parent-root");
    const observation = await runtime.observeDirectSubagent?.("child", context);
    assert.equal(observation?.state, "working");
    assert.equal(observation?.basis, "codex-rollout");
    assert.equal(observation?.observedAt, "2026-11-16T12:00:01.000Z");
    assert.equal(
      (await runtime.observeDirectSubagent?.("child", { ...context, rootTurnId: "older-root" }))
        ?.state,
      "unknown",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("public latest terminal turn is recorded without implying a live status", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-public-terminal-")));
  const start = "2026-11-16T12:00:00.000Z";
  let metadata = {
    path: null as string | null,
    cwd: root,
    turnId: "latest",
    rootTurnId: "root",
    turnStartedAt: start,
    turnStatus: "completed",
    turnCompletedAt: "2026-11-16T12:00:02.000Z",
  };
  const session = {
    closed: new Promise<void>(() => {}),
    requestMethods: [],
    readSubagentObservationMetadata: async (id: string, parent: string) =>
      id === "child" && parent === "parent" ? metadata : null,
    close: async () => {},
  } as unknown as CodexAppServerSession;
  const runtime = createCodexAppServerRuntime({ connect: async () => session });
  const context = {
    parentThreadId: "parent",
    cwd: root,
    rootTurnId: "root",
    rootTurnStartedAt: start,
  };
  try {
    for (const [status, state] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["interrupted", "idle"],
    ] as const) {
      metadata = { ...metadata, turnStatus: status };
      const result = await runtime.observeDirectSubagent?.("child", context);
      assert.equal(result?.state, state);
      assert.equal(result?.basis, "codex-turn");
      assert.equal(result?.eventTurnId, "latest");
      assert.equal(result?.observedAt, metadata.turnCompletedAt);
    }
    for (const invalid of [
      { ...metadata, turnId: "" },
      { ...metadata, rootTurnId: "old" },
      { ...metadata, cwd: "/" },
      { ...metadata, turnStatus: "inProgress" },
      { ...metadata, turnCompletedAt: "" },
    ]) {
      metadata = invalid;
      assert.equal((await runtime.observeDirectSubagent?.("child", context))?.state, "unknown");
    }
    assert.equal(
      (await runtime.observeDirectSubagent?.("child", { ...context, parentThreadId: "other" }))
        ?.state,
      "unknown",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
