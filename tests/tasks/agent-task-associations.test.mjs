import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { parseItems } from "../../src/supervision/check-heartbeat-ledger.mjs";
import { createTaskProgressSchemas } from "../../src/tasks/task-contract.mjs";
import { TaskStore } from "../../src/tasks/task-store.mjs";
import { projectHeartbeatTask } from "../../src/tasks/heartbeat-task-source.mjs";
import { projectAgentTaskProgress } from "../../src/tasks/agent-task-associations.mjs";

const agents = [{ threadId: "one", path: "/root/one" }, { threadId: "two", path: "/root/two" }];
const row = (id, status, owner, agent_thread_id, children) => ({ id, item: id, status, owner, agent_thread_id, children });
const project = (items, taskRootId) => projectHeartbeatTask({ report: { mode: "items", findings: [], items }, root: "/project", path: "/project/heartbeat.md", threadId: "root", contentHash: "full-hash", modifiedAt: "2026-01-01T00:00:00Z", taskRootId });
const progress = (task, members = agents) => projectAgentTaskProgress({ task, agents: members });

test("source owners and IDs select current members and retain canonical leaf semantics", () => {
	const task = project([
		row("P", "tracking", "/root/one", "one", '["A","B"]'),
		row("A", "done", "/root/one", "one"), row("B", "dispatched", "/root/two"),
		row("X", "done", "/root/one", "one"),
	], "P");
	assert.equal(task.source.contentHash, "full-hash");
	assert.equal(task.source.itemOwners.X, undefined);
	assert.deepEqual(task.source.itemOwners.A, { owner: "/root/one", agentThreadId: "one" });
	assert.deepEqual(task.progress, { completed: 1, total: 2, percent: 50 });
	assert.deepEqual(progress(task), [
		{ threadId: "one", progress: { completed: 1, total: 1, percent: 100 }, basis: "assigned-canonical-leaves", assignedTaskIds: ["A"], assignmentTitle: "A", granularity: "single-item" },
		{ threadId: "two", progress: { completed: 0, total: 1, percent: 0 }, basis: "assigned-canonical-leaves", assignedTaskIds: ["B"], assignmentTitle: "B", granularity: "single-item" },
	]);
});

test("conflicts, foreign IDs and ambiguous paths do not fall through", () => {
	const task = project([row("A", "done", "/root/two", "one"), row("B", "done", "/root/one", "foreign"), row("C", "dispatched", "/root/one")]);
	const results = progress(task, [...agents, { threadId: "three", path: "/root/one" }]);
	assert.ok(results.every((entry) => entry.progress === null && entry.assignedTaskIds.length === 0));
	assert.equal(progress(project([row("A", "dispatched")]))[0].progress, null);
});

test("shared descendants are counted once and tracking parents are not attributed", () => {
	const task = project([row("P", "tracking", "/root/two", undefined, '["A"]'), row("Q", "tracking", "/root/two", undefined, '["A"]'), row("A", "done", "/root/one")]);
	assert.deepEqual(task.progress, { completed: 1, total: 1, percent: 100 });
	assert.deepEqual(progress(task)[0].assignedTaskIds, ["A"]);
	assert.equal(progress(task)[1].progress, null);
});

test("canonical scope excludes cancelled and optional work, with no lifecycle completion inference", () => {
	const item = (id, status, agent = { threadId: "one" }) => ({ id, title: id, status, evidence: [], agent });
	const task = { objectives: [
		{ ...item("p", "completed"), required: true, items: [item("a", "pending"), item("b", "cancelled")] },
		{ ...item("optional", "completed"), required: false, items: [] },
		{ ...item("cancelled", "cancelled"), required: true, items: [] },
	], phase: "completed" };
	assert.deepEqual(progress(task)[0].progress, { completed: 0, total: 1, percent: 0 });
	assert.deepEqual(progress(task)[0].assignedTaskIds, ["a"]);
});

test("assignment survives update, rescope and store reread", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-task-"));
	try {
		const store = new TaskStore(root, { schemas: createTaskProgressSchemas(z) });
		const objectives = [{ id: "P", title: "Parent", items: [{ id: "A", title: "Leaf", agent: { threadId: "one", path: "/root/one" } }] }];
		await store.initialize("thread", { requestId: "i", expectedRevision: 0, reason: "init", title: "Test", objectives });
		await store.update("thread", { requestId: "u", expectedRevision: 1, reason: "start", changes: [{ targetId: "A", status: "active" }] });
		const current = await store.get("thread");
		assert.deepEqual(current.objectives[0].items[0].agent, objectives[0].items[0].agent);
		await store.rescope("thread", { requestId: "r", expectedRevision: 2, reason: "expand", objectives: [{ ...current.objectives[0], items: [...current.objectives[0].items, { id: "B", title: "New" }] }] });
		const reread = await new TaskStore(root, { schemas: createTaskProgressSchemas(z) }).get("thread");
		assert.deepEqual(reread.objectives[0].items[0].agent, objectives[0].items[0].agent);
	} finally { await rm(root, { recursive: true, force: true }); }
});


test("named ledger columns retain owner and explicit agent thread ID", () => {
	const parsed = parseItems(`## Items

| id | source | item | status | evidence | owner | agent_thread_id |
| --- | --- | --- | --- | --- | --- | --- |
| A | handoff:x | Work | dispatched | - | /root/one | one |
`);
	const task = project(parsed.rows);
	assert.deepEqual(task.source.itemOwners.A, { owner: "/root/one", agentThreadId: "one" });
	assert.deepEqual(progress(task)[0].assignedTaskIds, ["A"]);
});

test("unsafe links keep existing overall count semantics and do not infer rollups", () => {
	const task = project([row("P", "tracking", "/root/two", undefined, '["missing"]'), row("A", "done", "/root/one")]);
	assert.ok(task.source.linkRisks.length);
	assert.equal(task.progress.total, 2);
	assert.deepEqual(progress(task)[0].assignedTaskIds, ["A"]);
	assert.deepEqual(progress(task)[1].assignedTaskIds, ["P"]);
});

test("explicitly cleared local assignment never falls back to source metadata", () => {
	const task = project([row("A", "done", "/root/one", "one")]);
	task.objectives[0].agent = null;
	assert.equal(progress(task)[0].progress, null);
});

test("canonical parent assignment applies to children unless overridden or cleared", () => {
	const leaf = (id, status, assignment) => ({ id, title: id, status, evidence: [], ...(assignment !== undefined ? { agent: assignment } : {}) });
	const task = { objectives: [{ ...leaf("P", "active", { threadId: "one" }), required: true, items: [
		leaf("A", "pending"), leaf("B", "completed", { threadId: "two" }), leaf("C", "pending", null),
	] }] };
	assert.deepEqual(progress(task), [
		{ threadId: "one", progress: { completed: 0, total: 1, percent: 0 }, basis: "assigned-canonical-leaves", assignedTaskIds: ["A"], assignmentTitle: "A", granularity: "single-item" },
		{ threadId: "two", progress: { completed: 1, total: 1, percent: 100 }, basis: "assigned-canonical-leaves", assignedTaskIds: ["B"], assignmentTitle: "B", granularity: "single-item" },
	]);
});

test("heartbeat parent source owner does not flow down to unowned children", () => {
	const task = project([row("P", "tracking", "/root/one", "one", '["A","B"]'), row("A", "done"), row("B", "done", "/root/two")]);
	assert.equal(progress(task)[0].progress, null);
	assert.deepEqual(progress(task)[1].assignedTaskIds, ["B"]);
});


test("granularity and titles come from owned canonical tasks, never agent names", () => {
	const make = (id, status, agent) => ({ id, title: `Canonical ${id}`, status, evidence: [], ...(agent ? { agent } : {}) });
	const task = { objectives: [{ ...make("module", "active", { threadId: "one" }), required: true, items: [make("A", "completed"), make("B", "completed"), make("C", "active")] }] };
	const [one, two] = progress(task, [{ ...agents[0], name: "Random nickname" }, agents[1]]);
	assert.deepEqual(one.progress, { completed: 2, total: 3, percent: 66.67 });
	assert.equal(one.assignmentTitle, "Canonical module");
	assert.equal(one.granularity, "checklist");
	assert.equal(two.assignmentTitle, null);
	assert.equal(two.granularity, "none");
	const single = progress(project([row("A", "dispatched", "/root/one")]))[0];
	assert.equal(single.progress.percent, 0);
	assert.equal(single.granularity, "single-item");
	assert.equal(single.assignmentTitle, "A");
});

test("unsafe titles and foreign assignments never expose a path or label", () => {
	const task = project([{ ...row("A", "done", "/root/one"), item: "/private/secret" }, { ...row("B", "done", "/root/two", "foreign"), item: "Forbidden" }]);
	const [one, two] = progress(task);
	assert.equal(one.assignmentTitle, null);
	assert.equal(two.assignmentTitle, null);
	assert.equal(two.granularity, "none");
});


test("ordinary slash in a task label remains visible", () => {
	const task = project([{ ...row("A", "dispatched", "/root/one"), item: "API/UI 修复" }]);
	assert.equal(progress(task)[0].assignmentTitle, "API/UI 修复");
});

test("path-only assignment can be disabled while explicit IDs retain strict path checks", () => {
	const restricted = [{ threadId: "one", path: "/root/one", allowPathOnlyAssignment: false }, { threadId: "two", path: "/root/two" }];
	const pathOnly = project([row("A", "done", "/root/one")]);
	assert.equal(progress(pathOnly, restricted)[0].progress, null);
	assert.deepEqual(progress(pathOnly, agents)[0].assignedTaskIds, ["A"], "the default still permits unique path-only assignment");
	assert.deepEqual(progress(project([row("A", "done", "/root/one", "one")]), restricted)[0].assignedTaskIds, ["A"]);
	assert.deepEqual(progress(project([row("A", "done", undefined, "one")]), restricted)[0].assignedTaskIds, ["A"]);
	assert.equal(progress(project([row("A", "done", "/root/two", "one")]), restricted)[0].progress, null);
	const duplicated = [...restricted, { threadId: "three", path: "/root/one" }];
	assert.equal(progress(project([row("A", "done", "/root/one", "one")]), duplicated)[0].progress, null);
});

test("explicit canonical ID alias remains compatible with restricted path-only assignment", () => {
	const task = { objectives: [{ id: "A", title: "A", status: "active", required: true, evidence: [], items: [], agent: { threadId: "one", path: "one" } }] };
	assert.deepEqual(progress(task, [{ threadId: "one", path: "/root/one", allowPathOnlyAssignment: false }])[0].assignedTaskIds, ["A"]);
});


test("restricted member keeps explicit owner ID alias without an agent path", () => {
	const members = [{ threadId: "verified-child", allowPathOnlyAssignment: false }];
	const direct = project([row("A", "done", "verified-child", "verified-child")]);
	assert.deepEqual(progress(direct, members)[0].assignedTaskIds, ["A"]);
	assert.equal(progress(project([row("A", "done", "/wrong/path", "verified-child")]), members)[0].progress, null);
	assert.equal(progress(project([row("A", "done", "verified-child")]), members)[0].progress, null);
});
