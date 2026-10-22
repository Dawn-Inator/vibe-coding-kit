#!/usr/bin/env node
// size-budget: 575 legacy size at the 2026-10-20 seed; split or shrink before raising this budget
// Memory notes index + contract checker.
//
// Shared memory-note indexing runtime.
// The two stores deliberately differ: history shards by TIME (YYYY-MM/, entries
// frozen once written), memory shards by MODULE (entries are rewritten in place
// with supersede markers). Sharding memory by month would move a note across
// directories on every update and break its wikilinks.
//
// Pure helpers (frontmatter parsing, atomic writes, secret patterns) are imported
// from the history module rather than copied — a second copy would drift the
// moment one side gains a new pattern.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import {
  RAW_SECRET_PATTERNS,
  SAFE_SECRET_VALUES,
  SECRET_ASSIGNMENT_PATTERN,
  URI_CREDENTIAL_PATTERN,
  parseFrontmatter,
  writeTextAtomically,
} from '../history/history-index.mjs';

// Consumers pass roots and classifications explicitly. The standalone CLI
// defaults to CWD; the kit's own path is never treated as a consumer root.
let REPO_ROOT = process.cwd();
let MEMORY_ROOT = join(REPO_ROOT, '.vibe-coding', 'memory');

// The index is TWO files, and the split is forced by a measured harness constraint.
//
// MEMORY.md is the only filename the Claude Code harness loads on its own at
// session start, and it loads at most the first 200 lines / 25KB — past that the
// write still succeeds but the overflow is DROPPED on the next load, silently.
// (The pre-migration private store was already 26471 bytes, i.e. already being
// truncated.) 194 notes cannot each get a line inside that budget: ~132 bytes per
// note, most of which the markdown link consumes.
//
// So MEMORY.md carries a compact module map — enough for the model to know a note
// exists and decide to open it — and CATALOG.md carries the full per-note table
// with descriptions, read on demand like any other file.
export const BOOT_INDEX_NAME = 'MEMORY.md';
export const CATALOG_NAME = 'CATALOG.md';
export const BOOT_INDEX_MAX_LINES = 200;
export const BOOT_INDEX_MAX_BYTES = 25 * 1024;
const STRUCTURE_FILES = new Set([BOOT_INDEX_NAME, CATALOG_NAME, 'README.md']);

// Fixed module whitelist. Adding a module is a deliberate governance act that must
// edit this list — otherwise the module split silently degrades back into a flat
// dumping ground within a few months.
let MODULES = [
  ['general', 'General notes'],
  ['workflow', 'Workflow notes'],
];
let MODULE_NAMES = new Set(MODULES.map(([name]) => name));
let MODULE_LABELS = new Map(MODULES);

let memoryProfile = {};
export function configureMemoryIndex({ repoRoot, memoryRoot, modules, profile } = {}) {
  if (repoRoot) REPO_ROOT = resolve(repoRoot);
  if (memoryRoot) MEMORY_ROOT = resolve(memoryRoot);
  else if (repoRoot) MEMORY_ROOT = join(REPO_ROOT, '.vibe-coding', 'memory');
  if (modules) {
    MODULES = modules.map((item) => [...item]);
    MODULE_NAMES = new Set(MODULES.map(([name]) => name));
    MODULE_LABELS = new Map(MODULES);
  }
  if (profile) memoryProfile = { ...profile };
}

const TYPES = new Set(['project', 'feedback']);
const STATUSES = new Set(['active', 'superseded']);
const REDACTIONS = new Set(['none', 'redacted', 'safe-placeholders']);
const NAME_PATTERN = /^(project|feedback)_[a-z0-9_]+$/;
const UPDATED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A memory note corrects a judgement, so it must end in an actionable instruction.
const HOW_TO_APPLY = /^\s*\*\*How to apply:?\*\*/m;
// History body sections. A memory note using them means the two stores are being
// conflated — F1 structural mutual exclusion.
const HISTORY_SECTIONS = /^##\s+(Summary|Changed|Verification|Follow-up)\s*$/m;

const SECRET_ALLOW = /<!--\s*secret-scan:allow\s+(.+?)\s*-->/;

class MemoryError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'MemoryError';
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage: pnpm memory:index | pnpm check:memory

  sync    regenerate .vibe-coding/memory/index.md
  check   validate every note against the memory contract
`;
}

// Report paths as `.vibe-coding/memory/<module>/<file>` regardless of which root
// we were pointed at, so messages stay stable under test injection.
function displayPath(moduleName, fileName) {
  return moduleName
    ? `.vibe-coding/memory/${moduleName}/${fileName}`
    : `.vibe-coding/memory/${fileName}`;
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}

function normalizeSecretValue(rawValue) {
  let value = rawValue.trim().replace(/[,\]}]+$/, '').trim();
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

/**
 * Memory-specific secret contract. Differs from history's validateNoSecrets in
 * exactly one way, and the reason is measured rather than assumed:
 *
 * Running history's whole-file assignment check over the 199 seed notes flagged
 * 12 files, and ALL 12 were false positives — `SECRET_ASSIGNMENT_PATTERN` ends in
 * `(.+)$`, so in prose a line like "token：<一整段中文解释>" parses as an
 * assignment whose "value" is the rest of the sentence (measured lengths up to
 * 932 chars). The flagged keys were sshd/sudoers/git-config option names
 * (PasswordAuthentication, NOPASSWD, credential.helper), a CLI flag (--token),
 * a Vault config key (secret_id_ttl) and even a filename
 * (security-secret-gates.test.mjs) — identifier names, never values. This is the
 * same failure mode [[project_codeql_flags_names_not_values]] records.
 *
 * So the assignment check is scoped to fenced code blocks, where `key: value`
 * really is an assignment. Restricting it dropped 12 hits to 1. The two checks
 * that carry the actual protection — RAW_SECRET_PATTERNS (private key blocks,
 * GitHub/OpenAI tokens, JWTs, AWS/Aliyun/Slack keys) and URI_CREDENTIAL_PATTERN —
 * still run over the whole file and produced ZERO false positives on the seed set.
 *
 * This narrows memory's own scope only; history's contract is untouched.
 */
function collectSecretFindings(relPath, rawText) {
  const findings = [];
  const normalized = normalizeText(rawText);
  const lines = normalized.split('\n');

  for (const raw of RAW_SECRET_PATTERNS) {
    const pattern = new RegExp(raw.pattern.source, raw.pattern.flags);
    for (const match of normalized.matchAll(pattern)) {
      const line = normalized.slice(0, match.index ?? 0).split('\n').length;
      findings.push(`${relPath}:${line}: secret-like content (${raw.label}); redact it first`);
    }
  }

  const uri = new RegExp(URI_CREDENTIAL_PATTERN.source, URI_CREDENTIAL_PATTERN.flags);
  for (const match of normalized.matchAll(uri)) {
    if (isSafeSecretValue(match[1])) continue;
    const line = normalized.slice(0, match.index ?? 0).split('\n').length;
    findings.push(`${relPath}:${line}: URL credential must be redacted`);
  }

  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const match = line.match(SECRET_ASSIGNMENT_PATTERN);
    if (!match || isSafeSecretValue(match[2])) continue;
    // An explicit, reviewable exemption on the line itself or the one above it.
    const previous = index > 0 ? lines[index - 1] : '';
    if (SECRET_ALLOW.test(line) || SECRET_ALLOW.test(previous)) continue;
    findings.push(
      `${relPath}:${index + 1}: secret-like field "${match[1]}" in a code block must use ` +
        `<set>, <empty>, <redacted>, or carry <!-- secret-scan:allow reason -->`,
    );
  }

  return findings;
}

/**
 * Layout scan. Structural defects are COLLECTED, not thrown: throwing here would
 * abort the whole check on the first stray directory and hide every other problem,
 * which is exactly the "only the first failure is visible" trap this repo keeps
 * hitting. A genuinely missing root is still fatal — there is nothing to report on.
 */
function listModuleDirs(memoryRoot = MEMORY_ROOT) {
  if (!existsSync(memoryRoot) || !statSync(memoryRoot).isDirectory()) {
    throw new MemoryError('missing .vibe-coding/memory — create it before running memory tooling');
  }
  const modules = [];
  const problems = [];
  for (const dirent of readdirSync(memoryRoot, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (MODULE_NAMES.has(dirent.name)) {
        modules.push(dirent.name);
      } else {
        problems.push(
          `.vibe-coding/memory/${dirent.name}/: unknown module directory; ` +
            `allowed: ${[...MODULE_NAMES].sort().join(', ')} ` +
            '(adding one requires editing MODULES in manage-memory-index.mjs)',
        );
      }
      continue;
    }
    if (!dirent.isFile()) continue;
    if (STRUCTURE_FILES.has(dirent.name)) continue;
    if (dirent.name.endsWith('.md')) {
      problems.push(
        `.vibe-coding/memory/${dirent.name}: notes must live in a module directory, ` +
          'not at the memory root (only README.md and index.md belong there)',
      );
    }
  }
  return { modules: modules.sort(), problems };
}

function listNoteFiles(moduleName, memoryRoot = MEMORY_ROOT) {
  const dir = join(memoryRoot, moduleName);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(dir, name));
}

function fieldToText(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined || value === null ? '' : String(value);
}

/** canonical_source may be a single scalar or a YAML list; normalise to entries. */
function asList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function isPresent(value) {
  if (Array.isArray(value)) return value.length > 0 && value.some((item) => String(item).trim());
  return value !== undefined && value !== null && String(value).trim() !== '';
}

// Keys the harness writes on its own that this schema deliberately does not keep.
// `node_type` is already implied by the module directory; `originSessionId` points
  // at a transcript on one machine, which is an exact shape memory notes should avoid
// forbids -- a pointer nobody else on the team can follow.
const HARNESS_DROPPED_KEYS = Object.freeze(['node_type', 'originSessionId']);

// `metadata.<key>` folds up to `<key>`; `modified` becomes `updated` (date only).
const HARNESS_FOLDED_KEYS = Object.freeze(['type', 'status', 'redaction', 'supersedes', 'description']);

/**
 * Fold the harness's own memory frontmatter into this repo's flat schema.
 *
 * The native memory format nests under `metadata:` (`metadata.type`, plus
 * `node_type` / `originSessionId` / `modified` that it injects). The flat parser
 * borrowed from the history side rejects an indented line outright, so before
 * this existed, a note written through the harness could not even be READ.
 *
 * That mattered because `~/.claude/projects/<slug>/memory` is a symlink into
 * `.vibe-coding/memory/`: writing a note through the harness is not an exotic
 * path, it is the DEFAULT one, and it landed a red gate in whichever worktree
 * happened to hold the symlink. Measured 2026-08-08 from another session.
 *
 * Returns the canonical text plus what had to change, so `check` can name the
 * problem and `sync` can repair it -- the same split already used for the index
 * files themselves.
 */
export function foldHarnessFrontmatter(rawText) {
  const lines = rawText.split('\n');
  if (lines[0]?.trim() !== '---') return { text: rawText, changed: false, notes: [] };
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 0) return { text: rawText, changed: false, notes: [] };

  const flat = [];
  const folded = [];
  const dropped = [];
  let inMetadata = false;

  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim()) continue;
    if (/^metadata:\s*$/.test(line.trim())) {
      inMetadata = true;
      folded.push('metadata');
      continue;
    }
    const indented = /^\s+\S/.test(line);
    if (!indented) inMetadata = false;

    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      // A list item or anything else this folder does not understand: keep it
      // verbatim rather than guessing, so nothing is silently discarded.
      flat.push(line);
      continue;
    }

    const [, key, value] = match;
    if (HARNESS_DROPPED_KEYS.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (key === 'modified') {
      // Only fold it in as `updated` if the note has no `updated` of its own.
      if (!lines.slice(1, endIndex).some((entry) => /^updated:/.test(entry.trim()))) {
        flat.push(`updated: '${value.replace(/^['"]|['"]$/g, '').slice(0, 10)}'`);
        folded.push('modified -> updated');
      } else {
        dropped.push('modified');
      }
      continue;
    }
    if (inMetadata && HARNESS_FOLDED_KEYS.includes(key)) {
      flat.push(`${key}: ${value}`);
      folded.push(`metadata.${key} -> ${key}`);
      continue;
    }
    if (inMetadata) {
      // An unrecognized nested key. Lift it rather than drop it -- losing a
      // field the author meant to keep is worse than carrying one extra key,
      // and `check` will name it if it is not part of the schema.
      flat.push(`${key}: ${value}`);
      folded.push(`metadata.${key} -> ${key}`);
      continue;
    }
    flat.push(line.trim());
  }

  if (!folded.length && !dropped.length) return { text: rawText, changed: false, notes: [] };
  const rebuilt = ['---', ...flat, '---', ...lines.slice(endIndex + 1)].join('\n');
  const notes = [];
  if (folded.length) notes.push(`folded ${folded.join(', ')}`);
  if (dropped.length) notes.push(`dropped ${[...new Set(dropped)].join(', ')}`);
  return { text: rebuilt, changed: true, notes };
}

function readNote(filePath, moduleName) {
  const rawText = readFileSync(filePath, 'utf8');
  // `join()` uses the host separator. Splitting only on `/` turns every
  // Windows absolute path into the filename, corrupting the stem and all
  // diagnostics (for example `.vibe-coding/memory/agent/C:\\Users\\...`).
  const fileName = basename(filePath);
  const relPath = displayPath(moduleName, fileName);
  const stem = fileName.replace(/\.md$/, '');

  // Try the canonical shape first, then the harness shape. Recovering the parse
  // is what lets validateNote run at all: before this, a harness-written note
  // failed on frontmatter, so its OTHER problems (a missing `**How to apply:**`,
  // an absent `canonical_source`) stayed hidden until the first was fixed -- one
  // round trip per defect.
  let parsed;
  let harness = null;
  try {
    parsed = parseFrontmatter(rawText, filePath);
  } catch (error) {
    const folded = foldHarnessFrontmatter(rawText);
    if (!folded.changed) throw error;
    parsed = parseFrontmatter(folded.text, filePath);
    harness = { canonicalText: folded.text, notes: folded.notes };
  }

  return { relPath, stem, module: moduleName, ...parsed, rawText, harness };
}

function validateNote(note) {
  const findings = [];
  const fm = note.frontmatter;
  const get = (key) => (fm instanceof Map ? fm.get(key) : fm?.[key]);

  const name = fieldToText(get('name')).trim();
  const description = fieldToText(get('description')).trim();
  const type = fieldToText(get('type')).trim();
  const status = fieldToText(get('status')).trim() || 'active';
  const redaction = fieldToText(get('redaction')).trim();
  const updated = fieldToText(get('updated')).trim();
  const canonicalSource = get('canonical_source');

  if (note.harness) {
    // Reported, not tolerated: `check` names it and `sync` repairs it, the same
    // contract the index files already follow. Leaving it alone would let two
    // frontmatter shapes coexist in one library forever.
    findings.push(
      `${note.relPath}: frontmatter uses the harness memory shape (${note.harness.notes.join('; ')}) — run "pnpm memory:index" to normalize it`,
    );
  }

  if (!name) {
    findings.push(`${note.relPath}: frontmatter "name" is required`);
  } else if (name !== note.stem) {
    // wikilinks resolve by basename, so a mismatched name field silently breaks
    // the link graph rather than erroring anywhere.
    findings.push(`${note.relPath}: frontmatter name "${name}" must equal the filename stem "${note.stem}"`);
  } else if (!NAME_PATTERN.test(name)) {
    findings.push(`${note.relPath}: name must match <project|feedback>_<lower_snake_case>`);
  }

  if (!description) {
    findings.push(`${note.relPath}: frontmatter "description" is required (it IS the retrieval hook)`);
  }

  if (!TYPES.has(type)) {
    findings.push(`${note.relPath}: type must be one of ${[...TYPES].join(' | ')} (got "${type}")`);
  } else if (name && !name.startsWith(`${type}_`)) {
    findings.push(`${note.relPath}: filename prefix must match type "${type}"`);
  }

  if (!STATUSES.has(status)) {
    findings.push(`${note.relPath}: status must be one of ${[...STATUSES].join(' | ')}`);
  }
  if (status === 'superseded' && !isPresent(get('supersedes')) && !/⚠️/.test(note.body)) {
    findings.push(`${note.relPath}: superseded notes must point at the replacement or explain the retraction`);
  }

  // The execution point of the anti-duplication rule: a project note corrects a
  // fact that some Doc/Skill/code owns. Being unable to name that owner means the
  // fact has no home yet — fix the Doc first.
  if (type === 'project' && !isPresent(canonicalSource)) {
    findings.push(
      `${note.relPath}: project notes must set canonical_source (the Doc/Skill/code that owns the corrected fact)`,
    );
  } else if (type === 'project' && /\b(?:TODO|PENDING|FIXME|TBD)\b/i.test(fieldToText(canonicalSource))) {
    // A placeholder is non-empty, so a bare "is it set?" check would pass it. That
    // is precisely the "declared but never verified" shape, so name it explicitly:
    // migration seeded these and every one must be resolved before the store lands.
    findings.push(
      `${note.relPath}: canonical_source is still a migration placeholder — resolve it to the real ` +
        'owning Doc/Skill/code, or reclassify the note (unresolvable means the fact has no home yet)',
    );
  }
  if (type === 'feedback' && fieldToText(canonicalSource).trim() !== 'self') {
    findings.push(`${note.relPath}: feedback notes must set canonical_source to the literal "self"`);
  }

  // The pointer has to actually point somewhere. "Is it set?" and "is it not a
  // placeholder?" both pass a path that simply does not exist, and two such paths
  // reached the store before this check existed: a canonical_source naming
  // `apps/mobile-client/scripts/dev-services/build-ios-app.mjs` (the file lives
  // under the configured source root) and one naming a source directory
  // instead of `engineering/testing/gate/`. Both were written by someone reading a
  // stale path out of the body prose, and nothing caught them.
  //
  // Only the file part is enforced. The `#anchor` half is deliberately NOT checked:
  // the anchors in this store are hand-written and inconsistently escaped (some keep
  // full-width parentheses, some strip them), so a strict anchor check produces more
  // false alarms than findings. Anchor drift is tracked as a separate follow-up.
  for (const entry of asList(canonicalSource)) {
    const target = String(entry).trim();
    if (!target || target === 'self') continue;
    const filePart = target.split('#')[0].trim();
    if (!filePart) continue;
    if (!existsSync(join(REPO_ROOT, filePart))) {
      findings.push(
        `${note.relPath}: canonical_source points at a path that does not exist: ${filePart}`,
      );
    }
  }

  if (!REDACTIONS.has(redaction)) {
    findings.push(`${note.relPath}: field "redaction" must be one of ${[...REDACTIONS].join(' | ')}`);
  }
  if (!UPDATED_PATTERN.test(updated)) {
    findings.push(`${note.relPath}: updated must be YYYY-MM-DD`);
  }

  if (!HOW_TO_APPLY.test(note.body)) {
    findings.push(`${note.relPath}: body must contain a "**How to apply:**" section`);
  }
  if (HISTORY_SECTIONS.test(note.body)) {
    findings.push(
      `${note.relPath}: body must not use History's "## Summary/Changed/Verification/Follow-up" sections ` +
        '(memory narrates a tendency, history narrates an event)',
    );
  }

  findings.push(...collectSecretFindings(note.relPath, note.rawText));
  return findings;
}

/**
 * Collect [[wikilink]] targets, skipping fenced code blocks.
 *
 * ⚠️ The skip is not cosmetic. Bash's conditional syntax `[[ -d "$DIR" ]]` is
 * lexically indistinguishable from a wikilink, and these notes are full of shell
 * snippets — a scan over the raw body reported `[[-d "$HERE/policies"]]` as a
 * dangling link on the very first run. Same family as the "strip comments first,
 * string literals fool indexOf too" trap already recorded in the notes.
 */
export function collectWikilinks(body) {
  const targets = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      const target = match[1].trim().replace(/\.md$/, '');
      // A note stem, possibly mis-typed with hyphens (43% of the seed frontmatter
      // used hyphens). Anything else — shell tests, globs, quoted paths — is not a
      // link and must not be reported as a broken one.
      if (/^[A-Za-z0-9_-]+$/.test(target)) targets.push(target);
    }
  }
  return targets;
}

function loadNotes(memoryRoot = MEMORY_ROOT) {
  const { modules, problems } = listModuleDirs(memoryRoot);
  const notes = [];
  const failures = [...problems];
  for (const moduleName of modules) {
    for (const filePath of listNoteFiles(moduleName, memoryRoot)) {
      try {
        notes.push(readNote(filePath, moduleName));
      } catch (error) {
        failures.push(`${displayPath(moduleName, basename(filePath))}: ${error.message}`);
      }
    }
  }
  return { notes, failures };
}

export function escapeTableCell(value) {
  // Escape the escape character FIRST. Escaping `|` before `\` means a backslash
  // sitting immediately before a pipe absorbs the escape we just added, and the pipe
  // comes out unescaped — which breaks the table this writes and lets a note's
  // description forge extra cells in MEMORY.md, the one file the harness auto-loads
  // into context. CodeQL reports the ordering as js/incomplete-sanitization
  // (securitySeverity 7.8) and it is a real defect, not a naming false positive.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

function noteField(note, key) {
  const fm = note.frontmatter;
  return fieldToText(fm instanceof Map ? fm.get(key) : fm?.[key]);
}

function byStemAsc(a, b) {
  return a.stem.localeCompare(b.stem);
}

/**
 * MEMORY.md — the boot index. This is the ONLY file the harness loads by itself
 * at session start, and only its first 200 lines / 25KB survive that load, so it
 * must stay a compact map: which modules exist, and which note names live in each.
 * Names are deliberately self-describing (project_ruff_format_not_a_gate), which
 * is what lets a name-only listing still be actionable — the model can tell from
 * the name whether a note is worth opening, then Read it.
 */
function renderBootIndex(notes) {
  const lines = [
    `<!-- GENERATED by ${memoryProfile.generatedBy ?? 'scripts/memory-index.mjs'}.`,
    `     Run \`${memoryProfile.syncCommand ?? 'node memory-index.mjs sync'}\` to update. NON-CANONICAL projection — never put a`,
    '     judgement here that is not in the note itself.',
    '     ⚠️ Hard budget: the harness loads only the first 200 lines / 25KB of this',
    '     file and silently drops the rest. Keep it a map, not a catalogue. -->',
    '',
    `# ${memoryProfile.title ?? 'Memory Index'}`,
    '',
    memoryProfile.intro ?? 'Memory notes are retrieval cues for correcting recurring judgement errors.',
    '',
    `共 ${notes.length} 条，分布在 ${new Set(notes.map((n) => n.module)).size} 个模块。`,
    memoryProfile.catalogIntro ?? '**Descriptions and triggers are listed in [CATALOG.md](CATALOG.md).**',
    '',
    '按名字判断是否要打开某条；名字本身即检索键。',
    '',
  ];

  for (const [moduleName, label] of MODULES) {
    const inModule = notes.filter((note) => note.module === moduleName).sort(byStemAsc);
    if (inModule.length === 0) continue;
    lines.push(`### ${moduleName}/ — ${label}（${inModule.length}）`);
    const names = inModule.map((note) => {
      const short = note.stem.replace(/^(project|feedback)_/, '');
      return noteField(note, 'status').trim() === 'superseded' ? `~~${short}~~` : short;
    });
    // Wrap into a few dense lines rather than one line per note: 194 notes would
    // blow the 200-line budget on their own.
    let current = '';
    for (const name of names) {
      const next = current ? `${current} · ${name}` : name;
      if (next.length > 120) {
        lines.push(current);
        current = name;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    lines.push('');
  }

  lines.push('---', '', '`project_*` 纠偏仓库事实 · `feedback_*` 纠偏 AI 自身工作方式 · `~~划掉~~` = 已失效');
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * CATALOG.md — the full per-note table. Not loaded automatically; read on demand.
 * No size budget applies here, so this is where descriptions live.
 */
function renderCatalog(notes) {
  const lines = [
    `<!-- GENERATED by ${memoryProfile.generatedBy ?? 'scripts/memory-index.mjs'}.`,
    `     Run \`${memoryProfile.syncCommand ?? 'node memory-index.mjs sync'}\` to update. NON-CANONICAL: a projection of each`,
    "     note's own `description`; never add a judgement here that is not in the",
    '     note itself, or the catalogue becomes a second source. -->',
    '',
    '# Memory Catalogue',
    '',
    `${notes.length} note(s) across ${new Set(notes.map((n) => n.module)).size} module(s).`,
    'Boot index (auto-loaded, name-only): [MEMORY.md](MEMORY.md).',
    '',
  ];

  for (const [moduleName, label] of MODULES) {
    const inModule = notes.filter((note) => note.module === moduleName).sort(byStemAsc);
    if (inModule.length === 0) continue;
    lines.push(`## ${moduleName}/ — ${label}（${inModule.length}）`, '');
    lines.push('| Note | 什么时候你会想错 |');
    lines.push('| --- | --- |');
    for (const note of inModule) {
      const description = escapeTableCell(noteField(note, 'description'));
      const mark = noteField(note, 'status').trim() === 'superseded' ? ' ⚠️ superseded' : '';
      lines.push(`| [${note.stem}](${note.module}/${note.stem}.md)${mark} | ${description} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The harness truncates the boot index rather than rejecting it, so an overflow
 * would be invisible: the file on disk looks complete while the tail silently
 * stops reaching the model. Measured against it, not assumed.
 */
function bootIndexBudgetProblems(content) {
  const problems = [];
  const lineCount = content.split('\n').length;
  const byteCount = Buffer.byteLength(content, 'utf8');
  if (lineCount > BOOT_INDEX_MAX_LINES) {
    problems.push(
      `.vibe-coding/memory/${BOOT_INDEX_NAME}: ${lineCount} lines exceeds the harness budget of ` +
        `${BOOT_INDEX_MAX_LINES}; everything past it is dropped on load, not rejected`,
    );
  }
  if (byteCount > BOOT_INDEX_MAX_BYTES) {
    problems.push(
      `.vibe-coding/memory/${BOOT_INDEX_NAME}: ${byteCount} bytes exceeds the harness budget of ` +
        `${BOOT_INDEX_MAX_BYTES}; everything past it is dropped on load, not rejected`,
    );
  }
  return problems;
}

function indexArtifacts(notes) {
  return [
    { name: BOOT_INDEX_NAME, content: renderBootIndex(notes) },
    { name: CATALOG_NAME, content: renderCatalog(notes) },
  ];
}

export function runSync(options = {}) {
  const memoryRoot = typeof options === 'string' ? options : options.memoryRoot ?? MEMORY_ROOT;
  const repoRoot = typeof options === 'string' ? dirname(dirname(memoryRoot)) : options.repoRoot ?? dirname(dirname(memoryRoot));
  configureMemoryIndex({ memoryRoot, repoRoot });
  const { notes, failures } = loadNotes(memoryRoot);
  if (failures.length > 0) {
    throw new MemoryError(`cannot build index:\n  ${failures.join('\n  ')}`);
  }

  // Repair harness-written frontmatter before rendering, so the index is built
  // from the same shape the checker will see afterwards.
  const normalized = [];
  for (const note of notes) {
    if (!note.harness) continue;
    writeTextAtomically(join(memoryRoot, note.module, `${note.stem}.md`), note.harness.canonicalText);
    normalized.push(`${note.relPath} (${note.harness.notes.join('; ')})`);
  }
  if (normalized.length > 0) {
    console.log(`[memory] normalized harness frontmatter in ${normalized.length} note(s):`);
    for (const entry of normalized) console.log(`  ${entry}`);
  }

  const written = [];
  for (const { name, content } of indexArtifacts(notes)) {
    const path = join(memoryRoot, name);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (existing === content) continue;
    writeTextAtomically(path, content);
    written.push(name);
  }

  const budget = bootIndexBudgetProblems(renderBootIndex(notes));
  for (const problem of budget) console.error(`[memory] WARNING ${problem}`);

  console.log(
    written.length === 0
      ? `[memory] index already current (${notes.length} note(s))`
      : `[memory] wrote ${written.join(', ')} (${notes.length} note(s))`,
  );
  return {
    notes,
    wroteBootIndex: written.includes(BOOT_INDEX_NAME),
    wroteCatalog: written.includes(CATALOG_NAME),
    written,
  };
}

export function runCheck(options = {}) {
  const memoryRoot = typeof options === 'string' ? options : options.memoryRoot ?? MEMORY_ROOT;
  const quiet = typeof options === 'string' ? false : options.quiet ?? false;
  const repoRoot = typeof options === 'string' ? dirname(dirname(memoryRoot)) : options.repoRoot ?? dirname(dirname(memoryRoot));
  configureMemoryIndex({ memoryRoot, repoRoot });
  const { notes, failures } = loadNotes(memoryRoot);
  const problems = [...failures];

  for (const note of notes) {
    problems.push(...validateNote(note));
  }

  // Stems must be globally unique: wikilinks resolve by basename, so two notes
  // sharing a stem across modules would make [[name]] ambiguous.
  const byStem = new Map();
  for (const note of notes) {
    const seen = byStem.get(note.stem);
    if (seen) problems.push(`${note.relPath}: duplicate stem "${note.stem}", also at ${seen}`);
    else byStem.set(note.stem, note.relPath);
  }

  // A dangling wikilink in memory is a functional failure, not a hygiene issue:
  // the reader is left holding a superseded belief with nothing to refute it.
  for (const note of notes) {
    for (const target of collectWikilinks(note.body)) {
      if (!byStem.has(target)) {
        problems.push(`${note.relPath}: wikilink [[${target}]] does not resolve to any note`);
      }
    }
  }

  if (problems.length === 0) {
    for (const { name, content } of indexArtifacts(notes)) {
      const path = join(memoryRoot, name);
      const actual = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      if (actual !== content) {
        problems.push(`.vibe-coding/memory/${name} is stale; run \`pnpm memory:index\``);
      }
    }
    problems.push(...bootIndexBudgetProblems(renderBootIndex(notes)));
  }

  if (problems.length > 0) {
    if (!quiet) {
      console.error(`[memory] check failed (${problems.length} problem(s)):`);
      for (const problem of problems) console.error(`  ${problem}`);
    }
    return { ok: false, errors: problems, exitCode: 1, problems };
  }

  if (!quiet) {
    console.log(
      `[memory] check passed (${notes.length} note(s), ${listModuleDirs(memoryRoot).modules.length} module(s))`,
    );
  }
  return { ok: true, errors: problems, exitCode: 0, problems };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return command ? 0 : 1;
  }
  if (command === 'sync') {
    runSync();
    return 0;
  }
  if (command === 'check') return runCheck().exitCode;
  console.error(`unknown command: ${command}\n\n${usage()}`);
  return 1;
}

function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error?.name === 'MemoryError') {
      console.error(`[memory] ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
    } else {
      throw error;
    }
  }
}
