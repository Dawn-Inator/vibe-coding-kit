import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const fixture = `<!doctype html><html lang="zh-CN"><head><style>
:root{color-scheme:light dark;--ctp-surface:Canvas;--ctp-text:CanvasText;--ctp-accent:var(--ctp-text);--ctp-muted:GrayText;--ctp-border:color-mix(in srgb,currentColor 18%,transparent)}
body{font:14px system-ui;margin:0;background:transparent}#native-panel-shell{box-sizing:border-box;min-height:100vh;padding:12px;display:flex;flex-direction:column}
#messages{flex:1;min-height:0;overflow:auto}#composer{width:100%;height:100px;flex-shrink:0;background:var(--ctp-surface);border:1px solid #ccc;margin-bottom:20px;box-sizing:border-box}[role=textbox]{height:80px}
</style></head><body>
<main id="native-panel-shell" aria-label="Task progress"><div id="messages">Native task progress panel</div><div id="composer" data-codex-composer-root><div role="textbox" contenteditable="true"></div></div></main>
<script>
window.fixture = {delay:Number(new URL(location.href).searchParams.get("initialDelay") || 0),getFailureNext:new URL(location.href).searchParams.get("initialGetFailure"),holdNextGetFailure:false,releaseHeldGetFailure:null,holdNextGetSuccess:false,releaseHeldGetSuccess:null,getFailureThrownCount:0,fixtureEvents:[],delayNextHistory:0,holdNextHistoryFailure:false,releaseHeldHistoryFailure:null,historyFailureNext:null,heartbeatHistoryFailureNext:null,holdNextHeartbeatHistory:false,releaseHeldHeartbeatHistory:null,heartbeatHistoryResponses:[],heartbeatPending:false,task:null, taskSource:null, heartbeat:null, execution:{state:"unknown",observedAt:"2026-11-11T12:00:00Z",source:"codex-app-server"}, history:{events:[],nextCursor:null}, heartbeatHistory:null, calls:[],disabled:new URL(location.href).searchParams.get("disabled")==="true"};
window.fixture.threadId = "thread-a";
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  const fixtureRequestId = window.fixture.fixtureEvents.length + 1;
  window.fixture.fixtureEvents.push({type:'request',id:fixtureRequestId,method:request.method,threadId:request.threadId,at:performance.now()});
  if(request.method==='get' && window.fixture.getFailureNext) { const message=window.fixture.getFailureNext; window.fixture.getFailureNext=null; if(window.fixture.holdNextGetFailure) { window.fixture.holdNextGetFailure=false; await new Promise(resolve => { window.fixture.releaseHeldGetFailure=resolve; }); window.fixture.releaseHeldGetFailure=null; } window.fixture.getFailureThrownCount++; window.fixture.fixtureEvents.push({type:'response',id:fixtureRequestId,method:request.method,threadId:request.threadId,outcome:'error',at:performance.now()}); throw new Error(message); }
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.disabled?null:window.fixture.task,taskSource:window.fixture.disabled?null:window.fixture.taskSource,heartbeat:window.fixture.disabled?null:window.fixture.heartbeat,heartbeatPending:window.fixture.heartbeatPending,execution:window.fixture.execution,...(window.fixture.disabled?{enabled:false}:{}),...(request.method==='history'?{history:window.fixture.history}:{}),...(request.method==='heartbeat-history'?{heartbeatHistory:window.fixture.heartbeatHistory}:{})};
  if(request.method==='history' && window.fixture.historyFailureNext) { const message=window.fixture.historyFailureNext; window.fixture.historyFailureNext=null; if(window.fixture.holdNextHistoryFailure) { window.fixture.holdNextHistoryFailure=false; await new Promise(resolve => { window.fixture.releaseHeldHistoryFailure=resolve; }); window.fixture.releaseHeldHistoryFailure=null; } throw new Error(message); }
  if(request.method==='heartbeat-history' && window.fixture.holdNextHeartbeatHistory) { window.fixture.holdNextHeartbeatHistory=false; await new Promise(resolve => { window.fixture.releaseHeldHeartbeatHistory=resolve; }); window.fixture.releaseHeldHeartbeatHistory=null; }
  if(request.method==='heartbeat-history' && window.fixture.heartbeatHistoryFailureNext) { const message=window.fixture.heartbeatHistoryFailureNext; window.fixture.heartbeatHistoryFailureNext=null; throw new Error(message); }
  if(request.method==='history' && window.fixture.delayNextHistory) { const delay=window.fixture.delayNextHistory; window.fixture.delayNextHistory=0; await new Promise(resolve => setTimeout(resolve,delay)); }
  if(window.fixture.delay && request.threadId === 'thread-a') await new Promise(resolve => setTimeout(resolve,window.fixture.delay));
  if(request.method==='get' && window.fixture.holdNextGetSuccess) { window.fixture.holdNextGetSuccess=false; await new Promise(resolve => { window.fixture.releaseHeldGetSuccess=resolve; }); window.fixture.releaseHeldGetSuccess=null; }
  if(request.method==='get') window.fixture.fixtureEvents.push({type:'response',id:fixtureRequestId,method:request.method,threadId:request.threadId,outcome:'success',at:performance.now()});
  if(request.method==='heartbeat-history') window.fixture.heartbeatHistoryResponses.push({threadId:request.threadId,sourcePath:request.sourcePath,at:performance.now()});
  return result;
};
</script><script src="/bundle.js"></script></body></html>`;
const task = {
  schemaVersion: 3,
  kind: "task",
  threadId: "thread-a",
  title: "实现普通任务面板",
  revision: 1,
  createdAt: "2026-11-11T12:00:00Z",
  updatedAt: "2026-11-11T12:00:00Z",
  phase: "active",
  progress: { completed: 1, total: 2, percent: 50 },
  objectives: [
    {
      id: "ui",
      title: "普通聊天界面",
      required: true,
      status: "active",
      evidence: [],
      items: [
        {
          id: "render",
          title: "显示进度",
          status: "completed",
          evidence: [{ summary: "浏览器实测通过", verification: "verified" }],
        },
        { id: "history", title: "展示历史", status: "pending", evidence: [] },
      ],
    },
  ],
};
const heartbeat = {
  status: "ready",
  sourcePath: "/workspace/heartbeat.md",
  basis: "configured",
  candidates: [{ path: "/workspace/heartbeat.md", associated: true }],
  refreshedAt: "2026-11-11T12:00:00Z",
  modifiedAt: "2026-11-11T11:59:00Z",
  lastWakeAt: "2026-11-11T11:40:00Z",
  nextWakeAt: null,
  cadenceMinutes: null,
  certifiesCurrent: false,
  passed: false,
  items: [{ id: "I1", item: "处理阻塞", status: "blocked", evidence: "等待接口" }],
  wakes: [
    {
      heading: "2026-11-11 wake",
      timeMs: Date.parse("2026-11-11T11:40:00Z"),
      rows: [{ category: "Backlog", state: "checked" }],
    },
  ],
  findings: [{ severity: "error", message: "缺少巡检证据" }],
};

test("native task panel component flows", async (t) => {
  const result = await build({
    stdin: {
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "task-panel-native-test-entry.ts",
      loader: "ts",
      contents: `import { registerTaskProgressElement } from "../packages/renderer/src/task-progress-element.ts";
const elementName = registerTaskProgressElement(window);
const element = document.createElement(elementName);
element.locale = navigator.language || "en";
element.threadId = window.fixture.threadId;
element.requester = (request) => window.__codexTaskProgressRequest(request);
document.querySelector("#native-panel-shell").append(element);
let requestSequence = 0;
let lastError = null;
window.__CODEX_TASK_PROGRESS__ = {
  async refresh() {
    const requestId = ++requestSequence;
    const threadId = window.fixture.threadId || null;
    if (element.threadId !== threadId) element.resetThread(threadId);
    try {
      const response = await window.__codexTaskProgressRequest({ method: "get", threadId });
      if (requestId !== requestSequence || element.threadId !== threadId) return;
      element.data = response;
      element.observed = true;
      element.connectionError = null;
      lastError = null;
    } catch (error) {
      if (requestId !== requestSequence || element.threadId !== threadId) return;
      element.connectionError = String(error);
      element.observed = true;
      lastError = "TASK_PROGRESS_ERROR";
    }
    await element.updateComplete;
  },
  diagnostics() {
    return {
      status: element.connectionError ? "error" : element.threadId ? "connected" : "waiting",
      threadId: element.threadId,
      lastError,
      revision: element.data.task?.revision ?? null,
      lastRefreshAt: null,
      textboxCount: document.querySelectorAll('[data-codex-composer-root] [role="textbox"]:not([hidden])').length,
      composerCount: document.querySelectorAll("[data-codex-composer-root]").length,
      rejectionReason: null,
      visible: !element.hidden,
      elementName,
    };
  },
  destroy() { element.remove(); },
};
void window.__CODEX_TASK_PROGRESS__.refresh();`,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
  });
  const bundle = result.outputFiles[0].text;
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url === "/bundle.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    );
    res.end(req.url === "/bundle.js" ? bundle : fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  const contexts = new Set();
  const showView = async (panel, view) => {
    const trigger =
      view === "tasks"
        ? panel.locator(".summary .main")
        : panel.getByRole("button", { name: view === "history" ? "历史" : "心跳", exact: true });
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  };
  const open = async (query = "", contextOptions = {}) => {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 850 },
      locale: "zh-CN",
      ...contextOptions,
    });
    contexts.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    await page.goto(`${url}${query}`);
    await page.locator("codex-task-panel").waitFor({ state: "visible" });
    await page
      .locator("codex-task-panel .summary .main")
      .waitFor()
      .catch((error) => {
        if (pageErrors.length) error.message += `\nPage errors: ${pageErrors.join("\n")}`;
        throw error;
      });
    return { context, page, panel: page.locator("codex-task-panel") };
  };
  try {
    await t.test(
      "disabled project returns an empty standalone panel; omitted flag stays enabled",
      async () => {
        const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
        contexts.add(context);
        const page = await context.newPage();
        await page.goto(`${url}?disabled=true`);
        const panel = page.locator("codex-task-panel");
        await panel.waitFor({ state: "attached" });
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.equal(await panel.count(), 1);
        assert.equal(await panel.isVisible(), true);
        await page.evaluate((value) => {
          window.fixture.task = value;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.equal(await panel.count(), 1);
        assert.equal(await panel.isVisible(), true);
        assert.equal(await panel.getByText("实现普通任务面板", { exact: false }).count(), 0);
        assert.equal(await panel.locator(".row[data-objective]").count(), 0);
        await context.close();
        const legacy = await open();
        assert.equal(await legacy.panel.isVisible(), true);
        await legacy.context.close();
      },
    );
    await t.test(
      "same-path heartbeat hash changes reload history once and reject mismatched cursor pages",
      async () => {
        const { context, page, panel } = await open();
        const sourcePath = "/workspace/project/heartbeat.md";
        const wake = (text, minute) => ({
          timeMs: Date.parse(`2026-11-13T14:${minute}:00Z`),
          rows: [{ category: "status", state: text }],
        });
        const historyA = {
          sourcePath,
          contentHash: "hash-a",
          wakes: [wake("history hash A", "34")],
          nextCursor: null,
          total: 1,
        };
        const historyB = {
          sourcePath,
          contentHash: "hash-b",
          wakes: [wake("history hash B", "35")],
          nextCursor: "cursor-b",
          total: 2,
        };
        try {
          await page.evaluate(
            ({ task, heartbeat, sourcePath, historyA }) => {
              window.fixture.task = task;
              window.fixture.heartbeat = {
                ...heartbeat,
                sourcePath,
                contentHash: "hash-a",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:33:00Z"),
                    rows: [{ category: "status", state: "current hash A snapshot" }],
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyA;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { task, heartbeat, sourcePath, historyA },
          );
          await showView(panel, "heartbeat");
          await panel
            .locator(".hb-record-preview")
            .getByText("history hash A", { exact: true })
            .waitFor();
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 1);
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            1,
            "same-hash get does not reload history",
          );
          await page.evaluate(
            ({ heartbeat, sourcePath, historyB }) => {
              window.fixture.heartbeat = {
                ...heartbeat,
                sourcePath,
                contentHash: "hash-b",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:36:00Z"),
                    rows: [{ category: "status", state: "current hash B snapshot" }],
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyB;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { heartbeat, sourcePath, historyB },
          );
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 2);
          await panel
            .locator(".hb-record-preview")
            .getByText("history hash B", { exact: true })
            .waitFor();
          assert.doesNotMatch(await panel.locator(".hb-history").innerText(), /history hash A/);
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            2,
            "changed hash loads once; same hash does not reload",
          );
          await page.evaluate(
            ({ sourcePath }) => {
              window.fixture.heartbeatHistory = {
                sourcePath,
                contentHash: "hash-a",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:30:00Z"),
                    rows: [{ category: "status", state: "wrong hash cursor page" }],
                  },
                ],
                nextCursor: null,
                total: 2,
              };
            },
            { sourcePath },
          );
          await panel.getByRole("button", { name: "加载更早心跳" }).click();
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 3);
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const calls = await page.evaluate(() =>
            window.fixture.calls.filter((call) => call.method === "heartbeat-history"),
          );
          assert.equal(calls[2].cursor, "cursor-b");
          assert.match(await panel.locator(".hb-history").innerText(), /history hash B/);
          assert.doesNotMatch(
            await panel.locator(".hb-history").innerText(),
            /history hash A|wrong hash cursor page/,
          );
          const capsule = panel.locator(".summary .main");
          const capsuleLabel = await capsule.getAttribute("aria-label");
          const capsulePercent = await capsule.locator(".percent").textContent();
          await page.evaluate(
            ({ sourcePath }) => {
              window.fixture.heartbeatHistory = {
                sourcePath,
                contentHash: "hash-c",
                error: "source changed; refresh project",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:31:00Z"),
                    rows: [{ category: "status", state: "error page bad row" }],
                  },
                ],
                nextCursor: "bad-cursor-c",
                total: 99,
              };
            },
            { sourcePath },
          );
          await panel.getByRole("button", { name: "加载更早心跳" }).click();
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 4);
          const historyError = panel
            .locator(".hb-history .info-card-error")
            .filter({ hasText: "心跳历史错误" });
          await historyError.waitFor();
          assert.equal(await historyError.locator(".diagnostic-text").isVisible(), true);
          assert.match(await historyError.innerText(), /source changed; refresh project/);
          assert.match(await panel.locator(".hb-history").innerText(), /history hash B/);
          assert.doesNotMatch(await panel.locator(".hb-history").innerText(), /error page bad row/);
          assert.equal(await panel.locator(".hb-history-head .hb-count").innerText(), "2");
          assert.equal(await capsule.getAttribute("aria-label"), capsuleLabel);
          assert.equal(await capsule.locator(".percent").textContent(), capsulePercent);
          assert.equal(await panel.evaluate((element) => element.connectionError), null);
          await page.evaluate(
            ({ historyB }) => {
              window.fixture.heartbeatHistory = historyB;
            },
            { historyB },
          );
          await panel.getByRole("button", { name: "加载更早心跳" }).click();
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 5);
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").at(-1)
                ?.cursor === "cursor-b",
          );
          await historyError.waitFor({ state: "hidden" });
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").at(-1)
                  .cursor,
            ),
            "cursor-b",
            "bad response cursor is not accepted",
          );
          assert.match(await panel.locator(".hb-history").innerText(), /history hash B/);
          assert.doesNotMatch(await panel.locator(".hb-history").innerText(), /error page bad row/);
          assert.equal(await capsule.getAttribute("aria-label"), capsuleLabel);
          assert.equal(await capsule.locator(".percent").textContent(), capsulePercent);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "same-path heartbeat hash change lets new history pass a held old response",
      async () => {
        const { context, page, panel } = await open();
        const sourcePath = "/workspace/project/heartbeat.md";
        const historyA = {
          sourcePath,
          contentHash: "hash-a",
          wakes: [
            {
              timeMs: Date.parse("2026-11-13T14:34:00Z"),
              rows: [{ category: "status", state: "held history hash A" }],
            },
          ],
          nextCursor: null,
          total: 1,
        };
        const historyB = {
          sourcePath,
          contentHash: "hash-b",
          wakes: [
            {
              timeMs: Date.parse("2026-11-13T14:35:00Z"),
              rows: [{ category: "status", state: "new history hash B" }],
            },
          ],
          nextCursor: null,
          total: 1,
        };
        try {
          await page.evaluate(
            ({ task, heartbeat, sourcePath, historyA }) => {
              window.fixture.task = task;
              window.fixture.heartbeat = {
                ...heartbeat,
                sourcePath,
                contentHash: "hash-a",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:33:00Z"),
                    rows: [{ category: "status", state: "current hash A snapshot" }],
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyA;
              window.fixture.holdNextHeartbeatHistory = true;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { task, heartbeat, sourcePath, historyA },
          );
          await showView(panel, "heartbeat");
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldHeartbeatHistory === "function",
          );
          await page.evaluate(
            ({ heartbeat, sourcePath, historyB }) => {
              window.fixture.heartbeat = {
                ...heartbeat,
                sourcePath,
                contentHash: "hash-b",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T14:36:00Z"),
                    rows: [{ category: "status", state: "current hash B snapshot" }],
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyB;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { heartbeat, sourcePath, historyB },
          );
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").length ===
              2,
          );
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 1);
          await panel
            .locator(".hb-record-preview")
            .getByText("new history hash B", { exact: true })
            .waitFor();
          assert.equal(
            await page.evaluate(() => typeof window.fixture.releaseHeldHeartbeatHistory),
            "function",
          );
          await page.evaluate(() => window.fixture.releaseHeldHeartbeatHistory());
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 2);
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.match(await panel.locator(".hb-history").innerText(), /new history hash B/);
          assert.doesNotMatch(
            await panel.locator(".hb-history").innerText(),
            /held history hash A/,
          );
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            2,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "heartbeat notice keeps the verified project view and history through a pending refresh, then fences terminal responses",
      async () => {
        const { context, page, panel } = await open();
        const sourcePath = "/workspace/shared-project/heartbeat.md";
        const oldHistory = {
          wakes: [
            {
              timeMs: Date.parse("2026-11-13T14:34:48Z"),
              rows: [{ category: "status", state: "verified cached record" }],
            },
          ],
          nextCursor: null,
          total: 1,
          sourcePath,
          contentHash: "hash-a",
        };
        try {
          await page.evaluate(
            ({ value, history, sourcePath, taskValue }) => {
              window.fixture.heartbeat = {
                ...value,
                status: "ready",
                sourcePath,
                contentHash: "hash-a",
                wakes: history.wakes,
                wakeCount: 1,
                warning: "Project heartbeat refresh notice",
              };
              window.fixture.heartbeatHistory = history;
              window.fixture.task = taskValue;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: heartbeat, history: oldHistory, sourcePath, taskValue: task },
          );
          await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor();
          await panel.locator(".heartbeat-trigger").click();
          await panel
            .locator(".hb-record-preview")
            .getByText("verified cached record", { exact: true })
            .waitFor();
          assert.equal(await panel.locator(".hb-alert .info-card-title").count(), 1);
          assert.match(
            await panel.locator(".hb-alert").innerText(),
            /Project heartbeat refresh notice/,
          );

          await page.evaluate(() => {
            window.fixture.heartbeat = {
              ...window.fixture.heartbeat,
              certifiesCurrent: false,
              status: "stale",
            };
            window.fixture.heartbeatPending = true;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel.getByText(/正在刷新项目心跳；当前显示最近一次已验证的快照/).waitFor();
          await panel
            .locator(".hb-record-preview")
            .getByText("verified cached record", { exact: true })
            .waitFor();
          assert.equal(await panel.locator(".hb-history .hb-count").innerText(), "1");
          const historyCallsBeforeRefresh = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
          );
          await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).click();
          await page.waitForFunction(
            (count) =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").length ===
              count + 1,
            historyCallsBeforeRefresh,
          );

          await page.evaluate(
            ({ value, sourcePath }) => {
              window.fixture.heartbeatPending = false;
              window.fixture.heartbeat = {
                ...value,
                status: "ready",
                sourcePath,
                contentHash: "hash-b",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:00:00Z"),
                    rows: [{ category: "status", state: "new verified record" }],
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:00:00Z"),
                    rows: [{ category: "status", state: "new verified record" }],
                  },
                ],
                nextCursor: null,
                total: 1,
                sourcePath,
                contentHash: "hash-b",
              };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: heartbeat, sourcePath },
          );
          await panel
            .locator(".hb-record-preview")
            .getByText("new verified record", { exact: true })
            .waitFor();
          assert.equal(await panel.getByText("verified cached record", { exact: true }).count(), 0);

          await page.evaluate(() => {
            window.fixture.heartbeat = {
              ...window.fixture.heartbeat,
              certifiesCurrent: false,
              status: "stale",
            };
            window.fixture.heartbeatPending = true;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel
            .locator(".hb-record-preview")
            .getByText("new verified record", { exact: true })
            .waitFor();
          await page.evaluate(() => {
            window.fixture.heartbeat = null;
            window.fixture.heartbeatPending = false;
            window.fixture.taskSource = {
              status: "error",
              readOnly: true,
              error: "source read failed",
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel.getByText("当前项目没有可显示的心跳来源。", { exact: true }).waitFor();
          assert.equal(await panel.getByText("new verified record", { exact: true }).count(), 0);
          assert.equal(await panel.getByText("verified cached record", { exact: true }).count(), 0);

          await page.evaluate(
            ({ value, sourcePath }) => {
              window.fixture.taskSource = null;
              window.fixture.heartbeat = {
                ...value,
                status: "ready",
                sourcePath,
                contentHash: "hash-c",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:10:00Z"),
                    rows: [{ category: "status", state: "third verified record" }],
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:10:00Z"),
                    rows: [{ category: "status", state: "third verified record" }],
                  },
                ],
                nextCursor: null,
                total: 1,
                sourcePath,
                contentHash: "hash-c",
              };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: heartbeat, sourcePath },
          );
          await panel
            .locator(".hb-record-preview")
            .getByText("third verified record", { exact: true })
            .waitFor();
          await page.evaluate(() => {
            window.fixture.heartbeat = {
              ...window.fixture.heartbeat,
              certifiesCurrent: false,
              status: "stale",
            };
            window.fixture.heartbeatPending = true;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel
            .locator(".hb-record-preview")
            .getByText("third verified record", { exact: true })
            .waitFor();
          await page.evaluate(() => {
            window.fixture.heartbeat = null;
            window.fixture.heartbeatPending = false;
            window.fixture.taskSource = null;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel.getByText("当前项目没有可显示的心跳来源。", { exact: true }).waitFor();
          assert.equal(await panel.getByText("third verified record", { exact: true }).count(), 0);

          await page.evaluate(
            ({ value, sourcePath }) => {
              window.fixture.heartbeat = {
                ...value,
                status: "ready",
                sourcePath,
                contentHash: "hash-d",
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:20:00Z"),
                    rows: [{ category: "status", state: "fourth verified record" }],
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:20:00Z"),
                    rows: [{ category: "status", state: "fourth verified record" }],
                  },
                ],
                nextCursor: null,
                total: 1,
                sourcePath,
                contentHash: "hash-d",
              };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: heartbeat, sourcePath },
          );
          await panel
            .locator(".hb-record-preview")
            .getByText("fourth verified record", { exact: true })
            .waitFor();
          await page.evaluate(() => {
            window.fixture.heartbeat = null;
            window.fixture.heartbeatPending = true;
            window.fixture.taskSource = { status: "pending-selection", readOnly: true };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel.getByText("正在读取项目心跳…", { exact: true }).waitFor();
          assert.equal(await panel.getByText("fourth verified record", { exact: true }).count(), 0);
          assert.equal(await panel.locator(".hb-count").first().innerText(), "0");
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "pending project heartbeat keeps checklist visible, loads history once, and fences same-source chat changes",
      async () => {
        const { context, page, panel } = await open();
        const sourcePath = "/workspace/shared-project/heartbeat.md";
        const baselineWake = {
          timeMs: Date.parse("2026-11-13T14:34:48Z"),
          rows: [{ category: "status", state: "A baseline content" }],
        };
        const aHistory = {
          wakes: [baselineWake],
          nextCursor: null,
          total: 1,
          sourcePath,
        };
        try {
          await page.evaluate((value) => {
            window.fixture.task = value;
            window.fixture.heartbeat = null;
            window.fixture.heartbeatPending = true;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);
          await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor({ timeout: 6000 });
          await showView(panel, "heartbeat");
          await panel.getByText("正在读取项目心跳…", { exact: true }).waitFor({ timeout: 6000 });
          assert.doesNotMatch(
            await panel.locator("section.panel").innerText(),
            /没有当前心跳来源|当前项目没有可显示的心跳来源/,
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            0,
          );

          await page.evaluate(
            ({ value, aHistory, sourcePath }) => {
              window.fixture.heartbeat = {
                ...value,
                status: "ready",
                sourcePath,
                historyPath: "/workspace/shared-project/taskhistory.md",
                wakes: aHistory.wakes,
                wakeCount: 1,
              };
              window.fixture.heartbeatPending = false;
              window.fixture.heartbeatHistory = aHistory;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: heartbeat, aHistory, sourcePath },
          );
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").length ===
              1,
            null,
            { timeout: 6000 },
          );
          await panel
            .locator(".hb-record-preview")
            .getByText("A baseline content", { exact: true })
            .waitFor({ timeout: 6000 });
          assert.equal(
            await panel.getByRole("heading", { name: "项目心跳", exact: true }).count(),
            1,
          );
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          await page.waitForFunction(
            () => window.fixture.calls.filter((call) => call.method === "get").length >= 3,
            null,
            { timeout: 6000 },
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            1,
            "a normal get poll for the same source must not refetch its history",
          );

          const rawSummary = panel
            .locator(".hb-wake")
            .first()
            .locator(".hb-wake-raw")
            .first()
            .locator(":scope > summary");
          await rawSummary.click();
          const rawDetails = panel.locator(".hb-wake").first().locator(".hb-wake-raw").first();
          assert.equal(await rawDetails.getAttribute("open"), "");
          const lateA = {
            wakes: [
              {
                timeMs: Date.parse("2026-11-13T14:18:22Z"),
                rows: [{ category: "status", state: "A late history must not win" }],
              },
            ],
            nextCursor: null,
            total: 2,
            sourcePath,
          };
          await page.evaluate((historyPage) => {
            window.fixture.heartbeatHistory = historyPage;
            window.fixture.holdNextHeartbeatHistory = true;
          }, lateA);
          await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).click();
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldHeartbeatHistory === "function",
            null,
            { timeout: 6000 },
          );

          const bHistory = {
            wakes: [
              {
                timeMs: Date.parse("2026-11-13T14:05:11Z"),
                rows: [{ category: "status", state: "B thread history" }],
              },
            ],
            nextCursor: null,
            total: 1,
            sourcePath,
          };
          await page.evaluate(
            ({ value, bHistory }) => {
              window.fixture.threadId = "thread-b";
              window.fixture.task = { ...value, threadId: "thread-b", title: "B same project" };
              window.fixture.heartbeatHistory = bHistory;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: task, bHistory },
          );
          await page.waitForFunction(
            () =>
              window.fixture.calls.some(
                (call) => call.method === "get" && call.threadId === "thread-b",
              ),
            null,
            { timeout: 6000 },
          );
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter(
                (call) => call.method === "heartbeat-history" && call.threadId === "thread-b",
              ).length === 1,
            null,
            { timeout: 6000 },
          );
          await panel
            .locator(".hb-record-preview")
            .getByText("B thread history", { exact: true })
            .waitFor({ timeout: 6000 });
          assert.equal(
            await panel
              .locator(".hb-wake")
              .first()
              .locator(".hb-wake-raw")
              .first()
              .getAttribute("open"),
            null,
            "switching chats clears the previous wake disclosure state",
          );
          assert.equal(
            await page.evaluate(() => typeof window.fixture.releaseHeldHeartbeatHistory),
            "function",
          );
          await page.evaluate(() => window.fixture.releaseHeldHeartbeatHistory());
          await page.waitForFunction(
            () => window.fixture.heartbeatHistoryResponses.length === 3,
            null,
            { timeout: 6000 },
          );
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").length ===
              3,
            null,
            { timeout: 6000 },
          );
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const historyCalls = await page.evaluate(() =>
            window.fixture.calls.filter((call) => call.method === "heartbeat-history"),
          );
          assert.deepEqual(
            historyCalls.map((call) => call.threadId),
            ["thread-a", "thread-a", "thread-b"],
          );
          assert.match(await panel.locator("section.panel").innerText(), /B thread history/);
          assert.doesNotMatch(
            await panel.locator("section.panel").innerText(),
            /A late history must not win/,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "read-only source errors stay visible and canonical link risks are explained",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate(() => {
          window.fixture.task = null;
          window.fixture.taskSource = {
            status: "stale",
            path: "/workspace/heartbeat.md",
            readOnly: true,
            error: "台账文件已删除",
          };
          window.fixture.heartbeat = null;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel
          .locator(".summary")
          .getByText(/心跳任务来源已过期/)
          .waitFor();
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /尚未建立任务/);
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /台账文件已删除/);
        assert.equal(await panel.getByRole("progressbar").count(), 0);
        await panel.locator(".summary .main").click();
        await panel
          .locator(".scroll .info-card")
          .filter({ hasText: "只读 Kit 任务来源" })
          .waitFor();
        await panel.getByText("台账文件已删除", { exact: true }).waitFor();

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "error",
            readOnly: true,
            error: "Kit source helper unavailable",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel
          .locator(".summary")
          .getByText(/心跳任务来源暂不可用/)
          .waitFor();
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /尚未建立任务/);
        assert.equal(await panel.getByRole("progressbar").count(), 0);

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "pending-selection",
            readOnly: true,
            error: "Multiple heartbeat ledgers match this chat",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel
          .locator(".summary")
          .getByText(/当前任务来源尚未解析/)
          .waitFor();
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /请选择|选择台账/);
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /尚未建立任务/);

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "ready",
            path: "/workspace/heartbeat.md",
            readOnly: true,
          };
          window.fixture.task = {
            threadId: "thread-a",
            title: "Heartbeat ledger task",
            revision: 1,
            updatedAt: "2026-11-11T12:00:00Z",
            objectives: [
              {
                id: "P1",
                title: "Parent",
                status: "blocked",
                required: true,
                evidence: [],
                items: [],
              },
            ],
            progress: { completed: 1, total: 1, percent: 100 },
            phase: "completed",
            source: {
              kind: "kit-heartbeat",
              path: "/workspace/heartbeat.md",
              readOnly: true,
              itemStatuses: { P1: "done", C1: "blocked" },
              linkRisks: ["P1: missing child C1"],
            },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel
          .locator(".summary")
          .getByText(/只读 Kit 心跳来源/)
          .waitFor();
        const mainButton = panel.locator(".summary .main");
        if ((await mainButton.getAttribute("aria-expanded")) !== "true") await mainButton.click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "true");
        await panel.locator(".info-card").filter({ hasText: "只读 Kit 任务来源" }).waitFor();
        await panel.getByText(/P1: missing child C1/).waitFor();
        await panel.getByText(/P1: done · C1: blocked/).waitFor();
        await context.close();
      },
    );
    await t.test(
      "large source and connection diagnostics stay bounded and readable across source states",
      async () => {
        const { context, page, panel } = await open();
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
        const longError = Array.from(
          { length: 700 },
          (_, index) =>
            `Kit Items validation failed at I${index + 9}: missing linked item\nDetail ${index}: verify source row and parent association.`,
        ).join("\n");
        const longPath = `/repo/${"very-long-unbroken-path-segment-".repeat(48)}heartbeat.md`;
        await page.evaluate(
          ({ longError, longPath }) => {
            window.fixture.task = null;
            window.fixture.taskSource = {
              status: "stale",
              path: longPath,
              readOnly: true,
              contentHash: "items-hash",
              error: longError,
            };
            window.fixture.history = {
              events: [],
              wakes: [],
              total: 0,
              nextCursor: null,
              source: {
                kind: "kit-heartbeat",
                path: longPath,
                readOnly: true,
                contentHash: "items-hash",
                error: longError,
              },
            };
            window.fixture.heartbeat = null;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { longError, longPath },
        );
        await panel
          .locator(".summary")
          .getByText(/心跳任务来源已过期/)
          .waitFor();
        const summary = panel.locator(".summary");
        assert.ok((await summary.innerText()).length < 180);
        assert.doesNotMatch(
          await summary.innerText(),
          /I9: missing linked item|very-long-unbroken/,
        );

        const mainButton = panel.locator(".summary .main");
        if ((await mainButton.getAttribute("aria-expanded")) !== "true") await mainButton.click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "true");
        const historyTab = panel.getByRole("button", { name: "历史", exact: true });
        try {
          await historyTab.waitFor({ timeout: 5_000 });
        } catch (error) {
          throw new Error(
            `History tab did not render. pageerrors=${pageErrors.join("\n")}\npanel=${await panel.innerText()}`,
            { cause: error },
          );
        }
        const scroll = panel.locator(".scroll");
        const sourceDiagnostic = scroll
          .locator(".info-card")
          .filter({ hasText: "只读 Kit 任务来源" });
        assert.equal(await sourceDiagnostic.evaluate((element) => element.tagName), "SECTION");
        assert.equal(await sourceDiagnostic.locator("details").count(), 0);
        assert.equal(await sourceDiagnostic.locator(".diagnostic-text").isVisible(), true);
        assert.equal(await sourceDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await scroll.locator(".path-value").textContent()).includes(longPath));
        assert.ok((await panel.locator(".body").boundingBox()).height <= 640);
        assert.ok(
          (await scroll.boundingBox()).height < (await panel.locator(".body").boundingBox()).height,
        );
        await mkdir(".playwright-img", { recursive: true });
        await page.screenshot({ path: ".playwright-img/task-source-error-bounded.png" });

        await page.evaluate(
          ({ longError, projectHeartbeat }) => {
            window.fixture.heartbeat = {
              ...projectHeartbeat,
              status: "ready",
              sourcePath: "/workspace/project/heartbeat.md",
            };
            window.fixture.heartbeatHistoryFailureNext = longError;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { longError, projectHeartbeat: heartbeat },
        );
        await showView(panel, "heartbeat");
        await scroll.locator(".hb-history").waitFor();
        const liveStatus = panel.locator('[role="status"][aria-live="polite"]');
        await liveStatus.filter({ hasText: "清单暂不可用" }).waitFor();
        assert.equal(await liveStatus.count(), 1);
        assert.equal(await liveStatus.getAttribute("aria-atomic"), "true");
        assert.equal(await liveStatus.textContent(), "清单暂不可用");
        assert.match(await summary.innerText(), /清单暂不可用/);
        assert.doesNotMatch(
          await summary.innerText(),
          /I9: missing linked item|very-long-unbroken/,
        );
        const connectionDetails = scroll
          .locator(".info-card-title")
          .filter({ hasText: "连接错误详情" });
        await connectionDetails.click();
        const connectionDiagnostic = scroll
          .locator(".info-card")
          .filter({ hasText: "连接错误详情" });
        assert.equal(await connectionDiagnostic.evaluate((element) => element.tagName), "SECTION");
        assert.equal(await connectionDiagnostic.locator("details").count(), 0);
        assert.equal(
          await connectionDiagnostic.locator(".diagnostic-text").textContent(),
          String(new Error(longError)),
        );
        await panel.getByRole("button", { name: "心跳", exact: true }).click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "false");
        assert.equal(await liveStatus.count(), 1);
        assert.equal(await liveStatus.textContent(), "清单暂不可用");
        assert.doesNotMatch(await liveStatus.textContent(), /I9: missing linked item/);
        await panel.evaluate((element) => {
          element.connectionError = null;
        });
        if ((await mainButton.getAttribute("aria-expanded")) !== "true") await mainButton.click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "true");
        await page.evaluate(
          ({ longError, projectHeartbeat }) => {
            window.fixture.heartbeat = {
              ...projectHeartbeat,
              status: "error",
              sourcePath: null,
              error: longError,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { longError, projectHeartbeat: heartbeat },
        );
        await showView(panel, "heartbeat");
        const projectError = scroll.locator(".info-card-title").filter({ hasText: "项目心跳错误" });
        await projectError.waitFor();
        await projectError.click();
        const projectDiagnostic = scroll.locator(".info-card").filter({ hasText: "项目心跳错误" });
        assert.equal(await projectDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await panel.locator(".body").boundingBox()).height <= 640);

        for (const [status, expected] of [
          ["error", /心跳任务来源暂不可用/],
          ["pending-selection", /当前任务来源尚未解析/],
        ]) {
          await page.evaluate((nextStatus) => {
            window.fixture.taskSource.status = nextStatus;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, status);
          await summary.getByText(expected).waitFor();
          assert.ok((await summary.innerText()).length < 180);
          assert.doesNotMatch(
            await summary.innerText(),
            /I9: missing linked item|very-long-unbroken/,
          );
        }

        await panel.getByRole("button", { name: "历史", exact: true }).click();
        const historyError = scroll
          .locator(".info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await historyError.waitFor();
        await historyError.click();
        const historyDiagnostic = scroll
          .locator(".info-card")
          .filter({ hasText: "台账历史不可用" });
        assert.equal(await historyDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await panel.locator(".body").boundingBox()).height <= 640);

        await panel.getByRole("button", { name: "心跳", exact: true }).click();
        assert.equal(await panel.locator(".body").isVisible(), true);
        assert.match(await panel.locator(".panel-title").innerText(), /项目心跳/);
        await context.close();
      },
    );
    await t.test("capsule hierarchy and tabs remain in the native panel", async () => {
      const { context, page, panel } = await open();
      await page.evaluate(
        ({ task, heartbeat }) => {
          window.fixture.task = {
            ...task,
            objectives: [
              {
                ...task.objectives[0],
                items: [
                  ...task.objectives[0].items,
                  { id: "cancelled", title: "取消的节点", status: "cancelled", evidence: [] },
                ],
              },
            ],
          };
          window.fixture.heartbeat = heartbeat;
          window.fixture.history = {
            events: [{ occurredAt: "2026-11-11T12:01:00Z", reason: "真实历史请求" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        },
        { task, heartbeat },
      );
      const main = panel.locator(".summary .main");
      assert.equal((await main.boundingBox()).height, 44);
      assert.equal(
        await panel.locator(".edge-fill").evaluate((element) => element.namespaceURI),
        "http://www.w3.org/2000/svg",
      );
      for (const name of ["历史", "心跳"]) {
        const circle = await panel.getByRole("button", { name, exact: true }).boundingBox();
        assert.equal(circle.width, 40);
        assert.equal(circle.height, 40);
      }
      assert.equal(await panel.locator(".body").isVisible(), true);
      assert.equal(
        await page.evaluate(
          () => window.fixture.calls.filter((call) => call.method === "history").length,
        ),
        0,
      );
      const idleMainBorder = await main.evaluate(
        (element) => getComputedStyle(element).borderColor,
      );
      await main.click();
      const pointerFocus = await main.evaluate((element) => ({
        borderColor: getComputedStyle(element).borderColor,
        focusVisible: element.matches(":focus-visible"),
        outlineStyle: getComputedStyle(element).outlineStyle,
        outlineWidth: getComputedStyle(element).outlineWidth,
      }));
      assert.equal(
        pointerFocus.borderColor,
        idleMainBorder,
        "pointer opening keeps the pill border neutral",
      );
      assert.equal(
        pointerFocus.focusVisible,
        false,
        "pointer focus does not receive the keyboard ring",
      );
      assert.ok(
        pointerFocus.outlineStyle === "none" || pointerFocus.outlineWidth === "0px",
        "pointer focus has no visible outline",
      );
      const module = panel.getByRole("button", { name: /普通聊天界面/ });
      const meter = panel.getByRole("meter");
      assert.equal(await meter.getAttribute("aria-valuenow"), "50");
      assert.match(await module.innerText(), /1\s*\/\s*2/);
      await module.click();
      assert.equal(await module.getAttribute("aria-expanded"), "true");
      assert.equal(await panel.locator(".check").count(), 3);
      assert.match(await panel.locator(".detail").innerText(), /浏览器实测通过/);
      await module.press("Escape");
      assert.equal(await module.getAttribute("aria-expanded"), "false");
      await module.press("Escape");
      assert.equal(await panel.locator(".body").isVisible(), true);
      assert.equal(
        await panel.evaluate((element) =>
          element.shadowRoot.activeElement?.classList.contains("row"),
        ),
        true,
      );
      await panel.evaluate((element) => element.shadowRoot.activeElement?.blur());
      await page.locator("[role=textbox]:visible").focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await panel.evaluate(
          (element) =>
            element.shadowRoot.activeElement === element.shadowRoot.querySelector(".summary .main"),
        ),
        true,
        "Tab reaches the main pill before the other controls",
      );
      const keyboardFocus = await main.evaluate((element) => ({
        focusVisible: element.matches(":focus-visible"),
        outlineStyle: getComputedStyle(element).outlineStyle,
        outlineWidth: getComputedStyle(element).outlineWidth,
        boxShadow: getComputedStyle(element).boxShadow,
      }));
      assert.equal(
        keyboardFocus.focusVisible,
        true,
        "keyboard navigation retains focus-visible state",
      );
      assert.ok(
        (keyboardFocus.outlineStyle !== "none" && keyboardFocus.outlineWidth !== "0px") ||
          keyboardFocus.boxShadow !== "none",
        "keyboard focus remains visibly indicated",
      );
      await main.press("Enter");
      await panel.locator(".body").waitFor({ state: "visible" });
      assert.equal(
        await panel.evaluate(
          (element) =>
            element.shadowRoot.activeElement === element.shadowRoot.querySelector(".panel-title"),
        ),
        true,
        "opening the panel moves focus to its heading",
      );
      await panel.locator(".panel-title").press("Escape");
      assert.equal(await panel.locator(".body").isVisible(), true);
      await main.press("Enter");
      await panel.locator(".body").waitFor({ state: "visible" });
      await module.focus();
      await module.press("Space");
      assert.equal(await module.getAttribute("aria-expanded"), "true");
      await showView(panel, "history");
      await panel.getByText("真实历史请求", { exact: true }).waitFor();
      assert.equal(await main.getAttribute("aria-expanded"), "false");
      assert.equal(
        await panel
          .getByRole("button", { name: "历史", exact: true })
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(await panel.getByRole("meter").count(), 0);
      await showView(panel, "heartbeat");
      assert.equal(await panel.locator(".body").count(), 1);
      assert.equal(
        await panel
          .getByRole("button", { name: "历史", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await panel
          .getByRole("button", { name: "心跳", exact: true })
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(await panel.getByText("真实历史请求", { exact: true }).count(), 0);
      await page.locator("#messages").click({ position: { x: 3, y: 160 } });
      assert.equal(await panel.locator(".body").isVisible(), true);
      assert.equal(await panel.locator(".panel-title").innerText(), "项目心跳");
      await context.close();
    });
    await t.test(
      "long task and evidence remain bounded in narrow short windows with reduced motion",
      async () => {
        const { context, page, panel } = await open();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 390, height: 400 });
        await page.locator("#messages, #composer").evaluateAll((nodes) => {
          for (const node of nodes) node.remove();
        });
        const title = "长标题".repeat(300);
        const reference = `/workspace/${"long-unbroken-evidence-reference-".repeat(25)}acceptance.md`;
        await page.evaluate(
          ({ task, title, reference }) => {
            window.fixture.task = {
              ...task,
              title,
              objectives: [
                {
                  ...task.objectives[0],
                  items: [
                    {
                      ...task.objectives[0].items[0],
                      evidence: [{ summary: "长证据", verification: "verified", reference }],
                    },
                    task.objectives[0].items[1],
                  ],
                },
              ],
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { task, title, reference },
        );
        await showView(panel, "tasks");
        const body = panel.locator(".body");
        const bounds = await body.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 400);
        assert.ok(await panel.locator(".scroll").evaluate((element) => element.clientHeight > 40));
        assert.equal(await panel.locator(".panel-title").getAttribute("title"), title);
        await page.evaluate(() => {
          document.documentElement.dir = "rtl";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const rtlBounds = await body.boundingBox();
        assert.ok(rtlBounds.x >= 0 && rtlBounds.x + rtlBounds.width <= 390);
        assert.ok(rtlBounds.y >= 0 && rtlBounds.y + rtlBounds.height <= 400);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await body.evaluate((element) => getComputedStyle(element).animationName),
          "none",
        );
        await panel.getByRole("button", { name: /普通聊天界面/ }).click();
        const evidence = panel.locator(".evidence").filter({ hasText: "长证据" });
        assert.ok(
          await evidence.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        );
        assert.ok(
          await panel
            .locator(".scroll")
            .evaluate((element) => element.scrollHeight > element.clientHeight),
        );
        await context.close();
      },
    );
    await t.test("subtasks, evidence, progress regression and paginated history", async () => {
      const { context, page, panel } = await open();
      await page.evaluate((value) => {
        window.fixture.task = value;
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, task);
      await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
      assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
      await panel.getByRole("button", { name: /普通聊天界面/ }).click();
      assert.match(await panel.locator("section.panel").innerText(), /浏览器实测通过/);
      assert.match(await panel.locator("section.panel").innerText(), /实际验证/);
      await page.evaluate(() => {
        window.fixture.task.progress = { completed: 1, total: 3, percent: 33.33 };
        window.fixture.task.revision = 2;
        window.fixture.history = {
          events: [
            {
              occurredAt: "2026-11-11T12:01:00Z",
              reason: "新增验证任务",
              reasonTruncated: true,
              canonicalHistoryPath: "/repo/.workspace/task/session/original-history.md",
              before: { completed: 1, total: 2, percent: 50 },
              after: { completed: 1, total: 3, percent: 33.33 },
            },
          ],
          canonicalHistoryPath: "/repo/.workspace/task/session/history.md",
          nextCursor: "1",
        };
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "33.33");
      await panel.getByRole("button", { name: "历史", exact: true }).click();
      await panel.getByText("新增验证任务", { exact: true }).waitFor();
      const sourceNote = panel.locator(".history-source-note");
      await sourceNote.waitFor();
      assert.match(await sourceNote.innerText(), /完整记录见来源文件/);
      assert.match(await sourceNote.locator("code").innerText(), /original-history\.md$/);
      assert.doesNotMatch(
        await panel.locator(".scroll").innerText(),
        /reasonTruncated|canonicalHistoryPath/,
      );
      assert.match(
        await panel.locator("section.panel").innerText(),
        /1\/2 \(50%\) → 1\/3 \(33.33%\)/,
      );
      await page.evaluate(() => {
        window.fixture.history = {
          events: [{ occurredAt: "2026-11-11T12:00:00Z", reason: "建立任务" }],
          nextCursor: null,
        };
      });
      await panel.getByRole("button", { name: "加载更多" }).click();
      await panel.getByText("建立任务", { exact: true }).waitFor();
      assert.match(await panel.locator("section.panel").innerText(), /新增验证任务/);
      assert.equal(await panel.locator(".history-source-note").count(), 1);
      await context.close();
    });
    await t.test(
      "local History request failure settles and retries only after explicit refresh",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = value;
          window.fixture.historyFailureNext = "temporary history failure";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        const historyError = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "历史记录不可用" });
        await historyError.waitFor();
        assert.equal(await historyError.locator(".diagnostic-text").isVisible(), true);
        await historyError.click();
        assert.equal(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "历史记录不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          String(new Error("temporary history failure")),
        );
        assert.doesNotMatch(await panel.locator(".scroll").innerText(), /暂无变更记录/);
        await page.waitForTimeout(150);
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          ),
          1,
        );
        await page.evaluate(() => {
          window.fixture.history = { events: [{ reason: "retry succeeded" }], nextCursor: null };
        });
        await panel.getByRole("button", { name: "刷新", exact: true }).click();
        await panel.getByText("retry succeeded", { exact: true }).waitFor();
        await context.close();
      },
    );
    await t.test(
      "bound task History renders only its canonical Kit ledger, pages and refreshes",
      async () => {
        const { context, page, panel } = await open();
        const source = {
          kind: "kit-heartbeat",
          path: "/repo/.workspace/task/session/heartbeat.md",
          readOnly: true,
          contentHash: "hash-a",
        };
        await page.evaluate(
          ({ value, source }) => {
            window.fixture.task = { ...window.fixture.task, ...value, source };
            window.fixture.history = {
              events: [],
              wakes: [
                {
                  heading: "wake newest",
                  line: 12,
                  rows: [{ category: "Feature", state: "active" }],
                },
              ],
              nextCursor: "older",
              total: 2,
              source,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { value: task, source },
        );
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText("wake newest", { exact: true }).waitFor();
        assert.match(await panel.locator("section.panel").innerText(), /只读台账.*heartbeat\.md/s);
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /历史台账/);
        assert.match(await panel.locator("section.panel").innerText(), /台账记录.*2/s);
        assert.match(await panel.locator("section.panel").innerText(), /Feature · active/);
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /暂无变更记录/);
        await mkdir(".playwright-img", { recursive: true });
        await page.screenshot({ path: ".playwright-img/task-history-source-preview.png" });
        await page.evaluate(() => {
          window.fixture.history = {
            events: [],
            wakes: [{ heading: "wake older", rows: [] }],
            nextCursor: null,
            total: 2,
            source: { ...window.fixture.task.source },
          };
        });
        await panel.getByRole("button", { name: "加载更早记录", exact: true }).click();
        await panel.getByText("wake older", { exact: true }).waitFor();
        assert.match(
          await panel.locator("section.panel").innerText(),
          /wake newest[\s\S]*wake older/,
        );
        await page.evaluate(() => {
          window.fixture.history = {
            events: [],
            wakes: [{ heading: "wake refreshed", rows: [] }],
            nextCursor: null,
            total: 1,
            source: { ...window.fixture.task.source },
          };
        });
        await panel.getByRole("button", { name: "刷新台账历史", exact: true }).click();
        await panel.getByText("wake refreshed", { exact: true }).waitFor();
        assert.equal(await panel.getByText("wake older", { exact: true }).count(), 0);
        await context.close();
      },
    );
    await t.test(
      "paired Kit history displays its physical ledger and row locations while retaining HEAD identity",
      async () => {
        const { context, page, panel } = await open();
        const headPath = "/repo/.workspace/task/session/heartbeat.md";
        const historyPath = "/repo/.workspace/task/session/taskhistory.md";
        await page.evaluate(
          ({ value, headPath, historyPath, projectHeartbeat }) => {
            const source = {
              kind: "kit-heartbeat",
              path: headPath,
              historyPath,
              readOnly: true,
              contentHash: "head-hash-a",
            };
            window.fixture.task = { ...value, source };
            window.fixture.taskSource = {
              status: "ready",
              path: headPath,
              historyPath,
              readOnly: true,
              contentHash: "head-hash-a",
            };
            window.fixture.heartbeat = {
              ...projectHeartbeat,
              status: "ready",
              sourcePath: "/repo/.workspace/project/heartbeat.md",
              historyPath,
            };
            window.fixture.history = {
              events: [],
              wakes: [
                {
                  heading: "paired task-history wake",
                  sourcePath: historyPath,
                  line: 24,
                  rows: [
                    {
                      category: "Review",
                      state: "complete",
                      sourcePath: historyPath,
                      line: 25,
                    },
                  ],
                },
              ],
              nextCursor: null,
              total: 1,
              source,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { value: task, headPath, historyPath, projectHeartbeat: heartbeat },
        );
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText("paired task-history wake", { exact: true }).waitFor();
        const scroll = panel.locator(".scroll");
        assert.match(await scroll.innerText(), /只读心跳来源.*heartbeat\.md/s);
        assert.match(await scroll.innerText(), /历史台账.*taskhistory\.md/s);
        assert.match(await scroll.innerText(), /taskhistory\.md:24/);
        assert.match(await scroll.innerText(), /taskhistory\.md:25/);
        await panel.getByRole("button", { name: "心跳", exact: true }).click();
        assert.match(await panel.locator(".hb-source").innerText(), /heartbeat\.md/);
        assert.match(await panel.locator(".hb-source").innerText(), /taskhistory\.md/);
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await mkdir(".playwright-img", { recursive: true });
        await page.screenshot({ path: ".playwright-img/task-history-paired-preview.png" });

        const historyCallsBeforeHeartbeatChange = await page.evaluate(
          () => window.fixture.calls.filter((call) => call.method === "history").length,
        );
        await page.evaluate(() => {
          window.fixture.heartbeat.sourcePath = "/repo/.workspace/project/other-heartbeat.md";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await scroll.innerText(), /paired task-history wake/);
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          ),
          historyCallsBeforeHeartbeatChange,
          "project heartbeat identity does not alter the task's HEAD-bound history context",
        );

        await page.evaluate(
          ({ headPath, historyPath }) => {
            window.fixture.task.source = {
              ...window.fixture.task.source,
              path: "/repo/.workspace/task/other-session/heartbeat.md",
            };
            window.fixture.history.source.path = headPath;
            window.fixture.history.source.historyPath = historyPath;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { headPath, historyPath },
        );
        const mismatchDetails = scroll
          .locator(".info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await mismatchDetails.waitFor();
        await mismatchDetails.click();
        assert.match(
          await scroll
            .locator(".info-card")
            .filter({ hasText: "台账历史不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          /did not match the bound source/,
        );
        assert.doesNotMatch(await scroll.innerText(), /paired task-history wake/);
        await context.close();
      },
    );
    await t.test(
      "bound ledger with zero wakes and source error uses source-specific messages",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = {
            ...value,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/heartbeat.md",
              readOnly: true,
              contentHash: "hash-empty",
            },
          };
          window.fixture.history = {
            events: [],
            wakes: [],
            nextCursor: null,
            total: 0,
            source: { ...window.fixture.task.source },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText(/此台账暂无已记录的心跳巡检/).waitFor();
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /暂无变更记录/);
        await page.evaluate(() => {
          window.fixture.task.source.error = "ledger is stale";
          window.fixture.taskSource = {
            status: "stale",
            path: window.fixture.task.source.path,
            contentHash: window.fixture.task.source.contentHash,
            readOnly: true,
            error: "ledger is stale",
          };
          window.fixture.history.source.error = "ledger is stale";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const historyError = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await historyError.waitFor();
        await historyError.click();
        assert.match(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "台账历史不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          /ledger is stale/,
        );
        await context.close();
      },
    );
    await t.test(
      "source metadata without a task and mismatched history pages stay out of local History",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate(() => {
          window.fixture.task = null;
          window.fixture.taskSource = {
            status: "stale",
            path: "/repo/stale.md",
            contentHash: "stale-hash",
            readOnly: true,
            error: "ledger could not be read",
          };
          window.fixture.history = {
            events: [{ reason: "must not appear locally" }],
            wakes: [],
            nextCursor: null,
            total: 0,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/other.md",
              readOnly: true,
              contentHash: "wrong-hash",
            },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByRole("button", { name: "任务进度", exact: false }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        const mismatchDetails = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await mismatchDetails.waitFor();
        await mismatchDetails.click();
        assert.match(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "台账历史不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          /did not match the bound source/,
        );
        assert.doesNotMatch(
          await panel.locator(".scroll").innerText(),
          /must not appear locally|暂无变更记录/,
        );
        await page.waitForTimeout(200);
        const calls = await page.evaluate(
          () => window.fixture.calls.filter((call) => call.method === "history").length,
        );
        assert.equal(
          calls,
          1,
          "a mismatched page must settle to an error rather than retry indefinitely",
        );
        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "pending-selection",
            readOnly: true,
            error: "ledger binding is unresolved",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const unresolvedDetails = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await unresolvedDetails.waitFor();
        await unresolvedDetails.click();
        assert.equal(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "台账历史不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          "ledger binding is unresolved",
        );
        assert.doesNotMatch(await panel.locator(".scroll").innerText(), /暂无变更记录/);
        await context.close();
      },
    );
    await t.test(
      "valid historical ledger audits remain visible when the current task projection fails",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate(() => {
          window.fixture.task = null;
          window.fixture.taskSource = {
            status: "error",
            path: "/repo/ledger.md",
            contentHash: "ledger-hash",
            readOnly: true,
            error: "current Items projection invalid",
          };
          window.fixture.history = {
            events: [],
            wakes: [
              {
                heading: "historical wake remains valid",
                line: 31,
                rows: [{ category: "Audit", state: "verified" }],
              },
            ],
            nextCursor: null,
            total: 1,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/ledger.md",
              contentHash: "ledger-hash",
              readOnly: true,
            },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByRole("button", { name: "任务进度", exact: false }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText("historical wake remains valid", { exact: true }).waitFor();
        const historyText = await panel.locator(".scroll").innerText();
        assert.match(historyText, /Audit · verified/);
        assert.doesNotMatch(historyText, /current Items projection invalid|台账历史不可用/);
        assert.doesNotMatch(
          await panel.locator(".summary").innerText(),
          /current Items projection invalid/,
        );
        await panel.locator(".summary .main").click();
        await panel
          .locator(".scroll .info-card")
          .filter({ hasText: "只读 Kit 任务来源" })
          .waitFor();
        const sourceError = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "来源错误" });
        await sourceError.waitFor();
        assert.equal(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "来源错误" })
            .locator(".diagnostic-text")
            .textContent(),
          "current Items projection invalid",
        );
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText("historical wake remains valid", { exact: true }).waitFor();
        await context.close();
      },
    );
    await t.test(
      "stale ledger authority invalidates cached valid history at the same path and hash",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate(() => {
          window.fixture.task = null;
          window.fixture.taskSource = {
            status: "ready",
            path: "/repo/ledger.md",
            contentHash: "ledger-hash",
            readOnly: true,
          };
          window.fixture.history = {
            events: [],
            wakes: [{ heading: "formerly valid wake", rows: [] }],
            nextCursor: null,
            total: 1,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/ledger.md",
              contentHash: "ledger-hash",
              readOnly: true,
            },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByRole("button", { name: "任务进度", exact: false }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.getByText("formerly valid wake", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "stale",
            path: "/repo/ledger.md",
            contentHash: "ledger-hash",
            readOnly: true,
            error: "ledger association is stale",
          };
          window.fixture.history = {
            events: [],
            wakes: [],
            nextCursor: null,
            total: 0,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/ledger.md",
              contentHash: "ledger-hash",
              readOnly: true,
              error: "ledger association is stale",
            },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const staleDetails = panel
          .locator(".scroll .info-card-error")
          .filter({ hasText: "台账历史不可用" });
        await staleDetails.waitFor();
        await staleDetails.click();
        assert.equal(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "台账历史不可用" })
            .locator(".diagnostic-text")
            .textContent(),
          "ledger association is stale",
        );
        assert.equal(await panel.getByText("formerly valid wake", { exact: true }).count(), 0);
        await page.waitForTimeout(200);
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          ),
          2,
          "authority change should reload once and settle on source error",
        );
        await context.close();
      },
    );
    await t.test(
      "late ledger History is discarded after source changes and local History reloads",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = {
            ...value,
            source: {
              kind: "kit-heartbeat",
              path: "/repo/ledger-a.md",
              readOnly: true,
              contentHash: "hash-a",
            },
          };
          window.fixture.history = {
            events: [],
            wakes: [{ heading: "old source wake", rows: [] }],
            nextCursor: null,
            total: 1,
            source: { ...window.fixture.task.source },
          };
          window.fixture.delayNextHistory = 250;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await page.waitForFunction(
          () => window.fixture.calls.filter((call) => call.method === "history").length === 1,
        );
        await page.evaluate(() => {
          window.fixture.task.source = {
            kind: "kit-heartbeat",
            path: "/repo/ledger-b.md",
            readOnly: true,
            contentHash: "hash-b",
          };
          window.fixture.history = {
            events: [],
            wakes: [{ heading: "current source wake", rows: [] }],
            nextCursor: null,
            total: 1,
            source: { ...window.fixture.task.source },
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("current source wake", { exact: true }).waitFor();
        await page.waitForTimeout(300);
        assert.equal(await panel.getByText("old source wake", { exact: true }).count(), 0);
        await page.evaluate(() => {
          delete window.fixture.task.source;
          window.fixture.taskSource = null;
          window.fixture.history = {
            events: [{ reason: "local history returned" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("local history returned", { exact: true }).waitFor();
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /current source wake/,
        );
        await context.close();
      },
    );
    await t.test(
      "late History from a previous thread cannot overwrite the newly selected thread",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = value;
          window.fixture.history = {
            events: [{ reason: "late thread-a history" }],
            nextCursor: null,
          };
          window.fixture.delayNextHistory = 250;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await page.waitForFunction(
          () => window.fixture.calls.filter((call) => call.method === "history").length === 1,
        );
        await page.evaluate(() => {
          window.fixture.threadId = "thread-b";
          window.fixture.task = null;
          window.fixture.history = {
            events: [{ reason: "current thread-b history" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("current thread-b history", { exact: true }).waitFor();
        await page.waitForTimeout(300);
        assert.equal(await panel.getByText("late thread-a history", { exact: true }).count(), 0);
        const requests = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "history"),
        );
        assert.deepEqual(
          requests.map((request) => request.threadId),
          ["thread-a", "thread-b"],
        );
        await context.close();
      },
    );
    await t.test(
      "late failed History cannot overwrite a successful response after an A to B to A switch",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = value;
          window.fixture.historyFailureNext = "old thread-a request failed late";
          window.fixture.holdNextHistoryFailure = true;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await page.waitForFunction(
          () => window.fixture.calls.filter((call) => call.method === "history").length === 1,
        );
        await page.waitForFunction(
          () => typeof window.fixture.releaseHeldHistoryFailure === "function",
        );
        await page.evaluate(() => {
          window.fixture.threadId = "thread-b";
          window.fixture.task = null;
          window.fixture.history = {
            events: [{ reason: "thread-b history" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("thread-b history", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.threadId = "thread-a";
          window.fixture.history = {
            events: [{ reason: "new thread-a history" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("new thread-a history", { exact: true }).waitFor();
        await page.evaluate(async () => {
          window.fixture.releaseHeldHistoryFailure();
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const historyText = await panel.locator(".scroll").innerText();
        assert.match(historyText, /new thread-a history/);
        assert.doesNotMatch(historyText, /old thread-a request failed late|历史记录不可用/);
        const requests = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "history"),
        );
        assert.deepEqual(
          requests.map((request) => request.threadId),
          ["thread-a", "thread-b", "thread-a"],
        );
        await context.close();
      },
    );
    await t.test("registered checklist completion never claims runtime completion", async () => {
      const { context, page, panel } = await open();
      const header = panel.locator(".summary");
      assert.match(await header.innerText(), /已登记清单 0\/0/);
      assert.match(await header.innerText(), /执行状态未知/);
      await page.evaluate((value) => {
        window.fixture.task = {
          ...value,
          revision: 11,
          progress: { completed: 2, total: 2, percent: 100 },
        };
        window.fixture.execution.state = "working";
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, task);
      assert.match(await header.innerText(), /已登记清单 2\/2/);
      assert.match(await header.innerText(), /当前仍在执行/);
      assert.doesNotMatch(await header.innerText(), /100%|已完成/);
      assert.equal(await panel.getByRole("progressbar").count(), 0);
      await page.evaluate(() => {
        window.fixture.execution.state = "waiting";
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.match(await header.innerText(), /等待输入/);
      await page.evaluate(() => {
        window.fixture.execution.state = "idle";
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.match(await header.innerText(), /已登记清单 2\/2/);
      assert.match(await header.innerText(), /当前空闲/);
      assert.match(await panel.getByRole("progressbar").getAttribute("aria-label"), /已登记清单/);
      assert.equal(await header.locator(".percent svg").count(), 1);
      assert.match(await header.locator(".main").getAttribute("aria-label"), /已登记清单 2\/2/);
      assert.doesNotMatch(
        await panel.getByRole("progressbar").getAttribute("aria-valuetext"),
        /100%/,
      );
      assert.doesNotMatch(await header.innerText(), /100%|已完成/);
      assert.equal(await page.evaluate(() => window.fixture.task.revision), 11);
      await page.evaluate(() => {
        window.fixture.task.revision = 12;
        window.fixture.task.progress = { completed: 2, total: 3, percent: 66.67 };
        window.fixture.execution.state = "working";
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.match(await header.innerText(), /已登记清单 2\/3 · 清单进度 66.67%/);
      assert.match(await header.innerText(), /正在执行/);
      await page.evaluate(() => {
        window.fixture.execution.state = "unknown";
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.match(await header.innerText(), /执行状态未知/);
      assert.doesNotMatch(await header.innerText(), /已完成/);
      await context.close();
    });
    await t.test(
      "objective display status reflects children rather than stale stored status",
      async () => {
        const { context, page, panel } = await open();
        const objective = {
          ...task.objectives[0],
          status: "pending",
          items: [task.objectives[0].items[0]],
        };
        await page.evaluate(
          (value) => {
            window.fixture.task = {
              ...value.task,
              objectives: [value.objective],
              progress: { completed: 1, total: 1, percent: 100 },
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { task, objective },
        );
        await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
        const status = panel.getByRole("button", { name: /普通聊天界面/ }).locator(".status");
        assert.equal(await status.innerText(), "已完成");
        await page.evaluate(() => {
          window.fixture.task.objectives[0].items.push({
            id: "next",
            title: "下一项",
            status: "pending",
            evidence: [],
          });
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await status.innerText(), "进行中");
        await page.evaluate(() => {
          window.fixture.task.objectives[0].items[1].status = "blocked";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await status.innerText(), "阻塞");
        await page.evaluate(() => {
          window.fixture.task.objectives[0].status = "cancelled";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await status.innerText(), "已取消");
        await page.evaluate(() => {
          for (const item of window.fixture.task.objectives[0].items) item.status = "completed";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await status.innerText(), "已取消");
        assert.equal(await panel.getByRole("meter").getAttribute("aria-valuenow"), "0");
        assert.equal(await panel.getByRole("meter").getAttribute("aria-valuetext"), "0/0");
        await context.close();
      },
    );
    await t.test(
      "unfinished objectives sort newest first while completed and cancelled objectives stay stable",
      async () => {
        const { context, page, panel } = await open();
        const makeObjective = (id, title, status, evidence) => ({
          id,
          title,
          required: true,
          status,
          evidence: [],
          items: [
            {
              id: `${id}-item`,
              title: `${title} 节点`,
              status,
              evidence: [{ summary: evidence, verification: "verified" }],
            },
          ],
        });
        const sourceObjectives = [
          makeObjective("done-first", "已完成甲", "completed", "EVIDENCE_DONE_FIRST"),
          makeObjective("pending-first", "待办一", "pending", "EVIDENCE_PENDING_ONE"),
          makeObjective("blocked", "阻塞中", "blocked", "EVIDENCE_BLOCKED"),
          makeObjective("cancelled-first", "已取消甲", "cancelled", "EVIDENCE_CANCELLED_FIRST"),
          makeObjective("pending-last", "待办二", "pending", "EVIDENCE_PENDING_TWO"),
          makeObjective("done-last", "已完成乙", "completed", "EVIDENCE_DONE_LAST"),
          makeObjective("cancelled-last", "已取消乙", "cancelled", "EVIDENCE_CANCELLED_LAST"),
        ];
        await page.evaluate(
          (value) => {
            window.fixture.task = {
              ...value.task,
              phase: "active",
              progress: { completed: 2, total: 5, percent: 40 },
              objectives: value.objectives,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { task, objectives: sourceObjectives },
        );
        await panel.locator(".summary .main").click();
        await panel.locator(".row").last().waitFor();
        const rows = panel.locator(".scroll .row");
        const names = async () =>
          (await panel.locator(".scroll .row .name").allTextContents()).map((name) => name.trim());
        assert.deepEqual(await names(), [
          "待办二",
          "阻塞中",
          "待办一",
          "已完成甲",
          "已取消甲",
          "已完成乙",
          "已取消乙",
        ]);
        assert.match(
          await panel.locator(".summary .main").innerText(),
          /已登记清单 2\/5 · 清单进度 40%/,
        );
        await mkdir(".playwright-img", { recursive: true });
        await panel
          .locator(".body")
          .screenshot({ path: ".playwright-img/task-capsules-sorted.png" });
        const pillGeometry = await rows.first().evaluate((element) => ({
          radius: Number.parseFloat(getComputedStyle(element).borderRadius),
          height: element.getBoundingClientRect().height,
        }));
        assert.ok(
          pillGeometry.radius >= pillGeometry.height / 2,
          "task modules use capsule geometry without tying the test to a pixel radius",
        );

        await panel.getByRole("button", { name: /待办一/ }).click();
        assert.match(await panel.locator(".detail").innerText(), /EVIDENCE_PENDING_ONE/);
        assert.doesNotMatch(
          await panel.locator(".detail").innerText(),
          /EVIDENCE_PENDING_TWO|EVIDENCE_BLOCKED/,
        );
        await page.evaluate(() => {
          window.fixture.task.objectives.push({
            id: "pending-new",
            title: "刚新增待办",
            required: true,
            status: "pending",
            evidence: [],
            items: [
              {
                id: "pending-new-item",
                title: "刚新增待办节点",
                status: "pending",
                evidence: [{ summary: "EVIDENCE_PENDING_NEW", verification: "verified" }],
              },
            ],
          });
          window.fixture.task.progress = { completed: 2, total: 6, percent: 33.33 };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByRole("button", { name: /刚新增待办/ }).waitFor({ timeout: 6000 });
        assert.match(
          await panel.locator(".summary .main").innerText(),
          /已登记清单 2\/6 · 清单进度 33.33%/,
        );
        assert.deepEqual(await names(), [
          "刚新增待办",
          "待办二",
          "阻塞中",
          "待办一",
          "已完成甲",
          "已取消甲",
          "已完成乙",
          "已取消乙",
        ]);
        const pendingOne = panel.getByRole("button", { name: /待办一/ });
        assert.equal(await pendingOne.getAttribute("aria-expanded"), "true");
        assert.match(await panel.locator(".detail").innerText(), /EVIDENCE_PENDING_ONE/);
        assert.doesNotMatch(
          await panel.locator(".detail").innerText(),
          /EVIDENCE_PENDING_NEW|EVIDENCE_PENDING_TWO|EVIDENCE_BLOCKED/,
        );
        assert.deepEqual(
          await page.evaluate(() =>
            window.fixture.task.objectives.map((objective) => objective.id),
          ),
          [
            "done-first",
            "pending-first",
            "blocked",
            "cancelled-first",
            "pending-last",
            "done-last",
            "cancelled-last",
            "pending-new",
          ],
          "display sorting never mutates the source objective order",
        );
        await context.close();
      },
    );
    await t.test(
      "grouped heartbeat layout keeps summaries compact, history visible and source text accessible",
      async () => {
        const { context, page, panel } = await open("", {
          viewport: { width: 1100, height: 850 },
          deviceScaleFactor: 2,
          timezoneId: "America/New_York",
        });
        const pageErrors = [];
        const consoleErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        try {
          await page.evaluate((value) => {
            const wakes = [
              {
                timeMs: Date.parse("2026-11-13T14:34:48Z"),
                heading: "巡检原始标题 09:34:48",
                line: 812,
                rowCount: 10,
                rows: [
                  {
                    category: "剩余工作",
                    line: 813,
                    state: "(1a) 已完成 — /tmp/hotupdate-verification-audit/result.md",
                  },
                  { category: "验证依据", state: "记录 29/29 项检查，跨五个线程的校验均通过。" },
                ],
              },
              {
                timeMs: Date.parse("2026-11-13T14:18:22Z"),
                rows: [{ category: "检查", state: "较早记录一" }],
              },
              {
                timeMs: Date.parse("2026-11-13T14:05:11Z"),
                rows: [{ category: "检查", state: "较早记录二" }],
              },
              {
                timeMs: Date.parse("2026-11-13T13:52:00Z"),
                rows: [{ category: "检查", state: "较早记录三" }],
              },
            ];
            window.fixture.heartbeat = {
              ...value,
              sourcePath: "/workspace/project/heartbeat.md",
              historyPath: "/workspace/project/taskhistory.md",
              lastWakeAt: "2026-11-13T14:34:48Z",
              itemCount: 10,
              items: Array.from({ length: 10 }, (_, index) => ({
                id: `I${index + 1}`,
                item: `登记项 ${index + 1}`,
                status: index === 1 ? "blocked" : "active",
              })),
              findings: [{ severity: "warning", message: "旧记录存在校验提示" }],
              wakeCount: 4,
              wakes,
            };
            window.fixture.heartbeatHistory = {
              wakes,
              nextCursor: "older-page",
              total: 4,
              sourcePath: window.fixture.heartbeat.sourcePath,
              historyPath: window.fixture.heartbeat.historyPath,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, heartbeat);
          await showView(panel, "heartbeat");
          await panel.locator(".hb-history").waitFor();
          await panel.locator(".hb-wake").first().waitFor();

          assert.equal(await panel.locator(".hb-time-card .hb-time strong").count(), 2);
          assert.equal(await panel.locator(".hb-wake").count(), 4);
          assert.match(await panel.locator(".hb-time-card").innerText(), /09:34/);
          assert.match(
            await panel.locator(".hb-time-card .hb-time-label").nth(1).innerText(),
            /下次巡检/,
          );
          assert.match(await panel.locator(".hb-history").innerText(), /巡检记录/);
          assert.equal(await panel.locator(".hb-history-head .hb-count").innerText(), "4");
          assert.equal(
            await panel.locator(".hb-history").evaluate((element) => element.tagName),
            "SECTION",
            "history group stays visible without a wrapping disclosure",
          );
          assert.equal(
            await panel.locator(".hb-history").evaluate((element) => element.closest("details")),
            null,
          );
          assert.equal(
            await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).count(),
            1,
          );
          assert.equal(await panel.locator(".hb-items").locator("summary").count(), 1);
          assert.match(await panel.locator(".hb-items").innerText(), /10/);
          assert.equal(await panel.locator(".hb-items").getAttribute("open"), null);
          assert.equal(await panel.locator(".hb-source").getAttribute("open"), null);
          assert.equal(await panel.locator(".hb-wake").first().getAttribute("open"), "");
          assert.equal(await panel.locator(".hb-wake").first().locator("details[open]").count(), 0);
          assert.equal(await panel.locator(".hb-wake").nth(1).getAttribute("open"), null);
          assert.equal(await panel.locator(".hb-wake").nth(1).locator("details[open]").count(), 0);
          assert.equal(
            await panel
              .locator(".hb-wake")
              .first()
              .locator(".hb-wake-raw")
              .first()
              .getAttribute("open"),
            null,
          );
          assert.match(
            await panel.locator(".hb-wake").first().locator(".hb-wake-count").innerText(),
            /10/,
          );
          assert.equal(await panel.locator(".hb-alert .info-card-title").count(), 1);
          assert.equal(await panel.locator(".hb-alert .info-card-title").isVisible(), true);
          assert.match(await panel.locator(".hb-alert").innerText(), /旧记录存在校验提示/);
          assert.match(await panel.locator(".hb-source").innerText(), /heartbeat\.md/);
          assert.match(await panel.locator(".hb-source").innerText(), /taskhistory\.md/);
          assert.match(
            await panel.locator(".hb-source > summary").innerText(),
            /heartbeat\.md.*taskhistory\.md|taskhistory\.md.*heartbeat\.md/,
          );
          assert.doesNotMatch(
            await panel.locator(".hb-source > summary").innerText(),
            /\/workspace\//,
          );
          assert.equal(
            await panel.locator(".hb-wake").first().locator(".hb-record-preview").count(),
            2,
          );
          assert.equal(
            await panel
              .locator(".hb-wake")
              .first()
              .locator(".hb-record-preview > span")
              .first()
              .evaluate((element) => getComputedStyle(element).webkitLineClamp),
            "2",
          );
          const firstWake = panel.locator(".hb-wake").first();
          const wakeRaw = firstWake.locator(".hb-wake-raw").first();
          await wakeRaw.locator(":scope > summary").click();
          assert.match(await wakeRaw.innerText(), /巡检原始标题 09:34:48/);
          assert.match(await wakeRaw.innerText(), /heartbeat\.md:812/);
          assert.match(await wakeRaw.innerText(), /heartbeat\.md:813/);
          await wakeRaw.locator(":scope > summary").click();
          const rowRaw = firstWake.locator(".hb-record-raw").first();
          await rowRaw.locator(":scope > summary").click();
          assert.match(await rowRaw.innerText(), /剩余工作/);
          assert.match(await rowRaw.innerText(), /\/tmp\/hotupdate-verification-audit\/result\.md/);
          await rowRaw.locator(":scope > summary").click();
          assert.match(await panel.locator(".hb-wake").first().innerText(), /剩余工作/);
          assert.match(await panel.locator(".hb-wake").first().innerText(), /验证依据/);

          await mkdir(".playwright-img", { recursive: true });
          const body = panel.locator(".body");
          const scroll = panel.locator(".scroll");
          await scroll.evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
          const bounds = await body.boundingBox();
          assert.ok(
            bounds && Math.abs(bounds.width - (await panel.boundingBox()).width) <= 1,
            `expected the native panel to use its available width, got ${bounds?.width}`,
          );
          assert.ok(
            bounds.height <= 640,
            `expected a panel no taller than 640px, got ${bounds.height}`,
          );
          const light = await body.screenshot({
            path: ".playwright-img/heartbeat-grouped-light.png",
          });
          assert.deepEqual(
            [light.readUInt32BE(16), light.readUInt32BE(20)],
            [Math.round(bounds.width * 2), Math.round(bounds.height * 2)],
          );

          const lightBackground = await body.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          );
          const lightText = await body.evaluate((element) => getComputedStyle(element).color);
          await page.addStyleTag({
            content: `
            html.dark { color: #eee; color-scheme: dark; --ctp-surface: #252525; --ctp-text: #eee; }
            html.dark body { color: inherit; background: #1b1b1b; }
            html.dark #composer { color: inherit; background: #252525; border-color: #555; }
          `,
          });
          await page.evaluate(() => document.documentElement.classList.add("dark"));
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const darkBackground = await body.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          );
          assert.notEqual(
            darkBackground,
            lightBackground,
            "panel colors should follow the host dark class",
          );
          const darkText = await body.evaluate((element) => getComputedStyle(element).color);
          const composerText = await page
            .locator("#composer")
            .evaluate((element) => getComputedStyle(element).color);
          assert.equal(darkText, composerText, "panel text follows the host composer color");
          assert.notEqual(darkText, lightText, "panel text changes with the host theme");
          await body.screenshot({ path: ".playwright-img/heartbeat-grouped-dark.png" });

          const historyRequestCount = () =>
            page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            );
          assert.equal(
            await historyRequestCount(),
            1,
            "opening the heartbeat view fetches history once",
          );
          await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).click();
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter((call) => call.method === "heartbeat-history").length ===
              2,
          );

          await page.setViewportSize({ width: 320, height: 380 });
          await page.locator("#messages, #composer").evaluateAll((nodes) => {
            for (const node of nodes) node.remove();
          });
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          const narrow = await panel.locator(".body").boundingBox();
          assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 320);
          assert.ok(narrow.y >= 0 && narrow.y + narrow.height <= 380);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await panel
            .locator(".body")
            .screenshot({ path: ".playwright-img/heartbeat-grouped-narrow.png" });

          await page.evaluate(() => {
            window.fixture.heartbeatHistory.wakes[0].rows.push({
              category: "额外记录",
              state: "第三条原文内容",
            });
          });
          await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).click();
          const moreRecords = firstWake.locator(".hb-more-records");
          await moreRecords.waitFor();
          assert.equal(await moreRecords.getAttribute("open"), null);
          assert.equal(await firstWake.locator(".hb-record-preview:visible").count(), 2);
          const thirdPreview = moreRecords.locator(".hb-record-preview");
          assert.equal(await thirdPreview.isVisible(), false);
          await moreRecords.locator(":scope > summary").click();
          assert.equal(await thirdPreview.isVisible(), true);
          assert.match(await thirdPreview.innerText(), /第三条原文内容/);
          const thirdRaw = moreRecords.locator(".hb-record-raw");
          await thirdRaw.locator(":scope > summary").click();
          assert.match(await thirdRaw.innerText(), /第三条原文内容/);
          await thirdRaw.locator(":scope > summary").click();
          await moreRecords.locator(":scope > summary").click();
          assert.equal(await moreRecords.getAttribute("open"), null);
          assert.equal(await thirdPreview.isVisible(), false);
          assert.match(await thirdPreview.textContent(), /第三条原文内容/);
          assert.equal(
            await page.evaluate(() => window.fixture.heartbeatHistory.wakes[0].rows.length),
            3,
          );

          const source = panel.locator(".hb-source");
          await source.locator("summary").focus();
          await page.keyboard.press("Enter");
          assert.equal(await source.getAttribute("open"), "");
          await source.locator(":scope > summary").press("Escape");
          assert.equal(await panel.locator(".body").isVisible(), true);
          assert.equal(
            await panel.evaluate(
              (element) =>
                element.shadowRoot.activeElement ===
                element.shadowRoot.querySelector(".hb-source summary"),
            ),
            true,
            "Escape keeps keyboard focus on the persistent source control",
          );
          assert.deepEqual(pageErrors, []);
          assert.deepEqual(consoleErrors, []);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "automatic project Heartbeat status, stale state, findings, history and source details",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "candidates", sourcePath: null };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await panel.locator(".panel-head .panel-title").waitFor();
        assert.match(
          await panel.locator("section.panel").innerText(),
          /当前项目没有可显示的心跳来源/,
        );
        assert.equal(await panel.getByRole("combobox").count(), 0);
        assert.equal(await panel.getByRole("button", { name: /隐藏|解除关联/ }).count(), 0);
        assert.equal(
          await page.evaluate(() =>
            window.fixture.calls.some((call) => call.method === "bind-heartbeat"),
          ),
          false,
        );
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "ready" };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await panel.getByRole("heading", { name: "项目心跳", exact: true }).waitFor();
        assert.equal(
          await panel.getByRole("heading", { name: "项目心跳", exact: true }).count(),
          1,
        );
        assert.match(await panel.locator(".hb-status").innerText(), /当前状态未知/);
        assert.equal(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "current-unknown",
        );
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            status: "ready",
            passed: true,
            certifiesCurrent: false,
            discoveryComplete: false,
            discoveryReasons: ["depth-limit", "file-limit"],
            warning:
              "Project heartbeat discovery was incomplete (depth-limit, file-limit); the displayed record is the best available result.",
            findings: [],
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.equal(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "limited-source",
        );
        assert.match(await panel.locator(".hb-status").innerText(), /来源不完整/);
        assert.notEqual(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "certified",
        );
        assert.equal(await panel.locator(".hb-alert").count(), 0);
        await panel.locator(".hb-items > summary").click();
        assert.match(await panel.locator(".hb-items").innerText(), /处理阻塞/);
        assert.ok((await panel.locator(".hb-wake").count()) > 0);
        await panel.locator(".hb-source > summary").click();
        assert.match(await panel.locator(".hb-source").innerText(), /heartbeat\.md/);
        assert.match(
          await panel.locator(".hb-source").innerText(),
          /Project heartbeat discovery was incomplete/,
        );
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            status: "ready",
            passed: true,
            certifiesCurrent: false,
            discoveryComplete: false,
            discoveryReasons: ["depth-limit", "file-limit"],
            warning:
              "Project heartbeat discovery was incomplete (depth-limit, file-limit); the displayed record is the best available result.",
            findings: [
              { severity: "error", rule: "ledger-format", message: "Ledger format invalid" },
            ],
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await panel.locator(".hb-alert .info-card-title").waitFor();
        assert.match(await panel.locator(".hb-alert").innerText(), /Ledger format invalid/);
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            status: "ready",
            passed: true,
            certifiesCurrent: false,
            basis: "latest-recorded-wake",
            discoveryComplete: true,
            nextWakeAt: null,
            cadenceMinutes: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.equal(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "record-validated",
        );
        assert.match(await panel.locator(".hb-status").innerText(), /记录已校验/);
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            status: "ready",
            passed: true,
            certifiesCurrent: true,
            discoveryComplete: true,
            nextWakeAt: null,
            cadenceMinutes: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.equal(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "current-unknown",
        );
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            status: "ready",
            passed: true,
            certifiesCurrent: true,
            discoveryComplete: true,
            nextWakeAt: "2026-11-11T12:00:00Z",
            cadenceMinutes: 20,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.equal(
          await panel.locator(".hb-status").getAttribute("data-certification"),
          "certified",
        );
        assert.match(await panel.locator(".hb-status").innerText(), /当前已认证/);
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "stale", certifiesCurrent: true };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.match(await panel.locator(".hb-status").innerText(), /已过期/);
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "ready" };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        assert.match(await panel.locator(".hb-source").innerText(), /heartbeat\.md/);
        assert.doesNotMatch(await panel.locator(".hb-source").innerText(), /taskhistory\.md/);
        await panel.locator(".hb-source > summary").click();
        assert.match(await panel.locator("section.panel").innerText(), /只读/);
        assert.match(await panel.locator("section.panel").innerText(), /\/workspace\/heartbeat.md/);
        assert.match(await panel.locator("section.panel").innerText(), /项目配置/);
        assert.match(await panel.locator(".hb-time-card").innerText(), /最近记录/);
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /latest-recorded-wake|items-inventory/,
        );
        assert.equal(await panel.locator(".hb-time-card .hb-time strong").count(), 2);
        await panel.locator(".hb-items > summary").click();
        assert.match(await panel.locator("section.panel").innerText(), /处理阻塞/);
        await panel.locator(".hb-history").waitFor();
        const heartbeatWake = panel.locator(".hb-wake").first();
        await heartbeatWake.locator("> summary").waitFor();
        const heartbeatRaw = heartbeatWake.locator(".hb-wake-raw").first();
        await heartbeatRaw.locator(":scope > summary").click();
        assert.match(await heartbeatRaw.innerText(), /2026-11-11 wake/);
        await page.evaluate(() => {
          window.fixture.heartbeat.status = "stale";
          window.fixture.heartbeat.error = "台账文件已删除";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await panel.locator("section.panel").innerText(), /已过期/);
        const projectError = panel
          .locator(".scroll .info-card-title")
          .filter({ hasText: "项目心跳错误" });
        await projectError.waitFor();
        await projectError.click();
        assert.equal(
          await panel
            .locator(".scroll .info-card")
            .filter({ hasText: "项目心跳错误" })
            .locator(".diagnostic-text")
            .textContent(),
          "台账文件已删除",
        );
        assert.equal(await panel.getByRole("button", { name: /解除关联并隐藏心跳/ }).count(), 0);
        await context.close();
      },
    );
    await t.test(
      "large heartbeat history loads compact pages and displays full counts",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.heartbeat = {
            ...value,
            wakeCount: 50000,
            itemCount: 200,
            wakesTruncated: true,
            itemsTruncated: true,
            itemStatusCounts: { completed: 180, blocked: 20 },
          };
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "巡检第5000轮", rows: [] }],
            nextCursor: "1",
            total: 50000,
            sourcePath: value.sourcePath,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await panel.locator(".hb-source > summary").click();
        assert.match(
          await panel.locator("section.panel").innerText(),
          /200 · 已完成 180 · 阻塞 20/,
        );
        await panel.locator(".hb-history").getByText("50000", { exact: false }).waitFor();
        await panel.locator(".hb-wake > summary").filter({ hasText: "巡检第5000轮" }).waitFor();
        await page.evaluate(() => {
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "巡检第4999轮", rows: [] }],
            nextCursor: null,
            total: 50000,
            sourcePath: window.fixture.heartbeat.sourcePath,
          };
        });
        await panel.getByRole("button", { name: "加载更早心跳", exact: true }).click();
        await panel.locator(".hb-wake > summary").filter({ hasText: "巡检第4999轮" }).waitFor();
        assert.match(await panel.locator("section.panel").innerText(), /巡检第5000轮/);
        assert.equal(
          await panel.getByRole("button", { name: "加载更早心跳", exact: true }).count(),
          0,
        );
        const requests = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "heartbeat-history"),
        );
        assert.equal(requests.length, 2);
        assert.equal(requests[1].cursor, "1");
        await context.close();
      },
    );
    await t.test(
      "late heartbeat history cannot overwrite newer records after an A to B to A switch",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.heartbeat = value;
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "old thread-a heartbeat", rows: [] }],
            nextCursor: null,
            total: 1,
            sourcePath: value.sourcePath,
          };
          window.fixture.holdNextHeartbeatHistory = true;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await panel.locator(".hb-history").waitFor();
        await page.waitForFunction(
          () => typeof window.fixture.releaseHeldHeartbeatHistory === "function",
        );
        await page.evaluate(() => {
          window.fixture.threadId = "thread-b";
          window.fixture.heartbeat = {
            ...window.fixture.heartbeat,
            sourcePath: "/workspace/thread-b/heartbeat.md",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page.evaluate((value) => {
          window.fixture.threadId = "thread-a";
          window.fixture.heartbeat = value;
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "new thread-a heartbeat", rows: [] }],
            nextCursor: null,
            total: 1,
            sourcePath: value.sourcePath,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await panel
          .locator(".hb-wake > summary")
          .filter({ hasText: "new thread-a heartbeat" })
          .waitFor();
        await page.evaluate(async () => {
          window.fixture.releaseHeldHeartbeatHistory();
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        await page.waitForFunction(
          () => window.fixture.heartbeatHistoryResponses.length === 3,
          null,
          { timeout: 6000 },
        );
        assert.equal(
          await panel
            .locator(".hb-wake > summary")
            .filter({ hasText: "old thread-a heartbeat" })
            .count(),
          0,
        );
        assert.equal(
          await panel
            .locator(".hb-wake > summary")
            .filter({ hasText: "new thread-a heartbeat" })
            .count(),
          1,
        );
        const requests = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "heartbeat-history"),
        );
        assert.deepEqual(
          requests.map((request) => request.threadId),
          ["thread-a", "thread-b", "thread-a"],
        );
        await context.close();
      },
    );
    await t.test("switching threads clears old data and rejects delayed replies", async () => {
      const { context, page, panel } = await open();
      await page.evaluate((value) => {
        window.fixture.task = value;
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, task);
      await page.evaluate(() => {
        window.fixture.delay = 500;
        void window.__CODEX_TASK_PROGRESS__.refresh();
      });
      await page.evaluate(() => {
        window.fixture.threadId = "thread-b";
        window.fixture.task = null;
        window.fixture.delay = 0;
      });
      await page.waitForTimeout(650);
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      assert.equal(await panel.getByText("实现普通任务面板", { exact: false }).count(), 0);
      assert.match(await panel.locator("section.panel").innerText(), /尚未建立任务/);
      assert.equal(
        (await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics())).threadId,
        "thread-b",
      );
      await context.close();
    });
    await t.test("reopening restores persisted expansion and current task data", async () => {
      const { context, page, panel } = await open();
      await panel.getByRole("button", { name: /任务进度/ }).click();
      await page.reload();
      await panel.locator(".summary .main").waitFor();
      await page.evaluate((value) => {
        window.fixture.task = value;
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, task);
      assert.match(await panel.locator("section.panel").innerText(), /普通聊天界面/);
      const lightBackground = await panel
        .locator(".body")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
      });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      const darkBody = panel.locator(".body");
      const darkBackground = await darkBody.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      assert.notEqual(darkBackground, lightBackground, "panel surface follows the host theme");
      assert.equal(
        await darkBody.evaluate((element) => getComputedStyle(element).color),
        await page.locator("#composer").evaluate((element) => getComputedStyle(element).color),
        "panel foreground follows the native host token",
      );
      await context.close();
    });
  } finally {
    await Promise.allSettled([...contexts].map((context) => context.close()));
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
