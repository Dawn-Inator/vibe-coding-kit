import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";
import {
  GoalProgressIpcClient,
  type GoalProgressIpcRequest,
  GoalProgressIpcServer,
} from "../../ipc/src/index.js";
import { createGoalProgressMcpServer } from "./index.js";
import {
  createTaskProgressPanelResourceUri,
  loadNativePanelHtml,
  TASK_PROGRESS_PANEL_RESOURCE_URI,
} from "./native-panel-resource.js";
import { resolveNativeReadIdentity, resolveTrustedToolAuthorization } from "./runtime-identity.js";

test("ordinary task MCP tool schemas and trusted identity cross the real IPC transport", async () => {
  assert.equal(
    TASK_PROGRESS_PANEL_RESOURCE_URI,
    createTaskProgressPanelResourceUri(GOAL_PROGRESS_RELEASE_VERSION),
  );
  assert.notEqual(
    createTaskProgressPanelResourceUri("0.6.0"),
    createTaskProgressPanelResourceUri("0.6.1"),
  );
  const directory = await mkdtemp(join(tmpdir(), "task-mcp-"));
  const received: GoalProgressIpcRequest[] = [];
  const helper = new GoalProgressIpcServer(join(directory, "helper.sock"), async (request) => {
    received.push(request);
    return {
      revision: 1,
      result: {
        task: null,
        received: request.method,
        ...(request.method === "task.native-read" ? { threadId: request.params.threadId } : {}),
      },
    };
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
    assert.equal(panelMetadata?.ui?.resourceUri, TASK_PROGRESS_PANEL_RESOURCE_URI);
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
      resources.resources.some((resource) => resource.uri === TASK_PROGRESS_PANEL_RESOURCE_URI),
    );
    const panelResource = await client.readResource({
      uri: TASK_PROGRESS_PANEL_RESOURCE_URI,
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
    const nativeMeta = { threadId: "native-chat", thread_id: "native-chat" };
    const nativePanel = await client.callTool({
      name: "task_progress_panel",
      arguments: {},
      _meta: nativeMeta,
    });
    assert.notEqual(nativePanel.isError, true);
    assert.equal(nativePanel._meta?.["codex-task-progress/threadId"], "native-chat");
    const nativePanelRequest = received.at(-1);
    assert.equal(nativePanelRequest?.method, "task.native-read");
    if (nativePanelRequest?.method === "task.native-read") {
      assert.deepEqual(nativePanelRequest.params, {
        threadId: "native-chat",
        action: "get",
        input: {},
      });
    }
    const nativeHistory = await client.callTool({
      name: "task_progress_history",
      arguments: { limit: 3 },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.notEqual(nativeHistory.isError, true);
    assert.equal(nativeHistory._meta?.["codex-task-progress/threadId"], "native-chat");
    const nativeHistoryRequest = received.at(-1);
    assert.equal(nativeHistoryRequest?.method, "task.native-read");
    if (nativeHistoryRequest?.method === "task.native-read") {
      assert.deepEqual(nativeHistoryRequest.params, {
        threadId: "native-chat",
        action: "history",
        input: { limit: 3 },
      });
    }
    const nativeHeartbeatHistory = await client.callTool({
      name: "task_progress_heartbeat_history",
      arguments: { limit: 2 },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.notEqual(nativeHeartbeatHistory.isError, true);
    const nativeHeartbeatRequest = received.at(-1);
    assert.equal(nativeHeartbeatRequest?.method, "task.native-read");
    if (nativeHeartbeatRequest?.method === "task.native-read") {
      assert.deepEqual(nativeHeartbeatRequest.params, {
        threadId: "native-chat",
        action: "heartbeat-history",
        input: { limit: 2 },
      });
    }

    const interleaved = await Promise.all(
      ["native-a", "native-b"].map((threadId) =>
        client.callTool({
          name: "task_progress_get",
          arguments: {},
          _meta: { threadId, thread_id: threadId },
        }),
      ),
    );
    for (const [index, threadId] of ["native-a", "native-b"].entries()) {
      const result = interleaved[index];
      assert.ok(result);
      assert.notEqual(result.isError, true);
      assert.equal(result._meta?.["codex-task-progress/threadId"], threadId);
      assert.ok(Array.isArray(result.content));
      const content: unknown = result.content[0];
      assert.ok(
        content &&
          typeof content === "object" &&
          "type" in content &&
          content.type === "text" &&
          "text" in content &&
          typeof content.text === "string",
      );
      if (
        content &&
        typeof content === "object" &&
        "type" in content &&
        content.type === "text" &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        assert.match(content.text, new RegExp(`\\"threadId\\":\\"${threadId}\\"`));
      }
    }

    const afterValidReads = received.length;
    for (const malformed of [
      { threadId: "native-chat" },
      { thread_id: "native-chat" },
      { threadId: "", thread_id: "" },
      { threadId: "native-chat", thread_id: "other-chat" },
      { threadId: "x".repeat(513), thread_id: "x".repeat(513) },
      { threadId: "native-chat", thread_id: "native-chat", plugin_id: "other-plugin" },
    ]) {
      const rejected = await client.callTool({
        name: "task_progress_panel",
        arguments: {},
        _meta: malformed,
      });
      assert.equal(rejected.isError, true);
      assert.equal(rejected._meta?.["codex-task-progress/threadId"], undefined);
    }
    for (const [field, value] of [
      ["callId", "model-call"],
      ["sessionId", "other-chat"],
      ["itemId", "model-item"],
      ["windowId", "model-window"],
    ] as const) {
      const rejected = await client.callTool({
        name: "task_progress_panel",
        arguments: {},
        _meta: { threadId: "native-chat", thread_id: "native-chat", [field]: value },
      });
      assert.equal(rejected.isError, true);
      const error: unknown = rejected.structuredContent;
      assert.ok(error && typeof error === "object" && "code" in error);
      if (error && typeof error === "object" && "code" in error) {
        assert.equal(error.code, "CODEX_REQUEST_METADATA_REQUIRED");
      }
      assert.equal(rejected._meta?.["codex-task-progress/threadId"], undefined);
    }
    const businessId = await client.callTool({
      name: "task_progress_panel",
      arguments: { threadId: "business-chat" },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(businessId.isError, true);
    const partialHook = await client.callTool({
      name: "task_progress_panel",
      arguments: { _runtimeContext: {} },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(partialHook.isError, true);
    const invalidTurnMetadata = await client.callTool({
      name: "task_progress_panel",
      arguments: {},
      _meta: {
        threadId: "native-chat",
        thread_id: "native-chat",
        "x-codex-turn-metadata": { thread_id: "native-chat" },
      },
    });
    assert.equal(invalidTurnMetadata.isError, true);
    const writeWithoutProof = await client.callTool({
      name: "task_progress_initialize",
      arguments: {
        requestId: "native-write",
        expectedRevision: 0,
        title: "Native write must stay denied",
        reason: "Regression test",
        objectives: [],
      },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(writeWithoutProof.isError, true);
    const writeError: unknown = writeWithoutProof.structuredContent;
    assert.ok(
      writeError &&
        typeof writeError === "object" &&
        "code" in writeError &&
        typeof writeError.code === "string",
    );
    if (writeError && typeof writeError === "object" && "code" in writeError) {
      assert.equal(writeError.code, "CODEX_REQUEST_METADATA_REQUIRED");
    }
    const bindWithoutProof = await client.callTool({
      name: "task_progress_bind_heartbeat",
      arguments: { path: null },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(bindWithoutProof.isError, true);
    assert.equal(received.length, afterValidReads);
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

test("native identity never downgrades partial Hook or turn metadata", () => {
  const validNativeMeta = { threadId: "native-chat", thread_id: "native-chat" };
  const modelOnlyFields = ["callId", "sessionId", "itemId", "windowId"] as const;
  assert.equal(
    resolveNativeReadIdentity("get", { _runtimeContext: undefined }, { _meta: validNativeMeta })
      ?.ok,
    true,
  );
  assert.equal(
    resolveNativeReadIdentity("get", { _runtimeProof: {} }, { _meta: validNativeMeta }),
    undefined,
  );
  for (const turnMetadata of [null, undefined, { thread_id: "native-chat" }]) {
    const extra = {
      _meta: { ...validNativeMeta, "x-codex-turn-metadata": turnMetadata },
    } as Parameters<typeof resolveNativeReadIdentity>[2];
    assert.equal(resolveNativeReadIdentity("get", {}, extra), undefined);
    assert.equal(resolveTrustedToolAuthorization("task_progress_get", {}, extra).ok, false);
  }
  for (const field of modelOnlyFields) {
    for (const value of [null, undefined]) {
      const extra = {
        _meta: { ...validNativeMeta, [field]: value },
      } as Parameters<typeof resolveNativeReadIdentity>[2];
      assert.equal(resolveNativeReadIdentity("get", {}, extra), undefined);
      assert.equal(resolveTrustedToolAuthorization("task_progress_get", {}, extra).ok, false);
    }
  }
  const mismatchedSession = {
    _meta: { ...validNativeMeta, sessionId: "other-chat" },
  } as Parameters<typeof resolveNativeReadIdentity>[2];
  assert.equal(resolveNativeReadIdentity("get", {}, mismatchedSession), undefined);
  assert.equal(
    resolveTrustedToolAuthorization("task_progress_get", {}, mismatchedSession).ok,
    false,
  );
  const malformedAlias = resolveNativeReadIdentity(
    "get",
    {},
    { _meta: { threadId: 17, thread_id: "native-chat" } },
  );
  assert.deepEqual(malformedAlias, {
    ok: false,
    code: "CODEX_REQUEST_METADATA_REQUIRED",
  });
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
