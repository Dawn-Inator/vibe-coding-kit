export type TaskSourceBinding = {
	path: string;
	origin: "automatic" | "explicit";
};
export class TaskSourceRelations {
	constructor(
		root: string,
		options?: {
			legacyHeartbeatRoots?: string[];
			beforeWrite?: () => Promise<void>;
		},
	);
	get(
		threadId: string,
	): Promise<{ found: boolean; binding: TaskSourceBinding | null }>;
	set(
		threadId: string,
		binding: TaskSourceBinding | null,
	): Promise<{ found: boolean; binding: TaskSourceBinding | null }>;
	resolve(
		threadId: string,
		options: {
			projectRoot: string;
			discovery: {
				complete: boolean;
				candidates: { path: string; associated: boolean }[];
			};
		},
	): Promise<{
		status: "ready" | "stale" | "none" | "pending-selection" | "candidates";
		binding: TaskSourceBinding | null;
		error?: string;
	}>;
}
