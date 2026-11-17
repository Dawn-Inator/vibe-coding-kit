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
	const TaskAgentSchema = z.object({
		threadId: z.string().trim().min(1).max(512),
		path: z.string().trim().min(1).max(1024).optional(),
	}).strict();
	const ItemFields = {
		id: z.string().trim().min(1).max(128),
		title: z.string().trim().min(1).max(1_000),
		status: TaskStatusSchema.default("pending"),
		evidence: z.array(TaskEvidenceSchema).max(100).default([]),
		agent: TaskAgentSchema.nullable().optional(),
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
	const verifiedEvidence = z
		.array(TaskEvidenceSchema)
		.min(1)
		.max(20)
		.refine(
			(items) =>
				items.every((item) => item.verification === "verified" && !!item.reference?.trim()),
			"Verified evidence with a reference is required",
		);
	const deliveryCheck = z
		.object({
			status: z.enum(["done", "not-applicable"]),
			evidence: verifiedEvidence,
		})
		.strict();
	const TaskCloseoutSchema = z
		.object({
			branch: deliveryCheck,
			merge: deliveryCheck,
			push: deliveryCheck,
			remainingWork: z.literal(0),
			ownerActions: z.literal(0),
			auditEvidence: verifiedEvidence,
		})
		.strict();
	const WriteFields = {
		requestId: z.string().trim().min(1).max(256),
		expectedRevision: z.number().int().nonnegative(),
		reason: z.string().trim().min(1).max(2_000),
	};
	const TaskInitializeInputSchema = z
		.object({
			...WriteFields,
			lifecycle: z.literal(true).optional(),
			expectedRevision: z.literal(0),
			title: z.string().trim().min(1).max(1_000),
			objectives: TaskObjectivesSchema,
		})
		.strict();
	const TaskUpdateInputSchema = z
		.object({
			...WriteFields,
			lifecycle: z.literal(true).optional(),
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
			lifecycle: z.literal(true).optional(),
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
	const TaskCompleteInputSchema = z
		.object({ ...WriteFields, closeout: TaskCloseoutSchema })
		.strict();
	const TaskArchiveInputSchema = z
		.object({
			taskId: z.string().trim().min(1).max(128).optional(),
			cursor: z.string().min(1).max(2048).optional(),
			limit: z.number().int().min(1).max(100).optional(),
		})
		.strict();
	const StateFields = {
		kind: z.literal("task"),
		threadId: z.string().trim().min(1).max(512),
		title: z.string().trim().min(1).max(1_000),
		revision: z.number().int().positive(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
		objectives: TaskObjectivesSchema,
		progress: TaskProgressSchema,
		phase: z.enum(["active", "completed"]),
	};
	const legacyState = z.object({ schemaVersion: z.literal(3), ...StateFields }).strict();
	const managedState = z
		.object({
			schemaVersion: z.literal(4),
			...StateFields,
			lifecycle: z
				.object({
					id: z.string().trim().min(1).max(128),
					sequence: z.number().int().positive(),
					startedAt: z.iso.datetime(),
					completion: z
						.object({
							completedAt: z.iso.datetime(),
							receipt: TaskCloseoutSchema,
						})
						.strict()
						.nullable(),
				})
				.strict(),
		})
		.strict()
		.superRefine((state, ctx) => {
			const complete = state.lifecycle.completion !== null;
			const expected = calculateTaskLifecycleProgress(state.objectives, complete);
			if (
				JSON.stringify(state.progress) !== JSON.stringify(expected) ||
				(state.phase === "completed") !== complete ||
				(complete && hasOpenTaskWork(state.objectives))
			)
				ctx.addIssue({
					code: "custom",
					message: "Inconsistent managed task state",
				});
		});
	const TaskStateSchema = z.union([legacyState, managedState]);

	const TaskEventSchema = z
		.object({
			schemaVersion: z.union([z.literal(3), z.literal(4)]),
			kind: z.enum(["task.initialized", "task.updated", "task.rescoped", "task.completed"]),
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
		.strict()
		.superRefine((event, ctx) => {
			if (
				event.schemaVersion !== event.state.schemaVersion ||
				(event.schemaVersion === 3 && event.kind === "task.completed") ||
				(event.schemaVersion === 4 &&
					(event.kind === "task.completed") !== (event.state.lifecycle?.completion != null)) ||
				(event.schemaVersion === 4 &&
					JSON.stringify(event.after) !== JSON.stringify(event.state.progress))
			)
				ctx.addIssue({
					code: "custom",
					message: "Inconsistent task event",
				});
		});

	return {
		TaskStatusSchema,
		TaskEvidenceSchema,
		TaskItemSchema,
		TaskObjectiveSchema,
		TaskObjectivesSchema,
		TaskInitializeInputSchema,
		TaskUpdateInputSchema,
		TaskRescopeInputSchema,
		TaskCloseoutSchema,
		TaskCompleteInputSchema,
		TaskArchiveInputSchema,
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

export function hasOpenTaskWork(objectives) {
	return objectives.some(
		(objective) =>
			objective.status !== "cancelled" &&
			(objective.status !== "completed" ||
				objective.items.some((item) => item.status !== "cancelled" && item.status !== "completed")),
	);
}
export function calculateTaskLifecycleProgress(objectives, complete) {
	const raw = calculateTaskProgress(objectives);
	const completed = raw.completed + (complete ? 1 : 0);
	const total = raw.total + 1;
	return {
		completed,
		total,
		percent:
			(complete
				? Math.round((completed / total) * 10000)
				: Math.floor((completed / total) * 10000)) / 100,
	};
}
export function isTaskLifecycleComplete(task) {
	return task?.schemaVersion === 4 && task.lifecycle.completion !== null;
}
export function getTaskArchiveCount(task) {
	return task?.schemaVersion === 4 ? task.lifecycle.sequence - 1 : 0;
}
