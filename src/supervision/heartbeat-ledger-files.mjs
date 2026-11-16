import { validateHeartbeatOrchestration } from "./heartbeat-orchestration.mjs";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
	fsyncSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseWakes, WAKE_HEADING_RE } from "./check-heartbeat-ledger.mjs";
import {
	inspectHeartbeatLedger,
	summarizeHeartbeatLedger,
} from "./heartbeat-ledger-api.mjs";
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
			// Wake table rows and metadata belong to the archived record. Preserve
			// independent prose and comments even when they occur between headings.
			if (
				/^\s*(?:\||sources\s*:|orchestration\s*:|[-]{3,}\s*$)/i.test(lines[i])
			)
				remove.add(i);
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
// Open both files before reading so a combined limit is enforced without
// materializing either oversized file. The read loop also catches growth after fstat.
function boundedPairInputs(paths, maxBytes) {
	const flags =
		constants.O_RDONLY |
		(constants.O_NOFOLLOW ?? 0) |
		(constants.O_NONBLOCK ?? 0);
	const descriptors = [];
	const openRegular = (path, optional = false) => {
		let fd;
		try {
			fd = openSync(path, flags);
		} catch (error) {
			if (optional && error?.code === "ENOENT") return null;
			throw error;
		}
		descriptors.push(fd);
		const info = fstatSync(fd);
		if (!info.isFile())
			throw new Error("Heartbeat source must be a regular file");
		return { fd, info };
	};
	const readBounded = (file, limit) => {
		if (file.info.size > limit)
			throw new Error(`Heartbeat pair exceeds the ${maxBytes} byte read limit`);
		const chunks = [];
		let total = 0;
		for (;;) {
			const size = Math.min(65536, limit - total + 1);
			const chunk = Buffer.allocUnsafe(size);
			const count = readSync(file.fd, chunk, 0, size, null);
			if (!count) break;
			total += count;
			if (total > limit)
				throw new Error(
					`Heartbeat pair exceeds the ${maxBytes} byte read limit`,
				);
			chunks.push(chunk.subarray(0, count));
		}
		return {
			text: Buffer.concat(chunks, total).toString("utf8"),
			bytes: total,
		};
	};
	try {
		const head = openRegular(paths.headPath);
		const history = openRegular(paths.historyPath, true);
		if (head.info.size + (history?.info.size ?? 0) > maxBytes)
			throw new Error(`Heartbeat pair exceeds the ${maxBytes} byte read limit`);
		const headData = readBounded(head, maxBytes);
		const historyData = history
			? readBounded(history, maxBytes - headData.bytes)
			: null;
		let backupText;
		if (history) {
			const backup = openRegular(paths.legacyBackupPath, true);
			if (!backup)
				throw new Error(
					"Heartbeat pair is incomplete: immutable backup missing",
				);
			backupText = readBounded(backup, maxBytes).text;
		}
		return {
			headText: headData.text,
			historyText: historyData?.text,
			backupText,
			modifiedAt: new Date(
				Math.max(head.info.mtimeMs, history?.info.mtimeMs ?? 0),
			).toISOString(),
		};
	} finally {
		for (const fd of descriptors) closeSync(fd);
	}
}
function verifiedHistory(paths, bounded) {
	if (!existsSync(paths.historyPath))
		throw new Error("Heartbeat history companion missing");
	const history =
			bounded?.historyText ?? readFileSync(paths.historyPath, "utf8"),
		match = HISTORY.exec(history);
	if (!match || decodeURIComponent(match[1]) !== paths.headPath)
		throw new Error(
			"Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	if (!existsSync(paths.legacyBackupPath))
		throw new Error("Heartbeat pair is incomplete: immutable backup missing");
	const backup =
			bounded?.backupText ?? readFileSync(paths.legacyBackupPath, "utf8"),
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

function readPair(paths, maxBytes) {
	const bounded =
		maxBytes === undefined ? undefined : boundedPairInputs(paths, maxBytes);
	const headText = bounded?.headText ?? readFileSync(paths.headPath, "utf8");
	const headMatch = HEAD.exec(headText);
	if (
		bounded ? bounded.historyText === undefined : !existsSync(paths.historyPath)
	) {
		if (headMatch || /^<!-- heartbeat-head:v\d+\b/.test(headText))
			throw new Error(
				"Canonical heartbeat head references a missing history companion",
			);
		return {
			headText,
			historyText: "",
			fullText: headText,
			contentHash: sha(`${headText}\0`),
			modifiedAt:
				bounded?.modifiedAt ??
				new Date(statSync(paths.headPath).mtimeMs).toISOString(),
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
	const { history, match, body } = verifiedHistory(paths, bounded);
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
		modifiedAt:
			bounded?.modifiedAt ??
			new Date(
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
export function readHeartbeatLedgerPair({ root, path, maxBytes }) {
	if (
		maxBytes !== undefined &&
		(!Number.isSafeInteger(maxBytes) || maxBytes < 1)
	)
		throw new TypeError("maxBytes must be a positive safe integer");
	return readPair(safePaths(root, path), maxBytes);
}

// Audit one coherent view: the live head supplies the inventory and all non-wake
// content; historical wakes remain in their original order for cross-wake guards.
function auditText(pair) {
	if (pair.isLegacy)
		return {
			text: pair.fullText,
			lineSources: pair.fullText
				.split("\n")
				.map((_, i) => ({ sourcePath: pair.headPath, sourceLine: i + 1 })),
		};
	const headLines = pair.headText.split("\n");
	const lineSources = headLines.map((_, i) => ({
		sourcePath: pair.headPath,
		sourceLine: i + 1,
	}));
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
	const wakes = parseWakes(pair.fullText).map((w, index) => {
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
		const source = pair.wakes?.[index];
		return {
			text: [w.heading, ...lines].join("\n"),
			lines: [w.heading, ...lines].map((_, offset) =>
				source
					? {
							sourcePath: source.sourcePath,
							sourceLine: source.sourceLine + offset,
						}
					: null,
			),
		};
	});
	for (let i = 0; i < wakes.length; i++) {
		if (i) lineSources.push(null);
		lineSources.push(...wakes[i].lines);
	}
	return {
		text: `${headLines.join("\n")}\n${wakes.map((w) => w.text).join("\n\n")}`,
		lineSources,
	};
}

/** Metadata for ranking: identical audit text and head inventory, without audit findings. */
export function summarizeHeartbeatLedgerPair(pair) {
	if (
		!pair ||
		typeof pair.headText !== "string" ||
		typeof pair.fullText !== "string"
	)
		throw new TypeError("A heartbeat ledger pair is required");
	const { wakes } = summarizeHeartbeatLedger(
		pair.isLegacy ? pair.fullText : auditText(pair).text,
		{ includeItems: false },
	);
	const { itemCount } = summarizeHeartbeatLedger(pair.headText, {
		includeWakes: false,
	});
	return { wakes, itemCount };
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
	const input =
		mode === "items"
			? {
					text: pair.headText,
					lineSources: pair.headText
						.split("\n")
						.map((_, i) => ({ sourcePath: pair.headPath, sourceLine: i + 1 })),
				}
			: auditText(pair);
	const report = inspect(input.text, { mode, latest, now, ...options });
	if (!pair.isLegacy)
		report.findings = report.findings.map((finding) => {
			const locations = [];
			const sourceReferences = [];
			const referencePattern =
				/\blines? \d+(?:(?:,\s*|\s+and\s+|\s*(?:-|–|to)\s*)\d+)*/gi;
			const message = finding.message.replace(referencePattern, (reference) =>
				reference.replace(/\d+/g, (number) => {
					const source = input.lineSources[Number(number) - 1];
					sourceReferences.push(source ?? null);
					if (!source) return number;
					locations.push({ ...source, logicalLine: Number(number) });
					return String(source.sourceLine);
				}),
			);
			if (!locations.length) return finding;
			const paths = new Set(locations.map((location) => location.sourcePath));
			let index = 0;
			const contextual =
				paths.size > 1
					? message.replace(referencePattern, (reference) =>
							reference.replace(/\d+/g, (number) => {
								const loc = sourceReferences[index++];
								return loc ? `${number} [${loc.sourcePath}]` : number;
							}),
						)
					: message;
			return {
				...finding,
				message: contextual,
				sourcePath: locations[0].sourcePath,
				sourceLine: locations[0].sourceLine,
				sourceLocations: locations,
			};
		});
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
	let input = kind === "append" ? options.wakeText : options.text;
	if (typeof input !== "string")
		throw new TypeError("Heartbeat writer requires text");
	let wake = splitWakeSections(input).at(-1);
	if (wake && options.orchestration !== undefined) {
		if (wake.split("\n").some((line) => /^\s*orchestration\s*:/i.test(line)))
			throw new Error("Duplicate orchestration metadata");
		const metadata = `orchestration: ${JSON.stringify(validateHeartbeatOrchestration(options.orchestration))}`;
		const newline = wake.indexOf("\n");
		const updated =
			newline < 0
				? `${wake}\n${metadata}\n`
				: `${wake.slice(0, newline + 1)}${metadata}\n${wake.slice(newline + 1)}`;
		const index = input.lastIndexOf(wake);
		input = input.slice(0, index) + updated + input.slice(index + wake.length);
		wake = updated;
	}
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

// Display reads authenticate the whole pair but retain only bounded wake offsets.
// They intentionally do not perform (or certify) a full cross-history audit.
const displayCache = new Map();
const DISPLAY_HEAD_LIMIT = 32 * 1024 * 1024;
const DISPLAY_HEADER_LIMIT = 48 * 1024 * 1024;
const DISPLAY_LINE_LIMIT = 1024 * 1024;
const DISPLAY_RECORD_LIMIT = 4 * 1024 * 1024;
const DISPLAY_PAGE_LIMIT = 8 * 1024 * 1024;
const DISPLAY_INDEX_LIMIT = 250000;

function displayError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}
function displayFingerprint(info) {
	return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs]
		.map(String)
		.join(":");
}
async function displayOpen(path, optional = false, onRead) {
	const { open } = await import("node:fs/promises");
	let file;
	try {
		file = await open(
			path,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
	} catch (error) {
		if (optional && error?.code === "ENOENT") return null;
		throw error;
	}
	const info = await file.stat({ bigint: true });
	if (!info.isFile()) {
		await file.close();
		throw new Error("Heartbeat source must be a regular file");
	}
	return { file, path, info, fingerprint: displayFingerprint(info), onRead };
}
async function displayUnchanged(entry) {
	if (!entry) return;
	const { lstat } = await import("node:fs/promises");
	try {
		const [fd, path] = await Promise.all([
			entry.file.stat({ bigint: true }),
			lstat(entry.path, { bigint: true }),
		]);
		if (
			!path.isFile() ||
			displayFingerprint(fd) !== entry.fingerprint ||
			displayFingerprint(path) !== entry.fingerprint
		)
			throw new Error("changed");
	} catch {
		throw displayError(
			"Heartbeat source changed during display read",
			"HEARTBEAT_DISPLAY_CHANGED",
		);
	}
}
async function displayRead(entry, buffer, offset, length, position) {
	const result = await entry.file.read(buffer, offset, length, position);
	entry.onRead?.({ path: entry.path, bytes: result.bytesRead, position });
	return result;
}
async function displayReadFile(entry, limit) {
	if (entry.info.size > BigInt(limit))
		throw new Error(`Heartbeat display head exceeds ${limit} byte limit`);
	const chunks = [];
	let length = 0;
	const buffer = Buffer.allocUnsafe(65536);
	for (;;) {
		const { bytesRead } = await displayRead(
			entry,
			buffer,
			0,
			buffer.length,
			length,
		);
		if (!bytesRead) break;
		length += bytesRead;
		if (length > limit)
			throw new Error(`Heartbeat display head exceeds ${limit} byte limit`);
		chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
	}
	const result = Buffer.concat(chunks, length);
	new TextDecoder("utf-8", { fatal: true }).decode(result);
	return result;
}
function displayIndexer(path, firstLine = 1) {
	const records = [],
		active = [];
	let line = firstLine;
	return {
		line(text, start, end) {
			const heading = /^(#{1,6})\s/.exec(text);
			if (heading || /^-{3,}\s*$/.test(text)) {
				for (let i = active.length - 1; i >= 0; i--) {
					if (!heading || heading[1].length <= active[i].level) {
						active[i].end = start;
						active.splice(i, 1);
					}
				}
			}
			if (WAKE.test(text)) {
				if (records.length >= DISPLAY_INDEX_LIMIT)
					throw new Error("Heartbeat display wake index exceeds limit");
				const record = {
					path,
					start,
					end: null,
					line,
					timeMs: parseWakes(text)[0]?.timeMs ?? null,
					level: /^#+/.exec(text)[0].length,
				};
				records.push(record);
				active.push(record);
			}
			line++;
		},
		finish(end) {
			for (const record of active) record.end = end;
			return records;
		},
	};
}
function indexDisplayBuffer(buffer, path, start = 0, firstLine = 1) {
	const indexer = displayIndexer(path, firstLine);
	let from = start;
	while (from < buffer.length) {
		const found = buffer.indexOf(10, from),
			end = found < 0 ? buffer.length : found + 1;
		if (end - from > DISPLAY_LINE_LIMIT)
			throw new Error("Heartbeat display line exceeds limit");
		indexer.line(
			buffer.subarray(from, found < 0 ? end : found).toString("utf8"),
			from,
			end,
		);
		from = end;
	}
	return indexer.finish(buffer.length);
}
async function displayHashFile(entry) {
	const hash = createHash("sha256"),
		buffer = Buffer.allocUnsafe(65536);
	let offset = 0;
	for (;;) {
		const { bytesRead } = await displayRead(
			entry,
			buffer,
			0,
			buffer.length,
			offset,
		);
		if (!bytesRead) break;
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}
async function displayScanHistory(entry, paths, headBuffer) {
	const pairHash = createHash("sha256").update(headBuffer).update("\0");
	const bodyHash = createHash("sha256"),
		decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = Buffer.allocUnsafe(65536);
	let offset = 0,
		pending = Buffer.alloc(0),
		header = null,
		bodyOffset = 0,
		bodyLine = 2;
	const headerChunks = [];
	let headerBytes = 0;
	const indexer = displayIndexer(paths.historyPath, bodyLine);
	for (;;) {
		const { bytesRead } = await displayRead(
			entry,
			buffer,
			0,
			buffer.length,
			offset,
		);
		if (!bytesRead) break;
		const chunk = Buffer.from(buffer.subarray(0, bytesRead));
		offset += bytesRead;
		pairHash.update(chunk);
		decoder.decode(chunk, { stream: true });
		if (header === null) {
			const newline = chunk.indexOf(10);
			const headerPart = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
			if (headerBytes + headerPart.length > DISPLAY_HEADER_LIMIT)
				throw new Error("Heartbeat history header exceeds display limit");
			headerBytes += headerPart.length;
			headerChunks.push(headerPart);
			if (newline < 0) continue;
			header = Buffer.concat(headerChunks, headerBytes).toString("utf8");
			bodyOffset = headerBytes;
			pending = chunk.subarray(newline + 1);
		} else {
			const newline = chunk.indexOf(10);
			const firstLineBytes = newline < 0 ? chunk.length : newline + 1;
			if (pending.length + firstLineBytes > DISPLAY_LINE_LIMIT)
				throw new Error("Heartbeat display line exceeds limit");
			pending = Buffer.concat([pending, chunk]);
		}
		// Hash only bytes which have not previously been retained as an incomplete line.
		let consumed = 0;
		for (;;) {
			const newline = pending.indexOf(10, consumed);
			if (newline < 0) break;
			if (newline + 1 - consumed > DISPLAY_LINE_LIMIT)
				throw new Error("Heartbeat display line exceeds limit");
			const bytes = pending.subarray(consumed, newline + 1);
			bodyHash.update(bytes);
			indexer.line(
				bytes.subarray(0, -1).toString("utf8"),
				bodyOffset,
				bodyOffset + bytes.length,
			);
			bodyOffset += bytes.length;
			consumed = newline + 1;
		}
		pending = pending.subarray(consumed);
		if (pending.length > DISPLAY_LINE_LIMIT)
			throw new Error("Heartbeat display line exceeds limit");
	}
	decoder.decode();
	if (!header)
		throw new Error(
			"Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	if (pending.length) {
		bodyHash.update(pending);
		indexer.line(
			pending.toString("utf8"),
			bodyOffset,
			bodyOffset + pending.length,
		);
		bodyOffset += pending.length;
	}
	return {
		header,
		bodyHash: bodyHash.digest("hex"),
		contentHash: pairHash.digest("hex"),
		records: indexer.finish(bodyOffset),
	};
}
function displayCursor(contentHash, offset) {
	return Buffer.from(JSON.stringify({ v: 1, contentHash, offset })).toString(
		"base64url",
	);
}
function readDisplayCursor(cursor, contentHash, total) {
	if (cursor === undefined) return 0;
	if (
		typeof cursor !== "string" ||
		cursor.length > 512 ||
		!/^[A-Za-z0-9_-]+$/.test(cursor)
	)
		throw displayError(
			"Invalid heartbeat display cursor",
			"HEARTBEAT_DISPLAY_CURSOR_STALE",
		);
	try {
		const decoded = Buffer.from(cursor, "base64url");
		if (decoded.toString("base64url") !== cursor) throw new Error();
		const value = JSON.parse(decoded.toString("utf8"));
		if (
			value.v !== 1 ||
			value.contentHash !== contentHash ||
			!Number.isSafeInteger(value.offset) ||
			value.offset < 0 ||
			value.offset > total
		)
			throw new Error();
		return value.offset;
	} catch {
		throw displayError(
			"Heartbeat display cursor is stale or invalid",
			"HEARTBEAT_DISPLAY_CURSOR_STALE",
		);
	}
}
async function displayWake(entry, record) {
	const length = record.end - record.start;
	if (length > DISPLAY_RECORD_LIMIT)
		throw new Error("Heartbeat display wake exceeds record limit");
	const data = Buffer.alloc(length);
	let n = 0;
	while (n < length) {
		const { bytesRead } = await displayRead(
			entry,
			data,
			n,
			length - n,
			record.start + n,
		);
		if (!bytesRead)
			throw displayError(
				"Heartbeat source changed during display read",
				"HEARTBEAT_DISPLAY_CHANGED",
			);
		n += bytesRead;
	}
	const wake = inspectHeartbeatLedger(data.toString("utf8"), {
		mode: "history",
		latest: false,
	}).wakes[0];
	if (!wake)
		throw displayError(
			"Heartbeat source changed during display read",
			"HEARTBEAT_DISPLAY_CHANGED",
		);
	const logical = wake.line;
	Object.assign(wake, {
		sourcePath: record.path,
		sourceLine: record.line,
		logicalLine: logical,
		line: record.line,
		lineNumber: record.line,
		headingLine: record.line,
	});
	for (const row of wake.rows) {
		const line = record.line + row.line - logical;
		Object.assign(row, {
			sourcePath: record.path,
			sourceLine: line,
			logicalLine: row.line,
			line,
			lineNumber: line,
		});
	}
	return wake;
}
/** Clear reconstructible display indexes; no source files are modified. */
export function clearHeartbeatDisplayCache() {
	displayCache.clear();
}

/** Authenticated, bounded display projection; never a full business audit. */
export async function readHeartbeatDisplay({
	root,
	path,
	cursor,
	pageSize = 20,
	now = new Date(),
	onRead,
	inspect = inspectHeartbeatLedger,
}) {
	if (typeof inspect !== "function")
		throw new TypeError("inspect must be a function");
	if (onRead !== undefined && typeof onRead !== "function")
		throw new TypeError("onRead must be a function");
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 25)
		throw new TypeError("pageSize must be an integer from 1 to 25");
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		throw new TypeError("now must be a valid Date");
	const paths = safePaths(root, path);
	let head,
		history,
		backup,
		historyChecked = false,
		backupChecked = false;
	try {
		head = await displayOpen(paths.headPath, false, onRead);
		history = await displayOpen(paths.historyPath, true, onRead);
		historyChecked = true;
		backup = await displayOpen(paths.legacyBackupPath, true, onRead);
		backupChecked = true;
		const cacheKey = paths.headPath,
			fingerprints = [head, history, backup]
				.map((x) => x?.fingerprint ?? "-")
				.join("|");
		let snapshot = displayCache.get(cacheKey);
		if (!snapshot || snapshot.fingerprints !== fingerprints) {
			const headBuffer = await displayReadFile(head, DISPLAY_HEAD_LIMIT),
				headText = headBuffer.toString("utf8"),
				headMatch = HEAD.exec(headText);
			let records, contentHash, isLegacy;
			if (!history) {
				if (headMatch || /^<!-- heartbeat-head:v\d+\b/.test(headText))
					throw new Error(
						"Canonical heartbeat head references a missing history companion",
					);
				isLegacy = true;
				contentHash = createHash("sha256")
					.update(headBuffer)
					.update("\0")
					.digest("hex");
				records = indexDisplayBuffer(headBuffer, paths.headPath);
			} else {
				if (!backup)
					throw new Error(
						"Heartbeat pair is incomplete: immutable backup missing",
					);
				const scanned = await displayScanHistory(history, paths, headBuffer),
					match = HISTORY.exec(scanned.header);
				if (
					!match ||
					match[0] !== scanned.header ||
					decodeURIComponent(match[1]) !== paths.headPath
				)
					throw new Error(
						"Heartbeat history companion has an invalid, unrelated or incomplete format",
					);
				const plannedBuffer = Buffer.from(match[7], "base64"),
					planned = plannedBuffer.toString("utf8"),
					plannedRef = HEAD.exec(planned),
					bytes = Number(match[4]);
				if (
					!headMatch ||
					decodeURIComponent(headMatch[1]) !== paths.headPath ||
					decodeURIComponent(headMatch[2]) !== paths.historyPath
				)
					throw new Error(
						"Heartbeat pair is incomplete: head reference missing or unrelated",
					);
				if (
					scanned.bodyHash !== match[2] ||
					(await displayHashFile(backup)) !== match[5] ||
					plannedBuffer.toString("base64") !== match[7] ||
					!Buffer.from(planned, "utf8").equals(plannedBuffer) ||
					sha(plannedBuffer) !== match[3] ||
					plannedBuffer.length !== bytes ||
					!plannedRef ||
					decodeURIComponent(plannedRef[1]) !== paths.headPath ||
					decodeURIComponent(plannedRef[2]) !== paths.historyPath
				)
					throw new Error(
						"Heartbeat pair integrity check failed for history, backup or planned head",
					);
				if (
					!Number.isSafeInteger(bytes) ||
					bytes < Buffer.byteLength(headMatch[0]) ||
					bytes > headBuffer.length ||
					sha(headBuffer.subarray(0, bytes)) !== match[3]
				)
					throw new Error(
						"Heartbeat pair is incomplete or current head was modified; recovery required",
					);
				const prefixLines =
					headBuffer.subarray(0, bytes).toString("utf8").split("\n").length - 1;
				records = [
					...scanned.records,
					...indexDisplayBuffer(
						headBuffer,
						paths.headPath,
						bytes,
						prefixLines + 1,
					),
				];
				if (records.length > DISPLAY_INDEX_LIMIT)
					throw new Error("Heartbeat display wake index exceeds limit");
				contentHash = scanned.contentHash;
				isLegacy = false;
			}
			await Promise.all([
				displayUnchanged(head),
				displayUnchanged(history),
				displayUnchanged(backup),
			]);
			// Check companions did not appear after opening them.
			const rechecked = safePaths(root, path);
			if (
				(!history && existsSync(rechecked.historyPath)) ||
				(!backup && existsSync(rechecked.legacyBackupPath))
			)
				throw displayError(
					"Heartbeat source changed during display read",
					"HEARTBEAT_DISPLAY_CHANGED",
				);
			snapshot = {
				fingerprints,
				headText,
				headDigest: sha(headBuffer),
				records,
				contentHash,
				isLegacy,
				modifiedAt: new Date(
					Math.max(
						Number(head.info.mtimeMs),
						Number(history?.info.mtimeMs ?? 0),
					),
				).toISOString(),
			};
			displayCache.set(cacheKey, snapshot);
			if (displayCache.size > 4)
				displayCache.delete(displayCache.keys().next().value);
		}
		const cursorVersion = sha(`${snapshot.contentHash}\0${fingerprints}`);
		const offset = readDisplayCursor(
			cursor,
			cursorVersion,
			snapshot.records.length,
		);
		const selected = [];
		const last = snapshot.records.at(-1);
		const lastSize = last ? last.end - last.start : 0;
		if (lastSize > DISPLAY_RECORD_LIMIT)
			throw new Error("Heartbeat display wake exceeds record limit");
		// On later pages the latest wake is read separately. Reserve its bytes
		// so the complete display projection stays within the same IO budget.
		let size = offset > 0 ? lastSize : 0;
		for (
			let i = snapshot.records.length - 1 - offset;
			i >= 0 && selected.length < pageSize;
			i--
		) {
			const record = snapshot.records[i];
			const recordSize = record.end - record.start;
			if (recordSize > DISPLAY_RECORD_LIMIT) {
				if (selected.length) break;
				throw new Error("Heartbeat display wake exceeds record limit");
			}
			if (size + recordSize > DISPLAY_PAGE_LIMIT) break;
			selected.push(record);
			size += recordSize;
		}
		const entryFor = (record) =>
			record.path === paths.headPath ? head : history;
		const wakes = [];
		for (const record of selected)
			wakes.push(await displayWake(entryFor(record), record));
		const latestWake = !last
			? null
			: selected[0] === last
				? wakes[0]
				: await displayWake(entryFor(last), last);
		const inventory = inspectHeartbeatLedgerPair(
			{
				headText: snapshot.headText,
				fullText: snapshot.headText,
				headPath: paths.headPath,
				historyPath: paths.historyPath,
				isLegacy: true,
				wakes: [],
			},
			{ mode: "items", now, ledgerPath: paths.headPath, inspect },
		);
		await Promise.all([
			displayUnchanged(head),
			displayUnchanged(history),
			displayUnchanged(backup),
		]);
		const checkedPaths = safePaths(root, path);
		if (
			(!history && existsSync(checkedPaths.historyPath)) ||
			(!backup && existsSync(checkedPaths.legacyBackupPath))
		)
			throw displayError(
				"Heartbeat source changed during display read",
				"HEARTBEAT_DISPLAY_CHANGED",
			);
		let lastRecordedTime = null;
		for (const record of snapshot.records)
			if (
				Number.isFinite(record.timeMs) &&
				record.timeMs <= now.getTime() &&
				(lastRecordedTime === null || record.timeMs > lastRecordedTime)
			)
				lastRecordedTime = record.timeMs;
		return {
			headText: snapshot.headText,
			headDigest: snapshot.headDigest,
			contentHash: snapshot.contentHash,
			integrity: "verified",
			inventory,
			latestWake,
			historyPage: {
				wakes,
				nextCursor:
					offset + selected.length < snapshot.records.length
						? displayCursor(cursorVersion, offset + selected.length)
						: null,
				total: snapshot.records.length,
			},
			headPath: paths.headPath,
			historyPath: snapshot.isLegacy ? paths.headPath : paths.historyPath,
			isLegacy: snapshot.isLegacy,
			modifiedAt: snapshot.modifiedAt,
			lastRecordedAt:
				lastRecordedTime === null
					? null
					: new Date(lastRecordedTime).toISOString(),
			audit: "not-performed",
		};
	} catch (error) {
		// An integrity or format error observed during concurrent publication is
		// retryable; unchanged malformed input remains a permanent integrity error.
		await Promise.all([
			displayUnchanged(head),
			displayUnchanged(history),
			displayUnchanged(backup),
		]);
		if (
			(historyChecked && !history && existsSync(paths.historyPath)) ||
			(backupChecked && !backup && existsSync(paths.legacyBackupPath))
		)
			throw displayError(
				"Heartbeat source changed during display read",
				"HEARTBEAT_DISPLAY_CHANGED",
			);
		throw error;
	} finally {
		await Promise.all(
			[head, history, backup].filter(Boolean).map((x) => x.file.close()),
		);
	}
}
