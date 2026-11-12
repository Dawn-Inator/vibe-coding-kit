import type {
	HeartbeatAuditDueResult,
	HeartbeatInspectionReport,
} from "../supervision/heartbeat-ledger-api.mjs";
import type { HeartbeatLedgerDiscoveryReport } from "./heartbeat-task-source.mjs";

export type ProjectHeartbeatBasis =
	| "configured"
	| "latest-recorded-wake"
	| "items-inventory"
	| "none";

export interface ProjectHeartbeatSource {
	path: string;
	historyPath: string;
	contentHash: string;
	modifiedAt: string;
	lastRecordedAt: string | null;
	current: HeartbeatInspectionReport & { mode: "current" };
	history: HeartbeatInspectionReport & { mode: "history" };
	inventory: HeartbeatInspectionReport & { mode: "items" };
	cadence: HeartbeatAuditDueResult | null;
}

export interface ProjectHeartbeatReadResult {
	schemaVersion: 1;
	projectRoot: string;
	status: "ready" | "none" | "error";
	source: ProjectHeartbeatSource | null;
	discovery: HeartbeatLedgerDiscoveryReport;
	basis: ProjectHeartbeatBasis;
	error?: string;
}

export interface ReadProjectHeartbeatOptions {
	root: string;
	ledgerPath?: string;
	now?: Date;
	maxFiles?: number;
	maxDepth?: number;
	intervalMinutes?: number;
	migrate?: boolean;
}

/** Automatically display the latest recorded heartbeat in one current project root. */
export function readProjectHeartbeat(
	options: ReadProjectHeartbeatOptions,
): Promise<ProjectHeartbeatReadResult>;
