import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

test("legacy history migrates exactly into trusted cwd workspace and originals remain", async () => {
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
  const legacyDirectory = join(legacy, "tasks/v3", key("thread"));
  const original = await readFile(join(legacyDirectory, "events.jsonl"), "utf8");
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
  assert.equal(
    await readFile(join(context.storage.taskDirectory, "events.jsonl"), "utf8"),
    original,
  );
  assert.equal(await readFile(join(legacyDirectory, "events.jsonl"), "utf8"), original);
  assert.equal((await context.taskStore.get("thread"))?.revision, 2);
  assert.deepEqual(
    (await context.taskStore.history("thread", { limit: 2 })).events.map((event) => event.revision),
    [2, 1],
  );
  assert.equal(await readFile(join(context.storage.root, ".gitignore"), "utf8"), "*\n");
  assert.equal((await stat(context.storage.root)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(context.storage.taskDirectory, "events.jsonl"))).mode & 0o777,
    0o600,
  );
});

test("empty reads do not create workspace; explicit write preparation creates ignored private root", async () => {
  const { cwd, legacy } = await setup();
  const context = await manager(legacy).forThread("empty", cwd);
  assert.equal(await context.taskStore.get("empty"), null);
  await assert.rejects(
    stat(join(cwd, ".workspace")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  await context.ensureWritable();
  await initialize(context.taskStore, "empty");
  assert.equal((await context.taskStore.get("empty"))?.revision, 1);
  assert.equal(await readFile(join(context.storage.root, ".gitignore"), "utf8"), "*\n");
});

test("workspace advances independently; retained legacy data is not reimported after restart", async () => {
  const { cwd, legacy, legacyStore } = await setup();
  await initialize(legacyStore);
  const first = manager(legacy);
  const context = await first.forThread("thread", cwd);
  await context.taskStore.rescope("thread", {
    requestId: "expand",
    expectedRevision: 1,
    reason: "New work",
    objectives: [
      { id: "A", title: "Build" },
      { id: "B", title: "Ship" },
    ],
  });
  first.close();
  const resumed = await manager(legacy).forThread("thread", cwd);
  assert.equal(resumed.storage.migrated, false);
  assert.equal((await resumed.taskStore.get("thread"))?.revision, 2);
  assert.equal((await legacyStore.get("thread"))?.revision, 1);
});

test("existing divergent workspace history is never overwritten or silently merged", async () => {
  const { cwd, legacy, legacyStore } = await setup();
  await initialize(legacyStore, "thread", "Legacy");
  const destination = new TaskStore(join(cwd, ".workspace/codex-task-progress"));
  await initialize(destination, "thread", "Workspace");
  const path = join(cwd, ".workspace/codex-task-progress/tasks/v3", key("thread"), "events.jsonl");
  const before = await readFile(path, "utf8");
  await assert.rejects(manager(legacy).forThread("thread", cwd), hasCode("TASK_STORAGE_DIVERGED"));
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await legacyStore.get("thread"))?.title, "Legacy");
});

test("existing workspace extension of legacy history remains authoritative", async () => {
  const { cwd, legacy, legacyStore } = await setup();
  await initialize(legacyStore);
  const initial = manager(legacy);
  const imported = await initial.forThread("thread", cwd);
  await imported.taskStore.rescope("thread", {
    requestId: "more",
    expectedRevision: 1,
    reason: "More",
    objectives: [
      { id: "A", title: "Build" },
      { id: "B", title: "More" },
    ],
  });
  await rm(join(legacy, "workspace-storage-index.json"));
  initial.close();
  const context = await manager(legacy).forThread("thread", cwd);
  assert.equal((await context.taskStore.get("thread"))?.revision, 2);
  assert.equal(context.storage.migrated, false);
});

test("two projects and two chats remain isolated; cwd move copies latest indexed state", async () => {
  const { root, cwd, legacy } = await setup();
  const other = join(root, "second");
  await mkdir(join(other, ".git"), { recursive: true });
  const router = manager(legacy);
  const a = await router.forThread("chat-a", cwd);
  const b = await router.forThread("chat-b", other);
  await a.ensureWritable();
  await b.ensureWritable();
  await initialize(a.taskStore, "chat-a", "A");
  await initialize(b.taskStore, "chat-b", "B");
  assert.equal(await a.taskStore.get("chat-b"), null);
  assert.equal(await b.taskStore.get("chat-a"), null);
  const sameProject = await router.forThread("chat-c", cwd);
  await sameProject.ensureWritable();
  await initialize(sameProject.taskStore, "chat-c", "C");
  assert.notEqual(a.storage.taskDirectory, sameProject.storage.taskDirectory);
  assert.notEqual(a.storage.heartbeatDirectory, sameProject.storage.heartbeatDirectory);
  const moved = await router.forThread("chat-a", other);
  assert.equal(moved.storage.migrated, true);
  assert.equal(moved.storage.source, a.storage.root);
  assert.equal((await moved.taskStore.get("chat-a"))?.title, "A");
  assert.equal((await moved.taskStore.get("chat-b"))?.title, "B");
});

test("only current chat heartbeat binding and observations migrate", async () => {
  const { cwd, legacy } = await setup();
  const heartbeat = join(legacy, "heartbeat");
  await mkdir(heartbeat, { recursive: true });
  await writeFile(
    join(heartbeat, "bindings.json"),
    JSON.stringify({ thread: null, foreign: "/do-not-copy/heartbeat.md" }),
  );
  await writeFile(join(heartbeat, `${key("thread")}.jsonl`), '{"type":"heartbeat.observed"}\n');
  await writeFile(join(heartbeat, `${key("thread")}.snapshot.json`), '{"key":"test","view":{}}');
  await writeFile(join(heartbeat, `${key("foreign")}.jsonl`), "foreign\n");
  const context = await manager(legacy).forThread("thread", cwd);
  assert.deepEqual(
    JSON.parse(await readFile(join(context.storage.heartbeatDirectory, "bindings.json"), "utf8")),
    { thread: null },
  );
  assert.equal(
    await readFile(join(context.storage.heartbeatDirectory, `${key("thread")}.jsonl`), "utf8"),
    '{"type":"heartbeat.observed"}\n',
  );
  await assert.rejects(stat(join(context.storage.heartbeatDirectory, `${key("foreign")}.jsonl`)));
  assert.equal(await readFile(join(heartbeat, `${key("foreign")}.jsonl`), "utf8"), "foreign\n");
  assert.equal(await context.heartbeat.view("thread", cwd), null);
});

test("concurrent same-thread resolution imports once and returns one context", async () => {
  const { cwd, legacy, legacyStore } = await setup();
  await initialize(legacyStore);
  const router = manager(legacy);
  const [a, b] = await Promise.all([
    router.forThread("thread", cwd),
    router.forThread("thread", cwd),
  ]);
  assert.strictEqual(a, b);
  assert.equal((await a.taskStore.history("thread")).events.length, 1);
});

test("relative, unavailable and blocked workspace paths fail without global fallback writes", async () => {
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

test("moving a chat cwd transfers task history without carrying the prior project's heartbeat", async () => {
  const { root, cwd, legacy } = await setup();
  const other = join(root, "next-project");
  await mkdir(join(other, ".git"), { recursive: true });
  const router = manager(legacy);
  const initial = await router.forThread("moving", cwd);
  await initial.ensureWritable();
  await initialize(initial.taskStore, "moving", "Continue");
  await mkdir(initial.storage.heartbeatDirectory, { recursive: true });
  await writeFile(
    join(initial.storage.heartbeatDirectory, "bindings.json"),
    JSON.stringify({ moving: join(cwd, "heartbeat.md") }),
  );
  await writeFile(
    join(initial.storage.heartbeatDirectory, `${key("moving")}.jsonl`),
    "old-project-observation\n",
  );
  const moved = await router.forThread("moving", other);
  assert.equal((await moved.taskStore.get("moving"))?.title, "Continue");
  await assert.rejects(
    stat(moved.storage.heartbeatDirectory),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(await moved.heartbeat.view("moving", other), null);
  assert.ok(await readFile(join(initial.storage.heartbeatDirectory, "bindings.json"), "utf8"));
});
