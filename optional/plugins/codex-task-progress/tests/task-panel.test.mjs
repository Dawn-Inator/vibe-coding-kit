import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
window.fixture = {delay:Number(new URL(location.href).searchParams.get("initialDelay") || 0),getFailureNext:new URL(location.href).searchParams.get("initialGetFailure"),holdNextGetFailure:false,releaseHeldGetFailure:null,getFailureThrownCount:0,delayNextHistory:0,holdNextHistoryFailure:false,releaseHeldHistoryFailure:null,historyFailureNext:null,heartbeatHistoryFailureNext:null,holdNextHeartbeatHistory:false,releaseHeldHeartbeatHistory:null,task:null, taskSource:null, heartbeat:null, execution:{state:"unknown",observedAt:"2026-11-11T12:00:00Z",source:"codex-app-server"}, history:{events:[],nextCursor:null}, heartbeatHistory:null, calls:[],disabled:new URL(location.href).searchParams.get("disabled")==="true"};
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  if(request.method==='get' && window.fixture.getFailureNext) { const message=window.fixture.getFailureNext; window.fixture.getFailureNext=null; if(window.fixture.holdNextGetFailure) { window.fixture.holdNextGetFailure=false; await new Promise(resolve => { window.fixture.releaseHeldGetFailure=resolve; }); window.fixture.releaseHeldGetFailure=null; } window.fixture.getFailureThrownCount++; throw new Error(message); }
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.task,taskSource:window.fixture.taskSource,heartbeat:window.fixture.heartbeat,execution:window.fixture.execution,...(window.fixture.disabled?{enabled:false}:{}),...(request.method==='history'?{history:window.fixture.history}:{}),...(request.method==='heartbeat-history'?{heartbeatHistory:window.fixture.heartbeatHistory}:{})};
  if(request.method==='history' && window.fixture.historyFailureNext) { const message=window.fixture.historyFailureNext; window.fixture.historyFailureNext=null; if(window.fixture.holdNextHistoryFailure) { window.fixture.holdNextHistoryFailure=false; await new Promise(resolve => { window.fixture.releaseHeldHistoryFailure=resolve; }); window.fixture.releaseHeldHistoryFailure=null; } throw new Error(message); }
  if(request.method==='heartbeat-history' && window.fixture.holdNextHeartbeatHistory) { window.fixture.holdNextHeartbeatHistory=false; await new Promise(resolve => { window.fixture.releaseHeldHeartbeatHistory=resolve; }); window.fixture.releaseHeldHeartbeatHistory=null; }
  if(request.method==='heartbeat-history' && window.fixture.heartbeatHistoryFailureNext) { const message=window.fixture.heartbeatHistoryFailureNext; window.fixture.heartbeatHistoryFailureNext=null; throw new Error(message); }
  if(request.method==='history' && window.fixture.delayNextHistory) { const delay=window.fixture.delayNextHistory; window.fixture.delayNextHistory=0; await new Promise(resolve => setTimeout(resolve,delay)); }
  if(window.fixture.delay && request.threadId === 'thread-a') await new Promise(resolve => setTimeout(resolve,window.fixture.delay));
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
  const changePlacement = async (panel, name) => {
    const main = panel.locator(".summary .main");
    if (!(await panel.locator(".body").isVisible())) await main.click();
    const settings = panel.locator(".panel-actions summary").filter({ hasText: "显示设置" });
    if ((await settings.locator("..").getAttribute("open")) === null) await settings.click();
    await panel.getByRole("button", { name, exact: true }).click();
  };
  const open = async (query = "") => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
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

          await page.locator('[data-codex-composer-root] [role="textbox"]').evaluate((node) => {
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
      "new chat transition, resize and floating preserve dock target without stale padding",
      async () => {
        const { context, page, panel } = await open("/empty");
        const initialTop = (await panel.boundingBox()).y;
        await page.evaluate((value) => {
          window.fixture.task = value;
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
        await changePlacement(panel, "浮动面板");
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(await page.locator("#layout").evaluate((node) => node.style.paddingTop), "");
        await changePlacement(panel, "固定面板");
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
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
        await header.getByText(/尚未建立任务/).waitFor();
        assert.match(await header.innerText(), /已登记清单 0\/0/);
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
        await page.evaluate((value) => {
          window.fixture.task = value;
        }, task);
        await panel.getByRole("button", { name: /实现普通任务面板/ }).waitFor();
        await page.waitForFunction(
          () => window.__CODEX_TASK_PROGRESS__.diagnostics().status === "connected",
        );
        assert.doesNotMatch(await summary.innerText(), /清单暂不可用/);

        await page.evaluate(() => {
          window.fixture.getFailureNext = "later poll failure";
        });
        await summary.getByText(/清单暂不可用/).waitFor();
        assert.match(await summary.innerText(), /实现普通任务面板/);
        assert.match(await summary.innerText(), /清单暂不可用/);
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
        await scroll.locator("summary").filter({ hasText: "心跳历史" }).click();
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
        await main.click();
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
    await t.test(
      "subtasks, evidence, progress regression, paginated history, float and dock",
      async () => {
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
        await changePlacement(panel, "浮动面板");
        assert.equal(await panel.getAttribute("floating"), "");
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(
          await page.locator("#layout").evaluate((element) => element.style.paddingTop),
          "",
        );
        await changePlacement(panel, "固定面板");
        assert.equal(await panel.getAttribute("floating"), null);
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        const contentBox = await page.locator("#content").boundingBox();
        const panelBox = await panel.boundingBox();
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
        await context.close();
      },
    );
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
      "automatic project Heartbeat status, stale state, findings, history and source details",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "candidates", sourcePath: null };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await panel
          .locator(".scroll")
          .getByRole("heading", { name: "项目心跳", exact: true })
          .waitFor();
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
        await panel.getByRole("heading", { name: /项目心跳 当前未认证/ }).waitFor();
        await panel.locator("summary").filter({ hasText: "来源与诊断" }).click();
        assert.match(await panel.locator("section.panel").innerText(), /只读/);
        assert.match(await panel.locator("section.panel").innerText(), /\/workspace\/heartbeat.md/);
        assert.match(await panel.locator("section.panel").innerText(), /项目配置/);
        assert.match(await panel.locator("section.panel").innerText(), /最近心跳记录/);
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /latest-recorded-wake|items-inventory/,
        );
        assert.equal(await panel.locator(".audit-time dd").last().innerText(), "—");
        await panel.locator("summary").filter({ hasText: "登记项与阻塞" }).click();
        assert.match(await panel.locator("section.panel").innerText(), /处理阻塞/);
        await panel.locator("summary").filter({ hasText: "心跳历史" }).click();
        assert.match(await panel.locator("section.panel").innerText(), /2026-11-11 wake/);
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
      await panel.getByRole("heading", { name: /项目心跳 当前未认证/ }).waitFor();
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
      await panel.locator("summary").filter({ hasText: "心跳历史" }).click();
      await panel.getByText("2026-11-11 wake", { exact: true }).scrollIntoViewIfNeeded();
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
            wakeCount: 5000,
            itemCount: 200,
            wakesTruncated: true,
            itemsTruncated: true,
            itemStatusCounts: { completed: 180, blocked: 20 },
          };
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "巡检第5000轮", rows: [] }],
            nextCursor: "1",
            total: 5000,
            sourcePath: value.sourcePath,
          };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await showView(panel, "heartbeat");
        await panel.locator("summary").filter({ hasText: "来源与诊断" }).click();
        assert.match(
          await panel.locator("section.panel").innerText(),
          /200 · 已完成 180 · 阻塞 20/,
        );
        await panel.locator("summary").filter({ hasText: "心跳历史 (5000)" }).click();
        await panel.getByText("巡检第5000轮", { exact: true }).waitFor();
        await page.evaluate(() => {
          window.fixture.heartbeatHistory = {
            wakes: [{ heading: "巡检第4999轮", rows: [] }],
            nextCursor: null,
            total: 5000,
            sourcePath: window.fixture.heartbeat.sourcePath,
          };
        });
        await panel.getByRole("button", { name: "加载更早心跳", exact: true }).click();
        await panel.getByText("巡检第4999轮", { exact: true }).waitFor();
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
        await panel.locator("summary").filter({ hasText: "心跳历史" }).click();
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
        const heartbeatHistory = panel.locator("summary").filter({ hasText: "心跳历史" });
        if ((await heartbeatHistory.locator("..").getAttribute("open")) === null)
          await heartbeatHistory.click();
        else await panel.getByRole("button", { name: "刷新心跳历史", exact: true }).click();
        await panel.getByText("new thread-a heartbeat", { exact: true }).waitFor();
        await page.evaluate(async () => {
          window.fixture.releaseHeldHeartbeatHistory();
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        assert.equal(await panel.getByText("old thread-a heartbeat", { exact: true }).count(), 0);
        assert.equal(await panel.getByText("new thread-a heartbeat", { exact: true }).count(), 1);
        const requests = await page.evaluate(() =>
          window.fixture.calls.filter((call) => call.method === "heartbeat-history"),
        );
        assert.deepEqual(
          requests.map((request) => request.threadId),
          ["thread-a", "thread-a"],
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
