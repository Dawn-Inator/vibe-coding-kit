import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { chromium } from "@playwright/test";
import { buildNativePanel, renderNativePanelHtml } from "../scripts/build_native_panel.mjs";
import { buildPluginPackage } from "../scripts/build_plugin_package.mjs";

const task = {
  threadId: "conversation-verified-by-tool",
  title: "Native task panel",
  revision: 3,
  updatedAt: "2026-11-15T12:00:00Z",
  objectives: [
    {
      id: "A1",
      title: "Reuse current task data",
      status: "active",
      required: true,
      evidence: [],
      items: [
        { id: "A1.1", title: "Render existing checklist", status: "completed", evidence: [] },
        { id: "A1.2", title: "Verify the panel", status: "active", evidence: [] },
      ],
    },
  ],
  progress: { completed: 1, total: 3, percent: 33 },
  phase: "active",
};
const heartbeat = {
  status: "ready",
  sourcePath: "/workspace/heartbeat.md",
  candidates: [{ path: "/workspace/heartbeat.md", associated: true }],
  refreshedAt: "2026-11-15T12:00:00Z",
  modifiedAt: "2026-11-15T11:59:00Z",
  lastWakeAt: "2026-11-15T11:40:00Z",
  nextWakeAt: null,
  cadenceMinutes: null,
  certifiesCurrent: false,
  passed: false,
  items: [],
  wakes: [],
  findings: [],
};
const initialResponse = {
  task,
  heartbeat,
  execution: { state: "working", observedAt: "2026-11-15T12:00:00Z", source: "codex-app-server" },
};

const hostPage = `<!doctype html><html><body>
<iframe id="app" title="Task Progress" src="/task-progress-panel.html" style="width:100%;height:650px;border:0"></iframe>
<script>
window.hostCalls=[];
window.currentResponse=${JSON.stringify(initialResponse)};
window.initialTask=window.currentResponse.task;
if (new URL(location.href).searchParams.has('pending')) window.currentResponse={task:null,heartbeat:null,taskSourcePending:true};
window.noIdentity=false;
window.noTask=false;
window.currentThreadId='conversation-verified-by-tool';
window.getError=null;
window.historyError=null;
window.holdGet=false;
window.releaseHeldGet=null;
window.archiveResponse=null;
window.archiveIdentity=null;
window.fullHistoryResponse=false;
window.holdNextHistory=false;
window.heldHistoryDelivered=false;
window.releaseHeldHistory=null;
window.ignoreInitialize=new URL(location.href).searchParams.has('nohost');
window.deliverToolResult=(threadId,value)=>document.getElementById('app').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:JSON.stringify({ok:true,result:value})}],_meta:{'codex-task-progress/threadId':threadId}}},'*');
window.addEventListener('message', async (event) => {
  const frame=document.getElementById('app');
  if(event.source !== frame.contentWindow) return;
  const request=event.data;
  if(!request || request.jsonrpc !== '2.0' || !request.method) return;
  if(request.method === 'ui/initialize') {
    if(window.ignoreInitialize) return;
    const url=new URL(location.href);
    const theme=url.searchParams.get('theme') || 'dark';
    const foreground=theme==='dark'?'rgb(220, 224, 230)':'rgb(45, 51, 60)';
    const hostContext={theme,safeAreaInsets:{top:20,right:10,bottom:15,left:10},platform:'desktop'};
    if(!url.searchParams.has('nostyles')) hostContext.styles={variables:{'--color-text-primary':foreground,'--color-text-info':'rgb(0, 128, 0)','--color-background-primary':theme==='dark'?'rgb(30, 32, 36)':'rgb(255, 255, 255)'}};
    frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'test-host',version:'1'},hostCapabilities:{serverTools:{listChanged:true}},hostContext}},'*');
    return;
  }
  if(request.method === 'tools/call') {
    const name=request.params?.name;
    const args=request.params?.arguments ?? {};
    window.hostCalls.push({name,args});
    const holdThisHistory=name === 'task_progress_history' && window.holdNextHistory;
    if(holdThisHistory) window.holdNextHistory=false;
    let result;
    if(name === 'task_progress_get') {
      const value=window.noIdentity ? {task:null,heartbeat:null} : window.noTask ? {...window.currentResponse,task:null} : window.currentResponse;
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:value})}],_meta:window.noIdentity?{}:{'codex-task-progress/threadId':window.currentThreadId}};
    } else if(name === 'task_progress_archive') {
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:{archive:window.archiveResponse}})}],_meta:{'codex-task-progress/threadId':window.archiveIdentity || window.currentThreadId}};
    } else if(name === 'task_progress_history') {
      const {task:ignoredTask,...responseWithoutTask}=window.currentResponse;
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:{...(window.fullHistoryResponse ? window.currentResponse : responseWithoutTask),history:{events:[{type:'task.updated',occurredAt:'2026-11-15T11:00:00Z',reason:holdThisHistory?'STALE HISTORY':'OLD HISTORY'}],nextCursor:null}}})}],_meta:{'codex-task-progress/threadId':window.currentThreadId}};
    } else if(name === 'task_progress_heartbeat_history') {
      const {task:ignoredTask,...responseWithoutTask}=window.currentResponse;
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:{...responseWithoutTask,heartbeatHistory:{wakes:[],nextCursor:null,total:0,sourcePath:window.currentResponse.heartbeat?.sourcePath}}})}],_meta:{'codex-task-progress/threadId':window.currentThreadId}};
    } else {
      result={content:[{type:'text',text:JSON.stringify({ok:false,summary:'Unexpected tool call.'})}],isError:true};
    }
    if ((name === 'task_progress_get' && window.getError) || (name === 'task_progress_history' && window.historyError)) {
      const failure = name === 'task_progress_get' ? window.getError : window.historyError;
      result = { content: [{type:'text', text:JSON.stringify({ok:false,...failure})}], isError:true };
    }
    // Snapshot the response and identity when the request arrives, before delaying delivery.
    result=JSON.parse(JSON.stringify(result));
    if(name === 'task_progress_get' && window.holdGet) await new Promise(resolve=>{window.releaseHeldGet=resolve});
    if(holdThisHistory) await new Promise(resolve=>{window.releaseHeldHistory=resolve});
    frame.contentWindow.postMessage({jsonrpc:'2.0',id:request.id,result},'*');
    if(holdThisHistory) window.heldHistoryDelivered=true;
  }
});
</script></body></html>`;

test("native HTML insertion preserves replacement tokens and emits parseable inline JavaScript", () => {
  const tokens = "$& $' $" + String.fromCharCode(96);
  const source = `globalThis.fixture = ${JSON.stringify(tokens)}; globalThis.closeTag = ${JSON.stringify("</script>")};`;
  const html = renderNativePanelHtml("<body><!-- NATIVE_PANEL_SCRIPT --></body>", source);
  const embedded = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(embedded);
  assert.equal(embedded, source.replace(/<\/script/gi, "<\\/script"));
  assert.doesNotThrow(() => new Script(embedded));
});

async function serveAsset(html) {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(new URL(request.url, "http://localhost").pathname === "/" ? hostPage : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function waitForPanelThread(page, threadId) {
  await page.waitForFunction(
    (expected) =>
      document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
        ?.threadId === expected,
    threadId,
  );
}

test("native panel MCP Apps integration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-task-panel-"));
  const assetPath = join(root, "task-progress-panel.html");
  let server;
  let browser;
  try {
    await buildNativePanel({ outputPath: assetPath });
    const html = await readFile(assetPath, "utf8");
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
    server = await serveAsset(html);
    browser = await chromium.launch({ headless: true });
    const url = `http://127.0.0.1:${server.address().port}`;

    // Isolate each protocol scenario so a failure cannot hide later coverage.
    async function scenario(run, suffix = "", virtualClock = false) {
      const preferredColorScheme = new URLSearchParams(suffix).get("theme");
      const context = await browser.newContext({
        viewport: { width: 350, height: 740 },
        locale: "en-US",
        ...(preferredColorScheme ? { colorScheme: preferredColorScheme } : {}),
      });
      await context.addInitScript(() =>
        localStorage.setItem("codex-task-progress:expanded", "sentinel"),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      if (virtualClock) {
        await page.clock.install();
        // Freeze startup before navigation so the first retry cannot race the test's initial read.
        await page.clock.pauseAt(new Date(Date.now() + 60_000));
      }
      const requests = [];
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
      page.on("request", (request) => requests.push(request.url()));
      try {
        await page.goto(url + suffix);
        await run(page, page.frameLocator("#app"), requests);
        assert.deepEqual(pageErrors, [], "native fixture should have no page errors");
      } catch (error) {
        if (pageErrors.length) error.message += `\nPage errors: ${pageErrors.join("\n")}`;
        throw error;
      } finally {
        await context.close();
      }
    }
    await t.test(
      "pending discovery uses bounded non-overlapping retries and stops when hidden or disposed",
      () =>
        scenario(
          async (page, frame) => {
            const count = () =>
              page.evaluate(
                () => window.hostCalls.filter((call) => call.name === "task_progress_get").length,
              );
            await page.waitForFunction(() => window.hostCalls.length === 1);
            await frame.getByText("Refreshing task source…", { exact: true }).first().waitFor();
            await page.evaluate((response) => {
              window.currentResponse = response;
            }, initialResponse);
            await page.clock.fastForward(150);
            await frame
              .getByRole("heading", { level: 2, name: "Native task panel", exact: true })
              .waitFor();
            assert.equal(await count(), 2, "ready data arrives after the first 150 ms retry");

            await page.evaluate(() => {
              window.currentResponse = { task: null, heartbeat: null, heartbeatPending: true };
              window.deliverToolResult(window.currentThreadId, window.currentResponse);
              window.holdGet = true;
            });
            await page.waitForFunction(
              () =>
                document
                  .getElementById("app")
                  .contentWindow.document.querySelector("codex-task-panel")?.data
                  ?.heartbeatPending === true,
            );
            await page.clock.fastForward(150);
            await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
            const held = await count();
            await page.clock.fastForward(10_000);
            assert.equal(await count(), held, "slow requests never overlap");
            await page.evaluate(() => {
              window.holdGet = false;
              window.releaseHeldGet();
            });
            await page.waitForFunction(
              () =>
                !document
                  .getElementById("app")
                  .contentWindow.document.querySelector("codex-task-panel").refreshing,
            );
            for (const delay of [250, 500, 1000]) {
              const next = (await count()) + 1;
              await page.clock.fastForward(delay);
              await page.waitForFunction(
                (n) =>
                  window.hostCalls.filter((call) => call.name === "task_progress_get").length >= n,
                next,
              );
              await page.waitForFunction(
                () =>
                  !document
                    .getElementById("app")
                    .contentWindow.document.querySelector("codex-task-panel").refreshing,
              );
            }
            // The installed clock normally keeps ticking during protocol calls.
            // Freeze it at the boundary so the final millisecond cannot elapse
            // while the test sends the visibility event.
            await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
            const bounded = await count();
            await page.clock.fastForward(4_000);
            assert.equal(await count(), bounded, "long pending falls back to five seconds");
            await page.locator("#app").evaluate((iframe) => {
              Object.defineProperty(iframe.contentDocument, "visibilityState", {
                configurable: true,
                value: "hidden",
              });
              iframe.contentDocument.dispatchEvent(new Event("visibilitychange"));
            });
            await page.clock.fastForward(10_000);
            assert.equal(await count(), bounded, "hidden panel does not poll");
            await page
              .locator("#app")
              .evaluate((iframe) => iframe.contentWindow.dispatchEvent(new Event("pagehide")));
            await page.clock.fastForward(10_000);
            assert.equal(await count(), bounded, "disposed panel does not poll");
          },
          "/?pending",
          true,
        ),
    );

    await t.test("pending subagents retry promptly, then return to quiet polling", () =>
      scenario(
        async (page, frame) => {
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel")?.data.task?.title ===
              "Native task panel",
          );
          // Capture the actual ready-poll deadline: the installed clock advances
          // during protocol round trips, so 4,999 ms after observation is too late.
          await page.locator("#app").evaluate((iframe) => {
            const win = iframe.contentWindow;
            const original = win.setTimeout;
            win.setTimeout = function (callback, delay, ...args) {
              if (delay === 5_000) win.lastQuietPollScheduledAt = win.Date.now();
              return original.call(this, callback, delay, ...args);
            };
          });
          await page.evaluate(() => {
            const subagents = {
              schemaVersion: 1,
              parentThreadId: window.currentThreadId,
              observedAt: null,
              status: "pending",
              runningCount: null,
              runningBasis: "unknown",
              agents: [],
              complete: false,
              truncated: false,
            };
            window.currentResponse = {
              ...window.currentResponse,
              subagents,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.subagents?.status ===
              "pending",
          );
          const count = () =>
            page.evaluate(
              () => window.hostCalls.filter((c) => c.name === "task_progress_get").length,
            );
          const before = await count();
          await page.evaluate(() => {
            window.currentResponse = {
              ...window.currentResponse,
              subagents: {
                ...window.currentResponse.subagents,
                status: "ready",
                complete: true,
              },
            };
          });
          await page.clock.fastForward(150);
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.subagents?.status ===
              "ready",
          );
          assert.equal(await count(), before + 1);
          const snapshot = await frame
            .locator("codex-task-panel")
            .evaluate((panel) => panel.data.subagents);
          assert.equal(snapshot.runningCount, null);
          assert.equal(snapshot.runningBasis, "unknown");
          await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1);
          const remaining = await page.locator("#app").evaluate((iframe) => {
            const win = iframe.contentWindow;
            return win.lastQuietPollScheduledAt + 5_000 - win.Date.now();
          });
          assert.ok(
            remaining > 4_000 && remaining <= 5_000,
            `invalid quiet-poll deadline: ${remaining}`,
          );
          await page.clock.fastForward(remaining - 1);
          assert.equal(await count(), before + 1, "no poll before the five-second deadline");
          await page.clock.fastForward(1);
          await page.clock.resume();
          await page.waitForFunction(
            (expected) =>
              window.hostCalls.filter((c) => c.name === "task_progress_get").length === expected,
            before + 2,
          );
        },
        "",
        true,
      ),
    );

    await t.test("partial subagents retry promptly, then return to quiet polling", () =>
      scenario(
        async (page, frame) => {
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel")?.data.task?.title ===
              "Native task panel",
          );
          // Capture the actual ready-poll deadline: the installed clock advances
          // during protocol round trips, so 4,999 ms after observation is too late.
          await page.locator("#app").evaluate((iframe) => {
            const win = iframe.contentWindow;
            const original = win.setTimeout;
            win.setTimeout = function (callback, delay, ...args) {
              if (delay === 5_000) win.lastQuietPollScheduledAt = win.Date.now();
              return original.call(this, callback, delay, ...args);
            };
          });
          await page.evaluate(() => {
            const subagents = {
              schemaVersion: 1,
              parentThreadId: window.currentThreadId,
              observedAt: null,
              status: "partial",
              runningCount: null,
              runningBasis: "unknown",
              agents: [],
              complete: false,
              truncated: false,
            };
            window.currentResponse = {
              ...window.currentResponse,
              subagents,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.subagents?.status ===
              "partial",
          );
          const count = () =>
            page.evaluate(
              () => window.hostCalls.filter((c) => c.name === "task_progress_get").length,
            );
          const before = await count();
          await page.evaluate(() => {
            window.currentResponse = {
              ...window.currentResponse,
              subagents: {
                ...window.currentResponse.subagents,
                status: "ready",
                complete: true,
              },
            };
          });
          await page.clock.fastForward(150);
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.subagents?.status ===
              "ready",
          );
          assert.equal(await count(), before + 1);
          const snapshot = await frame
            .locator("codex-task-panel")
            .evaluate((panel) => panel.data.subagents);
          assert.equal(snapshot.runningCount, null);
          assert.equal(snapshot.runningBasis, "unknown");
          await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1);
          const remaining = await page.locator("#app").evaluate((iframe) => {
            const win = iframe.contentWindow;
            return win.lastQuietPollScheduledAt + 5_000 - win.Date.now();
          });
          assert.ok(
            remaining > 4_000 && remaining <= 5_000,
            `invalid quiet-poll deadline: ${remaining}`,
          );
          await page.clock.fastForward(remaining - 1);
          assert.equal(await count(), before + 1, "no poll before the five-second deadline");
          await page.clock.fastForward(1);
          await page.clock.resume();
          await page.waitForFunction(
            (expected) =>
              window.hostCalls.filter((c) => c.name === "task_progress_get").length === expected,
            before + 2,
          );
        },
        "",
        true,
      ),
    );

    await t.test(
      "agent-only pushes read fresh data and scoped cache rejects late responses and revocation",
      () =>
        scenario(async (page, frame) => {
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel")?.data.task?.title ===
              "Native task panel",
          );
          await page.evaluate(() => {
            const subagents = {
              schemaVersion: 1,
              parentThreadId: window.currentThreadId,
              observedAt: null,
              status: "ready",
              runningCount: null,
              runningBasis: "unknown",
              agents: [],
              complete: true,
              truncated: false,
            };
            window.currentResponse = {
              ...window.currentResponse,
              subagents,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.subagents?.status ===
              "ready",
          );
          await page.evaluate(() => {
            window.holdGet = true;
            window.deliverToolResult(window.currentThreadId, {
              subagents: { ...window.currentResponse.subagents, runningCount: 99 },
              presentation: window.currentResponse.presentation,
            });
          });
          await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((p) => p.data.task.title),
            "Native task panel",
          );
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((p) => p.data.subagents.runningCount),
            null,
          );
          await page.evaluate(() => {
            window.deliverToolResult(window.currentThreadId, {
              ...window.currentResponse,
              task: { ...window.currentResponse.task, title: "Source B", source: { path: "/b" } },
              subagents: { ...window.currentResponse.subagents, runningCount: 2 },
              presentation: { scope: "project-b", pending: false, cached: false, updatedAt: 20 },
            });
            window.deliverToolResult(window.currentThreadId, {
              task: null,
              heartbeat: null,
              presentation: { scope: "project-a", pending: true, cached: false, updatedAt: null },
            });
            window.holdGet = false;
            window.releaseHeldGet();
          });
          await page.waitForFunction(() => {
            const p = document
              .getElementById("app")
              .contentWindow.document.querySelector("codex-task-panel");
            return (
              p.data.presentation?.scope === "project-a" && p.data.subagents?.runningCount === null
            );
          });
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((p) => p.data.task.title),
            "Native task panel",
          );
          await page.evaluate(() => {
            window.deliverToolResult(window.currentThreadId, {
              enabled: false,
              task: null,
              heartbeat: null,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 30 },
            });
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.enabled === false,
          );
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((p) => p.data.subagents ?? null),
            null,
          );
        }),
    );

    await t.test("scoped cached views restore immediately and stay isolated", () =>
      scenario(
        async (page, frame) => {
          const present = (scope, pending = false, error) => ({
            scope,
            pending,
            cached: false,
            updatedAt: 10,
            ...(error ? { error } : {}),
          });
          await frame.locator(".summary .main").waitFor();
          await page.evaluate((presentation) => {
            window.currentResponse = { ...window.currentResponse, presentation };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          }, present("project-a"));
          await frame.getByRole("button", { name: "History" }).click();
          await frame.getByText("OLD HISTORY", { exact: false }).waitFor();
          await page.evaluate((presentation) => {
            window.deliverToolResult("thread-b", {
              ...window.currentResponse,
              presentation,
              task: { ...window.currentResponse.task, threadId: "thread-b", title: "Project B" },
            });
          }, present("project-b"));
          await waitForPanelThread(page, "thread-b");
          await page.evaluate(
            (presentation) => {
              window.holdGet = true;
              window.deliverToolResult("conversation-verified-by-tool", {
                task: null,
                heartbeat: null,
                presentation,
              });
            },
            present("project-a", true),
          );
          await frame.getByRole("heading", { name: "Task history" }).waitFor({ timeout: 1_000 });
          await frame.getByText("OLD HISTORY", { exact: false }).waitFor({ timeout: 1_000 });
          await page.clock.fastForward(150);
          await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
          await page.locator("#app").evaluate((iframe) => {
            Object.defineProperty(iframe.contentDocument, "visibilityState", {
              configurable: true,
              value: "hidden",
            });
            iframe.contentDocument.dispatchEvent(new Event("visibilitychange"));
            Object.defineProperty(iframe.contentDocument, "visibilityState", {
              configurable: true,
              value: "visible",
            });
            iframe.contentDocument.dispatchEvent(new Event("visibilitychange"));
          });
          await frame.getByText("OLD HISTORY", { exact: false }).waitFor({ timeout: 1_000 });
          await page.evaluate(
            (presentation) => {
              window.deliverToolResult("conversation-verified-by-tool", {
                task: null,
                heartbeat: null,
                presentation,
              });
            },
            present("project-c", true),
          );
          await page.waitForFunction(() => {
            const panel = document
              .getElementById("app")
              .contentWindow.document.querySelector("codex-task-panel");
            return panel.data.task === null;
          });
          assert.equal(await frame.getByText("OLD HISTORY", { exact: false }).count(), 0);
        },
        "",
        true,
      ),
    );

    await t.test(
      "native host bridge preserves source-scoped subagents from authenticated GET through rendering",
      () =>
        scenario(async (page, frame) => {
          const sourcePath = "/workspace/heartbeat.md";
          const sourceHash = "sha256:heartbeat-current";
          const rootTurnStartedAt = "2026-11-16T12:00:00.000Z";
          const observedAt = "2026-11-16T12:05:00.000Z";
          const response = {
            task: {
              threadId: "conversation-verified-by-tool",
              title: "Completed read-only heartbeat task",
              revision: 4,
              updatedAt: observedAt,
              objectives: [],
              progress: { completed: 1, total: 1, percent: 100 },
              phase: "completed",
              source: {
                kind: "kit-heartbeat",
                path: sourcePath,
                readOnly: true,
                contentHash: sourceHash,
              },
            },
            heartbeat,
            taskSource: {
              kind: "kit-heartbeat",
              status: "ready",
              path: sourcePath,
              readOnly: true,
              contentHash: sourceHash,
            },
            subagents: {
              schemaVersion: 1,
              parentThreadId: "conversation-verified-by-tool",
              taskCycleId: null,
              taskSourcePath: sourcePath,
              rootTurnId: "root-turn-current",
              rootTurnStartedAt,
              scopeBasis: "parent-root-turn",
              status: "ready",
              observedAt,
              runningCount: null,
              runningBasis: "unknown",
              agents: [
                {
                  id: "current-root-member",
                  name: "Current root member",
                  state: "working",
                  observedAt,
                  progress: { completed: 2, total: 2, percent: 100 },
                  progressBasis: "registered-checklist",
                },
              ],
              complete: true,
              truncated: false,
            },
            execution: { state: "unknown", observedAt, source: "codex-app-server" },
            presentation: {
              scope: "source-project",
              pending: false,
              cached: false,
              updatedAt: Date.parse(observedAt),
            },
          };
          const panel = frame.locator("codex-task-panel");
          const main = frame.locator(".summary .main");
          await main.waitFor();
          await waitForPanelThread(page, "conversation-verified-by-tool");
          await page.evaluate((value) => {
            window.currentResponse = value;
            window.deliverToolResult(window.currentThreadId, value);
          }, response);
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel")?.data.task?.title ===
              "Completed read-only heartbeat task",
          );
          if ((await main.getAttribute("aria-expanded")) !== "true") await main.click();
          await frame.getByRole("button", { name: "Subagents", exact: true }).click();
          await frame.getByText("Current root member", { exact: true }).waitFor();
          const subagentRegion = frame.getByRole("region", { name: "Subagents", exact: true });
          assert.equal(
            await subagentRegion.getByText("This run's agent records are not ready yet.").count(),
            0,
          );
          const verifyCurrentData = async () => {
            const data = await panel.evaluate((element) => ({
              taskSource: element.data.taskSource,
              source: element.data.task?.source,
              subagents: element.data.subagents,
            }));
            assert.deepEqual(data.taskSource, {
              kind: "kit-heartbeat",
              status: "ready",
              path: sourcePath,
              readOnly: true,
              contentHash: sourceHash,
            });
            assert.deepEqual(data.source, {
              kind: "kit-heartbeat",
              path: sourcePath,
              readOnly: true,
              contentHash: sourceHash,
            });
            assert.deepEqual(data.subagents.agents[0].progress, {
              completed: 2,
              total: 2,
              percent: 100,
            });
            assert.equal(data.subagents.agents[0].progressBasis, "registered-checklist");
            assert.equal(data.subagents.taskCycleId, null);
            assert.equal(data.subagents.taskSourcePath, sourcePath);
            assert.equal(data.subagents.rootTurnStartedAt, rootTurnStartedAt);
            assert.equal(data.subagents.observedAt, observedAt);
            const allocation = frame.locator(".agent-counts .allocation-ring");
            assert.equal(await allocation.getAttribute("role"), "img");
            assert.equal(await allocation.getAttribute("aria-valuenow"), null);
            assert.equal(await allocation.locator(".allocation-fill").count(), 0);
            assert.equal(await allocation.locator("strong").innerText(), "");
            assert.match(await allocation.getAttribute("aria-label"), /Unknown.*Not recorded yet/);
            assert.doesNotMatch(await allocation.innerText(), /\d+%|\d+\/\d+|0/);
          };
          await verifyCurrentData();

          // A source failure must not erase verified parent-thread activity.
          await page.evaluate((base) => {
            window.currentResponse = {
              ...base,
              task: null,
              taskSource: { ...base.taskSource, status: "stale" },
              subagents: {
                ...base.subagents,
                scopeBasis: "parent-thread",
                taskSourcePath: null,
                runningCount: 27,
                runningBasis: "runtime",
                agents: Array.from({ length: 27 }, (_, i) => ({
                  ...base.subagents.agents[0],
                  id: `agent-${i}`,
                  name: `Agent ${i}`,
                })),
              },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          }, response);
          await frame.getByText("Agent 0", { exact: true }).waitFor();
          assert.equal(await frame.locator(".agent-row").count(), 27);
          const unbound = await panel.evaluate((element) => element.currentRunSubagents());
          assert.ok(
            unbound.agents.every(
              (agent) => agent.progress === null && agent.progressBasis === null,
            ),
          );
          assert.equal(unbound.allocation, undefined);
          await page.evaluate((base) => {
            window.currentResponse = base;
            window.deliverToolResult(window.currentThreadId, base);
          }, response);
          await frame.getByText("Current root member", { exact: true }).waitFor();
          await verifyCurrentData();

          // A legacy model result may carry an updated source revision but omit
          // agents while the authenticated native read is still in flight.
          const callsBeforeLegacy = await page.evaluate(() => window.hostCalls.length);
          await page.evaluate(() => {
            window.holdGet = true;
            const { subagents: ignored, ...legacy } = window.currentResponse;
            legacy.task = { ...legacy.task, revision: 5 };
            window.deliverToolResult(window.currentThreadId, legacy);
          });
          await page.waitForFunction(
            (count) => window.hostCalls.length > count && window.releaseHeldGet,
            callsBeforeLegacy,
          );
          assert.equal(await panel.evaluate((element) => element.data.task.revision), 5);
          assert.equal(
            await panel.evaluate((element) => element.data.subagents.agents[0].progress),
            null,
          );
          assert.equal(
            await panel.evaluate((element) => element.data.subagents.agents[0].progressBasis),
            null,
          );
          await frame.getByText("Current root member", { exact: true }).waitFor();
          await page.evaluate(() => {
            window.holdGet = false;
            window.releaseHeldGet();
          });
          await verifyCurrentData();

          // An unscoped legacy push is only a refresh hint, never a new view.
          const callsBeforeUnscoped = await page.evaluate(() => window.hostCalls.length);
          await page.evaluate(() => {
            window.holdGet = true;
            window.releaseHeldGet = null;
            const { presentation, subagents, ...legacy } = window.currentResponse;
            legacy.task = { ...legacy.task, title: "Untrusted legacy title" };
            window.deliverToolResult(window.currentThreadId, legacy);
          });
          await page.waitForFunction(
            (count) => window.hostCalls.length > count && window.releaseHeldGet,
            callsBeforeUnscoped,
          );
          assert.equal(
            await panel.evaluate((element) => element.data.task.title),
            "Completed read-only heartbeat task",
          );
          await frame.getByText("Current root member", { exact: true }).waitFor();
          await page.evaluate(() => {
            window.holdGet = false;
            window.releaseHeldGet();
          });
          await verifyCurrentData();

          // Pending snapshots, both push and GET, retain proven membership and
          // schedule another read. A changed source must never retain it.
          await page.evaluate(() => {
            window.currentResponse = {
              ...window.currentResponse,
              subagents: {
                schemaVersion: 1,
                parentThreadId: window.currentThreadId,
                status: "pending",
                observedAt: null,
                runningCount: null,
                runningBasis: "unknown",
                agents: [],
                complete: false,
                truncated: false,
              },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await panel.evaluate((element) => element.refreshTask());
          await frame.getByText("Current root member", { exact: true }).waitFor();
          await page.evaluate(() => {
            window.currentResponse.subagents.status = "partial";
          });
          await panel.evaluate((element) => element.refreshTask());
          await frame.getByText("Current root member", { exact: true }).waitFor();
          // A complete empty result is authoritative and must clear the list.
          await page.evaluate(() => {
            window.currentResponse.subagents = {
              ...window.currentResponse.subagents,
              status: "ready",
              complete: true,
              scopeBasis: "parent-thread",
              observedAt: "2026-11-16T12:05:00.000Z",
              taskCycleId: null,
              taskSourcePath: "/workspace/heartbeat.md",
            };
          });
          await panel.evaluate((element) => element.refreshTask());
          await subagentRegion.getByText("No subagents recorded.").waitFor();
          await page.evaluate((value) => {
            window.currentResponse = value;
          }, response);
          await panel.evaluate((element) => element.refreshTask());
          await verifyCurrentData();
          await page.evaluate(() => {
            const { subagents, ...changed } = window.currentResponse;
            changed.task = {
              ...changed.task,
              source: { ...changed.task.source, path: "/workspace/other.md" },
            };
            changed.taskSource = { ...changed.taskSource, path: "/workspace/other.md" };
            window.deliverToolResult(window.currentThreadId, changed);
          });
          await subagentRegion.getByText("This run's agent records are not ready yet.").waitFor();
          assert.equal(await frame.locator(".agent-row").count(), 0);
          await page.evaluate((value) => {
            window.deliverToolResult(window.currentThreadId, value);
          }, response);
          await frame.getByText("Current root member", { exact: true }).waitFor();

          for (const invalidSnapshot of [
            { taskSourcePath: "/workspace/other-heartbeat.md" },
            { rootTurnStartedAt: "2026-11-16T12:06:00.000Z" },
          ]) {
            await page.evaluate((patch) => {
              window.currentResponse = {
                ...window.currentResponse,
                subagents: { ...window.currentResponse.subagents, ...patch },
              };
              window.deliverToolResult(window.currentThreadId, window.currentResponse);
            }, invalidSnapshot);
            await subagentRegion.getByText("This run's agent records are not ready yet.").waitFor();
            assert.equal(await frame.locator(".agent-row").count(), 0);
          }

          await page.evaluate(() => {
            window.currentResponse = {
              ...window.currentResponse,
              subagents: {
                ...window.currentResponse.subagents,
                parentThreadId: "conversation-other",
              },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await frame
            .getByRole("alert")
            .getByText(/Trusted conversation identity/)
            .waitFor();

          await page.evaluate((value) => {
            window.currentResponse = value;
          }, response);
          const getCount = await page.evaluate(
            () => window.hostCalls.filter((call) => call.name === "task_progress_get").length,
          );
          await panel.evaluate((element) => element.refreshTask());
          await page.waitForFunction(
            (count) =>
              window.hostCalls.filter((call) => call.name === "task_progress_get").length > count,
            getCount,
          );
          await frame.getByText("Current root member", { exact: true }).waitFor();
          await verifyCurrentData();
        }),
    );

    await t.test(
      "presentation errors keep valid data visible; disabled and untrusted responses invalidate it",
      () =>
        scenario(async (page, frame) => {
          await frame.locator(".summary .main").waitFor();
          await page.evaluate(() => {
            const presentation = {
              scope: "project-a",
              pending: false,
              cached: false,
              updatedAt: 10,
            };
            window.currentResponse = { ...window.currentResponse, presentation };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
            window.deliverToolResult(window.currentThreadId, {
              task: null,
              heartbeat: null,
              presentation: { ...presentation, error: "Backend unavailable" },
            });
          });
          await frame.getByRole("heading", { name: "Native task panel" }).waitFor();
          await frame.getByText("Backend unavailable", { exact: false }).first().waitFor();
          await page.evaluate(() =>
            window.deliverToolResult(window.currentThreadId, {
              task: null,
              heartbeat: null,
              enabled: false,
            }),
          );
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.enabled === false,
          );
          await page.evaluate(() => {
            window.currentResponse = {
              task: null,
              heartbeat: null,
              presentation: { scope: "project-a", pending: true, cached: false, updatedAt: null },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.enabled !== false,
          );
          assert.equal(await frame.getByRole("heading", { name: "Native task panel" }).count(), 0);
          await page.evaluate(() => window.deliverToolResult(null, window.currentResponse));
          await frame
            .getByRole("alert")
            .getByText(/Trusted conversation identity/)
            .waitFor();
        }),
    );

    await t.test("disabled panel rejects late enabled pushes until a fresh native read", () =>
      scenario(async (page, frame) => {
        await frame.locator(".summary .main").waitFor();
        await page.evaluate(() => {
          window.currentResponse = {
            ...window.currentResponse,
            presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
          };
          window.deliverToolResult(window.currentThreadId, window.currentResponse);
        });
        await page.waitForFunction(
          () =>
            document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
              .data.presentation?.scope === "project-a",
        );
        await page.evaluate(() =>
          window.deliverToolResult(window.currentThreadId, {
            enabled: false,
            task: null,
            heartbeat: null,
          }),
        );
        await page.waitForFunction(
          () =>
            document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
              .data.enabled === false,
        );
        await page.evaluate(() => {
          window.holdGet = true;
          window.deliverToolResult(window.currentThreadId, {
            ...window.currentResponse,
            history: { events: [], nextCursor: null },
          });
        });
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        assert.equal(
          await frame.locator("codex-task-panel").evaluate((panel) => panel.data.enabled),
          false,
        );
        assert.equal(await frame.getByRole("heading", { name: "Native task panel" }).count(), 0);
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await frame.getByRole("heading", { name: "Native task panel" }).waitFor();
        await page.evaluate(() => {
          window.holdGet = true;
          window.releaseHeldGet = null;
          window.deliverToolResult(window.currentThreadId, {
            ...window.currentResponse,
            task: {
              ...window.currentResponse.task,
              title: "Late bound source",
              source: { kind: "kit-heartbeat", path: "/old/ledger", readOnly: true },
            },
            history: { events: [], nextCursor: null },
          });
        });
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        assert.equal(
          await frame.locator("codex-task-panel").evaluate((panel) => panel.data.task?.title),
          "Native task panel",
        );
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await page.waitForFunction(
          () =>
            !document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
              .refreshing,
        );
        await page.evaluate(() => {
          window.deliverToolResult(null, window.currentResponse);
          window.holdGet = true;
          window.releaseHeldGet = null;
        });
        await frame
          .getByRole("alert")
          .getByText(/Trusted conversation identity/)
          .waitFor();
        await page.evaluate(() =>
          window.deliverToolResult(window.currentThreadId, {
            ...window.currentResponse,
            history: { events: [], nextCursor: null },
          }),
        );
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        assert.equal(await frame.getByRole("heading", { name: "Native task panel" }).count(), 0);
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await frame.getByRole("heading", { name: "Native task panel" }).waitFor();
      }),
    );

    await t.test("identity failure codes clear snapshots even with neutral summaries", () =>
      scenario(async (page, frame) => {
        for (const failure of [
          {
            code: "TASK_THREAD_UNTRUSTED",
            summary: "Native task read requires a verified user chat",
          },
          {
            code: "CODEX_REQUEST_THREAD_UNTRUSTED",
            summary: "Goal Progress only accepts a main user task.",
          },
          { code: "UNRECOGNIZED", summary: "Temporarily unavailable." },
        ]) {
          await page.evaluate(() => {
            window.getError = null;
            window.currentResponse = {
              ...window.currentResponse,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await frame.getByRole("heading", { name: "Native task panel" }).waitFor();
          await page.evaluate((value) => {
            window.getError = value;
          }, failure);
          await frame.locator(".panel-head .panel-refresh").click();
          await frame.getByRole("alert").getByText(failure.summary, { exact: false }).waitFor();
          assert.equal(await frame.getByRole("heading", { name: "Native task panel" }).count(), 0);
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((panel) => panel.threadId),
            null,
          );
        }
        await page.evaluate(() => {
          window.getError = null;
          window.deliverToolResult(window.currentThreadId, window.currentResponse);
          window.historyError = {
            code: "CODEX_REQUEST_THREAD_UNTRUSTED",
            summary: "Goal Progress only accepts a main user task.",
          };
        });
        await frame.getByRole("heading", { name: "Native task panel" }).waitFor();
        await frame.getByRole("button", { name: "History" }).click();
        await frame
          .getByRole("alert")
          .getByText("Goal Progress only accepts a main user task.", { exact: false })
          .waitFor();
        assert.equal(
          await frame.locator("codex-task-panel").evaluate((panel) => panel.threadId),
          null,
        );
        assert.equal(await frame.getByRole("heading", { name: "Native task panel" }).count(), 0);
      }),
    );

    await t.test("native archive is lazy and uses trusted tool identity", async () => {
      await scenario(async (page, frame) => {
        await frame.locator(".summary .main").waitFor();
        const current = {
          ...task,
          schemaVersion: 4,
          lifecycle: {
            id: "native-cycle",
            sequence: 2,
            startedAt: "2026-11-15T12:00:00Z",
            completion: null,
          },
          progress: { completed: 2, total: 3, percent: 66.67 },
        };
        await page.evaluate((currentTask) => {
          window.currentResponse = {
            ...window.currentResponse,
            task: currentTask,
            archiveCount: 1,
            completionBasis: "task-lifecycle",
          };
          window.archiveResponse = {
            kind: "tasks",
            tasks: [
              {
                id: "native-old",
                title: "Native archived task",
                completedAt: "2026-11-14T12:00:00Z",
                completionRevision: 2,
                progress: { completed: 2, total: 2, percent: 100 },
                objectiveCount: 1,
                itemCount: 1,
              },
            ],
            total: 1,
            nextCursor: null,
            currentTaskId: "native-cycle",
            threadId: window.currentThreadId,
          };
          window.deliverToolResult(window.currentThreadId, window.currentResponse);
        }, current);
        const panel = frame.locator("codex-task-panel");
        await panel.locator(".summary .main").waitFor();
        if ((await panel.locator(".summary .main").getAttribute("aria-expanded")) !== "true")
          await panel.locator(".summary .main").click();
        await panel.getByRole("button", { name: "Registered tasks" }).click();
        const archive = panel.locator(".archive-toggle");
        await archive.waitFor();
        assert.equal(await archive.getAttribute("aria-expanded"), "false");
        assert.equal(
          await page.evaluate(
            () => window.hostCalls.filter((call) => call.name === "task_progress_archive").length,
          ),
          0,
        );
        await archive.click();
        await panel
          .locator(".archive-cycle-toggle")
          .filter({ hasText: "Native archived task" })
          .waitFor();
        assert.equal(
          await panel.locator(".archive-cycle-toggle").getAttribute("aria-expanded"),
          "false",
        );
        const calls = await page.evaluate(() =>
          window.hostCalls.filter((call) => call.name === "task_progress_archive"),
        );
        assert.equal(calls.length, 1);
        assert.equal("threadId" in calls[0].args, false);
        assert.equal("path" in calls[0].args, false);
        assert.equal(calls[0].args.limit, 50);
        await page.evaluate(() => {
          window.archiveIdentity = "untrusted-other-thread";
          window.currentResponse = {
            ...window.currentResponse,
            task: {
              ...window.currentResponse.task,
              title: "Next native task",
              lifecycle: { ...window.currentResponse.task.lifecycle, id: "next-native-cycle" },
            },
          };
          window.archiveResponse = {
            ...window.archiveResponse,
            currentTaskId: "next-native-cycle",
            tasks: [{ ...window.archiveResponse.tasks[0], title: "Untrusted archive" }],
          };
          window.deliverToolResult(window.currentThreadId, window.currentResponse);
        });
        await panel
          .getByRole("heading", { level: 2, name: "Next native task", exact: true })
          .waitFor();
        assert.equal(await archive.getAttribute("aria-expanded"), "false");
        await archive.click();
        await panel.getByText(/identity changed/i).waitFor();
        assert.equal(
          await panel
            .locator(".archive-cycle-toggle")
            .filter({ hasText: "Untrusted archive" })
            .count(),
          0,
        );
      });
    });
    async function ready(frame) {
      const main = frame.locator(".summary .main");
      await main.waitFor();
      if ((await main.getAttribute("aria-expanded")) !== "true") await main.click();
      await frame.getByRole("button", { name: "Registered tasks" }).click();
      await frame.getByText("Reuse current task data", { exact: true }).waitFor();
    }
    async function normalizeColors(frame, colors) {
      return frame.locator("html").evaluate((_element, values) => {
        const context = document.createElement("canvas").getContext("2d");
        return values.map((value) => {
          if (!value || !CSS.supports("color", value)) throw new Error(`Invalid color: ${value}`);
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        });
      }, colors);
    }
    function sameColor(a, b) {
      return a.every((channel, index) => Math.abs(channel - b[index]) <= 1);
    }
    async function refresh(page) {
      await page.locator("#app").evaluate((iframe) => {
        iframe.contentDocument.dispatchEvent(new Event("visibilitychange"));
      });
    }

    await t.test("neutral native theme follows host light and dark foreground tokens", async () => {
      for (const theme of ["light", "dark"]) {
        await scenario(async (_page, frame) => {
          await ready(frame);
          await frame.locator(".row[data-objective]").click();
          const taskColors = await frame.locator("codex-task-panel").evaluate((element) => {
            const root = element.shadowRoot;
            const fill = root.querySelector(".edge-fill");
            const track = root.querySelector(".edge-track");
            const percent = root.querySelector(".percent");
            const main = root.querySelector(".main");
            const style = (node) => getComputedStyle(node);
            return {
              documentTheme: document.documentElement.getAttribute("data-theme"),
              hostForeground: getComputedStyle(element).color,
              accent: (() => {
                const probe = document.createElement("span");
                probe.style.color = "var(--ctp-accent)";
                element.shadowRoot.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
              })(),
              fill: style(fill).stroke,
              track: style(track).stroke,
              percent: style(percent).color,
              main: style(main).color,
              states: ["active", "completed"].map((status) => {
                const icon = root.querySelector(
                  status === "completed"
                    ? ".node-symbol[data-status='completed']"
                    : ".module-icon[data-status='active']",
                );
                return icon ? style(icon).color : null;
              }),
            };
          });
          assert.equal(taskColors.documentTheme, theme);
          const [accent, host, percent, main, fill, track, ...states] = await normalizeColors(
            frame,
            [
              taskColors.accent,
              taskColors.hostForeground,
              taskColors.percent,
              taskColors.main,
              taskColors.fill,
              taskColors.track,
              ...taskColors.states,
            ],
          );
          const green = [0, 128, 0, 255];
          assert.ok(sameColor(accent, host));
          assert.ok(sameColor(percent, main));
          assert.ok(sameColor(percent, host));
          assert.ok(!sameColor(fill, green));
          assert.ok(!sameColor(fill, track));
          assert.ok(states.every((color) => !sameColor(color, green)));

          await frame.getByRole("button", { name: "History" }).click();
          await frame.getByText("OLD HISTORY", { exact: false }).waitFor();
          const historyColor = await frame.locator("codex-task-panel").evaluate((element) => {
            const event = element.shadowRoot.querySelector(".event:first-child");
            return getComputedStyle(event, "::before").borderTopColor;
          });
          await frame.getByRole("button", { name: "Heartbeat" }).click();
          await frame.locator(".hb-time-latest .hb-time-label").waitFor();
          const heartbeatColor = await frame.locator("codex-task-panel").evaluate((element) => {
            const root = element.shadowRoot;
            const timeLabel = root.querySelector(".hb-time-latest .hb-time-label");
            const refresh = root.querySelector(".panel-head .panel-refresh");
            return {
              timeLabel: getComputedStyle(timeLabel).color,
              refresh: getComputedStyle(refresh).color,
              hasHeaderStatusBadge: root.querySelector(".hb-status") !== null,
            };
          });
          const [history, timeLabel, refresh] = await normalizeColors(frame, [
            historyColor,
            heartbeatColor.timeLabel,
            heartbeatColor.refresh,
          ]);
          assert.ok(sameColor(history, percent));
          assert.equal(heartbeatColor.hasHeaderStatusBadge, false);
          assert.ok(sameColor(timeLabel, refresh));
          assert.ok(!sameColor(timeLabel, green));
        }, `?theme=${theme}`);
      }
    });

    await t.test(
      "neutral native fallbacks work without host context or style variables",
      async () => {
        for (const theme of ["light", "dark"]) {
          for (const suffix of [`?nohost&theme=${theme}`, `?nostyles&theme=${theme}`]) {
            await scenario(async (_page, frame) => {
              if (suffix.includes("nohost")) {
                const panel = frame.locator("codex-task-panel");
                await panel.waitFor();
                await panel.evaluate((element, response) => {
                  element.data = response;
                  element.observed = true;
                  element.threadId = response.task.threadId;
                  element.requester = async () => response;
                }, initialResponse);
                await frame.getByRole("button", { name: "Registered tasks" }).click();
                await frame.getByText("Reuse current task data", { exact: true }).waitFor();
              } else {
                await ready(frame);
              }
              await frame.locator(".row[data-objective]").click();
              const colors = await frame.locator("codex-task-panel").evaluate((element) => {
                const root = element.shadowRoot;
                const style = (selector) => getComputedStyle(root.querySelector(selector));
                return {
                  accent: (() => {
                    const probe = document.createElement("span");
                    probe.style.color = "var(--ctp-accent)";
                    element.shadowRoot.append(probe);
                    const color = getComputedStyle(probe).color;
                    probe.remove();
                    return color;
                  })(),
                  colorScheme: getComputedStyle(document.documentElement).colorScheme,
                  prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
                  documentTheme: document.documentElement.getAttribute("data-theme"),
                  foreground: getComputedStyle(element).color,
                  percent: style(".percent").color,
                  fill: style(".edge-fill").stroke,
                  track: style(".edge-track").stroke,
                  active: style(".module-icon[data-status='active']").color,
                  completed: style(".node-symbol[data-status='completed']").color,
                };
              });
              const [accent, foreground, percent, fill, track, active, completed] =
                await normalizeColors(frame, [
                  colors.accent,
                  colors.foreground,
                  colors.percent,
                  colors.fill,
                  colors.track,
                  colors.active,
                  colors.completed,
                ]);
              const green = [0, 128, 0, 255];
              assert.ok(sameColor(accent, foreground));
              assert.equal(colors.prefersDark, theme === "dark");
              assert.equal(colors.documentTheme, suffix.includes("nohost") ? null : theme);
              assert.equal(colors.colorScheme, suffix.includes("nohost") ? "light dark" : theme);
              assert.ok(sameColor(percent, foreground));
              assert.ok(!sameColor(fill, green));
              assert.ok(!sameColor(fill, track));
              assert.ok(!sameColor(active, green));
              assert.ok(!sameColor(completed, green));
            }, suffix);
          }
        }
      },
    );

    await t.test("handshake, tabs, read-only requests and host presentation", () =>
      scenario(async (page, frame, requests) => {
        await ready(frame);
        assert.equal(await frame.locator("codex-task-progress").count(), 0);
        assert.equal(await frame.locator("codex-task-panel").getAttribute("presentation"), "panel");
        assert.equal(await frame.locator(".body").count(), 1);
        assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
        assert.equal(
          await frame
            .locator("#native-panel-shell")
            .evaluate((node) => getComputedStyle(node).paddingTop),
          "20px",
        );
        await frame.getByRole("button", { name: "History" }).click();
        await frame.getByRole("heading", { name: "Task history" }).waitFor();
        await frame.getByText("OLD HISTORY", { exact: false }).waitFor();
        await frame.getByRole("button", { name: "Heartbeat" }).click();
        await frame.getByRole("heading", { name: "Project heartbeat" }).waitFor();
        await page.waitForFunction(() =>
          window.hostCalls.some((call) => call.name === "task_progress_heartbeat_history"),
        );
        const calls = await page.evaluate(() => window.hostCalls);
        assert.deepEqual(calls[0], { name: "task_progress_get", args: {} });
        assert.ok(calls.some((call) => call.name === "task_progress_history"));
        assert.ok(calls.every((call) => !("threadId" in call.args) && !("path" in call.args)));
        const forbidden = await frame.locator("codex-task-panel").evaluate(async (element) => {
          try {
            await element.requester({
              method: "bind-heartbeat",
              threadId: "untrusted",
              path: "/tmp/untrusted",
            });
            return "unexpected-success";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
        assert.match(forbidden, /read-only task requests/);
        assert.equal(
          await page.evaluate(() =>
            window.hostCalls.some((call) => call.name === "task_progress_bind_heartbeat"),
          ),
          false,
        );
        assert.ok((await frame.locator("#native-panel-shell").boundingBox()).width <= 350);
        assert.ok(requests.every((requested) => requested.startsWith(url)));
        assert.equal(
          await frame
            .locator("body")
            .evaluate(() => localStorage.getItem("codex-task-progress:expanded")),
          "sentinel",
        );
      }),
    );

    await t.test("outer task refresh reloads the trusted task and updates visible progress", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        const refreshButton = frame.locator(".panel-head .panel-refresh");
        await refreshButton.waitFor();
        const before = await page.evaluate(
          () => window.hostCalls.filter((call) => call.name === "task_progress_get").length,
        );
        await page.evaluate(() => {
          window.currentResponse = {
            ...window.currentResponse,
            task: {
              ...window.currentResponse.task,
              title: "Manually refreshed task",
              progress: { completed: 2, total: 3, percent: 67 },
            },
          };
        });
        await refreshButton.click();
        await frame
          .getByRole("heading", { level: 2, name: "Manually refreshed task", exact: true })
          .waitFor();
        await page.waitForFunction(
          (previous) =>
            window.hostCalls.filter((call) => call.name === "task_progress_get").length > previous,
          before,
        );
        await frame.getByRole("progressbar").waitFor();
        assert.equal(await frame.getByRole("progressbar").getAttribute("aria-valuenow"), "67");
      }),
    );

    await t.test("one refresh icon stays on the outer header across History and Heartbeat", () =>
      scenario(async (_page, frame) => {
        await ready(frame);
        const outerRefresh = frame.locator(".panel-head .panel-refresh");
        await outerRefresh.waitFor();
        for (const tab of ["History", "Heartbeat"]) {
          await frame.getByRole("button", { name: tab, exact: true }).click();
          await frame.locator(".info-card-head").first().waitFor();
          assert.equal(await frame.locator(".panel-head .panel-refresh").count(), 1);
          assert.equal(
            await frame.locator(".info-card-head button[aria-label*='Refresh']").count(),
            0,
          );
        }
      }),
    );

    await t.test("manual refresh ignores stale response after the host changes identity", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.holdGet = true;
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, title: "STALE MANUAL REFRESH" },
          };
        });
        const refreshButton = frame.locator(".panel-head .panel-refresh");
        await refreshButton.click();
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        await page.evaluate(() => {
          const response = {
            ...window.currentResponse,
            task: {
              ...window.currentResponse.task,
              threadId: "thread-b",
              title: "Host identity B",
            },
          };
          window.currentResponse = response;
          window.currentThreadId = "thread-b";
          window.deliverToolResult("thread-b", response);
        });
        await frame
          .getByRole("heading", { level: 2, name: "Host identity B", exact: true })
          .waitFor();
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await page.waitForTimeout(150);
        assert.equal(
          await frame
            .getByRole("heading", { level: 2, name: "STALE MANUAL REFRESH", exact: true })
            .count(),
          0,
        );
        await frame
          .getByRole("heading", { level: 2, name: "Host identity B", exact: true })
          .waitFor();
        await waitForPanelThread(page, "thread-b");
      }),
    );

    await t.test("manual refresh disables duplicate clicks while its native read is pending", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.holdGet = true;
        });
        const refreshButton = frame.locator(".panel-head .panel-refresh");
        await refreshButton.click();
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        await page.waitForFunction(
          () =>
            document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
              ?.refreshing === true,
        );
        const during = await page.evaluate(
          () => window.hostCalls.filter((call) => call.name === "task_progress_get").length,
        );
        assert.equal(await refreshButton.isDisabled(), true);
        await frame.locator("codex-task-panel").evaluate(async (element) => {
          await element.refreshTask();
        });
        assert.equal(
          await page.evaluate(
            () => window.hostCalls.filter((call) => call.name === "task_progress_get").length,
          ),
          during,
        );
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await page.waitForFunction(
          () =>
            document.getElementById("app").contentWindow.document.querySelector("codex-task-panel")
              ?.refreshing === false,
        );
      }),
    );

    await t.test("taskless response accepts trusted metadata", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.noTask = true;
        });
        await refresh(page);
        await frame
          .getByText("A checklist appears when work is registered.", { exact: false })
          .waitFor();
        await waitForPanelThread(page, "conversation-verified-by-tool");
        assert.equal(await frame.locator("#native-panel-error").isVisible(), false);
        assert.equal(await frame.locator("#native-panel-retry").isVisible(), false);
      }),
    );

    await t.test("retryable task discovery remains neutral across identities and recovers", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.currentResponse = {
            task: null,
            heartbeat: null,
            taskSourcePending: true,
            taskSource: { status: "pending", retryable: true, readOnly: true },
          };
        });
        await refresh(page);
        await frame.getByText("Refreshing task source…", { exact: true }).first().waitFor();
        assert.equal(await frame.getByText("Reuse current task data", { exact: true }).count(), 0);
        assert.equal(await frame.getByText("Source error", { exact: true }).count(), 0);
        assert.equal(
          await frame.getByText("Start a task in this chat", { exact: false }).count(),
          0,
        );
        assert.equal(await frame.locator("#native-panel-error").isVisible(), false);
        await page.evaluate(() => {
          window.currentThreadId = "thread-b";
          window.deliverToolResult("thread-b", window.currentResponse);
        });
        await waitForPanelThread(page, "thread-b");
        assert.equal(await frame.getByText("Reuse current task data", { exact: true }).count(), 0);
        await page.evaluate(() => {
          window.currentResponse = {
            task: {
              ...window.initialTask,
              threadId: "thread-b",
              title: "Recovered task B",
              objectives: [{ ...window.initialTask.objectives[0], title: "Recovered B objective" }],
            },
            heartbeat: null,
          };
        });
        await refresh(page);
        await frame.locator(".summary .main").waitFor();
        if ((await frame.locator(".summary .main").getAttribute("aria-expanded")) !== "true")
          await frame.locator(".summary .main").click();
        await frame.getByRole("button", { name: "Registered tasks" }).click();
        await frame.getByText("Recovered B objective", { exact: true }).waitFor();
        await waitForPanelThread(page, "thread-b");
        assert.equal(await frame.getByText("Reuse current task data", { exact: true }).count(), 0);
        assert.equal(await frame.locator("#native-panel-error").isVisible(), false);
      }),
    );

    await t.test("missing and mismatched identity fail closed, visible retry recovers", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.noIdentity = true;
        });
        await refresh(page);
        await frame
          .getByRole("alert")
          .getByText(/Trusted conversation identity was not returned/)
          .waitFor();
        assert.equal(await frame.getByText("Reuse current task data", { exact: true }).count(), 0);
        await page.evaluate(() => {
          window.noIdentity = false;
          window.currentThreadId = "different-thread";
        });
        await frame.locator("#native-panel-retry").click();
        await frame
          .getByRole("alert")
          .getByText(/identity did not match/)
          .waitFor();
        await page.evaluate(() => {
          window.currentThreadId = "conversation-verified-by-tool";
        });
        await frame.locator("#native-panel-retry").click();
        await ready(frame);
        assert.equal(await frame.locator("#native-panel-retry").isVisible(), false);
      }),
    );

    await t.test("A to B to A rejects late refresh and history", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.holdNextHistory = true;
        });
        await frame.getByRole("button", { name: "History" }).click();
        await page.waitForFunction(() => typeof window.releaseHeldHistory === "function");
        await page.evaluate(() => {
          window.holdGet = true;
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, title: "STALE REFRESH" },
          };
        });
        await refresh(page);
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        await page.evaluate(() => {
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, title: "Native task panel" },
          };
          const value = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, threadId: "thread-b", title: "Thread B" },
          };
          window.deliverToolResult("thread-b", value);
        });
        await waitForPanelThread(page, "thread-b");
        await page.evaluate(() =>
          window.deliverToolResult("conversation-verified-by-tool", window.currentResponse),
        );
        await waitForPanelThread(page, "conversation-verified-by-tool");
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldHistory();
          window.releaseHeldGet();
        });
        await page.waitForFunction(() => window.heldHistoryDelivered);
        await page.waitForTimeout(150);
        assert.equal(await frame.getByText("STALE HISTORY", { exact: false }).count(), 0);
        await frame.locator(".summary .main").click();
        await ready(frame);
        assert.equal(
          await frame
            .getByRole("heading", { level: 2, name: "STALE REFRESH", exact: true })
            .count(),
          0,
        );
        await frame
          .getByRole("heading", { level: 2, name: "Native task panel", exact: true })
          .waitFor();
        await waitForPanelThread(page, "conversation-verified-by-tool");
      }),
    );

    await t.test(
      "late full history cannot roll back a newer task revision or repaint history",
      () =>
        scenario(async (page, frame) => {
          await ready(frame);
          await page.evaluate(() => {
            window.fullHistoryResponse = true;
            window.currentResponse = {
              ...window.currentResponse,
              presentation: { scope: "project-a", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
            window.holdNextHistory = true;
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.presentation
                ?.scope === "project-a",
          );
          await frame.getByRole("button", { name: "History" }).click();
          await page.waitForFunction(() => typeof window.releaseHeldHistory === "function");
          await page.evaluate(() => {
            window.currentResponse = {
              ...window.currentResponse,
              task: { ...window.currentResponse.task, revision: 4, title: "Newer task" },
            };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.task?.revision === 4,
          );
          await page.evaluate(() => {
            window.deliverToolResult(window.currentThreadId, {
              ...window.currentResponse,
              task: { ...window.currentResponse.task, revision: 3, title: "Stale history task" },
              history: {
                events: [
                  {
                    type: "task.updated",
                    occurredAt: "2026-11-15T11:00:00Z",
                    reason: "STALE PUSH HISTORY",
                  },
                ],
                nextCursor: null,
              },
            });
            window.releaseHeldHistory();
          });
          await page.waitForFunction(() => window.heldHistoryDelivered);
          await page
            .locator("#app")
            .evaluate(
              (iframe) =>
                new Promise((resolve) =>
                  iframe.contentWindow.requestAnimationFrame(() =>
                    iframe.contentWindow.requestAnimationFrame(resolve),
                  ),
                ),
            );
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((panel) => panel.data.task?.title),
            "Newer task",
          );
          assert.equal(await frame.getByText("STALE HISTORY", { exact: false }).count(), 0);
          assert.equal(await frame.getByText("STALE PUSH HISTORY", { exact: false }).count(), 0);
          await frame.getByText("OLD HISTORY", { exact: false }).waitFor();
          await page.evaluate(() => {
            window.deliverToolResult(window.currentThreadId, {
              ...window.currentResponse,
              task: {
                ...window.currentResponse.task,
                revision: 5,
                title: "Completed cycle",
                lifecycle: {
                  id: "old-cycle",
                  sequence: 1,
                  startedAt: "2026-11-15T11:00:00Z",
                  completion: { completedAt: "2026-11-15T11:59:00Z", receipt: null },
                },
              },
            });
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.task?.title ===
              "Completed cycle",
          );
          await page.evaluate(() => {
            window.deliverToolResult(window.currentThreadId, {
              ...window.currentResponse,
              task: {
                ...window.currentResponse.task,
                revision: 6,
                title: "New cycle",
                lifecycle: {
                  id: "new-cycle",
                  sequence: 2,
                  startedAt: "2026-11-15T12:00:00Z",
                  completion: null,
                },
              },
            });
          });
          await page.waitForFunction(
            () =>
              document
                .getElementById("app")
                .contentWindow.document.querySelector("codex-task-panel").data.task?.title ===
              "New cycle",
          );
          await page.evaluate(() =>
            window.deliverToolResult(window.currentThreadId, {
              ...window.currentResponse,
              task: {
                ...window.currentResponse.task,
                revision: 5,
                title: "Late old cycle",
                lifecycle: {
                  id: "old-cycle",
                  sequence: 1,
                  startedAt: "2026-11-15T11:00:00Z",
                  completion: { completedAt: "2026-11-15T11:59:00Z", receipt: null },
                },
              },
              history: { events: [], nextCursor: null },
            }),
          );
          await page
            .locator("#app")
            .evaluate(
              (iframe) =>
                new Promise((resolve) =>
                  iframe.contentWindow.requestAnimationFrame(() =>
                    iframe.contentWindow.requestAnimationFrame(resolve),
                  ),
                ),
            );
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((panel) => panel.data.task?.title),
            "New cycle",
          );
        }),
    );

    await t.test(
      "history-only push with presentation preserves the base and refreshes a new thread",
      () =>
        scenario(async (page, frame) => {
          await ready(frame);
          await page.evaluate(() => {
            const presentation = {
              scope: "project-a",
              pending: false,
              cached: false,
              updatedAt: 10,
            };
            window.currentResponse = { ...window.currentResponse, presentation };
            window.deliverToolResult(window.currentThreadId, window.currentResponse);
            window.deliverToolResult(window.currentThreadId, {
              history: { events: [], nextCursor: null },
              presentation,
            });
          });
          await page.waitForFunction(() => {
            const panel = document
              .getElementById("app")
              .contentWindow.document.querySelector("codex-task-panel");
            return (
              panel.data.task?.title === "Native task panel" &&
              panel.data.presentation?.scope === "project-a"
            );
          });
          await page.locator("#app").evaluate(
            (iframe) =>
              new Promise((resolve) => {
                iframe.contentWindow.requestAnimationFrame(() =>
                  iframe.contentWindow.requestAnimationFrame(resolve),
                );
              }),
          );
          assert.equal(
            await frame.locator("codex-task-panel").evaluate((panel) => panel.data.task?.title),
            "Native task panel",
          );
          await page.evaluate(() => {
            window.currentThreadId = "thread-b";
            window.currentResponse = {
              ...window.currentResponse,
              task: {
                ...window.currentResponse.task,
                threadId: "thread-b",
                title: "Fresh thread B",
              },
              presentation: { scope: "project-b", pending: false, cached: false, updatedAt: 10 },
            };
            window.deliverToolResult("thread-b", {
              history: { events: [], nextCursor: null },
              presentation: window.currentResponse.presentation,
            });
          });
          // The five-second poll must not be responsible for loading the new thread.
          await page.waitForFunction(
            () => window.hostCalls.filter((call) => call.name === "task_progress_get").length >= 2,
            null,
            { timeout: 2_000 },
          );
          await waitForPanelThread(page, "thread-b");
          await frame
            .getByRole("heading", { level: 2, name: "Fresh thread B", exact: true })
            .waitFor({ timeout: 2_000 });
        }),
    );

    await t.test("new same-thread host data wins over an earlier pending get", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.holdGet = true;
        });
        await refresh(page);
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        await page.evaluate(() => {
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, title: "New host update" },
          };
          window.deliverToolResult("conversation-verified-by-tool", window.currentResponse);
        });
        await frame
          .getByRole("heading", { level: 2, name: "New host update", exact: true })
          .waitFor();
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await page.waitForTimeout(150);
        await frame
          .getByRole("heading", { level: 2, name: "New host update", exact: true })
          .waitFor({ timeout: 2_000 });
        assert.equal(
          await frame
            .getByRole("heading", { level: 2, name: "Native task panel", exact: true })
            .count(),
          0,
        );
        await waitForPanelThread(page, "conversation-verified-by-tool");
      }),
    );

    await t.test("trusted data can arrive after the handshake deadline", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.holdGet = true;
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, title: "Slow trusted response" },
          };
        });
        await refresh(page);
        await page.waitForFunction(() => typeof window.releaseHeldGet === "function");
        // Use the real browser clock: AbortSignal.timeout may use a native clock that
        // Playwright's virtual timer does not advance. This crosses the old 5s limit.
        await page.waitForTimeout(6_200);
        assert.equal(await frame.locator("#native-panel-error").isVisible(), false);
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await frame
          .getByRole("heading", { level: 2, name: "Slow trusted response", exact: true })
          .waitFor();
        await waitForPanelThread(page, "conversation-verified-by-tool");
        assert.equal(await frame.locator("#native-panel-error").isVisible(), false);
      }),
    );

    await t.test("no host handshake times out visibly", () =>
      scenario(async (_page, frame) => {
        await frame.getByRole("alert").waitFor({ timeout: 7_000 });
        assert.ok((await frame.getByRole("alert").textContent())?.length > 0);
        assert.doesNotMatch(
          await frame.locator(".summary-state").textContent(),
          /Reading checklist/,
        );
      }, "/?nohost"),
    );

    await t.test("page teardown stops polling", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page
          .locator("#app")
          .evaluate((iframe) => iframe.contentWindow.dispatchEvent(new Event("pagehide")));
        const count = await page.evaluate(() => window.hostCalls.length);
        await page.waitForTimeout(5_250);
        assert.equal(await page.evaluate(() => window.hostCalls.length), count);
        assert.equal(await frame.locator("codex-task-panel").count(), 0);
      }),
    );
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin package keeps its self-contained panel outside dist and runtime release trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-task-panel-package-"));
  const output = join(root, "package");
  try {
    await buildPluginPackage({ outputRoot: output });
    const bundled = await readFile(join(output, "dist/plugin/task-progress-panel.html"), "utf8");
    const durable = await readFile(join(output, "assets/task-progress-panel.html"), "utf8");
    assert.equal(durable, bundled);
    await rm(join(output, "dist"), { recursive: true, force: true });
    await rm(join(output, "runtime"), { recursive: true, force: true });
    assert.equal(await readFile(join(output, "assets/task-progress-panel.html"), "utf8"), durable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
