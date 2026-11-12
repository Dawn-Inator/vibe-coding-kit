// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	readMarkdownRecords,
	writeMarkdownRecords,
	withMarkdownLock,
	verifyTaskHistoryHead,
	writeTaskHistoryHead,
} from "./markdown-records.mjs";
import { calculateTaskProgress } from "./task-contract.mjs";

export class TaskStoreError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "TaskStoreError";
		this.code = code;
	}
}

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

export function taskMarkdownPaths(root, threadId) {
	if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 512)
		throw new TaskStoreError(
			"TASK_THREAD_INVALID",
			"A verified thread ID is required",
		);
	const directory = resolve(root, "tasks", "v3", digest(threadId));
	return {
		directory,
		heartbeat: resolve(directory, "heartbeat.md"),
		history: resolve(directory, "taskhistory.md"),
		legacyEvents: resolve(directory, "events.jsonl"),
		legacySnapshot: resolve(directory, "snapshot.json"),
	};
}
// A dependency-free structural guard shared by readers before any history rewrite.
// TaskStore additionally applies the caller's full TaskEventSchema.
export function validateTaskEventStructure(e) {
	const object = (v, keys) =>
		v &&
		typeof v === "object" &&
		!Array.isArray(v) &&
		Object.keys(v).every((k) => keys.includes(k));
	const str = (v, max = Infinity) =>
		typeof v === "string" && v.trim().length > 0 && v.length <= max;
	const progress = (p) =>
		object(p, ["completed", "total", "percent"]) &&
		Number.isInteger(p.completed) &&
		p.completed >= 0 &&
		Number.isInteger(p.total) &&
		p.total >= 0 &&
		(p.percent === null ||
			(typeof p.percent === "number" &&
				Number.isFinite(p.percent) &&
				p.percent >= 0 &&
				p.percent <= 100));
	const statuses = ["pending", "active", "completed", "blocked", "cancelled"];
	const ids = new Set();
	const entry = (v, objective) => {
		if (
			!object(v, [
				"id",
				"title",
				"status",
				"evidence",
				...(objective ? ["required", "items"] : []),
			]) ||
			!str(v.id, 128) ||
			!str(v.title, 1000) ||
			ids.has(v.id) ||
			(v.status !== undefined && !statuses.includes(v.status)) ||
			(v.evidence !== undefined &&
				(!Array.isArray(v.evidence) || v.evidence.length > 100))
		)
			return false;
		ids.add(v.id);
		if (
			!(v.evidence ?? []).every(
				(x) =>
					object(x, ["summary", "verification", "kind", "reference"]) &&
					str(x.summary, 2000) &&
					["reported", "verified"].includes(x.verification) &&
					(x.kind === undefined || str(x.kind, 100)) &&
					(x.reference === undefined || str(x.reference, 4096)),
			)
		)
			return false;
		if (
			objective &&
			((v.required !== undefined && typeof v.required !== "boolean") ||
				(v.items !== undefined &&
					(!Array.isArray(v.items) ||
						v.items.length > 500 ||
						!v.items.every((i) => entry(i, false)))))
		)
			return false;
		return (
			v.status !== "completed" ||
			(v.evidence ?? []).length > 0 ||
			(objective && (v.items ?? []).length > 0)
		);
	};
	const date = (v) =>
		typeof v === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) &&
		Number.isFinite(Date.parse(v));
	if (
		!object(e, [
			"schemaVersion",
			"kind",
			"eventId",
			"threadId",
			"requestId",
			"fingerprint",
			"revision",
			"occurredAt",
			"reason",
			"before",
			"after",
			"state",
		]) ||
		e.schemaVersion !== 3 ||
		!["task.initialized", "task.updated", "task.rescoped"].includes(e.kind) ||
		![e.eventId, e.threadId, e.requestId, e.fingerprint, e.reason].every(
			(v) => typeof v === "string",
		) ||
		!Number.isInteger(e.revision) ||
		e.revision < 1 ||
		!date(e.occurredAt) ||
		!(e.before === null || progress(e.before)) ||
		!progress(e.after)
	)
		return false;
	const state = e.state;
	return !!(
		object(state, [
			"schemaVersion",
			"kind",
			"threadId",
			"title",
			"revision",
			"createdAt",
			"updatedAt",
			"objectives",
			"progress",
			"phase",
		]) &&
		state.schemaVersion === 3 &&
		state.kind === "task" &&
		str(state.threadId, 512) &&
		str(state.title, 1000) &&
		Number.isInteger(state.revision) &&
		state.revision > 0 &&
		date(state.createdAt) &&
		date(state.updatedAt) &&
		Array.isArray(state.objectives) &&
		state.objectives.length <= 100 &&
		state.objectives.every((v) => entry(v, true)) &&
		progress(state.progress) &&
		["active", "completed"].includes(state.phase)
	);
}
/** The Helper is the sole writer across processes. */
export class TaskStore {
	constructor(root, { schemas }) {
		this.schemas = schemas;
		this.root = resolve(root);
	}
	paths(threadId) {
		return taskMarkdownPaths(this.root, threadId);
	}
	async serialize(threadId, work) {
		return withMarkdownLock(this.paths(threadId).directory, work);
	}
	validateEvents(threadId, events) {
		let revision = 0;
		const ids = new Set();
		const requests = new Set();
		return events.map((raw) => {
			let event;
			try {
				event = this.schemas.TaskEventSchema.parse(raw);
			} catch {
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Task history contains an invalid committed record",
				);
			}
			if (
				event.threadId !== threadId ||
				event.state.threadId !== threadId ||
				event.revision !== ++revision ||
				event.state.revision !== event.revision ||
				ids.has(event.eventId) ||
				requests.has(event.requestId)
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Task history identity, revision or IDs are inconsistent",
				);
			ids.add(event.eventId);
			requests.add(event.requestId);
			// Parsing validates; the original event remains authoritative, including unknown fields.
			return raw;
		});
	}
	async legacy(path, threadId) {
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (isMissing(error))
				return { exists: false, events: [], partialTail: false };
			throw error;
		}
		const lines = text.split("\n");
		const tail = lines.pop();
		let partialTail = false;
		if (tail) {
			try {
				const value = JSON.parse(tail);
				this.schemas.TaskEventSchema.parse(value);
				lines.push(tail);
			} catch {
				partialTail = true;
			}
		}
		let events;
		try {
			events = lines.filter(Boolean).map((line) => JSON.parse(line));
		} catch {
			throw new TaskStoreError(
				"TASK_HISTORY_CORRUPT",
				"Task history contains an invalid committed record",
			);
		}
		return {
			exists: true,
			events: this.validateEvents(threadId, events),
			partialTail,
		};
	}
	validateRecords(records) {
		for (const record of records) {
			if (
				!record ||
				typeof record !== "object" ||
				!["task-event", "source-binding", "source-migration"].includes(
					record.type,
				)
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Unknown task history record",
				);
			if (
				record.type === "task-event" &&
				(Object.keys(record).some((k) => !["type", "event"].includes(k)) ||
					!validateTaskEventStructure(record.event))
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Invalid task event envelope",
				);
			if (
				record.type === "source-migration" &&
				(record.version !== 1 ||
					Object.keys(record).some((k) => !["type", "version"].includes(k)))
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Invalid source migration record",
				);
			if (
				record.type === "source-binding" &&
				(Object.keys(record).some((k) => !["type", "binding"].includes(k)) ||
					!(
						record.binding === null ||
						(record.binding &&
							typeof record.binding.path === "string" &&
							record.binding.path.startsWith("/") &&
							["automatic", "explicit"].includes(record.binding.origin) &&
							Object.keys(record.binding).every((k) =>
								["path", "origin"].includes(k),
							))
					))
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Invalid source binding record",
				);
		}
	}
	async load(threadId, { persist = true } = {}) {
		const paths = this.paths(threadId);
		let data;
		try {
			data = await readMarkdownRecords(paths.history, {
				kind: "task-progress",
				identity: threadId,
			});
		} catch (error) {
			throw new TaskStoreError("TASK_HISTORY_CORRUPT", error.message);
		}
		if (!data.exists) {
			try {
				await readFile(paths.heartbeat);
				throw new TaskStoreError(
					"TASK_HISTORY_CORRUPT",
					"Managed heartbeat exists without task history",
				);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
		this.validateRecords(data.records);
		const events = this.validateEvents(
			threadId,
			data.records.filter((r) => r.type === "task-event").map((r) => r.event),
		);
		const legacy = await this.legacy(paths.legacyEvents, threadId);
		const common = Math.min(events.length, legacy.events.length);
		if (
			legacy.events
				.slice(0, common)
				.some((e, i) => canonical(e) !== canonical(events[i]))
		)
			throw new TaskStoreError(
				"TASK_HISTORY_CONFLICT",
				"Legacy and Markdown task histories diverged",
			);
		let dirty = false;
		if (
			legacy.events.length > events.length ||
			(!data.exists && legacy.exists)
		) {
			data.records.push(
				...legacy.events
					.slice(events.length)
					.map((event) => ({ type: "task-event", event })),
			);
			dirty = true;
			data.exists = true;
			events.push(...legacy.events.slice(events.length));
		}
		try {
			await verifyTaskHistoryHead(paths.heartbeat, threadId, data.records);
		} catch (error) {
			throw new TaskStoreError("TASK_HISTORY_CORRUPT", error.message);
		}
		if (persist && dirty)
			await writeMarkdownRecords(paths.history, {
				kind: "task-progress",
				identity: threadId,
				records: data.records,
			});
		if (persist && data.exists)
			await writeTaskHistoryHead(paths.heartbeat, threadId, data.records);
		return { ...data, events, dirty, partialTail: legacy.partialTail };
	}

	async replay(threadId) {
		return (await this.load(threadId)).events;
	}
	async importFrom(
		threadId,
		sourceDirectory,
		{ includeBindings = false } = {},
	) {
		return this.serialize(threadId, async () => {
			const sourceHistory = resolve(sourceDirectory, "taskhistory.md");
			let source;
			try {
				source = await readMarkdownRecords(sourceHistory, {
					kind: "task-progress",
					identity: threadId,
				});
			} catch (error) {
				throw new TaskStoreError("TASK_HISTORY_CORRUPT", error.message);
			}
			this.validateRecords(source.records);
			const legacy = await this.legacy(
				resolve(sourceDirectory, "events.jsonl"),
				threadId,
			);
			const imported = source.exists
				? this.validateEvents(
						threadId,
						source.records
							.filter((r) => r?.type === "task-event")
							.map((r) => r.event),
					)
				: legacy.events;
			if (
				source.exists &&
				legacy.exists &&
				legacy.events.some(
					(e, i) =>
						i < imported.length && canonical(e) !== canonical(imported[i]),
				)
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CONFLICT",
					"Source histories diverged",
				);
			if (legacy.events.length > imported.length)
				imported.push(...legacy.events.slice(imported.length));
			const target = await this.load(threadId, { persist: false });
			const common = Math.min(target.events.length, imported.length);
			if (
				imported
					.slice(0, common)
					.some((e, i) => canonical(e) !== canonical(target.events[i]))
			)
				throw new TaskStoreError(
					"TASK_HISTORY_CONFLICT",
					"Imported and existing histories diverged",
				);
			const additions = imported
				.slice(target.events.length)
				.map((event) => ({ type: "task-event", event }));
			if (includeBindings && source.exists) {
				const sourceBindings = source.records.filter(
					(r) => r?.type === "source-binding" || r?.type === "source-migration",
				);
				const targetBindings = target.records.filter(
					(r) => r?.type === "source-binding" || r?.type === "source-migration",
				);
				const bindingCommon = Math.min(
					sourceBindings.length,
					targetBindings.length,
				);
				if (
					sourceBindings
						.slice(0, bindingCommon)
						.some((r, i) => canonical(r) !== canonical(targetBindings[i]))
				)
					throw new TaskStoreError(
						"TASK_HISTORY_CONFLICT",
						"Imported and existing source associations diverged",
					);
				additions.push(...sourceBindings.slice(targetBindings.length));
			}
			if (additions.length || target.dirty) {
				target.records.push(...additions);
				await writeMarkdownRecords(this.paths(threadId).history, {
					kind: "task-progress",
					identity: threadId,
					records: target.records,
				});
			}
			if (target.exists || additions.length)
				await writeTaskHistoryHead(
					this.paths(threadId).heartbeat,
					threadId,
					target.records,
				);
			return {
				migrated: additions.length > 0,
				importedEvents: Math.max(0, imported.length - target.events.length),
				partialTail: legacy.partialTail,
			};
		});
	}
	async get(threadId) {
		return this.serialize(
			threadId,
			async () => (await this.replay(threadId)).at(-1)?.state ?? null,
		);
	}
	async mutate(threadId, kind, input, build) {
		return this.serialize(threadId, async () => {
			const loaded = await this.load(threadId);
			const events = loaded.events;
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
			const records = [...loaded.records, { type: "task-event", event }];
			await writeMarkdownRecords(paths.history, {
				kind: "task-progress",
				identity: threadId,
				records,
			});
			await writeTaskHistoryHead(paths.heartbeat, threadId, records);
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
