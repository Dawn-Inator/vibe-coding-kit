import type { TaskSource, TaskState } from "./task-contract.mjs";

export interface HeartbeatLedgerCandidate {
	path: string;
	associated: boolean;
}

export interface DiscoverHeartbeatLedgersOptions {
	root: string;
	threadId: string;
	ledgerPath?: string;
	maxFiles?: number;
	maxDepth?: number;
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
	threadId: string;
	path: string;
	contentHash: string;
	modifiedAt: string | Date;
	title?: string;
}

/** Discover bounded project-local ledgers using Kit's canonical heartbeat parser. */
export function discoverHeartbeatLedgers(
	options: DiscoverHeartbeatLedgersOptions,
): Promise<HeartbeatLedgerCandidate[]>;

/** Purely project an inspected Items report into a read-only task state. */
export function projectHeartbeatTask(
	options: ProjectHeartbeatTaskOptions,
): TaskState & { source: HeartbeatTaskSource };
