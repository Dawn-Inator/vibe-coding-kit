import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
	heartbeatAuditDue,
	inspectHeartbeatLedger,
} from "../supervision/heartbeat-ledger-api.mjs";
import { parseStrictIsoTimestamp } from "../supervision/heartbeat-audit-due.mjs";
import { discoverHeartbeatLedgerSources } from "./heartbeat-task-source.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const isWithin = (root, candidate) => {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

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

async function readCanonicalSource(projectRoot, path, now, intervalMinutes) {
	const canonicalPath = await realpath(path);
	if (!isWithin(projectRoot, canonicalPath))
		throw new Error(
			"Configured heartbeat ledger resolves outside the project root",
		);
	const info = await stat(canonicalPath);
	if (!info.isFile())
		throw new Error("Configured heartbeat ledger path is not a file");
	if (info.size > MAX_BYTES)
		throw new Error("Heartbeat ledger exceeds the 8 MiB read limit");
	const text = await readFile(canonicalPath, "utf8");
	const current = inspectHeartbeatLedger(text, {
		mode: "current",
		latest: true,
		now,
		ledgerPath: canonicalPath,
	});
	const history = inspectHeartbeatLedger(text, {
		mode: "history",
		latest: false,
		now,
		ledgerPath: canonicalPath,
	});
	const inventory = inspectHeartbeatLedger(text, {
		mode: "items",
		now,
		ledgerPath: canonicalPath,
	});
	return {
		path: canonicalPath,
		contentHash: createHash("sha256").update(text).digest("hex"),
		modifiedAt: info.mtime.toISOString(),
		lastRecordedAt: lastRecordedWakeAt(history, now),
		current,
		history,
		inventory,
		cadence:
			intervalMinutes === undefined
				? null
				: heartbeatAuditDue(text, { now, intervalMinutes }),
	};
}

/** Read and display the latest recorded heartbeat source in one trusted project root. */
export async function readProjectHeartbeat({
	root,
	ledgerPath,
	now = new Date(),
	maxFiles = 2500,
	maxDepth = 5,
	intervalMinutes,
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
	const discovery = await discoverHeartbeatLedgerSources({
		root: projectRoot,
		maxFiles,
		maxDepth,
	});

	if (ledgerPath !== undefined) {
		const requestedPath = resolve(projectRoot, ledgerPath);
		let source;
		try {
			const canonicalRequested = await realpath(requestedPath);
			if (!isWithin(projectRoot, canonicalRequested))
				throw new Error(
					"Configured heartbeat ledger resolves outside the project root",
				);
			source = await readCanonicalSource(
				projectRoot,
				canonicalRequested,
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

	const readable = [];
	const readErrors = [];
	for (const candidate of discovery.candidates) {
		try {
			readable.push(
				await readCanonicalSource(
					projectRoot,
					candidate.path,
					now,
					intervalMinutes,
				),
			);
		} catch (error) {
			readErrors.push(
				`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (readErrors.length) {
		discovery.complete = false;
		discovery.reasons = [
			...new Set([...discovery.reasons, "unreadable-file"]),
		].sort();
	}
	if (!readable.length) {
		if (readErrors.length)
			return resultWithoutSource(
				discovery,
				"error",
				"none",
				readErrors.join("; "),
			);
		return resultWithoutSource(discovery, "none", "none");
	}

	const recorded = readable.filter((entry) => entry.lastRecordedAt !== null);
	const orderByPath = (a, b) => a.path.localeCompare(b.path);
	let source;
	let basis;
	if (recorded.length) {
		recorded.sort(
			(a, b) =>
				Date.parse(b.lastRecordedAt) - Date.parse(a.lastRecordedAt) ||
				orderByPath(a, b),
		);
		source = recorded[0];
		basis = "latest-recorded-wake";
	} else {
		readable.sort(orderByPath);
		source = readable[0];
		basis = "items-inventory";
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
