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
window.fixture = {delay:Number(new URL(location.href).searchParams.get("initialDelay") || 0),getFailureNext:new URL(location.href).searchParams.get("initialGetFailure"),holdNextGetFailure:false,releaseHeldGetFailure:null,holdNextGetSuccess:false,releaseHeldGetSuccess:null,getFailureThrownCount:0,fixtureEvents:[],delayNextHistory:0,holdNextHistoryFailure:false,releaseHeldHistoryFailure:null,historyFailureNext:null,heartbeatHistoryFailureNext:null,holdNextHeartbeatHistory:false,releaseHeldHeartbeatHistory:null,heartbeatHistoryResponses:[],heartbeatPending:false,taskSourcePending:false,task:null, taskSource:null, heartbeat:null, execution:{state:"unknown",observedAt:"2026-11-11T12:00:00Z",source:"codex-app-server"}, history:{events:[],nextCursor:null}, heartbeatHistory:null, archiveCount:0, completionBasis:undefined, archiveResponses:{}, holdNextArchive:false, releaseHeldArchive:null, calls:[],disabled:new URL(location.href).searchParams.get("disabled")==="true"};
window.fixture.threadId = "thread-a";
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  const fixtureRequestId = window.fixture.fixtureEvents.length + 1;
  window.fixture.fixtureEvents.push({type:'request',id:fixtureRequestId,method:request.method,threadId:request.threadId,at:performance.now()});
  if(request.method==='get' && window.fixture.getFailureNext) { const message=window.fixture.getFailureNext; window.fixture.getFailureNext=null; if(window.fixture.holdNextGetFailure) { window.fixture.holdNextGetFailure=false; await new Promise(resolve => { window.fixture.releaseHeldGetFailure=resolve; }); window.fixture.releaseHeldGetFailure=null; } window.fixture.getFailureThrownCount++; window.fixture.fixtureEvents.push({type:'response',id:fixtureRequestId,method:request.method,threadId:request.threadId,outcome:'error',at:performance.now()}); throw new Error(message); }
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.disabled?null:window.fixture.task,taskSource:window.fixture.disabled?null:window.fixture.taskSource,heartbeat:window.fixture.disabled?null:window.fixture.heartbeat,heartbeatPending:window.fixture.heartbeatPending,taskSourcePending:window.fixture.taskSourcePending,execution:window.fixture.execution,archiveCount:window.fixture.archiveCount,completionBasis:window.fixture.completionBasis,...(request.method==='archive'?{archive:structuredClone(window.fixture.archiveResponses[(request.taskId || "tasks") + ":" + (request.cursor || "first")])}:{}),...(window.fixture.disabled?{enabled:false}:{}),...(request.method==='history'?{history:window.fixture.history}:{}),...(request.method==='heartbeat-history'?{heartbeatHistory:window.fixture.heartbeatHistory}:{})};
  if(request.method==='archive' && window.fixture.holdNextArchive) { window.fixture.holdNextArchive=false; await new Promise(resolve => { window.fixture.releaseHeldArchive=resolve; }); window.fixture.releaseHeldArchive=null; }
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
element.refreshTask = () => window.__CODEX_TASK_PROGRESS__.refresh();
document.querySelector("#native-panel-shell").append(element);
let requestSequence = 0;
let lastError = null;
let refreshDepth = 0;
window.__CODEX_TASK_PROGRESS__ = {
  async refresh() {
    refreshDepth++;
    element.refreshing = true;
    try {
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
    } finally {
      refreshDepth--;
      element.refreshing = refreshDepth > 0;
      await element.updateComplete;
    }
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
      "view snapshots retain cached pages only within their thread and source fences",
      async () => {
        const { page } = await open();
        const result = await page.evaluate(
          async ({ task, heartbeat }) => {
            const panel = document.querySelector("codex-task-panel");
            panel.requester = null;
            const source = {
              kind: "kit-heartbeat",
              path: "/task.md",
              historyPath: "/task-history.md",
              contentHash: "task-v1",
              readOnly: true,
            };
            const data = {
              task: { ...task, source, lifecycle: { state: "active" } },
              heartbeat: { ...heartbeat, contentHash: "heartbeat-v1" },
              presentation: { scope: "project-a", pending: true, cached: true, updatedAt: 1 },
              taskSourcePending: true,
              history: {
                events: [],
                wakes: [{ heading: "cached history" }],
                total: 1,
                nextCursor: null,
                source,
              },
              heartbeatHistory: {
                wakes: [{ heading: "cached wake" }],
                total: 1,
                nextCursor: null,
                sourcePath: heartbeat.sourcePath,
                contentHash: "heartbeat-v1",
              },
            };
            panel.resetThread("thread-a");
            panel.data = data;
            panel.observed = true;
            panel.tab = "heartbeat";
            panel.selectedObjective = "ui";
            panel.heartbeatWakeExpansion.set("wake-key", true);
            await panel.updateComplete;
            const cachedWakeVisible = panel.shadowRoot.textContent.includes("cached wake");
            panel.tab = "history";
            await panel.updateComplete;
            const cachedHistoryVisible = panel.shadowRoot.textContent.includes("cached history");
            panel.tab = "heartbeat";
            await panel.updateComplete;
            const snapshot = panel.captureViewState();
            snapshot.heartbeatHistory.wakes[0].heading = "snapshot copy";
            const originalUnchanged = panel.heartbeatHistory.wakes[0].heading === "cached wake";
            panel.resetThread("thread-b");
            panel.data = { ...data, task: { ...data.task, threadId: "thread-b" } };
            panel.restoreViewState(snapshot);
            const otherThread = { tab: panel.tab, selected: panel.selectedObjective };
            panel.resetThread("thread-a");
            panel.data = data;
            panel.restoreViewState(snapshot);
            await panel.updateComplete;
            const restored = {
              tab: panel.tab,
              selected: panel.selectedObjective,
              history: panel.history.wakes[0].heading,
              wake: panel.heartbeatHistory.wakes[0].heading,
              expanded: panel.heartbeatWakeExpansion.get("wake-key"),
              pendingLabel: panel.shadowRoot.textContent.includes("正在刷新任务来源"),
            };
            panel.resetThread("thread-a");
            panel.data = {
              ...data,
              task: { ...data.task, source: { ...source, contentHash: "task-v2" } },
              history: undefined,
            };
            panel.restoreViewState(snapshot);
            const changedSource = { history: panel.history, selected: panel.selectedObjective };
            panel.resetThread("thread-a");
            panel.data = {
              ...data,
              task: { ...data.task, lifecycle: { state: "complete" } },
              history: undefined,
              heartbeatHistory: undefined,
            };
            panel.restoreViewState(snapshot);
            const changedLifecycle = {
              history: panel.history,
              heartbeatHistory: panel.heartbeatHistory,
              selected: panel.selectedObjective,
            };
            panel.resetThread(null);
            const nullThread = panel.captureViewState();
            return {
              originalUnchanged,
              cachedWakeVisible,
              cachedHistoryVisible,
              otherThread,
              restored,
              changedSource,
              changedLifecycle,
              nullThread,
            };
          },
          { task, heartbeat },
        );
        assert.equal(result.originalUnchanged, true);
        assert.equal(result.cachedWakeVisible, true);
        assert.equal(result.cachedHistoryVisible, true);
        assert.deepEqual(result.otherThread, { tab: "tasks", selected: null });
        assert.deepEqual(result.restored, {
          tab: "heartbeat",
          selected: "ui",
          history: "cached history",
          wake: "snapshot copy",
          expanded: true,
          pendingLabel: false,
        });
        assert.deepEqual(result.changedSource, { history: null, selected: null });
        assert.deepEqual(result.changedLifecycle, {
          history: null,
          heartbeatHistory: null,
          selected: null,
        });
        assert.equal(result.nullThread, null);
      },
    );

    await t.test("all views share the icon and label kicker", async () => {
      const { context, panel } = await open();
      for (const [view, label, path] of [
        ["tasks", "当前任务", "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"],
        ["history", "变更记录", "M3.5 10a8.5 8.5 0 1 1 1.8 7.4M3 4v6h6M12 7v5l3 2"],
        ["heartbeat", "项目动态", "M3 12h4l3-7 4 14 3-7h4"],
      ]) {
        await showView(panel, view);
        const kicker = panel.locator(".panel-head .panel-kicker");
        assert.equal(await kicker.count(), 1);
        assert.equal(await kicker.innerText(), label);
        assert.equal(await kicker.locator('svg[aria-hidden="true"] path').getAttribute("d"), path);
        assert.equal(await panel.locator(".panel-heading svg").count(), 0);
      }
      await context.close();
    });
    await t.test(
      "History and Heartbeat keep matching title-to-content breathing room in both locales",
      async () => {
        await mkdir(".playwright-img", { recursive: true });
        for (const width of [1100, 390]) {
          for (const { locale, expected } of [
            {
              locale: "en-US",
              expected: {
                history: "Task changes and their recorded evidence.",
                heartbeat: "Agent activity and tasks that need attention.",
              },
            },
            {
              locale: "zh-CN",
              expected: {
                history: "任务变更与已记录的依据。",
                heartbeat: "Agent 活动与需要关注的任务。",
              },
            },
          ]) {
            const { context, page, panel } = await open("", {
              viewport: { width, height: 850 },
              locale,
              reducedMotion: "reduce",
            });
            await page.evaluate(
              (value) => {
                window.fixture.task = value.task;
                window.fixture.heartbeat = value.heartbeat;
                return window.__CODEX_TASK_PROGRESS__.refresh();
              },
              { task, heartbeat },
            );
            const distances = {};
            for (const view of ["history", "heartbeat"]) {
              const trigger = panel.locator(
                view === "history" ? ".history-trigger" : ".heartbeat-trigger",
              );
              if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
              const subtitle = panel.locator(".panel-head .panel-subtitle");
              await subtitle.waitFor();
              assert.equal(await subtitle.innerText(), expected[view]);
              const layout = await panel.evaluate((element) => {
                const root = element.shadowRoot;
                const title = root.querySelector(".panel-title").getBoundingClientRect();
                const subtitleRect = root.querySelector(".panel-subtitle").getBoundingClientRect();
                const content = root
                  .querySelector(".scroll")
                  .firstElementChild.getBoundingClientRect();
                return {
                  titleBottom: title.bottom,
                  subtitleBottom: subtitleRect.bottom,
                  subtitleHeight: subtitleRect.height,
                  contentTop: content.top,
                };
              });
              assert.ok(layout.subtitleHeight > 0, `${view} description is visible at ${width}px`);
              assert.ok(
                layout.subtitleBottom <= layout.contentTop,
                `${view} content starts after its full description at ${width}px`,
              );
              distances[view] = layout.contentTop - layout.titleBottom;
              assert.ok(distances[view] > 0, `${view} has space after its title at ${width}px`);
              await panel.locator(".body").screenshot({
                path: `.playwright-img/${view}-header-${locale}-${width}.png`,
              });
            }
            assert.ok(
              Math.abs(distances.history - distances.heartbeat) <= 1,
              `History and Heartbeat title-to-content spacing should match at ${width}px (${locale}): ${JSON.stringify(distances)}`,
            );
            await context.close();
          }
        }
      },
    );
    await t.test("view headers and content regions share spacing at both widths", async () => {
      for (const width of [1100, 390]) {
        const { context, page, panel } = await open("", { viewport: { width, height: 850 } });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.evaluate(
          ({ task, heartbeat }) => {
            window.fixture.task = task;
            window.fixture.heartbeat = heartbeat;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { task, heartbeat },
        );
        const measurements = [];
        for (const view of ["tasks", "history", "heartbeat"]) {
          await showView(panel, view);
          if (view === "tasks") {
            const row = panel.locator(".scroll > .row").first();
            const style = await row.evaluate((element) => {
              const computed = getComputedStyle(element);
              return { margin: computed.margin, radius: computed.borderTopLeftRadius };
            });
            assert.deepEqual(style, { margin: "0px 0px 8px", radius: "999px" });
          }
          measurements.push(
            await panel.evaluate((element) => {
              const root = element.shadowRoot;
              const head = root.querySelector(".panel-head");
              const kicker = root.querySelector(".panel-kicker");
              const heading = root.querySelector(".panel-heading");
              const title = root.querySelector(".panel-title");
              const refresh = root.querySelector(".panel-refresh");
              const scroll = root.querySelector(".scroll");
              const first = scroll.firstElementChild;
              const body = root.querySelector(".body");
              const headStyle = getComputedStyle(head);
              return {
                padding: [
                  headStyle.paddingTop,
                  headStyle.paddingRight,
                  headStyle.paddingBottom,
                  headStyle.paddingLeft,
                ],
                kickerGap: getComputedStyle(kicker).gap,
                kickerBottom: getComputedStyle(kicker).marginBottom,
                headingGap: getComputedStyle(heading).gap,
                titleSize: getComputedStyle(title).fontSize,
                refreshSize: [
                  refresh.getBoundingClientRect().width,
                  refresh.getBoundingClientRect().height,
                ],
                refreshTitleGap:
                  title.getBoundingClientRect().top - refresh.getBoundingClientRect().bottom,
                kickerInset:
                  kicker.getBoundingClientRect().left - body.getBoundingClientRect().left,
                titleInset: title.getBoundingClientRect().left - body.getBoundingClientRect().left,
                contentInset:
                  first.getBoundingClientRect().left - body.getBoundingClientRect().left,
                contentGap: first.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
              };
            }),
          );
        }
        assert.deepEqual(measurements[1], measurements[0], `history spacing at ${width}px`);
        assert.deepEqual(measurements[2], measurements[0], `heartbeat spacing at ${width}px`);
        assert.deepEqual(
          measurements[0].padding,
          width > 450 ? ["19px", "20px", "14px", "20px"] : ["16px", "15px", "13px", "15px"],
        );
        assert.equal(measurements[0].titleSize, width > 450 ? "17px" : "15px");
        assert.equal(measurements[0].kickerGap, "7px");
        assert.equal(measurements[0].kickerBottom, "9px");
        assert.equal(measurements[0].headingGap, "8px");
        assert.equal(measurements[0].contentGap, 0);
        assert.deepEqual(measurements[0].refreshSize, [30, 30]);
        assert.ok(
          measurements[0].refreshTitleGap >= 0,
          "header refresh does not overlap the title",
        );
        await context.close();
      }
    });
    await t.test(
      "fresh onboarding excludes pending and errors; refresh controls and status labels",
      async () => {
        const { context, page, panel } = await open("", { locale: "en-US" });
        await page.evaluate(() => {
          window.fixture.task = null;
          window.fixture.taskSource = null;
          window.fixture.heartbeat = null;
          window.fixture.heartbeatPending = false;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await panel.locator(".summary .title").innerText(), /Start a new session/);
        await panel.locator(".summary .main").click();
        assert.match(await panel.locator(".scroll").innerText(), /Start a task in this chat/);
        assert.equal(await panel.locator(".scroll button").count(), 0);
        await page.evaluate(() => {
          window.fixture.heartbeatPending = true;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.doesNotMatch(
          await panel.locator(".summary .title").innerText(),
          /Start a new session/,
        );
        await page.evaluate(() => {
          window.fixture.heartbeatPending = false;
          window.fixture.taskSourcePending = true;
          window.fixture.taskSource = {
            status: "pending",
            retryable: true,
            readOnly: true,
            error: "temporary source failure",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await panel.locator(".scroll").innerText(), /Refreshing task source/);
        assert.doesNotMatch(await panel.locator(".scroll").innerText(), /temporary source failure/);
        await panel.getByRole("button", { name: "History", exact: true }).click();
        assert.match(await panel.locator(".scroll").innerText(), /Refreshing task source/);
        assert.equal(await panel.locator(".info-card-error").count(), 0);
        await panel.locator(".summary .main").click();
        await page.evaluate(() => {
          window.fixture.heartbeatPending = false;
          window.fixture.taskSourcePending = true;
          window.fixture.taskSource = { status: "error", readOnly: true, error: "source failed" };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.doesNotMatch(
          await panel.locator(".summary .title").innerText(),
          /Start a new session/,
        );
        assert.match(await panel.locator(".scroll").innerText(), /source failed/);
        await page.evaluate((value) => {
          window.fixture.taskSource = null;
          window.fixture.taskSourcePending = false;
          window.fixture.task = structuredClone(value);
          window.fixture.task.objectives[0].items[0].status = "active";
          window.fixture.task.objectives[0].items[1].status = "blocked";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await panel.locator(".row[data-objective]").first().click();
        assert.match(
          await panel.locator('.node-status[data-status="active"]').first().innerText(),
          /Working/,
        );
        assert.match(
          await panel.locator('.node-status[data-status="blocked"]').first().innerText(),
          /blocked/,
        );
        await panel.getByRole("button", { name: "History", exact: true }).click();
        const refresh = panel.locator(".panel-refresh");
        assert.equal(await refresh.getAttribute("aria-label"), "Refresh");
        const style = await refresh.evaluate((element) => {
          const css = getComputedStyle(element);
          return {
            border: css.borderTopWidth,
            cursor: css.cursor,
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
          };
        });
        assert.notEqual(style.border, "0px");
        assert.equal(style.cursor, "pointer");
        assert.deepEqual([style.width, style.height], [30, 30]);
        assert.equal(await refresh.innerText(), "");
        assert.equal(await refresh.getAttribute("title"), null);
        assert.equal(await refresh.locator("svg").count(), 1);
        await refresh.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(
          await refresh.evaluate((element) => element.getRootNode().activeElement === element),
          true,
        );
        assert.notEqual(
          await refresh.evaluate((element) => getComputedStyle(element).outlineStyle),
          "none",
        );
        await context.close();
      },
    );
    await t.test(
      "one compact header refresh routes through the active view and ignores stale chat results",
      async () => {
        for (const width of [1100, 390]) {
          const { context, page, panel } = await open("", {
            viewport: { width, height: 850 },
            reducedMotion: "reduce",
          });
          const assertRefresh = async (label, { disabled = false, busy = false } = {}) => {
            const button = panel.locator(".panel-refresh");
            await page.waitForFunction(
              ({ expectedDisabled, expectedBusy }) => {
                const current = document
                  .querySelector("codex-task-panel")
                  ?.shadowRoot?.querySelector(".panel-refresh");
                return (
                  current &&
                  current.disabled === expectedDisabled &&
                  current.getAttribute("aria-busy") === String(expectedBusy)
                );
              },
              { expectedDisabled: disabled, expectedBusy: busy },
            );
            assert.equal(await button.getAttribute("aria-label"), label);
            assert.equal(await button.getAttribute("aria-busy"), String(busy));
            assert.equal(await button.isDisabled(), disabled);
            assert.equal(await button.getAttribute("title"), null);
            assert.equal(await button.innerText(), "");
            assert.equal(await button.locator("svg").count(), 1);
            assert.deepEqual(
              await button.evaluate((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return {
                  width: rect.width,
                  height: rect.height,
                  radius: style.borderTopLeftRadius,
                  border: style.borderTopWidth,
                  hidden: style.visibility === "hidden" || style.display === "none",
                };
              }),
              { width: 30, height: 30, radius: "50%", border: "1px", hidden: false },
            );
            return button;
          };

          await page.evaluate((value) => {
            window.fixture.task = value;
            window.fixture.history = { events: [], nextCursor: null };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);
          await assertRefresh("刷新当前任务");
          await page.evaluate((value) => {
            window.fixture.task = { ...value, title: "header task refresh updated data" };
          }, task);
          const initialGetCount = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          );
          await panel.locator(".panel-refresh").click();
          await panel
            .getByRole("heading", {
              level: 2,
              name: "header task refresh updated data",
              exact: true,
            })
            .waitFor();
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "get").length,
            ),
            initialGetCount + 1,
          );

          await panel.getByRole("button", { name: "历史", exact: true }).click();
          await panel.locator('.info-card[aria-label="历史记录"]').waitFor();
          await assertRefresh("刷新");
          assert.equal(await panel.locator(".scroll .info-card-action").count(), 0);
          await page.evaluate(() => {
            window.fixture.history = {
              events: [{ reason: "outer history refresh updated data" }],
              nextCursor: null,
            };
          });
          const historyCallsBefore = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          );
          const getCallsBeforeHistoryRefresh = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          );
          await panel.locator(".panel-refresh").click();
          await panel
            .locator(".scroll")
            .getByText("outer history refresh updated data", { exact: true })
            .waitFor();
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "get").length,
            ),
            getCallsBeforeHistoryRefresh + 1,
          );
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "history").length,
            ),
            historyCallsBefore + 1,
          );

          const source = {
            kind: "kit-heartbeat",
            path: "/repo/.workspace/task/session/heartbeat.md",
            readOnly: true,
            contentHash: "hash-a",
          };
          await page.evaluate(
            ({ value, source }) => {
              window.fixture.task = { ...value, source };
              window.fixture.history = {
                events: [],
                wakes: [{ heading: "bound ledger refresh old" }],
                total: 1,
                nextCursor: null,
                source,
              };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: task, source },
          );
          await panel
            .locator(".scroll")
            .getByText("bound ledger refresh old", { exact: true })
            .waitFor();
          await assertRefresh("刷新台账历史");
          assert.equal(await panel.locator(".scroll .info-card-action").count(), 0);
          const boundHistoryCallsBefore = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          );
          const getCallsBeforeBoundRefresh = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          );
          await page.evaluate(() => {
            window.fixture.history = {
              events: [],
              wakes: [{ heading: "bound ledger refresh updated data" }],
              total: 2,
              nextCursor: null,
              source: { ...window.fixture.task.source },
            };
          });
          await panel.locator(".panel-refresh").click();
          await panel
            .locator(".scroll")
            .getByText("bound ledger refresh updated data", { exact: true })
            .waitFor();
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "get").length,
            ),
            getCallsBeforeBoundRefresh + 1,
          );
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "history").length,
            ),
            boundHistoryCallsBefore + 1,
          );

          await page.evaluate(() => {
            window.fixture.heartbeat = null;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await panel.getByRole("button", { name: "心跳", exact: true }).click();
          await assertRefresh("刷新心跳历史");
          assert.equal(await panel.locator(".scroll .info-card-action").count(), 0);

          await page.evaluate((value) => {
            window.fixture.heartbeat = value;
            window.fixture.heartbeatHistory = {
              wakes: [{ heading: "heartbeat refresh old" }],
              total: 1,
              nextCursor: null,
              sourcePath: value.sourcePath,
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, heartbeat);
          await panel
            .locator(".scroll")
            .getByText("heartbeat refresh old", { exact: true })
            .waitFor();
          assert.equal(await panel.locator(".scroll .info-card-action").count(), 0);
          const heartbeatHistoryCallsBefore = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
          );
          const getCallsBeforeHeartbeatRefresh = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          );
          await page.evaluate(() => {
            window.fixture.heartbeatHistory = {
              wakes: [{ heading: "heartbeat refresh updated data" }],
              total: 2,
              nextCursor: null,
              sourcePath: window.fixture.heartbeat.sourcePath,
            };
          });
          await panel.locator(".panel-refresh").click();
          await panel
            .locator(".scroll")
            .getByText("heartbeat refresh updated data", { exact: true })
            .waitFor();
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "get").length,
            ),
            getCallsBeforeHeartbeatRefresh + 1,
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            heartbeatHistoryCallsBefore + 1,
          );

          await page.evaluate((value) => {
            window.fixture.task = value;
            window.fixture.history = { events: [], nextCursor: null };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);

          const heartbeatCallsBeforeViewSwitch = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
          );
          await page.evaluate(() => {
            window.fixture.holdNextGetSuccess = true;
          });
          await panel.locator(".panel-refresh").click();
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldGetSuccess === "function",
          );
          await panel.locator(".history-trigger").click();
          await panel.locator(".scroll").getByText("暂无变更记录。", { exact: true }).waitFor();
          const historyCallsAfterViewSwitch = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          );
          await page.evaluate(() => window.fixture.releaseHeldGetSuccess());
          await page.waitForFunction(
            () =>
              !document
                .querySelector("codex-task-panel")
                ?.shadowRoot?.querySelector(".panel-refresh")?.disabled,
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
            ),
            heartbeatCallsBeforeViewSwitch,
            "a refresh started in Heartbeat cannot reload it after switching to History",
          );
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "history").length,
            ),
            historyCallsAfterViewSwitch,
            "the switched view's automatic load is not duplicated by the previous refresh",
          );

          await page.evaluate(() => {
            window.fixture.holdNextGetSuccess = true;
          });
          await assertRefresh("刷新");
          await panel.locator(".panel-refresh").click();
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldGetSuccess === "function",
          );
          await assertRefresh("刷新", { disabled: true, busy: true });
          const heldGetCalls = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          );
          await panel.locator(".panel-refresh").evaluate((element) => element.click());
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "get").length,
            ),
            heldGetCalls,
            "a busy outer refresh cannot enqueue a duplicate task read",
          );
          await page.evaluate(
            ({ value, threadId, title }) => {
              window.fixture.threadId = threadId;
              window.fixture.task = { ...value, threadId, title };
              window.fixture.history = { events: [], nextCursor: null };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: task, threadId: "thread-b", title: "thread b" },
          );
          await panel.locator(".summary .title").waitFor();
          assert.equal(await panel.locator(".summary .title").innerText(), "thread b");
          await page.evaluate(
            ({ value, threadId, title }) => {
              window.fixture.threadId = threadId;
              window.fixture.task = { ...value, threadId, title };
              window.fixture.history = { events: [], nextCursor: null };
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { value: task, threadId: "thread-a", title: "thread a current" },
          );
          await panel.locator(".summary .title").waitFor();
          assert.equal(await panel.locator(".summary .title").innerText(), "thread a current");
          await panel.locator(".scroll").getByText("暂无变更记录。", { exact: true }).waitFor();
          const historyCallsBeforeOldResponse = await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          );
          await page.evaluate(() => window.fixture.releaseHeldGetSuccess());
          await page.waitForFunction(
            () =>
              !document
                .querySelector("codex-task-panel")
                ?.shadowRoot?.querySelector(".panel-refresh")?.disabled,
          );
          assert.equal(
            await page.evaluate(
              () => window.fixture.calls.filter((call) => call.method === "history").length,
            ),
            historyCallsBeforeOldResponse,
            "late refresh from the prior A identity cannot start a second history read after an A-to-B-to-A identity reset",
          );
          await context.close();
        }
      },
    );
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
          orchestration: {
            blockedTasks: [{ title: text, reason: "reason", requiresOwner: false }],
          },
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
                    orchestration: {
                      blockedTasks: [
                        {
                          title: "current hash A snapshot",
                          reason: "reason",
                          requiresOwner: false,
                        },
                      ],
                    },
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyA;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { task, heartbeat, sourcePath, historyA },
          );
          await showView(panel, "heartbeat");
          await panel.locator(".hb-wake").getByText("history hash A", { exact: true }).waitFor();
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
                    orchestration: {
                      blockedTasks: [
                        {
                          title: "current hash B snapshot",
                          reason: "reason",
                          requiresOwner: false,
                        },
                      ],
                    },
                  },
                ],
              };
              window.fixture.heartbeatHistory = historyB;
              return window.__CODEX_TASK_PROGRESS__.refresh();
            },
            { heartbeat, sourcePath, historyB },
          );
          await page.waitForFunction(() => window.fixture.heartbeatHistoryResponses.length === 2);
          await panel.locator(".hb-wake").getByText("history hash B", { exact: true }).waitFor();
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
                    orchestration: {
                      blockedTasks: [
                        { title: "wrong hash cursor page", reason: "reason", requiresOwner: false },
                      ],
                    },
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
                    orchestration: {
                      blockedTasks: [
                        { title: "error page bad row", reason: "reason", requiresOwner: false },
                      ],
                    },
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
              orchestration: {
                blockedTasks: [
                  { title: "held history hash A", reason: "reason", requiresOwner: false },
                ],
              },
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
              orchestration: {
                blockedTasks: [
                  { title: "new history hash B", reason: "reason", requiresOwner: false },
                ],
              },
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
                    orchestration: {
                      blockedTasks: [
                        {
                          title: "current hash A snapshot",
                          reason: "reason",
                          requiresOwner: false,
                        },
                      ],
                    },
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
                    orchestration: {
                      blockedTasks: [
                        {
                          title: "current hash B snapshot",
                          reason: "reason",
                          requiresOwner: false,
                        },
                      ],
                    },
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
            .locator(".hb-wake")
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
      "background Heartbeat refresh keeps verified cards and records stable, then fences terminal responses",
      async () => {
        const { context, page, panel } = await open("", { reducedMotion: "reduce" });
        const sourcePath = "/workspace/shared-project/heartbeat.md";
        const oldHistory = {
          wakes: [
            {
              timeMs: Date.parse("2026-11-13T14:34:48Z"),
              orchestration: {
                blockedTasks: [
                  { title: "verified cached record", reason: "reason", requiresOwner: false },
                ],
              },
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
            .locator(".hb-wake")
            .getByText("verified cached record", { exact: true })
            .waitFor();
          assert.equal(await panel.locator(".hb-alert .info-card-title").count(), 1);
          assert.match(
            await panel.locator(".hb-alert").innerText(),
            /Project heartbeat refresh notice/,
          );
          const cardRects = async () =>
            panel.evaluate((element) =>
              [".hb-time-card", ".hb-history"].map((selector) => {
                const rect = element.shadowRoot.querySelector(selector).getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              }),
            );
          const readyCardRects = await cardRects();

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
            .locator(".hb-wake")
            .getByText("verified cached record", { exact: true })
            .waitFor();
          assert.doesNotMatch(
            await panel.locator(".scroll").innerText(),
            /正在刷新项目心跳|Refreshing the project heartbeat|心跳历史正在刷新|Heartbeat history is refreshing/,
          );
          assert.equal(await panel.locator(".hb-history .hb-count").innerText(), "1");
          assert.deepEqual(await cardRects(), readyCardRects);
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
          await page.waitForFunction(() => {
            const button = document
              .querySelector("codex-task-panel")
              ?.shadowRoot?.querySelector(".panel-refresh");
            return button && !button.disabled && button.getAttribute("aria-busy") === "false";
          });

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
                    orchestration: {
                      blockedTasks: [
                        { title: "new verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:00:00Z"),
                    orchestration: {
                      blockedTasks: [
                        { title: "new verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
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
            .locator(".hb-wake")
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
            .locator(".hb-wake")
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
                    orchestration: {
                      blockedTasks: [
                        { title: "third verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:10:00Z"),
                    orchestration: {
                      blockedTasks: [
                        { title: "third verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
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
            .locator(".hb-wake")
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
            .locator(".hb-wake")
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
                    orchestration: {
                      blockedTasks: [
                        { title: "fourth verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
                  },
                ],
                wakeCount: 1,
              };
              window.fixture.heartbeatHistory = {
                wakes: [
                  {
                    timeMs: Date.parse("2026-11-13T15:20:00Z"),
                    orchestration: {
                      blockedTasks: [
                        { title: "fourth verified record", reason: "reason", requiresOwner: false },
                      ],
                    },
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
            .locator(".hb-wake")
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
          orchestration: {
            blockedTasks: [{ title: "A baseline content", reason: "reason", requiresOwner: false }],
          },
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
            .locator(".hb-wake")
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

          const firstSummary = panel.locator(".hb-wake").first().locator(":scope > summary");
          await firstSummary.click();
          assert.equal(await panel.locator(".hb-wake").first().getAttribute("open"), null);
          const lateA = {
            wakes: [
              {
                timeMs: Date.parse("2026-11-13T14:18:22Z"),
                orchestration: {
                  blockedTasks: [
                    {
                      title: "A late history must not win",
                      reason: "reason",
                      requiresOwner: false,
                    },
                  ],
                },
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
                orchestration: {
                  blockedTasks: [
                    { title: "B thread history", reason: "reason", requiresOwner: false },
                  ],
                },
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
            .locator(".hb-wake")
            .getByText("B thread history", { exact: true })
            .waitFor({ timeout: 6000 });
          assert.equal(
            await panel.locator(".hb-wake").first().getAttribute("open"),
            "",
            "switching chats resets wake disclosure state",
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
      for (const [index, name] of ["历史", "心跳"].entries()) {
        const trigger = panel.getByRole("button", { name, exact: true });
        const circle = await trigger.boundingBox();
        assert.equal(circle.width, 40);
        assert.equal(circle.height, 40);
        assert.equal(await trigger.getAttribute("title"), null);
        await trigger.hover();
        assert.equal(await panel.getByText(name, { exact: true }).count(), 0);
        assert.equal(await panel.getByRole("tooltip").count(), 0);
        await page.locator("[role=textbox]:visible").focus();
        for (let tab = 0; tab < index + 2; tab += 1) await page.keyboard.press("Tab");
        assert.equal(await trigger.evaluate((element) => element.matches(":focus-visible")), true);
        assert.equal(await panel.getByText(name, { exact: true }).count(), 0);
        assert.equal(await panel.getByRole("tooltip").count(), 0);
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
      const heartbeatTab = panel.getByRole("button", { name: "心跳", exact: true });
      await heartbeatTab.focus();
      await heartbeatTab.press("Escape");
      assert.equal(await panel.locator(".body").isVisible(), true);
      assert.equal(await panel.locator(".panel-title").innerText(), "项目心跳");
      assert.equal(await heartbeatTab.getAttribute("aria-expanded"), "true");
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
        const historyCard = panel.locator(
          '.info-card[aria-label="History"], .info-card[aria-label="历史记录"]',
        );
        assert.equal(await historyCard.count(), 1);
        assert.match(
          await historyCard.locator(":scope > .info-card-head > .info-card-title").innerText(),
          /^(History|历史记录)$/,
        );
        assert.equal(
          await historyCard
            .locator(":scope > .info-card-head > .info-card-title > .info-card-count")
            .count(),
          0,
        );
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
                  orchestration: {
                    scope: "bound task",
                    before: { activeAgents: 2 },
                    after: { activeAgents: 4 },
                    blockedTaskCount: 1,
                    ownerInterventionCount: 1,
                    requiresOwner: true,
                    blockedTasks: [
                      {
                        id: "review",
                        title: "Owner decision",
                        reason: "Needs approval",
                        requiresOwner: true,
                      },
                    ],
                    truncated: false,
                  },
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
        const ledgerCard = panel.locator(
          '.info-card[aria-label="Ledger records"], .info-card[aria-label="台账记录"]',
        );
        assert.equal(await ledgerCard.count(), 1);
        assert.match(
          await ledgerCard.locator(":scope > .info-card-head > .info-card-title").innerText(),
          /^(Ledger records|台账记录)\s*2$/,
        );
        assert.equal(
          await ledgerCard
            .locator(":scope > .info-card-head > .info-card-title > .info-card-count")
            .innerText(),
          "2",
        );
        assert.match(await panel.locator("section.panel").innerText(), /只读台账.*heartbeat\.md/s);
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /历史台账/);
        assert.match(await panel.locator("section.panel").innerText(), /台账记录.*2/s);
        assert.match(await panel.locator("section.panel").innerText(), /bound task/);
        assert.match(await panel.locator("section.panel").innerText(), /2 → 4/);
        assert.match(await panel.locator("section.panel").innerText(), /Owner decision/);
        assert.doesNotMatch(await panel.locator("section.panel").innerText(), /Feature · active/);
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
      "paired Kit history displays its ledger location while retaining HEAD identity",
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
        assert.doesNotMatch(await scroll.innerText(), /taskhistory\.md:25/);
        await panel.getByRole("button", { name: "心跳", exact: true }).click();
        assert.equal(await panel.locator(".hb-source").count(), 0);
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
        assert.match(historyText, /旧记录未记录编排快照/);
        assert.doesNotMatch(historyText, /Audit · verified/);
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
    await t.test(
      "managed cycles keep closeout, archive pages and current scope separate",
      async () => {
        const { context, page, panel } = await open("", { locale: "en-US" });
        const summary = {
          id: "old-1",
          title: "First delivered task",
          completedAt: "2026-11-12T12:00:00Z",
          completionRevision: 5,
          progress: { completed: 3, total: 3, percent: 100 },
          objectiveCount: 1,
          itemCount: 2,
        };
        const second = {
          ...summary,
          id: "old-2",
          title: "Older delivered task",
          completionRevision: 2,
        };
        const managed = {
          ...task,
          title: "Current task",
          schemaVersion: 4,
          lifecycle: {
            id: "cycle-2",
            sequence: 2,
            startedAt: "2026-11-13T12:00:00Z",
            completion: null,
          },
          progress: { completed: 2, total: 3, percent: 66.67 },
          objectives: [
            {
              ...task.objectives[0],
              title: "Current objective",
              status: "completed",
              items: task.objectives[0].items.map((item) => ({ ...item, status: "completed" })),
            },
          ],
        };
        await page.evaluate(
          ({ managed, summary, second }) => {
            Object.assign(window.fixture, {
              task: managed,
              archiveCount: 2,
              completionBasis: "task-lifecycle",
              archiveResponses: {
                "tasks:first": {
                  kind: "tasks",
                  tasks: [summary],
                  total: 2,
                  nextCursor: "older",
                  currentTaskId: "cycle-2",
                  threadId: "thread-a",
                },
                "tasks:older": {
                  kind: "tasks",
                  tasks: [second],
                  total: 2,
                  nextCursor: null,
                  currentTaskId: "cycle-2",
                  threadId: "thread-a",
                },
                "old-1:first": {
                  kind: "subtasks",
                  task: summary,
                  nodes: [
                    {
                      id: "o",
                      title: "Archived objective",
                      status: "completed",
                      kind: "objective",
                      required: true,
                    },
                  ],
                  totalNodes: 2,
                  nextCursor: "node-2",
                  currentTaskId: "cycle-2",
                  threadId: "thread-a",
                },
                "old-1:node-2": {
                  kind: "subtasks",
                  task: summary,
                  nodes: [
                    {
                      id: "i",
                      title: "Archived child",
                      status: "completed",
                      kind: "item",
                      parentId: "o",
                    },
                  ],
                  totalNodes: 2,
                  nextCursor: null,
                  currentTaskId: "cycle-2",
                  threadId: "thread-a",
                },
              },
            });
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { managed, summary, second },
        );
        assert.match(await panel.locator(".summary").innerText(), /Task progress 2\/3/);
        await page.evaluate(() => {
          window.fixture.task.objectives[0].items.push({
            id: "added",
            title: "Mid-cycle addition",
            status: "pending",
            evidence: [],
          });
          window.fixture.task.progress = { completed: 2, total: 4, percent: 50 };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await panel.locator(".summary").innerText(), /Task progress 2\/4/);
        assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
        await page.evaluate(() => {
          window.fixture.task.objectives[0].items.pop();
          window.fixture.task.progress = { completed: 2, total: 3, percent: 66.67 };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.locator(".summary .main").click();
        assert.match(
          await panel.locator('[aria-label="Task closeout"]').innerText(),
          /Closeout not recorded.*0\/1/s,
        );
        const archive = panel.locator(".archive-toggle");
        assert.equal(await archive.getAttribute("aria-expanded"), "false");
        assert.match(await archive.innerText(), /Archive\s*2/);
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "archive").length,
          ),
          0,
        );
        assert.equal(await panel.locator(".archive-node").count(), 0);
        await archive.click();
        const first = panel
          .locator(".archive-cycle-toggle")
          .filter({ hasText: "First delivered task" });
        await first.waitFor();
        assert.equal(await first.getAttribute("aria-expanded"), "false");
        assert.equal(await panel.locator(".archive-node").count(), 0);
        await first.click();
        await panel.locator(".archive-node").filter({ hasText: "Archived objective" }).waitFor();
        await panel.getByRole("button", { name: "Load more", exact: true }).click();
        await panel.locator(".archive-node").filter({ hasText: "Archived child" }).waitFor();
        await panel.getByRole("button", { name: "Older tasks", exact: true }).click();
        const older = panel
          .locator(".archive-cycle-toggle")
          .filter({ hasText: "Older delivered task" });
        await older.waitFor();
        assert.equal(await older.getAttribute("aria-expanded"), "false");
        const calls = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "archive"),
        );
        assert.deepEqual(
          calls.map(({ threadId, taskId, cursor, limit }) => ({ threadId, taskId, cursor, limit })),
          [
            { threadId: "thread-a", taskId: undefined, cursor: undefined, limit: 50 },
            { threadId: "thread-a", taskId: "old-1", cursor: undefined, limit: 50 },
            { threadId: "thread-a", taskId: "old-1", cursor: "node-2", limit: 50 },
            { threadId: "thread-a", taskId: undefined, cursor: "older", limit: 50 },
          ],
        );
        assert.equal(await panel.locator(".row[data-objective]").count(), 1);
        assert.match(
          await panel.locator(".row[data-objective]").first().innerText(),
          /Current objective/,
        );
        await page.evaluate(() => {
          window.fixture.task.lifecycle.completion = {
            completedAt: "2026-11-14T12:00:00Z",
            receipt: {
              branch: { status: "done", evidence: [] },
              merge: { status: "done", evidence: [] },
              push: { status: "done", evidence: [] },
              remainingWork: 0,
              ownerActions: 0,
              auditEvidence: [],
            },
          };
          window.fixture.task.progress = { completed: 3, total: 3, percent: 100 };
          window.fixture.execution.state = "working";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
        assert.match(await panel.locator(".summary").innerText(), /working|executing/i);
        await page.evaluate(() => {
          window.fixture.execution.state = "unknown";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
        assert.match(await panel.locator(".summary").innerText(), /unknown/i);
        assert.match(
          await panel.locator('[aria-label="Task closeout"]').innerText(),
          /Recorded.*1\/1/s,
        );
        assert.equal(await panel.getByRole("button", { name: /complete task/i }).count(), 0);
        await page.evaluate(() => {
          window.fixture.task = {
            ...window.fixture.task,
            title: "New task",
            lifecycle: {
              id: "cycle-3",
              sequence: 3,
              startedAt: "2026-11-15T12:00:00Z",
              completion: null,
            },
            progress: { completed: 0, total: 2, percent: 0 },
            objectives: [
              {
                id: "new",
                title: "New objective",
                status: "pending",
                required: true,
                evidence: [],
                items: [],
              },
            ],
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await panel.locator(".archive-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(await panel.locator(".archive-node").count(), 0);
        assert.match(
          await panel.locator(".row[data-objective]").first().innerText(),
          /New objective/,
        );
        assert.doesNotMatch(
          await panel.locator(".scroll").innerText(),
          /Archived child|Current objective/,
        );
        await context.close();
      },
    );
    await t.test(
      "archive rejects delayed results across chat, cycle and source changes",
      async () => {
        const { context, page, panel } = await open("", { locale: "en-US" });
        const managed = {
          ...task,
          title: "Current task",
          schemaVersion: 4,
          lifecycle: {
            id: "cycle-a",
            sequence: 1,
            startedAt: "2026-11-13T12:00:00Z",
            completion: null,
          },
        };
        const old = {
          id: "old",
          title: "Stale archive must not appear",
          completedAt: "2026-11-12T12:00:00Z",
          completionRevision: 2,
          progress: { completed: 1, total: 1, percent: 100 },
          objectiveCount: 1,
          itemCount: 0,
        };
        await page.evaluate(
          ({ managed, old }) => {
            Object.assign(window.fixture, {
              task: managed,
              archiveCount: 1,
              completionBasis: "task-lifecycle",
              holdNextArchive: true,
              archiveResponses: {
                "tasks:first": {
                  kind: "tasks",
                  tasks: [old],
                  total: 1,
                  nextCursor: null,
                  currentTaskId: "cycle-a",
                  threadId: "thread-a",
                },
              },
            });
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { managed, old },
        );
        await panel.locator(".summary .main").click();
        await panel.locator(".archive-toggle").click();
        await page.waitForFunction(() => typeof window.fixture.releaseHeldArchive === "function");
        await page.evaluate(async () => {
          window.fixture.threadId = "thread-b";
          window.fixture.task = {
            ...window.fixture.task,
            threadId: "thread-b",
            lifecycle: { ...window.fixture.task.lifecycle, id: "cycle-b" },
          };
          await window.__CODEX_TASK_PROGRESS__.refresh();
          window.fixture.threadId = "thread-a";
          window.fixture.task = {
            ...window.fixture.task,
            threadId: "thread-a",
            lifecycle: { ...window.fixture.task.lifecycle, id: "cycle-a" },
          };
          window.fixture.archiveResponses["tasks:first"] = {
            kind: "tasks",
            tasks: [],
            total: 0,
            nextCursor: null,
            currentTaskId: "cycle-a",
            threadId: "thread-a",
          };
          await window.__CODEX_TASK_PROGRESS__.refresh();
        });
        if ((await panel.locator(".summary .main").getAttribute("aria-expanded")) !== "true")
          await panel.locator(".summary .main").click();
        assert.equal(await panel.locator(".archive-toggle").getAttribute("aria-expanded"), "false");
        await panel.locator(".archive-toggle").click();
        await panel.getByText("No archived tasks.").waitFor();
        await page.evaluate(async () => {
          window.fixture.releaseHeldArchive();
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        assert.equal(
          await panel
            .locator(".archive-cycle-toggle")
            .filter({ hasText: "Stale archive must not appear" })
            .count(),
          0,
        );
        await panel.locator(".archive-toggle").click();
        await page.evaluate(() => {
          window.fixture.holdNextArchive = true;
          window.fixture.task.lifecycle.id = "cycle-next";
          window.fixture.archiveResponses["tasks:first"] = {
            kind: "tasks",
            tasks: [
              {
                id: "late",
                title: "Late same chat cycle",
                completedAt: "2026-11-12T12:00:00Z",
                completionRevision: 2,
                progress: { completed: 1, total: 1, percent: 100 },
                objectiveCount: 1,
                itemCount: 0,
              },
            ],
            total: 1,
            nextCursor: null,
            currentTaskId: "cycle-next",
            threadId: "thread-a",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.locator(".archive-toggle").click();
        await page.waitForFunction(() => typeof window.fixture.releaseHeldArchive === "function");
        await page.evaluate(() => {
          window.fixture.task.lifecycle.id = "cycle-final";
          window.fixture.task.source = {
            kind: "kit-heartbeat",
            path: "/workspace/bound.md",
            readOnly: true,
            contentHash: "bound",
          };
          window.fixture.archiveResponses["tasks:first"] = {
            available: false,
            reason: "Source archive unavailable",
            currentTaskId: "cycle-final",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.equal(await panel.locator(".archive-toggle").getAttribute("aria-expanded"), "false");
        await panel.locator(".archive-toggle").click();
        await panel.getByText("Source archive unavailable").waitFor();
        await page.evaluate(async () => {
          window.fixture.releaseHeldArchive();
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        assert.equal(
          await panel
            .locator(".archive-cycle-toggle")
            .filter({ hasText: "Late same chat cycle" })
            .count(),
          0,
        );
        assert.equal(
          await panel
            .locator(".archive-cycle-toggle")
            .filter({ hasText: "Stale archive must not appear" })
            .count(),
          0,
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
      "heartbeat orchestration layout keeps history visible and fits the panel",
      async () => {
        const { context, page, panel } = await open("", {
          viewport: { width: 1100, height: 850 },
          deviceScaleFactor: 2,
          timezoneId: "America/New_York",
          // Measure the settled layout; motion behavior has its own test.
          reducedMotion: "reduce",
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
                    category: "goal-derived remaining work",
                    line: 813,
                    state: "(1a) 已完成 — /tmp/hotupdate-verification-audit/result.md",
                  },
                  {
                    category: "read-only review",
                    state: "记录 29/29 项检查，跨五个线程的校验均通过。",
                  },
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
              basis: "latest-recorded-wake",
              passed: true,
              certifiesCurrent: false,
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

          const timeSection = panel.locator(".hb-time-card");
          const latestTime = panel.locator(".hb-time.hb-time-latest");
          const nextTime = panel.locator(".hb-time.hb-time-next");
          assert.equal(await panel.locator(".hb-time-latest strong").count(), 1);
          assert.equal(await panel.locator(".hb-wake").count(), 4);
          assert.match(await latestTime.innerText(), /09:34/);
          assert.equal(
            await latestTime
              .locator("strong")
              .evaluate((element) => getComputedStyle(element).fontSize),
            "22px",
          );
          assert.match(await latestTime.locator(".hb-time-date").innerText(), /13/);
          assert.doesNotMatch(await timeSection.innerText(), /heartbeat\.md/);
          assert.equal(await panel.locator(".panel-head .hb-status").count(), 0);
          assert.equal(await nextTime.getAttribute("data-missing"), "true");
          assert.equal(await nextTime.locator("strong").count(), 1);
          assert.match(await nextTime.innerText(), /未记录/);
          assert.match(await nextTime.innerText(), /等待记录下次巡检时间/);
          assert.equal(
            await nextTime
              .locator("strong")
              .evaluate((element) => getComputedStyle(element).fontSize),
            "17px",
            "unknown next time uses secondary-size text",
          );
          await page.evaluate(() => {
            window.fixture.heartbeat.nextWakeAt = "2026-11-13T16:02:00Z";
            window.fixture.heartbeat.cadenceMinutes = 30;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          });
          assert.equal(await nextTime.getAttribute("data-missing"), "false");
          assert.match(await nextTime.innerText(), /11:02/);
          assert.match(await nextTime.innerText(), /13/);
          assert.equal(await nextTime.locator(".hb-time-date").count(), 1);
          assert.equal(await latestTime.locator(".hb-time-date").count(), 1);
          await page.evaluate((value) => {
            window.fixture.heartbeat.nextWakeAt = value.nextWakeAt;
            window.fixture.heartbeat.cadenceMinutes = value.cadenceMinutes;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, heartbeat);
          assert.match(await nextTime.locator(".hb-time-label").innerText(), /下次巡检/);
          assert.equal(await nextTime.getAttribute("data-missing"), "true");
          assert.equal(await panel.locator(".hb-wake").count(), 4);
          assert.deepEqual(
            await page.evaluate(() => ({
              source: window.fixture.heartbeat.sourcePath,
              historySource: window.fixture.heartbeatHistory.sourcePath,
              history: window.fixture.heartbeat.historyPath,
              historyHistory: window.fixture.heartbeatHistory.historyPath,
              wakes: window.fixture.heartbeat.wakes.length,
              historyWakes: window.fixture.heartbeatHistory.wakes.length,
            })),
            {
              source: "/workspace/project/heartbeat.md",
              historySource: "/workspace/project/heartbeat.md",
              history: "/workspace/project/taskhistory.md",
              historyHistory: "/workspace/project/taskhistory.md",
              wakes: 4,
              historyWakes: 4,
            },
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
          assert.equal(await panel.locator(".hb-items").count(), 0);
          assert.equal(await panel.locator(".hb-source").count(), 0);
          assert.equal(await panel.locator(".hb-wake").first().getAttribute("open"), "");
          assert.equal(await panel.locator(".hb-wake").nth(1).getAttribute("open"), null);
          assert.equal(await panel.locator(".hb-wake.event").count(), 4);
          assert.match(await panel.locator(".hb-wake").first().innerText(), /旧记录未记录编排快照/);
          assert.doesNotMatch(
            await panel.locator(".hb-history").innerText(),
            /剩余工作检查|独立审查|goal-derived remaining work/,
          );
          const firstWake = panel.locator(".hb-wake").first();

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
            path: ".playwright-img/heartbeat-time-cards-light.png",
          });
          const lightWidth = light.readUInt32BE(16);
          const lightHeight = light.readUInt32BE(20);
          assert.equal(lightWidth, Math.round(bounds.width * 2));
          assert.ok(
            lightHeight > 0 && lightHeight <= 640 * 2 + 1,
            `expected a non-empty screenshot within the 640px panel limit; PNG=${lightWidth}x${lightHeight}, panel=${bounds.width}x${bounds.height}`,
          );

          const lightBackground = await body.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          );
          const lightText = await body.evaluate((element) => getComputedStyle(element).color);
          const lightCardSurfaces = await panel
            .locator(".hb-time-latest, .hb-time-next")
            .evaluateAll((cards) => cards.map((card) => getComputedStyle(card).backgroundColor));
          assert.equal(lightCardSurfaces.length, 2);
          assert.equal(lightCardSurfaces[0], lightCardSurfaces[1]);
          const wrapperStyle = await timeSection.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              background: style.backgroundColor,
              padding: [
                style.paddingTop,
                style.paddingRight,
                style.paddingBottom,
                style.paddingLeft,
              ],
            };
          });
          assert.equal(wrapperStyle.background, "rgba(0, 0, 0, 0)");
          assert.deepEqual(wrapperStyle.padding, ["0px", "0px", "0px", "0px"]);
          assert.equal(await panel.locator(".panel-head .hb-status").count(), 0);
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
          await body.screenshot({ path: ".playwright-img/heartbeat-time-cards-dark.png" });
          const darkCardSurfaces = await panel
            .locator(".hb-time-latest, .hb-time-next")
            .evaluateAll((cards) => cards.map((card) => getComputedStyle(card).backgroundColor));
          assert.equal(darkCardSurfaces.length, 2);
          assert.equal(darkCardSurfaces[0], darkCardSurfaces[1]);
          assert.notEqual(
            darkCardSurfaces[0],
            lightCardSurfaces[0],
            "card surfaces follow the host dark theme",
          );
          await page.evaluate(() => document.documentElement.classList.remove("dark"));
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );

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

          for (const width of [438, 360]) {
            await page.setViewportSize({ width, height: 420 });
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            const viewport = await page.evaluate(() => ({
              viewport: document.documentElement.clientWidth,
              document: document.documentElement.scrollWidth,
            }));
            const layout = await panel
              .locator(".hb-time-latest, .hb-time-next")
              .evaluateAll((cards) => {
                const rectangles = cards.map((card) => card.getBoundingClientRect());
                return {
                  count: cards.length,
                  gap: rectangles.length === 2 ? rectangles[1].left - rectangles[0].right : null,
                  widths: rectangles.map((rect) => rect.width),
                  tops: rectangles.map((rect) => rect.top),
                  borders: cards.map((card) => getComputedStyle(card).borderTopWidth),
                  heights: rectangles.map((rect) => rect.height),
                  radii: cards.map((card) => getComputedStyle(card).borderTopLeftRadius),
                };
              });
            assert.equal(layout.count, 2, "both time cards are present");
            assert.ok(
              viewport.document <= viewport.viewport,
              `no horizontal overflow at ${width}px`,
            );
            assert.equal(
              await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth),
              true,
            );
            assert.equal(layout.tops[0], layout.tops[1], `cards stay side by side at ${width}px`);
            assert.ok(
              Math.abs(layout.gap - 12) <= 1,
              `cards have a visible 12px gap at ${width}px`,
            );
            assert.ok(Math.abs(layout.widths[0] - layout.widths[1]) <= 1);
            assert.deepEqual(layout.borders, ["1px", "1px"], "cards have separate outlines");
            assert.deepEqual(layout.radii, ["16px", "16px"]);
            assert.ok(layout.heights.every((height) => height >= 118));
          }
          await page.evaluate(() => {
            document.documentElement.dir = "rtl";
          });
          await page.setViewportSize({ width: 360, height: 420 });
          const rtlViewport = await page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
          }));
          const rtlCards = await panel
            .locator(".hb-time-latest, .hb-time-next")
            .evaluateAll((cards) =>
              cards.map((card) => {
                const rect = card.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top };
              }),
            );
          assert.equal(rtlCards.length, 2);
          assert.ok(
            rtlViewport.document <= rtlViewport.viewport,
            "RTL layout has no horizontal overflow",
          );
          assert.equal(
            await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          assert.equal(rtlCards[0].top, rtlCards[1].top);
          assert.ok(rtlCards[0].left > rtlCards[1].left, "RTL follows reading order");
          assert.ok(Math.abs(rtlCards[0].left - rtlCards[1].right - 12) <= 1);
          await page.evaluate(() => {
            document.documentElement.dir = "ltr";
          });
          await page.setViewportSize({ width: 360, height: 420 });
          await panel.locator(".hb-time-latest").waitFor();
          await timeSection.screenshot({
            path: ".playwright-img/heartbeat-time-cards-narrow.png",
          });
          await page.setViewportSize({ width: 319, height: 420 });
          const stacked = await panel
            .locator(".hb-time-latest, .hb-time-next")
            .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().top));
          assert.equal(stacked.length, 2);
          assert.ok(stacked[1] > stacked[0], "cards stack only below 320px");
          await page.setViewportSize({ width: 320, height: 380 });
          const threshold = await panel
            .locator(".hb-time-latest, .hb-time-next")
            .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().top));
          assert.equal(threshold.length, 2);
          assert.equal(threshold[0], threshold[1], "cards stay side by side at 320px");
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
            .screenshot({ path: ".playwright-img/heartbeat-orchestration-narrow.png" });

          for (const direction of ["ltr", "rtl"]) {
            await panel.evaluate((element, dir) => {
              element.dir = dir;
            }, direction);
            assert.equal(
              await firstWake.evaluate((wake) => wake.scrollWidth <= wake.clientWidth),
              true,
            );
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
          }
          await panel.evaluate((element) => {
            element.dir = "";
          });

          assert.equal(await panel.locator(".hb-source").count(), 0);
          const heartbeatTab = panel.getByRole("button", { name: "心跳", exact: true });
          await heartbeatTab.focus();
          await heartbeatTab.press("Escape");
          assert.equal(await panel.locator(".body").isVisible(), true);
          assert.equal(
            await panel.evaluate(
              (element) =>
                element.shadowRoot.activeElement ===
                element.shadowRoot.querySelector(".heartbeat-trigger"),
            ),
            true,
            "Escape keeps keyboard focus in the persistent panel controls",
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
        const assertNoHeaderStatus = async () => {
          assert.equal(
            await panel.locator(".panel-head .hb-status").count(),
            0,
            "Heartbeat header shows no certification or status badge",
          );
        };
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "candidates", sourcePath: null };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await assertNoHeaderStatus();
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
        await assertNoHeaderStatus();
        assert.equal(
          await panel.getByRole("heading", { name: "项目心跳", exact: true }).count(),
          1,
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
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-alert").count(), 0);
        assert.equal(await panel.locator(".hb-items").count(), 0);
        assert.ok((await panel.locator(".hb-wake").count()) > 0);
        assert.equal(await panel.locator(".hb-source").count(), 0);
        assert.match(await panel.locator(".hb-time-card").innerText(), /最近记录/);
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
        await assertNoHeaderStatus();
        assert.match(await panel.locator(".hb-alert").innerText(), /Ledger format invalid/);
        assert.doesNotMatch(
          await panel
            .locator(".hb-alert, .hb-source")
            .allInnerTexts()
            .then((texts) => texts.join(" ")),
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
            warning: "Ledger warning: signature mismatch.",
            findings: [
              { severity: "error", rule: "ledger-format", message: "Ledger format invalid" },
            ],
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await assertNoHeaderStatus();
        assert.match(
          await panel.locator(".hb-alert").innerText(),
          /Ledger warning: signature mismatch/,
        );
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
        await assertNoHeaderStatus();
        assert.match(await panel.locator(".hb-time-card").innerText(), /最近记录/);
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
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-time-next").getAttribute("data-missing"), "true");
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
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-time-next").getAttribute("data-missing"), "false");
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "stale", certifiesCurrent: true };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await assertNoHeaderStatus();
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "ready" };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-source").count(), 0);
        assert.match(await panel.locator("section.panel").innerText(), /只读/);
        assert.match(await panel.locator(".hb-time-card").innerText(), /最近记录/);
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /latest-recorded-wake|items-inventory/,
        );
        assert.equal(await panel.locator(".hb-time-latest strong").count(), 1);
        assert.equal(await panel.locator(".hb-items").count(), 0);
        await panel.locator(".hb-history").waitFor();
        await panel.locator(".hb-wake > summary").first().waitFor();
        await page.evaluate(() => {
          window.fixture.heartbeat.status = "stale";
          window.fixture.heartbeat.error = "台账文件已删除";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-time-card").count(), 1);
        assert.ok((await panel.locator(".hb-wake").count()) > 0);
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
        await page.evaluate((value) => {
          window.fixture.heartbeatPending = true;
          window.fixture.heartbeat = {
            ...value,
            status: "pending",
            retryable: true,
            sourcePath: "/workspace/heartbeat.md",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await assertNoHeaderStatus();
        assert.equal(await panel.locator(".hb-time-card").count(), 1);
        assert.ok((await panel.locator(".hb-wake").count()) > 0);
        assert.doesNotMatch(
          await panel.locator(".scroll").innerText(),
          /正在刷新项目心跳|Refreshing the project heartbeat|心跳历史正在刷新|Heartbeat history is refreshing/,
        );
        await page.evaluate((value) => {
          window.fixture.heartbeatPending = false;
          window.fixture.heartbeat = {
            ...value,
            status: "error",
            sourcePath: "/workspace/heartbeat.md",
            error: "heartbeat source reader failed",
            retryable: false,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await assertNoHeaderStatus();
        await panel
          .locator(".scroll .diagnostic-text")
          .filter({ hasText: "heartbeat source reader failed" })
          .waitFor();
        await context.close();
      },
    );
    await t.test(
      "orchestration snapshots show scoped agent flow and Owner actions without audit categories",
      async () => {
        const { context, page, panel } = await open("", { locale: "en-US" });
        const categories = [
          "goal-derived remaining",
          "read-only review",
          "temporary status",
          "knowledge artifacts",
          "tooling fixes",
          "release prep",
          "worker follow-ups",
          "centralized verification",
          "session hygiene",
          "deployable-unit drift",
        ];
        await page.evaluate(
          ({ value, categories }) => {
            window.fixture.heartbeat = { ...value, items: [{ item: "hidden registry entry" }] };
            window.fixture.heartbeatHistory = {
              sourcePath: value.sourcePath,
              total: 5,
              nextCursor: null,
              wakes: [
                {
                  heading: "current snapshot",
                  rows: categories.map((category) => ({ category, state: "hidden row" })),
                  orchestration: {
                    scope: "Import task only",
                    before: { activeAgents: 2 },
                    after: { activeAgents: 4 },
                    blockedTaskCount: 25,
                    ownerInterventionCount: 1,
                    requiresOwner: true,
                    blockedTasks: [
                      {
                        id: "a",
                        title: "Needs decision",
                        reason: "Choose a policy",
                        requiresOwner: true,
                      },
                      {
                        id: "b",
                        title: "Waiting for fix",
                        reason: "Dependency failed",
                        requiresOwner: false,
                      },
                    ],
                    truncated: true,
                  },
                },
                {
                  heading: "zero snapshot",
                  orchestration: {
                    before: { activeAgents: 0 },
                    after: { activeAgents: 0 },
                    blockedTaskCount: 0,
                    ownerInterventionCount: 0,
                    requiresOwner: false,
                    blockedTasks: [],
                    truncated: false,
                  },
                },
                { heading: "legacy snapshot", rows: [] },
                {
                  heading: "invalid snapshot",
                  orchestration: null,
                  orchestrationError: "invalid or duplicate metadata",
                },
                {
                  heading: "unknown snapshot",
                  orchestration: {
                    before: null,
                    after: null,
                    blockedTaskCount: 1,
                    ownerInterventionCount: 0,
                    requiresOwner: null,
                    blockedTasks: [
                      {
                        id: "unknown",
                        title: "Needs classification",
                        reason: "Unclear",
                        requiresOwner: null,
                      },
                    ],
                    truncated: false,
                  },
                },
              ],
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { value: heartbeat, categories },
        );
        await panel.getByRole("button", { name: "Heartbeat", exact: true }).click();
        const wakes = panel.locator(".hb-wake");
        await wakes.first().getByText("Needs decision").waitFor();
        const text = await wakes.first().innerText();
        assert.match(text, /Active child agents\s*2 → 4/i);
        assert.match(text, /Import task only/);
        assert.match(text, /Choose a policy/);
        assert.match(text, /Waiting for fix[\s\S]*Requires Owner: No/);
        assert.match(text, /Owner intervention required\s*Yes/);
        assert.match(text, /Confirmed Owner actions\s*1/);
        assert.match(text, /Showing 2 \/ 25 blocked tasks/);
        assert.doesNotMatch(
          await panel.locator(".heartbeat").innerText(),
          /hidden registry entry|hidden row|Items and blockers|Show \d+ more/,
        );
        for (const category of categories) assert.equal(text.includes(category), false);
        await mkdir(".playwright-img", { recursive: true });
        await wakes.first().scrollIntoViewIfNeeded();
        await panel.locator(".body").screenshot({
          path: ".playwright-img/heartbeat-orchestration-metrics.png",
        });
        await wakes.nth(1).locator(":scope > summary").click();
        assert.match(await wakes.nth(1).innerText(), /Blocked tasks\s*0/);
        assert.match(await wakes.nth(1).innerText(), /Owner intervention required\s*No/);
        await wakes.nth(2).locator(":scope > summary").click();
        assert.match(await wakes.nth(2).innerText(), /orchestration snapshot not recorded/i);
        await wakes.nth(3).locator(":scope > summary").click();
        assert.match(
          await wakes.nth(3).innerText(),
          /Invalid orchestration snapshot; metrics not recorded/,
        );
        assert.doesNotMatch(
          await wakes.nth(3).innerText(),
          /Legacy record|invalid or duplicate metadata|Owner intervention required|\b0\b/,
        );
        await wakes.nth(4).locator(":scope > summary").click();
        assert.match(await wakes.nth(4).innerText(), /Owner intervention required\s*Not recorded/);
        assert.match(await wakes.nth(4).innerText(), /Confirmed Owner actions\s*0/);
        assert.match(await wakes.nth(4).innerText(), /Requires Owner: Not recorded/);
        assert.match(
          await wakes.nth(4).innerText(),
          /Active child agents\s*Not recorded → Not recorded/,
        );
        for (const direction of ["ltr", "rtl"]) {
          await page.setViewportSize({ width: 320, height: 380 });
          await panel.evaluate((element, dir) => {
            element.dir = dir;
          }, direction);
          const geometry = await wakes.first().evaluate((wake) => {
            const body = wake.querySelector(".hb-wake-body");
            const cards = [...body.querySelectorAll(":scope > .hb-record")];
            return {
              gaps: cards
                .slice(1)
                .map(
                  (card, i) =>
                    card.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom,
                ),
              overflow: body.scrollWidth > body.clientWidth,
            };
          });
          assert.deepEqual(geometry.gaps, [10]);
          assert.equal(geometry.overflow, false);
        }
        await context.close();
      },
    );
    await t.test(
      "local retryable history recovers on bounded base updates and terminal failures stay manual",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.task = value;
          window.fixture.history = {
            events: [{ reason: "verified local event" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await showView(panel, "history");
        await panel.getByText("verified local event", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.history = {
            events: [],
            nextCursor: null,
            source: { kind: "kit-heartbeat", path: null, readOnly: true, retryable: true },
          };
        });
        await panel.getByRole("button", { name: "刷新", exact: true }).click();
        await panel.getByText(/历史记录正在刷新/).waitFor();
        assert.equal(await panel.getByText("verified local event", { exact: true }).count(), 1);
        const count = () =>
          page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "history").length,
          );
        const firstCount = await count();
        await panel.evaluate(async (element) => {
          element.requestUpdate();
          await element.updateComplete;
          element.requestUpdate();
          await element.updateComplete;
        });
        assert.equal(await count(), firstCount, "unrelated renders must not retry");
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        await page.waitForFunction(
          (n) => window.fixture.calls.filter((call) => call.method === "history").length === n + 1,
          firstCount,
        );
        await panel
          .getByRole("button", { name: "刷新", exact: true })
          .waitFor({ state: "visible" });
        await page.waitForFunction(() => !document.querySelector("codex-task-panel").busy);
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        await page.waitForFunction(
          (n) => window.fixture.calls.filter((call) => call.method === "history").length === n + 2,
          firstCount,
        );
        await page.waitForFunction(() => !document.querySelector("codex-task-panel").busy);
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(await count(), firstCount + 2, "automatic retries are capped per context");
        await page.evaluate(() => {
          window.fixture.history = {
            events: [{ reason: "recovered local event" }],
            nextCursor: null,
          };
        });
        await panel.getByRole("button", { name: "刷新", exact: true }).click();
        await panel.getByText("recovered local event", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.historyFailureNext = "terminal history error";
        });
        await panel.getByRole("button", { name: "刷新", exact: true }).click();
        await panel.getByText(/terminal history error/).waitFor();
        const afterError = await count();
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(
          await count(),
          afterError,
          "terminal failures do not trigger automatic retries",
        );
        await context.close();
      },
    );
    await t.test(
      "retryable history pages retain verified records until a later refresh",
      async () => {
        const { context, page, panel } = await open("", { reducedMotion: "reduce" });
        const sourcePath = "/workspace/heartbeat.md";
        await page.evaluate(
          ({ value, sourcePath }) => {
            window.fixture.heartbeat = { ...value, sourcePath, contentHash: "stable" };
            window.fixture.heartbeatHistory = {
              sourcePath,
              contentHash: "stable",
              total: 1,
              nextCursor: null,
              wakes: [{ heading: "verified wake", rows: [] }],
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { value: heartbeat, sourcePath },
        );
        await showView(panel, "heartbeat");
        await panel
          .locator(".hb-wake > summary")
          .getByText("verified wake", { exact: true })
          .waitFor();
        const getCardRects = async () =>
          panel.evaluate((element) =>
            [".hb-time-card", ".hb-history"].map((selector) => {
              const rect = element.shadowRoot.querySelector(selector).getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
          );
        const readyCardRects = await getCardRects();
        await page.evaluate(() => {
          window.fixture.heartbeatHistory = {
            retryable: true,
            sourcePath: null,
            total: 0,
            nextCursor: null,
            wakes: [],
          };
        });
        const historyCallsBeforeRetry = await page.evaluate(
          () => window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
        );
        await panel.getByRole("button", { name: "刷新心跳历史" }).click();
        await page.waitForFunction(() => {
          const button = document
            .querySelector("codex-task-panel")
            ?.shadowRoot?.querySelector(".panel-refresh");
          return button && !button.disabled && button.getAttribute("aria-busy") === "false";
        });
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "heartbeat-history").length,
          ),
          historyCallsBeforeRetry + 1,
        );
        assert.doesNotMatch(
          await panel.locator(".scroll").innerText(),
          /心跳历史正在刷新|Heartbeat history is refreshing/,
        );
        assert.equal(
          await panel
            .locator(".hb-wake > summary")
            .getByText("verified wake", { exact: true })
            .count(),
          1,
        );
        assert.equal(await panel.locator(".hb-history .info-card-error").count(), 0);
        assert.deepEqual(await getCardRects(), readyCardRects);
        await page.evaluate(
          ({ sourcePath }) => {
            window.fixture.heartbeatHistory = {
              sourcePath,
              contentHash: "stable",
              total: 1,
              nextCursor: null,
              wakes: [{ heading: "recovered wake", rows: [] }],
            };
          },
          { sourcePath },
        );
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        await panel
          .locator(".hb-wake > summary")
          .getByText("recovered wake", { exact: true })
          .waitFor();
        assert.equal(
          await panel
            .locator(".hb-wake > summary")
            .getByText("verified wake", { exact: true })
            .count(),
          0,
        );
        await page.evaluate(
          ({ value, sourcePath }) => {
            window.fixture.task = {
              ...value,
              source: {
                kind: "kit-heartbeat",
                path: sourcePath,
                contentHash: "stable",
                readOnly: true,
              },
            };
            window.fixture.history = {
              events: [],
              wakes: [{ heading: "verified bound wake", rows: [] }],
              total: 1,
              nextCursor: null,
              source: {
                kind: "kit-heartbeat",
                path: sourcePath,
                contentHash: "stable",
                readOnly: true,
              },
            };
            return window.__CODEX_TASK_PROGRESS__.refresh();
          },
          { value: task, sourcePath },
        );
        await showView(panel, "history");
        await panel.getByText("verified bound wake", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.history = {
            events: [],
            wakes: [],
            total: 0,
            nextCursor: null,
            source: { kind: "kit-heartbeat", path: null, readOnly: true, retryable: true },
          };
        });
        await panel.getByRole("button", { name: "刷新台账历史" }).click();
        await panel.getByText(/台账历史正在刷新/).waitFor();
        assert.equal(await panel.getByText("verified bound wake", { exact: true }).count(), 1);
        assert.equal(await panel.locator(".info-card-error").count(), 0);
        await page.evaluate(
          ({ sourcePath }) => {
            window.fixture.history = {
              events: [],
              wakes: [{ heading: "recovered bound wake", rows: [] }],
              total: 1,
              nextCursor: null,
              source: {
                kind: "kit-heartbeat",
                path: sourcePath,
                contentHash: "stable",
                readOnly: true,
              },
            };
          },
          { sourcePath },
        );
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        await panel.getByText("recovered bound wake", { exact: true }).waitFor();
        await context.close();
      },
    );
    await t.test(
      "large heartbeat history retains item and history totals with paging",
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
        assert.equal(await panel.locator(".hb-items").count(), 0);
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
      await panel.locator(".summary .main").click();
      await page.reload();
      await panel.locator(".summary .main").waitFor();
      await page.evaluate((value) => {
        window.fixture.task = value;
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, task);
      assert.match(await panel.locator("section.panel").innerText(), /普通聊天界面/);
      assert.equal(await panel.locator(".summary .main").getAttribute("aria-expanded"), "true");
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
      });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      const nativeColors = await panel.locator(".body").evaluate((element) => {
        const style = getComputedStyle(element);
        return { foreground: style.color, surface: style.backgroundColor };
      });
      assert.ok(nativeColors.foreground, "panel has a computed foreground");
      assert.ok(nativeColors.surface, "panel has a computed surface");
      assert.equal(await panel.locator(".summary .main").getAttribute("aria-expanded"), "true");
      await context.close();
    });
  } finally {
    await Promise.allSettled([...contexts].map((context) => context.close()));
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
