import type {
	TaskProgressSchemas,
	TaskState,
	TaskInitializeInput,
	TaskUpdateInput,
	TaskRescopeInput,
	TaskMutationResult,
	TaskHistoryPage,
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
	initialize(
		threadId: string,
		value: TaskInitializeInput,
	): Promise<TaskMutationResult>;
	update(threadId: string, value: TaskUpdateInput): Promise<TaskMutationResult>;
	rescope(
		threadId: string,
		value: TaskRescopeInput,
	): Promise<TaskMutationResult>;
	history(
		threadId: string,
		options?: { cursor?: string; limit?: number },
	): Promise<TaskHistoryPage>;
}
