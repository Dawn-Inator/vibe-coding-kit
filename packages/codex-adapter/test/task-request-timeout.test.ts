import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GoalProgressIpcRequestOptions } from "../../ipc/src/client.js";
import {
  GoalProgressIpcClient,
  GoalProgressIpcServer,
  TASK_PROGRESS_REQUEST_TIMEOUT_MS,
} from "../../ipc/src/index.js";
import type { GoalProgressIpcRequestInput } from "../../ipc/src/protocol.js";
import { createGoalProgressMcpServer } from "../../mcp/src/index.js";
import { GoalProgressCdpViewClient } from "../src/view-client.js";

test("request timeout override keeps the default deadline and allows a bounded longer task request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-timeout-"));
  const helper = new GoalProgressIpcServer(join(directory, "helper.sock"), async (request) => {
    if (request.method === "task.view") {
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    return { revision: 1, result: { task: null } };
  });
  await helper.start();
  const client = new GoalProgressIpcClient(join(directory, "helper.sock"), {
    clientKind: "cdp",
    timeoutMs: 25,
  });
  const request = {
    method: "task.view",
    params: { threadId: "thread-1", action: "get" },
  } satisfies GoalProgressIpcRequestInput;
  try {
    await assert.rejects(client.request(request), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "IPC_TIMEOUT");
      return true;
    });
    const response = await client.request(request, { timeoutMs: 250 });
    assert.deepEqual(response.result, { task: null });
    await assert.rejects(client.request(request, { timeoutMs: 0 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "IPC_TIMEOUT_INVALID");
      return true;
    });
    await assert.rejects(client.request(request, { timeoutMs: Number.POSITIVE_INFINITY }), {
      code: "IPC_TIMEOUT_INVALID",
    });
  } finally {
    await helper.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the server extends only active task handlers and restores its idle timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-server-timeout-"));
  const timeoutRequests: number[] = [];
  const originalSetTimeout = Socket.prototype.setTimeout;
  const helper = new GoalProgressIpcServer(join(directory, "helper.sock"), async (request) => {
    if (request.method === "task.view" || request.method === "ping") {
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
    return { revision: 1, result: { method: request.method } };
  });
  await helper.start();
  const client = new GoalProgressIpcClient(join(directory, "helper.sock"), {
    clientKind: "cdp",
    timeoutMs: 500,
  });
  Socket.prototype.setTimeout = function (timeout: number, callback?: () => void): Socket {
    timeoutRequests.push(timeout);
    const scaledTimeout = timeout === TASK_PROGRESS_REQUEST_TIMEOUT_MS ? 180 : 20;
    originalSetTimeout.call(this, scaledTimeout, callback);
    return this;
  };
  try {
    const taskResponse = await client.request(
      {
        method: "task.view",
        params: { threadId: "thread-1", action: "get" },
      },
      { timeoutMs: 300 },
    );
    assert.deepEqual(taskResponse.result, { method: "task.view" });
    assert.ok(timeoutRequests.includes(TASK_PROGRESS_REQUEST_TIMEOUT_MS));
    assert.ok(timeoutRequests.filter((timeout) => timeout === 10_000).length >= 2);

    await assert.rejects(client.request({ method: "ping", params: {} }, { timeoutMs: 300 }), {
      code: "IPC_CLOSED",
    });
    assert.equal(timeoutRequests.at(-1), 10_000);
  } finally {
    Socket.prototype.setTimeout = originalSetTimeout;
    await helper.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("task MCP and CDP entry points pass the shared task deadline", async () => {
  const captured: {
    request: GoalProgressIpcRequestInput;
    options?: GoalProgressIpcRequestOptions;
  }[] = [];
  class CapturingIpcClient extends GoalProgressIpcClient {
    override async request(
      request: GoalProgressIpcRequestInput,
      options?: GoalProgressIpcRequestOptions,
    ) {
      captured.push({ request, ...(options === undefined ? {} : { options }) });
      return {
        ok: true as const,
        protocolVersion: 4 as const,
        requestId: "test-request",
        revision: 1,
        result: { task: null },
      };
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "task-timeout-entrypoints-"));
  const mcpServer = createGoalProgressMcpServer({
    ipcClient: new CapturingIpcClient(join(directory, "unused.sock"), { clientKind: "mcp" }),
  });
  const mcpClient = new Client({ name: "task-timeout-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalRequest = GoalProgressIpcClient.prototype.request;
  const viewClient = new GoalProgressCdpViewClient(join(directory, "unused-view.sock"));
  try {
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "task_progress_get",
      arguments: {},
      _meta: {
        threadId: "thread-1",
        callId: "call-1",
        "x-codex-turn-metadata": {
          session_id: "thread-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
          model: "test",
          thread_source: "user",
          cwd: "/project",
        },
      },
    });

    const viewCaptured: GoalProgressIpcRequestOptions[] = [];
    GoalProgressIpcClient.prototype.request = async function (
      this: GoalProgressIpcClient,
      request: GoalProgressIpcRequestInput,
      options?: GoalProgressIpcRequestOptions,
    ) {
      assert.equal(request.method, "task.view");
      if (options) viewCaptured.push(options);
      return {
        ok: true,
        protocolVersion: 4,
        requestId: "view-request",
        revision: 1,
        result: { task: null },
      };
    };
    await viewClient.taskRequest({ method: "get", threadId: "thread-1" });

    assert.equal(captured[0]?.request.method, "task.request");
    assert.equal(captured[0]?.options?.timeoutMs, TASK_PROGRESS_REQUEST_TIMEOUT_MS);
    assert.deepEqual(viewCaptured, [{ timeoutMs: TASK_PROGRESS_REQUEST_TIMEOUT_MS }]);
    assert.equal(TASK_PROGRESS_REQUEST_TIMEOUT_MS, 30_000);
  } finally {
    GoalProgressIpcClient.prototype.request = originalRequest;
    await mcpClient.close();
    await mcpServer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
