import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";
import { GOAL_PROGRESS_PAGE_HOST_VERSION } from "../src/page-host.js";
import { GoalProgressRendererBridge } from "../src/renderer-bridge.js";
import { createGoalProgressRendererBundle } from "../src/renderer-bundle.js";

test("task binding forwards only the live visible chat and resolves replies in the originating context", async () => {
  const listeners = new Map<string, (params: unknown) => void>();
  const evaluations: { expression: string; contextId?: number }[] = [];
  const bindingNames: string[] = [];
  let visibleThread = "chat-a";
  const received: unknown[] = [];
  const source = "/* synthetic browser bundle */";
  const bundle = createGoalProgressRendererBundle(source, {
    schemaVersion: 1,
    releaseVersion: GOAL_PROGRESS_RELEASE_VERSION,
    pageHostVersion: GOAL_PROGRESS_PAGE_HOST_VERSION,
    file: "goal-progress.js",
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  const bridge = new GoalProgressRendererBridge({
    bundle,
    platform: "macos",
    appVersion: "test",
    sender: {
      onEvent(method, listener) {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
      async send(method, params) {
        const p = (params ?? {}) as { name?: string; expression?: string; contextId?: number };
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
        if (method === "Runtime.addBinding" && p.name) bindingNames.push(p.name);
        if (method === "Runtime.evaluate") {
          const expression = p.expression ?? "";
          evaluations.push({
            expression,
            ...(p.contextId === undefined ? {} : { contextId: p.contextId }),
          });
          if (expression.endsWith("(document).threadId"))
            return { result: { value: visibleThread } };
          if (expression === "globalThis.__CODEX_GOAL_PROGRESS__")
            return { result: { type: "object", objectId: "host" } };
          return { result: { value: true } };
        }
        if (method === "Runtime.callFunctionOn")
          return { result: { value: { action: "unmounted", reason: "ok", hostCount: 0 } } };
        return {};
      },
    },
    async onTaskRequest(request) {
      received.push(request);
      return { task: null, heartbeat: null };
    },
  });
  try {
    // Clear still installs the always-visible ordinary-task host, independent of Goal state.
    await bridge.clear();
    const binding = bindingNames.find((name) => name.startsWith("__CODEX_TASK_PROGRESS_"));
    assert.ok(binding);
    const emit = listeners.get("Runtime.bindingCalled");
    assert.ok(emit);
    emit({
      name: binding,
      executionContextId: 17,
      payload: JSON.stringify({ id: "1", request: { method: "get", threadId: "chat-a" } }),
    });
    await bridge.waitForIdle();
    assert.deepEqual(received, [{ method: "get", threadId: "chat-a" }]);
    const response = evaluations.find((entry) =>
      entry.expression.includes('__codexTaskProgressResolve?.("1"'),
    );
    assert.ok(response?.expression.includes('"heartbeat":null'));
    assert.equal(response?.contextId, 17);
    visibleThread = "chat-b";
    emit({
      name: binding,
      executionContextId: 18,
      payload: JSON.stringify({ id: "2", request: { method: "history", threadId: "chat-a" } }),
    });
    await bridge.waitForIdle();
    assert.equal(received.length, 1);
    const denied = evaluations.find((entry) =>
      entry.expression.includes('__codexTaskProgressResolve?.("2"'),
    );
    assert.ok(denied?.expression.includes("TASK_VISIBLE_THREAD_MISMATCH"));
    assert.equal(denied?.contextId, 18);
    emit({
      name: binding,
      payload: JSON.stringify({
        id: "3",
        request: { method: "get", threadId: "chat-b", forged: true },
      }),
    });
    await bridge.waitForIdle();
    assert.equal(received.length, 1);
  } finally {
    await bridge.close();
  }
});
