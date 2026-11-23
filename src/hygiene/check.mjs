// Code hygiene gate: collects defensive-programming and coupling findings, then enforces a
// shrink-only baseline (see skills/backend-governance-ratchets and skills/coding-discipline).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomically } from '../lib/atomic-write.mjs';

export const DEFAULT_CONFIG = '.vibe-coding/code-hygiene.json';
export const GROWTH_ENV = 'HYGIENE_BASELINE_GROWTH_REASON';
const GO_RULES = ['nil-context-check', 'nil-receiver-guard', 'reflect-nil-probe', 'scattered-recover',
  'wide-condition', 'collapsed-error', 'unknown-field-rejection', 'composition-root-data-access'];
export const RULES = Object.freeze([...GO_RULES, 'gofmt', 'line-length']);
const METADATA = ['owner', 'expiry', 'issue', 'removal_plan'];
const COLLAPSE_RATIO = 0.5;
const EXPIRY_WARNING_DAYS = 30;
const GOFMT_BATCH = 200;

export function loadConfig(projectRoot, configPath = DEFAULT_CONFIG) {
  const raw = JSON.parse(readFileSync(join(projectRoot, configPath), 'utf8'));
  if (raw.schemaVersion !== 1) throw new Error(`${configPath}: schemaVersion must be 1`);
  if (!Array.isArray(raw.include) || raw.include.length === 0) throw new Error(`${configPath}: include must list at least one glob`);
  const unknownRules = (raw.disabledRules ?? []).filter((rule) => !RULES.includes(rule));
  if (unknownRules.length) throw new Error(`${configPath}: unknown disabledRules: ${unknownRules.join(', ')}`);
  return {
    include: raw.include,
    exclude: raw.exclude ?? [],
    baseline: raw.baseline ?? '.vibe-coding/code-hygiene-baseline.json',
    baseRef: raw.baseRef,
    wideConditionMax: raw.wideConditionMax ?? 6,
    lineLengthMax: raw.lineLengthMax ?? 160,
    compositionRoots: raw.compositionRoots ?? [],
    dataAccessImports: raw.dataAccessImports ?? [],
    disabledRules: new Set(raw.disabledRules ?? []),
  };
}

function git(projectRoot, args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Files selected by the config globs: tracked plus new, non-ignored files, minus deleted ones. */
export function listFiles(projectRoot, config) {
  const specs = [...config.include.map((g) => `:(glob)${g}`), ...config.exclude.map((g) => `:(exclude,glob)${g}`)];
  const listed = git(projectRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', ...specs]);
  return [...new Set(listed.split('\0').filter(Boolean))].filter((f) => existsSync(join(projectRoot, f))).sort();
}

function runGoAnalyzer(projectRoot, files, config) {
  if (files.length === 0) return { filesScanned: 0, generated: [], findings: [] };
  const analyzer = fileURLToPath(new URL('./go-analyzer/main.go', import.meta.url));
  const input = JSON.stringify({ root: projectRoot, files, wideConditionMax: config.wideConditionMax,
    compositionRoots: config.compositionRoots, dataAccessImports: config.dataAccessImports });
  const run = spawnSync('go', ['run', analyzer], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GO111MODULE: 'off', GOPROXY: 'off', GOTOOLCHAIN: 'local' } });
  if (run.error || run.status !== 0) throw new Error(`Go hygiene analyzer failed: ${run.error?.message || run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}

function gofmtFindings(projectRoot, files) {
  const findings = [];
  for (let i = 0; i < files.length; i += GOFMT_BATCH) {
    const run = spawnSync('gofmt', ['-l', ...files.slice(i, i + GOFMT_BATCH)], { cwd: projectRoot, encoding: 'utf8' });
    if (run.error || run.status !== 0) throw new Error(`gofmt failed: ${run.error?.message || run.stderr.trim()}`);
    for (const path of run.stdout.split('\n').filter(Boolean)) {
      findings.push({ rule: 'gofmt', path, symbol: '', line: 1, message: 'file is not gofmt-formatted' });
    }
  }
  return findings;
}

function lineLengthFindings(projectRoot, files, max) {
  const findings = [];
  for (const path of files) {
    const lines = readFileSync(join(projectRoot, path), 'utf8').split('\n');
    lines.forEach((text, index) => {
      if ([...text].length > max) findings.push({ rule: 'line-length', path, symbol: '', line: index + 1, message: `line exceeds ${max} characters` });
    });
  }
  return findings;
}

/** Scan the configured scope and return every finding, before any baseline is applied. */
export function collectFindings(projectRoot, config) {
  const files = listFiles(projectRoot, config);
  const goFiles = files.filter((f) => f.endsWith('.go'));
  const go = runGoAnalyzer(projectRoot, goFiles, config);
  const generated = new Set(go.generated);
  const handWritten = files.filter((f) => !generated.has(f));
  const findings = [
    ...go.findings,
    ...gofmtFindings(projectRoot, handWritten.filter((f) => f.endsWith('.go'))),
    ...lineLengthFindings(projectRoot, handWritten, config.lineLengthMax),
  ].filter((f) => !config.disabledRules.has(f.rule));
  return { filesScanned: handWritten.length, findings };
}

const keyOf = (entry) => `${entry.rule}|${entry.path}|${entry.symbol}`;

function countByKey(entries, weight = () => 1) {
  const counts = new Map();
  for (const entry of entries) counts.set(keyOf(entry), (counts.get(keyOf(entry)) ?? 0) + weight(entry));
  return counts;
}

function totalsByRule(findings) {
  const totals = {};
  for (const f of findings) totals[f.rule] = (totals[f.rule] ?? 0) + 1;
  return totals;
}

function readBaseline(projectRoot, path) {
  const file = join(projectRoot, path);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function readBaselineAtMergeBase(projectRoot, baseRef, path) {
  const mergeBase = git(projectRoot, ['merge-base', 'HEAD', baseRef]).trim();
  const listed = git(projectRoot, ['ls-tree', '--name-only', mergeBase, '--', path]).trim();
  return listed ? JSON.parse(git(projectRoot, ['show', `${mergeBase}:${path}`])) : null;
}

function metadataProblems(baseline, today) {
  const problems = [];
  const warnings = [];
  for (const field of METADATA) {
    if (typeof baseline[field] !== 'string' || !baseline[field].trim()) problems.push(`baseline field ${field} must be a non-empty string`);
  }
  const expiry = Date.parse(baseline.expiry);
  if (Number.isNaN(expiry)) problems.push('baseline expiry must be an ISO date');
  else if (expiry < today.getTime()) problems.push(`baseline expired on ${baseline.expiry}; review the debt and renew or clear it`);
  else if (expiry - today.getTime() < EXPIRY_WARNING_DAYS * 86400000) warnings.push(`baseline expires on ${baseline.expiry}`);
  for (const e of baseline.exemptions ?? []) {
    if (!e.reason?.trim() || !e.symbol) problems.push(`exemption ${keyOf(e)} needs a symbol and a non-empty reason`);
  }
  const debtTotal = (baseline.debt ?? []).reduce((sum, d) => sum + d.count, 0);
  if (baseline.total !== debtTotal) problems.push(`baseline total ${baseline.total} does not match debt entries (${debtTotal})`);
  return { problems, warnings };
}

/** Describe every way `next` is looser than `previous`: more debt, more exemptions, narrower scope. */
export function baselineGrowth(previous, next) {
  const growth = [];
  for (const field of ['debt', 'exemptions']) {
    const before = countByKey(previous[field] ?? [], (e) => e.count);
    for (const [key, count] of countByKey(next[field] ?? [], (e) => e.count)) {
      if (count > (before.get(key) ?? 0)) growth.push(`${field} ${key}: ${before.get(key) ?? 0} -> ${count}`);
    }
  }
  if (next.total > previous.total) growth.push(`total: ${previous.total} -> ${next.total}`);
  const removedIncludes = previous.scope.include.filter((g) => !next.scope.include.includes(g));
  const addedExcludes = next.scope.exclude.filter((g) => !previous.scope.exclude.includes(g));
  if (removedIncludes.length) growth.push(`scope include removed: ${removedIncludes.join(', ')}`);
  if (addedExcludes.length) growth.push(`scope exclude added: ${addedExcludes.join(', ')}`);
  return growth;
}

function compareWithFindings(baseline, findings) {
  const failures = [];
  const allowed = countByKey(baseline?.debt ?? [], (d) => d.count);
  for (const [key, count] of countByKey(baseline?.exemptions ?? [], (e) => e.count)) allowed.set(key, (allowed.get(key) ?? 0) + count);
  const current = countByKey(findings);
  for (const [key, count] of current) {
    const limit = allowed.get(key) ?? 0;
    if (count <= limit) continue;
    const lines = findings.filter((f) => keyOf(f) === key).map((f) => `${f.path}:${f.line}`).join(', ');
    const message = findings.find((f) => keyOf(f) === key).message;
    failures.push(`new ${key} (${limit} -> ${count}) at ${lines}: ${message}`);
  }
  for (const [key, limit] of allowed) {
    const count = current.get(key) ?? 0;
    if (count < limit) failures.push(`stale baseline ${key} (${limit} -> ${count}); run write-baseline to shrink it`);
  }
  return failures;
}

/** Run the gate. Without a baseline every finding fails, which is the zero-debt default. */
export function checkHygiene({ projectRoot, configPath = DEFAULT_CONFIG, baseRef, today = new Date(), env = process.env }) {
  const config = loadConfig(projectRoot, configPath);
  const { filesScanned, findings } = collectFindings(projectRoot, config);
  const baseline = readBaseline(projectRoot, config.baseline);
  const failures = [];
  const warnings = [];

  if (baseline) {
    const metadata = metadataProblems(baseline, today);
    failures.push(...metadata.problems);
    warnings.push(...metadata.warnings);
    const ref = baseRef ?? config.baseRef;
    if (!ref) failures.push('baseRef is required to compare the baseline with its merge-base version');
    else {
      const base = readBaselineAtMergeBase(projectRoot, ref, config.baseline);
      if (base) {
        const growth = baselineGrowth(base, baseline);
        if (growth.length && env[GROWTH_ENV]) warnings.push(`baseline growth allowed (${env[GROWTH_ENV]}): ${growth.join('; ')}`);
        else failures.push(...growth.map((g) => `baseline grew versus merge-base: ${g}`));
        if (filesScanned < base.scope.fileCount * COLLAPSE_RATIO) {
          failures.push(`scan collapsed: ${filesScanned} files versus ${base.scope.fileCount} at merge-base`);
        }
      }
    }
  }
  if (filesScanned === 0) failures.push('scan matched no files; check the include globs');
  failures.push(...compareWithFindings(baseline, findings));
  return { ok: failures.length === 0, filesScanned, totals: totalsByRule(findings), failures, warnings };
}

/** Record current findings as debt. Refuses to grow an existing baseline unless a reason is given. */
export function writeBaseline({ projectRoot, configPath = DEFAULT_CONFIG, metadata = {}, env = process.env }) {
  const config = loadConfig(projectRoot, configPath);
  const { filesScanned, findings } = collectFindings(projectRoot, config);
  const previous = readBaseline(projectRoot, config.baseline);
  const exemptions = previous?.exemptions ?? [];
  const exempt = countByKey(exemptions, (e) => e.count);
  const debt = [...countByKey(findings)]
    .map(([key, count]) => {
      const [rule, path, symbol] = key.split('|');
      return { rule, path, symbol, count: count - (exempt.get(key) ?? 0) };
    })
    .filter((d) => d.count > 0)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const meta = Object.fromEntries(METADATA.map((field) => [field, metadata[field] ?? previous?.[field]]));
  const missing = METADATA.filter((field) => !meta[field]);
  if (missing.length) throw new Error(`write-baseline needs ${missing.map((m) => `--${m.replace('_', '-')}`).join(', ')}`);
  const next = { version: 1, ...meta, scope: { include: config.include, exclude: config.exclude, fileCount: filesScanned },
    total: debt.reduce((sum, d) => sum + d.count, 0), debt, exemptions };
  const growth = previous ? baselineGrowth(previous, next) : [];
  if (growth.length && !env[GROWTH_ENV]) {
    throw new Error(`refusing to grow the baseline (set ${GROWTH_ENV}=<reason> to allow):\n${growth.join('\n')}`);
  }
  writeTextAtomically(join(projectRoot, config.baseline), `${JSON.stringify(next, null, 2)}\n`);
  return { written: config.baseline, total: next.total, totals: totalsByRule(findings), growth };
}
