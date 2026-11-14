import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const fixture = `<!doctype html><html lang="zh-CN"><head><style>
body{font:14px system-ui;margin:0;background:#f5f5f5}aside{position:absolute;left:0;top:0}
main{margin:44px auto 0;width:min(700px,calc(100vw - 32px));height:calc(100vh - 44px);position:relative;display:flex;flex-direction:column}
#layout{height:100%;width:100%}#content{height:100%;width:100%;display:flex;flex-direction:column}
#messages{flex:1;min-height:0;overflow:auto}#composer{width:100%;height:100px;flex-shrink:0;background:white;border:1px solid #ccc;margin-bottom:20px;box-sizing:border-box}[role=textbox]{height:80px}
</style></head><body>
<aside><div data-app-action-sidebar-thread-row aria-current="page" data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="thread-a"></div></aside>
<main data-app-shell-page-surface><div id="layout" data-app-shell-main-content-layout="thread-edge-scroll"><div id="content"><div id="messages">Conversation remains below the task panel.</div><div id="composer" data-codex-composer-root><div role="textbox" contenteditable="true"></div></div></div></main>
<script>
window.fixture = {delay:Number(new URL(location.href).searchParams.get("initialDelay") || 0),getFailureNext:new URL(location.href).searchParams.get("initialGetFailure"),holdNextGetFailure:false,releaseHeldGetFailure:null,holdNextGetSuccess:false,releaseHeldGetSuccess:null,getFailureThrownCount:0,fixtureEvents:[],delayNextHistory:0,holdNextHistoryFailure:false,releaseHeldHistoryFailure:null,historyFailureNext:null,heartbeatHistoryFailureNext:null,holdNextHeartbeatHistory:false,releaseHeldHeartbeatHistory:null,heartbeatHistoryResponses:[],heartbeatPending:false,task:null, taskSource:null, heartbeat:null, execution:{state:"unknown",observedAt:"2026-11-11T12:00:00Z",source:"codex-app-server"}, history:{events:[],nextCursor:null}, heartbeatHistory:null, calls:[],disabled:new URL(location.href).searchParams.get("disabled")==="true"};
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  const fixtureRequestId = window.fixture.fixtureEvents.length + 1;
  window.fixture.fixtureEvents.push({type:'request',id:fixtureRequestId,method:request.method,threadId:request.threadId,at:performance.now()});
  if(request.method==='get' && window.fixture.getFailureNext) { const message=window.fixture.getFailureNext; window.fixture.getFailureNext=null; if(window.fixture.holdNextGetFailure) { window.fixture.holdNextGetFailure=false; await new Promise(resolve => { window.fixture.releaseHeldGetFailure=resolve; }); window.fixture.releaseHeldGetFailure=null; } window.fixture.getFailureThrownCount++; window.fixture.fixtureEvents.push({type:'response',id:fixtureRequestId,method:request.method,threadId:request.threadId,outcome:'error',at:performance.now()}); throw new Error(message); }
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.task,taskSource:window.fixture.taskSource,heartbeat:window.fixture.heartbeat,heartbeatPending:window.fixture.heartbeatPending,execution:window.fixture.execution,...(window.fixture.disabled?{enabled:false}:{}),...(request.method==='history'?{history:window.fixture.history}:{}),...(request.method==='heartbeat-history'?{heartbeatHistory:window.fixture.heartbeatHistory}:{})};
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
// Matches the desktop app's empty-chat topology: outer page includes the titlebar;
// the verified content viewport begins below it, even before a durable thread exists.
const emptyFixture = `<!doctype html><html lang="zh-CN"><head><style>
body{font:14px system-ui;margin:0;background:#f5f5f5}*{box-sizing:border-box}
#appframe{height:100vh;display:flex;flex-direction:column;width:100%;position:relative}
#toolbar{height:44px;flex-shrink:0;background:#ddd}
#main-region{display:flex;flex-direction:column;min-height:0;flex:1;margin-left:200px;width:calc(100% - 200px)}
#layout{display:flex;flex:1;min-height:0;position:relative;overflow:hidden;width:100%}
#content{display:flex;flex-direction:column;flex:1;min-height:0;width:100%}
#messages{flex:1;min-height:0;overflow:auto}#composer{width:calc(100% - 48px);max-width:700px;height:100px;flex-shrink:0;margin:0 auto 20px;background:white;border:1px solid #ccc}[role=textbox]{height:80px}
@media(max-width:600px){#main-region{margin-left:0;width:100%}}
</style></head><body>
<main id="outer-generic-main"><div id="appframe" data-app-shell-page-surface>
<header id="toolbar" data-app-shell-titlebar>Codex toolbar remains unobscured</header>
<main id="main-region" data-app-shell-main-surface="default"><div id="layout" data-app-shell-main-content-layout="default"><div id="content"><div id="messages">Empty chat content</div><div id="composer" data-codex-composer-root><div role="textbox" contenteditable="true"></div></div></div></main>
</div></main>
<aside><div id="active-thread" data-app-action-sidebar-thread-row aria-current="page" data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="client-new-thread:placeholder"></div></aside>
<div id="cached-page" data-app-shell-page-surface hidden><div data-app-shell-main-content-layout="thread-edge-scroll"><div data-codex-composer-root><div role="textbox"></div></div></div></div>
${fixture.slice(fixture.indexOf("<script>"))}`;
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

test("ordinary chat task panel browser flows", async (t) => {
  const result = await build({
    entryPoints: ["packages/codex-adapter/src/browser-entry.ts"],
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
    res.end(
      req.url === "/bundle.js" ? bundle : req.url?.startsWith("/empty") ? emptyFixture : fixture,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
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
      ...contextOptions,
    });
    contexts.add(context);
    const page = await context.newPage();
    await page.goto(`${url}${query}`);
    await page.locator("codex-task-panel").waitFor({ state: "visible" });
    return { context, page, panel: page.locator("codex-task-panel") };
  };
  try {
    await t.test(
      "health reports only the owned ordinary task panel without a native Goal",
      async () => {
        const { context, page } = await open();
        try {
          await page.evaluate(async (value) => {
            window.fixture.task = value;
            await window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);
          assert.equal(
            await page.locator('[role="textbox"]').getAttribute("data-codex-composer"),
            null,
            "the current Codex textbox no longer needs the legacy marker",
          );
          const health = await page.evaluate(() => window.__CODEX_GOAL_PROGRESS__.health());
          assert.equal(health.reason, "not-configured");
          assert.equal(health.hostCount, 0);
          assert.equal(health.taskPanel.status, "connected");
          assert.equal(health.taskPanel.threadId, "thread-a");
          assert.equal(health.taskPanel.threadMatched, true);
          assert.equal(health.taskPanel.revision, 1);
          assert.equal(health.taskPanel.connected, true);
          assert.equal(health.taskPanel.visible, true);
          assert.equal(health.taskPanel.count, 1);
          assert.ok(health.taskPanel.bounds.width > 0 && health.taskPanel.bounds.height > 0);
          await page.evaluate(async () => {
            window.fixture.getFailureNext = "GOAL_PROGRESS_CDP_PROCESS_LOOKUP_FAILED";
            await window.__CODEX_TASK_PROGRESS__.refresh();
          });
          const failed = await page.evaluate(
            () => window.__CODEX_GOAL_PROGRESS__.health().taskPanel,
          );
          assert.equal(failed.status, "error");
          assert.equal(failed.lastError, "GOAL_PROGRESS_CDP_PROCESS_LOOKUP_FAILED");
          const switched = await page.evaluate(() => {
            document
              .querySelector("[data-app-action-sidebar-thread-id]")
              .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
            return window.__CODEX_GOAL_PROGRESS__.health().taskPanel;
          });
          assert.equal(switched.visible, false);
          assert.equal(switched.threadMatched, false);
          assert.equal(switched.bounds, null);
          await page.waitForFunction(
            () =>
              window.__CODEX_TASK_PROGRESS__.diagnostics().lastError ===
              "TASK_RESPONSE_THREAD_MISMATCH",
          );
          await page.evaluate(() =>
            document
              .querySelector("[data-app-action-sidebar-thread-id]")
              .setAttribute("data-app-action-sidebar-thread-id", "thread-a"),
          );
          const hidden = await page.evaluate(() => {
            document.querySelector("[data-codex-task-panel]").style.display = "none";
            return window.__CODEX_GOAL_PROGRESS__.health().taskPanel;
          });
          assert.equal(hidden.visible, false);
          assert.equal(hidden.bounds, null);
          const destroyed = await page.evaluate(() => {
            window.__CODEX_TASK_PROGRESS__.destroy();
            return window.__CODEX_GOAL_PROGRESS__.health().taskPanel;
          });
          assert.equal(destroyed.connected, false);
          assert.equal(destroyed.visible, false);
          assert.equal(destroyed.count, 0);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      "current composer shape scopes textbox proof and preserves legacy marker support",
      async () => {
        const { context, page, panel } = await open();
        try {
          await page.evaluate((value) => {
            window.fixture.task = value;
            const outside = document.createElement("div");
            outside.setAttribute("role", "textbox");
            document.body.append(outside);
            const hidden = document.createElement("div");
            hidden.setAttribute("role", "textbox");
            hidden.hidden = true;
            document.querySelector("[data-codex-composer-root]").append(hidden);
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);
          await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor();
          let state = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
          assert.equal(state.textboxCount, 1);
          assert.equal(state.rejectionReason, null);
          assert.equal(state.threadId, "thread-a");
          assert.equal(state.visible, true);

          await page
            .locator('[data-codex-composer-root] [role="textbox"]:visible')
            .evaluate((node) => {
              node.setAttribute("data-codex-composer", "");
            });
          await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
          state = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
          assert.equal(state.textboxCount, 1);
          assert.equal(state.rejectionReason, null);
          assert.equal(state.visible, true);
        } finally {
          await context.close();
        }
      },
    );
    await t.test("ambiguous visible textboxes and competing surfaces fail closed", async () => {
      const { context, page } = await open();
      try {
        const ambiguousTextbox = await page.evaluate(() => {
          const second = document.createElement("div");
          second.setAttribute("role", "textbox");
          document.querySelector("[data-codex-composer-root]").append(second);
          return window.__CODEX_TASK_PROGRESS__.diagnostics();
        });
        assert.equal(ambiguousTextbox.textboxCount, 2);
        assert.equal(ambiguousTextbox.rejectionReason, "composer-textbox-ambiguous");
        assert.equal(ambiguousTextbox.visible, false);

        await page
          .locator("[data-codex-composer-root] [role=textbox]")
          .nth(1)
          .evaluate((node) => node.remove());
        const ambiguousSurface = await page.evaluate(() => {
          const surface = document.createElement("main");
          surface.setAttribute("data-app-shell-page-surface", "");
          surface.innerHTML = '<div data-codex-composer-root><div role="textbox"></div></div>';
          document.body.append(surface);
          return window.__CODEX_TASK_PROGRESS__.diagnostics();
        });
        assert.equal(ambiguousSurface.rejectionReason, "composer-root-ambiguous");
        assert.equal(ambiguousSurface.visible, false);
      } finally {
        await context.close();
      }
    });
    await t.test("waiting diagnostics show proof counts and sanitize errors", async () => {
      const { context, page } = await open();
      try {
        await page.evaluate(async () => {
          window.fixture.getFailureNext = "private message containing a path /tmp/secret";
          await window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const error = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
        assert.equal(error.status, "error");
        assert.equal(error.lastError, "TASK_PROGRESS_ERROR");
        const waiting = await page.evaluate(async () => {
          document.querySelector("[data-app-action-sidebar-thread-row]").remove();
          await window.__CODEX_TASK_PROGRESS__.refresh();
          return window.__CODEX_GOAL_PROGRESS__.health().taskPanel;
        });
        assert.equal(waiting.status, "waiting");
        assert.equal(waiting.threadId, null);
        assert.equal(waiting.visible, false);
        assert.equal(waiting.composerCount, 1);
        assert.equal(waiting.textboxCount, 1);
        assert.equal(waiting.threadCandidateCount, 0);
        assert.equal(waiting.rejectionReason, null);
        assert.equal(waiting.threadRejectionReason, "visible-thread-marker-missing");
      } finally {
        await context.close();
      }
    });
    await t.test(
      "disabled project hides panel without stale data; omitted legacy flag stays enabled",
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
        assert.equal(await panel.isVisible(), false);
        await page.evaluate((value) => {
          window.fixture.task = value;
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.equal(await panel.isVisible(), false);
        assert.equal(await panel.getByText("实现普通任务面板", { exact: false }).count(), 0);
        await context.close();
        const legacy = await open();
        assert.equal(await legacy.panel.isVisible(), true);
        await legacy.context.close();
      },
    );
    await t.test(
      "new chat content dock remains below titlebar and ignores hidden cached layouts",
      async () => {
        const { context, page, panel } = await open("/empty");
        const [toolbarBox, layoutBox, composerBox, panelBox, contentBox] = await Promise.all([
          page.locator("#toolbar").boundingBox(),
          page.locator("#layout").boundingBox(),
          page.locator("#composer").boundingBox(),
          panel.boundingBox(),
          page.locator("#content").boundingBox(),
        ]);
        assert.equal((await page.locator("#appframe").boundingBox()).y, 0);
        assert.equal(layoutBox.y, toolbarBox.y + toolbarBox.height);
        assert.ok(Math.abs(panelBox.y - layoutBox.y - 8) < 1);
        assert.ok(panelBox.y >= toolbarBox.y + toolbarBox.height);
        assert.ok(
          Math.abs(panelBox.x + panelBox.width / 2 - composerBox.x - composerBox.width / 2) < 1,
        );
        assert.ok(Math.abs(panelBox.width - Math.min(464, composerBox.width)) < 1);
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
        assert.equal(await page.locator("#appframe").evaluate((node) => node.style.paddingTop), "");
        assert.equal(
          await page.locator("#main-region").evaluate((node) => node.style.paddingTop),
          "",
        );
        assert.equal(
          await page.locator("#cached-page").evaluate((node) => node.style.paddingTop),
          "",
        );
        assert.equal(
          (await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics())).threadId,
          null,
        );
        assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
        await page.evaluate(() => {
          document.querySelector("#active-thread").remove();
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.ok(Math.abs((await panel.boundingBox()).y - layoutBox.y - 8) < 1);
        assert.equal(
          (await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics())).threadId,
          null,
        );
        await context.close();
      },
    );
    await t.test(
      "new chat transition stays centered and fixed when a legacy floating preference exists",
      async () => {
        const { context, page, panel } = await open("/empty");
        await page.evaluate(() => localStorage.setItem("codex-task-progress:floating", "true"));
        await page.reload();
        await panel.locator(".summary .main").waitFor();
        assert.equal(
          await panel.getAttribute("floating"),
          null,
          "legacy floating preference is ignored",
        );
        const initialTop = (await panel.boundingBox()).y;
        await page.evaluate((value) => {
          window.fixture.task = {
            ...value,
            objectives: Array.from({ length: 28 }, (_, index) => ({
              id: `fixed-${index + 1}`,
              title: `固定项目 ${index + 1}`,
              required: true,
              status: "active",
              evidence: [],
              items: [
                {
                  id: `item-${index + 1}`,
                  title: `纵向内容 ${index + 1}`,
                  status: "active",
                  evidence: [],
                },
              ],
            })),
          };
          document
            .querySelector("#layout")
            .setAttribute("data-app-shell-main-content-layout", "thread-edge-scroll");
          document
            .querySelector("#active-thread")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-a");
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor();
        assert.ok(Math.abs((await panel.boundingBox()).y - initialTop) < 1);
        assert.equal(
          (await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics())).threadId,
          "thread-a",
        );
        assert.equal(await page.locator("#appframe").evaluate((node) => node.style.paddingTop), "");
        assert.equal(
          await page.locator("#main-region").evaluate((node) => node.style.paddingTop),
          "",
        );
        await page.setViewportSize({ width: 420, height: 640 });
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        await panel.locator(".summary .main").click();
        await panel.locator(".body").waitFor({ state: "visible" });
        const [panelBox, composerBox, layoutBox] = await Promise.all([
          panel.boundingBox(),
          page.locator("#composer").boundingBox(),
          page.locator("#layout").boundingBox(),
        ]);
        assert.ok(Math.abs(panelBox.y - layoutBox.y - 8) < 1);
        assert.ok(
          Math.abs(panelBox.x + panelBox.width / 2 - composerBox.x - composerBox.width / 2) < 1,
        );
        assert.ok(Math.abs(panelBox.width - Math.min(464, composerBox.width)) < 1);
        assert.equal(await panel.getAttribute("floating"), null);
        assert.equal(await panel.getByRole("button", { name: /浮动面板|固定面板/ }).count(), 0);
        assert.equal(await panel.locator(".grip").count(), 0, "fixed panel has no drag affordance");
        const scroll = panel.locator(".scroll");
        const beforeWheel = await panel.boundingBox();
        await scroll.dispatchEvent("wheel", { deltaX: 240, deltaY: 0 });
        assert.equal(await scroll.evaluate((element) => element.scrollLeft), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(await page.evaluate(() => window.scrollX), 0);
        assert.ok(Math.abs((await panel.boundingBox()).x - beforeWheel.x) < 1);
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        assert.ok(
          await scroll.evaluate((element) => element.scrollTop > 0),
          "vertical scrolling reaches the end of the checklist",
        );
        const [lastRow, scrollBox] = await Promise.all([
          scroll.locator(".row").last().boundingBox(),
          scroll.boundingBox(),
        ]);
        assert.ok(
          lastRow &&
            scrollBox &&
            lastRow.y >= scrollBox.y &&
            lastRow.y + lastRow.height <= scrollBox.y + scrollBox.height,
        );
        assert.ok(
          Number.parseFloat(
            await page.locator("#layout").evaluate((node) => node.style.paddingTop),
          ) > 0,
        );
        await context.close();
      },
    );
    await t.test(
      "verified main-surface fallback never reserves outer app frame or toolbar",
      async () => {
        const { context, page, panel } = await open("/empty");
        await page.evaluate(() => {
          document.querySelector("#layout").removeAttribute("data-app-shell-main-content-layout");
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const [panelBox, regionBox, toolbarBox] = await Promise.all([
          panel.boundingBox(),
          page.locator("#main-region").boundingBox(),
          page.locator("#toolbar").boundingBox(),
        ]);
        assert.ok(Math.abs(panelBox.y - regionBox.y - 8) < 1);
        assert.ok(panelBox.y >= toolbarBox.y + toolbarBox.height);
        assert.equal(await page.locator("#layout").evaluate((node) => node.style.paddingTop), "");
        assert.ok(
          Number.parseFloat(
            await page.locator("#main-region").evaluate((node) => node.style.paddingTop),
          ) > 0,
        );
        assert.equal(await page.locator("#appframe").evaluate((node) => node.style.paddingTop), "");
        assert.equal(
          await page.locator("#outer-generic-main").evaluate((node) => node.style.paddingTop),
          "",
        );
        await context.close();
      },
    );
    await t.test(
      "zoomed content ancestors reserve physical panel height without changing frame",
      async () => {
        const { context, page, panel } = await open("/empty");
        await page.evaluate(() => {
          document.querySelector("#main-region").style.zoom = "0.8";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        const [panelBox, composerBox, layoutBox, contentBox] = await Promise.all([
          panel.boundingBox(),
          page.locator("#composer").boundingBox(),
          page.locator("#layout").boundingBox(),
          page.locator("#content").boundingBox(),
        ]);
        assert.ok(Math.abs(panelBox.y - layoutBox.y - 8) < 1);
        assert.ok(
          Math.abs(panelBox.x + panelBox.width / 2 - composerBox.x - composerBox.width / 2) < 1,
        );
        assert.ok(Math.abs(panelBox.width - Math.min(464, composerBox.width)) < 1);
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
        assert.equal(await page.locator("#appframe").evaluate((node) => node.style.paddingTop), "");
        await context.close();
      },
    );
    await t.test(
      "first task read stays unknown until a response confirms an empty checklist",
      async () => {
        const { context, panel } = await open("?initialDelay=800");
        const header = panel.locator(".summary");
        assert.match(await header.innerText(), /正在读取清单/);
        assert.doesNotMatch(await header.innerText(), /0\/0|尚未建立任务/);
        assert.equal(await header.locator(".percent").textContent(), "");
        assert.match(await header.locator(".main").getAttribute("aria-label"), /正在读取清单/);
        await header.getByText(/尚未建立任务/).waitFor();
        assert.match(await header.innerText(), /已登记清单 0\/0/);
        assert.equal(await header.locator(".percent").textContent(), "");
        assert.match(await header.locator(".main").getAttribute("aria-label"), /已登记清单 0\/0/);
        await context.close();
      },
    );
    await t.test(
      "page host automatically recovers after initial and later transient get failures",
      async () => {
        const { context, page, panel } = await open(
          "?initialGetFailure=temporary%20initial%20bridge%20failure",
        );
        const summary = panel.locator(".summary");
        await summary.getByText(/清单暂不可用/).waitFor();
        assert.match(await summary.innerText(), /清单暂不可用/);
        assert.equal(await summary.locator(".percent").textContent(), "");
        assert.match(await summary.locator(".main").getAttribute("aria-label"), /清单暂不可用/);
        await page.evaluate((value) => {
          window.fixture.task = value;
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor();
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.doesNotMatch(await summary.innerText(), /清单暂不可用/);
        assert.equal(await summary.locator(".percent").textContent(), "50%");
        assert.match(await summary.locator(".main").getAttribute("aria-label"), /清单进度 50%/);

        await page.evaluate(() => {
          window.fixture.getFailureNext = "later poll failure";
        });
        await summary.getByText(/清单暂不可用/).waitFor();
        assert.match(await summary.innerText(), /实现普通任务面板/);
        assert.match(await summary.innerText(), /清单暂不可用/);
        assert.equal(await summary.locator(".percent").textContent(), "");
        assert.match(await summary.locator(".main").getAttribute("aria-label"), /清单暂不可用/);
        await summary.getByText(/实现普通任务面板/).waitFor();
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.doesNotMatch(await summary.innerText(), /清单暂不可用/);
        assert.match(await summary.innerText(), /实现普通任务面板/);
        assert.ok(
          (await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          )) >= 4,
        );
        await context.close();
      },
    );
    await t.test(
      "late failed get from a previous thread cannot poison the selected thread",
      async () => {
        const { context, page, panel } = await open();
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        await page.evaluate(() => {
          window.fixture.getFailureNext = "late thread-a get failure";
          window.fixture.holdNextGetFailure = true;
          void window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page.waitForFunction(
          () => typeof window.fixture.releaseHeldGetFailure === "function",
        );
        const heldGetCount = await page.evaluate(
          () => window.fixture.calls.filter((call) => call.method === "get").length,
        );
        await page.evaluate(() => void window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(
          await page.evaluate(
            () => window.fixture.calls.filter((call) => call.method === "get").length,
          ),
          heldGetCount,
          "an in-flight get is not overlapped by a second refresh",
        );
        await page.evaluate(() => {
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
          window.fixture.task = null;
        });
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().threadId === "thread-b",
        );
        await page.evaluate(() => window.fixture.releaseHeldGetFailure());
        await page.waitForFunction(() => window.fixture.getFailureThrownCount === 1);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const state = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
        assert.equal(state.threadId, "thread-b");
        assert.notEqual(state.status, "error");
        assert.equal(state.lastError, null);
        assert.equal(await panel.evaluate((element) => element.connectionError), null);
        await page.waitForFunction(
          () =>
            window.__CODEX_TASK_PROGRESS__.diagnostics().threadId === "thread-b" &&
            window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.equal(await panel.evaluate((element) => element.connectionError), null);
        await context.close();
      },
    );
    await t.test(
      "generation-aware refresh renders B before held A and ignores A after an A to B to A switch",
      async () => {
        const { context, page, panel } = await open();
        try {
          await page.waitForFunction(
            () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
            null,
            { timeout: 6000 },
          );
          const initialACount = await page.evaluate(
            () =>
              window.fixture.calls.filter(
                (call) => call.method === "get" && call.threadId === "thread-a",
              ).length,
          );
          const oldA = { ...task, title: "旧 A 延迟任务", revision: 11 };
          const taskB = { ...task, threadId: "thread-b", title: "B 当前任务", revision: 20 };
          const latestA = { ...task, title: "最新 A 任务", revision: 21 };
          await page.evaluate((value) => {
            window.fixture.task = value;
            window.fixture.holdNextGetSuccess = true;
            void window.__CODEX_TASK_PROGRESS__.refresh();
          }, oldA);
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldGetSuccess === "function",
            null,
            { timeout: 6000 },
          );
          const heldA = await page.evaluate(() =>
            window.fixture.fixtureEvents
              .filter(
                (event) =>
                  event.type === "request" &&
                  event.method === "get" &&
                  event.threadId === "thread-a",
              )
              .at(-1),
          );

          const switchAt = await page.evaluate((value) => {
            document
              .querySelector("[data-app-action-sidebar-thread-id]")
              .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
            window.fixture.task = value;
            return performance.now();
          }, taskB);
          await page.waitForFunction(
            () =>
              window.fixture.calls.filter(
                (call) => call.method === "get" && call.threadId === "thread-b",
              ).length === 1,
            null,
            { timeout: 6000 },
          );
          await panel.getByRole("button", { name: /B 当前任务/ }).waitFor({ timeout: 6000 });
          const bRenderedAt = await page.evaluate(() => performance.now());
          assert.ok(bRenderedAt - switchAt < 6000, "B is rendered promptly from its own request");
          assert.equal(
            await page.evaluate(() => typeof window.fixture.releaseHeldGetSuccess),
            "function",
            "A remains held while B is visible",
          );
          assert.equal(
            await page.evaluate(
              (id) =>
                window.fixture.fixtureEvents.some(
                  (event) => event.type === "response" && event.id === id,
                ),
              heldA.id,
            ),
            false,
          );

          const backToAAt = await page.evaluate((value) => {
            document
              .querySelector("[data-app-action-sidebar-thread-id]")
              .setAttribute("data-app-action-sidebar-thread-id", "thread-a");
            window.fixture.task = value;
            return performance.now();
          }, latestA);
          await page.waitForFunction(
            (minimum) =>
              window.fixture.calls.filter(
                (call) => call.method === "get" && call.threadId === "thread-a",
              ).length >= minimum,
            initialACount + 2,
            { timeout: 6000 },
          );
          await panel.getByRole("button", { name: /最新 A 任务/ }).waitFor({ timeout: 6000 });
          const latestARenderedAt = await page.evaluate(() => performance.now());
          assert.ok(latestARenderedAt >= backToAAt);
          await page.evaluate(() => window.fixture.releaseHeldGetSuccess());
          await page.waitForFunction(
            (id) =>
              window.fixture.fixtureEvents.some(
                (event) => event.type === "response" && event.id === id,
              ),
            heldA.id,
            { timeout: 6000 },
          );
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.match(await panel.locator("section.panel").innerText(), /最新 A 任务/);
          assert.doesNotMatch(
            await panel.locator("section.panel").innerText(),
            /旧 A 延迟任务|B 当前任务/,
          );
          const afterLateRelease = await page.evaluate(() =>
            window.__CODEX_TASK_PROGRESS__.diagnostics(),
          );
          assert.equal(afterLateRelease.threadId, "thread-a");
          assert.equal(afterLateRelease.lastError, null);
          assert.equal(afterLateRelease.revision, 21);
          assert.equal(afterLateRelease.status, "connected");
          assert.equal(await panel.evaluate((element) => element.connectionError), null);

          const requests = await page.evaluate(() =>
            window.fixture.calls
              .filter((call) => call.method === "get")
              .map((call) => call.threadId),
          );
          assert.deepEqual(requests.slice(initialACount, initialACount + 3), [
            "thread-a",
            "thread-b",
            "thread-a",
          ]);
          const fixtureTrace = await page.evaluate(
            ({ switchAt, bRenderedAt, backToAAt, latestARenderedAt }) => ({
              fixtureOnly: true,
              note: "Browser fixture request and DOM paint timing; not a measurement of app-server or production app speed.",
              switchAt,
              bRenderedAt,
              backToAAt,
              latestARenderedAt,
              events: window.fixture.fixtureEvents,
            }),
            { switchAt, bRenderedAt, backToAAt, latestARenderedAt },
          );
          await mkdir(".playwright-img", { recursive: true });
          await writeFile(
            ".playwright-img/chat-switch-performance.json",
            `${JSON.stringify(fixtureTrace, null, 2)}\n`,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test("held A get errors cannot update B diagnostics after B has rendered", async () => {
      const { context, page, panel } = await open();
      try {
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
          null,
          { timeout: 6000 },
        );
        const errorCountBefore = await page.evaluate(() => window.fixture.getFailureThrownCount);
        const taskB = {
          ...task,
          threadId: "thread-b",
          title: "B survives old error",
          revision: 30,
        };
        await page.evaluate(() => {
          window.fixture.getFailureNext = "late A bridge error";
          window.fixture.holdNextGetFailure = true;
          void window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page.waitForFunction(
          () => typeof window.fixture.releaseHeldGetFailure === "function",
          null,
          { timeout: 6000 },
        );
        const heldA = await page.evaluate(() =>
          window.fixture.fixtureEvents
            .filter(
              (event) =>
                event.type === "request" && event.method === "get" && event.threadId === "thread-a",
            )
            .at(-1),
        );
        await page.evaluate((value) => {
          document
            .querySelector("[data-app-action-sidebar-thread-id]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
          window.fixture.task = value;
        }, taskB);
        await page.waitForFunction(
          () =>
            window.fixture.calls.filter(
              (call) => call.method === "get" && call.threadId === "thread-b",
            ).length === 1,
          null,
          { timeout: 6000 },
        );
        await panel
          .getByRole("button", { name: /B survives old error/ })
          .waitFor({ timeout: 6000 });
        assert.equal(
          await page.evaluate(() => typeof window.fixture.releaseHeldGetFailure),
          "function",
        );
        assert.equal(
          await page.evaluate(
            (id) =>
              window.fixture.fixtureEvents.some(
                (event) => event.type === "response" && event.id === id,
              ),
            heldA.id,
          ),
          false,
        );
        await page.evaluate(() => window.fixture.releaseHeldGetFailure());
        await page.waitForFunction(
          (id) =>
            window.fixture.fixtureEvents.some(
              (event) => event.type === "response" && event.id === id && event.outcome === "error",
            ),
          heldA.id,
          { timeout: 6000 },
        );
        await page.waitForFunction(
          (count) => window.fixture.getFailureThrownCount === count + 1,
          errorCountBefore,
          { timeout: 6000 },
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const diagnostics = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
        assert.equal(diagnostics.threadId, "thread-b");
        assert.equal(diagnostics.status, "connected");
        assert.equal(diagnostics.lastError, null);
        assert.equal(await panel.evaluate((element) => element.connectionError), null);
        assert.match(await panel.locator("section.panel").innerText(), /B survives old error/);
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /late A bridge error/,
        );
      } finally {
        await context.close();
      }
    });
    await t.test(
      "same-generation DOM refreshes coalesce and destroy fences a held response",
      async () => {
        const { context, page, panel } = await open();
        try {
          await page.waitForFunction(
            () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
            null,
            { timeout: 6000 },
          );
          await page.evaluate((value) => {
            window.fixture.task = value;
            return window.__CODEX_TASK_PROGRESS__.refresh();
          }, task);
          await page.waitForFunction(
            () =>
              document.querySelector("codex-task-panel")?.data?.task?.title === "实现普通任务面板",
            null,
            { timeout: 6000 },
          );
          const beforeCount = await page.evaluate(
            () =>
              window.fixture.calls.filter(
                (call) => call.method === "get" && call.threadId === "thread-a",
              ).length,
          );
          await page.evaluate(() => {
            window.fixture.holdNextGetSuccess = true;
            void window.__CODEX_TASK_PROGRESS__.refresh();
          });
          await page.waitForFunction(
            () => typeof window.fixture.releaseHeldGetSuccess === "function",
            null,
            { timeout: 6000 },
          );
          await page.evaluate(() => {
            for (let index = 0; index < 25; index++) {
              const message = document.querySelector("#messages");
              message.textContent = `same-thread-dom-mutation-${index}`;
              message.setAttribute("data-fixture-refresh", String(index));
            }
          });
          await page.waitForTimeout(300);
          const duringPending = await page.evaluate(
            () =>
              window.fixture.calls.filter(
                (call) => call.method === "get" && call.threadId === "thread-a",
              ).length,
          );
          assert.equal(
            duringPending,
            beforeCount + 1,
            "many same-generation DOM refreshes share the pending get",
          );

          const heldId = await page.evaluate(
            () =>
              window.fixture.fixtureEvents
                .filter(
                  (event) =>
                    event.type === "request" &&
                    event.method === "get" &&
                    event.threadId === "thread-a",
                )
                .at(-1).id,
          );
          const beforeDestroy = await page.evaluate(() => {
            window.fixture.panelBeforeDestroy = document.querySelector("codex-task-panel");
            window.fixture.dataBeforeDestroy = window.fixture.panelBeforeDestroy.data;
            window.fixture.diagnosticsBeforeDestroy = window.__CODEX_TASK_PROGRESS__.diagnostics();
            window.__CODEX_TASK_PROGRESS__.destroy();
            return window.fixture.diagnosticsBeforeDestroy;
          });
          assert.equal(await panel.count(), 0);
          await page.evaluate(() => window.fixture.releaseHeldGetSuccess());
          await page.waitForFunction(
            (id) =>
              window.fixture.fixtureEvents.some(
                (event) => event.type === "response" && event.id === id,
              ),
            heldId,
            { timeout: 6000 },
          );
          const afterDestroy = await page.evaluate(() => ({
            dataUnchanged:
              window.fixture.panelBeforeDestroy.data === window.fixture.dataBeforeDestroy,
            connectionError: window.fixture.panelBeforeDestroy.connectionError,
            diagnostics: window.__CODEX_TASK_PROGRESS__.diagnostics(),
          }));
          assert.equal(afterDestroy.dataUnchanged, true);
          assert.equal(afterDestroy.connectionError, null);
          for (const key of ["threadId", "status", "lastError", "revision", "lastRefreshAt"])
            assert.equal(
              afterDestroy.diagnostics[key],
              beforeDestroy[key],
              `destroyed host diagnostics.${key} remain unchanged`,
            );
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
              document
                .querySelector("[data-app-action-sidebar-thread-id]")
                .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
              window.fixture.task = { ...value, threadId: "thread-b", title: "B same project" };
              window.fixture.heartbeatHistory = bHistory;
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
      "empty chat reserves top space and hides heartbeat; identity confirmed",
      async () => {
        const { context, page, panel } = await open();
        assert.match(await panel.locator("section.panel").innerText(), /尚未建立任务/);
        assert.equal(await panel.getByRole("progressbar").count(), 0);
        await panel.getByRole("button", { name: /任务进度/ }).click();
        assert.equal(await panel.getByRole("heading", { name: "心跳", exact: true }).count(), 0);
        const state = await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.diagnostics());
        assert.equal(state.threadId, "thread-a");
        assert.equal(state.status, "connected");
        const [panelBox, composerBox] = await Promise.all([
          panel.boundingBox(),
          page.locator("#composer").boundingBox(),
        ]);
        assert.ok(panelBox.y + panelBox.height <= composerBox.y);
        const [layoutBox, contentBox] = await Promise.all([
          page.locator("#layout").boundingBox(),
          page.locator("#content").boundingBox(),
        ]);
        assert.ok(Math.abs(panelBox.y - layoutBox.y - 8) < 1);
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
        await context.close();
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
          .locator(".scroll details.heartbeat summary")
          .filter({ hasText: "只读 Kit 任务来源" })
          .click();
        await panel.locator(".scroll details.diagnostic summary").click();
        await panel.getByText("台账文件已删除", { exact: true }).waitFor();

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "error",
            readOnly: true,
            error: "Kit source helper unavailable",
          };
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
        });
        await panel
          .locator(".summary")
          .getByText(/只读 Kit 心跳来源/)
          .waitFor();
        const mainButton = panel.locator(".summary .main");
        if ((await mainButton.getAttribute("aria-expanded")) !== "true") await mainButton.click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "true");
        const sourceDetails = panel
          .locator("details.heartbeat")
          .filter({ hasText: "只读 Kit 任务来源" });
        if ((await sourceDetails.getAttribute("open")) === null)
          await sourceDetails.locator("summary").click();
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
        assert.ok((await panel.locator("section.panel").boundingBox()).height < 90);

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
        await scroll
          .locator("details.heartbeat summary")
          .filter({ hasText: "只读 Kit 任务来源" })
          .click();
        await scroll
          .locator("details.diagnostic summary")
          .filter({ hasText: "来源错误详情" })
          .click();
        const sourceDiagnostic = scroll
          .locator("details.diagnostic")
          .filter({ hasText: "来源错误详情" });
        assert.equal(await sourceDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await scroll.locator(".path-value").textContent()).includes(longPath));
        assert.ok((await panel.locator(".body").boundingBox()).height < 500);
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
          .locator("details.diagnostic summary")
          .filter({ hasText: "连接错误详情" });
        await connectionDetails.click();
        const connectionDiagnostic = scroll
          .locator("details.diagnostic")
          .filter({ hasText: "连接错误详情" });
        assert.equal(
          await connectionDiagnostic.locator(".diagnostic-text").textContent(),
          String(new Error(longError)),
        );
        await panel.getByRole("button", { name: "心跳", exact: true }).click();
        assert.equal(await mainButton.getAttribute("aria-expanded"), "false");
        assert.ok((await panel.locator("section.panel").boundingBox()).height < 90);
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
        const projectError = scroll
          .locator("details.diagnostic summary")
          .filter({ hasText: "项目心跳错误" });
        await projectError.waitFor();
        await projectError.click();
        const projectDiagnostic = scroll
          .locator("details.diagnostic")
          .filter({ hasText: "项目心跳错误" });
        assert.equal(await projectDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await panel.locator(".body").boundingBox()).height < 500);

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
          .locator("details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await historyError.waitFor();
        await historyError.click();
        const historyDiagnostic = scroll
          .locator("details.diagnostic")
          .filter({ hasText: "台账历史不可用" });
        assert.equal(await historyDiagnostic.locator(".diagnostic-text").textContent(), longError);
        assert.ok((await panel.locator(".body").boundingBox()).height < 500);

        await panel.getByRole("button", { name: "历史", exact: true }).click();
        await panel.locator(".body").waitFor({ state: "hidden" });
        assert.equal(await panel.locator(".body").isVisible(), false);
        assert.ok((await panel.locator("section.panel").boundingBox()).height < 90);
        await context.close();
      },
    );
    await t.test(
      "capsule hierarchy, independent circles, lazy history and keyboard dismissal",
      async () => {
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
        assert.equal(await panel.locator(".body").isVisible(), false);
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
        await panel.locator(".body").waitFor({ state: "hidden" });
        assert.equal(
          await panel.evaluate((element) =>
            element.shadowRoot.activeElement?.classList.contains("main"),
          ),
          true,
        );
        await panel.evaluate((element) => element.shadowRoot.activeElement?.blur());
        await page.locator("[role=textbox]:visible").focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await panel.evaluate(
            (element) =>
              element.shadowRoot.activeElement ===
              element.shadowRoot.querySelector(".summary .main"),
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
        await panel.locator(".body").waitFor({ state: "hidden" });
        assert.equal(
          await panel.evaluate(
            (element) =>
              element.shadowRoot.activeElement ===
              element.shadowRoot.querySelector(".summary .main"),
          ),
          true,
          "Escape returns focus to the main pill",
        );
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
        await panel.locator(".body").waitFor({ state: "hidden" });
        assert.equal(
          await panel.evaluate((element) =>
            element.shadowRoot.activeElement?.classList.contains("heartbeat-trigger"),
          ),
          true,
        );
        await context.close();
      },
    );
    await t.test(
      "long task and evidence remain bounded in narrow short windows with reduced motion",
      async () => {
        const { context, page, panel } = await open();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 390, height: 400 });
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
        const close = await panel.locator(".close-panel").boundingBox();
        assert.ok(close.x >= 0 && close.x + close.width <= 390);
        assert.ok(close.y >= 0 && close.y + close.height <= 400);
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
              before: { completed: 1, total: 2, percent: 50 },
              after: { completed: 1, total: 3, percent: 33.33 },
            },
          ],
          nextCursor: "1",
        };
        return window.__CODEX_TASK_PROGRESS__.refresh();
      });
      assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "33.33");
      await panel.getByRole("button", { name: "历史", exact: true }).click();
      await panel.getByText("新增验证任务", { exact: true }).waitFor();
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
      const contentBox = await page.locator("#content").boundingBox();
      const panelBox = await panel.boundingBox();
      assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "历史记录不可用" });
        await historyError.waitFor();
        await historyError.click();
        assert.equal(
          await panel
            .locator(".scroll details.diagnostic")
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
          .locator("details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await mismatchDetails.waitFor();
        await mismatchDetails.click();
        assert.match(
          await scroll
            .locator("details.diagnostic")
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await historyError.waitFor();
        await historyError.click();
        assert.match(
          await panel
            .locator(".scroll details.diagnostic")
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await mismatchDetails.waitFor();
        await mismatchDetails.click();
        assert.match(
          await panel
            .locator(".scroll details.diagnostic")
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await unresolvedDetails.waitFor();
        await unresolvedDetails.click();
        assert.equal(
          await panel
            .locator(".scroll details.diagnostic")
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
          .locator(".scroll details.heartbeat summary")
          .filter({ hasText: "只读 Kit 任务来源" })
          .click();
        const sourceError = panel
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "来源错误详情" });
        await sourceError.click();
        assert.equal(
          await panel
            .locator(".scroll details.diagnostic")
            .filter({ hasText: "来源错误详情" })
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "台账历史不可用" });
        await staleDetails.waitFor();
        await staleDetails.click();
        assert.equal(
          await panel
            .locator(".scroll details.diagnostic")
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
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
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
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
          window.fixture.task = null;
          window.fixture.history = {
            events: [{ reason: "thread-b history" }],
            nextCursor: null,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await panel.getByText("thread-b history", { exact: true }).waitFor();
        await page.evaluate(() => {
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-a");
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
      "visible composer Stop and Send controls independently report execution",
      async () => {
        const { context, page, panel } = await open();
        const runtime = panel.locator(".execution");
        await page.evaluate((value) => {
          window.fixture.task = {
            ...value,
            revision: 9,
            progress: { completed: 2, total: 2, percent: 100 },
          };
          const button = document.createElement("button");
          button.id = "runtime-control";
          button.textContent = "Control";
          button.setAttribute("aria-label", "Stop");
          document.querySelector("#composer").append(button);
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, task);
        assert.match(await runtime.innerText(), /当前仍在执行/);
        assert.equal(await panel.evaluate((element) => element.data.execution.source), "codex-ui");
        assert.equal(await panel.getByRole("progressbar").count(), 0);
        for (const label of ["Stop generating", "停止", "停止生成"]) {
          await page
            .locator("#runtime-control")
            .evaluate((button, label) => button.setAttribute("aria-label", label), label);
          await runtime.filter({ hasText: "当前仍在执行" }).waitFor();
        }
        for (const label of ["Send", "Send prompt", "发送", "发送消息"]) {
          await page
            .locator("#runtime-control")
            .evaluate((button, label) => button.setAttribute("aria-label", label), label);
          await runtime.filter({ hasText: "当前空闲" }).waitFor();
        }
        await page
          .locator("#runtime-control")
          .evaluate((button) => button.setAttribute("aria-label", "Envoyer"));
        await runtime.filter({ hasText: "执行状态未知" }).waitFor();
        await page.locator("#runtime-control").evaluate((button) => {
          button.style.display = "none";
          button.setAttribute("aria-label", "Stop");
        });
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.match(await runtime.innerText(), /执行状态未知/);
        await page.evaluate(() => {
          window.fixture.execution.state = "idle";
          const button = document.querySelector("#runtime-control");
          button.style.display = "";
          button.setAttribute("aria-label", "Stop");
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await runtime.innerText(), /当前仍在执行/);
        await page.evaluate(() => {
          window.fixture.execution.state = "waiting";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        assert.match(await runtime.innerText(), /等待输入/);
        await page.evaluate(() => {
          window.fixture.execution.state = "unknown";
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page.evaluate(() => {
          window.fixture.delay = 700;
          void window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page
          .locator("#runtime-control")
          .evaluate((button) => button.setAttribute("aria-label", "Send prompt"));
        await runtime.filter({ hasText: "当前空闲" }).waitFor({ timeout: 600 });
        assert.equal(await page.evaluate(() => window.fixture.task.revision), 9);
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /100%|已完成/);
        await context.close();
      },
    );
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
            window.fixture.task = { ...value.task, phase: "active", progress: { completed: 2, total: 5, percent: 40 }, objectives: value.objectives };
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
        assert.match(await panel.locator(".summary .main").innerText(), /已登记清单 2\/5 · 清单进度 40%/);
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
        assert.match(await panel.locator(".summary .main").innerText(), /已登记清单 2\/6 · 清单进度 33.33%/);
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
          assert.equal(await panel.locator(".hb-alert > summary").count(), 1);
          assert.equal(await panel.locator(".hb-alert > summary").isVisible(), true);
          await panel.locator(".hb-alert > summary").click();
          assert.match(await panel.locator(".hb-alert").innerText(), /旧记录存在校验提示/);
          await panel.locator(".hb-alert > summary").click();
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
            bounds && Math.abs(bounds.width - 464) <= 1,
            `expected a 464px panel, got ${bounds?.width}`,
          );
          assert.ok(
            bounds.height <= 496,
            `expected a panel no taller than 496px, got ${bounds.height}`,
          );
          const light = await body.screenshot({
            path: ".playwright-img/heartbeat-grouped-light.png",
          });
          assert.deepEqual(
            [light.readUInt32BE(16), light.readUInt32BE(20)],
            [928, Math.round(bounds.height * 2)],
          );

          const lightBackground = await body.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          );
          const lightText = await body.evaluate((element) => getComputedStyle(element).color);
          await page.addStyleTag({
            content: `
            html.dark { color: #eee; color-scheme: dark; --color-token-main-surface-primary: #252525; }
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
          await panel.locator(".body").waitFor({ state: "hidden" });
          assert.equal(await panel.locator(".body").isVisible(), false);
          assert.equal(
            await panel.evaluate(
              (element) =>
                element.shadowRoot.activeElement ===
                element.shadowRoot.querySelector(".heartbeat-trigger"),
            ),
            true,
            "Escape closes the panel and returns focus to the heartbeat trigger",
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
        assert.match(await panel.locator(".hb-status").innerText(), /未认证/);
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
          .locator(".scroll details.diagnostic summary")
          .filter({ hasText: "项目心跳错误" });
        await projectError.waitFor();
        await projectError.click();
        assert.equal(
          await panel
            .locator(".scroll details.diagnostic")
            .filter({ hasText: "项目心跳错误" })
            .locator(".diagnostic-text")
            .textContent(),
          "台账文件已删除",
        );
        assert.equal(await panel.getByRole("button", { name: /解除关联并隐藏心跳/ }).count(), 0);
        await context.close();
      },
    );
    await t.test("Goal panel coexistence keeps heartbeat accessible without overlap", async () => {
      const { context, page, panel } = await open();
      await page.evaluate(
        ({ task, heartbeat }) => {
          window.fixture.task = task;
          window.fixture.heartbeat = heartbeat;
          const goal = document.createElement("codex-task-progress");
          goal.id = "goal-fixture";
          goal.style.cssText =
            "display:block;position:fixed;bottom:128px;left:200px;width:700px;height:60px";
          document.body.append(goal);
          return window.__CODEX_TASK_PROGRESS__.refresh();
        },
        { task, heartbeat },
      );
      await showView(panel, "heartbeat");
      await panel.getByRole("heading", { name: "项目心跳", exact: true }).waitFor();
      const [popoverBox, goalBox] = await Promise.all([
        panel.locator(".body").boundingBox(),
        page.locator("#goal-fixture").boundingBox(),
      ]);
      assert.ok(popoverBox.y + popoverBox.height <= goalBox.y);
      const releaseVersion = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ).version;
      const { pageHostVersion } = JSON.parse(
        readFileSync(
          new URL("../packages/contracts/src/page-host-version.json", import.meta.url),
          "utf8",
        ),
      );
      const hotGoalElementName = `codex-task-progress-v${releaseVersion.replaceAll(".", "-")}-p${pageHostVersion}`;
      await page.evaluate((tagName) => {
        const previous = document.querySelector("#goal-fixture");
        const current = document.createElement(tagName);
        current.id = previous.id;
        current.style.cssText = previous.style.cssText;
        previous.replaceWith(current);
        return window.__CODEX_TASK_PROGRESS__.refresh();
      }, hotGoalElementName);
      const [hotPopover, hotGoal] = await Promise.all([
        panel.locator(".body").boundingBox(),
        page.locator("#goal-fixture").boundingBox(),
      ]);
      assert.ok(hotPopover.y + hotPopover.height <= hotGoal.y);
      await mkdir(".playwright-img", { recursive: true });
      await page.screenshot({ path: ".playwright-img/task-panel-preview.png" });
      await panel.locator(".hb-history").waitFor();
      await panel.locator(".hb-wake > summary").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: ".playwright-img/task-panel-heartbeat-history-preview.png" });
      await page.setViewportSize({ width: 420, height: 640 });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      const narrow = await panel.locator(".body").boundingBox();
      const goalNarrow = await page.locator("#goal-fixture").boundingBox();
      assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 420);
      assert.ok(narrow.y >= 0 && narrow.y + narrow.height <= goalNarrow.y);
      await context.close();
    });
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
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
          window.fixture.heartbeat = {
            ...window.fixture.heartbeat,
            sourcePath: "/workspace/thread-b/heartbeat.md",
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        });
        await page.evaluate((value) => {
          document
            .querySelector("[data-app-action-sidebar-thread-row]")
            .setAttribute("data-app-action-sidebar-thread-id", "thread-a");
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
    await t.test(
      "hot bundle updates replace the element and restore layout on destroy",
      async () => {
        const { context, page } = await open();
        const firstName = await page.evaluate(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().elementName,
        );
        await page.addScriptTag({ content: bundle });
        await page.locator("[data-codex-task-panel]").waitFor({ state: "visible" });
        const newName = await page.evaluate(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().elementName,
        );
        assert.notEqual(firstName, newName);
        assert.equal(await page.locator("[data-codex-task-panel]").count(), 1);
        const panelBox = await page.locator("[data-codex-task-panel]").boundingBox();
        const contentBox = await page.locator("#content").boundingBox();
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.destroy());
        assert.equal(
          await page.locator("#layout").evaluate((element) => element.style.paddingTop),
          "",
        );
        assert.equal(
          await page.locator("#layout").evaluate((element) => element.style.boxSizing),
          "",
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
        document
          .querySelector("[data-app-action-sidebar-thread-row]")
          .setAttribute("data-app-action-sidebar-thread-id", "thread-b");
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
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
      });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      assert.equal(
        await panel.evaluate((element) => element.style.getPropertyValue("--ctp-surface")),
        "#252525",
      );
      await context.close();
    });
  } finally {
    await Promise.allSettled([...contexts].map((context) => context.close()));
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
