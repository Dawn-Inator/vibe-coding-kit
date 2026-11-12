import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const fixture = `<!doctype html><html lang="zh-CN"><head><style>body{font:14px system-ui;margin:0;background:#f5f5f5}aside{position:absolute;left:0;top:0}main{margin:auto;width:700px;height:100vh}#composer{position:fixed;bottom:20px;width:700px;height:100px;background:white;border:1px solid #ccc} [role=textbox]{height:80px}</style></head><body>
<aside><div data-app-action-sidebar-thread-row aria-current="page" data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="thread-a"></div></aside>
<main data-app-shell-page-surface><div id="composer" data-codex-composer-root><div role="textbox" contenteditable="true" data-codex-composer></div></div></main>
<script>
window.fixture = {task:null, heartbeat:null, history:{events:[],nextCursor:null}, calls:[]};
window.__codexTaskProgressRequest = async function(request) {
  window.fixture.calls.push(request);
  if(request.method === 'bind-heartbeat') {
    window.fixture.heartbeat = request.path ? {...window.fixture.heartbeat,status:'ready',sourcePath:request.path} : null;
  }
  const result = {task:window.fixture.task,heartbeat:window.fixture.heartbeat,...(request.method==='history'?{history:window.fixture.history}:{})};
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
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator("codex-task-panel").waitFor({ state: "visible" });
    return { context, page, panel: page.locator("codex-task-panel") };
  };
  try {
    await t.test("empty chat stays docked and hides heartbeat; identity confirmed", async () => {
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
      await context.close();
    });
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
        await panel.getByRole("button", { name: "固定面板", exact: true }).click();
        assert.equal(await panel.getAttribute("floating"), null);
        await context.close();
      },
    );
    await t.test(
      "heartbeat candidate selection, stale state, findings, history and unbind",
      async () => {
        const { context, page, panel } = await open();
        await page.evaluate((value) => {
          window.fixture.heartbeat = { ...value, status: "candidates", sourcePath: null };
          return window.__CODEX_TASK_PROGRESS__.refresh();
        }, heartbeat);
        await panel.getByRole("button", { name: /任务进度/ }).click();
        await panel
          .getByRole("combobox", { name: "心跳台账" })
          .selectOption("/workspace/heartbeat.md");
        await panel.getByRole("heading", { name: /心跳 当前未认证/ }).waitFor();
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
        await panel
          .locator("summary")
          .filter({ hasText: /^来源$/ })
          .click();
        await panel.getByRole("button", { name: "解除关联并隐藏心跳" }).click();
        assert.equal(await panel.getByRole("heading", { name: /心跳/ }).count(), 0);
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
      await panel.getByRole("heading", { name: /心跳 当前未认证/ }).waitFor();
      const [panelBox, goalBox] = await Promise.all([
        panel.boundingBox(),
        page.locator("#goal-fixture").boundingBox(),
      ]);
      assert.ok(panelBox.y + panelBox.height <= goalBox.y);
      await mkdir("work", { recursive: true });
      await page.screenshot({ path: "work/task-panel-preview.png" });
      await panel.locator("summary").filter({ hasText: "心跳历史" }).click();
      await panel.getByText("2026-11-11 wake", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: "work/task-panel-heartbeat-history-preview.png" });
      await page.setViewportSize({ width: 420, height: 640 });
      await page.evaluate(() => window.__CODEX_TASK_PROGRESS__.refresh());
      const narrow = await panel.boundingBox();
      const goalNarrow = await page.locator("#goal-fixture").boundingBox();
      assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 420);
      assert.ok(narrow.y >= 0 && narrow.y + narrow.height <= goalNarrow.y);
      await context.close();
    });
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
