// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendDurableLine, atomicWriteFile } from "./task-io.mjs";
import { calculateTaskProgress } from "./task-contract.mjs";

export class TaskStoreError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "TaskStoreError";
		this.code = code;
	}
}
const queues = new Map();
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}
function isMissing(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The Helper is the sole writer; queues also serialize TaskStore instances within its process. */
export class TaskStore {
	constructor(root, { schemas }) {
		this.schemas = schemas;
		this.root = resolve(root);
	}
	paths(threadId) {
		if (!threadId.trim() || threadId.length > 512)
			throw new TaskStoreError(
				"TASK_THREAD_INVALID",
				"A verified thread ID is required",
			);
		const directory = resolve(this.root, "tasks", "v3", digest(threadId));
		return {
			directory,
			events: resolve(directory, "events.jsonl"),
			snapshot: resolve(directory, "snapshot.json"),
		};
	}
	async serialize(threadId, work) {
		const key = this.paths(threadId).directory;
		const result = (queues.get(key) ?? Promise.resolve())
			.catch(() => undefined)
			.then(work);
		queues.set(key, result);
		try {
			return await result;
		} finally {
			if (queues.get(key) === result) queues.delete(key);
		}
	}
	async replay(threadId) {
		const paths = this.paths(threadId);
		let contents;
		try {
			contents = await readFile(paths.events, "utf8");
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		// Only an incomplete final record is repairable. Corruption in committed lines is an error.
		const lastNewline = contents.lastIndexOf("\n");
		const tail = contents.slice(lastNewline + 1);
		let complete = contents.slice(0, lastNewline + 1);
		if (tail.length) {
			const recovered = this.schemas.TaskEventSchema.safeParse(
				(() => {
					try {
						return JSON.parse(tail);
					} catch {
						return null;
					}
				})(),
			);
			const file = await open(paths.events, "r+");
			try {
				if (recovered.success) {
					await file.write("\n", Buffer.byteLength(contents));
					complete = `${contents}\n`;
				} else await file.truncate(Buffer.byteLength(complete));
				await file.sync();
			} finally {
				await file.close();
			}
		}
		let events;
		try {
			events = complete
				.split("\n")
				.filter(Boolean)
				.map((line) => this.schemas.TaskEventSchema.parse(JSON.parse(line)));
		} catch {
			throw new TaskStoreError(
				"TASK_HISTORY_CORRUPT",
				"Task history contains an invalid committed record",
			);
		}
		let revision = 0;
		for (const event of events) {
			if (
				event.threadId !== threadId ||
				event.state.threadId !== threadId ||
				event.revision !== revision + 1 ||
				event.state.revision !== event.revision
			) {
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Task history identity or revision is inconsistent",
				);
			}
			revision = event.revision;
		}
		// Snapshot is a derived cache. The log remains authoritative after a crash.
		const state = events.at(-1)?.state;
		if (state) {
			let snapshot;
			try {
				snapshot = JSON.parse(await readFile(paths.snapshot, "utf8"));
			} catch {
				snapshot = null;
			}
			if (canonical(snapshot) !== canonical(state))
				await atomicWriteFile(paths.snapshot, `${JSON.stringify(state)}\n`);
		}
		return events;
	}
	async get(threadId) {
		return this.serialize(
			threadId,
			async () => (await this.replay(threadId)).at(-1)?.state ?? null,
		);
	}
	async mutate(threadId, kind, input, build) {
		return this.serialize(threadId, async () => {
			const events = await this.replay(threadId);
			const fingerprint = digest(canonical({ kind, input }));
			const duplicate = events.find(
				(event) => event.requestId === input.requestId,
			);
			if (duplicate) {
				if (duplicate.fingerprint !== fingerprint)
					throw new TaskStoreError(
						"TASK_REQUEST_CONFLICT",
						"This request ID was already used for different input",
					);
				return { state: duplicate.state, duplicate: true };
			}
			const previous = events.at(-1)?.state ?? null;
			if ((previous?.revision ?? 0) !== input.expectedRevision)
				throw new TaskStoreError(
					"TASK_REVISION_CONFLICT",
					`Expected revision ${input.expectedRevision}; current revision is ${previous?.revision ?? 0}`,
				);
			const next = build(previous);
			const progress = calculateTaskProgress(next.objectives);
			const now = new Date().toISOString();
			const state = this.schemas.TaskStateSchema.parse({
				schemaVersion: 3,
				kind: "task",
				threadId,
				...next,
				revision: (previous?.revision ?? 0) + 1,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				progress,
				phase:
					progress.total > 0 && progress.completed === progress.total
						? "completed"
						: "active",
			});
			const event = this.schemas.TaskEventSchema.parse({
				schemaVersion: 3,
				kind,
				eventId: randomUUID(),
				threadId,
				requestId: input.requestId,
				fingerprint,
				revision: state.revision,
				occurredAt: now,
				reason: input.reason,
				before: previous?.progress ?? null,
				after: progress,
				state,
			});
			const paths = this.paths(threadId);
			await appendDurableLine(paths.events, JSON.stringify(event));
			await atomicWriteFile(paths.snapshot, `${JSON.stringify(state)}\n`);
			return { state, duplicate: false };
		});
	}
	async initialize(threadId, value) {
		const input = this.schemas.TaskInitializeInputSchema.parse(value);
		return this.mutate(threadId, "task.initialized", input, (previous) => {
			if (previous)
				throw new TaskStoreError(
					"TASK_ALREADY_INITIALIZED",
					"Use update or rescope to continue this thread task",
				);
			return { title: input.title, objectives: input.objectives };
		});
	}
	async update(threadId, value) {
		const input = this.schemas.TaskUpdateInputSchema.parse(value);
		return this.mutate(threadId, "task.updated", input, (previous) => {
			if (!previous)
				throw new TaskStoreError(
					"TASK_NOT_INITIALIZED",
					"Initialize the task first",
				);
			const objectives = structuredClone(previous.objectives);
			const changedIds = new Set();
			for (const change of input.changes) {
				if (changedIds.has(change.targetId))
					throw new TaskStoreError(
						"TASK_DUPLICATE_CHANGE",
						`Duplicate change for ${change.targetId}`,
					);
				changedIds.add(change.targetId);
				const target = objectives
					.flatMap((objective) => [objective, ...objective.items])
					.find((entry) => entry.id === change.targetId);
				if (!target)
					throw new TaskStoreError(
						"TASK_TARGET_NOT_FOUND",
						`Unknown task item ${change.targetId}`,
					);
				target.status = change.status;
				if (change.evidence) target.evidence = change.evidence;
			}
			return {
				title: previous.title,
				objectives: this.schemas.TaskObjectivesSchema.parse(objectives),
			};
		});
	}
	async rescope(threadId, value) {
		const input = this.schemas.TaskRescopeInputSchema.parse(value);
		return this.mutate(threadId, "task.rescoped", input, (previous) => {
			if (!previous)
				throw new TaskStoreError(
					"TASK_NOT_INITIALIZED",
					"Initialize the task first",
				);
			const objectives = structuredClone(input.objectives);
			// Scope removal is represented by cancellation, never disappearance from the current registry.
			for (const old of previous.objectives) {
				const retained = objectives.find(
					(objective) => objective.id === old.id,
				);
				if (!retained) objectives.push({ ...old, status: "cancelled" });
				else
					for (const item of old.items) {
						if (!retained.items.some((entry) => entry.id === item.id))
							retained.items.push({ ...item, status: "cancelled" });
					}
			}
			return {
				title: input.title ?? previous.title,
				objectives: this.schemas.TaskObjectivesSchema.parse(objectives),
			};
		});
	}
	async history(threadId, options = {}) {
		return this.serialize(threadId, async () => {
			const events = await this.replay(threadId);
			const limit = options.limit ?? 25;
			if (!Number.isInteger(limit) || limit < 1 || limit > 100)
				throw new TaskStoreError(
					"TASK_HISTORY_PAGE_INVALID",
					"History limit must be 1–100",
				);
			const before =
				options.cursor === undefined
					? events.length + 1
					: Number(options.cursor);
			if (!Number.isSafeInteger(before) || before < 1)
				throw new TaskStoreError(
					"TASK_HISTORY_CURSOR_INVALID",
					"Invalid history cursor",
				);
			const eligible = events
				.filter((event) => event.revision < before)
				.reverse();
			const page = eligible.slice(0, limit);
			return {
				events: page,
				nextCursor:
					eligible.length > limit ? String(page.at(-1)?.revision) : null,
			};
		});
	}
}
