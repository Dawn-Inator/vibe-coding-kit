import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSourceRelations } from "../../src/tasks/task-source-relations.mjs";
import { TaskStore } from "../../src/tasks/task-store.mjs";
import { createTaskProgressSchemas } from "../../src/tasks/task-contract.mjs";
import { z } from "zod";
test("binding survives task writes, unbinding and restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-"));
	try {
		const rel = new TaskSourceRelations(root);
		const binding = { path: join(root, "ledger.md"), origin: "explicit" };
		await rel.set("thread", binding);
		const store = new TaskStore(root, {
			schemas: createTaskProgressSchemas(z),
		});
		await store.initialize("thread", {
			requestId: "init",
			expectedRevision: 0,
			reason: "Start",
			title: "Work",
			objectives: [{ id: "A", title: "A" }],
		});
		assert.deepEqual(
			(await new TaskSourceRelations(root).get("thread")).binding,
			binding,
		);
		await rel.set("thread", null);
		assert.deepEqual(await new TaskSourceRelations(root).get("thread"), {
			found: true,
			binding: null,
		});
		assert.equal((await store.get("thread")).revision, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("imports legacy binding without altering it", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-"));
	try {
		const legacy = join(root, "legacy");
		await mkdir(legacy);
		const text = JSON.stringify({ thread: null });
		await writeFile(join(legacy, "bindings.json"), text);
		const rel = new TaskSourceRelations(root, {
			legacyHeartbeatRoots: [legacy],
		});
		assert.deepEqual(await rel.get("thread"), { found: true, binding: null });
		assert.equal(await readFile(join(legacy, "bindings.json"), "utf8"), text);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("automatic discovery serializes with a concurrent explicit unbind", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-"));
	try {
		const path = join(root, "heartbeat.md");
		await writeFile(path, "ledger");
		let unblock;
		let started;
		const wait = new Promise((r) => {
			unblock = r;
		});
		const entered = new Promise((r) => {
			started = r;
		});
		let first = true;
		const rel = new TaskSourceRelations(root, {
			beforeWrite: async () => {
				if (first) {
					first = false;
					started();
					await wait;
				}
			},
		});
		const resolving = rel.resolve("thread", {
			projectRoot: root,
			discovery: { complete: true, candidates: [{ path, associated: true }] },
		});
		await entered;
		const unbind = rel.set("thread", null);
		unblock();
		await Promise.all([resolving, unbind]);
		assert.deepEqual(await new TaskSourceRelations(root).get("thread"), {
			found: true,
			binding: null,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("imports only the thread binding; conflicting legacy roots fail without changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-"));
	try {
		const a = join(root, "a");
		const b = join(root, "b");
		await mkdir(a);
		await mkdir(b);
		const first = JSON.stringify({ thread: join(root, "one"), other: null });
		const second = JSON.stringify({ thread: join(root, "two") });
		await writeFile(join(a, "bindings.json"), first);
		await writeFile(join(b, "bindings.json"), second);
		await assert.rejects(
			new TaskSourceRelations(root, { legacyHeartbeatRoots: [a, b] }).get(
				"thread",
			),
			/Conflicting/,
		);
		assert.equal(await readFile(join(a, "bindings.json"), "utf8"), first);
		assert.equal(await readFile(join(b, "bindings.json"), "utf8"), second);
		assert.deepEqual(
			await new TaskSourceRelations(root, { legacyHeartbeatRoots: [a] }).get(
				"thread",
			),
			{ found: true, binding: { path: join(root, "one"), origin: "explicit" } },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("snapshot fallback is imported once and later cache loss cannot change the relation", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-"));
	try {
		const legacy = join(root, "old");
		await mkdir(legacy);
		const { createHash } = await import("node:crypto");
		const path = join(
			legacy,
			`${createHash("sha256").update("thread").digest("hex")}.snapshot.json`,
		);
		const text = JSON.stringify({
			key: "k",
			view: {
				status: "ready",
				sourcePath: join(root, "heartbeat.md"),
				contentHash: "hash",
			},
		});
		await writeFile(path, text);
		const rel = new TaskSourceRelations(root, {
			legacyHeartbeatRoots: [legacy],
		});
		assert.deepEqual(await rel.get("thread"), {
			found: true,
			binding: { path: join(root, "heartbeat.md"), origin: "automatic" },
		});
		assert.equal(await readFile(path, "utf8"), text);
		await rm(path);
		assert.deepEqual(
			await new TaskSourceRelations(root, {
				legacyHeartbeatRoots: [legacy],
			}).get("thread"),
			{
				found: true,
				binding: { path: join(root, "heartbeat.md"), origin: "automatic" },
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("modern legacy bindings retain origin and ignore unrelated future values", async () => {
	const root = await mkdtemp(join(tmpdir(), "relations-modern-"));
	try {
		const legacy = join(root, "legacy");
		await mkdir(legacy);
		const values = {
			auto: { path: join(root, "auto.md"), origin: "automatic" },
			explicit: { path: join(root, "explicit.md"), origin: "explicit" },
			unbound: null,
			future: { schema: 99 },
		};
		const bytes = JSON.stringify(values);
		await writeFile(join(legacy, "bindings.json"), bytes);
		const relations = new TaskSourceRelations(root, {
			legacyHeartbeatRoots: [legacy],
		});
		assert.deepEqual(await relations.get("auto"), {
			found: true,
			binding: values.auto,
		});
		assert.deepEqual(await relations.get("explicit"), {
			found: true,
			binding: values.explicit,
		});
		assert.deepEqual(await relations.get("unbound"), {
			found: true,
			binding: null,
		});
		await assert.rejects(relations.get("future"), /Invalid legacy binding/);
		assert.equal(await readFile(join(legacy, "bindings.json"), "utf8"), bytes);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("empty lookup creates no history; importing on an existing task preserves events", async () => {
	const root = await mkdtemp(join(tmpdir(), "relations-empty-"));
	try {
		const rel = new TaskSourceRelations(root);
		assert.deepEqual(await rel.get("empty"), { found: false, binding: null });
		const { readdir } = await import("node:fs/promises");
		assert.deepEqual(await readdir(root), []);
		const store = new TaskStore(root, {
			schemas: createTaskProgressSchemas(z),
		});
		await store.initialize("thread", {
			requestId: "init",
			expectedRevision: 0,
			reason: "Start",
			title: "Work",
			objectives: [{ id: "A", title: "A" }],
		});
		assert.deepEqual(await rel.get("thread"), { found: false, binding: null });
		assert.equal((await store.get("thread")).revision, 1);
		assert.equal((await store.history("thread")).events.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt committed task state is never rewritten by relation access", async () => {
	const root = await mkdtemp(join(tmpdir(), "relations-corrupt-"));
	try {
		const store = new TaskStore(root, {
			schemas: createTaskProgressSchemas(z),
		});
		await store.initialize("thread", {
			requestId: "init",
			expectedRevision: 0,
			reason: "Start",
			title: "Work",
			objectives: [{ id: "A", title: "A" }],
		});
		const { taskMarkdownPaths } = await import(
			"../../src/tasks/task-store.mjs"
		);
		const { readMarkdownRecords, writeMarkdownRecords } = await import(
			"../../src/tasks/markdown-records.mjs"
		);
		const path = taskMarkdownPaths(root, "thread").history;
		const data = await readMarkdownRecords(path, {
			kind: "task-progress",
			identity: "thread",
		});
		data.records[0].event.state.objectives = "invalid";
		await writeMarkdownRecords(path, {
			kind: "task-progress",
			identity: "thread",
			records: data.records,
		});
		const before = await readFile(path, "utf8");
		const rel = new TaskSourceRelations(root);
		await assert.rejects(rel.set("thread", null));
		assert.equal(await readFile(path, "utf8"), before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loss or divergence of binding-only suffix fails before relation mutation", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-proof-"));
	try {
		const relations = new TaskSourceRelations(root);
		const first = { path: join(root, "first.md"), origin: "explicit" };
		await relations.set("thread", first);
		const { taskMarkdownPaths } = await import(
			"../../src/tasks/task-store.mjs"
		);
		const { readMarkdownRecords, writeMarkdownRecords } = await import(
			"../../src/tasks/markdown-records.mjs"
		);
		const paths = taskMarkdownPaths(root, "thread");
		const prefix = (
			await readMarkdownRecords(paths.history, {
				kind: "task-progress",
				identity: "thread",
			})
		).records;
		await relations.set("thread", null);
		const head = await readFile(paths.heartbeat, "utf8");
		await writeMarkdownRecords(paths.history, {
			kind: "task-progress",
			identity: "thread",
			records: prefix,
		});
		await assert.rejects(relations.get("thread"), /history conflict/i);
		await assert.rejects(relations.set("thread", first), /history conflict/i);
		assert.equal(await readFile(paths.heartbeat, "utf8"), head);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt managed head blocks both binding reads and writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "relation-proof-corrupt-"));
	try {
		const rel = new TaskSourceRelations(root);
		await rel.set("thread", { path: join(root, "a.md"), origin: "explicit" });
		const { taskMarkdownPaths } = await import(
			"../../src/tasks/task-store.mjs"
		);
		const paths = taskMarkdownPaths(root, "thread");
		const history = await readFile(paths.history, "utf8");
		for (const corrupt of [
			"# missing payload",
			"```json task-heartbeat-v1\n{\n```\n",
		]) {
			await writeFile(paths.heartbeat, corrupt);
			await assert.rejects(rel.get("thread"), /head.*corrupt/i);
			await assert.rejects(rel.set("thread", null), /head.*corrupt/i);
			assert.equal(await readFile(paths.history, "utf8"), history);
			assert.equal(await readFile(paths.heartbeat, "utf8"), corrupt);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
