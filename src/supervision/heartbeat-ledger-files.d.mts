import type {
	HeartbeatInspectionMode,
	HeartbeatInspectionReport,
	HeartbeatItem,
	HeartbeatItemTable,
	HeartbeatLedgerRow,
	HeartbeatWake,
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
	"wakes" | "items" | "tables"
> & {
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
}): HeartbeatLedgerPair;
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
export function writeHeartbeatLedgerPair(
	options: HeartbeatWriteOptions & { text: string },
): HeartbeatLedgerPair;
export function appendHeartbeatWake(
	options: HeartbeatWriteOptions & { wakeText: string },
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
