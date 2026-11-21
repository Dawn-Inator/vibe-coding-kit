import { validateHeartbeatOrchestration } from "./heartbeat-orchestration.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	linkSync,
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
import {
	parseWakes,
	WAKE_HEADING_RE,
	matchHeartbeatLedgerRow,
	findStrayItemRows,
	parseItemTables,
} from "./check-heartbeat-ledger.mjs";
import {
	isConcreteCoordinationField,
	isTrackingItemState,
} from "./heartbeat-ledger-tracking.mjs";
import {
	heartbeatAuditDueForWake,
	isFullTenRowWake,
} from "./heartbeat-audit-due.mjs";
import {
	inspectHeartbeatLedger,
	summarizeHeartbeatLedger,
} from "./heartbeat-ledger-api.mjs";
import {
	resolveProjectLedgerPathSync,
	resolveProjectLedgerCreationPathSync,
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
function safePaths(root, path, { creating = false } = {}) {
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
	const resolveHead = creating
		? resolveProjectLedgerCreationPathSync
		: resolveProjectLedgerPathSync;
	const { path: canonicalHead } = resolveHead(
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
function publishNewHead(path, text) {
	const temporary = `${path}.tmp-create-${randomBytes(8).toString("hex")}`;
	try {
		atomicWriteFileSync(temporary, text, { mode: 0o600 });
		// Linking publishes the complete file exclusively, including on Windows.
		// Readers can never observe a partially written initial Markdown seed.
		linkSync(temporary, path);
		let directory;
		try {
			directory = openSync(dirname(path), "r");
			fsyncSync(directory);
		} catch (error) {
			if (!["EINVAL", "EPERM", "EISDIR"].includes(error?.code)) throw error;
		} finally {
			if (directory !== undefined) closeSync(directory);
		}
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
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
function requireOwnership(options, { creating = false } = {}) {
	if (options.legacyWritersQuiescent !== true)
		throw new Error(
			"Heartbeat writes require explicit exclusive ownership and quiescent legacy writers",
		);
	if (!creating && (
		typeof options.expectedContentHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(options.expectedContentHash)
	))
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
// File primitives for bounded reads; injectable so non-regular-file handling is testable on any host.
const FILE_IO = Object.freeze({ openSync, fstatSync, readSync, closeSync });
function boundedPairInputs(paths, maxBytes, io = FILE_IO) {
	const flags =
		constants.O_RDONLY |
		(constants.O_NOFOLLOW ?? 0) |
		(constants.O_NONBLOCK ?? 0);
	const descriptors = [];
	const openRegular = (path, optional = false) => {
		let fd;
		try {
			fd = io.openSync(path, flags);
		} catch (error) {
			if (optional && error?.code === "ENOENT") return null;
			throw error;
		}
		descriptors.push(fd);
		const info = io.fstatSync(fd);
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
			const count = io.readSync(file.fd, chunk, 0, size, null);
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
		for (const fd of descriptors) io.closeSync(fd);
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

function readPair(paths, maxBytes, io) {
	const bounded =
		maxBytes === undefined ? undefined : boundedPairInputs(paths, maxBytes, io);
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
export function readHeartbeatLedgerPair({ root, path, maxBytes, io }) {
	if (
		maxBytes !== undefined &&
		(!Number.isSafeInteger(maxBytes) || maxBytes < 1)
	)
		throw new TypeError("maxBytes must be a positive safe integer");
	return readPair(safePaths(root, path), maxBytes, io);
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
		mode === "items" || mode === "format"
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
	if (mode !== "items" && mode !== "format") {
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
function readWritablePair(paths, options) {
	assertExpected(paths, options.expectedContentHash);
	const prior = readPair(paths);
	if (prior.isLegacy)
		throw new Error(
			"Explicitly migrate the quiescent legacy ledger before writing",
		);
	return prior;
}
function publishPairHead(paths, options, prior, head, historyBody) {
	assertWritableHeartbeat(head);
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
function prepareWriteInput(options, kind) {
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
	return { input, wake };
}

function assertWritableHeartbeat(text) {
	const report = inspectHeartbeatLedger(text, { mode: "format" });
	if (report.passed) return;
	const error = new Error(
		`Refusing invalid heartbeat ledger before publication: ${report.findings.map(({ rule, message }) => `${rule}: ${message}`).join("; ")}`,
	);
	error.code = "HEARTBEAT_LEDGER_INVALID";
	error.findings = report.findings;
	throw error;
}

/** Generate a validated ledger without exposing an unchecked raw seed to readers. */
export function createHeartbeatLedgerPair(options) {
	requireOwnership(options, { creating: true });
	const paths = safePaths(options.root, options.path, { creating: true });
	const { input } = prepareWriteInput(options, "write");
	if (/<!-- heartbeat-(?:head|history):v\d+\b/.test(input))
		throw new Error("Heartbeat creation requires source Markdown, without storage markers");
	assertWritableHeartbeat(input);
	assertWritableHeartbeat(canonicalHead(input, paths));
	return withWriterLock(paths, () => {
		for (const path of [paths.headPath, paths.historyPath, paths.legacyBackupPath]) {
			try {
				lstatSync(path);
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
			throw new Error("Heartbeat creation requires absent head, history, and backup files");
		}
		// A crash before migration leaves valid source Markdown, never an unchecked
		// seed. Migration/recovery can preserve it using the existing version contract.
		publishNewHead(paths.headPath, input);
		return migrateLocked(paths, {
			...options,
			expectedContentHash: sha(`${input}\0`),
		});
	});
}

function writeLocked(paths, options, kind) {
	const prior = readWritablePair(paths, options);
	const marker = HISTORY.exec(prior.historyText),
		body = prior.historyText.slice(marker[0].length);
	const { input, wake } = prepareWriteInput(options, kind);
	// Reject malformed input even when canonicalization would omit an older wake.
	assertWritableHeartbeat(input);
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
	return publishPairHead(paths, options, prior, head, historyBody);
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

const isEmptyAssignmentCell = (value) =>
	value === "" || value === "-" || value === "—";
const isLiteralCell = (value) =>
	typeof value === "string" &&
	value === value.trim() &&
	!/[|\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
const isNativeThreadId = (value) =>
	isLiteralCell(value) &&
	isConcreteCoordinationField(value) &&
	/[\p{L}\p{N}]/u.test(value) &&
	!/[\s\\<>]/u.test(value);

function editAgentAssignments(head, assignments) {
	if (!Array.isArray(assignments) || !assignments.length)
		throw new TypeError("Heartbeat assignments must be a nonempty array");
	const lines = head.split("\n");
	const [table] = parseItemTables(head);
	if (
		!table?.rows.length ||
		lines.filter((line) => /^#{1,6}\s+Items\s*$/i.test(line)).length !== 1
	)
		throw new Error(
			"Heartbeat assignments require one unambiguous populated Items table",
		);
	const { headers, rows } = table;
	const dispatchColumn = headers.indexOf("dispatch_ref");
	const childrenColumn = headers.indexOf("children");
	const agentColumn = headers.indexOf("agent_thread_id");
	if (
		!headers.includes("id") ||
		!headers.includes("status") ||
		dispatchColumn < 0 ||
		headers.includes("") ||
		new Set(headers).size !== headers.length ||
		(childrenColumn >= 0 && childrenColumn !== dispatchColumn + 1)
	)
		throw new Error("Heartbeat assignments require valid, unique Items headers");

	const tableStart = rows[0].line - 3;
	const tableEnd = rows.at(-1).line;
	const rawTable = lines.slice(tableStart, tableEnd).map((line) => {
		// The shared parser accepts uneven Markdown rows. An edit needs exact cell
		// boundaries and retains every character outside the assignment cells.
		const cells = line.split("|");
		if (
			cells.length !== headers.length + 2 ||
			cells[0].trim() ||
			cells.at(-1).trim()
		)
			throw new Error("Malformed Heartbeat Items row or separator");
		return cells;
	});
	if (
		!rawTable[1].slice(1, -1).every((cell) => /^:?-{2,}:?$/.test(cell.trim())) ||
		lines[tableEnd]?.trimStart().startsWith("|")
	)
		throw new Error("Malformed Heartbeat Items row or separator");
	const items = new Map();
	for (const row of rows) {
		if (!row.id || !row.status || items.has(row.id))
			throw new Error("Malformed or duplicate Heartbeat Items row");
		items.set(row.id, row);
	}
	if (findStrayItemRows(head, rows).some(({ id }) => items.has(id)))
		throw new Error("Heartbeat Items include an ambiguous row outside the registry");

	const seen = new Set();
	const changes = new Map();
	for (const assignment of assignments) {
		const input = assignment ?? {};
		const { itemId, agentThreadId, expectedDispatchRef, expectedAgentThreadId } =
			input;
		if (
			!isLiteralCell(itemId) ||
			!itemId ||
			!isNativeThreadId(agentThreadId) ||
			!Object.hasOwn(input, "expectedDispatchRef") ||
			!isLiteralCell(expectedDispatchRef) ||
			(!isEmptyAssignmentCell(expectedDispatchRef) &&
				!isConcreteCoordinationField(expectedDispatchRef)) ||
			(expectedAgentThreadId !== undefined && !isNativeThreadId(expectedAgentThreadId))
		)
			throw new TypeError(
				"Heartbeat assignment requires an Item ID, native thread ID and exact expected dispatch_ref",
			);
		if (seen.has(itemId))
			throw new Error(`Duplicate Heartbeat assignment for Item ${itemId}`);
		seen.add(itemId);
		const row = items.get(itemId);
		if (!row) throw new Error(`Heartbeat assignment Item ${itemId} does not exist`);
		const children = row.children ?? "";
		if (
			isTrackingItemState(row.status) ||
			(!isEmptyAssignmentCell(children) && !/^\[\s*\]$/.test(children))
		)
			throw new Error(`Heartbeat assignment Item ${itemId} is not an unambiguous leaf`);
		if (row.dispatch_ref !== expectedDispatchRef)
			throw new Error(`Heartbeat assignment dispatch_ref conflict for Item ${itemId}`);
		const current = row.agent_thread_id ?? "";
		if (
			(expectedAgentThreadId !== undefined && current !== expectedAgentThreadId) ||
			(expectedAgentThreadId === undefined &&
				current !== agentThreadId &&
				!isEmptyAssignmentCell(current))
		)
			throw new Error(`Heartbeat assignment agent_thread_id conflict for Item ${itemId}`);
		if (current !== agentThreadId)
			changes.set(row.line - 1 - tableStart, agentThreadId);
	}
	if (!changes.size) return head;
	if (agentColumn < 0) {
		const insertAt = Math.max(dispatchColumn, childrenColumn) + 2;
		const columnCells = [" agent_thread_id ", " --- "];
		for (const [index, cells] of rawTable.entries()) {
			const agent = changes.get(index);
			cells.splice(
				insertAt,
				0,
				columnCells[index] ?? (agent ? ` ${agent} ` : "  "),
			);
			lines[tableStart + index] = cells.join("|");
		}
	} else {
		for (const [index, agent] of changes) {
			const cells = rawTable[index];
			const old = cells[agentColumn + 1];
			cells[agentColumn + 1] = old.trim()
				? old.replace(old.trim(), () => agent)
				: ` ${agent} `;
			lines[tableStart + index] = cells.join("|");
		}
	}
	return lines.join("\n");
}

/** Record only explicit native assignments verified by the authorized source writer. */
export function recordHeartbeatAgentAssignments(options) {
	requireOwnership(options);
	const paths = safePaths(options.root, options.path);
	return withWriterLock(paths, () => {
		const prior = readWritablePair(paths, options);
		const marker = HISTORY.exec(prior.historyText);
		// Folding an unarchived suffix into the authenticated head would remove its
		// wakes from reads. Assignment edits keep the entire history body intact.
		if (Buffer.byteLength(prior.headText) !== Number(marker[4]))
			throw new Error(
				"Heartbeat assignments require a canonical head without an unarchived suffix",
			);
		const head = editAgentAssignments(prior.headText, options.assignments);
		if (head === prior.headText) return prior;
		return publishPairHead(
			paths,
			options,
			prior,
			head,
			prior.historyText.slice(marker[0].length),
		);
	});
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
// Keep only at most eleven row numbers per open wake. This follows the same
// section and row-token rules as parseWakes without retaining historical text.
function displayCadenceTracker() {
	const active = [];
	let ordinal = 0,
		last = null;
	const close = (entry) => {
		if (isFullTenRowWake(entry) && (!last || entry.ordinal > last.ordinal))
			last = entry;
	};
	return {
		line(text, path, line) {
			const heading = /^(#{1,6})\s/.exec(text);
			if (heading || /^-{3,}\s*$/.test(text)) {
				for (let i = active.length - 1; i >= 0; i--) {
					if (!heading || heading[1].length <= active[i].level) {
						close(active[i]);
						active.splice(i, 1);
					}
				}
			}
			const match = WAKE.exec(text);
			if (match)
				active.push({
					heading: text.trim(),
					line,
					sourcePath: path,
					level: heading[1].length,
					ordinal: ordinal++,
					layout: { count: Number(match[1]) },
					rows: [],
				});
			const row = matchHeartbeatLedgerRow(text);
			if (row)
				for (const entry of active)
					if (entry.layout.count === 10 && entry.rows.length < 11)
						entry.rows.push({ num: Number(row[1]) });
		},
		finish() {
			for (const entry of active) close(entry);
			return last;
		},
	};
}
// The source remains authoritative. Only the display projection may summarize
// write_set cells in a recognized Items table; all control cells remain bounded.
async function scanDisplayHead(
	entry,
	{ onChunk, onLine, startPosition = 0, firstLine = 1 },
) {
	const chunk = Buffer.allocUnsafe(65536),
		decoder = new TextDecoder("utf-8", { fatal: true });
	const metadataLimit = 65536;
	let offset = startPosition,
		lineStart = startPosition,
		lineNumber = firstLine,
		stage = null,
		headers = [];
	let parts = [],
		partBytes = 0,
		column = -1,
		eligible = false,
		cellParts = [],
		cellBytes = 0,
		rawBytes = 0,
		lastNonspace = -1,
		omitted = [];
	function keep(part) {
		if (!part.length) return;
		partBytes += part.length;
		if (partBytes > DISPLAY_LINE_LIMIT)
			throw new Error("Heartbeat display line exceeds limit");
		parts.push(Buffer.from(part));
	}
	function isMetadata() {
		return stage === "rows" && eligible && headers[column] === "write_set";
	}
	function consume(part) {
		if (!part.length) return;
		rawBytes += part.length;
		for (let i = part.length - 1; i >= 0; i--)
			if (![9, 13, 32].includes(part[i])) {
				lastNonspace = part[i];
				break;
			}
		let from = 0;
		for (;;) {
			const pipe = part.indexOf(124, from),
				end = pipe < 0 ? part.length : pipe;
			const segment = part.subarray(from, end);
			if (isMetadata()) {
				cellBytes += segment.length;
				if (cellBytes <= metadataLimit) cellParts.push(Buffer.from(segment));
				else cellParts = [];
			} else keep(segment);
			if (pipe < 0) break;
			if (column === -1 && stage === "rows")
				eligible = /^\s*$/.test(
					Buffer.concat(parts, partBytes).toString("utf8"),
				);
			if (isMetadata()) {
				if (cellBytes > metadataLimit) {
					keep(Buffer.from("[omitted write_set metadata]"));
					omitted.push({
						line: lineNumber,
						column: "write_set",
						bytes: cellBytes,
					});
				} else for (const saved of cellParts) keep(saved);
				cellParts = [];
				cellBytes = 0;
			}
			keep(part.subarray(pipe, pipe + 1));
			column++;
			from = pipe + 1;
		}
	}
	function finish(newline) {
		if (isMetadata()) {
			// Without a terminating pipe the row is not an Items row under the canonical parser.
			if (cellBytes > metadataLimit)
				throw new Error("Heartbeat display line exceeds limit");
			for (const saved of cellParts) keep(saved);
		}
		if (omitted.length && lastNonspace !== 124)
			throw new Error("Heartbeat display line exceeds limit");
		const text = Buffer.concat(parts, partBytes).toString("utf8"),
			trimmed = text.trim();
		if (/^#{1,6}\s+Items\s*$/i.test(text)) {
			stage = "header";
			headers = [];
		} else if (stage === "header") {
			if (!trimmed) {
				/* canonical parser skips blank lines before the header */
			} else if (/^\|.*\|\s*$/.test(trimmed)) {
				headers = trimmed
					.slice(1, -1)
					.split("|")
					.map((c) => c.trim().toLowerCase().replace(/[ -]+/g, "_"));
				stage = "separator";
			} else stage = null;
		} else if (stage === "separator")
			stage = /^\|\s*:?-{2,}/.test(trimmed) ? "rows" : null;
		else if (stage === "rows" && !/^\|.*\|\s*$/.test(trimmed)) stage = null;
		const end = lineStart + rawBytes + (newline ? 1 : 0);
		onLine(text, lineStart, end, newline, omitted);
		lineStart = end;
		lineNumber++;
		parts = [];
		partBytes = 0;
		column = -1;
		eligible = false;
		cellParts = [];
		cellBytes = 0;
		rawBytes = 0;
		lastNonspace = -1;
		omitted = [];
	}
	for (;;) {
		const { bytesRead } = await displayRead(
			entry,
			chunk,
			0,
			chunk.length,
			offset,
		);
		if (!bytesRead) break;
		const piece = chunk.subarray(0, bytesRead);
		offset += bytesRead;
		decoder.decode(piece, { stream: true });
		onChunk?.(piece);
		let from = 0;
		for (;;) {
			const newline = piece.indexOf(10, from);
			if (newline < 0) {
				consume(piece.subarray(from));
				break;
			}
			consume(piece.subarray(from, newline));
			finish(true);
			from = newline + 1;
		}
	}
	decoder.decode();
	if (rawBytes) finish(false);
	return offset;
}

// Retain all canonical Items inputs, task and association metadata, and line
// positions; ordinary history prose is replaced by blank lines.
async function displayProjectLargeHead(entry) {
	const pairHash = createHash("sha256"),
		headHash = createHash("sha256"),
		retained = [],
		omittedMetadataFields = [];
	let retainedBytes = 0,
		table = false,
		headerSeen = false,
		blankLines = 0,
		retainedLines = 0,
		firstLine = null;
	function flush() {
		if (blankLines) {
			retained.push("\n".repeat(blankLines));
			blankLines = 0;
		}
	}
	const bytes = await scanDisplayHead(entry, {
		onChunk(piece) {
			pairHash.update(piece);
			headHash.update(piece);
		},
		onLine(text, start, end, newline, omitted) {
			if (start === 0) firstLine = text + (newline ? "\n" : "");
			if (omittedMetadataFields.length + omitted.length > DISPLAY_INDEX_LIMIT)
				throw new Error(
					"Heartbeat display omitted metadata index exceeds limit",
				);
			omittedMetadataFields.push(...omitted);
			const trimmed = text.trim(),
				isHeading = /^#{1,6}\s+/.test(text),
				isItems = /^#{1,6}\s+Items\s*$/i.test(text);
			let keep =
				isHeading ||
				/^\s*(?:[-*]\s*)?(?:thread|thread_id|threadId)\s*:/i.test(text) ||
				/^\s*task_root(?:\s|:|$)/i.test(text) ||
				/^\s{0,3}(?:`{3,}|~{3,})/.test(text) ||
				start === 0;
			if (isItems) {
				table = true;
				headerSeen = false;
			} else if (table) {
				if (!headerSeen && !trimmed) keep = true;
				else if (/^\|.*\|\s*$/.test(trimmed)) {
					keep = true;
					headerSeen = true;
				} else table = false;
			}
			if (
				!keep &&
				trimmed.startsWith("|") &&
				findStrayItemRows(text, []).length
			)
				keep = true;
			const value = keep ? text : "",
				length = Buffer.byteLength(value) + (newline ? 1 : 0);
			if (retainedBytes + length > DISPLAY_HEAD_LIMIT)
				throw new Error("Heartbeat display head projection exceeds byte limit");
			retainedBytes += length;
			if (!value && newline) blankLines++;
			else {
				flush();
				if (++retainedLines > DISPLAY_INDEX_LIMIT)
					throw new Error(
						"Heartbeat display retained line index exceeds limit",
					);
				retained.push(value, newline ? "\n" : "");
			}
		},
	});
	flush();
	return {
		headText: retained.join(""),
		headDigest: headHash.digest("hex"),
		pairHash,
		headMatch: HEAD.exec(firstLine ?? ""),
		firstLine: firstLine ?? "",
		bytes,
		omittedMetadataFields,
	};
}
async function displayScanLargeHead(entry, start, firstLine, cadenceTracker) {
	const indexer = displayIndexer(entry.path, firstLine, cadenceTracker);
	const length = await scanDisplayHead(entry, {
		onLine(text, begin, end) {
			if (end <= start) return;
			if (begin < start)
				throw new Error("Heartbeat planned head ends inside a line");
			indexer.line(text, begin, end);
		},
	});
	return indexer.finish(length);
}
async function displayHashPrefix(entry, length) {
	const hash = createHash("sha256"),
		buffer = Buffer.allocUnsafe(65536);
	let offset = 0,
		lines = 0;
	while (offset < length) {
		const { bytesRead } = await displayRead(
			entry,
			buffer,
			0,
			Math.min(buffer.length, length - offset),
			offset,
		);
		if (!bytesRead)
			throw displayError(
				"Heartbeat source changed during display read",
				"HEARTBEAT_DISPLAY_CHANGED",
			);
		const piece = buffer.subarray(0, bytesRead);
		hash.update(piece);
		for (const byte of piece) if (byte === 10) lines++;
		offset += bytesRead;
	}
	return { digest: hash.digest("hex"), lines };
}
function displayIndexer(path, firstLine = 1, cadenceTracker) {
	const records = [],
		active = [];
	let line = firstLine;
	return {
		line(text, start, end) {
			cadenceTracker?.line(text, path, line);
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
function indexDisplayBuffer(
	buffer,
	path,
	start = 0,
	firstLine = 1,
	cadenceTracker,
) {
	const indexer = displayIndexer(path, firstLine, cadenceTracker);
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
// HISTORY v3 planned payload is base64 streamed in aligned chunks; only the
// bounded metadata prefix and the planned head's first line are retained.
async function displayScanHistory(
	entry,
	paths,
	headBuffer,
	cadenceTracker,
	headSize,
) {
	const pairHash = Buffer.isBuffer(headBuffer)
		? createHash("sha256").update(headBuffer).update("\0")
		: headBuffer.update("\0");
	const bodyHash = createHash("sha256"),
		plannedHash = createHash("sha256"),
		utf8 = new TextDecoder("utf-8", { fatal: true });
	const buffer = Buffer.allocUnsafe(65536),
		prefixParts = [];
	let offset = 0,
		prefixSize = 0,
		prefix = null,
		markerEnd = -1;
	for (;;) {
		const { bytesRead } = await displayRead(
			entry,
			buffer,
			0,
			buffer.length,
			offset,
		);
		if (!bytesRead) break;
		const piece = Buffer.from(buffer.subarray(0, bytesRead));
		prefixParts.push(piece);
		prefixSize += bytesRead;
		offset += bytesRead;
		if (
			prefixSize >
			Math.min(DISPLAY_HEADER_LIMIT, DISPLAY_LINE_LIMIT) + buffer.length
		)
			throw new Error("Heartbeat history header exceeds display limit");
		const combined = Buffer.concat(prefixParts, prefixSize),
			text = combined.toString("latin1");
		const marker = / previous=[a-f0-9]{64} planned=/.exec(text);
		if (marker) {
			markerEnd = marker.index + marker[0].length;
			if (markerEnd > Math.min(DISPLAY_HEADER_LIMIT, DISPLAY_LINE_LIMIT))
				throw new Error("Heartbeat history header exceeds display limit");
			prefix = combined.subarray(0, markerEnd);
			break;
		}
		if (combined.indexOf(10) !== -1) break;
	}
	if (!prefix)
		throw new Error(
			prefixSize > Math.min(DISPLAY_HEADER_LIMIT, DISPLAY_LINE_LIMIT)
				? "Heartbeat history header exceeds display limit"
				: "Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	const prefixText = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
	const match =
		/^<!-- heartbeat-history:v3 source=([^\s>]+) body=([a-f0-9]{64}) base=([a-f0-9]{64}) bytes=(\d+) backup=([a-f0-9]{64}) previous=([a-f0-9]{64}) planned=$/.exec(
			prefixText,
		);
	if (!match || decodeURIComponent(match[1]) !== paths.headPath)
		throw new Error(
			"Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	const bytes = Number(match[4]),
		encodedLength = 4 * Math.ceil(bytes / 3);
	if (
		!Number.isSafeInteger(bytes) ||
		bytes < 1 ||
		bytes > headSize ||
		!Number.isSafeInteger(encodedLength)
	)
		throw new Error(
			"Heartbeat pair integrity check failed for planned head length",
		);
	pairHash.update(prefix);
	offset = prefix.length;
	let remaining = encodedLength,
		decodedBytes = 0,
		firstLine = null,
		lineParts = [],
		lineLength = 0;
	while (remaining) {
		const want = Math.min(buffer.length, remaining);
		let received = 0;
		while (received < want) {
			const { bytesRead } = await displayRead(
				entry,
				buffer,
				received,
				want - received,
				offset + received,
			);
			if (!bytesRead)
				throw new Error(
					"Heartbeat pair integrity check failed for incomplete planned head",
				);
			received += bytesRead;
		}
		const encoded = buffer.subarray(0, want),
			text = encoded.toString("ascii"),
			decoded = Buffer.from(text, "base64");
		if (
			encoded.some((byte) => byte > 127) ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
			decoded.toString("base64") !== text ||
			(remaining > want && text.includes("="))
		)
			throw new Error(
				"Heartbeat pair integrity check failed for planned base64",
			);
		pairHash.update(encoded);
		plannedHash.update(decoded);
		utf8.decode(decoded, { stream: true });
		decodedBytes += decoded.length;
		if (firstLine === null) {
			const newline = decoded.indexOf(10),
				count = newline < 0 ? decoded.length : newline + 1;
			if (lineLength + count > DISPLAY_LINE_LIMIT)
				throw new Error("Heartbeat planned head reference exceeds line limit");
			lineParts.push(Buffer.from(decoded.subarray(0, count)));
			lineLength += count;
			if (newline >= 0)
				firstLine = Buffer.concat(lineParts, lineLength).toString("utf8");
		}
		offset += want;
		remaining -= want;
	}
	utf8.decode();
	const suffix = Buffer.alloc(5);
	let count = 0;
	while (count < suffix.length) {
		const result = await displayRead(
			entry,
			suffix,
			count,
			suffix.length - count,
			offset + count,
		);
		if (!result.bytesRead)
			throw new Error(
				"Heartbeat pair integrity check failed for incomplete history header",
			);
		count += result.bytesRead;
	}
	if (!suffix.equals(Buffer.from(" -->\n")))
		throw new Error(
			"Heartbeat history companion has an invalid, unrelated or incomplete format",
		);
	pairHash.update(suffix);
	offset += suffix.length;
	const plannedRef = firstLine === null ? null : HEAD.exec(firstLine);
	if (
		decodedBytes !== bytes ||
		plannedHash.digest("hex") !== match[3] ||
		!plannedRef ||
		decodeURIComponent(plannedRef[1]) !== paths.headPath ||
		decodeURIComponent(plannedRef[2]) !== paths.historyPath
	)
		throw new Error("Heartbeat pair integrity check failed for planned head");
	const indexer = displayIndexer(paths.historyPath, 2, cadenceTracker);
	const length = await scanDisplayHead(entry, {
		startPosition: offset,
		firstLine: 2,
		onChunk(piece) {
			pairHash.update(piece);
			bodyHash.update(piece);
		},
		onLine(text, start, end) {
			indexer.line(text, start, end);
		},
	});
	return {
		match,
		bodyHash: bodyHash.digest("hex"),
		contentHash: pairHash.digest("hex"),
		records: indexer.finish(length),
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

/** Read only a bounded head projection for discovery; pair integrity is not checked. */
export async function readHeartbeatDiscoveryHead({ root, path, onRead }) {
	if (onRead !== undefined && typeof onRead !== "function")
		throw new TypeError("onRead must be a function");
	const paths = safePaths(root, path);
	let head;
	try {
		head = await displayOpen(paths.headPath, false, onRead);
		const cached = displayCache.get(paths.headPath);
		let result;
		if (cached && cached.fingerprints.split("|")[0] === head.fingerprint) {
			result = {
				headText: cached.headText,
				headDigest: cached.headDigest,
				headProjected: cached.headProjected,
				omittedMetadataFields: cached.omittedMetadataFields,
			};
		} else if (head.info.size > BigInt(DISPLAY_HEAD_LIMIT)) {
			const projection = await displayProjectLargeHead(head);
			result = {
				headText: projection.headText,
				headDigest: projection.headDigest,
				headProjected: true,
				omittedMetadataFields: projection.omittedMetadataFields,
			};
		} else {
			const data = await displayReadFile(head, DISPLAY_HEAD_LIMIT);
			result = {
				headText: data.toString("utf8"),
				headDigest: sha(data),
				headProjected: false,
				omittedMetadataFields: [],
			};
		}
		await displayUnchanged(head);
		safePaths(root, path);
		return {
			...result,
			omittedMetadataFields: result.omittedMetadataFields.map((entry) => ({
				...entry,
			})),
		};
	} catch (error) {
		await displayUnchanged(head);
		throw error;
	} finally {
		await head?.file.close();
	}
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
	canonicalDisplayOnly = false,
	intervalMinutes,
}) {
	if (typeof canonicalDisplayOnly !== "boolean")
		throw new TypeError("canonicalDisplayOnly must be boolean");
	if (typeof inspect !== "function")
		throw new TypeError("inspect must be a function");
	if (onRead !== undefined && typeof onRead !== "function")
		throw new TypeError("onRead must be a function");
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 25)
		throw new TypeError("pageSize must be an integer from 1 to 25");
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		throw new TypeError("now must be a valid Date");
	if (intervalMinutes !== undefined)
		heartbeatAuditDueForWake(null, { now, intervalMinutes });
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
			const projected = head.info.size > BigInt(DISPLAY_HEAD_LIMIT);
			if (
				projected &&
				inspect !== inspectHeartbeatLedger &&
				!canonicalDisplayOnly
			)
				throw new Error(
					"Large heartbeat head requires canonical-display-only inspection",
				);
			const projection = projected ? await displayProjectLargeHead(head) : null;
			const headBuffer = projected
					? null
					: await displayReadFile(head, DISPLAY_HEAD_LIMIT),
				headText = projected
					? projection.headText
					: headBuffer.toString("utf8"),
				headMatch = projected ? projection.headMatch : HEAD.exec(headText),
				headDigest = projected ? projection.headDigest : sha(headBuffer);
			let records, contentHash, isLegacy;
			const cadenceTracker = displayCadenceTracker();
			if (!history) {
				if (headMatch || /^<!-- heartbeat-head:v\d+\b/.test(headText))
					throw new Error(
						"Canonical heartbeat head references a missing history companion",
					);
				isLegacy = true;
				contentHash = (
					projected
						? projection.pairHash
						: createHash("sha256").update(headBuffer)
				)
					.update("\0")
					.digest("hex");
				records = projected
					? await displayScanLargeHead(head, 0, 1, cadenceTracker)
					: indexDisplayBuffer(
							headBuffer,
							paths.headPath,
							0,
							1,
							cadenceTracker,
						);
			} else {
				if (!backup)
					throw new Error(
						"Heartbeat pair is incomplete: immutable backup missing",
					);
				const scanned = await displayScanHistory(
						history,
						paths,
						projected ? projection.pairHash : headBuffer,
						cadenceTracker,
						projected ? projection.bytes : headBuffer.length,
					),
					match = scanned.match,
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
					(await displayHashFile(backup)) !== match[5]
				)
					throw new Error(
						"Heartbeat pair integrity check failed for history, backup or planned head",
					);
				if (
					!Number.isSafeInteger(bytes) ||
					bytes < Buffer.byteLength(headMatch[0]) ||
					bytes > (projected ? projection.bytes : headBuffer.length)
				)
					throw new Error(
						"Heartbeat pair is incomplete or current head was modified; recovery required",
					);
				const entireHeadPlanned =
					bytes === (projected ? projection.bytes : headBuffer.length);
				// When the prefix is the whole head, the already streamed physical
				// digest is exactly the required prefix digest and no suffix exists.
				const prefix = entireHeadPlanned
					? { digest: headDigest, lines: 0 }
					: projected
						? await displayHashPrefix(head, bytes)
						: {
								digest: sha(headBuffer.subarray(0, bytes)),
								lines:
									headBuffer.subarray(0, bytes).toString("utf8").split("\n")
										.length - 1,
							};
				if (prefix.digest !== match[3])
					throw new Error(
						"Heartbeat pair is incomplete or current head was modified; recovery required",
					);
				const suffixRecords = entireHeadPlanned
					? []
					: projected
						? await displayScanLargeHead(
								head,
								bytes,
								prefix.lines + 1,
								cadenceTracker,
							)
						: indexDisplayBuffer(
								headBuffer,
								paths.headPath,
								bytes,
								prefix.lines + 1,
								cadenceTracker,
							);
				records = [...scanned.records, ...suffixRecords];
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
				headDigest,
				headProjected: projected,
				omittedMetadataFields: projection?.omittedMetadataFields ?? [],
				records,
				lastCompleteWake: cadenceTracker.finish(),
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
		if (
			snapshot.headProjected &&
			inspect !== inspectHeartbeatLedger &&
			!canonicalDisplayOnly
		)
			throw new Error(
				"Large heartbeat head requires canonical-display-only inspection",
			);
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
			{
				mode: "items",
				now,
				ledgerPath: paths.headPath,
				inspect:
					snapshot.headProjected && canonicalDisplayOnly
						? inspectHeartbeatLedger
						: inspect,
			},
		);
		// A structural display may omit write_set bytes, so it cannot claim a
		// complete Items audit even if the retained fields have no errors.
		if (snapshot.omittedMetadataFields.length) {
			inventory.passed = false;
			inventory.certifiesCurrent = false;
		}
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
			headProjected: snapshot.headProjected,
			customChecks: snapshot.headProjected ? "not-performed" : "as-configured",
			omittedMetadataFields: snapshot.omittedMetadataFields.map((entry) => ({
				...entry,
			})),
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
			cadence:
				intervalMinutes === undefined
					? null
					: heartbeatAuditDueForWake(snapshot.lastCompleteWake, {
							now,
							intervalMinutes,
						}),
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
