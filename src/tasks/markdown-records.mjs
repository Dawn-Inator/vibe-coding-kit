import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./task-io.mjs";
const queues = new Map();
export async function withMarkdownLock(key, work) {
	const result = (queues.get(key) ?? Promise.resolve())
		.catch(() => {})
		.then(work);
	queues.set(key, result);
	try {
		return await result;
	} finally {
		if (queues.get(key) === result) queues.delete(key);
	}
}
export async function readMarkdownRecords(path, { kind, identity }) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { exists: false, records: [] };
		throw error;
	}
	const matches = [
		...text.matchAll(/^```json task-records-v1\n([\s\S]*?)\n```\s*$/gm),
	];
	if (matches.length !== 1)
		throw new Error(`Corrupt Markdown records: ${path}`);
	let payload;
	try {
		payload = JSON.parse(matches[0][1]);
	} catch {
		throw new Error(`Corrupt Markdown records: ${path}`);
	}
	if (
		!payload ||
		payload.schemaVersion !== 1 ||
		payload.kind !== kind ||
		payload.identity !== identity ||
		!Array.isArray(payload.records) ||
		Object.keys(payload).some(
			(k) => !["schemaVersion", "kind", "identity", "records"].includes(k),
		)
	)
		throw new Error(
			`Invalid Markdown records identity, kind or version: ${path}`,
		);
	return { exists: true, records: payload.records };
}
export async function writeMarkdownRecords(path, { kind, identity, records }) {
	if (
		typeof kind !== "string" ||
		!kind ||
		typeof identity !== "string" ||
		!identity ||
		!Array.isArray(records)
	)
		throw new TypeError("Invalid Markdown records payload");
	const payload = JSON.stringify(
		{ schemaVersion: 1, kind, identity, records },
		null,
		2,
	);
	await atomicWriteFile(
		path,
		`# ${kind}\n\nPersistent records for ${JSON.stringify(identity)}.\n\n\`\`\`json task-records-v1\n${payload}\n\`\`\`\n`,
	);
}

function canonicalTaskRecords(value) {
	if (Array.isArray(value))
		return `[${value.map(canonicalTaskRecords).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalTaskRecords(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function taskHistoryDigest(records) {
	return createHash("sha256")
		.update(canonicalTaskRecords(records))
		.digest("hex");
}
/** Validate a committed head against the history prefix before mutating either file. */
export async function verifyTaskHistoryHead(path, identity, records) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if (e?.code === "ENOENT") return;
		throw e;
	}
	const matches = [
		...text.matchAll(/^```json task-heartbeat-v1\n([\s\S]*?)\n```\s*$/gm),
	];
	if (matches.length !== 1)
		throw new Error(
			"Task history head is corrupt: missing or duplicate managed payload",
		);
	const match = matches[0];
	let payload;
	try {
		payload = JSON.parse(match[1]);
	} catch {
		throw new Error("Task history head is corrupt: invalid payload JSON");
	}
	if (
		!payload ||
		payload.kind !== "task-heartbeat" ||
		payload.schemaVersion !== 1 ||
		payload.identity !== identity
	)
		throw new Error("Task history head identity or version is invalid");
	const proof = payload.historyProof;
	if (proof !== undefined) {
		if (
			!proof ||
			typeof proof !== "object" ||
			Array.isArray(proof) ||
			Object.keys(proof).some(
				(k) => !["recordCount", "historyDigest"].includes(k),
			) ||
			!Number.isSafeInteger(proof.recordCount) ||
			proof.recordCount < 0 ||
			typeof proof.historyDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(proof.historyDigest)
		)
			throw new Error("Task history head proof is corrupt");
		if (
			proof.recordCount > records.length ||
			taskHistoryDigest(records.slice(0, proof.recordCount)) !==
				proof.historyDigest
		)
			throw new Error(
				"Task history conflict: committed history is missing or diverged",
			);
	} else {
		const revision = payload.state?.revision;
		if (
			!payload.state ||
			typeof payload.state !== "object" ||
			payload.state.threadId !== identity ||
			!Number.isSafeInteger(revision) ||
			revision < 1
		)
			throw new Error("Task history legacy head is corrupt");
		const last =
			records.filter((r) => r?.type === "task-event").at(-1)?.event?.revision ??
			0;
		if (Number.isSafeInteger(revision) && revision > last)
			throw new Error(
				"Task history conflict: legacy head revision exceeds committed history",
			);
	}
}
/** Publish the current projection and a digest over all typed history records. */
export async function writeTaskHistoryHead(path, identity, records) {
	const state =
		records.filter((r) => r?.type === "task-event").at(-1)?.event?.state ??
		null;
	const lines = state
		? state.objectives
				.flatMap((o) => [
					`- [${o.status}] ${o.title}`,
					...(o.items ?? []).map((i) => `  - [${i.status}] ${i.title}`),
				])
				.join("\n")
		: "";
	const payload = JSON.stringify(
		{
			schemaVersion: 1,
			kind: "task-heartbeat",
			identity,
			state,
			historyProof: {
				recordCount: records.length,
				historyDigest: taskHistoryDigest(records),
			},
		},
		null,
		2,
	);
	const title = state
		? state.title.replace(/[\r\n]/g, " ")
		: "Task source associations";
	const text = `# ${title}\n\n${state ? `Revision: ${state.revision}\n\n${lines}\n\n` : ""}\`\`\`json task-heartbeat-v1\n${payload}\n\`\`\`\n`;
	let previous;
	try {
		previous = await readFile(path, "utf8");
	} catch (e) {
		if (e?.code !== "ENOENT") throw e;
	}
	if (previous !== text) await atomicWriteFile(path, text);
}
