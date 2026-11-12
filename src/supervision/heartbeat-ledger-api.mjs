// Canonical synchronous API for Kit and consuming projects. Deprecated checker exports remain
// low-level helpers; callers that need an audit report should use this normalized contract.
import { checkItems, checkLedger, findStrayItemRows, ownerFindings, parseItemTables, parseItems, parseWakes } from './check-heartbeat-ledger.mjs';
import { checkHeartbeatV2 } from './heartbeat-ledger-v2.mjs';
import { checkV2Guards } from './heartbeat-ledger-v2-guards.mjs';
export { heartbeatAuditDue } from './heartbeat-audit-due.mjs';

const MODES = new Set(['current', 'history', 'items']);

function normalizeFindings(findings) {
  return findings.map((finding) => ({ ...finding, severity: finding.severity === 'advisory' ? 'advisory' : 'error' }));
}

/**
 * Inspect a heartbeat ledger with one shared report shape.
 * @param {string} text Markdown ledger contents.
 * @param {{mode?: 'current'|'history'|'items', latest?: boolean, now?: Date, ledgerPath?: string, baseDir?: string, extraChecks?: Function|Function[]}} options
 */
export function inspectHeartbeatLedger(text, {
  mode = 'current',
  latest = true,
  now = new Date(),
  ledgerPath,
  baseDir,
  extraChecks = [],
} = {}) {
  if (!MODES.has(mode)) throw new TypeError(`mode must be one of ${[...MODES].join(', ')}; got ${mode}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const wakes = parseWakes(text);
  const items = parseItems(text).rows;
  const tables = parseItemTables(text);
  let rawFindings;

  if (mode === 'current') {
    rawFindings = checkHeartbeatV2(text, { now, ledgerPath, baseDir, extraChecks });
  } else if (mode === 'history') {
    rawFindings = checkLedger(text, { latest, now, ledgerPath, baseDir });
    rawFindings.push(...ownerFindings(tables));
    if (latest) {
      for (const stray of findStrayItemRows(text, items)) {
        rawFindings.push({ rule: 'item-outside-table', message: `item ${stray.id || '(no id)'} (line ${stray.line}): row sits outside the "## Items" table` });
      }
    }
    const latestWake = wakes.at(-1);
    if (latestWake) rawFindings.push(...checkV2Guards({ text, wakes, items, latestWake, now }));
  } else {
    rawFindings = [...checkItems(text, { now }), ...ownerFindings(tables)];
  }

  const findings = normalizeFindings(rawFindings);
  const noErrors = findings.every((finding) => finding.severity !== 'error');
  return {
    schemaVersion: 1,
    mode,
    contract: mode === 'current' ? 'heartbeat/v2' : null,
    certifiesCurrent: mode === 'current' && noErrors,
    passed: noErrors,
    wakeCount: wakes.length,
    itemCount: items.length,
    wakes,
    items,
    tables,
    findings,
  };
}
