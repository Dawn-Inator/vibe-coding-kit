import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
<main data-app-shell-page-surface><div id="layout" data-app-shell-main-content-layout="thread-edge-scroll"><div id="content"><div id="messages">Conversation remains below the task panel.</div><div id="composer" data-codex-composer-root><div role="textbox" contenteditable="true" data-codex-composer></div></div></div></main>
<script>
window.fixture = {delay:Number(new URL(location.href).searchParams.get("initialDelay") || 0),task:null, taskSource:null, heartbeat:null, execution:{state:"unknown",observedAt:"2026-11-11T12:00:00Z",source:"codex-app-server"}, history:{events:[],nextCursor:null}, heartbeatHistory:null, calls:[]};
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.task,taskSource:window.fixture.taskSource,heartbeat:window.fixture.heartbeat,execution:window.fixture.execution,...(request.method==='history'?{history:window.fixture.history}:{}),...(request.method==='heartbeat-history'?{heartbeatHistory:window.fixture.heartbeatHistory}:{})};
  if(window.fixture.delay && request.threadId === 'thread-a') await new Promise(resolve => setTimeout(resolve,window.fixture.delay));
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
    res.end(req.url === "/bundle.js" ? bundle : fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const open = async (query = "") => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const page = await context.newPage();
    await page.goto(`${url}${query}`);
    await page.locator("codex-task-panel").waitFor({ state: "visible" });
    return { context, page, panel: page.locator("codex-task-panel") };
  };
  try {
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
        await panel.getByText(/心跳任务来源已过期/).waitFor();
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /尚未建立任务/);
        assert.equal(await panel.getByRole("progressbar").count(), 0);
        assert.match(await panel.locator("section.panel").innerText(), /台账文件已删除/);

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "error",
            readOnly: true,
            error: "Kit source helper unavailable",
          };
        });
        await panel.getByText(/心跳任务来源暂不可用/).waitFor();
        assert.doesNotMatch(await panel.locator(".summary").innerText(), /尚未建立任务/);
        assert.equal(await panel.getByRole("progressbar").count(), 0);

        await page.evaluate(() => {
          window.fixture.taskSource = {
            status: "pending-selection",
            readOnly: true,
            error: "Multiple heartbeat ledgers match this chat",
          };
        });
        await panel.getByText(/当前任务来源尚未解析/).waitFor();
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
        await panel.getByText(/只读 Kit 心跳来源/).waitFor();
        await panel.getByRole("button", { name: /Heartbeat ledger task/ }).click();
        await panel
          .locator("details.heartbeat summary")
          .filter({ hasText: "只读 Kit 任务来源" })
          .click();
        await panel.getByText(/P1: missing child C1/).waitFor();
        await panel.getByText(/P1: done · C1: blocked/).waitFor();
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
        await panel.getByRole("tab", { name: "历史", exact: true }).click();
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
        await panel.getByRole("button", { name: "浮动面板", exact: true }).click();
        assert.equal(await panel.getAttribute("floating"), "");
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        assert.equal(
          await page.locator("#layout").evaluate((element) => element.style.paddingTop),
          "",
        );
        await panel.getByRole("button", { name: "固定面板", exact: true }).click();
        assert.equal(await panel.getAttribute("floating"), null);
        await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
        const contentBox = await page.locator("#content").boundingBox();
        const panelBox = await panel.boundingBox();
        assert.ok(contentBox.y >= panelBox.y + panelBox.height + 7);
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
      assert.match(await header.innerText(), /已登记清单 2\/2 · 当前空闲/);
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
      assert.match(await header.innerText(), /已登记清单 2\/3 · 清单进度 66.67% · 正在执行/);
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
        await panel.getByRole("button", { name: /任务进度/ }).click();
        await panel.getByRole("heading", { name: "项目心跳" }).waitFor();
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
        assert.match(await panel.locator("section.panel").innerText(), /只读/);
        assert.match(await panel.locator("section.panel").innerText(), /\/workspace\/heartbeat.md/);
        assert.match(await panel.locator("section.panel").innerText(), /项目配置/);
        assert.match(await panel.locator("section.panel").innerText(), /最近心跳记录/);
        assert.doesNotMatch(
          await panel.locator("section.panel").innerText(),
          /latest-recorded-wake|items-inventory/,
        );
        assert.equal(await panel.getByText("预期下次巡检", { exact: true }).count(), 0);
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
        assert.match(await panel.locator("section.panel").innerText(), /台账文件已删除/);
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
      await panel.getByRole("button", { name: /实现普通任务面板/ }).click();
      await panel.getByRole("heading", { name: /项目心跳 当前未认证/ }).waitFor();
      const [panelBox, goalBox] = await Promise.all([
        panel.boundingBox(),
        page.locator("#goal-fixture").boundingBox(),
      ]);
      assert.ok(panelBox.y + panelBox.height <= goalBox.y);
      await mkdir(".playwright-img", { recursive: true });
      await panel.screenshot({ path: ".playwright-img/task-panel-preview.png" });
      await panel.locator("summary").filter({ hasText: "心跳历史" }).click();
      await panel.getByText("2026-11-11 wake", { exact: true }).scrollIntoViewIfNeeded();
      await panel.screenshot({ path: ".playwright-img/task-panel-heartbeat-history-preview.png" });
      await page.setViewportSize({ width: 420, height: 640 });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      const narrow = await panel.boundingBox();
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
        await panel.getByRole("button", { name: /任务进度/ }).click();
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
      await panel.getByRole("tab", { name: "子任务", exact: true }).waitFor();
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
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
