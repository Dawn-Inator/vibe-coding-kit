import type { z } from "zod";
export type TaskStatus =
	| "pending"
	| "active"
	| "completed"
	| "blocked"
	| "cancelled";
export interface TaskEvidence {
	summary: string;
	verification: "reported" | "verified";
	kind?: string;
	reference?: string;
}
export interface TaskItem {
	id: string;
	title: string;
	status: TaskStatus;
	evidence: TaskEvidence[];
}
export interface TaskObjective extends TaskItem {
	required: boolean;
	items: TaskItem[];
}
export interface TaskProgress {
	completed: number;
	total: number;
	percent: number | null;
}
export interface TaskSource {
	kind: "kit-heartbeat";
	path: string;
	readOnly: true;
	contentHash: string;
	itemStatuses: Record<string, string>;
}
export interface TaskState {
	schemaVersion: 3;
	kind: "task";
	threadId: string;
	title: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	objectives: TaskObjective[];
	progress: TaskProgress;
	phase: "active" | "completed";
	source?: TaskSource;
}
export type TaskItemInput = Omit<TaskItem, "status" | "evidence"> &
	Partial<Pick<TaskItem, "status" | "evidence">>;
export type TaskObjectiveInput = TaskItemInput & {
	required?: boolean;
	items?: TaskItemInput[];
};
export interface TaskInitializeInput {
	requestId: string;
	expectedRevision: 0;
	reason: string;
	title: string;
	objectives: TaskObjectiveInput[];
}
export interface TaskUpdateInput {
	requestId: string;
	expectedRevision: number;
	reason: string;
	changes: {
		targetId: string;
		status: TaskStatus;
		evidence?: TaskEvidence[];
	}[];
}
export interface TaskRescopeInput {
	requestId: string;
	expectedRevision: number;
	reason: string;
	title?: string;
	objectives: TaskObjectiveInput[];
}
export interface TaskEvent {
	schemaVersion: 3;
	kind: "task.initialized" | "task.updated" | "task.rescoped";
	eventId: string;
	threadId: string;
	requestId: string;
	fingerprint: string;
	revision: number;
	occurredAt: string;
	reason: string;
	before: TaskProgress | null;
	after: TaskProgress;
	state: TaskState;
}
export interface TaskMutationResult {
	state: TaskState;
	duplicate: boolean;
}
export interface TaskHistoryPage {
	events: TaskEvent[];
	nextCursor: string | null;
}
export interface TaskProgressSchemas {
	TaskStatusSchema: z.ZodType<TaskStatus>;
	TaskEvidenceSchema: z.ZodType<TaskEvidence>;
	TaskItemSchema: z.ZodType<TaskItem>;
	TaskObjectiveSchema: z.ZodType<TaskObjective>;
	TaskObjectivesSchema: z.ZodType<TaskObjective[]>;
	TaskInitializeInputSchema: z.ZodObject<{
		requestId: z.ZodString;
		expectedRevision: z.ZodLiteral<0>;
		reason: z.ZodString;
		title: z.ZodString;
		objectives: z.ZodType<TaskObjective[]>;
	}>;
	TaskUpdateInputSchema: z.ZodObject<{
		requestId: z.ZodString;
		expectedRevision: z.ZodNumber;
		reason: z.ZodString;
		changes: z.ZodType<TaskUpdateInput["changes"]>;
	}>;
	TaskRescopeInputSchema: z.ZodObject<{
		requestId: z.ZodString;
		expectedRevision: z.ZodNumber;
		reason: z.ZodString;
		title: z.ZodOptional<z.ZodString>;
		objectives: z.ZodType<TaskObjective[]>;
	}>;
	TaskProgressSchema: z.ZodType<TaskProgress>;
	TaskStateSchema: z.ZodType<TaskState>;
	TaskEventSchema: z.ZodType<TaskEvent>;
}
export function createTaskProgressSchemas(
	factory: typeof z,
): TaskProgressSchemas;
export function calculateTaskProgress(
	objectives: readonly TaskObjective[],
): TaskProgress;
