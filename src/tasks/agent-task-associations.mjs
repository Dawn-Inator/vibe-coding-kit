import { calculateTaskProgress } from "./task-contract.mjs";

/**
 * Associate canonical progress leaves with current verified members. The caller must
 * establish membership and source freshness; this function never reads lifecycle
 * state or infers completion from agent activity. Null means no known assignment.
 */
export function projectAgentTaskProgress({ task, agents }) {
	if (!task || !Array.isArray(task.objectives) || !Array.isArray(agents))
		throw new TypeError("A task and current agents are required");
	const byId = new Map();
	const byPath = new Map();
	for (const agent of agents) {
		if (typeof agent.threadId !== "string" || !agent.threadId.trim())
			throw new TypeError("Each current agent requires a threadId");
		const ids = byId.get(agent.threadId) ?? [];
		ids.push(agent);
		byId.set(agent.threadId, ids);
		if (typeof agent.path === "string" && agent.path) {
			const paths = byPath.get(agent.path) ?? [];
			paths.push(agent);
			byPath.set(agent.path, paths);
		}
	}
	const leaves = new Map();
	for (const objective of task.objectives) {
		if (!objective.required || objective.status === "cancelled") continue;
		for (const item of objective.items.length ? objective.items : [objective]) {
			if (item.status !== "cancelled" && !leaves.has(item.id)) {
				// Only canonical assignment metadata inherits. Heartbeat row owners
				// belong to each source leaf and must not roll down from a parent.
				const agent = item.agent !== undefined ? item.agent : objective.agent;
				leaves.set(item.id, { item, agent, objective });
			}
		}
	}
	const owned = new Map();
	for (const [id, { item, agent, objective }] of leaves) {
		const source = agent === undefined ? task.source?.itemOwners?.[id] : undefined;
		const identity = agent?.threadId ?? source?.agentThreadId;
		const path = agent?.path ?? source?.owner;
		let member;
		if (identity) {
			const candidates = byId.get(identity);
			if (candidates?.length !== 1) continue;
			member = candidates[0];
			// An explicit ID is authoritative, but a contradictory path/owner
			// invalidates the association instead of falling back to another agent.
			if (path && path !== member.threadId &&
				(path !== member.path || byPath.get(path)?.length !== 1)) continue;
		} else if (path) {
			const candidates = byPath.get(path);
			if (candidates?.length !== 1 || candidates[0].allowPathOnlyAssignment === false || byId.get(candidates[0].threadId)?.length !== 1) continue;
			member = candidates[0];
		} else continue;
		const entries = owned.get(member.threadId) ?? [];
		entries.push({ item, objective });
		owned.set(member.threadId, entries);
	}
	return agents.map((agent) => {
		const entries = byId.get(agent.threadId).length === 1 ? owned.get(agent.threadId) : undefined;
		const commonObjective = entries?.length > 1 && entries.every((entry) => entry.objective.id === entries[0].objective.id);
		const rawTitle = entries?.length === 1 ? entries[0].item.title : commonObjective ? entries[0].objective.title : null;
		// Reject path-like labels rather than exposing source or filesystem locations in cards.
		const title = typeof rawTitle === "string" && !/(?:^|[\s(])(?:\/|~\/|[A-Za-z]:\\|file:\/\/)[^\s]+|^\S+\.(?:md|json|jsonl|ya?ml|tsx?|jsx?|py|mjs)$/i.test(rawTitle.trim())
			? rawTitle.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 400).trim() || null
			: null;
		return {
			threadId: agent.threadId,
			progress: entries?.length ? calculateTaskProgress(entries.map(({ item }) => ({ ...item, required: true, items: [] }))) : null,
			basis: entries?.length ? "assigned-canonical-leaves" : null,
			assignedTaskIds: entries?.map(({ item }) => item.id) ?? [],
			assignmentTitle: title,
			granularity: !entries?.length ? "none" : entries.length === 1 ? "single-item" : "checklist",
		};
	});
}
