import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";
import { TASK_PROGRESS_REQUEST_TIMEOUT_MS } from "../../ipc/src/index.js";
import { GOAL_PROGRESS_PAGE_HOST_VERSION } from "../src/page-host.js";
import {
  GoalProgressRendererBridge,
  TASK_PROGRESS_RENDERER_DELIVERY_MARGIN_MS,
} from "../src/renderer-bridge.js";
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
    const taskWrapper = evaluations.findIndex((entry) =>
      entry.expression.includes("globalThis.__codexTaskProgressRequest ="),
    );
    const hostInstall = evaluations.findIndex((entry) => entry.expression.includes(source));
    assert.ok(
      taskWrapper >= 0 && hostInstall > taskWrapper,
      "the live request wrapper must precede the host's initial read during hot updates",
    );
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

test("task page wrapper waits through the IPC deadline, then cleans timed-out requests", async () => {
  const listeners = new Map<string, (params: unknown) => void>();
  const source = "/* synthetic browser bundle */";
  const bundle = createGoalProgressRendererBundle(source, {
    schemaVersion: 1,
    releaseVersion: GOAL_PROGRESS_RELEASE_VERSION,
    pageHostVersion: GOAL_PROGRESS_PAGE_HOST_VERSION,
    file: "goal-progress.js",
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  const receivedBindings: unknown[] = [];
  const page: Record<string, unknown> = {
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimerId;
      timers.set(id, { dueAt: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  const advance = (duration: number) => {
    const endAt = now + duration;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= endAt)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.dueAt;
      timers.delete(id);
      timer.callback();
    }
    now = endAt;
  };
  const visibleThread = "chat-a";
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
        const p = (params ?? {}) as { name?: string; expression?: string };
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
        if (method === "Runtime.addBinding" && p.name?.startsWith("__CODEX_TASK_PROGRESS_")) {
          Object.defineProperty(page, p.name, {
            configurable: true,
            value: (payload: string) => {
              receivedBindings.push(JSON.parse(payload));
            },
          });
        }
        if (method === "Runtime.evaluate") {
          const expression = p.expression ?? "";
          if (expression.endsWith("(document).threadId"))
            return { result: { value: visibleThread } };
          if (expression.includes("globalThis.__codexTaskProgressRequest =")) {
            runInNewContext(expression, page);
          } else if (expression.includes("__codexTaskProgressResolve?.(")) {
            runInNewContext(expression, page);
          } else if (expression === "globalThis.__CODEX_GOAL_PROGRESS__") {
            return { result: { type: "object", objectId: "host" } };
          }
          return { result: { value: true } };
        }
        if (method === "Runtime.callFunctionOn")
          return {
            result: {
              value: { action: "unmounted", reason: "ok", hostCount: 0 },
            },
          };
        return {};
      },
    },
    async onTaskRequest(request) {
      return { threadId: request.threadId };
    },
  });
  try {
    await bridge.clear();
    const request = (
      page as unknown as {
        __codexTaskProgressRequest: (input: {
          method: "get";
          threadId: string;
        }) => Promise<unknown>;
      }
    ).__codexTaskProgressRequest;

    const first = request({ method: "get", threadId: "chat-a" });
    assert.equal(receivedBindings.length, 1);
    assert.equal(
      [...timers.values()][0]?.dueAt,
      now + TASK_PROGRESS_REQUEST_TIMEOUT_MS + TASK_PROGRESS_RENDERER_DELIVERY_MARGIN_MS,
    );
    advance(12_000);
    const firstId = (receivedBindings[0] as { id: string }).id;
    runInNewContext(
      `globalThis.__codexTaskProgressResolve(${JSON.stringify(firstId)}, { ok: true }, null)`,
      page,
    );
    assert.equal(JSON.stringify(await first), JSON.stringify({ ok: true }));
    assert.equal(timers.size, 0, "a successful response clears its outer timer");

    const timedOut = request({ method: "get", threadId: "chat-a" });
    const timedOutId = (receivedBindings[1] as { id: string }).id;
    const rejected = assert.rejects(timedOut, /Task panel connection timed out/);
    assert.equal(
      [...timers.values()][0]?.dueAt,
      now + TASK_PROGRESS_REQUEST_TIMEOUT_MS + TASK_PROGRESS_RENDERER_DELIVERY_MARGIN_MS,
    );
    advance(TASK_PROGRESS_REQUEST_TIMEOUT_MS + TASK_PROGRESS_RENDERER_DELIVERY_MARGIN_MS);
    await rejected;
    assert.equal(timers.size, 0, "timeout removes its pending timer");

    const next = request({ method: "get", threadId: "chat-a" });
    const nextId = (receivedBindings[2] as { id: string }).id;
    runInNewContext(
      `globalThis.__codexTaskProgressResolve(${JSON.stringify(timedOutId)}, { stale: true }, null)`,
      page,
    );
    runInNewContext(
      `globalThis.__codexTaskProgressResolve(${JSON.stringify(nextId)}, { fresh: true }, null)`,
      page,
    );
    assert.equal(
      JSON.stringify(await next),
      JSON.stringify({ fresh: true }),
      "a late reply cannot settle the next request",
    );
    assert.equal(timers.size, 0);
  } finally {
    await bridge.close();
  }
});
