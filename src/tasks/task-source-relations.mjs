import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	readMarkdownRecords,
	writeMarkdownRecords,
	withMarkdownLock,
} from "./markdown-records.mjs";
import {
	taskMarkdownPaths,
	validateTaskEventStructure,
} from "./task-store.mjs";
import { resolveProjectLedgerPath } from "./project-ledger-path.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function validBinding(value) {
	return (
		value === null ||
		(value &&
			typeof value === "object" &&
			typeof value.path === "string" &&
			isAbsolute(value.path) &&
			["automatic", "explicit"].includes(value.origin) &&
			Object.keys(value).every((k) => ["path", "origin"].includes(k)))
	);
}
async function optionalJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw new Error(`Invalid legacy source data: ${path}`);
	}
}
export class TaskSourceRelations {
	constructor(root, { legacyHeartbeatRoots = [], beforeWrite } = {}) {
		this.root = resolve(root);
		this.legacyHeartbeatRoots = legacyHeartbeatRoots.map((p) => resolve(p));
		this.beforeWrite = beforeWrite;
	}
	async load(threadId) {
		const paths = taskMarkdownPaths(this.root, threadId);
		const data = await readMarkdownRecords(paths.history, {
			kind: "task-progress",
			identity: threadId,
		});
		if (!data.exists) {
			try {
				await readFile(paths.heartbeat);
				throw new Error("Managed heartbeat exists without task history");
			} catch (e) {
				if (e?.code !== "ENOENT") throw e;
			}
		}
		let revision = 0;
		const eventIds = new Set();
		const requestIds = new Set();
		for (const r of data.records) {
			if (
				!r ||
				typeof r !== "object" ||
				!["task-event", "source-binding", "source-migration"].includes(r.type)
			)
				throw new Error("Invalid task history record");
			if (r.type === "task-event") {
				const e = r.event;
				if (
					Object.keys(r).some((k) => !["type", "event"].includes(k)) ||
					!validateTaskEventStructure(e) ||
					e.schemaVersion !== 3 ||
					e.threadId !== threadId ||
					!e.state ||
					e.state.threadId !== threadId ||
					e.revision !== ++revision ||
					e.state.revision !== revision ||
					typeof e.eventId !== "string" ||
					typeof e.requestId !== "string" ||
					typeof e.fingerprint !== "string" ||
					!["task.initialized", "task.updated", "task.rescoped"].includes(
						e.kind,
					) ||
					eventIds.has(e.eventId) ||
					requestIds.has(e.requestId)
				)
					throw new Error("Invalid task event record");
				eventIds.add(e.eventId);
				requestIds.add(e.requestId);
			}
			if (
				r.type === "source-binding" &&
				(!validBinding(r.binding) ||
					Object.keys(r).some((k) => !["type", "binding"].includes(k)))
			)
				throw new Error("Invalid source binding record");
			if (
				r.type === "source-migration" &&
				(r.version !== 1 ||
					Object.keys(r).some((k) => !["type", "version"].includes(k)))
			)
				throw new Error("Invalid source migration record");
		}
		return data;
	}
	async write(threadId, records) {
		await this.beforeWrite?.();
		await writeMarkdownRecords(taskMarkdownPaths(this.root, threadId).history, {
			kind: "task-progress",
			identity: threadId,
			records,
		});
	}
	async getUnlocked(threadId) {
		const data = await this.load(threadId);
		let binding = data.records
			.filter((r) => r.type === "source-binding")
			.at(-1);
		if (binding) return { found: true, binding: binding.binding };
		if (data.records.some((r) => r.type === "source-migration"))
			return { found: false, binding: null };
		const roots = [
			...new Set([
				resolve(this.root, "sessions", hash(threadId), "heartbeat"),
				...this.legacyHeartbeatRoots,
			]),
		];
		let explicit;
		let automatic;
		for (const root of roots) {
			const entries = await optionalJson(resolve(root, "bindings.json"));
			if (entries !== undefined) {
				if (!entries || typeof entries !== "object" || Array.isArray(entries))
					throw new Error("Invalid legacy bindings");
				if (Object.hasOwn(entries, threadId)) {
					const raw = entries[threadId];
					const value =
						raw === null
							? null
							: typeof raw === "string"
								? { path: raw, origin: "explicit" }
								: raw;
					if (!validBinding(value))
						throw new Error("Invalid legacy binding for thread");
					if (
						explicit !== undefined &&
						JSON.stringify(explicit) !== JSON.stringify(value)
					)
						throw new Error("Conflicting legacy source bindings");
					explicit = value;
				}
			}
		}
		if (explicit === undefined)
			for (const root of roots) {
				const snapshot = await optionalJson(
					resolve(root, `${hash(threadId)}.snapshot.json`),
				).catch(() => undefined);
				if (
					snapshot &&
					typeof snapshot === "object" &&
					snapshot.view &&
					typeof snapshot.view === "object"
				) {
					const view = snapshot.view;
					if (
						view.status === "ready" &&
						typeof view.sourcePath === "string" &&
						isAbsolute(view.sourcePath) &&
						view.contentHash
					)
						automatic ??= { path: view.sourcePath, origin: "automatic" };
				}
			}
		const selected = explicit !== undefined ? explicit : automatic;
		if (selected === undefined && !data.exists)
			return { found: false, binding: null };
		data.records.push({ type: "source-migration", version: 1 });
		if (selected !== undefined)
			data.records.push({ type: "source-binding", binding: selected });
		await this.write(threadId, data.records);
		return { found: selected !== undefined, binding: selected ?? null };
	}
	async get(threadId) {
		return withMarkdownLock(
			taskMarkdownPaths(this.root, threadId).directory,
			() => this.getUnlocked(threadId),
		);
	}
	async set(threadId, binding) {
		if (!validBinding(binding)) throw new TypeError("Invalid source binding");
		return withMarkdownLock(
			taskMarkdownPaths(this.root, threadId).directory,
			async () => {
				const data = await this.load(threadId);
				data.records.push({ type: "source-binding", binding });
				await this.write(threadId, data.records);
				return { found: true, binding };
			},
		);
	}
	async resolve(threadId, { projectRoot, discovery }) {
		return withMarkdownLock(
			taskMarkdownPaths(this.root, threadId).directory,
			async () => {
				const previous = await this.getUnlocked(threadId);
				if (previous.found) {
					if (previous.binding === null)
						return { status: "none", binding: null };
					try {
						const resolved = await resolveProjectLedgerPath(
							projectRoot,
							previous.binding.path,
						);
						const candidate = discovery.candidates.find(
							(c) => c.path === resolved.path,
						);
						if (
							!candidate ||
							(previous.binding.origin === "automatic" && !candidate.associated)
						)
							return { status: "stale", binding: previous.binding };
						return { status: "ready", binding: previous.binding };
					} catch (error) {
						return {
							status: "stale",
							binding: previous.binding,
							error: String(error.message ?? error),
						};
					}
				}
				const associated = discovery.candidates.filter((c) => c.associated);
				if (!discovery.complete || associated.length > 1)
					return { status: "pending-selection", binding: null };
				if (associated.length === 1) {
					const path = (
						await resolveProjectLedgerPath(projectRoot, associated[0].path)
					).path;
					const binding = { path, origin: "automatic" };
					const data = await this.load(threadId);
					data.records.push({ type: "source-binding", binding });
					await this.write(threadId, data.records);
					return { status: "ready", binding };
				}
				return {
					status: discovery.candidates.length ? "candidates" : "none",
					binding: null,
				};
			},
		);
	}
}
