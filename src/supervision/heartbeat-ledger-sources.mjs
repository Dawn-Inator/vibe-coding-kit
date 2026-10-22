// Grading of the per-wake `sources:` line (graded under `check-heartbeat-ledger --latest`).
//
//   sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume)
//            external-backlog(✓ <timestamp>|blocked ← <reason>) worker-health(✓)
//
// Every channel must be present and marked checked. The external backlog (a bug tracker, an issue queue)
// has a cadence: it is read at session start and at least every 6 hours, so its token carries the time it
// was read; when it cannot be read the token says `blocked ← <reason>` AND the Items registry holds an
// `owner ←` row naming the blocker. Nothing here names a particular tracker.

export const REQUIRED_SOURCES = ['sweep', 'landings', 'reports', 'drift-matrix', 'memory/handoff', 'worker-health'];
export const EXTERNAL_BACKLOG = 'external-backlog';
export const BACKLOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const TOKEN_RE = /([\w./:-]+)\(([^)]*)\)/g;
const CHECKED_RE = /^(?:✓|ok\b)/i;
const BLOCKED_RE = /^blocked\s*(?:←|<-)\s*(\S.*)$/i;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/;

export function parseSourceTokens(text) {
  const tokens = new Map();
  for (const match of text.matchAll(TOKEN_RE)) tokens.set(match[1].toLowerCase(), match[2].trim());
  return tokens;
}

// `2026-01-01T10:00` with no zone is read as UTC, the way the heartbeat headings are written.
export function parseIsoMs(text) {
  const found = text?.match(TIMESTAMP_RE)?.[0];
  if (!found) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(found) ? found : `${found}Z`);
  return Number.isNaN(ms) ? null : ms;
}

// An `owner ←` registry row that names the external backlog (the token's own name, or the words
// "external backlog"); `ownerRows` are parsed registry rows with `status`, `item`, `evidence`.
export function hasBacklogOwnerItem(ownerRows, backlogName) {
  const needles = ['external-backlog', 'external backlog'];
  if (backlogName) needles.push(backlogName.toLowerCase());
  return ownerRows.some((row) => {
    const haystack = `${row.item} ${row.status} ${row.evidence}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

// Returns [{ rule, message }] for one wake. `wakeMs` is the wake heading time (null when unparseable).
export function gradeSources(sourcesLine, { wakeMs, ownerRows }) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });
  const body = sourcesLine.replace(/^\s*sources:\s*/i, '');
  const tokens = parseSourceTokens(body);
  let backlogKey = null;
  for (const key of tokens.keys()) {
    if (key === EXTERNAL_BACKLOG || key.startsWith(`${EXTERNAL_BACKLOG}:`)) backlogKey = key;
  }
  const missing = REQUIRED_SOURCES.filter((key) => !tokens.has(key));
  if (!backlogKey) missing.push(EXTERNAL_BACKLOG);
  if (missing.length > 0) add('sources-incomplete', `"sources:" is missing channel(s): ${missing.join(', ')}; got "${sourcesLine.trim()}"`);

  for (const key of REQUIRED_SOURCES) {
    if (tokens.has(key) && !CHECKED_RE.test(tokens.get(key))) {
      add('sources-token-unchecked', `${key}(${tokens.get(key)}) must be marked checked, e.g. ${key}(✓)`);
    }
  }
  if (!backlogKey) return findings;

  const value = tokens.get(backlogKey);
  const backlogName = backlogKey.includes(':') ? backlogKey.split(':')[1] : null;
  const blocked = value.match(BLOCKED_RE);
  if (blocked) {
    if (!hasBacklogOwnerItem(ownerRows, backlogName)) {
      add('external-backlog-owner-missing', `${EXTERNAL_BACKLOG} is blocked ← ${blocked[1].trim()} but no "owner ←" row in the "## Items" registry names the blocker (mention "external-backlog" in it)`);
    }
    return findings;
  }
  if (!CHECKED_RE.test(value)) {
    add('external-backlog-format', `${EXTERNAL_BACKLOG} must read "✓ <timestamp>" or "blocked ← <reason>"; got "${value}"`);
    return findings;
  }
  const readMs = parseIsoMs(value);
  if (readMs === null) {
    add('external-backlog-timestamp-missing', `${EXTERNAL_BACKLOG} is marked read but carries no ISO timestamp, so the 6h cadence cannot be verified; got "${value}"`);
  } else if (wakeMs !== null && wakeMs - readMs > BACKLOG_MAX_AGE_MS) {
    add('external-backlog-stale', `${EXTERNAL_BACKLOG} was last read at ${value.match(TIMESTAMP_RE)[0]}, more than 6h before this wake: read it again, or mark it blocked ← <reason> and open an "owner ←" item`);
  }
  return findings;
}
