#!/usr/bin/env node
// Mechanical checker for the heartbeat ledger written by the `agent-task-supervision` skill.
// A self-graded ledger is not evidence; this script is the second pair of eyes.
//
// Usage:
//   node check-heartbeat-ledger.mjs <ledger> [--latest]   # wake sections (whole file, or newest only)
//   node check-heartbeat-ledger.mjs <ledger> --items      # the "## Items" registry table
// Both modes accept `--now <ISO>` (default: the current time) for the freeze-expiry and 24h-staleness rules.
// Exit codes: 0 green, 1 red (one line per red row on stdout), 2 usage / unreadable file.
//
// Wake section (appended on every wake, never rewritten):
//   ## 2026-01-01T12:00Z wake (10-row ledger)
//   sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ <timestamp>) worker-health(✓)
//   | # | category | state |
//   | 1 | goal-derived remaining work | (1a) <state>; (1b) <state> |
//   | 2 | read-only review | done -- `git log a..b` clean |
//   ...
// Row states: `in-flight <unit>` / `dispatched <unit>` / `blocked <- <exclusive resource>` /
// `deferred <- <input> ETA <=20m` / `empty -- <query run this wake>` / `done -- <evidence>` /
// `unchanged -- `<command rerun this wake>`` (rows 2-9 only; see heartbeat-ledger-unchanged.mjs). `←` and `—`
// are accepted wherever `<-` and `--` are shown.
// `--latest` grades only the newest section (history stays as record); earlier sections are still read so
// "the same deferred input twice in a row must escalate" and the `unchanged` carry-forward can be checked.
// Under `--latest` the `sources:` line is also graded (every channel present, the external backlog read
// within 6h of the wake or `blocked <-` with an `owner <-` item) and the drift row must cite the matrix:
// see heartbeat-ledger-sources.mjs. Without `--latest` a `sources:` line only has to exist.
// Also under `--latest`: the default answer to "can it be split?" is yes. Every `blocked <-` / `deferred <-` row needs a
// verdict in the wake's `re-split: ... rows(...)` group plus a matching `splittable: D/P` token (heartbeat-ledger-splittable.mjs),
// and a `blocked <-` that waits only on another unit's unlanded branch needs a tagged proof (heartbeat-blocked-reason.mjs).
//
// Items registry (`## Items`, columns `id | source | item | status | evidence`): status is
// `ready` / `dispatched <unit>` / `done` (+ evidence) / `blocked <- <resource>` /
// `owner <- <hard category> + <authorization checked and why it does not cover this>`.
// `replays:<unit>=<N>` in status/evidence counts full-chain re-dispatches of one unit: N >= 3 needs an
// `audit:<unit>` item (done/dispatched), and a count must never decrease.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBlockedStreakTracker,
  findLandingStageOnlyResources,
  findStaleBlockedRows,
  freezeProblem,
  landingStageMessage,
  staleStreakMessage,
  unlandedBranchMessage,
  waitsOnUnlandedBranchWithoutProof,
  writeSetMessage,
  writeSetWithoutPaths,
} from './heartbeat-blocked-reason.mjs';
import { gradeSources, parseIsoMs } from './heartbeat-ledger-sources.mjs';
import { checkSplittable } from './heartbeat-ledger-splittable.mjs';
import { createUnchangedTracker } from './heartbeat-ledger-unchanged.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';

// Realpath on both sides: Node resolves symlinks in import.meta.url, argv[1] keeps the caller's spelling (starter kit is copied into
// other repos, so this is an inline copy of the shared helper rather than an import).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

// The ten sweep categories, in order. SKILL.md's backlog sweep uses these exact phrases; the test
// suite fails if the two drift apart.
export const CATEGORIES = [
  'goal-derived remaining work',
  'read-only review',
  'temporary status updates',
  'long-lived knowledge artifacts',
  'tooling/test fixes',
  'release/deploy prep',
  'follow-ups from finished workers',
  'centralized verification',
  'session hygiene',
  'deployable-unit drift',
];

export const WAKE_HEADING_RE = /^#{1,6}\s+.*wake \(10-row ledger[^)]*\)\s*$/i;
const HEADING_TIME_RE = /^#{1,6}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HEADING_ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/;
const SECTION_END_RE = /^(#{1,6}\s|-{3,}\s*$)/;
const SOURCES_RE = /^\s*sources:\s*\S/i;
const DRIFT_ROW = 10;
const DRIFT_MATRIX_RE = /matrix|unchecked\s*:/i;
const ROW_RE = /^\|\s*(\d+)\s*\|([^|]*)\|(.*)\|\s*$/;
const ARROW = '(?:←|<-)';
const BLOCKED_RE = new RegExp(`^blocked\\s*${ARROW}\\s*(\\S.*)$`, 'i');
const VAGUE_RESOURCE_RE = /^(in[- ]?flight|busy|running|working|pending|waiting)\.?$/i;
const DEFERRED_RE = new RegExp(`^deferred\\s*${ARROW}\\s*(.+?)\\s+ETA\\s*(?:<=|≤)\\s*20\\s*m\\b`, 'i');
// Evidence is a backticked command/output or a commit SHA (7-40 hex characters, at least one a digit).
const EVIDENCE_RE = /`[^`]+`|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;
const ALLOWED_STATES = 'in-flight / dispatched / blocked / deferred / empty / done / unchanged';
const UNIT_RE = /^(?:in-flight|dispatched)\s*:?\s+\S/i;

export function countWakeSections(text) {
  return text.split('\n').filter((line) => WAKE_HEADING_RE.test(line)).length;
}

function kindOf(state) {
  const match = state.trim().match(/^(in-flight|dispatched|blocked|deferred|empty|done|unchanged)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function parseWakes(text) {
  const lines = text.split('\n');
  const wakes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!WAKE_HEADING_RE.test(lines[i])) continue;
    const wake = { heading: lines[i].trim(), line: i + 1, headingOk: HEADING_TIME_RE.test(lines[i]), sources: false, sourcesLine: null, rows: [] };
    wake.sectionLines = [];
    for (let j = i + 1; j < lines.length && !SECTION_END_RE.test(lines[j]); j += 1) {
      wake.sectionLines.push(lines[j]);
      if (SOURCES_RE.test(lines[j]) && !wake.sourcesLine) {
        wake.sources = true;
        wake.sourcesLine = lines[j].trim();
      }
      const row = lines[j].match(ROW_RE);
      if (row) wake.rows.push({ num: Number(row[1]), category: row[2].trim(), state: row[3].trim(), line: j + 1 });
    }
    wake.timeMs = parseIsoMs(lines[i].match(HEADING_ISO_RE)?.[0]);
    wakes.push(wake);
  }
  return wakes;
}

// Row 1 carries two answers: `(1a) <state>; (1b) <state>`. Every other row is one cell keyed by number.
function stateCells(wake, red) {
  const cells = [];
  for (const row of wake.rows) {
    if (row.num !== 1) {
      cells.push({ key: String(row.num), state: row.state, row });
      continue;
    }
    const parts = row.state.match(/^\s*\(1a\)\s*([\s\S]*?)\s*;?\s*\(1b\)\s*([\s\S]*)$/i);
    if (!parts) {
      red('goal-row-parts', row.line, 'row 1 must carry "(1a) <state>; (1b) <state>" -- two separate answers');
      continue;
    }
    cells.push({ key: '1a', state: parts[1].trim(), row }, { key: '1b', state: parts[2].trim(), row });
  }
  return cells;
}

function deferredInputs(wake) {
  const inputs = new Map();
  for (const cell of stateCells(wake, () => {})) {
    const match = cell.state.match(DEFERRED_RE);
    if (match) inputs.set(cell.key, match[1].trim().toLowerCase());
  }
  return inputs;
}

export function checkLedger(text, { latest = false, now = new Date() } = {}) {
  const blockedStreaks = createBlockedStreakTracker();
  const wakes = parseWakes(text);
  const findings = [];
  if (wakes.length === 0) {
    return [{ rule: 'no-wake-sections', message: 'no "## <ISO time> wake (10-row ledger)" heading found' }];
  }
  const first = latest ? wakes.length - 1 : 0;
  const ownerRows = parseItems(text).rows.filter((row) => itemKind(row.status) === 'owner');
  const unchanged = createUnchangedTracker();
  let previousInputs = new Map();
  // Every wake is walked, so the `unchanged` carry-forward and the deferred-input memory are right even
  // when only the newest section is graded; findings are kept for the graded sections only.
  for (let w = 0; w < wakes.length; w += 1) {
    const wake = wakes[w];
    const graded = w >= first;
    const red = (rule, line, message) => {
      if (graded) findings.push({ rule, message: `${wake.heading} (line ${line}): ${message}` });
    };
    if (!wake.headingOk) red('heading-time', wake.line, 'heading must be "## <ISO time> wake (10-row ledger)", e.g. 2026-01-01T12:00Z');
    if (!wake.sources) red('sources-missing', wake.line, 'missing a "sources:" line naming the discovery channels this wake consulted');
    if (latest && graded && wake.sourcesLine) {
      for (const finding of gradeSources(wake.sourcesLine, { wakeMs: wake.timeMs, ownerRows })) red(finding.rule, wake.line, finding.message);
    }

    const counts = new Map();
    for (const row of wake.rows) counts.set(row.num, (counts.get(row.num) || 0) + 1);
    CATEGORIES.forEach((name, index) => {
      const seen = counts.get(index + 1) || 0;
      if (seen === 0) red('row-missing', wake.line, `row ${index + 1} (${name}) is missing`);
      if (seen > 1) red('row-duplicate', wake.line, `row ${index + 1} (${name}) appears ${seen} times, expected exactly once`);
    });
    for (const num of counts.keys()) {
      if (num < 1 || num > CATEGORIES.length) red('row-number', wake.line, `row number ${num} is outside 1..${CATEGORIES.length}`);
    }

    unchanged.startWake();
    for (const cell of stateCells(wake, red)) {
      const where = cell.row.line;
      const label = `row ${cell.key}`;
      const kind = kindOf(cell.state);
      const problem = unchanged.check(cell.key, cell.state, kind);
      if (kind === 'unchanged') {
        if (problem) red('unchanged-shorthand', where, `${label}: "unchanged -- \`<command rerun this wake>\`" is not allowed here: ${problem}; got "${cell.state}"`);
      } else if (kind === 'unknown') {
        red('state-unknown', where, `${label}: state must start with ${ALLOWED_STATES}; got "${cell.state}"`);
      } else if (kind === 'in-flight' || kind === 'dispatched') {
        if (!UNIT_RE.test(cell.state)) red('unit-missing', where, `${label}: ${kind} must name the agent or unit as "${kind} <unit>"; got "${cell.state}"`);
      } else if (kind === 'blocked') {
        const resource = cell.state.match(BLOCKED_RE)?.[1];
        if (!resource) red('blocked-resource', where, `${label}: blocked must name an exclusive resource as "blocked <- <resource>"; got "${cell.state}"`);
        else if (VAGUE_RESOURCE_RE.test(resource.trim())) red('blocked-resource', where, `${label}: "${resource}" is not an exclusive resource`);
        else {
          const landing = findLandingStageOnlyResources(resource);
          if (landing) red('blocked-landing-stage-resource', where, landingStageMessage(label, landing).replace(`${label}: `, ''));
          if (writeSetWithoutPaths(resource)) red('write-set-no-paths', where, writeSetMessage(label).replace(`${label}: `, ''));
          if (waitsOnUnlandedBranchWithoutProof(resource)) red('blocked-on-unlanded-branch-defaults-free', where, unlandedBranchMessage(label).replace(`${label}: `, ''));
        }
      } else if (kind === 'deferred') {
        const input = cell.state.match(DEFERRED_RE)?.[1].trim().toLowerCase();
        if (!input) red('deferred-syntax', where, `${label}: deferred must read "deferred <- <input> ETA <=20m"; got "${cell.state}"`);
        else if (previousInputs.get(cell.key) === input) {
          red('deferred-repeat', where, `${label}: deferred on "${input}" two wakes in a row -- escalate to dispatched or blocked <- <resource>`);
        }
      } else if ((kind === 'empty' || kind === 'done') && !EVIDENCE_RE.test(cell.state)) {
        red('evidence-missing', where, `${label}: ${kind} needs evidence (a backticked command/output or a commit SHA)`);
      }
      const since = blockedStreaks.observe(cell.key, kind, cell.state, wake.timeMs);
      if (since !== null) red('blocked-stale', where, staleStreakMessage(label, since).replace(`${label}: `, ''));
      const freeze = freezeProblem(cell.state, wake.timeMs);
      if (freeze) red(freeze.rule, where, `${label}: ${freeze.detail}`);
      if (latest && cell.key === String(DRIFT_ROW) && (kind === 'empty' || kind === 'done') && !DRIFT_MATRIX_RE.test(cell.state)) {
        red('drift-matrix-missing', where, `${label}: the drift row must cite a check against the declared stage x unit matrix, or name the units not checked ("unchecked: <units>"); got "${cell.state}"`);
      }
    }
    unchanged.endWake();
    previousInputs = deferredInputs(wake);
    if (latest && graded) {
      const itemRows = parseItems(text).rows.map((row) => ({ id: row.id, status: row.status }));
      const cells = stateCells(wake, () => {});
      for (const finding of checkSplittable({ loc: `${wake.heading} (line ${wake.line})`, sectionLines: wake.sectionLines, cells, itemRows })) findings.push(finding);
    }
  }
  return findings;
}

// ---- "## Items" registry ----------------------------------------------------------------------

const ITEMS_HEADING_RE = /^#{1,6}\s+Items\s*$/i;
const SOURCE_RE = /^(memory|handoff|report|landing|owner|sweep|audit|goal):\S/i;
// The hard categories an `owner <-` item may cite (the supervision skill's list).
const OWNER_CATEGORY_RE = /irreversible|security|cost|owner decision/i;
const REPLAY_RE = /replays:([\w./-]+)=(\d+)/gi;

function itemKind(status) {
  const text = status.trim();
  if (/^ready$/i.test(text)) return 'ready';
  if (new RegExp(`^owner\\s*${ARROW}`, 'i').test(text)) return 'owner';
  if (/^blocked\b/i.test(text)) return 'blocked';
  if (/^dispatched\s*:?\s+\S/i.test(text)) return 'dispatched';
  if (/^done\b/i.test(text)) return 'done';
  return 'unknown';
}

export function parseItems(text) {
  const lines = text.split('\n');
  const rows = [];
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!ITEMS_HEADING_RE.test(lines[i])) continue;
    found = true;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j += 1;
    j += 2; // header row + separator row
    for (; j < lines.length && /^\|.*\|\s*$/.test(lines[j].trim()); j += 1) {
      const [id = '', source = '', item = '', status = '', ...evidence] = lines[j].trim().slice(1, -1).split('|').map((c) => c.trim());
      rows.push({ id, source, item, status, evidence: evidence.join(' | '), line: j + 1 });
    }
  }
  return { found, rows };
}

// A registry row (its second cell is a recognised source) that sits outside the `## Items` table:
// invisible to `--items` parsing, so it is reported instead of silently lost. Wake-ledger rows
// (`| 3 | category | state |`) never carry a source in their second cell, so they cannot match.
export function findStrayItemRows(text, rows = parseItems(text).rows) {
  const inTable = new Set(rows.map((row) => row.line));
  const stray = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line) || inTable.has(index + 1)) return;
    const [id = '', source = ''] = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (SOURCE_RE.test(source)) stray.push({ id, source, line: index + 1 });
  });
  return stray;
}

export function findDuplicateItemIds(rows) {
  const first = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (!row.id) continue;
    if (first.has(row.id)) duplicates.push({ id: row.id, line: row.line, firstLine: first.get(row.id) });
    else first.set(row.id, row.line);
  }
  return duplicates;
}

export function checkItems(text, { now = new Date() } = {}) {
  const { found, rows } = parseItems(text);
  const findings = [];
  if (!found) return [{ rule: 'no-items-table', message: 'no "## Items" registry table found' }];
  if (rows.length === 0) return [{ rule: 'items-empty', message: '"## Items" table has no rows' }];
  const red = (rule, row, message) => findings.push({ rule, message: `item ${row.id || '(no id)'} (line ${row.line}): ${message}` });
  for (const stray of findStrayItemRows(text, rows)) {
    findings.push({ rule: 'item-outside-table', message: `item ${stray.id || '(no id)'} (line ${stray.line}): row sits outside the "## Items" table -- move it inside, rows below a later section are invisible to this checker` });
  }
  const duplicateLines = new Set(findDuplicateItemIds(rows).map((dup) => dup.line));
  const history = new Map();
  for (const row of rows) {
    if (!row.id) red('item-id', row, 'row has no id');
    else if (duplicateLines.has(row.line)) red('item-id', row, 'duplicate id');
    if (!SOURCE_RE.test(row.source)) red('item-source', row, `source must be memory:/handoff:/report:/landing:/owner:/sweep:/audit:/goal:<ref>; got "${row.source}"`);
    const kind = itemKind(row.status);
    if (kind === 'ready') red('item-ready', row, 'status is "ready" -- dispatch it this wake or reclassify it with proof');
    else if (kind === 'unknown') red('item-status', row, `status must start with ready / dispatched <unit> / done / blocked <- / owner <-; got "${row.status}"`);
    else if (kind === 'done' && (!row.evidence || row.evidence === '-')) red('item-done-evidence', row, 'done needs evidence in the evidence column');
    else if (kind === 'blocked') {
      const resource = row.status.match(BLOCKED_RE)?.[1];
      if (!resource || VAGUE_RESOURCE_RE.test(resource.trim())) red('item-blocked', row, 'blocked must name an exclusive resource as "blocked <- <resource>"');
    } else if (kind === 'owner') {
      const proof = row.status.match(new RegExp(`^owner\\s*${ARROW}\\s*(\\S.*?)\\s*\\+\\s*(\\S.*)$`, 'i'));
      if (!proof) red('item-owner-proof', row, 'owner <- needs "<hard category> + <authorization checked and why it does not cover this>"');
      else if (!OWNER_CATEGORY_RE.test(proof[1])) red('item-owner-category', row, `owner <- must cite a hard category (irreversible / security boundary / significant cost / owner decision); got "${proof[1]}"`);
    }
    for (const match of `${row.status} ${row.evidence}`.matchAll(REPLAY_RE)) {
      const unit = match[1];
      const count = Number(match[2]);
      if (!history.has(unit)) history.set(unit, []);
      const counts = history.get(unit);
      if (counts.length > 0 && count < counts[counts.length - 1]) {
        red('replay-decreased', row, `replays:${unit} went from ${counts[counts.length - 1]} to ${count}; replay counters never decrease`);
      }
      counts.push(count);
      if (count >= 3 && !hasAudit(rows, unit, row.id)) {
        red('replay-audit', row, `replays:${unit}=${count} needs a done/dispatched "audit:${unit}" item (or a "report:${row.id}" item naming a root-cause audit)`);
      }
    }
  }
  const isDone = (row) => itemKind(row.status) === 'done';
  const nowMs = now.getTime();
  const flat = rows.map((row) => ({ ...row, loc: `item ${row.id || '(no id)'} (line ${row.line})` }));
  const wakeTimes = parseWakes(text).filter((w) => w.timeMs !== null && w.timeMs !== undefined);
  const wakeSpan = (key) => {
    const hits = wakeTimes.filter((w) => w.rows.some((r) => r.state.replace(/\s+/g, ' ').toLowerCase().includes(key)));
    return hits.length > 0 ? { since: Math.min(...hits.map((w) => w.timeMs)), until: Math.max(...hits.map((w) => w.timeMs)) } : null;
  };
  const blockedReason = (row) => (itemKind(row.status) === 'blocked' ? row.status.match(BLOCKED_RE)?.[1]?.trim() || null : null);
  for (const row of flat) {
    const resource = blockedReason(row);
    if (resource) {
      const landing = findLandingStageOnlyResources(resource);
      if (landing) findings.push({ rule: 'blocked-landing-stage-resource', message: landingStageMessage(row.loc, landing) });
      if (writeSetWithoutPaths(resource)) findings.push({ rule: 'write-set-no-paths', message: writeSetMessage(row.loc) });
      if (waitsOnUnlandedBranchWithoutProof(resource)) findings.push({ rule: 'blocked-on-unlanded-branch-defaults-free', message: unlandedBranchMessage(row.loc) });
    }
    if (!isDone(row)) {
      const freeze = freezeProblem(`${row.item} ${row.status} ${row.evidence}`, nowMs);
      if (freeze) findings.push({ rule: freeze.rule, message: `${row.loc}: ${freeze.detail}` });
    }
  }
  findings.push(...findStaleBlockedRows({ rows: flat, blockedReason, isDone, wakeSpan, nowMs }));
  return findings;
}

function hasAudit(rows, unit, itemId) {
  return rows.some((row) => {
    const kind = itemKind(row.status);
    if (kind !== 'done' && kind !== 'dispatched') return false;
    if (row.source.toLowerCase() === `audit:${unit}`.toLowerCase()) return true;
    return row.source === `report:${itemId}` && /audit|root[- ]cause/i.test(`${row.item} ${row.status}`);
  });
}

// ---- CLI --------------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const target = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--now');
  const known = new Set(['--latest', '--items']);
  const nowAt = args.indexOf('--now');
  const nowText = nowAt >= 0 ? args[nowAt + 1] : null;
  const now = nowText ? new Date(nowText) : new Date();
  if (nowAt >= 0) {
    flags.delete('--now');
    if (!nowText || Number.isNaN(now.getTime())) {
      process.stderr.write('--now needs an ISO time\n');
      exitDrained(2);
      return;
    }
  }
  if (!target || [...flags].some((flag) => !known.has(flag)) || (flags.has('--latest') && flags.has('--items'))) {
    process.stderr.write('usage: check-heartbeat-ledger.mjs <ledger> [--latest | --items]\n');
    exitDrained(2);
    return;
  }
  let text;
  try {
    text = readFileSync(resolve(process.cwd(), target), 'utf8');
  } catch (error) {
    process.stderr.write(`cannot read ${target}: ${error.message}\n`);
    exitDrained(2);
    return;
  }
  const findings = flags.has('--items') ? checkItems(text, { now }) : checkLedger(text, { latest: flags.has('--latest'), now });
  if (findings.length === 0) {
    process.stdout.write(`check-heartbeat-ledger: OK ${target}\n`);
    exitDrained(0);
    return;
  }
  for (const finding of findings) process.stdout.write(`RED [${finding.rule}] ${finding.message}\n`);
  exitDrained(1);
}

if (isMainModule(import.meta.url)) main();
