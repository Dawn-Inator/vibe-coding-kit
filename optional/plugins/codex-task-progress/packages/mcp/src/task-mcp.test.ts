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
    nativePanelHtmlLoader: async () => "<!doctype html><title>Task Progress Panel</title>",
  });
  const client = new Client({ name: "task-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.filter((tool) => tool.name.startsWith("task_progress_")).length, 8);
    const panel = tools.tools.find((tool) => tool.name === "task_progress_panel");
    assert.ok(panel);
    assert.deepEqual(panel.inputSchema.properties, {});
    const panelMetadata = panel._meta as
      | {
          ui?: { resourceUri?: string };
          "openai/ui"?: { entrypoints?: unknown[]; displayModes?: unknown[] };
        }
      | undefined;
    assert.equal(panelMetadata?.ui?.resourceUri, "ui://codex-task-progress/panel-v1.html");
    assert.deepEqual(panelMetadata?.["openai/ui"]?.entrypoints, [{ type: "thread" }]);
    assert.equal(panelMetadata?.["openai/ui"]?.displayModes, undefined);
    const heartbeatHistory = tools.tools.find(
      (tool) => tool.name === "task_progress_heartbeat_history",
    );
    assert.equal(heartbeatHistory?.annotations?.readOnlyHint, true);
    const resources = await client.listResources();
    assert.ok(
      resources.resources.some(
        (resource) => resource.uri === "ui://codex-task-progress/panel-v1.html",
      ),
    );
    const panelResource = await client.readResource({
      uri: "ui://codex-task-progress/panel-v1.html",
    });
    assert.equal(panelResource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.ok(panelResource.contents[0] && "text" in panelResource.contents[0]);
    if (panelResource.contents[0] && "text" in panelResource.contents[0]) {
      assert.match(panelResource.contents[0].text, /Task Progress Panel/);
      const contentMetadata = panelResource.contents[0]._meta as
        | {
            ui?: { csp?: Record<string, unknown>; permissions?: Record<string, unknown> };
            "openai/ui"?: {
              availableDisplayModes?: string[];
              preferredDisplayMode?: string;
              entrypoints?: unknown[];
              displayModes?: unknown[];
            };
          }
        | undefined;
      assert.deepEqual(contentMetadata?.ui?.csp, {
        connectDomains: [],
        resourceDomains: [],
        baseUriDomains: [],
        frameDomains: [],
      });
      assert.deepEqual(contentMetadata?.ui?.permissions, {});
      assert.deepEqual(contentMetadata?.["openai/ui"]?.availableDisplayModes, [
        "inline",
        "fullscreen",
      ]);
      assert.equal(contentMetadata?.["openai/ui"]?.preferredDisplayMode, "fullscreen");
      assert.equal(contentMetadata?.["openai/ui"]?.entrypoints, undefined);
      assert.equal(contentMetadata?.["openai/ui"]?.displayModes, undefined);
    }
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
    assert.equal(result._meta?.["codex-task-progress/threadId"], "chat-1");
    const request = received.at(-1);
    assert.equal(request?.method, "task.request");
    if (request?.method === "task.request") {
      assert.equal(request.params.action, "get");
      assert.equal(request.params.auth.kind, "codex-request");
      if (request.params.auth.kind === "codex-request")
        assert.equal(request.params.auth.identity.threadId, "chat-1");
    }
    const panelResult = await client.callTool({
      name: "task_progress_panel",
      arguments: {},
      _meta: { ...metadata, callId: "call-panel" },
    });
    assert.notEqual(panelResult.isError, true);
    assert.equal(panelResult._meta?.["codex-task-progress/threadId"], "chat-1");
    const panelRequest = received.at(-1);
    assert.equal(panelRequest?.method, "task.request");
    if (panelRequest?.method === "task.request") {
      assert.equal(panelRequest.params.action, "get");
      assert.equal(panelRequest.params.auth.kind, "codex-request");
      if (panelRequest.params.auth.kind === "codex-request")
        assert.equal(panelRequest.params.auth.identity.threadId, "chat-1");
    }
    const historyResult = await client.callTool({
      name: "task_progress_history",
      arguments: {},
      _meta: { ...metadata, callId: "call-history" },
    });
    assert.notEqual(historyResult.isError, true);
    assert.equal(historyResult._meta?.["codex-task-progress/threadId"], "chat-1");
    const callsAfterPanel = received.length;
    const missingIdentity = await client.callTool({ name: "task_progress_panel", arguments: {} });
    assert.equal(missingIdentity.isError, true);
    assert.equal(missingIdentity._meta?.["codex-task-progress/threadId"], undefined);
    assert.equal(received.length, callsAfterPanel);
    const mismatchedIdentity = await client.callTool({
      name: "task_progress_panel",
      arguments: {},
      _meta: {
        ...metadata,
        callId: "call-mismatch",
        "x-codex-turn-metadata": { ...metadata["x-codex-turn-metadata"], thread_id: "other-chat" },
      },
    });
    assert.equal(mismatchedIdentity.isError, true);
    assert.equal(mismatchedIdentity._meta?.["codex-task-progress/threadId"], undefined);
    assert.equal(received.length, callsAfterPanel);
    const spoofedIdentity = await client.callTool({
      name: "task_progress_panel",
      arguments: { threadId: "injected-thread" },
      _meta: { ...metadata, callId: "call-spoof" },
    });
    assert.equal(spoofedIdentity.isError, true);
    assert.equal(received.length, callsAfterPanel);
    const badResult = await client.callTool({
      name: "task_progress_get",
      arguments: { threadId: "injected-thread" },
      _meta: { ...metadata, callId: "call-2" },
    });
    assert.equal(badResult.isError, true);
    assert.equal(received.length, callsAfterPanel);
  } finally {
    await client.close();
    await server.close();
    await helper.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
