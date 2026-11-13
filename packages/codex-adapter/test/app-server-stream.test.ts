import assert from "node:assert/strict";
import test from "node:test";
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
  const script = responderScript(`
    let count = 0;
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method !== "thread/turns/list") return;
      count += 1;
      if (count === 1) {
        setTimeout(
          () => process.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + "\\n"),
          400,
        );
      } else {
        process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ id: "turn-b" }] } }) + "\\n");
      }
    });
  `);
  const client = await clientFor(script, { outputMode: "stream", requestTimeoutMs: 150 });
  try {
    await assert.rejects(client.listTurnIds("thread-a"), /GOAL_PROGRESS_APP_SERVER_TIMEOUT/);
    assert.deepEqual(await client.listTurnIds("thread-a"), ["turn-b"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(client.failed, undefined);
  } finally {
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
