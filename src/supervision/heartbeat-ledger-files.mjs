import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
	fsyncSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseWakes, WAKE_HEADING_RE } from "./check-heartbeat-ledger.mjs";
import { inspectHeartbeatLedger } from "./heartbeat-ledger-api.mjs";
import {
	resolveProjectLedgerPathSync,
	validateProjectLedgerSidecarSync,
} from "../tasks/project-ledger-path.mjs";
import {
	atomicCreateFileSync,
	atomicWriteFileSync,
} from "../tasks/task-io.mjs";

const WAKE = WAKE_HEADING_RE;
const HEAD = /^<!-- heartbeat-head:v2 source=([^\s>]+) history=([^\s>]+) -->\n/;
const HISTORY =
	/^<!-- heartbeat-history:v3 source=([^\s>]+) body=([a-f0-9]{64}) base=([a-f0-9]{64}) bytes=(\d+) backup=([a-f0-9]{64}) previous=([a-f0-9]{64}) planned=([A-Za-z0-9+/=]+) -->\n/;
const OLD_HISTORY =
	/^<!-- heartbeat-history:v1 source=([^\s>]+)(?: pending=([a-f0-9]{64}))? -->\n/;
const sha = (text) => createHash("sha256").update(text).digest("hex");
export function heartbeatLedgerPairPaths(path) {
	if (typeof path !== "string" || !path.trim())
		throw new TypeError("path is required");
	const headPath = resolve(path),
		name = basename(headPath);
	const historyPath =
		name.toLowerCase() === "heartbeat.md"
			? resolve(dirname(headPath), "taskhistory.md")
			: resolve(
					dirname(headPath),
					`${name.replace(/\.md$/i, "")}.taskhistory.md`,
				);
	return { headPath, historyPath, legacyBackupPath: `${headPath}.legacy` };
}
function safePaths(root, path) {
	if (typeof root !== "string" || !root.trim() || !isAbsolute(root))
		throw new TypeError("root must be an absolute path");
	if (typeof path !== "string" || !path.trim())
		throw new TypeError("path is required");
	const canonicalRoot = realpathSync(root),
		requested = resolve(canonicalRoot, path);
	if (
		basename(requested).toLowerCase() === "taskhistory.md" ||
		requested.endsWith(".taskhistory.md") ||
		requested.endsWith(".legacy") ||
		requested.endsWith(".lock") ||
		/\.tmp(?:-|$)/i.test(requested)
	)
		throw new Error(
			"History, backup, lock, and temporary files cannot be used as heartbeat heads",
		);
	const { path: canonicalHead } = resolveProjectLedgerPathSync(
		canonicalRoot,
		requested,
	);
	const paths = heartbeatLedgerPairPaths(canonicalHead);
	for (const companion of [
		paths.historyPath,
		paths.legacyBackupPath,
		`${paths.headPath}.lock`,
	]) {
		const validated = validateProjectLedgerSidecarSync(
			canonicalRoot,
			companion,
		);
		if (validated.exists && validated.path !== companion)
			throw new Error("Heartbeat companion paths cannot be symlinks");
	}
	if (canonicalHead === paths.historyPath)
		throw new Error("History files cannot be used as heartbeat heads");
	return { ...paths, root: canonicalRoot };
}
function atomicWrite(path, text) {
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	atomicWriteFileSync(path, text, { mode });
}
function withWriterLock(paths, work) {
	const lock = `${paths.headPath}.lock`;
	let fd;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if (error?.code === "EEXIST")
			throw new Error("Heartbeat writer lock is held or requires recovery");
		throw error;
	}
	try {
		writeFileSync(fd, `${process.pid}\n`);
		fsyncSync(fd);
		return work();
	} finally {
		closeSync(fd);
		unlinkSync(lock);
	}
}
function requireOwnership(options) {
	if (options.legacyWritersQuiescent !== true)
		throw new Error(
			"Heartbeat writes require explicit exclusive ownership and quiescent legacy writers",
		);
	if (
		typeof options.expectedContentHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(options.expectedContentHash)
	)
		throw new Error(
			"Heartbeat writes require expectedContentHash from a fresh read",
		);
}
function assertExpected(paths, expected) {
	const head = readFileSync(paths.headPath, "utf8");
	const history = existsSync(paths.historyPath)
		? readFileSync(paths.historyPath, "utf8")
		: "";
	if (sha(`${head}\0${history}`) !== expected)
		throw new Error(
			"Heartbeat version conflict: source changed since observation",
		);
}
function splitWakeSections(text) {
	const lines = text.split("\n");
	const sections = [];
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!WAKE.test(lines[i])) continue;
		if (start >= 0) sections.push(lines.slice(start, i).join("\n"));
		start = i;
	}
	if (start >= 0) sections.push(lines.slice(start).join("\n"));
	return sections;
}
// Remove only superseded wake sections; independent headings, inventory and unknown text survive.
function latestHead(text) {
	const lines = text.split(/(?<=\n)/);
	const starts = [];
	for (let i = 0; i < lines.length; i++)
		if (WAKE.test(lines[i].trimEnd())) starts.push(i);
	if (starts.length < 2) return text;
	const remove = new Set();
	for (const start of starts.slice(0, -1)) {
		const level = /^#+/.exec(lines[start])[0].length;
		let end = start + 1;
		while (end < lines.length) {
			const heading = /^(#{1,6})\s+/.exec(lines[end]);
			if (heading && heading[1].length <= level) break;
			end++;
		}
		remove.add(start);
		for (let i = start + 1; i < end; i++) {
			// Wake table rows and their source line belong to the archived record. Preserve
			// independent prose and comments even when they occur between headings.
			if (/^\s*(?:\||sources\s*:|[-]{3,}\s*$)/i.test(lines[i])) remove.add(i);
		}
	}
	return lines.filter((_, i) => !remove.has(i)).join("");
}
function appendHead(previous, wake) {
	// Appending and re-projecting retains every non-wake heading, including Items in any position.
	return latestHead(
		`${previous}${previous.endsWith("\n") ? "" : "\n"}${wake}${wake.endsWith("\n") ? "" : "\n"}`,
	);
}
function headMarker(paths) {
	return `<!-- heartbeat-head:v2 source=${encodeURIComponent(paths.headPath)} history=${encodeURIComponent(paths.historyPath)} -->\n`;
}
function canonicalHead(raw, paths) {
	return headMarker(paths) + latestHead(raw.replace(HEAD, ""));
}
function historyText(body, head, backup, paths, previousHead) {
	return `<!-- heartbeat-history:v3 source=${encodeURIComponent(paths.headPath)} body=${sha(body)} base=${sha(head)} bytes=${Buffer.byteLength(head)} backup=${sha(backup)} previous=${sha(previousHead)} planned=${Buffer.from(head, "utf8").toString("base64")} -->\n${body}`;
}
function verifiedHistory(paths) {
	if (!existsSync(paths.historyPath))
		throw new Error("Heartbeat history companion missing");
	const history = readFileSync(paths.historyPath, "utf8"),
		match = HISTORY.exec(history);
	if (!match || decodeURIComponent(match[1]) !== paths.headPath)
		throw new Error(
			"Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	if (!existsSync(paths.legacyBackupPath))
		throw new Error("Heartbeat pair is incomplete: immutable backup missing");
	const backup = readFileSync(paths.legacyBackupPath, "utf8"),
		body = history.slice(match[0].length);
	const plannedBuffer = Buffer.from(match[7], "base64"),
		planned = plannedBuffer.toString("utf8");
	const plannedRef = HEAD.exec(planned);
	if (
		sha(backup) !== match[5] ||
		sha(body) !== match[2] ||
		plannedBuffer.toString("base64") !== match[7] ||
		!Buffer.from(planned, "utf8").equals(plannedBuffer) ||
		sha(plannedBuffer) !== match[3] ||
		plannedBuffer.length !== Number(match[4]) ||
		!plannedRef ||
		decodeURIComponent(plannedRef[1]) !== paths.headPath ||
		decodeURIComponent(plannedRef[2]) !== paths.historyPath
	)
		throw new Error(
			"Heartbeat pair integrity check failed for history, backup or planned head",
		);
	return { history, match, body, planned };
}

function readPair(paths) {
	const headText = readFileSync(paths.headPath, "utf8");
	const headMatch = HEAD.exec(headText);
	if (!existsSync(paths.historyPath)) {
		if (headMatch || /^<!-- heartbeat-head:v\d+\b/.test(headText))
			throw new Error(
				"Canonical heartbeat head references a missing history companion",
			);
		return {
			headText,
			historyText: "",
			fullText: headText,
			contentHash: sha(`${headText}\0`),
			modifiedAt: new Date(statSync(paths.headPath).mtimeMs).toISOString(),
			headPath: paths.headPath,
			historyPath: paths.historyPath,
			isLegacy: true,
			wakes: parseWakes(headText).map((w) => ({
				...w,
				sourcePath: paths.headPath,
				sourceLine: w.line,
			})),
		};
	}
	const { history, match, body } = verifiedHistory(paths);
	if (!headMatch)
		throw new Error("Heartbeat pair is incomplete: head reference missing");
	if (
		decodeURIComponent(headMatch[1]) !== paths.headPath ||
		decodeURIComponent(headMatch[2]) !== paths.historyPath
	)
		throw new Error("Heartbeat head references an unrelated history companion");
	const bytes = Number(match[4]),
		buffer = Buffer.from(headText, "utf8");
	if (
		!Number.isSafeInteger(bytes) ||
		bytes < Buffer.byteLength(headMatch[0]) ||
		bytes > buffer.length ||
		sha(buffer.subarray(0, bytes)) !== match[3]
	)
		throw new Error(
			"Heartbeat pair is incomplete or current head was modified; recovery required",
		);
	const suffix = buffer.subarray(bytes).toString("utf8");
	const fullText = `${body}${body.endsWith("\n") || !suffix ? "" : "\n"}${suffix}`;
	const archive = parseWakes(body).map((w) => ({
		...w,
		sourcePath: paths.historyPath,
		sourceLine: w.line + 1,
	}));
	const prefixLines =
		buffer.subarray(0, bytes).toString("utf8").split("\n").length - 1;
	const appended = parseWakes(suffix).map((w) => ({
		...w,
		sourcePath: paths.headPath,
		sourceLine: w.line + prefixLines,
	}));
	return {
		headText,
		historyText: history,
		fullText,
		contentHash: sha(`${headText}\0${history}`),
		modifiedAt: new Date(
			Math.max(
				statSync(paths.headPath).mtimeMs,
				statSync(paths.historyPath).mtimeMs,
			),
		).toISOString(),
		headPath: paths.headPath,
		historyPath: paths.historyPath,
		isLegacy: false,
		wakes: [...archive, ...appended],
	};
}
export function readHeartbeatLedgerPair({ root, path }) {
	return readPair(safePaths(root, path));
}

// Audit one coherent view: the live head supplies the inventory and all non-wake
// content; historical wakes remain in their original order for cross-wake guards.
function auditText(pair) {
	if (pair.isLegacy) return pair.fullText;
	const headLines = pair.headText.split("\n");
	for (const wake of parseWakes(pair.headText)) {
		const start = wake.line - 1;
		let inventoryLevel = null;
		for (let i = start; i <= start + wake.sectionLines.length; i++) {
			const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(headLines[i]);
			if (
				inventoryLevel !== null &&
				heading &&
				heading[1].length <= inventoryLevel
			)
				inventoryLevel = null;
			if (heading && /^Items$/i.test(heading[2]))
				inventoryLevel = heading[1].length;
			if (inventoryLevel === null) headLines[i] = "";
		}
	}
	const wakes = parseWakes(pair.fullText).map((w) => {
		let inventoryLevel = null;
		const lines = w.sectionLines.map((line) => {
			const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
			if (
				inventoryLevel !== null &&
				heading &&
				heading[1].length <= inventoryLevel
			)
				inventoryLevel = null;
			if (heading && /^Items$/i.test(heading[2]))
				inventoryLevel = heading[1].length;
			return inventoryLevel === null ? line : "";
		});
		return [w.heading, ...lines].join("\n");
	});
	return `${headLines.join("\n")}\n${wakes.join("\n\n")}`;
}

export function inspectHeartbeatLedgerPair(
	pair,
	{
		mode = "current",
		latest = true,
		now = new Date(),
		inspect = inspectHeartbeatLedger,
		...options
	} = {},
) {
	if (
		!pair ||
		typeof pair.headText !== "string" ||
		typeof pair.fullText !== "string"
	)
		throw new TypeError("A heartbeat ledger pair is required");
	const text = mode === "items" ? pair.headText : auditText(pair);
	const report = inspect(text, { mode, latest, now, ...options });
	if (mode !== "items") {
		const headInventory = inspect(pair.headText, {
			mode: "items",
			latest: true,
			now,
			...options,
		});
		report.items = headInventory.items;
		report.itemCount = headInventory.itemCount;
		report.tables = headInventory.tables;
	}
	let sourceIndex = 0;
	for (const wake of report.wakes ?? []) {
		let source = pair.wakes?.[sourceIndex++];
		while (source && source.heading !== wake.heading)
			source = pair.wakes?.[sourceIndex++];
		if (!source) continue;
		const logicalWakeLine = wake.line;
		wake.sourcePath = source.sourcePath;
		wake.sourceLine = source.sourceLine;
		wake.logicalLine = logicalWakeLine;
		wake.line = source.sourceLine;
		wake.lineNumber = source.sourceLine;
		wake.headingLine = source.sourceLine;
		for (const row of wake.rows ?? []) {
			const logicalRowLine = row.line;
			row.sourcePath = source.sourcePath;
			row.sourceLine = source.sourceLine + (logicalRowLine - logicalWakeLine);
			row.logicalLine = logicalRowLine;
			row.line = row.sourceLine;
			row.lineNumber = row.sourceLine;
		}
	}
	report.items = report.items.map((item) => ({
		...item,
		sourcePath: pair.headPath,
		sourceLine: item.line,
	}));
	report.tables = (report.tables ?? []).map((table) => ({
		...table,
		rows: table.rows.map((item) => ({
			...item,
			sourcePath: pair.headPath,
			sourceLine: item.line,
		})),
	}));
	return report;
}

function migrateLocked(paths, options) {
	assertExpected(paths, options.expectedContentHash);
	const original = readFileSync(paths.headPath, "utf8");
	if (
		!existsSync(paths.historyPath) &&
		/^<!-- heartbeat-head:v\d+\b/.test(original)
	)
		throw new Error(
			"Canonical heartbeat head references a missing history companion",
		);
	if (existsSync(paths.historyPath)) {
		const history = readFileSync(paths.historyPath, "utf8");
		if (HISTORY.test(history)) return readPair(paths);
		const old = OLD_HISTORY.exec(history);
		if (!old || old[2] || decodeURIComponent(old[1]) !== paths.headPath)
			throw new Error(
				"Refusing unrelated or incomplete heartbeat history companion",
			);
		if (!existsSync(paths.legacyBackupPath))
			throw new Error(
				"Heartbeat migration incomplete: immutable backup missing",
			);
		const backup = readFileSync(paths.legacyBackupPath, "utf8");
		if (backup !== original || history.slice(old[0].length) !== original)
			throw new Error(
				"Heartbeat migration incomplete: original and verified backup differ",
			);
	} else if (existsSync(paths.legacyBackupPath)) {
		if (readFileSync(paths.legacyBackupPath, "utf8") !== original)
			throw new Error(
				"Immutable legacy backup already exists with different content",
			);
	} else if (
		!atomicCreateFileSync(paths.legacyBackupPath, original, { mode: 0o600 })
	)
		throw new Error("Heartbeat backup was concurrently created");
	if (readFileSync(paths.legacyBackupPath, "utf8") !== original)
		throw new Error("Heartbeat backup verification failed");
	assertExpected(paths, options.expectedContentHash);
	const head = canonicalHead(original, paths),
		history = historyText(original, head, original, paths, original);
	atomicWrite(paths.historyPath, history);
	options.beforeHeadPublish?.();
	if (readFileSync(paths.headPath, "utf8") !== original)
		throw new Error(
			"Heartbeat version conflict before head publication; backup and history retained",
		);
	atomicWrite(paths.headPath, head);
	return readPair(paths);
}
/** Caller asserts exclusive control over legacy writers for the entire transaction. */
export function migrateHeartbeatLedgerPair(options) {
	requireOwnership(options);
	const paths = safePaths(options.root, options.path);
	return withWriterLock(paths, () => migrateLocked(paths, options));
}
function writeLocked(paths, options, kind) {
	assertExpected(paths, options.expectedContentHash);
	const prior = readPair(paths);
	if (prior.isLegacy)
		throw new Error(
			"Explicitly migrate the quiescent legacy ledger before writing",
		);
	const marker = HISTORY.exec(prior.historyText),
		body = prior.historyText.slice(marker[0].length);
	const input = kind === "append" ? options.wakeText : options.text;
	if (typeof input !== "string")
		throw new TypeError("Heartbeat writer requires text");
	const wake = splitWakeSections(input).at(-1);
	if (!wake)
		throw new Error("Heartbeat writer requires at least one wake section");
	// Incorporate any manual suffix by its validated byte boundary before writing the new wake.
	const bytes = Number(marker[4]);
	const suffix = Buffer.from(prior.headText).subarray(bytes).toString("utf8");
	const historyBody = `${body}${body.endsWith("\n") || !suffix ? "" : "\n"}${suffix}${(suffix || body).endsWith("\n") ? "" : "\n"}${wake}${wake.endsWith("\n") ? "" : "\n"}`;
	const head = canonicalHead(
		kind === "append"
			? appendHead(prior.headText.replace(HEAD, ""), wake)
			: input,
		paths,
	);
	const backup = readFileSync(paths.legacyBackupPath, "utf8");
	assertExpected(paths, options.expectedContentHash);
	atomicWrite(
		paths.historyPath,
		historyText(historyBody, head, backup, paths, prior.headText),
	);
	options.beforeHeadPublish?.();
	if (readFileSync(paths.headPath, "utf8") !== prior.headText)
		throw new Error(
			"Heartbeat version conflict before head publication; committed history retained for recovery",
		);
	atomicWrite(paths.headPath, head);
	return readPair(paths);
}
export function writeHeartbeatLedgerPair(options) {
	requireOwnership(options);
	const paths = safePaths(options.root, options.path);
	return withWriterLock(paths, () => writeLocked(paths, options, "write"));
}
export function appendHeartbeatWake(options) {
	requireOwnership(options);
	const paths = safePaths(options.root, options.path);
	return withWriterLock(paths, () => writeLocked(paths, options, "append"));
}

/** Read raw version without interpreting the pair, including interrupted transactions. */
export function readHeartbeatLedgerPairVersion({ root, path }) {
	const paths = safePaths(root, path);
	const head = readFileSync(paths.headPath, "utf8");
	const history = existsSync(paths.historyPath)
		? readFileSync(paths.historyPath, "utf8")
		: "";
	return { contentHash: sha(`${head}\0${history}`) };
}
/** Finish a history-first transaction only if the current head is exactly its old or planned head. */
export function recoverHeartbeatLedgerPair(options) {
	requireOwnership(options);
	const paths = safePaths(options.root, options.path);
	return withWriterLock(paths, () => {
		assertExpected(paths, options.expectedContentHash);
		const { match, planned } = verifiedHistory(paths);
		const current = readFileSync(paths.headPath, "utf8");
		if (current !== planned && sha(current) !== match[6])
			throw new Error(
				"Heartbeat recovery conflict: current head differs from the previous and planned heads",
			);
		assertExpected(paths, options.expectedContentHash);
		if (current !== planned) atomicWrite(paths.headPath, planned);
		return readPair(paths);
	});
}
