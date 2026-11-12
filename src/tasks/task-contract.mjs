// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
export function createTaskProgressSchemas(z) {
	const TaskStatusSchema = z.enum([
		"pending",
		"active",
		"completed",
		"blocked",
		"cancelled",
	]);
	const TaskEvidenceSchema = z
		.object({
			summary: z.string().trim().min(1).max(2_000),
			verification: z.enum(["reported", "verified"]),
			kind: z.string().trim().min(1).max(100).optional(),
			reference: z.string().trim().min(1).max(4_096).optional(),
		})
		.strict();
	const ItemFields = {
		id: z.string().trim().min(1).max(128),
		title: z.string().trim().min(1).max(1_000),
		status: TaskStatusSchema.default("pending"),
		evidence: z.array(TaskEvidenceSchema).max(100).default([]),
	};
	const TaskItemSchema = z.object(ItemFields).strict();
	const TaskObjectiveSchema = z
		.object({
			...ItemFields,
			required: z.boolean().default(true),
			items: z.array(TaskItemSchema).max(500).default([]),
		})
		.strict();
	const TaskObjectivesSchema = z
		.array(TaskObjectiveSchema)
		.max(100)
		.superRefine((objectives, ctx) => {
			const ids = new Set();
			for (const objective of objectives) {
				for (const entry of [objective, ...objective.items]) {
					if (ids.has(entry.id))
						ctx.addIssue({
							code: "custom",
							message: `Duplicate task ID: ${entry.id}`,
						});
					ids.add(entry.id);
					if (
						entry.status === "completed" &&
						entry.evidence.length === 0 &&
						!(entry === objective && objective.items.length > 0)
					) {
						ctx.addIssue({
							code: "custom",
							message: `Completed item ${entry.id} requires evidence`,
						});
					}
				}
			}
		});
	const WriteFields = {
		requestId: z.string().trim().min(1).max(256),
		expectedRevision: z.number().int().nonnegative(),
		reason: z.string().trim().min(1).max(2_000),
	};
	const TaskInitializeInputSchema = z
		.object({
			...WriteFields,
			expectedRevision: z.literal(0),
			title: z.string().trim().min(1).max(1_000),
			objectives: TaskObjectivesSchema,
		})
		.strict();
	const TaskUpdateInputSchema = z
		.object({
			...WriteFields,
			changes: z
				.array(
					z
						.object({
							targetId: z.string().trim().min(1).max(128),
							status: TaskStatusSchema,
							evidence: z.array(TaskEvidenceSchema).max(100).optional(),
						})
						.strict(),
				)
				.min(1)
				.max(500),
		})
		.strict();
	const TaskRescopeInputSchema = z
		.object({
			...WriteFields,
			title: z.string().trim().min(1).max(1_000).optional(),
			objectives: TaskObjectivesSchema,
		})
		.strict();
	const TaskProgressSchema = z
		.object({
			completed: z.number().int().nonnegative(),
			total: z.number().int().nonnegative(),
			percent: z.number().min(0).max(100).nullable(),
		})
		.strict();
	const TaskStateSchema = z
		.object({
			schemaVersion: z.literal(3),
			kind: z.literal("task"),
			threadId: z.string().trim().min(1).max(512),
			title: z.string().trim().min(1).max(1_000),
			revision: z.number().int().positive(),
			createdAt: z.iso.datetime(),
			updatedAt: z.iso.datetime(),
			objectives: TaskObjectivesSchema,
			progress: TaskProgressSchema,
			phase: z.enum(["active", "completed"]),
		})
		.strict();

	const TaskEventSchema = z
		.object({
			schemaVersion: z.literal(3),
			kind: z.enum(["task.initialized", "task.updated", "task.rescoped"]),
			eventId: z.string(),
			threadId: z.string(),
			requestId: z.string(),
			fingerprint: z.string(),
			revision: z.number().int().positive(),
			occurredAt: z.iso.datetime(),
			reason: z.string(),
			before: TaskProgressSchema.nullable(),
			after: TaskProgressSchema,
			state: TaskStateSchema,
		})
		.strict();

	return {
		TaskStatusSchema,
		TaskEvidenceSchema,
		TaskItemSchema,
		TaskObjectiveSchema,
		TaskObjectivesSchema,
		TaskInitializeInputSchema,
		TaskUpdateInputSchema,
		TaskRescopeInputSchema,
		TaskProgressSchema,
		TaskStateSchema,
		TaskEventSchema,
	};
}

export function calculateTaskProgress(objectives) {
	let completed = 0;
	let total = 0;
	for (const objective of objectives) {
		if (!objective.required || objective.status === "cancelled") continue;
		const leaves = objective.items.length ? objective.items : [objective];
		for (const item of leaves) {
			if (item.status === "cancelled") continue;
			total += 1;
			if (item.status === "completed") completed += 1;
		}
	}
	return {
		completed,
		total,
		percent:
			total === 0 ? null : Math.round((completed / total) * 10_000) / 100,
	};
}
