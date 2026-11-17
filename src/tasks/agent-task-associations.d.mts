import type { TaskProgress, TaskState, TaskSource } from "./task-contract.mjs";

export interface CurrentAgent { threadId: string; path?: string }
export interface AgentTaskProgress {
	threadId: string;
	progress: TaskProgress | null;
	basis: "assigned-canonical-leaves" | null;
	assignedTaskIds: string[];
	assignmentTitle: string | null;
	granularity: "none" | "single-item" | "checklist";
}
/** Caller verifies current membership and source path/hash freshness. */
export function projectAgentTaskProgress(options: {
	task: TaskState & { source?: TaskSource };
	agents: readonly CurrentAgent[];
}): AgentTaskProgress[];
