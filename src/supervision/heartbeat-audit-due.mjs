// Advisory cadence inspection. A full parsed ten-row wake is an attempted audit even
// when its heartbeat/v2 metadata is red; certification remains the API's separate job.
import { parseWakes } from './check-heartbeat-ledger.mjs';

const TEN_ROW_NUMBERS = Array.from({ length: 10 }, (_, index) => index + 1);

function isFullTenRowWake(wake) {
  if (wake.layout.count !== 10 || wake.rows.length !== TEN_ROW_NUMBERS.length) return false;
  const rowNumbers = new Set(wake.rows.map((row) => row.num));
  return rowNumbers.size === TEN_ROW_NUMBERS.length && TEN_ROW_NUMBERS.every((number) => rowNumbers.has(number));
}

/**
 * Return whether a full ten-row heartbeat audit is due. Legacy ten-row headings
 * count for cadence regardless of heartbeat/v2 certification; this does not grant
 * v2 certification or waive its metadata requirements.
 * @param {string} text Markdown ledger contents.
 * @param {{now?: Date, intervalMinutes?: number}} options
 */
export function heartbeatAuditDue(text, { now = new Date(), intervalMinutes = 20 } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new TypeError('intervalMinutes must be a finite number greater than 0');
  }

  const intervalMs = intervalMinutes * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs > 8.64e15) throw new TypeError('intervalMinutes is too large');
  const wake = parseWakes(text).filter(isFullTenRowWake).at(-1);
  const common = { schemaVersion: 1, intervalMinutes };
  if (!wake) {
    return { ...common, due: true, lastAuditAt: null, nextDueAt: null, reason: 'no-full-ten-row-audit' };
  }
  if (!Number.isFinite(wake.timeMs)) {
    return { ...common, due: true, lastAuditAt: null, nextDueAt: null, reason: 'invalid-audit-timestamp', line: wake.line };
  }

  const lastAuditAt = new Date(wake.timeMs).toISOString();
  if (wake.timeMs > now.getTime()) {
    return { ...common, due: true, lastAuditAt, nextDueAt: null, reason: 'future-audit-timestamp', line: wake.line };
  }
  const nextDueMs = wake.timeMs + intervalMs;
  if (!Number.isFinite(nextDueMs) || !Number.isFinite(new Date(nextDueMs).getTime())) {
    throw new TypeError('intervalMinutes produces an out-of-range due date');
  }
  const nextDueAt = new Date(nextDueMs).toISOString();
  const due = now.getTime() >= nextDueMs;
  return {
    ...common,
    due,
    lastAuditAt,
    nextDueAt,
    reason: due ? 'interval-elapsed' : 'interval-not-elapsed',
    line: wake.line,
  };
}
