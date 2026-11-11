// Advisory cadence inspection. A full parsed ten-row wake is an attempted audit even
// when its heartbeat/v2 metadata is red; certification remains the API's separate job.
import { parseWakes } from './check-heartbeat-ledger.mjs';

const TEN_ROW_NUMBERS = Array.from({ length: 10 }, (_, index) => index + 1);
const ISO_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** Strict ISO calendar parser shared by ledger and CLI timestamp handling. */
export function parseStrictIsoTimestamp(value, { requireTimezone = false } = {}) {
  if (typeof value !== 'string') return null;
  const match = value.match(ISO_DATE_TIME_RE);
  if (!match || (requireTimezone && !match[8])) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', fractionText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return null;
  const normalizedTimezone = timezone?.toUpperCase() ?? 'Z';
  const normalized = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${fractionText ? `.${fractionText}` : ''}${normalizedTimezone}`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

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
  const rawTimestamp = wake.heading.replace(/^#{1,6}\s+/, '').trim().split(/\s+/, 1)[0];
  const strictTimestamp = parseStrictIsoTimestamp(rawTimestamp);
  if (strictTimestamp === null || !Number.isFinite(wake.timeMs) || strictTimestamp !== wake.timeMs) {
    return { ...common, due: true, lastAuditAt: null, nextDueAt: null, reason: 'invalid-audit-timestamp', line: wake.line };
  }

  const lastAuditAt = new Date(strictTimestamp).toISOString();
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
