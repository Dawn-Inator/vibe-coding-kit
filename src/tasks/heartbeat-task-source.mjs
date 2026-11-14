import { createHash } from "node:crypto";
import { lstatSync, realpathSync, watch } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { calculateTaskProgress } from "./task-contract.mjs";
import { summarizeHeartbeatLedger } from "../supervision/heartbeat-ledger-api.mjs";
import {
	createProjectLedgerPathScan,
	isProjectPathWithinRoot,
} from "./project-ledger-path.mjs";

const SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"runtime",
	"vendor",
	".cache",
	".tmp",
]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILTER_DIRECTORIES = 16384;
const MAX_FILTER_SOURCE_IDENTITIES = 2500;
const MAX_DIRECTORY_ENTRIES = 65536;
const metadataStamp = (info) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const fileIdentity = (info) =>
	Number.isSafeInteger(info?.dev) && Number.isSafeInteger(info?.ino)
		? `${info.dev}:${info.ino}` : null;
const directoryEntryKind = (entry) => entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other";
function isHeartbeatCompanion(name) {
	return /^taskhistory\.md$/i.test(name) || /(?:\.taskhistory\.md|\.md\.legacy|\.tmp(?:-|$)|\.legacy(?:$|\.)|\.taskhistory\.md\.tmp)/i.test(name);
}
function withoutFencedExamples(text) {
	if (!/^\s{0,3}(?:`{3,}|~{3,})/m.test(text)) return text;
	let fence = null;
	return text
		.split("\n")
		.filter((line) => {
			const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length)
					fence = null;
				return false;
			}
			return fence === null;
		})
		.join("\n");
}

function associatedThread(text) {
	const values = [];
	for (const line of text.split("\n")) {
		const match =
			/^\s*(?:[-*]\s*)?(?:thread|thread_id|threadId)\s*:\s*(.*?)\s*$/i.exec(
				line,
			);
		if (!match) continue;
		let value = match[1].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		// A metadata value names exactly one thread; lists, prose and placeholders are ambiguous.
		if (!value || /\s|,|;|\|/.test(value)) return null;
		values.push(value);
	}
	const unique = new Set(values);
	return unique.size === 1 ? values[0] : null;
}

function priority(name) {
	if (/heartbeat/i.test(name)) return 0;
	if ([".workspace", ".todolist"].includes(name)) return 1;
	if ([".codex", "doc", "docs"].includes(name)) return 2;
	return 3;
}

/**
 * Find candidate heartbeat ledgers without mutating or scheduling anything. The canonical
 * heartbeat API remains responsible for parsing and validating ledger structure.
 */
async function discoverHeartbeatLedgerSourcesInternal({
	root,
	threadId,
	ledgerPath,
	maxFiles = 2500,
	maxDepth = 5,
	collectAssociation,
	collectObservedDirectory,
	collectSourceIdentity,
	collectObservation,
	collectDirectoryEntries,
} = {}, { boundOnly = false } = {}) {
	if (typeof root !== "string" || !root.trim() || !isAbsolute(root))
		throw new TypeError(
			"Heartbeat discovery requires an absolute project root",
		);
	if (
		threadId !== undefined &&
		(typeof threadId !== "string" || !threadId.trim())
	)
		throw new TypeError("Heartbeat discovery requires an exact thread ID");
	if (
		!Number.isInteger(maxFiles) ||
		maxFiles < 1 ||
		!Number.isInteger(maxDepth) ||
		maxDepth < 0
	)
		throw new TypeError(
			"maxFiles and maxDepth must be nonnegative bounded integers",
		);

	const projectRoot = await realpath(resolve(root));
	const pathScan = createProjectLedgerPathScan(projectRoot);
	const candidates = new Map();
	const seenFiles = new Set();
	const seenDirectories = new Set();
	const reasons = new Set();
	let visitedFiles = 0;
	let explicitRealPath = null;
	let boundSourceDigest = null;
	// Resolve and read concurrently, but commit results in traversal order. Only a
	// bounded number of reads may be outstanding, and reservations are consumed
	// in order so duplicate paths and maxFiles retain their serial semantics.
	const pending = [];
	const prepare = async (candidatePath) => {
		try {
			const { path, info } = await pathScan.resolve(candidatePath);
			if (info.size > MAX_BYTES) return { path, info, oversized: true };
			try {
				return { path, info, original: await readFile(path, "utf8") };
			} catch {
				return { path, info, unreadable: true };
			}
		} catch (error) {
			return { error };
		}
	};
	const commit = (result, failClosed = false) => {
		if (result.error) {
			if (failClosed) throw result.error;
			if (result.error?.code !== "nested-git") {
				collectSourceIdentity?.(null);
				collectObservation?.(null, null);
				reasons.add("unreadable-file");
			}
			return;
		}
		const { path } = result;
		if (failClosed) explicitRealPath = path;
		if (seenFiles.has(path)) return;
		if (visitedFiles >= maxFiles) {
			reasons.add("file-limit");
			return;
		}
		seenFiles.add(path);
		visitedFiles += 1;
		collectSourceIdentity?.(result.info);
		collectObservation?.(path, result.info);
		if (result.oversized) { reasons.add("oversized-file"); return; }
		if (result.unreadable) { reasons.add("unreadable-file"); return; }
		try {
			if (boundOnly) boundSourceDigest = createHash("sha256").update(result.original, "utf8").digest("hex");
			const text = withoutFencedExamples(result.original);
			const named = /heartbeat/i.test(basename(path)) ||
				(explicitRealPath && path === explicitRealPath);
			const report = summarizeHeartbeatLedger(text, { includeItems: Boolean(named) });
			const hasDatedWake = report.wakes.some(
				(wake) => typeof wake.timeMs === "number" && Number.isFinite(wake.timeMs),
			);
			if (!hasDatedWake && !(named && report.itemCount)) return;
			const association = associatedThread(text);
			collectAssociation?.(path, association);
			candidates.set(path, { path, associated: Boolean(threadId && association === threadId) });
		} catch {
			reasons.add("unreadable-file");
		}
	};
	const drainOne = async () => commit(await pending.shift());
	const enqueue = async (path) => {
		// Never speculate past the remaining file budget: a failed resolution or
		// duplicate releases its reservation for the next file.
		while (pending.length && (pending.length >= 32 ||
			visitedFiles + pending.length >= maxFiles)) await drainOne();
		if (visitedFiles >= maxFiles) { reasons.add("file-limit"); return false; }
		pending.push(prepare(path));
		return true;
	};

	if (ledgerPath) {
		if (typeof ledgerPath !== "string" || !ledgerPath.trim())
			throw new TypeError("ledgerPath must be nonblank");
		const explicit = resolve(projectRoot, ledgerPath);
		if (isHeartbeatCompanion(basename(explicit)))
			throw new Error("Heartbeat history and backup files cannot be selected as ledger heads");
		commit(await prepare(explicit), true);
	}

	if (boundOnly) {
		if (!ledgerPath) throw new TypeError("A bound ledgerPath is required");
		// This report is deliberately incomplete: no project-wide scan took place.
		reasons.add("source-only");
		return {
			schemaVersion: 1, root: projectRoot,
			candidates: [...candidates.values()], complete: false, visitedFiles,
			limits: { maxFiles, maxDepth }, reasons: [...reasons].sort(),
			...(boundSourceDigest ? { boundSourceDigest } : {}),
		};
	}

	const scan = async (directory, depth) => {
		let canonicalDirectory;
		try {
			canonicalDirectory = await realpath(directory);
		} catch {
			collectObservedDirectory?.(null);
			reasons.add("unreadable-directory");
			return;
		}
		if (seenDirectories.has(canonicalDirectory)) return;
		if (!isProjectPathWithinRoot(projectRoot, canonicalDirectory)) return;
		let entries;
		try {
			if (collectObservation) collectObservation(canonicalDirectory, await lstat(canonicalDirectory));
			entries = await readdir(canonicalDirectory, { withFileTypes: true });
			collectDirectoryEntries?.(canonicalDirectory, entries);
		} catch {
			// A nested repository is excluded even if its directory is unreadable.
			if (!await pathScan.isNestedCanonical(canonicalDirectory)) {
				collectObservedDirectory?.(null);
				collectObservation?.(canonicalDirectory, null);
				reasons.add("unreadable-directory");
			}
			return;
		}
		if (await pathScan.isNestedListedCanonical(canonicalDirectory, entries)) return;
		seenDirectories.add(canonicalDirectory);
		entries.sort(
			(a, b) =>
				priority(a.name) - priority(b.name) || a.name.localeCompare(b.name),
		);
		// Record all observed directories, including depth-limited entries and
		// entries later than the Markdown budget. A former directory changing
		// into a regular file is a structural event, not a content-only edit.
		collectObservedDirectory?.(canonicalDirectory);
		if (collectObservedDirectory)
			for (const entry of entries)
				if (entry.isDirectory()) collectObservedDirectory(resolve(canonicalDirectory, entry.name));
		for (const entry of entries) {
			const path = resolve(canonicalDirectory, entry.name);
			if (entry.isDirectory() && !SKIP.has(entry.name)) {
				if (depth + 1 > maxDepth) {
					if (!await pathScan.isNested(path)) reasons.add("depth-limit");
				} else await scan(path, depth + 1);
			} else if (
				entry.isFile() &&
				entry.name.toLowerCase().endsWith(".md") &&
				!isHeartbeatCompanion(entry.name) &&
				!seenFiles.has(path)
			) {
				if (!await enqueue(path)) return;
			}
		}
	};

	// Visit the highest value project-local locations first, within the same file/depth bounds.
	for (const directory of [".workspace", ".todolist"]) {
		const path = resolve(projectRoot, directory);
		if ((await lstat(path).catch(() => null))?.isDirectory()) {
			if (1 > maxDepth) {
				if (!await pathScan.isNested(path)) reasons.add("depth-limit");
			} else await scan(path, 1);
		}
	}
	await scan(projectRoot, 0);
	while (pending.length) await drainOne();
	return {
		schemaVersion: 1,
		root: projectRoot,
		candidates: [...candidates.values()].sort((a, b) =>
			a.path.localeCompare(b.path),
		),
		complete: reasons.size === 0,
		visitedFiles,
		limits: { maxFiles, maxDepth },
		reasons: [...reasons].sort(),
	};
}

/** Full bounded project scan, including an optional prioritized explicit ledger. */
export function discoverHeartbeatLedgerSources(options = {}) {
	return discoverHeartbeatLedgerSourcesInternal(options);
}

/** Inspect only an already-bound ledger; never claims project-wide completeness. */
export function discoverBoundHeartbeatSource(options = {}) {
	return discoverHeartbeatLedgerSourcesInternal(options, { boundOnly: true });
}

/** Scan-local results are reused only while a live recursive watcher protects the root. */
export class HeartbeatDiscoveryIndex {
	#entries = new Map();
	#versions = new Map();
	#sequence = 0;
	#closed = false;
	#watch;
	#scan;
	#limit;
	constructor({ watchFactory = watch, scanFactory = discoverHeartbeatLedgerSources, maxEntries = 16 } = {}) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be positive");
		this.#watch = watchFactory;
		this.#scan = scanFactory;
		this.#limit = maxEntries;
	}
	async generation(root) {
		const canonical = await realpath(resolve(root));
		return this.#versions.get(canonical) ?? null;
	}
	#invalidate(entry) {
		entry.epoch++;
		entry.value = null;
		// Filtering proof describes the previous snapshot only. A new source
		// can appear while a replacement scan is in flight, so no prior inode or
		// directory evidence may suppress events until that scan commits.
		entry.observedDirectories = null;
		entry.sourceIdentities = null;
		this.#versions.set(entry.root, ++this.#sequence);
	}
	#drop(key, entry) {
		entry.active = false;
		entry.watcher?.close();
		this.#entries.delete(key);
		this.#invalidate(entry);
		if (![...this.#entries.values()].some((other) => other.root === entry.root && other.active))
			this.#versions.delete(entry.root);
	}
	async discover(options, { force = false } = {}) {
		if (this.#closed) throw new Error("Heartbeat discovery index is closed");
		if (typeof options?.root !== "string" || !options.root.trim() || !isAbsolute(options.root))
			throw new TypeError("Heartbeat discovery requires an absolute project root");
		if (options.threadId !== undefined && (typeof options.threadId !== "string" || !options.threadId.trim()))
			throw new TypeError("Heartbeat discovery requires an exact thread ID");
		if (options.ledgerPath !== undefined && (typeof options.ledgerPath !== "string" || !options.ledgerPath.trim()))
			throw new TypeError("ledgerPath must be nonblank");
		if (!Number.isInteger(options.maxFiles === undefined ? 2500 : options.maxFiles) || (options.maxFiles === undefined ? 2500 : options.maxFiles) < 1 ||
			!Number.isInteger(options.maxDepth === undefined ? 5 : options.maxDepth) || (options.maxDepth === undefined ? 5 : options.maxDepth) < 0)
			throw new TypeError("maxFiles and maxDepth must be nonnegative bounded integers");
		const root = await realpath(resolve(options.root));
		const { threadId, ledgerPath, maxFiles = 2500, maxDepth = 5 } = options;
		const explicit = ledgerPath ? resolve(root, ledgerPath) : null;
		let explicitCanonical = null;
		// Automatic discovery skips .tmp. An explicitly selected head there
		// retains its existing behavior but is always read afresh.
		if (explicit) {
			explicitCanonical = await realpath(explicit).catch(() => explicit);
			if ([explicit, explicitCanonical].some((path) => relative(root, path).split(/[\\/]/).includes(".tmp")))
				return this.#scan(options);
		}
		const key = JSON.stringify([root, explicit, maxFiles, maxDepth]);
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { root, epoch: 0, value: null, pending: null, watcher: null, active: false,
				explicit, explicitCanonical, observedDirectories: null, sourceIdentities: null };
			try {
				const current = entry;
				const watcher = this.#watch(root, { recursive: true, persistent: false }, (event, filename) => {
					if (!current.active) return;
					// Skipped trees are excluded from automatic discovery, but a file
					// inside one can still be a hardlink to an inspected ledger or an
					// explicitly configured source. Never suppress an event until every
					// active key has complete directory and source-identity proof.
					const name = typeof filename === "string" ? filename : "";
					const parts = name ? name.split(/[\\/]/) : [];
					const skippedAncestor = parts.some((part, i) => SKIP.has(part) && i < parts.length - 1);
					const nestedGit = parts.includes(".git") && parts[0] !== ".git";
					const regularContentChange = event === "change" && !parts.includes(".git") &&
						!basename(name).toLowerCase().endsWith(".md");
					const skippedRegularEvent = skippedAncestor && !nestedGit &&
						(event === "change" || event === "rename");
					if (typeof filename === "string" && filename && basename(filename) !== ".git" &&
						(regularContentChange || skippedRegularEvent)) {
						const path = resolve(root, filename);
						const relevant = [...this.#entries.values()].filter((other) => other.root === root && other.active);
						if (isProjectPathWithinRoot(root, path) && relevant.length) {
							try {
								const info = lstatSync(path);
								const identity = fileIdentity(info);
								if (info.isFile() && identity && realpathSync(path) === path &&
									relevant.every((other) => other.observedDirectories && !other.observedDirectories.has(path) &&
										other.sourceIdentities && !other.sourceIdentities.has(identity) &&
										(!other.explicit || !isProjectPathWithinRoot(path, other.explicit)) &&
										(!other.explicitCanonical || !isProjectPathWithinRoot(path, other.explicitCanonical)))) return;
							} catch { /* Missing or inaccessible paths invalidate. */ }
						}
					}
					// Every key observes the same root. Invalidate them together before
					// another key can serve a result while its own event is still queued.
					for (const other of this.#entries.values())
						if (other.root === root && other.active) this.#invalidate(other);
				});
				entry.watcher = watcher;
				entry.active = true;
				const lost = () => {
					if (!current.active) return;
					this.#drop(key, current);
				};
				watcher.on("error", lost);
				watcher.on("close", lost);
				if (!this.#versions.has(root)) this.#versions.set(root, ++this.#sequence);
				this.#entries.set(key, entry);
				while (this.#entries.size > this.#limit) {
					const [oldKey, old] = this.#entries.entries().next().value;
					this.#drop(oldKey, old);
				}
			} catch {
				// Unsupported/unavailable recursive watch: never reuse unprotected data.
				return this.#scan(options);
			}
		} else {
			if (entry.explicitCanonical !== explicitCanonical) {
				entry.explicitCanonical = explicitCanonical;
				for (const other of this.#entries.values())
					if (other.root === root && other.active) this.#invalidate(other);
			}
			this.#entries.delete(key);
			this.#entries.set(key, entry);
		}
		const derive = (record) => {
			// The watcher may have invalidated the snapshot after a pending scan
			// resolved but before its awaiting caller resumed.
			if (!entry.active || entry.value !== record || this.#versions.get(root) !== record.generation)
				throw new Error("Heartbeat discovery changed before delivery; retry required");
			const report = { ...record.report, reasons: [...record.report.reasons], limits: { ...record.report.limits },
				candidates: record.report.candidates.map((candidate) => ({
					path: candidate.path, associated: Boolean(threadId && record.associations.get(candidate.path) === threadId),
				})) };
			Object.defineProperty(report, "indexGeneration", { value: record.generation });
			return report;
		};
		if (force) {
			// A scan already in progress may predate the mutation request.
			// Wait for it, then start a new scan before authorizing a write.
			if (entry.pending) await entry.pending.catch(() => {});
			if (!entry.active) return this.#scan(options);
			for (const other of this.#entries.values())
				if (other.root === root && other.active) this.#invalidate(other);
		}
		while (entry.value && entry.active) {
			const record = entry.value;
			const revision = record.revision;
			const updates = [];
			let valid = Boolean(record.observations && record.directories && entry.sourceIdentities);
			if (valid) {
				const observations = [...record.observations];
				for (let offset = 0; offset < observations.length && valid; offset += 32) {
					const results = await Promise.all(observations.slice(offset, offset + 32).map(async ([path, stamp]) => {
						const info = await lstat(path).catch(() => null);
						if (!info) return false;
						if (metadataStamp(info) === stamp) return true;
						const oldEntries = record.directories.get(path);
						if (!oldEntries || !info.isDirectory()) return false;
						const list = await readdir(path, { withFileTypes: true }).catch(() => null);
						if (!list || list.length > MAX_DIRECTORY_ENTRIES) return false;
						const current = new Map(list.map((item) => [item.name, directoryEntryKind(item)]));
						for (const [name, kind] of oldEntries) if (current.get(name) !== kind) return false;
						for (const [name, kind] of current) {
							if (oldEntries.has(name)) continue;
							if (kind !== "file" || name === ".git" || name.toLowerCase().endsWith(".md")) return false;
							const added = resolve(path, name);
							const addedInfo = await lstat(added).catch(() => null);
							const identity = fileIdentity(addedInfo);
							if (!addedInfo?.isFile() || addedInfo.nlink !== 1 || !identity || entry.sourceIdentities.has(identity) ||
								(entry.explicit && isProjectPathWithinRoot(added, entry.explicit)) ||
								(entry.explicitCanonical && isProjectPathWithinRoot(added, entry.explicitCanonical)) ||
								await realpath(added).catch(() => null) !== added) return false;
						}
						const after = await lstat(path).catch(() => null);
						if (!after || metadataStamp(after) !== metadataStamp(info)) return false;
						updates.push([path, metadataStamp(info), current]);
						return true;
					}));
					valid = results.every(Boolean);
				}
			}
			if (valid && record.directoryEntryCount + updates.reduce((sum, [path, , entries]) => sum + entries.size - record.directories.get(path).size, 0) > MAX_DIRECTORY_ENTRIES) valid = false;
			// An older validation cannot invalidate or overwrite a replacement proof.
			if (entry.value !== record || !entry.active || record.revision !== revision) continue;
			if (valid) {
				for (const [path, stamp, entries] of updates) {
					record.directoryEntryCount += entries.size - record.directories.get(path).size;
					record.observations.set(path, stamp);
					record.directories.set(path, entries);
				}
				if (updates.length) record.revision++;
				return derive(record);
			}
			for (const other of this.#entries.values())
				if (other.root === root && other.active) this.#invalidate(other);
		}
		if (!entry.pending) {
			const current = entry;
			const pending = (async () => {
				for (let attempt = 0; attempt < 3; attempt++) {
					const epoch = current.epoch;
					const associations = new Map();
					const observations = new Map();
					const directories = new Map();
					let directoryEntryCount = 0;
					let observationsComplete = true;
					const observedDirectories = new Set();
					const sourceIdentities = new Set();
					let directoryMetadataComplete = true;
					let sourceIdentitiesComplete = true;
					let observedSources = 0;
					const report = await this.#scan({ ...options, root, threadId: undefined,
						collectObservation: (path, info) => {
							if (!info || (!observations.has(path) && observations.size >= MAX_FILTER_DIRECTORIES + MAX_FILTER_SOURCE_IDENTITIES)) observationsComplete = false;
							else observations.set(path, metadataStamp(info));
						},
						collectDirectoryEntries: (path, entries) => {
							directoryEntryCount += entries.length;
							if (directoryEntryCount > MAX_DIRECTORY_ENTRIES) observationsComplete = false;
							else directories.set(path, new Map(entries.map((item) => [item.name, directoryEntryKind(item)])));
						},
						collectAssociation: (path, value) => associations.set(path, value),
						collectSourceIdentity: (info) => {
							observedSources++;
							const identity = fileIdentity(info);
							if (!identity) sourceIdentitiesComplete = false;
							else if (!sourceIdentities.has(identity)) {
								if (sourceIdentities.size >= MAX_FILTER_SOURCE_IDENTITIES) sourceIdentitiesComplete = false;
								else sourceIdentities.add(identity);
							}
						},
						collectObservedDirectory: (path) => {
							if (!path) directoryMetadataComplete = false;
							else if (!observedDirectories.has(path)) {
								if (observedDirectories.size >= MAX_FILTER_DIRECTORIES) directoryMetadataComplete = false;
								else observedDirectories.add(path);
							}
						} });
					if (current.active && current.epoch === epoch) {
						const record = { report, associations, directories: observationsComplete && directories.has(root) ? directories : null, directoryEntryCount, revision: 0, observations: observationsComplete && observations.has(root) && observedSources === report.visitedFiles ? observations : null, generation: this.#versions.get(root) };
						current.observedDirectories = directoryMetadataComplete && observedDirectories.has(root) ? observedDirectories : null;
						current.sourceIdentities = sourceIdentitiesComplete && observedSources === report.visitedFiles ? sourceIdentities : null;
						current.value = record;
						return record;
					}
					if (!current.active) break;
				}
				throw new Error("Heartbeat discovery changed while scanning; retry required");
			})();
			current.pending = pending;
			void pending.finally(() => { if (current.pending === pending) current.pending = null; }).catch(() => {});
		}
		return derive(await entry.pending);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const [key, entry] of this.#entries) this.#drop(key, entry);
		this.#versions.clear();
	}
}

/** Backward-compatible candidates-only view of the shared bounded scan. */
export async function discoverHeartbeatLedgers(options = {}) {
	return (await discoverHeartbeatLedgerSources(options)).candidates;
}

function parsedChildren(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function mapStatus(raw) {
	const token = String(raw ?? "")
		.trim()
		.split(/\s+/)[0]
		.toLowerCase();
	if (token === "done" || token === "completed") return "completed";
	if (token === "dispatched" || token === "tracking") return "active";
	if (token === "blocked" || token === "owner") return "blocked";
	return "pending";
}

function rowEvidence(row, path) {
	const summary = String(row.evidence ?? "").trim();
	if (!summary) return [];
	const line = [row.line, row.lineNumber].find(
		(value) => Number.isInteger(value) && value > 0,
	);
	const location = line === undefined ? path : `${path}#L${line}`;
	const source = String(row.source ?? "").trim();
	return [
		{
			summary,
			verification: "reported",
			kind: "heartbeat-item",
			reference: source ? `${location}; source=${source}` : location,
		},
	];
}

/** Project an inspected Items inventory into a read-only shared task view. */
export function projectHeartbeatTask({
	report,
	root,
	threadId,
	path,
	contentHash,
	modifiedAt,
	title,
} = {}) {
	if (
		!report ||
		report.mode !== "items" ||
		!Array.isArray(report.items) ||
		!Array.isArray(report.findings)
	)
		throw new TypeError(
			"Heartbeat task projection requires an inspectHeartbeatLedger items report",
		);
	if (typeof threadId !== "string" || !threadId.trim())
		throw new TypeError("A nonblank threadId is required");
	if (
		typeof root !== "string" ||
		!root.trim() ||
		!isAbsolute(root) ||
		resolve(root) !== root
	)
		throw new TypeError("A normalized absolute project root is required");
	if (
		typeof path !== "string" ||
		!path.trim() ||
		!isAbsolute(path) ||
		resolve(path) !== path
	)
		throw new TypeError("A project-local absolute ledger path is required");
	if (!isProjectPathWithinRoot(root, path))
		throw new Error("Heartbeat ledger path must stay within the project root");
	if (typeof contentHash !== "string" || !contentHash.trim())
		throw new TypeError("contentHash is required");
	const modifiedTime = new Date(modifiedAt);
	if (!Number.isFinite(modifiedTime.getTime()))
		throw new TypeError("modifiedAt must be a valid timestamp");
	const errors = report.findings.filter(
		(finding) => finding.severity === "error",
	);
	if (errors.length) {
		const details = errors
			.map(
				(finding) => `${finding.rule ?? "heartbeat-items"}: ${finding.message}`,
			)
			.join("; ");
		throw new Error(
			`Cannot project invalid heartbeat Items report: ${details}`,
		);
	}

	const rows = report.items;
	const byId = new Map();
	for (const row of rows) {
		const id = typeof row.id === "string" ? row.id.trim() : "";
		if (!id)
			throw new Error(`Heartbeat Items row ${row.line ?? "?"} has no ID`);
		if (byId.has(id))
			throw new Error(`Heartbeat Items contains duplicate row ID ${id}`);
		byId.set(id, row);
	}

	const links = new Map();
	const linkRisks = [];
	for (const [id, row] of byId) {
		if (row.children === undefined || row.children === "") continue;
		const children = parsedChildren(row.children);
		if (!children) {
			linkRisks.push(`${id}: children is not a JSON array`);
			continue;
		}
		if (children.length === 0) continue;
		if (
			mapStatus(row.status) !== "active" ||
			!/^tracking\b/i.test(String(row.status ?? "").trim())
		) {
			linkRisks.push(
				`${id}: child links are only aggregated for tracking parents`,
			);
			continue;
		}
		const normalized = children.map((child) =>
			typeof child === "string" ? child.trim() : "",
		);
		if (new Set(normalized).size !== normalized.length)
			linkRisks.push(`${id}: duplicate child link`);
		for (const child of normalized) {
			if (!child || !byId.has(child))
				linkRisks.push(`${id}: missing child ${child || "(empty)"}`);
			if (child === id) linkRisks.push(`${id}: self-link`);
		}
		if (
			normalized.every((child) => child && byId.has(child) && child !== id) &&
			new Set(normalized).size === normalized.length
		)
			links.set(id, normalized);
	}
	const visiting = new Set();
	const visited = new Set();
	const cyclic = new Set();
	const visit = (id, trail = []) => {
		if (visiting.has(id)) {
			const start = trail.indexOf(id);
			for (const member of trail.slice(start)) cyclic.add(member);
			return;
		}
		if (visited.has(id)) return;
		visiting.add(id);
		for (const child of links.get(id) ?? []) visit(child, [...trail, id]);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) visit(id);
	for (const id of cyclic) linkRisks.push(`${id}: cyclic child link`);

	const safeParents = new Map(
		[...links].filter(
			([id, children]) =>
				!cyclic.has(id) && children.every((child) => !cyclic.has(child)),
		),
	);
	const incoming = new Map();
	for (const [parent, children] of safeParents)
		for (const child of children) {
			const current = incoming.get(child) ?? [];
			current.push(parent);
			incoming.set(child, current);
		}
	const representedAsChild = new Set(incoming.keys());
	const roots = [...safeParents.keys()]
		.filter((id) => !representedAsChild.has(id))
		.sort();
	const assignedLeaves = new Set();
	const leafOwner = new Map();
	const groupedLeaves = new Map();
	for (const rootId of roots) {
		const leaves = [];
		const walk = (id, trail = new Set()) => {
			if (trail.has(id)) return;
			const children = safeParents.get(id);
			if (!children?.length) {
				if (!assignedLeaves.has(id)) {
					assignedLeaves.add(id);
					leafOwner.set(id, rootId);
					leaves.push(id);
				}
				return;
			}
			const nextTrail = new Set(trail).add(id);
			for (const child of children) walk(child, nextTrail);
		};
		walk(rootId);
		groupedLeaves.set(rootId, leaves);
	}
	for (const [child, parents] of incoming)
		if (parents.length > 1)
			linkRisks.push(
				`${child}: shared child link; counted once under ${leafOwner.get(child) ?? parents.sort()[0]}`,
			);

	const objectives = [];
	const buildEntry = (row) => ({
		id: row.id.trim(),
		title: String(row.item ?? "").trim() || `Heartbeat item ${row.id}`,
		status: mapStatus(row.status),
		evidence: rowEvidence(row, path),
	});
	const represented = new Set();
	for (const [id, row] of byId) {
		if (safeParents.has(id)) {
			// Parent rows remain visible but are excluded from leaf progress; terminal descendants
			// appear under one deterministic top-level parent only, including in shared-child DAGs.
			const isRoot = groupedLeaves.has(id);
			const leaves = isRoot ? groupedLeaves.get(id) : [];
			const objective = {
				...buildEntry(row),
				required: leaves.length > 0,
				items: leaves.map((leafId) => buildEntry(byId.get(leafId))),
			};
			objectives.push(objective);
			represented.add(id);
			for (const leafId of objective.items.map((item) => item.id))
				represented.add(leafId);
		}
	}
	for (const [id, row] of byId)
		if (!represented.has(id)) {
			objectives.push({ ...buildEntry(row), required: true, items: [] });
			represented.add(id);
		}

	const progress = calculateTaskProgress(objectives);
	const timestamp = modifiedTime.toISOString();
	return {
		schemaVersion: 3,
		kind: "task",
		threadId,
		title:
			typeof title === "string" && title.trim()
				? title.trim()
				: "Heartbeat ledger task",
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		objectives,
		progress,
		phase:
			progress.total > 0 && progress.completed === progress.total
				? "completed"
				: "active",
		source: {
			kind: "kit-heartbeat",
			path,
			readOnly: true,
			contentHash,
			itemStatuses: Object.fromEntries(
				[...byId].map(([id, row]) => [id, String(row.status ?? "")]),
			),
			...(linkRisks.length ? { linkRisks } : {}),
		},
	};
}
