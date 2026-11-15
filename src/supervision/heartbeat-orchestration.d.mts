import type { HeartbeatOrchestration, HeartbeatOrchestrationProjection } from './heartbeat-ledger-api.mjs';
export function validateHeartbeatOrchestration(value: HeartbeatOrchestration): HeartbeatOrchestration;
export function parseHeartbeatOrchestrationLines(lines: string[]): { orchestration: HeartbeatOrchestration | null; orchestrationError: string | null };
export function projectHeartbeatOrchestration(snapshot: HeartbeatOrchestration, options?: { maxBlockedPreview?: number }): HeartbeatOrchestrationProjection;
export function projectHeartbeatOrchestration(snapshot: null | undefined, options?: { maxBlockedPreview?: number }): null;
