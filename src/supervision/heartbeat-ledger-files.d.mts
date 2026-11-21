import type {
	HeartbeatFinding,
	HeartbeatAuditDueResult,
	HeartbeatInspectionMode,
	HeartbeatInspectionReport,
	HeartbeatItem,
	HeartbeatItemTable,
	HeartbeatLedgerRow,
	HeartbeatWake,
	HeartbeatOrchestration,
	InspectHeartbeatLedgerOptions,
} from "./heartbeat-ledger-api.mjs";

export interface HeartbeatLedgerPair {
	headText: string;
	historyText: string;
	fullText: string;
	contentHash: string;
	modifiedAt: string;
	headPath: string;
	historyPath: string;
	isLegacy: boolean;
	wakes: Array<{
		text: string;
		sourcePath: string;
		sourceLine?: number;
		heading?: string;
	}>;
}
export type HeartbeatPairInspectionReport = Omit<
	HeartbeatInspectionReport,
	"wakes" | "items" | "tables" | "findings"
> & {
	findings: Array<
		HeartbeatFinding & {
			sourcePath?: string;
			sourceLine?: number;
			sourceLocations?: Array<{
				sourcePath: string;
				sourceLine: number;
				logicalLine: number;
			}>;
		}
	>;
	wakes: Array<
		Omit<HeartbeatWake, "rows"> & {
			sourcePath: string;
			sourceLine: number;
			logicalLine: number;
			rows: Array<
				HeartbeatLedgerRow & {
					sourcePath: string;
					sourceLine: number;
					logicalLine: number;
				}
			>;
		}
	>;
	items: Array<HeartbeatItem & { sourcePath: string; sourceLine: number }>;
	tables: Array<
		Omit<HeartbeatItemTable, "rows"> & {
			rows: Array<HeartbeatItem & { sourcePath: string; sourceLine: number }>;
		}
	>;
};

export function heartbeatLedgerPairPaths(path: string): {
	headPath: string;
	historyPath: string;
	legacyBackupPath: string;
};
export function readHeartbeatLedgerPair(options: {
	root: string;
	path: string;
	migrate?: false;
	/** Maximum combined bytes of head and history; the backup is also bounded. */
	maxBytes?: number;
}): HeartbeatLedgerPair;
/** Parse ranking metadata without certifying or auditing the pair. */
export function summarizeHeartbeatLedgerPair(pair: HeartbeatLedgerPair): {
	wakes: HeartbeatWake[];
	itemCount: number;
};
export function inspectHeartbeatLedgerPair(
	pair: HeartbeatLedgerPair,
	options?: InspectHeartbeatLedgerOptions & {
		mode?: HeartbeatInspectionMode;
		inspect?: (
			text: string,
			options: InspectHeartbeatLedgerOptions,
		) => HeartbeatInspectionReport;
	},
): HeartbeatPairInspectionReport;
/** The caller must ensure all legacy writers remain quiescent for the complete operation.
 * All Kit writers coordinate using an exclusive cross-process lock; stale locks require operator recovery. */
export type HeartbeatWriteOptions = {
	root: string;
	path: string;
	legacyWritersQuiescent: true;
	expectedContentHash: string;
	/** Optional deterministic fault hook, invoked after durable history commit. */
	beforeHeadPublish?: () => void;
};
export function migrateHeartbeatLedgerPair(
	options: HeartbeatWriteOptions,
): HeartbeatLedgerPair;
/** Validate in memory before creating any ledger files. The parent directory must exist.
 * Requires absent head/history/backup entries; never overwrites a ledger. */
export function createHeartbeatLedgerPair(
	options: Omit<HeartbeatWriteOptions, "expectedContentHash"> & {
		text: string;
		orchestration?: HeartbeatOrchestration;
	},
): HeartbeatLedgerPair;
export function writeHeartbeatLedgerPair(
	options: HeartbeatWriteOptions & {
		text: string;
		orchestration?: HeartbeatOrchestration;
	},
): HeartbeatLedgerPair;
export function appendHeartbeatWake(
	options: HeartbeatWriteOptions & {
		wakeText: string;
		orchestration?: HeartbeatOrchestration;
	},
): HeartbeatLedgerPair;

export interface HeartbeatAgentAssignment {
	itemId: string;
	/** Exact native thread ID observed in the original host dispatch result. */
	agentThreadId: string;
	/** Exact current cell value, including `""`, `"-"` or `"—"`. This is a version precondition. */
	expectedDispatchRef: string;
	/** Required to replace a different existing native thread ID. */
	expectedAgentThreadId?: string;
}
/** Record verified assignments to existing canonical leaf Items. The authorized source writer
 * must verify the Item-to-thread mapping against the original dispatch records before calling.
 * The pair must have no unarchived head suffix. */
export function recordHeartbeatAgentAssignments(
	options: HeartbeatWriteOptions & { assignments: readonly HeartbeatAgentAssignment[] },
): HeartbeatLedgerPair;

/** Read a raw version even when a pair is incomplete; never mutates the files. */
export function readHeartbeatLedgerPairVersion(options: {
	root: string;
	path: string;
}): { contentHash: string };
/** Complete a verified pending publication while preserving ownership and version checks. */
export function recoverHeartbeatLedgerPair(
	options: HeartbeatWriteOptions,
): HeartbeatLedgerPair;

/** Discard reconstructible indexes. The authenticated source remains authoritative. */
export function clearHeartbeatDisplayCache(): void;
export interface HeartbeatDisplayResult {
	/** On large heads this is a bounded structural projection retaining physical line numbers. */
	headText: string;
	headProjected: boolean;
	customChecks: "not-performed" | "as-configured";
	/** Bytes omitted only from recognized non-progress write_set cells. */
	omittedMetadataFields: Array<{
		line: number;
		column: "write_set";
		bytes: number;
	}>;
	headDigest: string;
	contentHash: string;
	integrity: "verified";
	audit: "not-performed";
	cadence: HeartbeatAuditDueResult | null;
	inventory: HeartbeatPairInspectionReport;
	latestWake: HeartbeatPairInspectionReport["wakes"][number] | null;
	historyPage: {
		wakes: HeartbeatPairInspectionReport["wakes"];
		nextCursor: string | null;
		total: number;
	};
	headPath: string;
	historyPath: string;
	isLegacy: boolean;
	modifiedAt: string;
	lastRecordedAt: string | null;
}
/** Bounded head-only discovery; does not validate the pair or perform an audit. */
export function readHeartbeatDiscoveryHead(options: {
	root: string;
	path: string;
	onRead?: (read: { path: string; bytes: number; position: number }) => void;
}): Promise<{
	headText: string;
	headDigest: string;
	headProjected: boolean;
	omittedMetadataFields: Array<{
		line: number;
		column: "write_set";
		bytes: number;
	}>;
}>;
/** Read-only bounded display. Does not perform or certify a full business audit.
 * Cursors are valid only for the exact source content and file identity.
 * Changed sources and stale cursors use HEARTBEAT_DISPLAY_CHANGED and
 * HEARTBEAT_DISPLAY_CURSOR_STALE error codes respectively. */
export function readHeartbeatDisplay(options: {
	root: string;
	path: string;
	cursor?: string;
	pageSize?: number;
	now?: Date;
	intervalMinutes?: number;
	/** On large heads explicitly use canonical structural Items validation; custom checks are not performed. */
	canonicalDisplayOnly?: boolean;
	/** Custom items inspector; integrity validation remains in the core reader. */
	inspect?: (
		text: string,
		options: InspectHeartbeatLedgerOptions,
	) => HeartbeatInspectionReport;
	/** Optional read-observation hook, for diagnostics and deterministic tests. */
	onRead?: (read: { path: string; bytes: number; position: number }) => void;
}): Promise<HeartbeatDisplayResult>;
