import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TaskStore, TaskStoreError } from "../src/task-store.js";
import { calculateTaskProgress, TaskObjectivesSchema } from "../src/task-types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "task-progress-test-"));
  roots.push(root);
  return { root, store: new TaskStore(root) };
}
const evidence = [
  { summary: "Meaningful test passed", verification: "verified" as const, kind: "test" },
];
const objectives = [
  {
    id: "C1",
    title: "Implementation",
    items: [
      { id: "C1.1", title: "Build" },
      { id: "C1.2", title: "Verify" },
    ],
  },
];
function hasCode(code: string) {
  return (error: unknown) => error instanceof TaskStoreError && error.code === code;
}

test("ordinary task reaches 100%, then rescope regresses and captures before/after", async () => {
  const { store } = await setup();
  assert.equal(await store.get("thread"), null);
  const initial = await store.initialize("thread", {
    requestId: "init",
    expectedRevision: 0,
    reason: "New task",
    title: "Work",
    objectives,
  });
  assert.deepEqual(initial.state.progress, { completed: 0, total: 2, percent: 0 });
  const done = await store.update("thread", {
    requestId: "done",
    expectedRevision: 1,
    reason: "Validated",
    changes: [
      { targetId: "C1.1", status: "completed", evidence },
      { targetId: "C1.2", status: "completed", evidence },
    ],
  });
  assert.equal(done.state.phase, "completed");
  assert.equal(done.state.progress.percent, 100);
  const expanded = await store.rescope("thread", {
    requestId: "expand",
    expectedRevision: 2,
    reason: "Additional delivery requested",
    objectives: [...done.state.objectives, { id: "C2", title: "New requirement" }],
  });
  assert.equal(expanded.state.progress.percent, 66.67);
  assert.equal(expanded.state.phase, "active");
  const history = await store.history("thread", { limit: 1 });
  assert.equal(history.events[0]?.before?.percent, 100);
  assert.equal(history.events[0]?.after.percent, 66.67);
  assert.equal(history.events[0]?.reason, "Additional delivery requested");
  assert.equal(history.nextCursor, "3");
  const previous = await store.history("thread", { cursor: history.nextCursor ?? "", limit: 2 });
  assert.deepEqual(
    previous.events.map((event) => event.revision),
    [2, 1],
  );
  assert.equal(previous.nextCursor, null);
});

test("optional and cancelled items excluded; empty denominator has no percentage", () => {
  const parsed = TaskObjectivesSchema.parse([
    {
      id: "A",
      title: "A",
      items: [
        { id: "a1", title: "a1", status: "completed", evidence },
        { id: "a2", title: "a2", status: "cancelled" },
      ],
    },
    { id: "B", title: "B", required: false },
    { id: "C", title: "C", status: "cancelled" },
  ]);
  assert.deepEqual(calculateTaskProgress(parsed), { completed: 1, total: 1, percent: 100 });
  assert.deepEqual(calculateTaskProgress([]), { completed: 0, total: 0, percent: null });
});

test("completed leaves require evidence; reported and verified are retained", async () => {
  const { store } = await setup();
  await store.initialize("thread", {
    requestId: "init",
    expectedRevision: 0,
    reason: "Task",
    title: "Work",
    objectives,
  });
  await assert.rejects(
    store.update("thread", {
      requestId: "bad",
      expectedRevision: 1,
      reason: "No evidence",
      changes: [{ targetId: "C1.1", status: "completed" }],
    }),
  );
  const result = await store.update("thread", {
    requestId: "good",
    expectedRevision: 1,
    reason: "Report",
    changes: [
      {
        targetId: "C1.1",
        status: "completed",
        evidence: [{ summary: "Model reports implementation", verification: "reported" }],
      },
    ],
  });
  assert.equal(result.state.objectives[0]?.items[0]?.evidence[0]?.verification, "reported");
  assert.equal(result.state.revision, 2);
});

test("retries deduplicate and changed request IDs cannot reuse prior payload", async () => {
  const { store } = await setup();
  const input = {
    requestId: "init",
    expectedRevision: 0 as const,
    reason: "Task",
    title: "Work",
    objectives,
  };
  await store.initialize("thread", input);
  assert.equal((await store.initialize("thread", input)).duplicate, true);
  await assert.rejects(
    store.initialize("thread", { ...input, title: "Changed" }),
    hasCode("TASK_REQUEST_CONFLICT"),
  );
  assert.equal((await store.history("thread")).events.length, 1);
});

test("concurrent updates enforce revision and allow retry after conflict", async () => {
  const { store, root } = await setup();
  await store.initialize("thread", {
    requestId: "init",
    expectedRevision: 0,
    reason: "Task",
    title: "Work",
    objectives,
  });
  const another = new TaskStore(root);
  const settled = await Promise.allSettled([
    store.update("thread", {
      requestId: "one",
      expectedRevision: 1,
      reason: "First",
      changes: [{ targetId: "C1.1", status: "active" }],
    }),
    another.update("thread", {
      requestId: "two",
      expectedRevision: 1,
      reason: "Second",
      changes: [{ targetId: "C1.2", status: "active" }],
    }),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.get("thread"))?.revision, 2);
});

test("rescope preserves removed entries as cancelled and reopening changes the count", async () => {
  const { store } = await setup();
  await store.initialize("thread", {
    requestId: "init",
    expectedRevision: 0,
    reason: "Task",
    title: "Work",
    objectives,
  });
  const result = await store.rescope("thread", {
    requestId: "remove",
    expectedRevision: 1,
    reason: "No longer needed",
    objectives: [{ id: "C1", title: "Implementation", items: [{ id: "C1.1", title: "Build" }] }],
  });
  assert.equal(result.state.objectives[0]?.items[1]?.status, "cancelled");
  assert.equal(result.state.progress.total, 1);
  const reopened = await store.update("thread", {
    requestId: "reopen",
    expectedRevision: 2,
    reason: "Needed again",
    changes: [{ targetId: "C1.2", status: "pending" }],
  });
  assert.equal(reopened.state.progress.total, 2);
});

test("restart rebuilds a missing Markdown head while preserving legacy backups and rejecting corruption", async () => {
  const { store, root } = await setup();
  await store.initialize("thread", {
    requestId: "init",
    expectedRevision: 0,
    reason: "Task",
    title: "Work",
    objectives,
  });
  const directory = join(root, "tasks", "v3", createHash("sha256").update("thread").digest("hex"));
  const updated = await store.update("thread", {
    requestId: "start-build",
    expectedRevision: 1,
    reason: "Begin implementation",
    changes: [{ targetId: "C1.1", status: "active" }],
  });
  const historyPath = join(directory, "taskhistory.md");
  const headPath = join(directory, "heartbeat.md");
  const historyBefore = await readFile(historyPath, "utf8");
  const legacyEventsPath = join(directory, "events.jsonl");
  const legacySnapshotPath = join(directory, "snapshot.json");
  const legacyEvents = `${(await store.history("thread", { limit: 100 })).events
    .reverse()
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;
  const legacySnapshot = '{"legacyBackup":"preserve verbatim"}\n';
  await writeFile(legacyEventsPath, legacyEvents);
  await writeFile(legacySnapshotPath, legacySnapshot);
  const legacyEventsBefore = await readFile(legacyEventsPath, "utf8");
  const legacySnapshotBefore = await readFile(legacySnapshotPath, "utf8");

  await rm(headPath);
  const restored = await new TaskStore(root).get("thread");
  assert.deepEqual(restored, updated.state);
  assert.ok((await readFile(headPath, "utf8")).includes("json task-heartbeat-v1"));
  assert.equal(await readFile(historyPath, "utf8"), historyBefore);
  assert.equal(await readFile(legacyEventsPath, "utf8"), legacyEventsBefore);
  assert.equal(await readFile(legacySnapshotPath, "utf8"), legacySnapshotBefore);

  const corruptHead = "# damaged managed task head\n";
  await writeFile(headPath, corruptHead);
  await assert.rejects(new TaskStore(root).get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
  assert.equal(await readFile(headPath, "utf8"), corruptHead);
  assert.equal(await readFile(historyPath, "utf8"), historyBefore);
  assert.equal(await readFile(legacyEventsPath, "utf8"), legacyEventsBefore);
  assert.equal(await readFile(legacySnapshotPath, "utf8"), legacySnapshotBefore);

  const cleanDirectory = join(
    root,
    "tasks",
    "v3",
    createHash("sha256").update("clean-chat").digest("hex"),
  );
  await store.initialize("clean-chat", {
    requestId: "clean-init",
    expectedRevision: 0,
    reason: "No legacy formats for new chats",
    title: "Clean task",
    objectives,
  });
  await assert.rejects(access(join(cleanDirectory, "events.jsonl")), { code: "ENOENT" });
  await assert.rejects(access(join(cleanDirectory, "snapshot.json")), { code: "ENOENT" });
});

test("thread histories stay isolated and invalid pagination is rejected", async () => {
  const { store } = await setup();
  await store.initialize("thread-one", {
    requestId: "same",
    expectedRevision: 0,
    reason: "Task",
    title: "One",
    objectives,
  });
  await store.initialize("thread-two", {
    requestId: "same",
    expectedRevision: 0,
    reason: "Task",
    title: "Two",
    objectives,
  });
  assert.equal((await store.get("thread-one"))?.title, "One");
  assert.equal((await store.get("thread-two"))?.title, "Two");
  await assert.rejects(
    store.history("thread-one", { cursor: "invalid" }),
    hasCode("TASK_HISTORY_CURSOR_INVALID"),
  );
  await assert.rejects(
    store.history("thread-one", { limit: 0 }),
    hasCode("TASK_HISTORY_PAGE_INVALID"),
  );
});
