import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
	createTaskProgressSchemas,
	calculateTaskProgress,
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
