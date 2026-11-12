import type { HeartbeatInspectionMode, HeartbeatInspectionReport, HeartbeatItem, HeartbeatItemTable, HeartbeatLedgerRow, HeartbeatWake, InspectHeartbeatLedgerOptions } from './heartbeat-ledger-api.mjs';

export interface HeartbeatLedgerPair {
	headText: string;
	historyText: string;
	fullText: string;
	contentHash: string;
	modifiedAt: string;
	headPath: string;
	historyPath: string;
	isLegacy: boolean;
	wakes: Array<{ text: string; sourcePath: string; sourceLine?: number; heading?: string }>;
}
export type HeartbeatPairInspectionReport = Omit<HeartbeatInspectionReport, "wakes" | "items" | "tables"> & {
	wakes: Array<Omit<HeartbeatWake, "rows"> & { sourcePath: string; sourceLine: number; logicalLine: number; rows: Array<HeartbeatLedgerRow & { sourcePath: string; sourceLine: number; logicalLine: number }> }>;
	items: Array<HeartbeatItem & { sourcePath: string; sourceLine: number }>;
	tables: Array<Omit<HeartbeatItemTable, "rows"> & { rows: Array<HeartbeatItem & { sourcePath: string; sourceLine: number }> }>;
};

export function heartbeatLedgerPairPaths(path: string): {
	headPath: string;
	historyPath: string;
	legacyBackupPath: string;
};
export function readHeartbeatLedgerPair(options: { root: string; path: string; migrate?: false }): HeartbeatLedgerPair;
export function inspectHeartbeatLedgerPair(pair: HeartbeatLedgerPair, options?: InspectHeartbeatLedgerOptions & { mode?: HeartbeatInspectionMode; inspect?: (text: string, options: InspectHeartbeatLedgerOptions) => HeartbeatInspectionReport }): HeartbeatPairInspectionReport;
export function migrateHeartbeatLedgerPair(options: { root: string; path: string }): HeartbeatLedgerPair;
export function writeHeartbeatLedgerPair(options: { root: string; path: string; text: string }): HeartbeatLedgerPair;
export function appendHeartbeatWake(options: { root: string; path: string; wakeText: string }): HeartbeatLedgerPair;
