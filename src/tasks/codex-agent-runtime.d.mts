export interface CodexAgentObservation {
  state: 'working' | 'completed' | 'idle' | 'failed' | 'unknown';
  basis: 'codex-rollout';
  observedAt: string | null;
  eventTurnId: string | null;
  rootTurnId?: string;
  eventType: 'task_started' | 'task_complete' | 'turn_aborted' | null;
  complete: boolean;
  readStable: boolean;
  reason: string | null;
  tailTruncated?: boolean;
}
export function readCodexAgentObservation(options: {
  path: string;
  trustedRoot: string;
  threadId: string;
  cwd: string;
  parentThreadId: string;
  turnId: string;
  rootTurnId: string;
  turnStartedAt: string;
  maxBytes?: number;
  maxLineBytes?: number;
  onRead?: (event: { phase: 'opened' | 'scanned'; attempt: number }) => void | Promise<void>;
}): Promise<CodexAgentObservation>;
