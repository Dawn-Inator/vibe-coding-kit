import type { TaskSource, TaskState } from "./task-contract.mjs";

export interface HeartbeatLedgerCandidate {
	path: string;
	associated: boolean;
}

export interface DiscoverHeartbeatLedgersOptions {
	root: string;
	threadId?: string;
	ledgerPath?: string;
	maxFiles?: number;
	maxDepth?: number;
}

export type HeartbeatDiscoveryReason =
	| "file-limit"
	| "depth-limit"
	| "unreadable-directory"
	| "unreadable-file"
	| "oversized-file";

export interface HeartbeatLedgerDiscoveryReport {
	schemaVersion: 1;
	root: string;
	candidates: HeartbeatLedgerCandidate[];
	complete: boolean;
	visitedFiles: number;
	limits: { maxFiles: number; maxDepth: number };
	reasons: HeartbeatDiscoveryReason[];
}

export interface HeartbeatItemRow {
	id: string;
	item?: string;
	status?: string;
	evidence?: string;
	line?: number;
	children?: unknown;
	[field: string]: unknown;
}

export interface HeartbeatItemsReport {
	mode: "items";
	items: HeartbeatItemRow[];
	findings: { severity: string; rule?: string; message: string }[];
}

export interface HeartbeatTaskSource extends TaskSource {
	linkRisks?: string[];
}

export interface ProjectHeartbeatTaskOptions {
	report: HeartbeatItemsReport;
	/** Canonical real project root matching the root used for discovery. */
	root: string;
	threadId: string;
	/** Canonical discovered ledger path, under root. */
	path: string;
	contentHash: string;
	modifiedAt: string | Date;
	title?: string;
}

export type HeartbeatTaskState = Omit<TaskState, "source"> & {
	source: HeartbeatTaskSource;
};

/** Discover bounded project-local ledgers and report whether the scan was exhaustive within its scope. */
export function discoverHeartbeatLedgerSources(
	options: DiscoverHeartbeatLedgersOptions,
): Promise<HeartbeatLedgerDiscoveryReport>;

/** Compatibility-only candidates projection; use discoverHeartbeatLedgerSources when completeness matters. */
export function discoverHeartbeatLedgers(
	options: DiscoverHeartbeatLedgersOptions,
): Promise<HeartbeatLedgerCandidate[]>;

/** Purely project an inspected Items report into a read-only task state. */
export function projectHeartbeatTask(
	options: ProjectHeartbeatTaskOptions,
): HeartbeatTaskState;
