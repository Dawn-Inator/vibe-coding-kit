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
window.noIdentity=false;
window.noTask=false;
window.currentThreadId='conversation-verified-by-tool';
window.holdGet=false;
window.releaseHeldGet=null;
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
    } else if(name === 'task_progress_history') {
      const {task:ignoredTask,...responseWithoutTask}=window.currentResponse;
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:{...responseWithoutTask,history:{events:[{type:'task.updated',occurredAt:'2026-11-15T11:00:00Z',reason:holdThisHistory?'STALE HISTORY':'OLD HISTORY'}],nextCursor:null}}})}],_meta:{'codex-task-progress/threadId':window.currentThreadId}};
    } else if(name === 'task_progress_heartbeat_history') {
      const {task:ignoredTask,...responseWithoutTask}=window.currentResponse;
      result={content:[{type:'text',text:JSON.stringify({ok:true,result:{...responseWithoutTask,heartbeatHistory:{wakes:[],nextCursor:null,total:0,sourcePath:window.currentResponse.heartbeat?.sourcePath}}})}],_meta:{'codex-task-progress/threadId':window.currentThreadId}};
    } else {
      result={content:[{type:'text',text:JSON.stringify({ok:false,summary:'Unexpected tool call.'})}],isError:true};
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
    async function scenario(run, suffix = "") {
      const preferredColorScheme = new URLSearchParams(suffix).get("theme");
      const context = await browser.newContext({
        viewport: { width: 350, height: 740 },
        ...(preferredColorScheme ? { colorScheme: preferredColorScheme } : {}),
      });
      await context.addInitScript(() =>
        localStorage.setItem("codex-task-progress:expanded", "sentinel"),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
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
    async function ready(frame) {
      const main = frame.locator(".summary .main");
      await main.waitFor();
      if ((await main.getAttribute("aria-expanded")) !== "true") await main.click();
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
          await frame.locator(".hb-status[data-status=ready]").waitFor();
          const heartbeatColor = await frame.locator("codex-task-panel").evaluate((element) => {
            const status = element.shadowRoot.querySelector(".hb-status[data-status='ready']");
            return {
              status: getComputedStyle(status).color,
              muted: getComputedStyle(element.shadowRoot.querySelector(".hb-refresh")).color,
              certification: status.getAttribute("data-certification"),
            };
          });
          const [history, status, muted] = await normalizeColors(frame, [
            historyColor,
            heartbeatColor.status,
            heartbeatColor.muted,
          ]);
          assert.ok(sameColor(history, percent));
          assert.equal(heartbeatColor.certification, "current-unknown");
          assert.ok(sameColor(status, muted));
          assert.ok(!sameColor(status, green));
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
        assert.equal(await frame.getByText("STALE REFRESH", { exact: true }).count(), 0);
        await frame.locator(".summary .main").click();
        await ready(frame);
        await waitForPanelThread(page, "conversation-verified-by-tool");
      }),
    );

    await t.test("history-only push for a new thread immediately refreshes its data", () =>
      scenario(async (page, frame) => {
        await ready(frame);
        await page.evaluate(() => {
          window.currentThreadId = "thread-b";
          window.currentResponse = {
            ...window.currentResponse,
            task: { ...window.currentResponse.task, threadId: "thread-b", title: "Fresh thread B" },
          };
          window.deliverToolResult("thread-b", { history: { events: [], nextCursor: null } });
        });
        // The five-second poll must not be responsible for loading the new thread.
        await page.waitForFunction(
          () => window.hostCalls.filter((call) => call.name === "task_progress_get").length >= 2,
          null,
          { timeout: 2_000 },
        );
        await waitForPanelThread(page, "thread-b");
        await frame
          .getByRole("heading", { name: "Fresh thread B", exact: true })
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
        await frame.getByRole("heading", { name: "New host update", exact: true }).waitFor();
        await page.evaluate(() => {
          window.holdGet = false;
          window.releaseHeldGet();
        });
        await page.waitForTimeout(150);
        await frame
          .getByRole("heading", { name: "New host update", exact: true })
          .waitFor({ timeout: 2_000 });
        assert.equal(await frame.getByText("Native task panel", { exact: true }).count(), 0);
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
        await frame.getByRole("heading", { name: "Slow trusted response", exact: true }).waitFor();
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
