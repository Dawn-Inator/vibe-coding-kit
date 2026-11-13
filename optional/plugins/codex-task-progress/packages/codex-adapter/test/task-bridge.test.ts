import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { GOAL_PROGRESS_RELEASE_VERSION } from "../../contracts/src/index.js";
import rendererBundlePolicy from "../../contracts/src/renderer-bundle-policy.json" with {
  type: "json",
};
import { inspectGoalProgressRuntime } from "../../host/src/helper-doctor.js";
import { RendererTargetManager } from "../../host/src/renderer-target-manager.js";
import { TASK_PROGRESS_REQUEST_TIMEOUT_MS } from "../../ipc/src/index.js";
import { discoverCodexCdp, isCodexRendererPageUrl } from "../src/cdp.js";
import { GOAL_PROGRESS_PAGE_HOST_VERSION } from "../src/page-host.js";
import {
  GoalProgressRendererBridge,
  TASK_PROGRESS_RENDERER_DELIVERY_MARGIN_MS,
} from "../src/renderer-bridge.js";
import {
  createGoalProgressRendererBundle,
  GOAL_PROGRESS_RENDERER_BUNDLE_MAX_BYTES,
} from "../src/renderer-bundle.js";

test("CDP renderer discovery accepts only the Codex main and detached conversation pages", async () => {
  const detachedUrl = "app://-/detached-window.html?initialRoute=%2Fdetached-window";
  assert.equal(isCodexRendererPageUrl("app://-/index.html"), true);
  assert.equal(isCodexRendererPageUrl("app://-/index.html?initialRoute=%2Flocal%2Fchat-1"), true);
  assert.equal(isCodexRendererPageUrl(detachedUrl), true);
  for (const rejectedUrl of [
    "app://-/avatar-overlay.html",
    "app://-/detached-window.html",
    "app://-/detached-window.html?initialRoute=%2Fother",
    "app://-/detached-window.html?initialRoute=%2Fdetached-window&extra=1",
    "app://-/detached-window.html?initialRoute=%2Fdetached-window&initialRoute=%2Fdetached-window",
    "app://-/detached-window.html?initialRoute=%2Fdetached-window#fragment",
    "app://user@-/detached-window.html?initialRoute=%2Fdetached-window",
    "app://-:1234/detached-window.html?initialRoute=%2Fdetached-window",
    "https://example.com/detached-window.html?initialRoute=%2Fdetached-window",
    "app://-/unknown.html",
  ]) {
    assert.equal(isCodexRendererPageUrl(rejectedUrl), false, rejectedUrl);
  }

  const urls = [
    { id: "main", type: "page", url: "app://-/index.html" },
    { id: "detached", type: "page", url: detachedUrl },
    { id: "avatar", type: "page", url: "app://-/avatar-overlay.html" },
    { id: "unknown", type: "page", url: "app://-/unexpected.html" },
    {
      id: "wrong-route",
      type: "page",
      url: "app://-/detached-window.html?initialRoute=%2Fother",
    },
    {
      id: "multiple-params",
      type: "page",
      url: "app://-/detached-window.html?initialRoute=%2Fdetached-window&extra=1",
    },
    {
      id: "hash",
      type: "page",
      url: "app://-/detached-window.html?initialRoute=%2Fdetached-window#fragment",
    },
    {
      id: "credentials",
      type: "page",
      url: "app://user@-/detached-window.html?initialRoute=%2Fdetached-window",
    },
    {
      id: "remote",
      type: "page",
      url: "https://example.com/detached-window.html?initialRoute=%2Fdetached-window",
    },
    { id: "iframe", type: "iframe", url: detachedUrl },
    { id: "webview", type: "webview", url: detachedUrl },
  ].map((target) => ({
    ...target,
    title: target.id,
    webSocketDebuggerUrl: `ws://127.0.0.1:54235/devtools/page/${target.id}`,
  }));
  const discovery = await discoverCodexCdp(54235, async (input) => {
    const path = new URL(String(input)).pathname;
    const payload =
      path === "/json/version"
        ? {
            Browser: "Codex",
            "Protocol-Version": "1.3",
            "User-Agent": "Codex test",
            webSocketDebuggerUrl: "ws://127.0.0.1:54235/devtools/browser/test",
          }
        : urls;
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  assert.deepEqual(
    discovery.targets.map(({ id, url }) => ({ id, url })),
    [
      { id: "main", url: "app://-/index.html" },
      { id: "detached", url: detachedUrl },
    ],
  );
});

test("production renderer artifact obeys the shared size policy and runtime integrity checks", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const artifact = await readFile(resolve(root, "dist/renderer/goal-progress.js"));
  const manifest = JSON.parse(
    await readFile(resolve(root, "dist/renderer/goal-progress.manifest.json"), "utf8"),
  );
  assert.equal(
    GOAL_PROGRESS_RENDERER_BUNDLE_MAX_BYTES,
    rendererBundlePolicy.rendererBundleMaxBytes,
  );
  assert.ok(artifact.byteLength <= rendererBundlePolicy.rendererBundleMaxBytes);
  const source = Buffer.from(artifact).toString("utf8");
  const bundle = createGoalProgressRendererBundle(source, manifest);
  assert.equal(bundle.source, source);
  assert.equal(bundle.manifest.bytes, artifact.byteLength);
  assert.equal(manifest.releaseVersion, GOAL_PROGRESS_RELEASE_VERSION);
  assert.equal(manifest.pageHostVersion, GOAL_PROGRESS_PAGE_HOST_VERSION);

  assert.throws(
    () => createGoalProgressRendererBundle(source, { ...manifest, bytes: manifest.bytes + 1 }),
    /GOAL_PROGRESS_RENDERER_BUNDLE_BYTES_MISMATCH/u,
  );
  assert.throws(
    () => createGoalProgressRendererBundle(source, { ...manifest, sha256: "0".repeat(64) }),
    /GOAL_PROGRESS_RENDERER_BUNDLE_SHA256_MISMATCH/u,
  );
  const capacitySource = "x".repeat(rendererBundlePolicy.rendererBundleMaxBytes);
  const capacityManifest = {
    ...manifest,
    bytes: Buffer.byteLength(capacitySource),
    sha256: createHash("sha256").update(capacitySource).digest("hex"),
  };
  assert.equal(
    createGoalProgressRendererBundle(capacitySource, capacityManifest).manifest.bytes,
    rendererBundlePolicy.rendererBundleMaxBytes,
  );
  const oversizedSource = "x".repeat(rendererBundlePolicy.rendererBundleMaxBytes + 1);
  assert.throws(() =>
    createGoalProgressRendererBundle(oversizedSource, {
      ...manifest,
      bytes: Buffer.byteLength(oversizedSource),
      sha256: createHash("sha256").update(oversizedSource).digest("hex"),
    }),
  );

  const fixtureRoot = await mkdtemp(join(tmpdir(), "renderer-bundle-limit-"));
  try {
    const sourceRoot = fixtureRoot;
    const contractsRoot = join(sourceRoot, "packages/contracts/src");
    const adapterRoot = join(sourceRoot, "packages/codex-adapter/src");
    await mkdir(contractsRoot, { recursive: true });
    await mkdir(adapterRoot, { recursive: true });
    await writeFile(
      join(contractsRoot, "renderer-bundle-policy.json"),
      JSON.stringify(rendererBundlePolicy),
    );
    await writeFile(
      join(contractsRoot, "page-host-version.json"),
      JSON.stringify({ pageHostVersion: GOAL_PROGRESS_PAGE_HOST_VERSION }),
    );
    await writeFile(
      join(adapterRoot, "browser-entry.ts"),
      `globalThis.fixture = "${"x".repeat(rendererBundlePolicy.rendererBundleMaxBytes + 4096)}";\n`,
    );

    const runtimeOutput = join(fixtureRoot, "runtime-output");
    await mkdir(runtimeOutput, { recursive: true });
    await writeFile(join(runtimeOutput, "sentinel.txt"), "preserve runtime output");
    const runtimeBuild = spawnSync(
      process.execPath,
      [
        resolve(root, "runtime/build-runtime.mjs"),
        "--source",
        sourceRoot,
        "--output",
        runtimeOutput,
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    assert.notEqual(runtimeBuild.status, 0);
    assert.match(
      `${runtimeBuild.stdout}\n${runtimeBuild.stderr}`,
      /GOAL_PROGRESS_RENDERER_BUNDLE_SIZE_INVALID/u,
    );
    assert.deepEqual(await readdir(runtimeOutput), ["sentinel.txt"]);
    assert.equal(
      await readFile(join(runtimeOutput, "sentinel.txt"), "utf8"),
      "preserve runtime output",
    );

    const prebuiltScripts = join(fixtureRoot, "scripts");
    await mkdir(prebuiltScripts, { recursive: true });
    await writeFile(
      join(fixtureRoot, "package.json"),
      await readFile(resolve(root, "package.json")),
    );
    await writeFile(
      join(prebuiltScripts, "build_renderer_bundle.mjs"),
      await readFile(resolve(root, "scripts/build_renderer_bundle.mjs")),
    );
    await symlink(resolve(root, "node_modules"), join(fixtureRoot, "node_modules"), "dir");
    const prebuiltOutput = join(fixtureRoot, "dist/renderer");
    await mkdir(prebuiltOutput, { recursive: true });
    await writeFile(join(prebuiltOutput, "sentinel.txt"), "preserve prebuilt output");
    const prebuiltBuild = spawnSync(
      process.execPath,
      [join(prebuiltScripts, "build_renderer_bundle.mjs")],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    assert.notEqual(prebuiltBuild.status, 0);
    assert.match(
      `${prebuiltBuild.stdout}\n${prebuiltBuild.stderr}`,
      /GOAL_PROGRESS_RENDERER_BUNDLE_SIZE_INVALID/u,
    );
    assert.deepEqual(await readdir(prebuiltOutput), ["sentinel.txt"]);
    assert.equal(
      await readFile(join(prebuiltOutput, "sentinel.txt"), "utf8"),
      "preserve prebuilt output",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

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

test("doctor exposes the ordinary task panel independently of native Goal health", async () => {
  const source = "/* diagnostic bundle */";
  const bundle = createGoalProgressRendererBundle(source, {
    schemaVersion: 1,
    releaseVersion: GOAL_PROGRESS_RELEASE_VERSION,
    pageHostVersion: GOAL_PROGRESS_PAGE_HOST_VERSION,
    file: "goal-progress.js",
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  const panel = {
    version: 1,
    elementName: "codex-task-panel",
    threadId: "chat-a",
    visible: true,
    connected: true,
    count: 1,
    threadMatched: true,
    composerCount: 1,
    textboxCount: 1,
    threadCandidateCount: 1,
    rejectionReason: null,
    threadRejectionReason: null,
    bounds: { x: 1, y: 2, width: 100, height: 44 },
    status: "connected",
    lastError: null,
    lastRefreshAt: null,
    revision: 3,
  };
  const bridge = new GoalProgressRendererBridge({
    bundle,
    platform: "macos",
    appVersion: "test",
    sender: {
      async send() {
        return {
          result: {
            value: {
              reason: "not-configured",
              hostCount: 0,
              componentVisible: false,
              taskPanel: panel,
            },
          },
        };
      },
    },
  });
  try {
    const matching = await bridge.doctor("chat-a");
    assert.deepEqual(matching.taskPanel, panel);
    assert.equal(matching.componentCount, 0);
    assert.equal(matching.capabilityReason, "not-configured");
    assert.equal(matching.bundleSha256, bundle.manifest.sha256);
    const mismatch = await bridge.doctor("chat-b");
    assert.equal(mismatch.taskPanel?.visible, false);
    assert.equal(mismatch.taskPanel?.threadMatched, false);
    assert.equal(mismatch.taskPanel?.bounds, null);
  } finally {
    await bridge.close();
  }
});

test("target doctor reports bounded per-window task diagnostics without changing selected Goal results", async () => {
  let failB = false;
  const targets = ["a", "b"].map((targetId) => ({
    targetId,
    type: "page",
    url: "app://-/index.html",
  }));
  const manager = new RendererTargetManager({
    connector: async () => ({
      initialTargets: targets,
      onTargetInfo: () => () => undefined,
      onTargetDestroyed: () => () => undefined,
      close: async () => undefined,
      connectTarget: async ({ targetId }) =>
        ({
          clear: async () => undefined,
          recoverVisibleThreadId: async () => (targetId === "a" ? "chat-a" : null),
          doctor: async () => {
            if (targetId === "b" && failB) throw new Error("private path /tmp/secret");
            return {
              lastErrorCode: null,
              displayRequired: null,
              taskPanel: {
                version: 1,
                elementName: "codex-task-panel",
                threadId: targetId === "a" ? "chat-a" : null,
                connected: true,
                visible: targetId === "a",
                count: 1,
                threadMatched: targetId === "a",
                composerCount: targetId === "a" ? 1 : 0,
                textboxCount: targetId === "a" ? 1 : 0,
                threadCandidateCount: targetId === "a" ? 1 : 0,
                rejectionReason: targetId === "a" ? null : "composer-root-missing",
                threadRejectionReason: targetId === "a" ? null : "visible-thread-marker-missing",
                bounds: null,
                status: targetId === "a" ? "connected" : "waiting",
                lastError: null,
                lastRefreshAt: null,
                revision: null,
              },
            };
          },
          close: async () => undefined,
        }) as never,
    }),
  });
  try {
    await manager.start();
    const selected = await manager.doctor("chat-a");
    assert.equal(selected.taskPanel?.threadId, "chat-a");
    assert.equal(selected.taskPanelTargetCount, 2);
    assert.deepEqual(
      selected.taskPanels?.map((entry) => [entry.targetId, entry.taskPanel?.status]),
      [
        ["a", "connected"],
        ["b", "waiting"],
      ],
    );
    const runtime = await inspectGoalProgressRuntime("unknown-chat", {
      rendererDoctor: (threadId) => manager.doctor(threadId),
      store: { load: async () => ({ contract: null }) } as never,
      refreshUsage: async () => undefined,
      readNativeGoal: async () => null,
      startupListener: undefined,
    });
    assert.equal(runtime.renderer.taskPanel, null);
    assert.equal(runtime.renderer.taskPanels.length, 2);
    assert.equal(
      runtime.renderer.taskPanels[1]?.taskPanel?.threadRejectionReason,
      "visible-thread-marker-missing",
    );
    assert.equal(runtime.lastErrorCode, "RENDERER_TARGET_UNAVAILABLE");
    failB = true;
    const withFailure = await manager.doctor("chat-a");
    assert.equal(withFailure.taskPanel?.threadId, "chat-a");
    assert.equal(withFailure.taskPanels?.[1]?.errorCode, "RENDERER_TARGET_UNAVAILABLE");
    await assert.rejects(manager.doctor(), /private path/);
  } finally {
    await manager.close();
  }
});
