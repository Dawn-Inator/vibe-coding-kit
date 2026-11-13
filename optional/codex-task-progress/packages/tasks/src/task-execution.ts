/** Runtime observation, independent of model-maintained checklist completion. */
export interface TaskExecution {
  state: "working" | "waiting" | "idle" | "unknown";
  observedAt: string;
  source: "codex-app-server" | "codex-ui";
  activeFlags?: string[];
}

// Verified against the installed Codex CLI's experimental app-server JSON schema.
const WAITING_FLAGS = ["waitingOnApproval", "waitingOnUserInput"] as const;

/**
 * Project only a trusted thread/read status. The caller timestamps its completed read;
 * timestamps or completion claims embedded in status are deliberately ignored.
 * Unknown/future protocol variants and contradictory flags do not establish idleness.
 */
export function projectTaskExecution(
  status: unknown,
  observedAt: Date = new Date(),
): TaskExecution {
  if (!Number.isFinite(observedAt.getTime())) throw new RangeError("Invalid observation time");
  const observation: TaskExecution = {
    state: "unknown",
    observedAt: observedAt.toISOString(),
    source: "codex-app-server",
  };
  if (status === null || typeof status !== "object" || Array.isArray(status)) return observation;
  const record = status as Record<string, unknown>;
  if (record.type === "idle") {
    if (
      record.activeFlags !== undefined &&
      (!Array.isArray(record.activeFlags) || record.activeFlags.length > 0)
    )
      return observation;
    return { ...observation, state: "idle" };
  }
  if (record.type !== "active") return observation;
  const flags = record.activeFlags;
  if (
    !Array.isArray(flags) ||
    flags.length > 16 ||
    flags.some(
      (flag: unknown) => typeof flag !== "string" || !WAITING_FLAGS.some((known) => known === flag),
    )
  )
    return observation;
  const activeFlags = WAITING_FLAGS.filter((flag) => flags.includes(flag));
  return {
    ...observation,
    state: activeFlags.length ? "waiting" : "working",
    activeFlags,
  };
}
