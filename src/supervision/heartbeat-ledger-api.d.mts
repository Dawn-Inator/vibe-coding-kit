export type HeartbeatInspectionMode = "current" | "history" | "items";

export interface HeartbeatLedgerRow {
	num: number;
	category: string;
	state: string;
	line: number;
	lineNumber: number;
}

export interface HeartbeatWake {
	heading: string;
	line: number;
	lineNumber: number;
	headingLine: number;
	layout: {
		count: 8 | 10;
		reviewRow: number;
		driftRow: number;
		goalRow: number | null;
	};
	headingOk: boolean;
	sources: boolean;
	sourcesLine: string | null;
	rows: HeartbeatLedgerRow[];
	sectionLines: string[];
	timeMs: number | null;
}

/** Parsed Item registry row; unrecognized named columns are retained as strings. */
export interface HeartbeatItem {
	id: string;
	source: string;
	item: string;
	status: string;
	evidence: string;
	owner: string;
	repository: string;
	worktree: string;
	mode: string;
	write_set: string;
	dispatch_ref: string;
	line: number;
	lineNumber?: number;
	[key: string]: unknown;
}

export interface HeartbeatItemTable {
	heading: string;
	lineNumber: number;
	headers: string[];
	rows: HeartbeatItem[];
}

export interface HeartbeatFinding {
	severity: "error" | "advisory";
	rule?: string;
	message: string;
	[key: string]: unknown;
}

export interface HeartbeatInspectionReport {
	schemaVersion: 1;
	mode: HeartbeatInspectionMode;
	contract: "heartbeat/v2" | null;
	certifiesCurrent: boolean;
	passed: boolean;
	wakeCount: number;
	itemCount: number;
	wakes: HeartbeatWake[];
	items: HeartbeatItem[];
	tables: HeartbeatItemTable[];
	findings: HeartbeatFinding[];
}

export interface HeartbeatCheckContext {
	text: string;
	wakes: HeartbeatWake[];
	items: HeartbeatItem[];
	latestWake: HeartbeatWake;
	ledgerPath: string | null;
}

export interface InspectHeartbeatLedgerOptions {
	mode?: HeartbeatInspectionMode;
	latest?: boolean;
	now?: Date;
	ledgerPath?: string;
	extraChecks?: ((context: HeartbeatCheckContext) => HeartbeatFinding[] | void) | ((context: HeartbeatCheckContext) => HeartbeatFinding[] | void)[];
}

export interface HeartbeatAuditDueOptions {
	now?: Date;
	intervalMinutes?: number;
}

export type HeartbeatAuditDueResult =
	| {
		schemaVersion: 1;
		intervalMinutes: number;
		due: true;
		lastAuditAt: null;
		nextDueAt: null;
		reason: "no-full-ten-row-audit";
	}
	| {
		schemaVersion: 1;
		intervalMinutes: number;
		due: true;
		lastAuditAt: null;
		nextDueAt: null;
		reason: "invalid-audit-timestamp";
		line: number;
	}
	| {
		schemaVersion: 1;
		intervalMinutes: number;
		due: true;
		lastAuditAt: string;
		nextDueAt: null;
		reason: "future-audit-timestamp";
		line: number;
	}
	| {
		schemaVersion: 1;
		intervalMinutes: number;
		due: boolean;
		lastAuditAt: string;
		nextDueAt: string;
		reason: "interval-elapsed" | "interval-not-elapsed";
		line: number;
	};

/** Inspect a heartbeat ledger using the shared current, history, or Items report shape. */
export function inspectHeartbeatLedger(
	text: string,
	options?: InspectHeartbeatLedgerOptions,
): HeartbeatInspectionReport;

/** Advisory cadence result for the most recent complete ten-row wake. */
export function heartbeatAuditDue(
	text: string,
	options?: HeartbeatAuditDueOptions,
): HeartbeatAuditDueResult;
