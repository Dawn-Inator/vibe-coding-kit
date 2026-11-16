// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	readMarkdownRecords,
	readBoundedText,
	writeMarkdownRecords,
	withMarkdownLock,
	verifyTaskHistoryHead,
	writeTaskHistoryHead,
} from "./markdown-records.mjs";
import {
	calculateTaskProgress,
	calculateTaskLifecycleProgress,
	hasOpenTaskWork,
	isTaskLifecycleComplete,
} from "./task-contract.mjs";

// Leave room for the surrounding IPC envelope. The raw journal is never truncated.
const SUMMARY_PAGE_BYTES = 512 * 1024;
const SUMMARY_REASON_CHARACTERS = 512;

function summarizeHistoryEvent(event) {
	const characters = Array.from(event.reason);
	return {
		revision: event.revision,
		kind: event.kind,
		occurredAt: event.occurredAt,
		reason: characters.slice(0, SUMMARY_REASON_CHARACTERS).join(""),
		reasonTruncated: characters.length > SUMMARY_REASON_CHARACTERS,
		before: event.before,
		after: event.after,
	};
}

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
function validReceipt(receipt) {
	const evidence = (items) =>
		Array.isArray(items) &&
		items.length > 0 &&
		items.length <= 20 &&
		items.every(
			(e) =>
				e &&
				typeof e === "object" &&
				Object.keys(e).every((k) => ["summary", "verification", "kind", "reference"].includes(k)) &&
				typeof e.summary === "string" &&
				e.summary.trim() &&
				e.summary.length <= 2000 &&
				e.verification === "verified" &&
				typeof e.reference === "string" &&
				e.reference.trim() &&
				e.reference.length <= 4096 &&
				(e.kind === undefined ||
					(typeof e.kind === "string" && e.kind.trim() && e.kind.length <= 100)),
		);
	const check = (v) =>
		v &&
		typeof v === "object" &&
		Object.keys(v).every((k) => ["status", "evidence"].includes(k)) &&
		["done", "not-applicable"].includes(v.status) &&
		evidence(v.evidence);
	return (
		receipt &&
		typeof receipt === "object" &&
		Object.keys(receipt).every((k) =>
			["branch", "merge", "push", "remainingWork", "ownerActions", "auditEvidence"].includes(k),
		) &&
		check(receipt.branch) &&
		check(receipt.merge) &&
		check(receipt.push) &&
		receipt.remainingWork === 0 &&
		receipt.ownerActions === 0 &&
		evidence(receipt.auditEvidence)
	);
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
			(v.evidence !== undefined && (!Array.isArray(v.evidence) || v.evidence.length > 100))
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
		![3, 4].includes(e.schemaVersion) ||
		![
			"task.initialized",
			"task.updated",
			"task.rescoped",
			...(e.schemaVersion === 4 ? ["task.completed"] : []),
		].includes(e.kind) ||
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
			...(e.schemaVersion === 4 ? ["lifecycle"] : []),
		]) &&
		state.schemaVersion === e.schemaVersion &&
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
		["active", "completed"].includes(state.phase) &&
		(e.schemaVersion === 3 ||
			(e.after.completed === state.progress.completed &&
				e.after.total === state.progress.total &&
				e.after.percent === state.progress.percent &&
				object(state.lifecycle, ["id", "sequence", "startedAt", "completion"]) &&
				str(state.lifecycle.id, 128) &&
				Number.isInteger(state.lifecycle.sequence) &&
				state.lifecycle.sequence > 0 &&
				date(state.lifecycle.startedAt) &&
				(state.lifecycle.completion === null ||
					(object(state.lifecycle.completion, ["completedAt", "receipt"]) &&
						date(state.lifecycle.completion.completedAt) &&
						validReceipt(state.lifecycle.completion.receipt))) &&
				(state.phase === "completed") === (state.lifecycle.completion !== null) &&
				(e.kind === "task.completed") === (state.lifecycle.completion !== null) &&
				JSON.stringify(state.progress) ===
					JSON.stringify(
						calculateTaskLifecycleProgress(state.objectives, state.lifecycle.completion !== null),
					) &&
				(state.lifecycle.completion === null || !hasOpenTaskWork(state.objectives))))
	);
}
// Shared by every writer of the journal, including source association updates.
export function isValidTaskLifecycleTransition(previous, event) {
	if (event.schemaVersion !== 4) return previous?.schemaVersion !== 4;
	const life = event.state.lifecycle;
	const old = previous?.schemaVersion === 4 ? previous.lifecycle : null;
	return old
		? old.completion
			? event.kind === "task.rescoped" &&
				life.sequence === old.sequence + 1 &&
				life.id !== old.id &&
				life.completion === null
			: life.sequence === old.sequence && life.id === old.id && life.startedAt === old.startedAt &&
				(event.kind !== "task.completed" ||
					(!hasOpenTaskWork(previous.objectives) &&
						event.state.title === previous.title &&
						event.state.createdAt === previous.createdAt &&
						canonical(event.state.objectives) === canonical(previous.objectives)))
		: life.sequence === 1 && life.completion === null;
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
		let prior = null;
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
			if (!isValidTaskLifecycleTransition(prior, event))
				throw new TaskStoreError("TASK_HISTORY_CORRUPT", "Invalid task lifecycle transition");
			prior = event.state;
			ids.add(event.eventId);
			requests.add(event.requestId);
			// Parsing validates; the original event remains authoritative, including unknown fields.
			return raw;
		});
	}
	async legacy(path, threadId, reader = readFile) {
		let text;
		try {
			text = await reader(path, "utf8");
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
	async load(threadId, { persist = true, reader = readFile } = {}) {
		if (persist && reader !== readFile) throw new TypeError("Custom readers cannot authorize writes");
		const paths = this.paths(threadId);
		let data;
		try {
			data = await readMarkdownRecords(paths.history, {
				kind: "task-progress",
				identity: threadId,
				reader,
			});
		} catch (error) {
			throw new TaskStoreError("TASK_HISTORY_CORRUPT", error.message);
		}
		if (!data.exists) {
			try {
				await reader(paths.heartbeat, "utf8");
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
		const legacy = await this.legacy(paths.legacyEvents, threadId, reader);
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
			await verifyTaskHistoryHead(paths.heartbeat, threadId, data.records, reader);
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

	/** Bounded display-only read. Does not publish heads, migrate legacy records or bind sources. */
	async getReadOnly(threadId, { maxBytes = 1024 * 1024, beforeOpen, afterOpen } = {}) {
		return this.serialize(threadId, async () => {
			let canonicalRoot;
			try { canonicalRoot = await realpath(this.root); }
			catch (error) {
				if (isMissing(error)) return { state: null, sourceBound: false, uncertain: false };
				throw error;
			}
			const reader = (path) => readBoundedText(path, maxBytes, { trustedRoot: canonicalRoot, beforeOpen, afterOpen });
			const loaded = await this.load(threadId, { persist: false, reader });
			const binding = loaded.records.filter((record) => record.type === "source-binding").at(-1);
			return { state: loaded.dirty || loaded.partialTail || (binding && binding.binding !== null) ? null : (loaded.events.at(-1)?.state ?? null), sourceBound: Boolean(binding && binding.binding !== null), uncertain: loaded.dirty || loaded.partialTail };
		});
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
			const { lifecycle: _policy, ...businessInput } = input;
			const fingerprint = digest(canonical({ kind, input: businessInput }));
			const duplicate = events.find((event) => event.requestId === input.requestId);
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
			const now = new Date().toISOString();
			const next = build(previous);
			const managed = previous?.schemaVersion === 4 || input.lifecycle === true;
			let lifecycle;
			if (managed) {
				lifecycle =
					previous?.schemaVersion === 4
						? previous.lifecycle
						: {
								id: randomUUID(),
								sequence: 1,
								startedAt: now,
								completion: null,
							};
				if (kind === "task.rescoped" && isTaskLifecycleComplete(previous))
					lifecycle = {
						id: randomUUID(),
						sequence: previous.lifecycle.sequence + 1,
						startedAt: now,
						completion: null,
					};
				if (kind === "task.completed")
					lifecycle = {
						...lifecycle,
						completion: {
							completedAt: now,
							receipt: input.closeout,
						},
					};
			}
			const progress = managed
				? calculateTaskLifecycleProgress(next.objectives, !!lifecycle.completion)
				: calculateTaskProgress(next.objectives);
			const state = this.schemas.TaskStateSchema.parse({
				schemaVersion: managed ? 4 : 3,
				kind: "task",
				...(managed ? { lifecycle } : {}),
				threadId,
				...next,
				revision: (previous?.revision ?? 0) + 1,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				progress,
				phase: (
					managed
						? !!lifecycle.completion
						: progress.total > 0 && progress.completed === progress.total
				)
					? "completed"
					: "active",
			});
			const event = this.schemas.TaskEventSchema.parse({
				schemaVersion: managed ? 4 : 3,
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
			if (!previous) throw new TaskStoreError("TASK_NOT_INITIALIZED", "Initialize the task first");
			if (isTaskLifecycleComplete(previous))
				throw new TaskStoreError(
					"TASK_CLOSED",
					"Closed tasks cannot be updated; rescope to start new work",
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
					throw new TaskStoreError("TASK_TARGET_NOT_FOUND", `Unknown task item ${change.targetId}`);
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
			if (!previous) throw new TaskStoreError("TASK_NOT_INITIALIZED", "Initialize the task first");
			let objectives = structuredClone(input.objectives);
			if (isTaskLifecycleComplete(previous)) {
				objectives = objectives.flatMap((objective) => {
					const old = previous.objectives.find((entry) => entry.id === objective.id);
					if (!old) return [objective];
					const sameFields =
						canonical({ ...objective, items: [] }) === canonical({ ...old, items: [] });
					const items = objective.items.filter(
						(item) =>
							!old.items.some(
								(prior) => prior.id === item.id && canonical(prior) === canonical(item),
							),
					);
					if (sameFields && items.length === 0) return [];
					return [
						{
							...objective,
							...(items.length === 0 &&
							objective.status === "completed" &&
							objective.evidence.length === 0
								? { status: "pending" }
								: {}),
							items,
						},
					];
				});
				if (!objectives.length)
					throw new TaskStoreError("TASK_NO_NEW_WORK", "A new cycle requires new or changed work");
				return {
					title: input.title ?? objectives[0].title,
					objectives: this.schemas.TaskObjectivesSchema.parse(objectives),
				};
			}
			// Scope removal is represented by cancellation, never disappearance from the current registry.
			for (const old of previous.objectives) {
				const retained = objectives.find((objective) => objective.id === old.id);
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

	async complete(threadId, value) {
		const input = this.schemas.TaskCompleteInputSchema.parse(value);
		return this.mutate(threadId, "task.completed", input, (previous) => {
			if (!previous) throw new TaskStoreError("TASK_NOT_INITIALIZED", "Initialize the task first");
			if (previous.schemaVersion !== 4)
				throw new TaskStoreError("TASK_NOT_MANAGED", "Opt in to lifecycle before completing");
			if (isTaskLifecycleComplete(previous))
				throw new TaskStoreError("TASK_CLOSED", "Task is already closed");
			if (hasOpenTaskWork(previous.objectives))
				throw new TaskStoreError(
					"TASK_OPEN_WORK",
					"All non-cancelled objectives and items must be completed",
				);
			return { title: previous.title, objectives: previous.objectives };
		});
	}

	async archives(threadId, options = {}) {
		return this.archivePage(threadId, null, options);
	}
	async archive(threadId, taskId, options = {}) {
		if (typeof taskId !== "string" || !taskId.trim())
			throw new TaskStoreError("TASK_ARCHIVE_INVALID", "Archive task ID is required");
		return this.archivePage(threadId, taskId, options);
	}
	async archivePage(threadId, taskId, options) {
		return this.serialize(threadId, async () => {
			const { events } = await this.load(threadId, { persist: false });
			const current = events.at(-1)?.state;
			const currentTaskId = current?.schemaVersion === 4 ? current.lifecycle.id : null;
			const closed = events
				.filter(
					(e) =>
						e.schemaVersion === 4 &&
						e.kind === "task.completed" &&
						e.state.lifecycle.id !== currentTaskId,
				)
				.reverse();
			const summary = (e) => ({
				id: e.state.lifecycle.id,
				title: e.state.title,
				completedAt: e.state.lifecycle.completion.completedAt,
				completionRevision: e.revision,
				progress: e.state.progress,
				objectiveCount: e.state.objectives.length,
				itemCount: e.state.objectives.reduce((n, o) => n + o.items.length, 0),
			});
			const limit = options.limit ?? (taskId ? 50 : 10);
			if (!Number.isInteger(limit) || limit < 1 || limit > 100)
				throw new TaskStoreError("TASK_ARCHIVE_PAGE_INVALID", "Archive limit must be 1–100");
			const scope = digest(canonical({ threadId, taskId, currentTaskId }));
			let offset = 0;
			if (options.cursor !== undefined) {
				try {
					const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
					if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1)
						throw new Error();
					offset = parsed.offset;
				} catch {
					throw new TaskStoreError("TASK_ARCHIVE_CURSOR_INVALID", "Invalid archive cursor");
				}
			}
			let entries, base;
			if (taskId) {
				const event = closed.find((e) => e.state.lifecycle.id === taskId);
				if (!event) throw new TaskStoreError("TASK_ARCHIVE_NOT_FOUND", "Archived task not found");
				entries = event.state.objectives.flatMap((o) => [
					{
						id: o.id,
						title: o.title,
						status: o.status,
						kind: "objective",
						required: o.required,
					},
					...o.items.map((i) => ({
						id: i.id,
						title: i.title,
						status: i.status,
						kind: "item",
						parentId: o.id,
					})),
				]);
				base = {
					kind: "subtasks",
					task: summary(event),
					totalNodes: entries.length,
					currentTaskId,
				};
			} else {
				entries = closed.map(summary);
				base = { kind: "tasks", total: entries.length, currentTaskId };
			}
			if (offset > entries.length)
				throw new TaskStoreError("TASK_ARCHIVE_CURSOR_INVALID", "Archive cursor is out of range");
			const key = taskId ? "nodes" : "tasks";
			const page = [];
			for (const entry of entries.slice(offset, offset + limit)) {
				const candidate = [...page, entry];
				if (
					Buffer.byteLength(
						JSON.stringify({
							...base,
							[key]: candidate,
							nextCursor: "x".repeat(256),
						}),
					) > SUMMARY_PAGE_BYTES
				) {
					if (!page.length)
						throw new TaskStoreError(
							"TASK_ARCHIVE_PAGE_TOO_LARGE",
							"Archive entry exceeds page budget",
						);
					break;
				}
				page.push(entry);
			}
			const nextOffset = offset + page.length;
			const nextCursor =
				nextOffset < entries.length
					? Buffer.from(
							JSON.stringify({
								scope,
								offset: nextOffset,
							}),
						).toString("base64url")
					: null;
			return { ...base, [key]: page, nextCursor };
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
			if (options.projection === "summary") {
				const page = [];
				const canonicalHistoryPath = taskMarkdownPaths(this.root, threadId).history;
				for (const event of eligible.slice(0, limit)) {
					const summary = summarizeHistoryEvent(event);
					const candidate = [...page, summary];
					// Measure the serialized result itself, including cursor and source metadata.
					if (Buffer.byteLength(JSON.stringify({ events: candidate, nextCursor: String(event.revision), canonicalHistoryPath })) > SUMMARY_PAGE_BYTES - 1024) {
						if (page.length === 0)
							throw new TaskStoreError("TASK_HISTORY_PAGE_TOO_LARGE", "History summary cannot fit the page budget");
						break;
					}
					page.push(summary);
				}
				return {
					events: page,
					nextCursor: eligible.length > page.length ? String(page.at(-1).revision) : null,
					canonicalHistoryPath,
				};
			}
			if (options.projection !== undefined && options.projection !== "raw")
				throw new TaskStoreError("TASK_HISTORY_PROJECTION_INVALID", "Invalid history projection");
			const page = eligible.slice(0, limit);
			return {
				events: page,
				nextCursor:
					eligible.length > limit ? String(page.at(-1)?.revision) : null,
			};
		});
	}
}
