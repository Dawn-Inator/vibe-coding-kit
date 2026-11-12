import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { calculateTaskProgress } from "./task-contract.mjs";
import { inspectHeartbeatLedger } from "../supervision/heartbeat-ledger-api.mjs";

const SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"runtime",
	"vendor",
	".cache",
]);
const MAX_BYTES = 8 * 1024 * 1024;
const isWithin = (root, path) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function isNestedGitProject(projectRoot, directory) {
	if (directory === projectRoot) return false;
	return Boolean(await lstat(resolve(directory, ".git")).catch(() => null));
}

function withoutFencedExamples(text) {
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

function isAssociatedThread(text, threadId) {
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
		if (!value || /\s|,|;|\|/.test(value)) return false;
		values.push(value);
	}
	const unique = new Set(values);
	return unique.size === 1 && unique.has(threadId);
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
export async function discoverHeartbeatLedgerSources({
	root,
	threadId,
	ledgerPath,
	maxFiles = 2500,
	maxDepth = 5,
} = {}) {
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
	const candidates = new Map();
	const seenFiles = new Set();
	const seenDirectories = new Set();
	const reasons = new Set();
	let visitedFiles = 0;
	let explicitRealPath = null;
	const inspect = async (candidatePath) => {
		const lexicalPath = resolve(candidatePath);
		let path = lexicalPath;
		try {
			path = await realpath(lexicalPath);
		} catch {
			reasons.add("unreadable-file");
		}
		if (seenFiles.has(path)) return;
		if (visitedFiles >= maxFiles) {
			reasons.add("file-limit");
			return;
		}
		seenFiles.add(path);
		visitedFiles += 1;
		try {
			const info = await stat(path);
			if (!info.isFile() || !isWithin(projectRoot, path)) return;
			if (info.size > MAX_BYTES) {
				reasons.add("oversized-file");
				return;
			}
			const original = await readFile(path, "utf8");
			const text = withoutFencedExamples(original);
			const report = inspectHeartbeatLedger(text, { mode: "items" });
			const hasDatedWake = report.wakes.some(
				(wake) =>
					typeof wake.timeMs === "number" && Number.isFinite(wake.timeMs),
			);
			const named =
				/heartbeat/i.test(basename(path)) ||
				(explicitRealPath && path === explicitRealPath);
			// Discovery uses parsed API output as a signal, never a second ledger-format validator.
			if (!hasDatedWake && !(named && report.itemCount)) return;
			candidates.set(path, {
				path,
				associated: threadId ? isAssociatedThread(text, threadId) : false,
			});
		} catch {
			reasons.add("unreadable-file");
		}
	};

	if (ledgerPath) {
		if (typeof ledgerPath !== "string" || !ledgerPath.trim())
			throw new TypeError("ledgerPath must be nonblank");
		const explicit = resolve(projectRoot, ledgerPath);
		if (!isWithin(projectRoot, explicit))
			throw new Error(
				"Explicit heartbeat ledger path must stay within the project root",
			);
		explicitRealPath = await realpath(explicit).catch(() => null);
		if (explicitRealPath && !isWithin(projectRoot, explicitRealPath))
			throw new Error(
				"Explicit heartbeat ledger path resolves outside the project root",
			);
		await inspect(explicitRealPath ?? explicit);
	}

	const scan = async (directory, depth) => {
		let canonicalDirectory;
		try {
			canonicalDirectory = await realpath(directory);
		} catch {
			reasons.add("unreadable-directory");
			return;
		}
		if (seenDirectories.has(canonicalDirectory)) return;
		if (await isNestedGitProject(projectRoot, canonicalDirectory)) return;
		seenDirectories.add(canonicalDirectory);
		let entries;
		try {
			entries = await readdir(canonicalDirectory, { withFileTypes: true });
		} catch {
			reasons.add("unreadable-directory");
			return;
		}
		entries.sort(
			(a, b) =>
				priority(a.name) - priority(b.name) || a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const path = resolve(canonicalDirectory, entry.name);
			if (entry.isDirectory() && !SKIP.has(entry.name)) {
				if (await isNestedGitProject(projectRoot, path)) continue;
				if (depth + 1 > maxDepth) reasons.add("depth-limit");
				else await scan(path, depth + 1);
			} else if (
				entry.isFile() &&
				entry.name.toLowerCase().endsWith(".md") &&
				!seenFiles.has(path)
			) {
				if (visitedFiles >= maxFiles) {
					reasons.add("file-limit");
					return;
				}
				await inspect(path);
			}
		}
	};

	// Visit the highest value project-local locations first, within the same file/depth bounds.
	for (const directory of [".workspace", ".todolist"]) {
		const path = resolve(projectRoot, directory);
		if ((await lstat(path).catch(() => null))?.isDirectory()) {
			if (await isNestedGitProject(projectRoot, path)) continue;
			if (1 > maxDepth) reasons.add("depth-limit");
			else await scan(path, 1);
		}
	}
	await scan(projectRoot, 0);
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
	return summary
		? [
				{
					summary,
					verification: "reported",
					kind: "heartbeat-item",
					reference: `${path}#L${row.line}; source=${row.source ?? ""}`,
				},
			]
		: [];
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
	if (!isWithin(root, path))
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
