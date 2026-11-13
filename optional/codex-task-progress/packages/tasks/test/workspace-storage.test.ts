import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { TaskStore, TaskStoreError } from "../src/task-store.js";
import { WorkspaceTaskStorage } from "../src/workspace-storage.js";

const roots: string[] = [];
const managers: WorkspaceTaskStorage[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const key = (thread: string) => createHash("sha256").update(thread).digest("hex");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const legacy = join(root, "app");
  return { root, cwd, legacy, legacyStore: new TaskStore(legacy) };
}
function manager(legacy: string) {
  const instance = new WorkspaceTaskStorage(legacy, {
    kitPaths: [],
    heartbeat: { fallbackKitPath: null },
  });
  managers.push(instance);
  return instance;
}
function initialize(store: TaskStore, thread = "thread", title = "Task") {
  return store.initialize(thread, {
    requestId: `init-${title}`,
    expectedRevision: 0,
    reason: "Requested",
    title,
    objectives: [{ id: "A", title: "Build" }],
  });
}
const hasCode = (code: string) => (error: unknown) =>
  error instanceof TaskStoreError && error.code === code;

test("legacy JSONL migrates to canonical Markdown while full replay and source bytes remain exact", async () => {
  const { cwd, legacy, legacyStore } = await setup();
  await initialize(legacyStore);
  await legacyStore.update("thread", {
    requestId: "done",
    expectedRevision: 1,
    reason: "Verified build",
    changes: [
      {
        targetId: "A",
        status: "completed",
        evidence: [{ summary: "Build passed", verification: "verified" }],
      },
    ],
  });
  const sourceDirectory = join(legacy, "tasks/v3", key("thread"));
  const events = (await legacyStore.history("thread", { limit: 100 })).events;
  const originalEvents = `${[...events]
    .reverse()
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;
  await writeFile(join(sourceDirectory, "events.jsonl"), originalEvents);
  await rm(join(sourceDirectory, "taskhistory.md"));
  await rm(join(sourceDirectory, "heartbeat.md"));
  const router = manager(legacy);
  const context = await router.forThread("thread", cwd);
  assert.equal(context.storage.mode, "workspace");
  assert.equal(context.storage.cwd, await realpath(cwd));
  assert.equal(
    context.storage.root,
    resolve(await realpath(cwd), ".workspace/codex-task-progress"),
  );
  assert.equal(context.storage.migrated, true);
  assert.equal(context.storage.source, legacy);
  assert.ok(context.storage.taskhistoryPath?.endsWith("taskhistory.md"));
  assert.ok(context.storage.heartbeatPath?.endsWith("heartbeat.md"));
  const historyPath = context.storage.historyPath;
  assert.ok(historyPath);
  const migratedHistory = await readFile(historyPath, "utf8");
  for (const event of events) assert.ok(migratedHistory.includes(event.requestId));
  assert.deepEqual(
    (await context.taskStore.history("thread", { limit: 2 })).events.map((event) => event.revision),
    [2, 1],
  );
  assert.equal(await readFile(join(sourceDirectory, "events.jsonl"), "utf8"), originalEvents);
  await assert.rejects(stat(join(sourceDirectory, "taskhistory.md")));
  await assert.rejects(stat(join(context.storage.taskDirectory, "events.jsonl")));
  assert.deepEqual((await readdir(context.storage.taskDirectory)).sort(), [
    "heartbeat.md",
    "taskhistory.md",
  ]);
  assert.equal(await readFile(join(context.storage.root, ".gitignore"), "utf8"), "*\n");
  assert.equal((await stat(context.storage.root)).mode & 0o777, 0o700);
});

test("empty reads stay read-only and task writes create the private ignored Markdown store", async () => {
  const { cwd, legacy } = await setup();
  const context = await manager(legacy).forThread("empty", cwd);
  assert.equal(await context.taskStore.get("empty"), null);
  await assert.rejects(stat(join(cwd, ".workspace")), { code: "ENOENT" });
  await context.ensureWritable();
  await initialize(context.taskStore, "empty");
  assert.equal((await context.taskStore.get("empty"))?.revision, 1);
  const historyPath = context.storage.historyPath;
  assert.ok(historyPath);
  assert.ok((await readFile(historyPath, "utf8")).includes("task-event"));
  assert.equal(await readFile(join(context.storage.root, ".gitignore"), "utf8"), "*\n");
});

test("per-chat Markdown storage isolates projects and disposable cache is outside durable history", async () => {
  const { root, cwd, legacy } = await setup();
  const other = join(root, "second");
  await mkdir(join(other, ".git"), { recursive: true });
  const router = manager(legacy);
  const a = await router.forThread("chat-a", cwd);
  const b = await router.forThread("chat-b", other);
  await initialize(a.taskStore, "chat-a", "A");
  await initialize(b.taskStore, "chat-b", "B");
  assert.equal(await a.taskStore.get("chat-b"), null);
  assert.equal(await b.taskStore.get("chat-a"), null);
  assert.notEqual(a.storage.historyPath, b.storage.historyPath);
  assert.ok(a.storage.cacheRoot?.startsWith(join(await realpath(cwd), ".tmp/codex-task-progress")));
  assert.ok(
    b.storage.cacheRoot?.startsWith(join(await realpath(other), ".tmp/codex-task-progress")),
  );
  assert.equal((await a.taskStore.history("chat-a")).events.length, 1);
});

test("moving cwd carries task events but does not carry the previous project's source relation", async () => {
  const { root, cwd, legacy } = await setup();
  const other = join(root, "next-project");
  await mkdir(join(other, ".git"), { recursive: true });
  const router = manager(legacy);
  const initial = await router.forThread("moving", cwd);
  await initialize(initial.taskStore, "moving", "Continue");
  await initial.heartbeat.bind("moving", null, cwd);
  const moved = await router.forThread("moving", other);
  const initialHistoryPath = initial.storage.historyPath;
  const movedHistoryPath = moved.storage.historyPath;
  assert.ok(initialHistoryPath);
  assert.ok(movedHistoryPath);
  const priorHistory = await readFile(initialHistoryPath, "utf8");
  assert.equal((await moved.taskStore.get("moving"))?.title, "Continue");
  assert.equal((await moved.taskStore.history("moving")).events.length, 1);
  assert.equal(await moved.heartbeat.view("moving", other), null);
  assert.equal(await readFile(initialHistoryPath, "utf8"), priorHistory);
  assert.equal(
    (await readFile(movedHistoryPath, "utf8")).includes('"type":"source-binding"'),
    false,
  );
});

test("workspace router reuses heartbeat service for cwd aliases and closes it on project move", async () => {
  const { root, cwd, legacy } = await setup();
  const alias = join(root, "project-alias");
  await symlink(cwd, alias, "dir");
  const other = join(root, "other-project");
  await mkdir(join(other, ".git"), { recursive: true });
  const router = manager(legacy);
  const initial = await router.forThread("lifecycle-chat", cwd);
  let closeCalls = 0;
  const originalClose = initial.heartbeat.close.bind(initial.heartbeat);
  initial.heartbeat.close = () => {
    closeCalls += 1;
    originalClose();
  };

  const throughAlias = await router.forThread("lifecycle-chat", alias);
  assert.strictEqual(throughAlias.heartbeat, initial.heartbeat);
  assert.equal(closeCalls, 0);

  const moved = await router.forThread("lifecycle-chat", other);
  assert.notStrictEqual(moved.heartbeat, initial.heartbeat);
  assert.equal(closeCalls, 1);
});

test("invalid trusted cwd and blocked workspace roots fail closed", async () => {
  const { cwd, legacy } = await setup();
  const router = manager(legacy);
  await assert.rejects(router.forThread("thread", "relative"), hasCode("TASK_WORKSPACE_INVALID"));
  await assert.rejects(
    router.forThread("thread", join(cwd, "missing")),
    hasCode("TASK_WORKSPACE_INVALID"),
  );
  await writeFile(join(cwd, ".workspace"), "blocked");
  await assert.rejects(router.forThread("thread", cwd), hasCode("TASK_WORKSPACE_UNWRITABLE"));
  assert.equal(await new TaskStore(legacy).get("thread"), null);
});

test("default Kit resolver honors project-local Kit and configured heartbeat kitPath contracts", async () => {
  const { root, legacy } = await setup();
  const projectKitCwd = join(root, "project-kit");
  const configuredKitCwd = join(root, "configured-kit");
  await mkdir(join(projectKitCwd, ".git"), { recursive: true });
  await mkdir(join(configuredKitCwd, ".git"), { recursive: true });
  const contractSource = () => `
    import { resolve } from "node:path";
    export function resolveTaskProgressStorage({ cwd }) {
      return { schemaVersion: 2, mode: "workspace", cwd,
        workspaceRoot: resolve(cwd, ".workspace"),
        storageRoot: resolve(cwd, ".workspace/codex-task-progress"),
        cacheRoot: resolve(cwd, ".tmp/codex-task-progress") };
    }
  `;
  const projectContract = join(
    projectKitCwd,
    ".vibe-coding/kit/src/contracts/task-progress-storage.mjs",
  );
  await mkdir(join(projectKitCwd, ".vibe-coding/kit/src/contracts"), { recursive: true });
  await writeFile(projectContract, contractSource());

  const configuredApi = join(
    configuredKitCwd,
    "local-kit/src/supervision/heartbeat-ledger-api.mjs",
  );
  const configuredContract = join(
    configuredKitCwd,
    "local-kit/src/contracts/task-progress-storage.mjs",
  );
  await mkdir(join(configuredKitCwd, "local-kit/src/supervision"), { recursive: true });
  await mkdir(join(configuredKitCwd, "local-kit/src/contracts"), { recursive: true });
  await writeFile(configuredApi, "export {};\n");
  await writeFile(configuredContract, contractSource());
  await writeFile(
    join(configuredKitCwd, ".codex-task-progress.json"),
    JSON.stringify({
      heartbeat: { kitPath: "local-kit/src/supervision/heartbeat-ledger-api.mjs" },
    }),
  );

  const router = new WorkspaceTaskStorage(legacy, { heartbeat: { fallbackKitPath: null } });
  managers.push(router);
  const canonicalProjectContract = join(
    await realpath(projectKitCwd),
    ".vibe-coding/kit/src/contracts/task-progress-storage.mjs",
  );
  const canonicalConfiguredContract = join(
    await realpath(configuredKitCwd),
    "local-kit/src/contracts/task-progress-storage.mjs",
  );
  assert.equal(
    (await router.forThread("project-kit-chat", projectKitCwd)).storage.contractSource,
    canonicalProjectContract,
  );
  assert.equal(
    (await router.forThread("configured-kit-chat", configuredKitCwd)).storage.contractSource,
    canonicalConfiguredContract,
  );
});
