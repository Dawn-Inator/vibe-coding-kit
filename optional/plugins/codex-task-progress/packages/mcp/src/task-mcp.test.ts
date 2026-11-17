import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CodexAppServerRuntime } from "../../codex-adapter/src/index.js";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";
import { GoalProgressHelper } from "../../host/src/index.js";
import {
  GoalProgressIpcClient,
  type GoalProgressIpcRequest,
  GoalProgressIpcServer,
} from "../../ipc/src/index.js";
import { resolveGoalProgressPaths } from "../../store/src/index.js";
import { createGoalProgressMcpServer } from "./index.js";
import {
  createTaskProgressPanelResourceUri,
  isCompatibleTaskProgressPanelResourceUri,
  loadNativePanelHtml,
  TASK_PROGRESS_PANEL_RESOURCE_URI,
} from "./native-panel-resource.js";
import { resolveNativeReadIdentity, resolveTrustedToolAuthorization } from "./runtime-identity.js";

test("ordinary task MCP tool schemas and trusted identity cross the real IPC transport", async () => {
  assert.equal(TASK_PROGRESS_PANEL_RESOURCE_URI, "ui://codex-task-progress/panel-v1.html");
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
    assert.equal(tools.tools.filter((tool) => tool.name.startsWith("task_progress_")).length, 11);
    const panel = tools.tools.find((tool) => tool.name === "task_progress_dashboard");
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
    assert.equal(panel.title, "Task Progress");
    assert.equal(
      tools.tools.filter((tool) => {
        const meta = tool._meta as { "openai/ui"?: { entrypoints?: unknown[] } } | undefined;
        return meta?.["openai/ui"]?.entrypoints?.length;
      }).length,
      1,
    );
    const legacyPanel = tools.tools.find((tool) => tool.name === "task_progress_panel");
    assert.ok(legacyPanel);
    assert.equal(legacyPanel.annotations?.readOnlyHint, true);
    assert.deepEqual(legacyPanel._meta, { ui: { visibility: ["model"] } });
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
    const archiveTool = tools.tools.find((tool) => tool.name === "task_progress_archive");
    const completeTool = tools.tools.find((tool) => tool.name === "task_progress_complete");
    assert.equal(archiveTool?.annotations?.readOnlyHint, true);
    assert.deepEqual((archiveTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, [
      "model",
      "app",
    ]);
    assert.notEqual(completeTool?.annotations?.readOnlyHint, true);
    assert.deepEqual((completeTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, [
      "model",
    ]);
    const initialize = tools.tools.find((tool) => tool.name === "task_progress_initialize");
    const initializeMetadata = initialize?._meta as
      | { ui?: { visibility?: string[] }; "openai/widgetAccessible"?: boolean }
      | undefined;
    assert.deepEqual(initializeMetadata?.ui?.visibility, ["model"]);
    assert.equal(initializeMetadata?.["openai/widgetAccessible"], undefined);
    const resources = await client.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      [TASK_PROGRESS_PANEL_RESOURCE_URI],
      "only the current panel URI is listed; compatibility aliases stay hidden",
    );
    const resourceTemplates = await client.listResourceTemplates();
    assert.deepEqual(
      resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate),
      ["ui://codex-task-progress/{panel}.html"],
      "the standard resource template is listed once, without duplicate aliases",
    );
    const panelResource = await client.readResource({
      uri: TASK_PROGRESS_PANEL_RESOURCE_URI,
    });
    assert.equal(panelResource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.ok(panelResource.contents[0] && "text" in panelResource.contents[0]);
    const currentPanelHtml =
      panelResource.contents[0] && "text" in panelResource.contents[0]
        ? panelResource.contents[0].text
        : undefined;
    assert.ok(currentPanelHtml);
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
    const compatiblePanelUris = [
      "ui://codex-task-progress/panel-0.6.7.html",
      "ui://codex-task-progress/panel-0.6.3.html",
      "ui://codex-task-progress/panel-0.6.1.html",
      createTaskProgressPanelResourceUri(GOAL_PROGRESS_RELEASE_VERSION),
    ];
    for (const uri of compatiblePanelUris) {
      const compatiblePanel = await client.readResource({ uri });
      assert.equal(compatiblePanel.contents.length, 1);
      const content = compatiblePanel.contents[0];
      assert.ok(content && "text" in content);
      if (!content || !("text" in content)) continue;
      assert.equal(content.uri, uri, "the requested compatibility URI is preserved");
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.equal(content.text, currentPanelHtml, "compatibility reads serve current HTML");
      const compatibilityMetadata = content._meta as
        | { ui?: { csp?: Record<string, unknown>; permissions?: Record<string, unknown> } }
        | undefined;
      assert.deepEqual(compatibilityMetadata?.ui?.csp, {
        connectDomains: [],
        resourceDomains: [],
        baseUriDomains: [],
        frameDomains: [],
      });
      assert.deepEqual(compatibilityMetadata?.ui?.permissions, {});
    }
    for (const uri of [
      `${TASK_PROGRESS_PANEL_RESOURCE_URI}?query=1`,
      createTaskProgressPanelResourceUri("999.0.0"),
      "ui://codex-task-progress/../codex-task-progress/panel-v1.html",
    ]) {
      await assert.rejects(client.readResource({ uri }), { message: /Resource .* not found/ }, uri);
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
    const dashboardResult = await client.callTool({
      name: "task_progress_dashboard",
      arguments: {},
      _meta: { ...metadata, callId: "call-dashboard" },
    });
    assert.notEqual(dashboardResult.isError, true);
    assert.equal(dashboardResult._meta?.["codex-task-progress/threadId"], "chat-1");
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
      name: "task_progress_dashboard",
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
    const nativeArchive = await client.callTool({
      name: "task_progress_archive",
      arguments: { taskId: "old", limit: 2 },
      _meta: nativeMeta,
    });
    assert.notEqual(nativeArchive.isError, true);
    const archiveRequest = received.at(-1);
    assert.equal(archiveRequest?.method, "task.native-read");
    if (archiveRequest?.method === "task.native-read") {
      assert.deepEqual(archiveRequest.params, {
        threadId: "native-chat",
        action: "archive",
        input: { taskId: "old", limit: 2 },
      });
    }
    const proof = [{ summary: "Verified", verification: "verified", reference: "test:delivery" }];
    const check = { status: "done", evidence: proof };
    const closeout = {
      branch: check,
      merge: check,
      push: check,
      remainingWork: 0,
      ownerActions: 0,
      auditEvidence: proof,
    };
    const completeInput = {
      requestId: "close",
      expectedRevision: 1,
      reason: "Delivered",
      closeout,
    };
    const beforeUntrusted = received.length;
    const untrustedComplete = await client.callTool({
      name: "task_progress_complete",
      arguments: completeInput,
      _meta: nativeMeta,
    });
    assert.equal(untrustedComplete.isError, true);
    assert.equal(received.length, beforeUntrusted);
    const trustedComplete = await client.callTool({
      name: "task_progress_complete",
      arguments: completeInput,
      _meta: { ...metadata, callId: "call-close" },
    });
    assert.notEqual(trustedComplete.isError, true);
    const completeRequest = received.at(-1);
    assert.equal(completeRequest?.method, "task.request");
    if (completeRequest?.method === "task.request") {
      assert.equal(completeRequest.params.action, "complete");
      assert.deepEqual(completeRequest.params.input, completeInput);
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
        name: "task_progress_dashboard",
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
        name: "task_progress_dashboard",
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
      name: "task_progress_dashboard",
      arguments: { threadId: "business-chat" },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(businessId.isError, true);
    const partialHook = await client.callTool({
      name: "task_progress_dashboard",
      arguments: { _runtimeContext: {} },
      _meta: { threadId: "native-chat", thread_id: "native-chat" },
    });
    assert.equal(partialHook.isError, true);
    const invalidTurnMetadata = await client.callTool({
      name: "task_progress_dashboard",
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
    const missingIdentity = await client.callTool({
      name: "task_progress_dashboard",
      arguments: {},
    });
    assert.equal(missingIdentity.isError, true);
    assert.equal(missingIdentity._meta?.["codex-task-progress/threadId"], undefined);
    assert.equal(received.length, callsAfterPanel);
    const mismatchedIdentity = await client.callTool({
      name: "task_progress_dashboard",
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
      name: "task_progress_dashboard",
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

test("real MCP and helper expose bound-source subagents to both authenticated read paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "m-"));
  const root = await realpath(directory);
  const threadId = "integration-parent";
  const ledgerPath = join(root, "heartbeat.md");
  const ledger = `# Supervision
thread: ${threadId}
## Items
| id | source | item | status | evidence |
| --- | --- | --- | --- | --- |
| H1 | report:test | Bound source task | done | receipt |
`;
  await mkdir(join(root, ".git"));
  await writeFile(ledgerPath, ledger);
  const startedAt = Math.floor(Date.now() / 1000) - 10;
  const child = (id: string) => ({
    id,
    cwd: root,
    parentThreadId: threadId,
    source: { subAgent: { thread_spawn: { parent_thread_id: threadId } } },
    status: { type: "active", activeFlags: [] },
  });
  const testRuntime: CodexAppServerRuntime = {
    async getGoal() {
      return null;
    },
    async readThreadIdentity(id) {
      return {
        id,
        sessionId: id,
        cwd: root,
        threadSource: "user",
        agentRole: null,
        ephemeral: false,
        status: { type: "idle" },
      };
    },
    async resolveCurrentThread(input) {
      return {
        threadId: input.sessionTreeId,
        sessionTreeId: input.sessionTreeId,
        turnId: input.turnId,
        cwd: root,
        model: "test",
      };
    },
    async refreshGoalUsage() {
      throw new Error("Unexpected goal usage");
    },
    watchGoalUsage() {},
    unwatchGoalUsage() {},
    setPollingMode() {},
    async close() {},
    async listSubagentTurns(parent) {
      return {
        data: [
          {
            id: "root-turn",
            rootTurnId: "root-turn",
            startedAt,
            itemsView: "full",
            items: [
              {
                type: "collabAgentToolCall",
                senderThreadId: parent,
                receiverThreadIds: ["current-child", "foreign-child"],
                tool: "spawnAgent",
                status: "completed",
                startedAtMs: (startedAt + 1) * 1000,
              },
            ],
          },
          {
            id: "old-turn",
            rootTurnId: "old-turn",
            startedAt: startedAt - 100,
            itemsView: "full",
            items: [
              {
                type: "collabAgentToolCall",
                senderThreadId: parent,
                receiverThreadIds: ["old-child"],
                tool: "spawnAgent",
                status: "completed",
                startedAtMs: (startedAt - 99) * 1000,
              },
            ],
          },
        ],
        nextCursor: null,
      };
    },
    async listDirectSubagents() {
      return {
        data: [
          child("current-child"),
          child("old-child"),
          { ...child("completed-child"), status: { type: "completed", activeFlags: [] } },
          {
            ...child("foreign-child"),
            source: { subAgent: { thread_spawn: { parent_thread_id: "foreign-parent" } } },
          },
        ],
        nextCursor: null,
      };
    },
  };
  const paths = resolveGoalProgressPaths({ root: join(root, "h") });
  const helper = new GoalProgressHelper({
    paths,
    runtime: testRuntime,
    resolveNativeGoal: async () => null,
  });
  const server = createGoalProgressMcpServer({
    ipcClient: new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" }),
    nativePanelHtmlLoader: async () => "<!doctype html><title>Task Progress Panel</title>",
  });
  const client = new Client({ name: "source-subagents-integration", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let call = 0;
  const fullMeta = () => ({
    threadId,
    callId: `call-${++call}`,
    "x-codex-turn-metadata": {
      session_id: threadId,
      thread_id: threadId,
      turn_id: "root-turn",
      model: "test",
      thread_source: "user",
      cwd: root,
    },
  });
  const nativeMeta = { threadId, thread_id: threadId };
  type Snapshot = {
    task: {
      source?: { kind?: string; path?: string; readOnly?: boolean };
      lifecycle?: unknown;
    } | null;
    taskSource?: { status?: string; path?: string; readOnly?: boolean; error?: string };
    subagents?: {
      status: string;
      parentThreadId: string;
      scopeBasis: string;
      rootTurnId?: string;
      taskSourcePath?: string;
      allocation?: { ratio: number | null };
      agents: Array<{ id: string; state: string }>;
    };
  };
  async function callRead(
    name: "task_progress_dashboard" | "task_progress_get",
    metadata: ReturnType<typeof fullMeta> | typeof nativeMeta,
  ): Promise<Snapshot> {
    const response = await client.callTool({ name, arguments: {}, _meta: metadata });
    assert.notEqual(response.isError, true);
    assert.equal(response._meta?.["codex-task-progress/threadId"], threadId);
    assert.ok(Array.isArray(response.content));
    const block = response.content.find(
      (value) => value && typeof value === "object" && value.type === "text",
    );
    assert.ok(block && block.type === "text" && typeof block.text === "string");
    const envelope = JSON.parse(block.text) as { ok: boolean; result: Snapshot };
    assert.equal(envelope.ok, true);
    return envelope.result;
  }
  async function ready(
    name: "task_progress_dashboard" | "task_progress_get",
    metadata: () => ReturnType<typeof fullMeta> | typeof nativeMeta,
  ) {
    let snapshot: Snapshot | undefined;
    for (let i = 0; i < 150; i++) {
      snapshot = await callRead(name, metadata());
      assert.ok(
        !["error", "stale", "pending-selection"].includes(snapshot.taskSource?.status ?? ""),
        `Terminal source failure: ${JSON.stringify(snapshot.taskSource)}`,
      );
      if (
        snapshot.taskSource?.status === "ready" &&
        ["ready", "partial"].includes(snapshot.subagents?.status ?? "") &&
        snapshot.subagents?.agents.some((agent) => agent.id === "current-child") &&
        snapshot.subagents.agents.some((agent) => agent.id === "old-child")
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(snapshot?.task);
    assert.equal(snapshot.task.source?.kind, "kit-heartbeat");
    assert.equal(snapshot.task.source?.path, ledgerPath);
    assert.equal(snapshot.task.source?.readOnly, true);
    assert.equal(snapshot.task.lifecycle, undefined);
    assert.equal(snapshot.taskSource?.status, "ready");
    assert.equal(snapshot.taskSource?.path, ledgerPath);
    assert.equal(snapshot.taskSource?.readOnly, true);
    assert.ok(snapshot.subagents);
    assert.ok(["ready", "partial"].includes(snapshot.subagents.status));
    assert.equal(snapshot.subagents.parentThreadId, threadId);
    assert.equal(snapshot.subagents.scopeBasis, "parent-thread");
    assert.equal(snapshot.subagents.rootTurnId, "root-turn");
    assert.equal(snapshot.subagents.taskSourcePath, ledgerPath);
    assert.deepEqual(snapshot.subagents.agents.map((agent) => agent.id).sort(), [
      "current-child",
      "old-child",
    ]);
    assert.ok(snapshot.subagents.agents.every((agent) => agent.state === "working"));
    assert.equal(snapshot.subagents.allocation?.ratio, null);
    return snapshot;
  }
  try {
    await helper.start();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const bind = await client.callTool({
      name: "task_progress_bind_heartbeat",
      arguments: { path: ledgerPath },
      _meta: fullMeta(),
    });
    assert.notEqual(bind.isError, true);
    const dashboard = await ready("task_progress_dashboard", fullMeta);
    const native = await ready("task_progress_get", () => nativeMeta);
    const fullGet = await ready("task_progress_get", fullMeta);
    assert.deepEqual(
      fullGet.subagents?.agents.map((agent) => agent.id),
      dashboard.subagents?.agents.map((agent) => agent.id),
    );
    assert.deepEqual(
      native.subagents?.agents.map((agent) => agent.id),
      dashboard.subagents?.agents.map((agent) => agent.id),
    );
    const write = await client.callTool({
      name: "task_progress_update",
      arguments: {
        requestId: "blocked-update",
        expectedRevision: 1,
        reason: "Protect canonical source",
        changes: [{ targetId: "H1", status: "active" }],
      },
      _meta: fullMeta(),
    });
    assert.equal(write.isError, true);
    assert.equal(
      (write.structuredContent as { code?: string } | undefined)?.code,
      "TASK_SOURCE_READ_ONLY",
    );
    const nativeWrite = await client.callTool({
      name: "task_progress_update",
      arguments: {
        requestId: "untrusted-update",
        expectedRevision: 1,
        reason: "Reject native write",
        changes: [{ targetId: "H1", status: "active" }],
      },
      _meta: nativeMeta,
    });
    assert.equal(nativeWrite.isError, true);
    const mismatch = await client.callTool({
      name: "task_progress_get",
      arguments: {},
      _meta: { ...fullMeta(), threadId: "foreign-parent" },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(await readFile(ledgerPath, "utf8"), ledger);
  } finally {
    await client.close();
    await server.close();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("real MCP preserves canonical assignments and projects their progress to the native panel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "m-"));
  const root = await realpath(directory);
  const threadId = "assignment-parent";
  const childId = "assignment-child";
  const oldChildId = "assignment-old-child";
  const oldPath = "/root/persistent-worker";
  const agent = { threadId: childId, path: "/root/worker" };
  await mkdir(join(root, ".git"));
  const startedAt = Math.floor(Date.now() / 1000) + 2;
  const runtime: CodexAppServerRuntime = {
    async getGoal() {
      return null;
    },
    async readThreadIdentity(id) {
      return {
        id,
        sessionId: id,
        cwd: root,
        threadSource: "user",
        agentRole: null,
        ephemeral: false,
        status: { type: "idle" },
      };
    },
    async resolveCurrentThread(input) {
      return {
        threadId: input.sessionTreeId,
        sessionTreeId: input.sessionTreeId,
        turnId: input.turnId,
        cwd: root,
        model: "test",
      };
    },
    async refreshGoalUsage() {
      throw new Error("Unexpected goal usage");
    },
    watchGoalUsage() {},
    unwatchGoalUsage() {},
    setPollingMode() {},
    async close() {},
    async listSubagentTurns(parent) {
      return {
        data: [
          {
            id: "root-turn",
            rootTurnId: "root-turn",
            startedAt,
            itemsView: "full",
            items: [
              {
                type: "collabAgentToolCall",
                senderThreadId: parent,
                receiverThreadIds: [childId],
                tool: "spawnAgent",
                status: "completed",
                startedAtMs: (startedAt + 1) * 1000,
              },
            ],
          },
        ],
        nextCursor: null,
      };
    },
    async listDirectSubagents() {
      return {
        data: [
          {
            id: childId,
            cwd: root,
            parentThreadId: threadId,
            source: {
              subAgent: { thread_spawn: { parent_thread_id: threadId, agent_path: agent.path } },
            },
            status: { type: "active", activeFlags: [] },
          },
          {
            id: oldChildId,
            cwd: root,
            parentThreadId: threadId,
            source: {
              subAgent: { thread_spawn: { parent_thread_id: threadId, agent_path: oldPath } },
            },
            status: { type: "active", activeFlags: [] },
          },
          {
            id: "foreign-child",
            cwd: root,
            parentThreadId: "foreign-parent",
            source: {
              subAgent: {
                thread_spawn: { parent_thread_id: "foreign-parent", agent_path: agent.path },
              },
            },
            status: { type: "active", activeFlags: [] },
          },
        ],
        nextCursor: null,
      };
    },
  };
  const paths = resolveGoalProgressPaths({ root: join(root, "h") });
  const helper = new GoalProgressHelper({ paths, runtime, resolveNativeGoal: async () => null });
  const server = createGoalProgressMcpServer({
    ipcClient: new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" }),
  });
  const client = new Client({ name: "assignment-integration", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let number = 0;
  const fullMeta = () => ({
    threadId,
    callId: `assignment-call-${++number}`,
    "x-codex-turn-metadata": {
      session_id: threadId,
      thread_id: threadId,
      turn_id: "root-turn",
      model: "test",
      thread_source: "user",
      cwd: root,
    },
  });
  const nativeMeta = { threadId, thread_id: threadId };
  type Item = { id: string; status: string; agent?: { threadId: string; path?: string } | null };
  type Snapshot = {
    task: {
      revision: number;
      objectives: Array<{
        id: string;
        agent?: { threadId: string; path?: string } | null;
        items: Item[];
      }>;
    } | null;
    history?: { events: Array<{ revision: number; type: string }> };
    subagents?: {
      status: string;
      scopeBasis: string;
      parentThreadId: string;
      rootTurnId?: string;
      agents: Array<{
        id: string;
        state: string;
        progress: { completed: number; total: number; percent: number | null } | null;
        progressBasis: string | null;
      }>;
    };
  };
  async function invoke(
    name: string,
    args: Record<string, unknown>,
    metadata: ReturnType<typeof fullMeta> | typeof nativeMeta,
  ): Promise<Snapshot> {
    const response = await client.callTool({ name, arguments: args, _meta: metadata });
    assert.notEqual(
      response.isError,
      true,
      JSON.stringify(response.structuredContent ?? response.content),
    );
    assert.ok(Array.isArray(response.content));
    const block = response.content.find(
      (value) => value && typeof value === "object" && value.type === "text",
    );
    assert.ok(block && block.type === "text" && typeof block.text === "string");
    const envelope = JSON.parse(block.text) as { ok: boolean; result: Snapshot };
    assert.equal(envelope.ok, true);
    return envelope.result;
  }
  const evidence = [
    { summary: "Verified in fixture", verification: "verified", reference: "test:assignment" },
  ];
  const initialObjectives = [
    {
      id: "A",
      title: "Assigned objective",
      agent,
      items: [
        { id: "A1", title: "First", agent },
        { id: "A2", title: "Second" },
        { id: "A3", title: "Third" },
      ],
    },
  ];
  try {
    await helper.start();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await invoke(
      "task_progress_initialize",
      {
        requestId: "assignment-init",
        expectedRevision: 0,
        title: "Assignments",
        reason: "Start fixture",
        objectives: initialObjectives,
      },
      fullMeta(),
    );
    const initialized = await invoke("task_progress_get", {}, fullMeta());
    assert.equal(initialized.task?.revision, 1);
    assert.deepEqual(initialized.task?.objectives[0]?.agent, agent);
    assert.deepEqual(initialized.task?.objectives[0]?.items[0]?.agent, agent);
    await invoke(
      "task_progress_update",
      {
        requestId: "assignment-update",
        expectedRevision: 1,
        reason: "Finish two",
        changes: [
          { targetId: "A1", status: "completed", evidence },
          { targetId: "A2", status: "completed", evidence },
        ],
      },
      fullMeta(),
    );
    const priorHistory = await invoke("task_progress_history", { limit: 20 }, fullMeta());
    assert.ok(priorHistory.history);
    assert.deepEqual(
      priorHistory.history.events.map((event) => event.revision),
      [2, 1],
    );
    await invoke(
      "task_progress_rescope",
      {
        requestId: "assignment-rescope",
        expectedRevision: 2,
        reason: "Associate the second item",
        objectives: [
          {
            id: "A",
            title: "Assigned objective",
            agent,
            items: [
              { id: "A1", title: "First", status: "completed", evidence },
              { id: "A2", title: "Second", status: "completed", evidence, agent },
              { id: "A3", title: "Third", status: "pending" },
            ],
          },
        ],
      },
      fullMeta(),
    );
    const full = await invoke("task_progress_get", {}, fullMeta());
    assert.equal(full.task?.revision, 3);
    assert.deepEqual(full.task?.objectives[0]?.agent, agent);
    assert.deepEqual(full.task?.objectives[0]?.items[0]?.agent, agent);
    assert.deepEqual(full.task?.objectives[0]?.items[1]?.agent, agent);
    assert.deepEqual(
      full.task?.objectives[0]?.items.map((item) => [item.id, item.status]),
      [
        ["A1", "completed"],
        ["A2", "completed"],
        ["A3", "pending"],
      ],
    );
    const afterHistory = await invoke("task_progress_history", { limit: 20 }, fullMeta());
    assert.ok(afterHistory.history);
    assert.deepEqual(
      afterHistory.history.events.map((event) => event.revision),
      [3, 2, 1],
    );
    assert.deepEqual(afterHistory.history.events.slice(1), priorHistory.history.events);
    let native: Snapshot | undefined;
    for (let i = 0; i < 150; i++) {
      native = await invoke("task_progress_get", {}, nativeMeta);
      if (
        native.subagents?.agents.find((agent) => agent.id === childId)?.progress?.total === 3 &&
        native.subagents.agents.some((agent) => agent.id === oldChildId)
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(native?.task?.revision, 3);
    assert.equal(native?.subagents?.parentThreadId, threadId);
    assert.equal(native?.subagents?.scopeBasis, "parent-thread");
    assert.equal(native?.subagents?.rootTurnId, "root-turn");
    assert.equal(native?.subagents?.agents.length, 2);
    const oldMember = native?.subagents?.agents.find((agent) => agent.id === oldChildId);
    assert.ok(oldMember);
    assert.equal(oldMember.progress, null);
    assert.equal(
      native?.subagents?.agents.some((agent) => agent.id === "foreign-child"),
      false,
    );
    const member = native?.subagents?.agents.find((agent) => agent.id === childId);
    assert.ok(member);
    assert.equal(member.id, childId);
    assert.equal(member.state, "working");
    assert.deepEqual(member.progress, { completed: 2, total: 3, percent: 66.67 });
    assert.equal(member.progressBasis, "module-delivery");
    let fullWithProgress: Snapshot | undefined;
    for (let i = 0; i < 150; i++) {
      fullWithProgress = await invoke("task_progress_get", {}, fullMeta());
      if (
        fullWithProgress.subagents?.agents.find((agent) => agent.id === childId)?.progress
          ?.total === 3
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      fullWithProgress?.subagents?.agents.find((agent) => agent.id === childId)?.progress,
      member.progress,
    );
    assert.equal(
      fullWithProgress?.subagents?.agents.find((agent) => agent.id === oldChildId)?.progress,
      null,
    );
    await invoke(
      "task_progress_rescope",
      {
        requestId: "persistent-id-rescope",
        expectedRevision: 3,
        reason: "Assign persistent worker by ID",
        objectives: [
          {
            id: "A",
            title: "Assigned objective",
            agent,
            items: [
              { id: "A1", title: "First", status: "completed", evidence },
              { id: "A2", title: "Second", status: "completed", evidence, agent },
              {
                id: "A3",
                title: "Third",
                status: "pending",
                agent: { threadId: oldChildId, path: oldPath },
              },
            ],
          },
        ],
      },
      fullMeta(),
    );
    let idProjection: Snapshot | undefined;
    for (let i = 0; i < 150; i++) {
      idProjection = await invoke("task_progress_get", {}, nativeMeta);
      if (
        idProjection.task?.revision === 4 &&
        idProjection.subagents?.agents.find((value) => value.id === oldChildId)?.progress?.total ===
          1
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      idProjection?.subagents?.agents.find((value) => value.id === oldChildId)?.progress,
      { completed: 0, total: 1, percent: 0 },
    );
    assert.deepEqual(
      idProjection?.subagents?.agents.find((value) => value.id === childId)?.progress,
      { completed: 2, total: 2, percent: 100 },
    );
  } finally {
    await client.close();
    await server.close();
    await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("stable native panel identity survives releases and each transport serves its own asset", async () => {
  const oldServer = createGoalProgressMcpServer({
    nativePanelReleaseVersion: "0.9.4",
    nativePanelHtmlLoader: async () => "<!doctype html><title>release 0.9.4</title>",
  });
  const newServer = createGoalProgressMcpServer({
    nativePanelReleaseVersion: "0.9.5",
    nativePanelHtmlLoader: async () => "<!doctype html><title>release 0.9.5</title>",
  });
  const oldClient = new Client({ name: "old-transport", version: "1" });
  const newClient = new Client({ name: "new-transport", version: "1" });
  const [oldClientTransport, oldServerTransport] = InMemoryTransport.createLinkedPair();
  const [newClientTransport, newServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await oldServer.connect(oldServerTransport);
    await oldClient.connect(oldClientTransport);
    await newServer.connect(newServerTransport);
    await newClient.connect(newClientTransport);
    for (const [client, asset] of [
      [oldClient, "<!doctype html><title>release 0.9.4</title>"],
      [newClient, "<!doctype html><title>release 0.9.5</title>"],
    ] as const) {
      const catalog = await client.listTools();
      const panel = catalog.tools.find((tool) => tool.name === "task_progress_dashboard");
      const uri = (panel?._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
      assert.equal(uri, TASK_PROGRESS_PANEL_RESOURCE_URI);
      assert.equal(panel?._meta?.["ui/resourceUri"], uri);
      assert.equal(panel?._meta?.["openai/outputTemplate"], uri);
      assert.deepEqual(
        (await client.listResources()).resources.map((resource) => resource.uri),
        [uri],
      );
      const result = await client.readResource({ uri: TASK_PROGRESS_PANEL_RESOURCE_URI });
      const content = result.contents[0];
      assert.ok(content && "text" in content);
      assert.equal(content.text, asset);
    }
    for (const version of ["0.9.2", "0.9.3", "0.9.4"]) {
      const result = await newClient.readResource({
        uri: createTaskProgressPanelResourceUri(version),
      });
      const content = result.contents[0];
      assert.ok(content && "text" in content);
      assert.equal(content.text, "<!doctype html><title>release 0.9.5</title>");
    }
    await assert.rejects(
      newClient.readResource({ uri: createTaskProgressPanelResourceUri("0.9.6") }),
      { code: -32602 },
    );
  } finally {
    await oldClient.close();
    await newClient.close();
    await oldServer.close();
    await newServer.close();
  }
});

test("historical versioned catalog rejects a future resource instead of returning old HTML", async () => {
  const legacyVersion = "0.9.2";
  const oldUri = createTaskProgressPanelResourceUri(legacyVersion);
  const newUri = createTaskProgressPanelResourceUri("0.9.3");
  // This models the historical server's versioned descriptor and resource guard;
  // it deliberately does not use the new stable-URI server fixture.
  const server = new McpServer({ name: "legacy-panel", version: legacyVersion });
  const read = async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: "old asset" }],
  });
  server.registerTool(
    "task_progress_dashboard",
    { _meta: { ui: { resourceUri: oldUri } } },
    async () => ({ content: [] }),
  );
  server.registerResource("panel", oldUri, {}, read);
  server.registerResource(
    "aliases",
    new ResourceTemplate("ui://codex-task-progress/{panel}.html", { list: undefined }),
    {},
    async (uri) => {
      if (!isCompatibleTaskProgressPanelResourceUri(uri.href, legacyVersion)) {
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
      }
      return read(uri);
    },
  );
  const client = new Client({ name: "legacy-catalog-probe", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const panel = (await client.listTools()).tools.find(
      (tool) => tool.name === "task_progress_dashboard",
    );
    assert.equal((panel?._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri, oldUri);
    assert.notEqual(oldUri, TASK_PROGRESS_PANEL_RESOURCE_URI);
    const existing = await client.readResource({ uri: oldUri });
    assert.ok(existing.contents[0] && "text" in existing.contents[0]);
    assert.equal(existing.contents[0].text, "old asset");
    await assert.rejects(client.readResource({ uri: newUri }), { code: -32602 });
  } finally {
    await client.close();
    await server.close();
  }
});

test("native panel resource URI compatibility accepts only shipped same-origin versions", () => {
  const [major = "0", minor = "0", patch = "0"] = GOAL_PROGRESS_RELEASE_VERSION.split(".");
  const futureVersion = `${Number(major)}.${Number(minor)}.${Number(patch) + 1}`;
  const accepted = [
    "ui://codex-task-progress/panel-v1.html",
    "ui://codex-task-progress/panel-0.5.16.html",
    "ui://codex-task-progress/panel-0.6.1.html",
    "ui://codex-task-progress/panel-0.6.3.html",
    "ui://codex-task-progress/panel-0.11.0.html",
    "ui://codex-task-progress/panel-0.12.0.html",
    TASK_PROGRESS_PANEL_RESOURCE_URI,
  ];
  for (const uri of accepted) {
    assert.equal(isCompatibleTaskProgressPanelResourceUri(uri), true, uri);
  }

  // Simulate the version guard of historical 0.9.2/0.9.3 servers. These
  // versions advertised semver URIs; the new stable-URI test above does not
  // model their old catalog metadata.
  const oldCatalogUri = createTaskProgressPanelResourceUri("0.9.2");
  const newCatalogUri = createTaskProgressPanelResourceUri("0.9.3");
  assert.notEqual(oldCatalogUri, newCatalogUri);
  assert.equal(isCompatibleTaskProgressPanelResourceUri(newCatalogUri, "0.9.2"), false);
  assert.equal(isCompatibleTaskProgressPanelResourceUri(oldCatalogUri, "0.9.3"), true);
  assert.equal(
    isCompatibleTaskProgressPanelResourceUri("ui://codex-task-progress/panel-v1.html", "0.8.1"),
    true,
  );

  const rejected = [
    "ui://other-host/panel-0.6.3.html",
    "ui://codex-task-progress/panel-v1.html?query=1",
    "ui://codex-task-progress/panel-v1.html#fragment",
    "ui://codex-task-progress/other-0.6.3.html",
    "ui://codex-task-progress/panel-0.6.3.html?query=1",
    "ui://codex-task-progress/panel-0.6.3.html#fragment",
    "ui://codex-task-progress/panel-0.6.3.0.html",
    "ui://codex-task-progress/panel-0.06.3.html",
    "ui://codex-task-progress/panel-0.6.03.html",
    "ui://codex-task-progress/panel-0.5.15.html",
    `ui://codex-task-progress/panel-${futureVersion}.html`,
    "ui://codex-task-progress/panel-0.6.3-beta.1.html",
    "ui://codex-task-progress/panel-0.6.3.html/extra",
    "ui://codex-task-progress/panel-0.6.3.html%2Fextra",
    "ui://codex-task-progress/../codex-task-progress/panel-0.6.3.html",
  ];
  for (const uri of rejected) {
    assert.equal(isCompatibleTaskProgressPanelResourceUri(uri), false, uri);
  }
  assert.equal(
    isCompatibleTaskProgressPanelResourceUri(
      "ui://codex-task-progress/panel-0.6.3.html",
      "0.6.6-rc.1",
    ),
    false,
    "invalid current versions fail closed",
  );
  assert.equal(
    isCompatibleTaskProgressPanelResourceUri("ui://codex-task-progress/panel-0.6.3.html", "0.06.6"),
    false,
    "zero-padded current versions fail closed",
  );
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

test("SEA native panel loader uses the embedded release asset and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-sea-resource-"));
  const previous = process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
  try {
    const stalePlugin = join(root, "0.6.3");
    const source = join(root, "source");
    await mkdir(join(stalePlugin, "assets"), { recursive: true });
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(stalePlugin, "assets/task-progress-panel.html"), "stale-0.6.3");
    await writeFile(join(source, "assets/task-progress-panel.html"), "source-runtime");
    process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT = source;
    const sea = {
      isSea: () => true,
      getAsset: (key: string, encoding: "utf8") => {
        assert.equal(key, "task-progress-panel.html");
        assert.equal(encoding, "utf8");
        return "embedded-0.6.5";
      },
    };
    assert.equal(await loadNativePanelHtml(stalePlugin, sea), "embedded-0.6.5");
    await assert.rejects(
      loadNativePanelHtml(stalePlugin, {
        isSea: () => true,
        getAsset: (_key: string, _encoding: "utf8") => {
          throw new Error("asset missing");
        },
      }),
      /asset missing/u,
    );
    assert.equal(
      await loadNativePanelHtml(stalePlugin, {
        isSea: () => false,
        getAsset: () => "unused",
      }),
      "source-runtime",
    );
  } finally {
    if (previous === undefined) delete process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT;
    else process.env.GOAL_PROGRESS_SOURCE_RUNTIME_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
