#!/usr/bin/env node
// size-budget: 575 legacy size at the 2026-10-20 seed; split or shrink before raising this budget

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizedGitEnv } from '../../git-environment.mjs';

// The caller owns root selection. CWD is the standalone CLI default; this
// module never infers a consumer root from its own import.meta.url.
let REPO_ROOT = process.cwd();
let HISTORY_ROOT = join(REPO_ROOT, '.vibe-coding', 'history');
const INDEX_NAME = 'index.md';
const IGNORED_MARKDOWN_FILES = new Set([INDEX_NAME, 'README.md']);
const REQUIRED_FIELDS = [
  'title',
  'date',
  'author',
  'purpose',
  'category',
  'scope',
  'status',
  'related_files',
  'redaction',
];
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Exported for reuse by the memory-note tooling. Both knowledge stores enforce
// the identical secret contract, so the patterns live here once instead of being
// copied — a second copy would drift the moment one side gains a new pattern.
export const SAFE_SECRET_VALUES = new Set(['<set>', '<empty>', '<redacted>']);
export const SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[\s"'`([{,])([A-Za-z0-9_.-]*(?:secret|token|api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|pwd|credential|credentials|authorization|auth[_-]?header)[A-Za-z0-9_.-]*)\s*[:=]\s*(.+)$/i;
export const URI_CREDENTIAL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]+)@[^/\s]+/gi;
export const RAW_SECRET_PATTERNS = [
  {
    label: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi,
  },
  {
    label: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    label: 'OpenAI-style key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: 'AWS access key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
];
let trackedRepoPathsCache;
let configuredTrackedFiles = null;
let historyProfile = {};

/** Inject consumer-owned environment policies while retaining shared checks. */
export function configureHistoryIndex({ repoRoot, historyRoot, trackedFiles: trackedFilesImpl, secretPatterns = [], profile } = {}) {
  if (repoRoot) REPO_ROOT = resolve(repoRoot);
  if (historyRoot) HISTORY_ROOT = resolve(historyRoot);
  else if (repoRoot) HISTORY_ROOT = join(REPO_ROOT, '.vibe-coding', 'history');
  if (Object.hasOwn(arguments[0] ?? {}, 'trackedFiles')) configuredTrackedFiles = trackedFilesImpl ?? null;
  if (profile) historyProfile = { ...profile };
  for (const item of secretPatterns) {
    if (!RAW_SECRET_PATTERNS.some(({ label }) => label === item.label)) RAW_SECRET_PATTERNS.push(item);
  }
  trackedRepoPathsCache = undefined;
}

function trackedFiles({ rootDir }) {
  if (configuredTrackedFiles) return configuredTrackedFiles({ rootDir });
  const result = spawnSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8', env: sanitizedGitEnv() });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit code ${result.status}, stderr: ${result.stderr}`;
    throw new Error(`git ls-files failed: ${detail}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

function exitDrained(code) {
  process.exitCode = code;
}

class HistoryError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'HistoryError';
    this.exitCode = exitCode;
  }
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}

function readOptionalText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeTextAtomically(path, content) {
  // A sibling temp file plus rename prevents path replacement between compare and write.
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function usage() {
  return `Usage: pnpm history:index [--month YYYY-MM]
       pnpm check:history [--month YYYY-MM]

Commands:
  sync   Generate .vibe-coding/history/YYYY-MM/index.md
  check  Verify generated index.md files are current
`;
}

function parseArgs(argv) {
  const options = { command: undefined, months: [], help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--month') {
      index += 1;
      if (!argv[index]) throw new HistoryError('missing value for --month', 2);
      options.months.push(argv[index]);
    } else if (arg.startsWith('--month=')) {
      options.months.push(arg.slice('--month='.length));
    } else if (arg.startsWith('--')) {
      throw new HistoryError(`unknown option: ${arg}`, 2);
    } else if (!options.command) {
      options.command = arg;
    } else {
      throw new HistoryError(`unexpected argument: ${arg}`, 2);
    }
  }

  if (options.help) return options;
  if (!options.command) throw new HistoryError('missing command: sync or check', 2);
  if (!['sync', 'check'].includes(options.command)) {
    throw new HistoryError(`unknown command: ${options.command}`, 2);
  }

  options.months = uniqueSorted(options.months);
  for (const month of options.months) {
    if (!MONTH_PATTERN.test(month)) {
      throw new HistoryError(`invalid --month value: ${month}; expected YYYY-MM`, 2);
    }
  }

  return options;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toRepoRelative(absPath) {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

export function readMonthDirs({ historyRoot = HISTORY_ROOT } = {}) {
  if (!existsSync(historyRoot)) return [];
  if (!statSync(historyRoot).isDirectory()) {
    throw new HistoryError(`history root is not a directory: ${toRepoRelative(historyRoot)}`);
  }

  const directories = readdirSync(historyRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  const invalidDirectories = directories
    .filter((entry) => !MONTH_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (invalidDirectories.length > 0) {
    throw new HistoryError(
      `${toRepoRelative(historyRoot)}: invalid history directory name(s): ${invalidDirectories.join(', ')}; does not match expected YYYY-MM format`,
    );
  }

  return directories
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function monthDirFor(month) {
  return join(HISTORY_ROOT, month);
}

async function ensureMonthDir(month, { create }) {
  const dir = monthDirFor(month);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      throw new HistoryError(`history month path is not a directory: ${toRepoRelative(dir)}`);
    }
    return dir;
  }

  if (create) {
    await mkdir(dir, { recursive: true });
    return dir;
  }

  throw new HistoryError(`missing history month directory: ${toRepoRelative(dir)}`);
}

function listEntryFiles(monthDir) {
  return readdirSync(monthDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (IGNORED_MARKDOWN_FILES.has(entry.name)) return false;
      return extname(entry.name).toLowerCase() === '.md';
    })
    .map((entry) => join(monthDir, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

export function parseFrontmatter(text, filePath) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');

  if (lines[0] !== '---') {
    throw new HistoryError(`${toRepoRelative(filePath)}: missing YAML frontmatter`);
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (endIndex === -1) {
    throw new HistoryError(`${toRepoRelative(filePath)}: unterminated YAML frontmatter`);
  }

  const frontmatter = parseSimpleYaml(lines.slice(1, endIndex), filePath);
  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join('\n'),
  };
}

function parseSimpleYaml(lines, filePath) {
  const data = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) {
      throw new HistoryError(`${toRepoRelative(filePath)}: unsupported frontmatter line: ${line}`);
    }

    const key = match[1];
    const rawValue = match[2] ?? '';
    if (Object.hasOwn(data, key)) {
      throw new HistoryError(`${toRepoRelative(filePath)}: duplicate frontmatter key: ${key}`);
    }

    if (rawValue.trim() === '') {
      const items = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const itemMatch = lines[nextIndex].match(/^\s*-\s+(.*)$/);
        if (!itemMatch) break;
        items.push(parseYamlScalar(itemMatch[1]));
        nextIndex += 1;
      }
      if (items.length > 0) {
        data[key] = items;
        index = nextIndex - 1;
      } else {
        data[key] = '';
      }
      continue;
    }

    data[key] = parseYamlValue(rawValue);
  }

  return data;
}

function parseYamlValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseYamlScalar(item.trim()));
  }
  return parseYamlScalar(trimmed);
}

function parseYamlScalar(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function fieldToText(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}

function isPresent(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => isPresent(item));
  return String(value ?? '').trim().length > 0;
}

function validateRequiredFields(entry) {
  const missing = REQUIRED_FIELDS.filter((field) => !isPresent(entry.frontmatter[field]));
  if (missing.length > 0) {
    throw new HistoryError(
      `${entry.relPath}: missing required frontmatter field(s): ${missing.join(', ')}`,
    );
  }
}

// Consumer tooling can supply a tracked-files provider for environments where
// a Git checkout is represented by an external file manifest.
function readTrackedRepoPaths() {
  if (trackedRepoPathsCache) return trackedRepoPathsCache;
  try {
    trackedRepoPathsCache = new Set(trackedFiles({ rootDir: REPO_ROOT }));
  } catch (error) {
    throw new HistoryError(
      `unable to determine git-tracked files for related_files validation: ${error.message}`,
    );
  }
  return trackedRepoPathsCache;
}

export function validateRelatedFiles(
  entry,
  { trackedPaths = readTrackedRepoPaths(), repoRoot = REPO_ROOT } = {},
) {
  const relatedFiles = entry.frontmatter.related_files;
  if (!Array.isArray(relatedFiles) || relatedFiles.length === 0) {
    throw new HistoryError(`${entry.relPath}: related_files must be a non-empty list`);
  }

  for (const value of relatedFiles) {
    const repoPath = String(value ?? '');
    const segments = repoPath.split('/');
    if (
      !repoPath ||
      repoPath !== repoPath.trim() ||
      repoPath.includes('\\') ||
      repoPath.startsWith('/') ||
      repoPath.startsWith('./') ||
      /^[A-Za-z]:/.test(repoPath) ||
      segments.includes('..')
    ) {
      throw new HistoryError(`${entry.relPath}: related_files entry ${JSON.stringify(repoPath)} fails path-safety checks`);
    }

    const absolutePath = resolve(repoRoot, repoPath);
    if (!existsSync(absolutePath)) {
      throw new HistoryError(`${entry.relPath}: related_files entry ${JSON.stringify(repoPath)} does not exist on disk`);
    }
    const tracked = statSync(absolutePath).isDirectory()
      ? [...trackedPaths].some((trackedPath) => trackedPath.startsWith(`${repoPath}/`))
      : trackedPaths.has(repoPath);
    if (!tracked) {
      throw new HistoryError(
        `${entry.relPath}: related_files entry ${JSON.stringify(repoPath)} exists but is not tracked by git`,
      );
    }
  }
}

export function expectedDateFromFile(month, fileName) {
  const stem = fileName.replace(/\.md$/i, '');
  const fullDate = stem.match(/^(\d{4}-\d{2}-\d{2})(?:$|[-_].*)/);
  if (fullDate) return fullDate[1];

  const dayOnly = stem.match(/^(\d{2})(?:$|[-_].*)/);
  if (dayOnly) return `${month}-${dayOnly[1]}`;

  return null;
}

function validateEntryDate(entry, month) {
  const date = fieldToText(entry.frontmatter.date).trim();
  if (!DATE_PATTERN.test(date)) {
    throw new HistoryError(`${entry.relPath}: date must use YYYY-MM-DD`);
  }
  if (!date.startsWith(`${month}-`)) {
    throw new HistoryError(
      `${entry.relPath}: date ${date} does not start with month directory name ${month}`,
    );
  }

  const expectedDate = expectedDateFromFile(month, entry.fileName);
  if (!expectedDate) {
    throw new HistoryError(
      `${entry.relPath}: filename must start with YYYY-MM-DD or DD to match the date field`,
    );
  }
  if (date !== expectedDate) {
    throw new HistoryError(
      `${entry.relPath}: date ${date} does not match date derived from file name ${expectedDate}`,
    );
  }
}

function normalizeSecretValue(rawValue) {
  let value = rawValue.trim();
  value = value.replace(/[,\]}]+$/, '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('`') && value.endsWith('`'))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (/^Bearer\s+/i.test(value)) value = value.replace(/^Bearer\s+/i, '').trim();
  return value;
}

function isSafeSecretValue(value) {
  return SAFE_SECRET_VALUES.has(normalizeSecretValue(value));
}

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

// `entry` only needs `{ relPath }`; callers outside this module (memory notes)
// construct that minimal shape rather than a full history entry.
// Throws HistoryError on the FIRST hit — callers that need a complete violation
// list must invoke this per file and collect, not once over a whole tree.
export function validateNoSecrets(entry, rawText) {
  const normalized = normalizeText(rawText);
  const lines = normalized.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(SECRET_ASSIGNMENT_PATTERN);
    if (!match) continue;

    const key = match[1];
    const value = match[2];
    if (!isSafeSecretValue(value)) {
      throw new HistoryError(
        `${entry.relPath}:${index + 1}: secret-like field "${key}" must use <set>, <empty>, <redacted>, or <redacted>`,
      );
    }
  }

  for (const match of normalized.matchAll(URI_CREDENTIAL_PATTERN)) {
    const passwordValue = match[1];
    if (!isSafeSecretValue(passwordValue)) {
      throw new HistoryError(
        `${entry.relPath}:${lineNumberForOffset(normalized, match.index ?? 0)}: URL credential must be redacted`,
      );
    }
  }

  for (const rawPattern of RAW_SECRET_PATTERNS) {
    for (const match of normalized.matchAll(rawPattern.pattern)) {
      throw new HistoryError(
        `${entry.relPath}:${lineNumberForOffset(normalized, match.index ?? 0)}: secret-like content detected (${rawPattern.label}); redact it first`,
      );
    }
  }
}

function readEntry(filePath, month) {
  const rawText = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(rawText, filePath);
  const relPath = toRepoRelative(filePath);
  const entry = {
    filePath,
    fileName: basename(filePath),
    relPath,
    frontmatter,
    body,
  };

  validateRequiredFields(entry);
  validateEntryDate(entry, month);
  validateRelatedFiles(entry);
  validateNoSecrets(entry, rawText);
  return entry;
}

export function escapeTableCell(value) {
  // Escape the escape character FIRST. Escaping "|" before "\" lets a value
  // ending in "\" absorb the escape this adds as an *escaped backslash* (`\\`)
  // when Markdown renders it, leaving the following "|" unescaped and forging
  // extra table cells. Same fix + rationale as escapeTableCell in
  // js/incomplete-sanitization; a real defect, not a naming false positive.
  return fieldToText(value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replaceAll('|', '\\|');
}

export function escapeMarkdownLinkText(value) {
  // Escape the escape character FIRST, same reasoning as escapeTableCell above:
  // escaping "[" / "]" before "\" lets a value containing "\[" or "\]" absorb
  // the escape this adds, leaving the bracket unescaped and breaking (or
  // extending) the rendered Markdown link's "[...]" text span.
  return fieldToText(value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

export function linkDestination(fileName) {
  return `./${encodeURI(fileName).replaceAll('(', '%28').replaceAll(')', '%29')}`;
}

function renderIndex(month, entries) {
  const lines = [
    `# History Index - ${month}`,
    '',
    `<!-- GENERATED by ${historyProfile.generatedBy ?? 'scripts/history-index.mjs'}. Run \`${historyProfile.syncCommand ?? 'node history-index.mjs sync'}\` to update. -->`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('_No history entries._', '');
    return lines.join('\n');
  }

  lines.push('| Date | Entry | Category | Scope | Status | Summary |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const entry of entries) {
    const { frontmatter } = entry;
    lines.push(
      [
        escapeTableCell(frontmatter.date),
        `[${escapeMarkdownLinkText(frontmatter.title)}](${linkDestination(entry.fileName)})`,
        escapeTableCell(frontmatter.category),
        escapeTableCell(frontmatter.scope),
        escapeTableCell(frontmatter.status),
        escapeTableCell(frontmatter.purpose),
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function buildMonthIndex(month) {
  const monthDir = monthDirFor(month);
  const entries = listEntryFiles(monthDir)
    .map((filePath) => readEntry(filePath, month))
    .sort((a, b) => {
      const dateCompare = fieldToText(a.frontmatter.date).localeCompare(
        fieldToText(b.frontmatter.date),
      );
      if (dateCompare !== 0) return dateCompare;
      return a.fileName.localeCompare(b.fileName);
    });

  return {
    month,
    indexPath: join(monthDir, INDEX_NAME),
    content: renderIndex(month, entries),
    entries,
  };
}

async function resolveMonths(options) {
  // Validate the whole root even for a selected month so malformed nested
  // layouts cannot hide behind a narrow index/check invocation.
  const discoveredMonths = readMonthDirs();
  if (options.months.length > 0) return options.months;
  return discoveredMonths;
}

async function runSyncCommand(options) {
  const months = await resolveMonths(options);
  if (months.length === 0) {
    console.log('[history] no history month directories found');
    return 0;
  }

  let written = 0;
  for (const month of months) {
    await ensureMonthDir(month, { create: options.months.includes(month) });
    const index = buildMonthIndex(month);
    const currentText = readOptionalText(index.indexPath);
    const current = currentText === undefined ? undefined : normalizeText(currentText);
    if (current !== index.content) {
      writeTextAtomically(index.indexPath, index.content);
      written += 1;
      console.log(
        `[history] wrote ${toRepoRelative(index.indexPath)} (${index.entries.length} entries)`,
      );
    } else {
      console.log(
        `[history] current ${toRepoRelative(index.indexPath)} (${index.entries.length} entries)`,
      );
    }
  }

  console.log(`[history] sync passed (${months.length} month(s), ${written} updated)`);
  return 0;
}

async function runCheckCommand(options) {
  const months = await resolveMonths(options);
  if (months.length === 0) {
    console.log('[history] no history month directories found');
    return 0;
  }

  const stale = [];
  for (const month of months) {
    await ensureMonthDir(month, { create: false });
    const index = buildMonthIndex(month);
    const relPath = toRepoRelative(index.indexPath);
    if (!existsSync(index.indexPath)) {
      stale.push(`${relPath} is missing`);
      continue;
    }

    const current = normalizeText(readFileSync(index.indexPath, 'utf8'));
    if (current !== index.content) {
      stale.push(`${relPath} differs from generated output`);
    }
  }

  if (stale.length > 0) {
    console.error('[history] check failed; run `pnpm history:index` to refresh generated indexes.');
    for (const item of stale) console.error(`  - ${item}`);
    return 1;
  }

  console.log(`[history] check passed (${months.length} month(s))`);
  return 0;
}

export function runSync(historyRoot = HISTORY_ROOT, months = []) {
  configureHistoryIndex({ historyRoot, repoRoot: dirname(dirname(historyRoot)) });
  const selected = [...months];
  const activeMonths = selected.length ? selected : readMonthDirs({ historyRoot });
  const written = [];
  for (const month of activeMonths) {
    const monthDir = join(historyRoot, month);
    if (!existsSync(monthDir)) mkdirSync(monthDir, { recursive: true });
    const index = buildMonthIndex(month);
    const current = readOptionalText(index.indexPath);
    const wrote = current !== index.content;
    if (wrote) writeTextAtomically(index.indexPath, index.content);
    written.push({ month, entryCount: index.entries.length, wrote, indexPath: index.indexPath });
  }
  return written;
}

export function runCheck(historyRoot = HISTORY_ROOT, months = []) {
  configureHistoryIndex({ historyRoot, repoRoot: dirname(dirname(historyRoot)) });
  const selected = [...months];
  const issues = [];
  let activeMonths;
  try {
    activeMonths = selected.length ? selected : readMonthDirs({ historyRoot });
  } catch (error) {
    if (error instanceof HistoryError) return { ok: false, errors: [error.message] };
    throw error;
  }
  for (const month of activeMonths) {
    const index = buildMonthIndex(month);
    const current = readOptionalText(index.indexPath);
    if (current !== index.content) issues.push(`${toRepoRelative(index.indexPath)} is stale`);
  }
  return { ok: issues.length === 0, errors: issues };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[history] ${error.message}`);
    console.error(usage());
    return error instanceof HistoryError ? error.exitCode : 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    if (options.command === 'sync') return await runSyncCommand(options);
    if (options.command === 'check') return await runCheckCommand(options);
    throw new HistoryError(`unknown command: ${options.command}`, 2);
  } catch (error) {
    console.error(`[history] ${error.message}`);
    return error instanceof HistoryError ? error.exitCode : 1;
  }
}

if (isMainModule(import.meta.url)) {
  exitDrained(await main());
}
