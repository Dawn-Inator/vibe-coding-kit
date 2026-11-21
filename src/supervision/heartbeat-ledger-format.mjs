// Publication validation deliberately excludes current-audit governance. A readable registry may
// still contain honestly pending work, stale evidence, or an audit that is not yet complete.
import {
  checkItems, findStrayItemRows, itemKind, ownerFindings, parseItems, parseItemTables,
  parseWakes, WAKE_HEADING_RE,
} from './check-heartbeat-ledger.mjs';

const ITEMS_HEADING_RE = /^#{1,6}\s+Items\s*$/i;
const REQUIRED_ITEM_COLUMNS = ['id', 'source', 'item', 'status', 'evidence'];
const ITEM_FORMAT_RULES = new Set([
  'items-empty', 'item-id', 'item-source', 'item-ready', 'item-done-evidence',
  'item-blocked', 'item-deferred', 'item-deferred-owner', 'item-deferred-evidence',
  'item-owner-category', 'item-owner-authorization-note', 'item-outside-table',
]);
const cellsOf = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
const normalizeHeader = (cell) => cell.toLowerCase().replace(/[ -]+/g, '_');
const fullRow = (line) => /^\|.*\|\s*$/.test(line.trim());

function checkItemTableShape(text, findings) {
  const lines = text.split('\n');
  const headings = lines.flatMap((line, index) => ITEMS_HEADING_RE.test(line) ? [index] : []);
  const add = (rule, line, detail) => findings.push({ rule, message: `Items (line ${line}): ${detail}` });
  if (!headings.length) return false;
  if (headings.length !== 1) {
    add('items-table-count', headings[1] + 1, 'exactly one Items registry is permitted');
    return true;
  }
  let headerIndex = headings[0] + 1;
  while (headerIndex < lines.length && !lines[headerIndex].trim()) headerIndex += 1;
  if (!fullRow(lines[headerIndex] ?? '')) {
    add('items-header', headerIndex + 1, 'a complete pipe-delimited header must follow the Items heading');
    return true;
  }
  const headers = cellsOf(lines[headerIndex]).map(normalizeHeader);
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    add('items-header', headerIndex + 1, 'column names must be nonblank and unique after normalization');
  }
  const missing = REQUIRED_ITEM_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) add('items-header', headerIndex + 1, `missing required columns: ${missing.join(', ')}`);
  const separator = lines[headerIndex + 1] ?? '';
  if (!fullRow(separator) || cellsOf(separator).length !== headers.length || cellsOf(separator).some((cell) => !/^:?-{2,}:?$/.test(cell))) {
    add('items-separator', headerIndex + 2, 'separator must have one Markdown separator cell per header column');
    return true;
  }
  let inTable = true;
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line)) break;
    if (!/^\s*\|/.test(line)) {
      inTable = false;
      continue;
    }
    if (!fullRow(line) || cellsOf(line).length !== headers.length) {
      add('items-row-shape', index + 1, 'each registry row must be closed and have exactly one cell per header column');
    } else if (!inTable) {
      add('item-outside-table', index + 1, 'registry rows must be contiguous with the header and separator');
    }
  }
  return true;
}

function withoutFencedExamples(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    return fence === null ? line : '';
  }).join('\n');
}

function checkTaskStructure(text, rows, findings) {
  const add = (rule, row, detail) => findings.push({ rule, message: `item ${row.id || '(no id)'} (line ${row.line ?? '?'}): ${detail}` });
  for (const row of rows) {
    const raw = String(row.children ?? '').trim();
    if (!raw || raw === '-') continue;
    let children;
    try { children = JSON.parse(raw); } catch { children = null; }
    if (!Array.isArray(children) || children.some((child) => typeof child !== 'string' || !child.trim())) {
      add('item-children-json', row, 'children must be a JSON array of nonblank child IDs');
    } else if (!/^tracking\b/i.test(row.status.trim()) && children.length) {
      add('item-children-kind', row, 'only tracking rows may declare child IDs');
    }
  }
  const declarations = withoutFencedExamples(text).split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*task_root(?:\s|:|$)/i.test(line));
  if (!declarations.length) return;
  if (declarations.length !== 1) {
    findings.push({ rule: 'task-root', message: 'task_root must be declared exactly once' });
    return;
  }
  const { line, index } = declarations[0];
  const match = /^\s*task_root\s*:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$/i.exec(line);
  if (!match) {
    findings.push({ rule: 'task-root', message: `task_root (line ${index + 1}) must name a valid nonblank Items ID` });
    return;
  }
  const root = rows.find((row) => row.id.trim() === match[1]);
  if (!root || !/^tracking\b/i.test(root.status.trim())) {
    findings.push({ rule: 'task-root', message: `task_root ${match[1]} must name an existing tracking Items row` });
  }
}

/** Check prospective source-head syntax without certifying the current supervision audit. */
export function checkHeartbeatLedgerFormat(text, { now = new Date() } = {}) {
  const findings = [];
  const hasItems = checkItemTableShape(text, findings);
  const { rows } = parseItems(text);
  if (hasItems) {
    for (const finding of checkItems(text, { now })) {
      if (ITEM_FORMAT_RULES.has(finding.rule) || finding.rule.startsWith('tracking-')) findings.push(finding);
    }
    // Unknown is an honest pending value. Other unrecognized spellings are publication errors.
    for (const row of rows) if (itemKind(row.status, row.owner) === 'unknown' && !/^unknown$/i.test(row.status.trim())) {
      findings.push({ rule: 'item-status', message: `item ${row.id || '(no id)'} (line ${row.line}): unrecognized status "${row.status}"; use an explicit supported state or unknown` });
    }
    findings.push(...ownerFindings(parseItemTables(text)));
  } else {
    for (const stray of findStrayItemRows(text, rows)) {
      findings.push({ rule: 'item-outside-table', message: `item ${stray.id || '(no id)'} (line ${stray.line}): registry rows require an Items table` });
    }
  }
  checkTaskStructure(text, rows, findings);
  const wakes = parseWakes(text);
  const orchestrationLines = new Set();
  for (const wake of wakes) {
    wake.sectionLines.forEach((line, index) => {
      if (/^\s*orchestration\s*:/i.test(line)) orchestrationLines.add(wake.line + index);
    });
    if (!wake.headingOk || wake.timeMs === null) findings.push({ rule: 'heading-time', message: `${wake.heading} (line ${wake.line}): wake heading must contain a valid ISO time` });
    if (wake.orchestrationError) findings.push({ rule: 'orchestration-metadata', message: `${wake.heading} (line ${wake.line}): ${wake.orchestrationError}` });
  }
  text.split('\n').forEach((line, index) => {
    if (/^#{1,6}\s+.*\bwake\s*\(/i.test(line) && !WAKE_HEADING_RE.test(line)) {
      findings.push({ rule: 'wake-heading', message: `line ${index + 1}: wake heading must declare an 8-row or 10-row ledger` });
    }
    if (/^\s*orchestration\s*:/i.test(line) && !orchestrationLines.has(index)) {
      findings.push({ rule: 'orchestration-metadata', message: `line ${index + 1}: orchestration metadata must belong to a recognized wake section` });
    }
  });
  return findings;
}
