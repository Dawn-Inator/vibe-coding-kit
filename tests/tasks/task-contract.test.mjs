import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
	createTaskProgressSchemas,
	calculateTaskProgress,
	calculateTaskLifecycleProgress,
} from "../../src/tasks/task-contract.mjs";
const schemas = createTaskProgressSchemas(z);

test("IDs are unique across objectives and leaves and completion requires evidence", () => {
	const duplicate = [
		{ id: "a", title: "A", items: [{ id: "a", title: "duplicate" }] },
	];
	assert.equal(
		schemas.TaskObjectivesSchema.safeParse(duplicate).success,
		false,
	);
	assert.equal(
		schemas.TaskObjectivesSchema.safeParse([
			{ id: "a", title: "A", status: "completed" },
		]).success,
		false,
	);
	assert.equal(
		schemas.TaskObjectivesSchema.safeParse([
			{
				id: "a",
				title: "A",
				status: "completed",
				items: [{ id: "b", title: "B" }],
			},
		]).success,
		true,
	);
});

test("completion counts only registered required non-cancelled leaves", () => {
	const objectives = schemas.TaskObjectivesSchema.parse([
		{
			id: "a",
			title: "A",
			items: [
				{
					id: "a1",
					title: "Done",
					status: "completed",
					evidence: [{ summary: "reported", verification: "reported" }],
				},
				{ id: "a2", title: "Remaining" },
			],
		},
		{ id: "b", title: "Optional", required: false },
		{ id: "c", title: "Cancelled", status: "cancelled" },
	]);
	assert.deepEqual(calculateTaskProgress(objectives), {
		completed: 1,
		total: 2,
		percent: 50,
	});
	assert.equal(objectives[0].items[0].evidence[0].verification, "reported");
	assert.deepEqual(calculateTaskProgress([]), {
		completed: 0,
		total: 0,
		percent: null,
	});
});

test("persisted state schema rejects transient ledger metadata and unknown fields", () => {
	const state = {
		schemaVersion: 3,
		kind: "task",
		threadId: "t",
		title: "T",
		revision: 1,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		objectives: [],
		progress: { completed: 0, total: 0, percent: null },
		phase: "active",
	};
	assert.equal(schemas.TaskStateSchema.safeParse(state).success, true);
	assert.equal(
		schemas.TaskStateSchema.safeParse({
			...state,
			source: {
				kind: "kit-heartbeat",
				path: "a",
				readOnly: true,
				contentHash: "x",
				itemStatuses: {},
			},
		}).success,
		false,
	);
});

test("managed closeout requires verified referenced evidence for every check", () => {
	const proof = [{ summary: "audited", verification: "verified", reference: "receipt:1" }];
	const check = { status: "not-applicable", evidence: proof };
	const receipt = { branch: check, merge: check, push: check, remainingWork: 0, ownerActions: 0, auditEvidence: proof };
	assert.equal(schemas.TaskCloseoutSchema.safeParse(receipt).success, true);
	for (const bad of [{ ...receipt, ownerActions: 1 }, { ...receipt, auditEvidence: [{ ...proof[0], verification: "reported" }] }, { ...receipt, branch: { ...check, evidence: [] } }, { ...receipt, push: { ...check, evidence: [{ ...proof[0], reference: " " }] } }]) assert.equal(schemas.TaskCloseoutSchema.safeParse(bad).success, false);
});


test("large managed scopes never round pending closeout to 100 percent", () => {
	const leaf = { id: "leaf", title: "Done", status: "completed", evidence: [] };
	for (const count of [20_000, 50_000]) {
		const objectives = [{ id: "wide", title: "Wide", status: "completed", required: true, evidence: [], items: Array(count).fill(leaf) }];
		const pending = calculateTaskLifecycleProgress(objectives, false);
		assert.equal(pending.completed, count);
		assert.equal(pending.total, count + 1);
		assert.ok(pending.percent < 100);
		assert.equal(calculateTaskLifecycleProgress(objectives, true).percent, 100);
	}
});

test("managed state cannot assert closure with open work even with a verified receipt", () => {
	const proof = [{ summary: "Audited", verification: "verified", reference: "audit:1" }];
	const check = { status: "done", evidence: proof };
	const objectives = schemas.TaskObjectivesSchema.parse([{ id: "open", title: "Open" }]);
	const now = "2026-11-15T00:00:00.000Z";
	const state = { schemaVersion: 4, kind: "task", threadId: "thread", title: "Task", revision: 1, createdAt: now, updatedAt: now, objectives, progress: calculateTaskLifecycleProgress(objectives, true), phase: "completed", lifecycle: { id: "cycle", sequence: 1, startedAt: now, completion: { completedAt: now, receipt: { branch: check, merge: check, push: check, remainingWork: 0, ownerActions: 0, auditEvidence: proof } } } };
	assert.equal(schemas.TaskStateSchema.safeParse(state).success, false);
});
