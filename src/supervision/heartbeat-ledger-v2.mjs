// Versioned live heartbeat audit. Historical ledger rules stay in check-heartbeat-ledger.mjs;
// this module owns the current-wake contract shared by projects using the starter kit.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { checkItems, checkLedger, parseWakes } from './check-heartbeat-ledger.mjs';
import { checkV2Guards } from './heartbeat-ledger-v2-guards.mjs';

const REQUIRED_ITEM_COLUMNS = ['id', 'source', 'item', 'status', 'evidence', 'owner', 'repository', 'worktree', 'mode', 'write_set', 'dispatch_ref'];
const DECOMP_COLUMNS = ['item', 'next_step', 'disposition', 'owner', 'evidence'];
const DISPOSITIONS = new Set(['dispatched', 'continuing', 'blocked', 'owner', 'done']);
const TOOL_RE = /^(?:collaboration\.spawn_agent|Task|Agent|create_session|[A-Za-z][A-Za-z0-9_.:-]*)$/;

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
const splitTable = (lines, headingIndex) => {
  let h = headingIndex + 1;
  while (h < lines.length && !lines[h].trim()) h += 1;
  if (h >= lines.length || !/^\|.*\|\s*$/.test(lines[h].trim())) return null;
  const headers = cellsOf(lines[h]);
  const s = h + 1;
  if (s >= lines.length || !/^\|\s*:?-{2,}/.test(lines[s].trim())) return null;
  const rows = [];
  let i = s + 1;
  for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i].trim()); i += 1) {
    const values = cellsOf(lines[i]);
    const row = Object.fromEntries(headers.map((key, index) => [norm(key), values[index] ?? '']));
    row.line = i + 1;
    rows.push(row);
  }
  return { headers: headers.map(norm), rows, start: h, end: i };
};

function itemTable(text) {
  const lines = text.split('\n');
  const tables = [];
  let headingCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^#{1,6}\s+Items\s*$/i.test(lines[i])) continue;
    headingCount += 1;
    const table = splitTable(lines, i);
    if (table) tables.push(table);
  }
  if (!tables.length) return null;
  return { ...tables[0], headingCount };
}

function sectionFor(text, wake) {
  const lines = text.split('\n');
  const start = wake.line - 1;
  const level = (lines[start].match(/^#+/)?.[0] ?? '##').length;
  let end = start + 1;
  while (end < lines.length) {
    const nextLevel = lines[end].match(/^(#+)\s/)?.[1].length;
    if (nextLevel && nextLevel <= level) break;
    end += 1;
  }
  return lines.slice(start, end);
}

function findNamedTable(lines, title) {
  const idx = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${title}\\s*$`, 'i').test(line.trim()));
  return idx < 0 ? null : splitTable(lines, idx);
}

function value(row, key) { return String(row?.[key] ?? '').trim(); }
function add(findings, rule, message, severity = 'error') { findings.push({ severity, rule, message }); }

function resolveExistingPrefix(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(cursor), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(cursor, ...suffix);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(root, candidate) { return candidate === root || candidate.startsWith(`${root}${sep}`); }

function validateReceipt(row, options, findings) {
  const owner = value(row, 'owner');
  const ref = value(row, 'dispatch_ref');
  if (!owner) add(findings, 'v2-dispatch-owner', `item ${row.id}: dispatched work needs an owner task/session ID`);
  if (!value(row, 'repository')) add(findings, 'v2-repository', `item ${row.id}: dispatched work needs an explicit repository`);
  if (!value(row, 'worktree')) add(findings, 'v2-worktree', `item ${row.id}: dispatched work needs an explicit worktree`);
  const mode = value(row, 'mode');
  if (!['write', 'read-only'].includes(mode)) add(findings, 'v2-mode', `item ${row.id}: mode must be write or read-only`);
  let paths;
  try {
    paths = JSON.parse(value(row, 'write_set'));
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new Error('expected a JSON array of strings');
  } catch (error) {
    add(findings, 'v2-write-set-json', `item ${row.id}: write_set must be a JSON array of repo-relative file paths (${error.message})`);
    paths = [];
  }
  if (mode === 'write' && paths.length === 0) add(findings, 'v2-write-set-empty', `item ${row.id}: write mode requires a nonempty write_set`);
  if (mode === 'read-only' && paths.length !== 0) add(findings, 'v2-readonly-write-set', `item ${row.id}: read-only mode requires write_set []`);
  const repo = value(row, 'repository');
  const baseDir = options.baseDir || (options.ledgerPath ? dirname(resolve(options.ledgerPath)) : process.cwd());
  const worktree = value(row, 'worktree');
  const worktreeRoot = worktree ? (isAbsolute(worktree) ? worktree : resolve(baseDir, worktree)) : baseDir;
  let canonicalRoot;
  try { canonicalRoot = resolveExistingPrefix(worktreeRoot); }
  catch (error) {
    add(findings, 'v2-worktree-path', `item ${row.id}: cannot resolve declared worktree ${worktree}: ${error.message}`);
    canonicalRoot = resolve(worktreeRoot);
  }
  const canonicalPaths = [];
  for (const rawPath of paths) {
    const path = rawPath.replaceAll('\\', '/');
    const segments = path.split('/').filter((part) => part !== '' && part !== '.');
    const normalizedPath = segments.join('/');
    // Paths are literal repo-relative filenames; square brackets are valid in Next.js dynamic
    // route names such as [locale] and [...slug], and are never expanded as globs here.
    const glob = /[*?{}]/.test(path);
    if (!path || isAbsolute(rawPath) || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || segments.includes('..') || glob || path.endsWith('/')) {
      add(findings, 'v2-write-set-path', `item ${row.id}: write_set path must be an exact repo-relative file path: ${rawPath}`);
      continue;
    }
    const candidate = resolve(worktreeRoot, normalizedPath);
    let canonicalCandidate;
    try { canonicalCandidate = resolveExistingPrefix(candidate); }
    catch (error) {
      add(findings, 'v2-write-set-path', `item ${row.id}: cannot resolve write_set path ${rawPath}: ${error.message}`);
      canonicalPaths.push(normalizedPath);
      continue;
    }
    if (!isWithin(canonicalRoot, canonicalCandidate)) {
      add(findings, 'v2-write-set-escape', `item ${row.id}: write_set path resolves outside its declared worktree: ${rawPath}`);
      canonicalPaths.push(normalizedPath);
      continue;
    }
    // Existing directories are rejected; nonexistent literal file paths are valid for new files.
    if (existsSync(candidate) && statSync(candidate).isDirectory()) add(findings, 'v2-write-set-directory', `item ${row.id}: write_set must name files, not a directory: ${rawPath}`);
    canonicalPaths.push(relative(canonicalRoot, canonicalCandidate).split(sep).join('/'));
  }
  if (!ref) {
    add(findings, 'v2-dispatch-receipt', `item ${row.id}: dispatched work needs dispatch_ref to an accepted JSON receipt`);
    return canonicalPaths;
  }
  const receiptPath = isAbsolute(ref) ? ref : resolve(baseDir, ref);
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch (error) {
    add(findings, 'v2-dispatch-receipt', `item ${row.id}: cannot read dispatch receipt ${ref}: ${error.message}`);
    return canonicalPaths;
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    add(findings, 'v2-dispatch-receipt', `item ${row.id}: dispatch receipt must be a JSON object`);
    return canonicalPaths;
  }
  const observed = receipt?.result && [receipt.result.task_name, receipt.result.agent_id, receipt.result.session_id, receipt.result.id]
    .find((id) => typeof id === 'string' && id.trim());
  if (!TOOL_RE.test(String(receipt.tool ?? '')) || receipt.event !== 'accepted' || receipt.agent_id !== owner || observed !== owner) {
    add(findings, 'v2-dispatch-receipt', `item ${row.id}: receipt must be accepted and its observed returned ID must match owner ${owner}`);
  }
  return canonicalPaths;
}

function validateRegistry(table, options, findings) {
  if (!table) { add(findings, 'v2-items-missing', 'v2 requires one ## Items registry table'); return []; }
  if (table.headingCount > 1) add(findings, 'v2-items-duplicate', `v2 requires exactly one ## Items registry; found ${table.headingCount}`);
  for (const col of REQUIRED_ITEM_COLUMNS) if (!table.headers.includes(col)) add(findings, 'v2-item-column', `## Items is missing required header column ${col}`);
  const active = [];
  const seen = new Set();
  for (const row of table.rows) {
    if (seen.has(value(row, 'id'))) add(findings, 'v2-item-id-duplicate', `item ${value(row, 'id') || '(no id)'}: duplicate registry ID`);
    seen.add(value(row, 'id'));
    if (/^ready$/i.test(value(row, 'status'))) add(findings, 'v2-item-ready', `item ${value(row, 'id')}: ready is not a valid end-of-wake status`);
    if (!/^(?:dispatched\b|done\b|blocked\b|owner\b)/i.test(value(row, 'status'))) add(findings, 'v2-item-status', `item ${value(row, 'id')}: status must be dispatched / done / blocked / owner`);
    if (/^dispatched\b/i.test(value(row, 'status'))) {
      if (!value(row, 'evidence')) add(findings, 'v2-dispatch-evidence', `item ${value(row, 'id')}: active dispatched work needs evidence`);
      const paths = validateReceipt(row, options, findings);
      active.push({ row, paths });
    }
  }
  for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
    const a = active[i]; const b = active[j];
    if (value(a.row, 'mode') !== 'write' || value(b.row, 'mode') !== 'write' || value(a.row, 'owner') === value(b.row, 'owner') || value(a.row, 'repository') !== value(b.row, 'repository')) continue;
    const overlap = a.paths.find((path) => b.paths.includes(path));
    if (overlap) add(findings, 'v2-write-conflict', `items ${value(a.row, 'id')} and ${value(b.row, 'id')} have different active writer owners for ${value(a.row, 'repository')}:${overlap}`);
  }
  return table.rows;
}

function validateDecomposition(text, wake, items, findings) {
  const section = sectionFor(text, wake);
  const table = findNamedTable(section, 'Decomposition');
  const loc = `${wake.heading} (line ${wake.line})`;
  if (!table) { add(findings, 'v2-decomposition-missing', `${loc}: requires a ### Decomposition table`); return; }
  for (const col of DECOMP_COLUMNS) if (!table.headers.includes(col)) add(findings, 'v2-decomposition-column', `${loc}: Decomposition table is missing ${col}`);
  const decomposed = new Map();
  const itemById = new Map(items.map((row) => [value(row, 'id'), row]));
  for (const row of table.rows) {
    const key = value(row, 'item');
    const disposition = value(row, 'disposition').toLowerCase();
    if (!key) add(findings, 'v2-decomposition-item', `${loc}: decomposition row has no item ID`);
    if (!DISPOSITIONS.has(disposition)) add(findings, 'v2-decomposition-disposition', `${loc}: ${key || '(item)'} disposition must be dispatched/continuing/blocked/owner/done, not ready`);
    if (!value(row, 'next_step')) add(findings, 'v2-decomposition-next-step', `${loc}: ${key || '(item)'} needs a next_step`);
    if (!itemById.has(key)) add(findings, 'v2-decomposition-unknown-item', `${loc}: Decomposition references unknown Item ID ${key || '(empty)'}`);
    else {
      const status = value(itemById.get(key), 'status').toLowerCase();
      const matches = (disposition === 'done' && status.startsWith('done')) ||
        (disposition === 'dispatched' && status.startsWith('dispatched')) ||
        (disposition === 'continuing' && status.startsWith('dispatched')) ||
        (disposition === 'blocked' && status.startsWith('blocked')) ||
        (disposition === 'owner' && status.startsWith('owner'));
      if (!matches) add(findings, 'v2-decomposition-status', `${loc}: ${key} disposition ${disposition} does not match current Item status ${status}`);
    }
    if (key && decomposed.has(key)) add(findings, 'v2-decomposition-duplicate', `${loc}: item ${key} appears more than once in Decomposition`);
    if (key) decomposed.set(key, row);
  }
  for (const item of items) {
    const id = value(item, 'id');
    if (/^done\b/i.test(value(item, 'status'))) continue;
    const entry = decomposed.get(id);
    if (!entry) add(findings, 'v2-decomposition-item-missing', `${loc}: non-done item ${id} needs one Decomposition row`);
    else if (value(entry, 'disposition').toLowerCase() !== 'done' && (!value(entry, 'owner') || !value(item, 'owner') || value(entry, 'owner') !== value(item, 'owner'))) add(findings, 'v2-decomposition-owner', `${loc}: ${id} Decomposition owner must be nonempty and match its registry owner`);
  }
}

function validateV2Wake(text, wake, items, findings) {
  const lines = sectionFor(text, wake);
  const loc = `${wake.heading} (line ${wake.line})`;
  if (wake.layout.count !== 10) add(findings, 'v2-layout', `${loc}: current heartbeat/v2 audits require the ten-row layout`);
  if (!lines.some((line) => /^\s*contract:\s*heartbeat\/v2\s*$/i.test(line))) add(findings, 'v2-contract-missing', `${loc}: latest wake must contain contract: heartbeat/v2`);
  validateDecomposition(text, wake, items, findings);
  const resplit = lines.find((line) => /^\s*re-split:/i.test(line));
  if (!resplit || !/rows\s*\(/i.test(resplit)) add(findings, 'resplit-rows-missing', `${loc}: latest wake requires re-split rows(...) even when no rows are blocked/deferred`);
}

// Shared API: extraChecks receives normalized {text, wakes, items, latestWake, ledgerPath} and returns findings.
export function checkHeartbeatV2(text, { now = new Date(), ledgerPath, baseDir, extraChecks = [] } = {}) {
  const findings = [...checkLedger(text, { latest: true, now, requireAudit: true }), ...checkItems(text, { now })];
  const table = itemTable(text);
  const provisionalWakes = parseWakes(text);
  const provisionalWake = provisionalWakes.at(-1);
  const provisionalSection = provisionalWake ? sectionFor(text, provisionalWake) : [];
  const decomposition = findNamedTable(provisionalSection, 'Decomposition');
  if (table?.rows.length === 0 && decomposition?.rows.length === 0 && provisionalSection.some((line) => /^\s*contract:\s*heartbeat\/v2\s*$/i.test(line))) {
    for (let i = findings.length - 1; i >= 0; i -= 1) if (findings[i].rule === 'items-empty') findings.splice(i, 1);
  }
  const registryRows = validateRegistry(table, { ledgerPath, baseDir }, findings);
  const wakes = provisionalWakes;
  if (!wakes.length) return findings;
  const latestWake = wakes[wakes.length - 1];
  validateV2Wake(text, latestWake, registryRows, findings);
  const parsed = { text, wakes, items: registryRows, latestWake, ledgerPath: ledgerPath ? resolve(ledgerPath) : null };
  findings.push(...checkV2Guards(parsed));
  for (const check of (Array.isArray(extraChecks) ? extraChecks : [extraChecks])) {
    if (typeof check !== 'function') continue;
    const result = check(parsed);
    if (Array.isArray(result)) findings.push(...result);
  }
  return findings;
}

export const parseItemsV2 = (text) => itemTable(text);
export const checkLedgerV2 = checkHeartbeatV2;
