#!/usr/bin/env node
// Sync `.vibe-coding/skills/**` and `.vibe-coding/loading.md` (the single
// hand-written source of truth) into generated per-tool projections:
//   - .agents/skills/**  and  AGENTS.md   (Codex-style / generic agent tooling)
//   - .claude/skills/**  and  CLAUDE.md   (Claude Code)
//
// Usage:
//   node sync-skills.mjs sync  [--root <path>]
//   node sync-skills.mjs check [--root <path>]
//   node sync-skills.mjs vendor <name> --from <claude|agents> [--no-sync] [--root <path>]
//
// Skill packs (see skill-packs.mjs): a domain with many task-specific skills is registered as a
// pack. Its ENTRY skill is mirrored to `<tool>/skills/<entry>/` like any other skill (plus a generated
// member index); its MEMBERS go to `<tool>/skill-packs/<name>/` so they never enter the per-turn skill
// listing. The source stays flat in `.vibe-coding/skills/`. With no packs registered nothing changes.
//
// `check` also validates source skill structure: each skills/<dir>/ must be lowercase kebab-case,
// contain SKILL.md, and its frontmatter `name` must equal <dir>; offenders are named and exit is non-zero.

import { readFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomically } from '../lib/atomic-write.mjs';
import {
  injectPackBlocks,
  mirrorRootFor,
  packMirrorRoot,
  rewriteLinksFromMirror,
  rewriteLinksToMirror,
  SKILLS_CLASS,
  splitSkillRel,
  stripGeneratedPackBlocks,
} from './skill-pack-mirror.mjs';
import {
  isPackMember,
  overrideSkillPacks,
  PACK_MIRROR_DIRNAME,
  validateSkillPacks,
} from './skill-packs.mjs';

// Realpath on both sides: Node resolves symlinks in import.meta.url, argv[1] keeps the caller's spelling (starter kit is copied into
// other repos, so this is an inline copy of the shared helper rather than an import).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function identity(value) {
  return value;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isMarkdownPath(p) {
  return /\.(md|mdx)$/i.test(p);
}

// Joint mentions like "`AGENTS.md`/`CLAUDE.md`" must survive a vendor
// transform unchanged instead of collapsing into "`CLAUDE.md`/`CLAUDE.md`".
export const JOINT_ROOT_DOC_REFERENCE = '`AGENTS.md`/`CLAUDE.md`';
const JOINT_ROOT_DOC_PLACEHOLDER = '@@JOINT_ROOT_DOC_REFERENCE@@';

export function toClaudeMarkdown(value) {
  return value
    .replaceAll(JOINT_ROOT_DOC_REFERENCE, JOINT_ROOT_DOC_PLACEHOLDER)
    .replaceAll('AGENTS.md', 'CLAUDE.md')
    .replaceAll('.agents/skills', '.claude/skills')
    .replaceAll(JOINT_ROOT_DOC_PLACEHOLDER, JOINT_ROOT_DOC_REFERENCE);
}

export function fromClaudeMarkdown(value) {
  return value
    .replaceAll(JOINT_ROOT_DOC_REFERENCE, JOINT_ROOT_DOC_PLACEHOLDER)
    .replaceAll('CLAUDE.md', 'AGENTS.md')
    .replaceAll('.claude/skills', '.agents/skills')
    .replaceAll(JOINT_ROOT_DOC_PLACEHOLDER, JOINT_ROOT_DOC_REFERENCE);
}

// Some target tools (e.g. plain "agents" consumers) don't understand
// Claude-specific `allowed-tools:` frontmatter — strip that line for them.
export function stripAllowedToolsFrontmatterLine(text) {
  if (!text.startsWith('---\n')) return text;
  const frontmatterMatch = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (!frontmatterMatch) return text;
  const frontmatter = frontmatterMatch[0];
  const rest = text.slice(frontmatter.length);
  const filteredFrontmatter = frontmatter
    .split('\n')
    .filter((line) => !/^allowed-tools:/.test(line))
    .join('\n');
  return `${filteredFrontmatter}${rest}`;
}

// Platform-conditional content markers: a block kept for `target` is
// unwrapped in place; a block kept for the other target is dropped whole.
const CLAUDE_ONLY_BEGIN = '<!-- BEGIN: claude-only -->';
const CLAUDE_ONLY_END = '<!-- END: claude-only -->';
const AGENT_ONLY_BEGIN = '<!-- BEGIN: agent-only -->';
const AGENT_ONLY_END = '<!-- END: agent-only -->';

export function stripPlatformMarkers(text, target) {
  if (!text.includes(CLAUDE_ONLY_BEGIN) && !text.includes(AGENT_ONLY_BEGIN)) return text;
  const keepBegin = target === 'claude' ? CLAUDE_ONLY_BEGIN : AGENT_ONLY_BEGIN;
  const keepEnd = target === 'claude' ? CLAUDE_ONLY_END : AGENT_ONLY_END;
  const dropBegin = target === 'claude' ? AGENT_ONLY_BEGIN : CLAUDE_ONLY_BEGIN;
  const dropEnd = target === 'claude' ? AGENT_ONLY_END : CLAUDE_ONLY_END;
  const lines = text.split('\n');
  const out = [];
  let mode = null; // null | 'keep' | 'drop'
  for (const line of lines) {
    const trimmed = line.trim();
    if (mode === null) {
      if (trimmed === keepBegin) mode = 'keep';
      else if (trimmed === dropBegin) mode = 'drop';
      else out.push(line);
      continue;
    }
    if (mode === 'keep') {
      if (trimmed === keepEnd) mode = null;
      else out.push(line);
      continue;
    }
    // mode === 'drop': discard content lines until the matching END marker.
    if (trimmed === dropEnd) mode = null;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Generated-file banner
// ---------------------------------------------------------------------------

const GENERATED_MARKER = 'GENERATED FILE - DO NOT EDIT.';

function generatedNotice(sourceRel) {
  return [
    '<!--',
    GENERATED_MARKER,
    `Source: ${sourceRel}`,
    'Run `node engineering/automation/agent-skills/sync-skills.mjs sync` after editing source files.',
    '-->',
    '',
    '',
  ].join('\n');
}

const GENERATED_NOTICE_RE =
  /<!--\nGENERATED FILE - DO NOT EDIT\.\nSource: [^\n]*\nRun `node engineering\/automation\/agent-skills\/sync-skills\.mjs sync` after editing source files\.\n-->\n\n/;

export function stripGeneratedNotice(text) {
  if (text.startsWith('---\n')) {
    const frontmatterMatch = text.match(/^---\n[\s\S]*?\n---\n?/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[0];
      const rest = text.slice(frontmatter.length);
      return `${frontmatter}${rest.replace(GENERATED_NOTICE_RE, '')}`;
    }
  }
  return text.replace(GENERATED_NOTICE_RE, '');
}

export function addGeneratedNotice(text, sourceRel) {
  const stripped = stripGeneratedNotice(text);
  const notice = generatedNotice(sourceRel);
  if (stripped.startsWith('---\n')) {
    const frontmatterMatch = stripped.match(/^---\n[\s\S]*?\n---\n?/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[0];
      const rest = stripped.slice(frontmatter.length);
      return `${frontmatter}${notice}${rest}`;
    }
  }
  return `${notice}${stripped}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function buildConfig(root, { sourceSkillsDir = join(root, '.vibe-coding', 'skills') } = {}) {
  const REPO_ROOT = root;
  const SOURCE_ROOT = join(REPO_ROOT, '.vibe-coding');
  const SOURCE_SKILLS_DIR = sourceSkillsDir;
  const SOURCE_LOADING = join(SOURCE_ROOT, 'loading.md');

  const OUTPUTS = [
    {
      key: 'agents',
      label: 'agents skills',
      root: join(REPO_ROOT, '.agents', 'skills'),
      markdownTransform: identity,
      reverseMarkdownTransform: identity,
    },
    {
      key: 'claude',
      label: 'claude skills',
      root: join(REPO_ROOT, '.claude', 'skills'),
      markdownTransform: toClaudeMarkdown,
      reverseMarkdownTransform: fromClaudeMarkdown,
    },
  ];

  const DOC_OUTPUTS = [
    {
      key: 'agents',
      label: 'AGENTS.md',
      path: join(REPO_ROOT, 'AGENTS.md'),
      sourceRel: '.vibe-coding/loading.md',
      transform: identity,
    },
    {
      key: 'claude',
      label: 'CLAUDE.md',
      path: join(REPO_ROOT, 'CLAUDE.md'),
      sourceRel: '.vibe-coding/loading.md',
      transform: toClaudeMarkdown,
    },
  ];

  return {
    REPO_ROOT,
    SOURCE_ROOT,
    SOURCE_SKILLS_DIR,
    composedSource: sourceSkillsDir !== join(SOURCE_ROOT, 'skills'),
    SOURCE_LOADING,
    OUTPUTS,
    DOC_OUTPUTS,
  };
}

// ---------------------------------------------------------------------------
// Filesystem traversal
// ---------------------------------------------------------------------------

const SKIP_NAMES = new Set(['.DS_Store', '__pycache__', '.pytest_cache']);

function walkFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return results;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function walkAllFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkAllFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function pruneEmptyDirs(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      pruneEmptyDirs(join(dir, entry.name), root);
    }
  }
  if (dir !== root && existsSync(dir)) {
    const remaining = readdirSync(dir);
    if (remaining.length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function collectManagedFiles(config) {
  const managed = [];
  for (const output of config.OUTPUTS) {
    managed.push(...walkAllFiles(output.root));
    managed.push(...walkAllFiles(packMirrorRoot(output)));
  }
  for (const docOutput of config.DOC_OUTPUTS) {
    if (existsSync(docOutput.path)) managed.push(docOutput.path);
  }
  return managed;
}

// ---------------------------------------------------------------------------
// Markdown pipeline
// ---------------------------------------------------------------------------

function processMarkdown(rawText, { targetKey, relPath, transform, sourceRel, postTransform = identity }) {
  let text = normalizeNewlines(rawText);
  text = stripPlatformMarkers(text, targetKey);
  if (targetKey === 'agents' && basename(relPath) === 'SKILL.md') {
    text = stripAllowedToolsFrontmatterLine(text);
  }
  text = transform(text);
  text = postTransform(text);
  text = addGeneratedNotice(text, sourceRel);
  return text;
}

// ---------------------------------------------------------------------------
// Expected-output computation
// ---------------------------------------------------------------------------

function docFileMode() {
  return process.platform === 'win32' ? 0o666 : 0o644;
}

function buildExpectedOutputs(config) {
  const expected = new Map();

  const skillFiles = walkFiles(config.SOURCE_SKILLS_DIR);
  for (const fullPath of skillFiles) {
    const relPath = toPosix(relative(config.SOURCE_SKILLS_DIR, fullPath));
    const sourceRel = config.composedSource
      ? `.vibe-coding/skills/${relPath}`
      : toPosix(relative(config.REPO_ROOT, fullPath));
    const srcMode = statSync(fullPath).mode & 0o777;
    const { name: skillName, inner: innerPath } = splitSkillRel(relPath, '/');
    for (const output of config.OUTPUTS) {
      const outPath = join(skillName ? mirrorRootFor(output, skillName) : output.root, relPath);
      if (isMarkdownPath(relPath)) {
        const rawText = readFileSync(fullPath, 'utf8');
        const processed = processMarkdown(rawText, {
          targetKey: output.key,
          relPath,
          transform: output.markdownTransform,
          sourceRel,
          postTransform: skillName
            ? (text) =>
                injectPackBlocks(
                  rewriteLinksToMirror(text, skillName, innerPath),
                  skillName,
                  innerPath,
                  config.SOURCE_SKILLS_DIR,
                )
            : identity,
        });
        expected.set(outPath, { content: processed, mode: srcMode, isText: true });
      } else {
        const rawBuf = readFileSync(fullPath);
        expected.set(outPath, { content: rawBuf, mode: srcMode, isText: false });
      }
    }
  }

  if (existsSync(config.SOURCE_LOADING)) {
    const rawText = readFileSync(config.SOURCE_LOADING, 'utf8');
    const mode = docFileMode();
    for (const output of config.DOC_OUTPUTS) {
      const processed = processMarkdown(rawText, {
        targetKey: output.key,
        relPath: 'loading.md',
        transform: output.transform,
        sourceRel: output.sourceRel,
      });
      expected.set(output.path, { content: processed, mode, isText: true });
    }
  }

  return expected;
}

// ---------------------------------------------------------------------------
// sync / check / vendor
// ---------------------------------------------------------------------------

export function sync({ root = process.cwd(), sourceSkillsDir } = {}) {
  const config = buildConfig(root, { sourceSkillsDir });
  const expected = buildExpectedOutputs(config);
  const managed = collectManagedFiles(config);

  for (const filePath of managed) {
    if (!expected.has(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
  for (const output of config.OUTPUTS) {
    pruneEmptyDirs(output.root, output.root);
    pruneEmptyDirs(packMirrorRoot(output), packMirrorRoot(output));
  }

  for (const [filePath, entry] of expected) {
    writeTextAtomically(filePath, entry.content, entry.mode);
  }

  return { written: expected.size };
}

function relForDisplay(filePath, root) {
  return toPosix(relative(root, filePath));
}

// Source-skill structure rules (check mode only):
//   skill-directory-invalid -- a directory under skills/ must be lowercase kebab-case and contain SKILL.md
//   skill-name-mismatch     -- SKILL.md frontmatter `name` must equal its directory name
// The directory name is the skill's identity everywhere else (projections, loading.md triggers,
// cross-skill links), so a drifting `name` breaks lookups silently.
const SKILL_DIR_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readFrontmatterName(text) {
  const match = normalizeNewlines(text).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const field = line.match(/^name:\s*(.*?)\s*$/);
    if (field) return field[1].replace(/^(["'])(.*)\1$/, '$2');
  }
  return null;
}

/**
 * The `description:` value of a SKILL.md frontmatter (plain, quoted, or a `>` / `|`
 * block scalar), or '' when there is none.
 */
export function parseSkillDescription(text) {
  const fm = normalizeNewlines(text).match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return '';
  const lines = fm[1].split('\n');
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index === -1) return '';
  const head = lines[index].replace(/^description:\s*/, '');
  const continuation = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    continuation.push(line.trim());
  }
  while (continuation.length > 0 && continuation[continuation.length - 1] === '') continuation.pop();
  if (/^[>|][+-]?\s*$/.test(head)) return continuation.join(head.startsWith('|') ? '\n' : ' ').trim();
  const joined = [head, ...continuation].join(' ').trim();
  if (/^".*"$/.test(joined)) {
    try {
      return JSON.parse(joined);
    } catch {
      return joined.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(joined)) return joined.slice(1, -1).replaceAll("''", "'");
  return joined;
}

/**
 * Soft budget report, never a failure: Claude Code and Codex put every skill's
 * name + description into a per-turn listing with a limited budget, so this is
 * what each skill you add costs on every turn. Counts the source skills (one
 * listing entry each).
 */
export function listingBudget(config) {
  let skills = 0;
  let descriptionChars = 0;
  let entries;
  try {
    entries = readdirSync(config.SOURCE_SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { skills, descriptionChars };
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_NAMES.has(entry.name)) continue;
    const skillFile = join(config.SOURCE_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    skills += 1;
    descriptionChars += [...parseSkillDescription(readFileSync(skillFile, 'utf8'))].length;
  }
  return { skills, descriptionChars };
}

export function checkSkillStructure(config, root) {
  const problems = [];
  let entries;
  try {
    entries = readdirSync(config.SOURCE_SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return problems;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_NAMES.has(entry.name)) continue;
    const dirPath = join(config.SOURCE_SKILLS_DIR, entry.name);
    const dirRel = relForDisplay(dirPath, root);
    if (!SKILL_DIR_NAME_RE.test(entry.name)) {
      problems.push(`skill-directory-invalid: ${dirRel} (directory name must be lowercase kebab-case)`);
    }
    const skillFile = join(dirPath, 'SKILL.md');
    if (!existsSync(skillFile)) {
      problems.push(`skill-directory-invalid: ${dirRel} (no SKILL.md)`);
      continue;
    }
    const name = readFrontmatterName(readFileSync(skillFile, 'utf8'));
    if (name !== entry.name) {
      const shown = name === null ? 'missing' : `"${name}"`;
      problems.push(
        `skill-name-mismatch: ${relForDisplay(skillFile, root)} (frontmatter name ${shown} must equal directory "${entry.name}")`,
      );
    }
  }
  return problems;
}

function listSourceSkillNames(config) {
  try {
    return readdirSync(config.SOURCE_SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_NAMES.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function check({ root = process.cwd(), sourceSkillsDir } = {}) {
  const config = buildConfig(root, { sourceSkillsDir });
  const expected = buildExpectedOutputs(config);
  const managed = new Set(collectManagedFiles(config));
  const problems = checkSkillStructure(config, root);
  // skill-pack-registry -- SKILL_PACKS must agree with the source skills (missing entry/member,
  // double membership, unregistered `<memberPrefix>*` sibling); see skill-packs.mjs.
  for (const error of validateSkillPacks(listSourceSkillNames(config))) {
    problems.push(`skill-pack-registry: ${error}`);
  }

  for (const [filePath, entry] of expected) {
    if (!existsSync(filePath)) {
      problems.push(`missing: ${relForDisplay(filePath, root)}`);
      continue;
    }
    const stat = statSync(filePath);
    const actualMode = stat.mode & 0o777;
    let contentMatches;
    if (entry.isText) {
      const actualRaw = readFileSync(filePath, 'utf8');
      contentMatches = normalizeNewlines(actualRaw) === normalizeNewlines(entry.content);
    } else {
      const actualBuf = readFileSync(filePath);
      contentMatches = actualBuf.equals(entry.content);
    }
    if (!contentMatches) {
      problems.push(`changed: ${relForDisplay(filePath, root)}`);
    }
    if (actualMode !== entry.mode) {
      problems.push(`mode: ${relForDisplay(filePath, root)}`);
    }
  }

  for (const filePath of managed) {
    if (!expected.has(filePath)) {
      problems.push(`extra: ${relForDisplay(filePath, root)}`);
    }
  }

  problems.sort();
  return { ok: problems.length === 0, problems, listing: listingBudget(config) };
}

export function vendor(name, { from, root = process.cwd(), sync: shouldSync = true } = {}) {
  const config = buildConfig(root);
  const output = config.OUTPUTS.find((o) => o.key === from);
  if (!output) {
    throw new Error(`unknown vendor target: ${from} (expected one of: ${config.OUTPUTS.map((o) => o.key).join(', ')})`);
  }
  // Third-party installers write the flat `<root>/skills/<name>`; a pack member that was already
  // synced only exists under `<root>/skill-packs/<name>`. Prefer the flat copy when both exist.
  const flatDir = join(output.root, name);
  const packDir = join(packMirrorRoot(output), name);
  let srcDir = flatDir;
  let importClass = SKILLS_CLASS;
  if (!existsSync(flatDir) && isPackMember(name) && existsSync(packDir)) {
    srcDir = packDir;
    importClass = PACK_MIRROR_DIRNAME;
  }
  if (!existsSync(srcDir)) {
    throw new Error(`vendor source not found: ${flatDir}`);
  }
  const destDir = join(config.SOURCE_SKILLS_DIR, name);
  const files = walkAllFiles(srcDir);

  for (const filePath of files) {
    const relPath = relative(srcDir, filePath);
    const destPath = join(destDir, relPath);
    const mode = statSync(filePath).mode & 0o777;
    if (isMarkdownPath(relPath)) {
      const raw = readFileSync(filePath, 'utf8');
      const stripped = stripGeneratedNotice(raw);
      const reversed = rewriteLinksFromMirror(
        output.reverseMarkdownTransform(stripGeneratedPackBlocks(stripped)),
        name,
        toPosix(relPath),
        importClass,
      );
      writeTextAtomically(destPath, reversed, mode);
    } else {
      writeTextAtomically(destPath, readFileSync(filePath), mode);
    }
  }

  if (shouldSync) {
    sync({ root });
  }

  return { destDir, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      args.root = argv[(i += 1)];
    } else if (arg === '--from') {
      args.from = argv[(i += 1)];
    } else if (arg === '--skill-packs-config') {
      args.skillPacksConfig = argv[(i += 1)];
    } else if (arg === '--no-sync') {
      args.noSync = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? resolve(args.root) : process.cwd();
  const command = args._[0];

  // Test seam (see skill-packs.mjs): swap the pack registry for a fixture, only together with --root.
  if (args.skillPacksConfig !== undefined) {
    if (!args.root) {
      console.error('sync-skills: --skill-packs-config is only allowed together with --root');
      process.exitCode = 2;
      return;
    }
    overrideSkillPacks(JSON.parse(readFileSync(resolve(args.skillPacksConfig), 'utf8')));
  }

  if (command === 'sync') {
    const result = sync({ root });
    console.log(`sync-skills: wrote ${result.written} generated file(s).`);
    return;
  }

  if (command === 'check') {
    const result = check({ root });
    if (!result.ok) {
      for (const problem of result.problems) console.error(problem);
      console.error(`sync-skills: check failed (${result.problems.length} problem(s)).`);
      process.exitCode = 1;
      return;
    }
    console.log('sync-skills: check passed.');
    console.log(`sync-skills: listing: ${result.listing.skills} skill(s), description chars=${result.listing.descriptionChars} (sent to the agent every turn; keep descriptions to trigger conditions)`);
    return;
  }

  if (command === 'vendor') {
    const name = args._[1];
    if (!name || !args.from) {
      console.error('usage: node sync-skills.mjs vendor <name> --from <claude|agents> [--no-sync] [--root <path>]');
      process.exitCode = 1;
      return;
    }
    const result = vendor(name, { from: args.from, root, sync: !args.noSync });
    console.log(`sync-skills: vendored ${result.fileCount} file(s) into ${relForDisplay(result.destDir, root)}.`);
    return;
  }

  console.error('usage: node sync-skills.mjs <sync|check|vendor> ...');
  process.exitCode = 1;
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  main();
}
