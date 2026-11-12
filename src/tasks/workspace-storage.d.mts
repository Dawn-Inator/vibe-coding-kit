import type { TaskProgressSchemas } from './task-contract.mjs';
import type { TaskStore } from './task-store.mjs';

export interface WorkspaceTaskStorageOptions {
	schemas: TaskProgressSchemas;
	resolveContract?: (canonicalCwd: string) => Promise<{ contract: unknown; source?: string }> | { contract: unknown; source?: string };
}
export interface WorkspaceTaskStorageLocation {
	mode: 'workspace';
	cwd: string;
	root: string;
	taskDirectory: string;
	heartbeatDirectory: string;
	migrated: boolean;
	source?: string;
	contractSource: string;
	taskhistoryPath: string;
	historyPath: string;
	heartbeatPath: string;
	cacheRoot: string;
}
export interface WorkspaceTaskStorageContext {
	taskStore: TaskStore;
	storage: WorkspaceTaskStorageLocation;
	taskhistoryPath: string;
	heartbeatPath: string;
	cacheRoot: string;
	legacyHeartbeatRoots: string[];
	ensureWritable(): Promise<void>;
}
/** Kit-owned workspace route and import/migration adapter. */
export class WorkspaceTaskStorage {
	constructor(legacyAppRoot: string, options: WorkspaceTaskStorageOptions);
	forThread(threadId: string, cwd: string): Promise<WorkspaceTaskStorageContext>;
	close(): void;
}
