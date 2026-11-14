import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { CodexAppServerClient } from "../src/index.js";

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
