import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { heartbeatAuditDue } from "../supervision/heartbeat-ledger-api.mjs";
import { parseStrictIsoTimestamp } from "../supervision/heartbeat-audit-due.mjs";
import {
	inspectHeartbeatLedgerPair,
	readHeartbeatLedgerPair,
	summarizeHeartbeatLedgerPair,
} from "../supervision/heartbeat-ledger-files.mjs";
import { discoverHeartbeatLedgerSources } from "./heartbeat-task-source.mjs";
import { resolveProjectLedgerPath } from "./project-ledger-path.mjs";

const MAX_BYTES = 8 * 1024 * 1024;

function resultWithoutSource(discovery, status, basis, error) {
	return {
		schemaVersion: 1,
		projectRoot: discovery.root,
		status,
		source: null,
		discovery,
		basis,
		...(error ? { error } : {}),
	};
}

function lastRecordedWakeAt(report, now) {
	const times = report.wakes
		.map((wake) => {
			const timestamp = wake.heading
				.replace(/^#{1,6}\s+/, "")
				.trim()
				.split(/\s+/, 1)[0];
			const parsed = parseStrictIsoTimestamp(timestamp);
			return parsed !== null && parsed <= now.getTime() ? parsed : null;
		})
		.filter((value) => value !== null);
	return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

async function readCanonicalPair(projectRoot, path, now) {
	const { path: canonicalPath, info } = await resolveProjectLedgerPath(projectRoot, path);
	if (info.size > MAX_BYTES) throw new Error("Heartbeat ledger exceeds the 8 MiB read limit");
	const pair = readHeartbeatLedgerPair({ root: projectRoot, path: canonicalPath, maxBytes: MAX_BYTES });
	const summary = summarizeHeartbeatLedgerPair(pair);
	return {
		path: canonicalPath, info, pair,
		lastRecordedAt: lastRecordedWakeAt(summary, now),
		itemCount: summary.itemCount,
	};
}

function inspectCanonicalSource(entry, now, intervalMinutes) {
	const { path: canonicalPath, info, pair } = entry;
	const current = inspectHeartbeatLedgerPair(pair, { mode: "current", latest: true, now, ledgerPath: canonicalPath });
	const history = inspectHeartbeatLedgerPair(pair, { mode: "history", latest: false, now, ledgerPath: canonicalPath });
	const inventory = inspectHeartbeatLedgerPair(pair, { mode: "items", now, ledgerPath: canonicalPath });
	return {
		path: canonicalPath,
		contentHash: pair.contentHash,
		modifiedAt: pair.modifiedAt || info.mtime.toISOString(),
		historyPath: pair.isLegacy ? pair.headPath : pair.historyPath,
		lastRecordedAt: lastRecordedWakeAt(history, now),
		current, history, inventory,
		cadence: intervalMinutes === undefined ? null : heartbeatAuditDue(pair.fullText, { now, intervalMinutes }),
	};
}

async function readCanonicalSource(projectRoot, path, now, intervalMinutes) {
	return inspectCanonicalSource(await readCanonicalPair(projectRoot, path, now), now, intervalMinutes);
}

/** Read and display the latest recorded heartbeat source in one trusted project root. */
export async function readProjectHeartbeat({
	root,
	ledgerPath,
	now = new Date(),
	maxFiles = 2500,
	maxDepth = 5,
	intervalMinutes,
	discoveryIndex,
} = {}) {
	if (typeof root !== "string" || !root.trim() || !isAbsolute(root))
		throw new TypeError("Project heartbeat requires an absolute project root");
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		throw new TypeError("now must be a valid Date");
	if (
		intervalMinutes !== undefined &&
		(typeof intervalMinutes !== "number" ||
			!Number.isFinite(intervalMinutes) ||
			intervalMinutes <= 0)
	)
		throw new TypeError(
			"intervalMinutes must be a finite number greater than 0",
		);
	if (
		ledgerPath !== undefined &&
		(typeof ledgerPath !== "string" || !ledgerPath.trim())
	)
		throw new TypeError("ledgerPath must be a nonblank path when configured");

	const projectRoot = await realpath(resolve(root));
	const discoveryOptions = { root: projectRoot, maxFiles, maxDepth };
	const discovery = await (discoveryIndex
		? discoveryIndex.discover(discoveryOptions)
		: discoverHeartbeatLedgerSources(discoveryOptions));

	if (ledgerPath !== undefined) {
		const requestedPath = resolve(projectRoot, ledgerPath);
		let source;
		try {
			source = await readCanonicalSource(
				projectRoot,
				requestedPath,
				now,
				intervalMinutes,
			);
		} catch (error) {
			return resultWithoutSource(
				discovery,
				"error",
				"none",
				`Configured heartbeat ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {
			schemaVersion: 1,
			projectRoot,
			status: "ready",
			source,
			discovery,
			basis: "configured",
		};
	}

	const readErrors = [];
	const entries = [];
	let bestRecorded = null;
	let bestInventory = null;
	const comparePath = (a, b) => a.path.localeCompare(b.path);
	for (const candidate of discovery.candidates) {
		try {
			const entry = await readCanonicalPair(projectRoot, candidate.path, now);
			// Keep at most two complete pair snapshots, regardless of project size.
			const isRecorded = entry.lastRecordedAt !== null && (!bestRecorded ||
				entry.lastRecordedAt > bestRecorded.lastRecordedAt ||
				(entry.lastRecordedAt === bestRecorded.lastRecordedAt && comparePath(entry, bestRecorded) < 0));
			const isInventory = entry.itemCount > 0 && (!bestInventory || comparePath(entry, bestInventory) < 0);
			entries.push({ path: entry.path, lastRecordedAt: entry.lastRecordedAt, itemCount: entry.itemCount });
			if (isRecorded) bestRecorded = entry;
			if (isInventory) bestInventory = entry;
		} catch (error) {
			readErrors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	entries.sort((a, b) => {
		if (a.lastRecordedAt !== null && b.lastRecordedAt !== null)
			return b.lastRecordedAt.localeCompare(a.lastRecordedAt) || comparePath(a, b);
		if (a.lastRecordedAt !== null) return -1;
		if (b.lastRecordedAt !== null) return 1;
		if (Boolean(a.itemCount) !== Boolean(b.itemCount)) return a.itemCount ? -1 : 1;
		return comparePath(a, b);
	});
	let source = null;
	let auditFailures = 0;
	let basis = "none";
	for (const entry of entries) {
		if (entry.lastRecordedAt === null && !entry.itemCount) break;
		try {
			const snapshot = entry.path === bestRecorded?.path ? bestRecorded :
				entry.path === bestInventory?.path ? bestInventory :
				await readCanonicalPair(projectRoot, entry.path, now);
			if (snapshot.lastRecordedAt !== entry.lastRecordedAt || snapshot.itemCount !== entry.itemCount)
				throw new Error("Heartbeat source changed while selecting a candidate");
			source = inspectCanonicalSource(snapshot, now, intervalMinutes);
			basis = entry.lastRecordedAt !== null ? "latest-recorded-wake" : "items-inventory";
			break;
		} catch (error) {
			auditFailures += 1;
			readErrors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (readErrors.length) {
		discovery.complete = false;
		discovery.reasons = [...new Set([...discovery.reasons, "unreadable-file"])].sort();
	}
	if (!source) {
		if (entries.length === auditFailures && readErrors.length)
			return resultWithoutSource(discovery, "error", "none", readErrors.join("; "));
		return resultWithoutSource(discovery, "none", "none");
	}

	return {
		schemaVersion: 1,
		projectRoot,
		status: "ready",
		source,
		discovery,
		basis,
	};
}
