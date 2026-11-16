import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
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
/** Read no more than maxBytes even if a file grows while being read. */
export async function readBoundedText(path, maxBytes, { trustedRoot, beforeOpen, afterOpen } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) throw new RangeError("Invalid record byte limit");
  await beforeOpen?.(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    await afterOpen?.(path);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Task record is not a regular file");
    if (trustedRoot !== undefined) {
      let verifiedRoot;
      try { verifiedRoot = await realpath(trustedRoot); }
      catch (error) { throw new Error("Task storage root changed", { cause: error }); }
      if (verifiedRoot !== trustedRoot) throw new Error("Task storage root changed");
      let canonicalPath;
      try { canonicalPath = await realpath(path); }
      catch (error) { throw new Error("Task record changed during open", { cause: error }); }
      const boundary = relative(trustedRoot, canonicalPath);
      if (boundary === ".." || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)) throw new Error("Task record escapes storage root");
      let entry;
      let current;
      try { entry = await lstat(path); current = await stat(canonicalPath); }
      catch (error) { throw new Error("Task record changed during open", { cause: error }); }
      if (!entry.isFile() || opened.dev !== current.dev || opened.ino !== current.ino || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error("Task record changed during open");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new RangeError("Task record exceeds byte limit");
    return buffer.subarray(0, used).toString("utf8");
  } finally { await handle.close(); }
}
async function readManagedRecords(path, kind, reader = readFile) {
	let text;
	try {
		text = await reader(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
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
		(typeof payload.identity !== "string" || !payload.identity.trim()) ||
		!Array.isArray(payload.records) ||
		Object.keys(payload).some(
			(k) => !["schemaVersion", "kind", "identity", "records"].includes(k),
		)
	)
		throw new Error(
			`Invalid Markdown records identity, kind or version: ${path}`,
		);
	return payload;
}
/** Inspect the identity of a strictly validated managed record, without writing. */
export async function inspectMarkdownRecordsIdentity(path, { kind }) {
	return (await readManagedRecords(path, kind))?.identity ?? null;
}
export async function readMarkdownRecords(path, { kind, identity, reader }) {
	const payload = await readManagedRecords(path, kind, reader);
	if (!payload) return { exists: false, records: [] };
	if (payload.identity !== identity)
		throw new Error(`Invalid Markdown records identity, kind or version: ${path}`);
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
export async function verifyTaskHistoryHead(path, identity, records, reader = readFile) {
	let text;
	try {
		text = await reader(path, "utf8");
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
