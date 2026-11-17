import type { z } from "zod";
export type TaskStatus = "pending" | "active" | "completed" | "blocked" | "cancelled";
export interface TaskEvidence {
	summary: string;
	verification: "reported" | "verified";
	kind?: string;
	reference?: string;
}
export interface TaskAgent {
	threadId: string;
	path?: string;
}
export interface TaskItem {
	id: string;
	title: string;
	status: TaskStatus;
	evidence: TaskEvidence[];
	agent?: TaskAgent | null;
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
	itemOwners?: Record<string, { owner?: string; agentThreadId?: string }>;
}
export interface TaskStateFields {
	kind: "task";
	threadId: string;
	title: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	objectives: TaskObjective[];
	progress: TaskProgress;
	phase: "active" | "completed";
}
export type TaskState =
	| (TaskStateFields & { schemaVersion: 3 })
	| (TaskStateFields & {
			schemaVersion: 4;
			lifecycle: TaskLifecycle;
	  });
export interface TaskDeliveryCheck {
	status: "done" | "not-applicable";
	evidence: TaskEvidence[];
}
export interface TaskCloseoutReceipt {
	branch: TaskDeliveryCheck;
	merge: TaskDeliveryCheck;
	push: TaskDeliveryCheck;
	remainingWork: 0;
	ownerActions: 0;
	auditEvidence: TaskEvidence[];
}
export interface TaskLifecycle {
	id: string;
	sequence: number;
	startedAt: string;
	completion: null | {
		completedAt: string;
		receipt: TaskCloseoutReceipt;
	};
}
export interface TaskCompleteInput {
	requestId: string;
	expectedRevision: number;
	reason: string;
	closeout: TaskCloseoutReceipt;
}
export interface TaskArchiveInput {
	taskId?: string;
	cursor?: string;
	limit?: number;
}
export interface TaskArchiveSummary {
	id: string;
	title: string;
	completedAt: string;
	completionRevision: number;
	progress: TaskProgress;
	objectiveCount: number;
	itemCount: number;
}
export interface TaskArchiveNode {
	id: string;
	title: string;
	status: TaskStatus;
	kind: "objective" | "item";
	parentId?: string;
	required?: boolean;
}
export interface TaskArchiveTasksPage {
	kind: "tasks";
	tasks: TaskArchiveSummary[];
	total: number;
	nextCursor: string | null;
	currentTaskId: string | null;
}
export interface TaskArchiveSubtasksPage {
	kind: "subtasks";
	task: TaskArchiveSummary;
	nodes: TaskArchiveNode[];
	totalNodes: number;
	nextCursor: string | null;
	currentTaskId: string | null;
}
export type TaskArchivePage = TaskArchiveTasksPage | TaskArchiveSubtasksPage;
export type TaskItemInput = Omit<TaskItem, "status" | "evidence"> &
	Partial<Pick<TaskItem, "status" | "evidence">>;
export type TaskObjectiveInput = TaskItemInput & {
	required?: boolean;
	items?: TaskItemInput[];
};
export interface TaskInitializeInput {
	lifecycle?: true;
	requestId: string;
	expectedRevision: 0;
	reason: string;
	title: string;
	objectives: TaskObjectiveInput[];
}
export interface TaskUpdateInput {
	lifecycle?: true;
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
	lifecycle?: true;
	requestId: string;
	expectedRevision: number;
	reason: string;
	title?: string;
	objectives: TaskObjectiveInput[];
}
export interface TaskEvent {
	schemaVersion: 3 | 4;
	kind: "task.initialized" | "task.updated" | "task.rescoped" | "task.completed";
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
/** Bounded presentation of an event; the complete record stays in the journal. */
export interface TaskHistorySummary {
	revision: number;
	kind: TaskEvent["kind"];
	occurredAt: string;
	reason: string;
	reasonTruncated: boolean;
	before: TaskProgress | null;
	after: TaskProgress;
}
export interface TaskHistorySummaryPage {
	events: TaskHistorySummary[];
	nextCursor: string | null;
	canonicalHistoryPath: string;
}
export interface TaskProgressSchemas {
	TaskStatusSchema: z.ZodType<TaskStatus>;
	TaskEvidenceSchema: z.ZodType<TaskEvidence>;
	TaskItemSchema: z.ZodType<TaskItem>;
	TaskObjectiveSchema: z.ZodType<TaskObjective>;
	TaskObjectivesSchema: z.ZodType<TaskObjective[]>;
	TaskCloseoutSchema: z.ZodType<TaskCloseoutReceipt>;
	TaskCompleteInputSchema: z.ZodObject<{
		requestId: z.ZodString;
		expectedRevision: z.ZodNumber;
		reason: z.ZodString;
		closeout: z.ZodType<TaskCloseoutReceipt>;
	}>;
	TaskArchiveInputSchema: z.ZodObject<{
		taskId: z.ZodOptional<z.ZodString>;
		cursor: z.ZodOptional<z.ZodString>;
		limit: z.ZodOptional<z.ZodNumber>;
	}>;
	TaskInitializeInputSchema: z.ZodObject<{
		lifecycle: z.ZodOptional<z.ZodLiteral<true>>;
		requestId: z.ZodString;
		expectedRevision: z.ZodLiteral<0>;
		reason: z.ZodString;
		title: z.ZodString;
		objectives: z.ZodType<TaskObjective[]>;
	}>;
	TaskUpdateInputSchema: z.ZodObject<{
		lifecycle: z.ZodOptional<z.ZodLiteral<true>>;
		requestId: z.ZodString;
		expectedRevision: z.ZodNumber;
		reason: z.ZodString;
		changes: z.ZodType<TaskUpdateInput["changes"]>;
	}>;
	TaskRescopeInputSchema: z.ZodObject<{
		lifecycle: z.ZodOptional<z.ZodLiteral<true>>;
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
export function createTaskProgressSchemas(factory: typeof z): TaskProgressSchemas;
export function calculateTaskProgress(objectives: readonly TaskObjective[]): TaskProgress;

export function calculateTaskLifecycleProgress(
	objectives: readonly TaskObjective[],
	complete: boolean,
): TaskProgress;
export function getTaskArchiveCount(task: TaskState | null): number;
export function isTaskLifecycleComplete(task: TaskState | null): boolean;
export function hasOpenTaskWork(objectives: readonly TaskObjective[]): boolean;
