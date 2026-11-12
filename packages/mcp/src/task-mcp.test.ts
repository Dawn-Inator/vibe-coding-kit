import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GoalProgressIpcClient,
  type GoalProgressIpcRequest,
  GoalProgressIpcServer,
} from "../../ipc/src/index.js";
import { createGoalProgressMcpServer } from "./index.js";

test("ordinary task MCP tool schemas and trusted identity cross the real IPC transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-mcp-"));
  const received: GoalProgressIpcRequest[] = [];
  const helper = new GoalProgressIpcServer(join(directory, "helper.sock"), async (request) => {
    received.push(request);
    return { revision: 1, result: { task: null, received: request.method } };
  });
  await helper.start();
  const server = createGoalProgressMcpServer({
    ipcClient: new GoalProgressIpcClient(join(directory, "helper.sock"), { clientKind: "mcp" }),
  });
  const client = new Client({ name: "task-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.filter((tool) => tool.name.startsWith("task_progress_")).length, 6);
    const initialize = tools.tools.find((tool) => tool.name === "task_progress_initialize");
    assert.ok(initialize);
    assert.equal(initialize.inputSchema.additionalProperties, false);
    assert.ok(initialize.inputSchema.required?.includes("requestId"));
    assert.equal(initialize.inputSchema.properties?.threadId, undefined);
    const metadata = {
      threadId: "chat-1",
      callId: "call-1",
      "x-codex-turn-metadata": {
        session_id: "chat-1",
        thread_id: "chat-1",
        turn_id: "turn-1",
        model: "test",
        thread_source: "user",
        cwd: "/project",
      },
    };
    const result = await client.callTool({
      name: "task_progress_get",
      arguments: {},
      _meta: metadata,
    });
    assert.notEqual(result.isError, true);
    const request = received.at(-1);
    assert.equal(request?.method, "task.request");
    if (request?.method === "task.request") {
      assert.equal(request.params.action, "get");
      assert.equal(request.params.auth.kind, "codex-request");
      if (request.params.auth.kind === "codex-request")
        assert.equal(request.params.auth.identity.threadId, "chat-1");
    }
    const callsBefore = received.length;
    const badResult = await client.callTool({
      name: "task_progress_get",
      arguments: { threadId: "injected-thread" },
      _meta: { ...metadata, callId: "call-2" },
    });
    assert.equal(badResult.isError, true);
    assert.equal(received.length, callsBefore);
  } finally {
    await client.close();
    await server.close();
    await helper.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
