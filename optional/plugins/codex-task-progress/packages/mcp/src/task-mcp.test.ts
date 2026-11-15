import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { loadNativePanelHtml } from "./native-panel-resource.js";

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
          ui?: { resourceUri?: string; visibility?: string[] };
          "ui/resourceUri"?: string;
          "openai/outputTemplate"?: string;
          "openai/widgetAccessible"?: boolean;
          "openai/ui"?: { entrypoints?: unknown[]; displayModes?: unknown[] };
        }
      | undefined;
    assert.equal(panelMetadata?.ui?.resourceUri, "ui://codex-task-progress/panel-v1.html");
    assert.deepEqual(panelMetadata?.ui?.visibility, ["model", "app"]);
    assert.equal(panelMetadata?.["ui/resourceUri"], panelMetadata?.ui?.resourceUri);
    assert.equal(panelMetadata?.["openai/outputTemplate"], panelMetadata?.ui?.resourceUri);
    assert.equal(panelMetadata?.["openai/widgetAccessible"], true);
    assert.deepEqual(panelMetadata?.["openai/ui"]?.entrypoints, [{ type: "thread" }]);
    assert.equal(panelMetadata?.["openai/ui"]?.displayModes, undefined);
    const getTool = tools.tools.find((tool) => tool.name === "task_progress_get");
    const historyTool = tools.tools.find((tool) => tool.name === "task_progress_history");
    const getMetadata = getTool?._meta as
      | { ui?: { visibility?: string[] }; "openai/widgetAccessible"?: boolean }
      | undefined;
    const historyMetadata = historyTool?._meta as
      | { ui?: { visibility?: string[] }; "openai/widgetAccessible"?: boolean }
      | undefined;
    assert.deepEqual(getMetadata?.ui?.visibility, ["model", "app"]);
    assert.equal(getMetadata?.["openai/widgetAccessible"], true);
    assert.deepEqual(historyMetadata?.ui?.visibility, ["model", "app"]);
    assert.equal(historyMetadata?.["openai/widgetAccessible"], true);
    const heartbeatHistory = tools.tools.find(
      (tool) => tool.name === "task_progress_heartbeat_history",
    );
    assert.equal(heartbeatHistory?.annotations?.readOnlyHint, true);
    const heartbeatMetadata = heartbeatHistory?._meta as
      | { ui?: { visibility?: string[] }; "openai/widgetAccessible"?: boolean }
      | undefined;
    assert.deepEqual(heartbeatMetadata?.ui?.visibility, ["model", "app"]);
    assert.equal(heartbeatMetadata?.["openai/widgetAccessible"], true);
    const initialize = tools.tools.find((tool) => tool.name === "task_progress_initialize");
    const initializeMetadata = initialize?._meta as
      | { ui?: { visibility?: string[] }; "openai/widgetAccessible"?: boolean }
      | undefined;
    assert.deepEqual(initializeMetadata?.ui?.visibility, ["model"]);
    assert.equal(initializeMetadata?.["openai/widgetAccessible"], undefined);
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

test("native panel loader selects packaged and source-runtime assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-resource-"));
  const previous = process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
  try {
    const packaged = join(root, "packaged");
    const source = join(root, "source");
    await mkdir(join(packaged, "assets"), { recursive: true });
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(packaged, "assets/task-progress-panel.html"), "packaged");
    await writeFile(join(source, "assets/task-progress-panel.html"), "source");
    delete process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
    assert.equal(await loadNativePanelHtml(packaged), "packaged");
    process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT = source;
    assert.equal(await loadNativePanelHtml(packaged), "source");
  } finally {
    if (previous === undefined) delete process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
    else process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
