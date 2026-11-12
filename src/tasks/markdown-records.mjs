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
