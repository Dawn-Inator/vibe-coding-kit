#!/usr/bin/env node
// Mechanical DISCOVERY for the heartbeat registry. The ledger checker validates the registry's
// shape; this looks for candidate items that should exist and do not, so a wake never re-derives
// them from memory.
//
// Usage:
//   node heartbeat-sweep.mjs --ledger <path> [--base <ref> ...] [--stale-days <n>] [--worktree-root <dir>]
//                            [--probes <file>] [--max-rows <n>] [--config <worktree-config.json>]
// Exit codes: 0 zero candidates and zero free candidates, 1 at least one of either, 2 usage error.
// Read-only and offline: it never writes the ledger, never runs `git fetch` (read whatever the remote-
// tracking refs currently hold; fetch yourself first if you need them fresh), and finishes in seconds.
// stdout carries the candidate rows, in the `## Items` row format with status `ready`
// (`| id | source | item | status | evidence |`), then a `free-candidates:` section (every other line is
// indented or a header, never a row); notes and the one-line summary
// (`in-flight N · free-undispatched M · blocked K (owner/time J)`) go to stderr.
// Free candidates are `blocked` / `ready` registry rows that are mechanically not blocked (see
// heartbeat-sweep-free.mjs); any of them also makes the exit code 1.
//
// Baseline discovery categories:
//   1. landings  -- commits on each tracked base branch after the last reviewed point that no `landing:` item names
//   2. worktrees -- registered managed worktrees the kit's reclaim pass would remove (never an active-recent one)
//   3. registry  -- item rows outside the `## Items` table, and duplicate ids
// Extension point (`--probes <file>` or HEARTBEAT_SWEEP_PROBES): where a project adds its own drift
// probes (deployed-version drift, an external backlog, ...). JSON: an array of {source, item, evidence}.
// ES module (.mjs/.js): default export `(ctx) => candidates | Promise<candidates>` with
// ctx = { ledgerPath, repoDir, rows, bases }. A probe that throws becomes a candidate itself: a broken probe must be loud.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { findDuplicateItemIds, findStrayItemRows, parseItems } from './check-heartbeat-ledger.mjs';
import { defaultBase, discoverLandings } from './heartbeat-sweep-landings.mjs';
import { discoverWorktrees } from './heartbeat-sweep-worktrees.mjs';
import { computeFree, formatFree } from './heartbeat-sweep-free.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';

// Realpath on both sides: Node resolves symlinks in import.meta.url, argv[1] keeps the caller's spelling (starter kit is copied into
// other repos, so this is an inline copy of the shared helper rather than an import).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

const PROBE_TIMEOUT_MS = 20_000;
const SOURCE_OK = /^(memory|handoff|report|landing|owner|sweep|audit):\S/i;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { ledger: null, bases: [], staleDays: 1, worktreeRoot: null, probes: process.env.HEARTBEAT_SWEEP_PROBES || null, maxRows: 20, config: null };
  const valued = { '--ledger': 'ledger', '--base': 'bases', '--stale-days': 'staleDays', '--worktree-root': 'worktreeRoot', '--probes': 'probes', '--max-rows': 'maxRows', '--config': 'config' };
  const args = argv.filter((arg) => arg !== '--');
  for (let i = 0; i < args.length; i += 1) {
    const key = valued[args[i]];
    const value = args[i + 1];
    if (!key) throw new UsageError(`unknown argument "${args[i]}"`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${args[i]} needs a value`);
    i += 1;
    if (key === 'bases') opts.bases.push(value);
    else opts[key] = key === 'staleDays' || key === 'maxRows' ? Number(value) : value;
  }
  if (!opts.ledger) throw new UsageError('--ledger <path> is required');
  if (!(opts.staleDays > 0)) throw new UsageError('--stale-days must be a positive number');
  if (!Number.isInteger(opts.maxRows) || opts.maxRows < 1) throw new UsageError('--max-rows must be a positive integer');
  return opts;
}

const cell = (text) => String(text).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();

function registryHygiene(text, rows) {
  const out = [];
  for (const stray of findStrayItemRows(text, rows)) {
    out.push({ source: `sweep:registry:outside-table-line-${stray.line}`, item: `move item row ${stray.id || '(no id)'} (line ${stray.line}) into the "## Items" table`, evidence: '`check-heartbeat-ledger --items` reports it as item-outside-table' });
  }
  for (const dup of findDuplicateItemIds(rows)) {
    out.push({ source: `sweep:registry:duplicate-id-${dup.id}`, item: `item id ${dup.id} is used twice (lines ${dup.firstLine} and ${dup.line}); renumber one`, evidence: '`check-heartbeat-ledger --items` reports it as a duplicate id' });
  }
  return out;
}

async function runProbes(file, ctx) {
  const path = resolve(file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read probes file ${file}: ${error.message}`);
  }
  try {
    if (path.endsWith('.json')) return JSON.parse(text);
    const mod = await import(pathToFileURL(path).href);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS).unref());
    return await Promise.race([mod.default(ctx), timeout]);
  } catch (error) {
    return [{ source: 'sweep:probe-error', item: `probes file ${file} failed: ${String(error.message).split('\n')[0]}`, evidence: 'fix the probe; a broken probe hides the drift it exists to find', always: true }];
  }
}

// Candidates already tracked by a non-done registry row with the same source are not proposed again.
function untracked(candidates, rows) {
  const tracked = new Set(rows.filter((row) => !/^done\b/i.test(row.status)).map((row) => row.source.toLowerCase()));
  return candidates.filter((candidate) => candidate.always || !tracked.has(candidate.source.toLowerCase()));
}

export async function sweep(opts, { cwd = process.cwd(), worktreeOptions = {} } = {}) {
  let text;
  try {
    text = readFileSync(resolve(cwd, opts.ledger), 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ledger ${opts.ledger}: ${error.message}`);
  }
  const { found, rows } = parseItems(text);
  const notes = found ? [] : ['registry: ledger has no "## Items" table yet'];
  const all = [];
  const take = (result) => {
    all.push(...result.candidates);
    notes.push(...result.notes);
  };

  const bases = opts.bases.length > 0 ? opts.bases : [defaultBase(cwd)].filter(Boolean);
  if (bases.length === 0) notes.push('landings: no tracked base branch found (pass --base <ref>)');
  const proposed = new Set();
  for (const base of bases) take(discoverLandings(cwd, base, rows, { maxRows: opts.maxRows, proposed }));
  take(discoverWorktrees(cwd, {
    staleDays: opts.staleDays,
    worktreeRoot: opts.worktreeRoot,
    configPath: opts.config,
    ...worktreeOptions,
  }));
  all.push(...registryHygiene(text, rows));
  const free = computeFree(rows, { repoDir: cwd, base: bases[0] ?? 'HEAD', ledgerPath: resolve(cwd, opts.ledger) });
  if (opts.probes) all.push(...(await runProbes(opts.probes, { ledgerPath: resolve(cwd, opts.ledger), repoDir: cwd, rows, bases })));

  let next = Math.max(0, ...rows.map((row) => Number(/^I-?(\d+)$/i.exec(row.id)?.[1] ?? 0)));
  const lines = untracked(all, rows).map((candidate) => {
    next += 1;
    const source = SOURCE_OK.test(candidate.source ?? '') ? candidate.source : `sweep:probe:${String(candidate.source ?? 'unnamed').replace(/[^\w./:-]+/g, '_')}`;
    return `| I-${next} | ${cell(source)} | ${cell(candidate.item)} | ready | ${cell(candidate.evidence || '-')} |`;
  });
  return { lines, notes, free, freeText: formatFree(free) };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const { lines, notes, free, freeText } = await sweep(opts);
    for (const note of notes) process.stderr.write(`heartbeat-sweep: ${note}\n`);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    if (freeText) process.stdout.write(`${freeText}\n`);
    process.stderr.write(`heartbeat-sweep: ${lines.length} candidate(s) -- ingest each as a registry row and dispatch or defer it this wake\n`);
    process.stderr.write(`heartbeat-sweep: ${free.summary}\n`);
    exitDrained(lines.length > 0 || free.free.length > 0 ? 1 : 0);
    return;
  } catch (error) {
    process.stderr.write(`heartbeat-sweep: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write('usage: heartbeat-sweep.mjs --ledger <path> [--base <ref> ...] [--stale-days <n>] [--worktree-root <dir>] [--probes <file>] [--max-rows <n>]\n');
    exitDrained(2);
  }
}

if (isMainModule(import.meta.url)) await main();
