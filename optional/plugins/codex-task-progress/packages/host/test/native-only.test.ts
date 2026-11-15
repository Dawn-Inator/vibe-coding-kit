import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServerRuntime } from "../../codex-adapter/src/index.js";
import { GoalProgressIpcClient } from "../../ipc/src/index.js";
import { resolveGoalProgressPaths } from "../../store/src/index.js";
import { GoalProgressHelper } from "../src/index.js";

test("native Helper starts and serves exact task reads without controlling Codex", async () => {
  const root = await mkdtemp("/tmp/ctph-native-only-");
  await mkdir(join(root, ".git"));
  const paths = resolveGoalProgressPaths({ root: join(root, "data") });
  let reads = 0;
  let closes = 0;
  const runtime: CodexAppServerRuntime = {
    async readThreadIdentity(threadId) {
      reads++;
      return {
        id: threadId,
        sessionId: threadId,
        cwd: root,
        threadSource: "user",
        agentRole: null,
        ephemeral: false,
        status: { type: "idle" },
      };
    },
    async resolveCurrentThread() {
      throw new Error("unexpected Goal lookup");
    },
    async getGoal() {
      throw new Error("unexpected Goal lookup");
    },
    async refreshGoalUsage() {
      throw new Error("unexpected Goal lookup");
    },
    watchGoalUsage() {},
    unwatchGoalUsage() {},
    setPollingMode() {},
    async close() {
      closes++;
    },
  };
  const helper = new GoalProgressHelper({ paths, runtime, resolveNativeGoal: async () => null });
  const client = new GoalProgressIpcClient(paths.helperSocketPath, { clientKind: "mcp" });
  const originalKill = process.kill;
  const signals: Array<string | number | undefined> = [];
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0) signals.push(signal);
    return originalKill(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  try {
    await helper.start();
    const response = await client.request({
      method: "task.native-read",
      params: { action: "get", threadId: "exact-chat", input: {} },
    });
    assert.equal(response.result !== null, true);
    assert.equal(reads, 1);
    assert.deepEqual(signals, []);
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /startup-listener|renderer-bridge|remote-debugging-port|launchCodex|process\.kill|\bspawn\s*\(/i,
    );
  } finally {
    await helper.stop();
    process.kill = originalKill;
    assert.equal(closes, 1);
    await rm(root, { recursive: true, force: true });
  }
});
