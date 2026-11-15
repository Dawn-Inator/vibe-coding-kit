// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TaskStore, TaskStoreError } from "../../src/tasks/task-store.mjs";
import { z } from "zod";
import {
	calculateTaskProgress,
	createTaskProgressSchemas,
} from "../../src/tasks/task-contract.mjs";
const schemas = createTaskProgressSchemas(z);
const { TaskObjectivesSchema } = schemas;

const roots = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "task-progress-test-"));
	roots.push(root);
	return { root, store: new TaskStore(root, { schemas }) };
}
const evidence = [
	{ summary: "Meaningful test passed", verification: "verified", kind: "test" },
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
function hasCode(code) {
	return (error) => error instanceof TaskStoreError && error.code === code;
}

test("summary history bounds wide events, traverses every revision and preserves raw records", async () => {
	const { root, store } = await setup();
	await store.initialize("thread", {
		requestId: "init", expectedRevision: 0, reason: "Initial", title: "Wide",
		objectives: Array.from({ length: 90 }, (_, i) => ({
			id: `objective-${i}`, title: "Wide objective ".repeat(40),
			items: Array.from({ length: 20 }, (_, j) => ({ id: `item-${i}-${j}`, title: "Wide item ".repeat(40) })),
		})),
	});
	const raw = await store.history("thread");
	const path = (await import("../../src/tasks/task-store.mjs")).taskMarkdownPaths(root, "thread").history;
	const canonicalBefore = await readFile(path, "utf8");
	const event = raw.events[0];
	const many = Array.from({ length: 100 }, (_, i) => ({ ...event, revision: i + 1, reason: "\u0001".repeat(3000) }));
	const replay = store.replay;
	store.replay = async () => many;
	let cursor;
	const revisions = [];
	do {
		const page = await store.history("thread", { projection: "summary", limit: 100, ...(cursor ? { cursor } : {}) });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
		assert.equal(page.canonicalHistoryPath, path);
		for (const summary of page.events) {
			assert.equal("state" in summary, false);
			assert.equal(summary.reasonTruncated, true);
			assert.deepEqual(summary.after, event.after);
			revisions.push(summary.revision);
		}
		cursor = page.nextCursor;
	} while (cursor);
	assert.deepEqual(revisions, Array.from({ length: 100 }, (_, i) => 100 - i));
	assert.equal(many[0].reason.length, 3000);
	store.replay = replay;
	assert.deepEqual(await store.history("thread"), raw);
	assert.equal(await readFile(path, "utf8"), canonicalBefore);
	assert.deepEqual((await store.history("absent", { projection: "summary" })).events, []);
});

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
	assert.deepEqual(initial.state.progress, {
		completed: 0,
		total: 2,
		percent: 0,
	});
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
		objectives: [
			...done.state.objectives,
			{ id: "C2", title: "New requirement" },
		],
	});
	assert.equal(expanded.state.progress.percent, 66.67);
	assert.equal(expanded.state.phase, "active");
	const history = await store.history("thread", { limit: 1 });
	assert.equal(history.events[0]?.before?.percent, 100);
	assert.equal(history.events[0]?.after.percent, 66.67);
	assert.equal(history.events[0]?.reason, "Additional delivery requested");
	assert.equal(history.nextCursor, "3");
	const previous = await store.history("thread", {
		cursor: history.nextCursor ?? "",
		limit: 2,
	});
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
	assert.deepEqual(calculateTaskProgress(parsed), {
		completed: 1,
		total: 1,
		percent: 100,
	});
	assert.deepEqual(calculateTaskProgress([]), {
		completed: 0,
		total: 0,
		percent: null,
	});
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
				evidence: [
					{ summary: "Model reports implementation", verification: "reported" },
				],
			},
		],
	});
	assert.equal(
		result.state.objectives[0]?.items[0]?.evidence[0]?.verification,
		"reported",
	);
	assert.equal(result.state.revision, 2);
});

test("retries deduplicate and changed request IDs cannot reuse prior payload", async () => {
	const { store } = await setup();
	const input = {
		requestId: "init",
		expectedRevision: 0,
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
	const another = new TaskStore(root, { schemas });
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
	assert.equal(
		settled.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		settled.filter((result) => result.status === "rejected").length,
		1,
	);
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
		objectives: [
			{
				id: "C1",
				title: "Implementation",
				items: [{ id: "C1.1", title: "Build" }],
			},
		],
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

test("legacy import preserves bytes and rebuilds heartbeat on restart", async () => {
	const { store, root } = await setup();
	const initial = await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const directory = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
	);
	const event = (await store.history("thread")).events[0];
	const legacy = `${JSON.stringify(event)}\n{"truncated":`;
	await writeFile(join(directory, "events.jsonl"), legacy);
	await rm(join(directory, "heartbeat.md"));
	assert.deepEqual(
		await new TaskStore(root, { schemas }).get("thread"),
		initial.state,
	);
	assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), legacy);
	assert.match(
		await readFile(join(directory, "heartbeat.md"), "utf8"),
		/task-heartbeat-v1/,
	);
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

test("committed corruption is rejected instead of silently truncated", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const directory = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
	);
	await appendFile(join(directory, "events.jsonl"), '{"bad":true}\n');
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
});

test("migration preserves full unterminated legacy event and request retry", async () => {
	const { store, root } = await setup();
	const input = {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	};
	const original = await store.initialize("thread", input);
	const event = (await store.history("thread")).events[0];
	const directory = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
	);
	const old = JSON.stringify(event);
	await writeFile(join(directory, "events.jsonl"), old);
	await rm(join(directory, "taskhistory.md"));
	await rm(join(directory, "heartbeat.md"));
	const reopened = new TaskStore(root, { schemas });
	assert.deepEqual(await reopened.get("thread"), original.state);
	assert.deepEqual((await reopened.history("thread")).events, [event]);
	assert.equal((await reopened.initialize("thread", input)).duplicate, true);
	assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), old);
	assert.deepEqual(
		await new TaskStore(root, { schemas }).get("thread"),
		original.state,
	);
});

test("prefix migration is repeatable, divergence fails and lost history fails closed", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const first = (await store.history("thread")).events[0];
	await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const events = (await store.history("thread")).events.reverse();
	const directory = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
	);
	await writeFile(
		join(directory, "events.jsonl"),
		`${JSON.stringify(first)}\n`,
	);
	assert.equal((await store.get("thread")).revision, 2);
	await writeFile(
		join(directory, "events.jsonl"),
		events.map(JSON.stringify).join("\n") + "\n",
	);
	assert.equal((await store.get("thread")).revision, 2);
	await writeFile(
		join(directory, "events.jsonl"),
		`${JSON.stringify({ ...first, eventId: "different" })}\n`,
	);
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CONFLICT"));
	await rm(join(directory, "taskhistory.md"));
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
});

test("import validates all source records and thread before touching target", async () => {
	const { store, root } = await setup();
	const source = join(root, "source");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	const sourcePath = join(source, "taskhistory.md");
	await writeMarkdownRecords(sourcePath, {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "unknown" }],
	});
	const original = await readFile(sourcePath, "utf8");
	await assert.rejects(
		store.importFrom("thread", source),
		hasCode("TASK_HISTORY_CORRUPT"),
	);
	assert.equal(await readFile(sourcePath, "utf8"), original);
	assert.equal(await store.get("thread"), null);
	await writeMarkdownRecords(sourcePath, {
		kind: "task-progress",
		identity: "different-thread",
		records: [],
	});
	await assert.rejects(
		store.importFrom("thread", source),
		hasCode("TASK_HISTORY_CORRUPT"),
	);
	assert.equal(await store.get("thread"), null);
	await writeMarkdownRecords(sourcePath, {
		kind: "task-progress",
		identity: "thread",
		records: [
			{
				type: "source-binding",
				binding: { path: "relative", origin: "explicit" },
			},
		],
	});
	await assert.rejects(
		store.importFrom("thread", source, { includeBindings: false }),
		hasCode("TASK_HISTORY_CORRUPT"),
	);
});

test("legacy extension imports once and preserves partial tail and both source files", async () => {
	const { store, root } = await setup();
	const input = {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	};
	await store.initialize("thread", input);
	const first = (await store.history("thread")).events[0];
	await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const full = (await store.history("thread")).events.reverse();
	const directory = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
	);
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	await writeMarkdownRecords(join(directory, "taskhistory.md"), {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "task-event", event: first }],
	});
	const bytes = full.map(JSON.stringify).join("\n") + '\n{"partial":';
	await writeFile(join(directory, "events.jsonl"), bytes);
	assert.equal((await store.get("thread")).revision, 2);
	assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), bytes);
	assert.equal(
		(await new TaskStore(root, { schemas }).history("thread")).events.length,
		2,
	);
	assert.equal((await store.initialize("thread", input)).duplicate, true);
});

test("source event identity corruption does not alter existing target", async () => {
	const { store, root } = await setup();
	const input = {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	};
	await store.initialize("thread", input);
	const event = (await store.history("thread")).events[0];
	const { mkdir } = await import("node:fs/promises");
	const source = join(root, "source");
	await mkdir(source);
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	await writeMarkdownRecords(join(source, "taskhistory.md"), {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "task-event", event: { ...event, threadId: "wrong" } }],
	});
	const historyPath = join(
		root,
		"tasks",
		"v3",
		createHash("sha256").update("thread").digest("hex"),
		"taskhistory.md",
	);
	const before = await readFile(historyPath, "utf8");
	await assert.rejects(
		store.importFrom("thread", source),
		hasCode("TASK_HISTORY_CORRUPT"),
	);
	assert.equal(await readFile(historyPath, "utf8"), before);
});

test("valid historical prefix and changed same-length history cannot roll back committed task head", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const first = (await store.history("thread")).events[0];
	await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const all = (await store.history("thread")).events.reverse();
	const { taskMarkdownPaths } = await import("../../src/tasks/task-store.mjs");
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	const paths = taskMarkdownPaths(root, "thread");
	const head = await readFile(paths.heartbeat, "utf8");
	await writeMarkdownRecords(paths.history, {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "task-event", event: first }],
	});
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
	assert.equal(await readFile(paths.heartbeat, "utf8"), head);
	const changed = structuredClone(all[1]);
	changed.state.title = "Different";
	await writeMarkdownRecords(paths.history, {
		kind: "task-progress",
		identity: "thread",
		records: [
			{ type: "task-event", event: all[0] },
			{ type: "task-event", event: changed },
		],
	});
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
	assert.equal(await readFile(paths.heartbeat, "utf8"), head);
});

test("stale prefix head rebuilds after committed history and unchanged reads do not rewrite", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const { taskMarkdownPaths } = await import("../../src/tasks/task-store.mjs");
	const { stat } = await import("node:fs/promises");
	const paths = taskMarkdownPaths(root, "thread");
	const head1 = await readFile(paths.heartbeat, "utf8");
	await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const head2 = await readFile(paths.heartbeat, "utf8");
	await writeFile(paths.heartbeat, head1);
	assert.equal((await store.get("thread")).revision, 2);
	assert.equal(await readFile(paths.heartbeat, "utf8"), head2);
	const before = await stat(paths.heartbeat);
	await store.get("thread");
	const after = await stat(paths.heartbeat);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("pre-proof legacy heartbeat revision prevents task history rollback", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const first = (await store.history("thread")).events[0];
	const newer = await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const { taskMarkdownPaths } = await import("../../src/tasks/task-store.mjs");
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	const paths = taskMarkdownPaths(root, "thread");
	const legacy = `# old\n\n\`\`\`json task-heartbeat-v1\n${JSON.stringify({ schemaVersion: 1, kind: "task-heartbeat", identity: "thread", state: newer.state })}\n\`\`\`\n`;
	await writeFile(paths.heartbeat, legacy);
	await writeMarkdownRecords(paths.history, {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "task-event", event: first }],
	});
	await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
	assert.equal(await readFile(paths.heartbeat, "utf8"), legacy);
});

test("corrupt head plus valid-prefix rollback cannot erase a committed revision", async () => {
	const { store, root } = await setup();
	await store.initialize("thread", {
		requestId: "init",
		expectedRevision: 0,
		reason: "Task",
		title: "Work",
		objectives,
	});
	const first = (await store.history("thread")).events[0];
	await store.update("thread", {
		requestId: "update",
		expectedRevision: 1,
		reason: "Start",
		changes: [{ targetId: "C1.1", status: "active" }],
	});
	const { taskMarkdownPaths } = await import("../../src/tasks/task-store.mjs");
	const { writeMarkdownRecords } = await import(
		"../../src/tasks/markdown-records.mjs"
	);
	const paths = taskMarkdownPaths(root, "thread");
	await writeMarkdownRecords(paths.history, {
		kind: "task-progress",
		identity: "thread",
		records: [{ type: "task-event", event: first }],
	});
	for (const broken of [
		"# truncated\n",
		"# broken\n```json task-heartbeat-v1\n{invalid\n```\n",
		`# invalid\n\`\`\`json task-heartbeat-v1\n${JSON.stringify({ schemaVersion: 1, kind: "task-heartbeat", identity: "thread", state: first.state, historyProof: { recordCount: "1", historyDigest: "a".repeat(64) } })}\n\`\`\`\n`,
	]) {
		await writeFile(paths.heartbeat, broken);
		await assert.rejects(store.get("thread"), hasCode("TASK_HISTORY_CORRUPT"));
		assert.equal(await readFile(paths.heartbeat, "utf8"), broken);
	}
});

test("managed lifecycle closes explicitly, archives prior cycles and isolates threads", async () => {
	const { root, store } = await setup();
	const proof = [{ summary: "Verified", verification: "verified", reference: "test:proof" }];
	const check = { status: "done", evidence: proof };
	const closeout = { branch: check, merge: check, push: check, remainingWork: 0, ownerActions: 0, auditEvidence: proof };
	const initial = await store.initialize("managed", { requestId: "init", expectedRevision: 0, reason: "start", title: "First", lifecycle: true, objectives: [{ id: "a", title: "A", items: [{ id: "i", title: "I" }] }, { id: "optional", title: "Optional", required: false }] });
	assert.equal(initial.state.progress.total, 2);
	await assert.rejects(store.complete("managed", { requestId: "open", expectedRevision: 1, reason: "close", closeout }), hasCode("TASK_OPEN_WORK"));
	const done = await store.update("managed", { requestId: "done", expectedRevision: 1, reason: "done", changes: [{ targetId: "a", status: "completed" }, { targetId: "i", status: "completed", evidence: proof }] });
	assert.equal(done.state.progress.percent, 50);
	await assert.rejects(store.complete("managed", { requestId: "optional", expectedRevision: 2, reason: "close", closeout }), hasCode("TASK_OPEN_WORK"));
	await store.update("managed", { requestId: "optional-done", expectedRevision: 2, reason: "done", changes: [{ targetId: "optional", status: "completed", evidence: proof }] });
	const input = { requestId: "close", expectedRevision: 3, reason: "delivered", closeout };
	const closed = await store.complete("managed", input);
	assert.equal(closed.state.progress.percent, 100);
	assert.equal((await store.complete("managed", input)).duplicate, true);
	await assert.rejects(store.update("managed", { requestId: "late", expectedRevision: 4, reason: "late", changes: [{ targetId: "i", status: "pending" }] }), hasCode("TASK_CLOSED"));
	await assert.rejects(store.rescope("managed", { requestId: "empty", expectedRevision: 4, reason: "same", objectives: closed.state.objectives }), hasCode("TASK_NO_NEW_WORK"));
	const next = await store.rescope("managed", { requestId: "next", expectedRevision: 4, reason: "new work", objectives: [{ ...closed.state.objectives[0], items: [...closed.state.objectives[0].items, { id: "new", title: "New" }] }, closed.state.objectives[1]] });
	assert.equal(next.state.lifecycle.sequence, 2);
	assert.deepEqual(next.state.objectives[0].items.map((i) => i.id), ["new"]);
	assert.equal(next.state.objectives.length, 1);
	assert.equal(next.state.progress.percent, 0);
	const archives = await store.archives("managed", { limit: 1 });
	assert.equal(archives.total, 1);
	const page = await store.archive("managed", archives.tasks[0].id, { limit: 1 });
	assert.equal(page.totalNodes, 3);
	const page2 = await store.archive("managed", archives.tasks[0].id, { limit: 1, cursor: page.nextCursor });
	assert.equal(page2.nodes[0].id, "i");
	await assert.rejects(store.archive("other", archives.tasks[0].id, { cursor: page.nextCursor }), hasCode("TASK_ARCHIVE_CURSOR_INVALID"));
	assert.equal((await new TaskStore(root, { schemas }).archives("managed")).total, 1);
});

test("managed archive and source bindings survive import and repeated import without rewriting the source", async () => {
	const { root: sourceRoot, store: source } = await setup();
	const { root: targetRoot, store: target } = await setup();
	const { TaskSourceRelations } = await import("../../src/tasks/task-source-relations.mjs");
	const binding = { path: join(sourceRoot, "ledger.md"), origin: "explicit" };
	await new TaskSourceRelations(sourceRoot, { schemas }).set("import-thread", binding);
	const verified = [{ summary: "Delivered", verification: "verified", reference: "audit:verified" }];
	await source.initialize("import-thread", { requestId: "legacy", expectedRevision: 0, reason: "legacy", title: "Legacy", objectives: [{ id: "old", title: "Old", status: "completed", evidence: verified }] });
	assert.equal((await source.archives("import-thread")).total, 0);
	await source.rescope("import-thread", { requestId: "adopt", expectedRevision: 1, reason: "adopt", lifecycle: true, title: "Managed", objectives: [{ id: "managed", title: "Managed", status: "completed", items: [{ id: "leaf", title: "Leaf", status: "completed", evidence: verified }] }] });
	assert.equal((await source.archives("import-thread")).total, 0);
	const check = { status: "done", evidence: verified };
	await source.complete("import-thread", { requestId: "close", expectedRevision: 2, reason: "delivered", closeout: { branch: check, merge: check, push: check, remainingWork: 0, ownerActions: 0, auditEvidence: verified } });
	await source.rescope("import-thread", { requestId: "new", expectedRevision: 3, reason: "new cycle", objectives: [{ id: "fresh", title: "Fresh" }] });
	const sourcePaths = source.paths("import-thread");
	const historyBefore = await readFile(sourcePaths.history, "utf8");
	const heartbeatBefore = await readFile(sourcePaths.heartbeat, "utf8");
	const imported = await target.importFrom("import-thread", sourcePaths.directory, { includeBindings: true });
	assert.equal(imported.importedEvents, 4);
	const current = await target.get("import-thread");
	assert.equal(current.revision, 4);
	assert.equal(current.lifecycle.sequence, 2);
	assert.deepEqual(current.objectives.map((objective) => objective.id), ["fresh"]);
	assert.deepEqual(await new TaskSourceRelations(targetRoot, { schemas }).get("import-thread"), { found: true, binding });
	const archives = await target.archives("import-thread");
	assert.equal(archives.total, 1);
	const actual = await target.archive("import-thread", archives.tasks[0].id);
	const expected = await source.archive("import-thread", archives.tasks[0].id);
	assert.deepEqual(actual.nodes, expected.nodes);
	assert.deepEqual(actual.nodes.map((node) => node.id), ["managed", "leaf", "old"]);
	const restarted = new TaskStore(targetRoot, { schemas });
	assert.equal((await restarted.importFrom("import-thread", sourcePaths.directory, { includeBindings: true })).importedEvents, 0);
	assert.equal((await restarted.archives("import-thread")).total, 1);
	assert.equal((await restarted.get("import-thread")).revision, 4);
	assert.deepEqual(await new TaskSourceRelations(targetRoot, { schemas }).get("import-thread"), { found: true, binding });
	assert.equal(await readFile(sourcePaths.history, "utf8"), historyBefore);
	assert.equal(await readFile(sourcePaths.heartbeat, "utf8"), heartbeatBefore);
});
