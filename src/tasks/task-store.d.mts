import type {
	TaskProgressSchemas,
	TaskState,
	TaskInitializeInput,
	TaskUpdateInput,
	TaskRescopeInput,
	TaskMutationResult,
	TaskHistoryPage,
	TaskHistorySummaryPage,
} from "./task-contract.mjs";
export class TaskStoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string);
}
/** Serializes writers within the process; the caller must ensure a single writer process. */
export class TaskStore {
	readonly root: string;
	constructor(root: string, options: { schemas: TaskProgressSchemas });
	get(threadId: string): Promise<TaskState | null>;
	/** Imports prefix-compatible history without modifying the source. */
	importFrom(
		threadId: string,
		sourceDirectory: string,
		options?: { includeBindings?: boolean },
	): Promise<{
		migrated: boolean;
		importedEvents: number;
		partialTail: boolean;
	}>;
	initialize(
		threadId: string,
		value: TaskInitializeInput,
	): Promise<TaskMutationResult>;
	update(threadId: string, value: TaskUpdateInput): Promise<TaskMutationResult>;
	rescope(
		threadId: string,
		value: TaskRescopeInput,
	): Promise<TaskMutationResult>;
	/** Summary pages contain no snapshots, cap reasons at 512 characters and fit within 512 KiB.
	 * canonicalHistoryPath and revision identify the unchanged full records. */
	history(
		threadId: string,
		options: { cursor?: string; limit?: number; projection: "summary" },
	): Promise<TaskHistorySummaryPage>;
	history(
		threadId: string,
		options?: { cursor?: string; limit?: number; projection?: "raw" },
	): Promise<TaskHistoryPage>;
}
export function taskMarkdownPaths(
	root: string,
	threadId: string,
): {
	directory: string;
	heartbeat: string;
	history: string;
	legacyEvents: string;
	legacySnapshot: string;
};
/** Internal dependency-free corruption guard shared by task history writers. */
export function validateTaskEventStructure(event: unknown): boolean;
