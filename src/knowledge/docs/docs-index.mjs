#!/usr/bin/env node
// doc/ index generator + contract checker.
//
// Shared generated knowledge index and contract checker. Same shape:
// a `sync` command regenerates a GENERATED, NON-CANONICAL projection file from
// per-file frontmatter, and a `check` command validates the frontmatter contract
// and rejects a stale or drifted projection.
//
// What doc/ needed that memory/history did not: `.vibe-coding/loading.md` used
// to hand-maintain an 84-entry "文档索引（doc/）" section describing every file
// under doc/. It rotted (dead links, missing entries) because nothing forced it
// to track doc/**/*.md. This script makes doc/README.md a generated index built
// from each doc's own frontmatter (`title` / `description` / `authority`), the
// same anti-duplication move memory/history already made: the fact lives once,
// on the file it describes, and the index is a read-only view over it.
//
// Collections (a doc/<dir>/ subdirectory such as doc/bootstrap-deployment/) are
// indexed as ONE entry pointing at their own README.md. The files inside a
// collection are reachable through that README's own links (already enforced by
// check-knowledge-artifacts.mjs's doc-collection-link rule) and are deliberately
// NOT flattened into the top-level index or required to carry this frontmatter
// schema themselves.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeTextAtomically } from '../../lib/atomic-write.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The consumer owns root selection. A library default is the caller's cwd;
// importing this file must never infer a consumer root from this module's URL.
const DOC_ROOT = join(process.cwd(), 'doc');
const README_NAME = 'README.md';
const AUTHORITIES = new Set(['hard', 'normal']);

class DocsIndexError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'DocsIndexError';
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage: pnpm docs:index | pnpm check:docs-index

  sync    regenerate doc/README.md from each doc's frontmatter
  check   validate every doc's frontmatter and doc/README.md against it
`;
}

/**
 * Minimal frontmatter parser scoped to this store's own flat 3-field schema
 * (title / description / authority). Deliberately NOT shared with the
 * history/memory parser: that one resolves error paths against ITS OWN
 * REPO_ROOT, which makes messages ugly under test fixtures rooted outside the
 * repo. This store's relPath is always caller-supplied, so messages stay
 * stable (`doc/foo.md: ...`) whether scanning the real repo or a tmp fixture.
 */
function parseFrontmatter(rawText, relPath) {
  const normalized = rawText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new DocsIndexError(`${relPath}: missing YAML frontmatter`);
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) {
    throw new DocsIndexError(`${relPath}: unterminated YAML frontmatter`);
  }
  const fields = {};
  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim()) continue;
    // Block-list items (`  - "glob"`) and `#` comments belong to list-valued keys such as the
    // docs-impact `covers:` family (see engineering/testing/docs/docs-covers.mjs); the index only
    // consumes the flat title / description / authority scalars, so it skips them.
    if (/^\s/.test(line) || line.trim().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      throw new DocsIndexError(`${relPath}: unsupported frontmatter line: ${line}`);
    }
    const [, key, rawValue] = match;
    if (Object.hasOwn(fields, key)) {
      throw new DocsIndexError(`${relPath}: duplicate frontmatter key: ${key}`);
    }
    fields[key] = stripQuotes(rawValue.trim());
  }
  return fields;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Read one indexed doc's frontmatter. Returns { fields } or { problems }. */
function readIndexedDoc(absPath, relPath) {
  let rawText;
  try {
    rawText = readFileSync(absPath, 'utf8');
  } catch (error) {
    return { problems: [`${relPath}: cannot read file: ${error.message}`] };
  }

  let fields;
  try {
    fields = parseFrontmatter(rawText, relPath);
  } catch (error) {
    if (error instanceof DocsIndexError) return { problems: [error.message] };
    throw error;
  }

  const title = (fields.title ?? '').trim();
  const description = (fields.description ?? '').trim();
  const authority = (fields.authority ?? '').trim();
  const problems = [];
  if (!title) problems.push(`${relPath}: frontmatter "title" is required`);
  if (!description) problems.push(`${relPath}: frontmatter "description" is required`);
  if (!AUTHORITIES.has(authority)) {
    problems.push(
      `${relPath}: frontmatter "authority" must be one of ${[...AUTHORITIES].join(' | ')} (got "${authority || '<empty>'}")`,
    );
  }
  if (problems.length > 0) return { problems };
  return { fields: { title, description, authority } };
}

/**
 * Walk doc/ ONE level deep. A subdirectory contributes exactly one entry (its
 * own README.md); files inside it are not visited. doc/README.md itself is the
 * generated artifact and is excluded from its own index.
 */
export function scanDocs(docRoot = DOC_ROOT) {
  if (!existsSync(docRoot) || !statSync(docRoot).isDirectory()) {
    throw new DocsIndexError('missing doc/ — create it before running docs index tooling');
  }

  const docs = [];
  const problems = [];
  const entries = readdirSync(docRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const dirent of entries) {
    if (dirent.isDirectory()) {
      const relPath = `doc/${dirent.name}/${README_NAME}`;
      const absReadme = join(docRoot, dirent.name, README_NAME);
      if (!existsSync(absReadme)) {
        problems.push(`${relPath}: collection directory is missing README.md`);
        continue;
      }
      const result = readIndexedDoc(absReadme, relPath);
      if (result.problems) {
        problems.push(...result.problems);
        continue;
      }
      docs.push({
        relPath,
        linkPath: `${dirent.name}/${README_NAME}`,
        kind: 'collection',
        ...result.fields,
      });
      continue;
    }

    if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.md')) continue;
    if (dirent.name.toLowerCase() === README_NAME.toLowerCase()) continue; // doc/README.md itself

    const relPath = `doc/${dirent.name}`;
    const result = readIndexedDoc(join(docRoot, dirent.name), relPath);
    if (result.problems) {
      problems.push(...result.problems);
      continue;
    }
    docs.push({ relPath, linkPath: dirent.name, kind: 'top', ...result.fields });
  }

  return { docs, problems };
}

function byLinkPath(a, b) {
  return a.linkPath.localeCompare(b.linkPath);
}

export function escapeLinkText(value) {
  // Escape the escape character FIRST. Escaping "]" before "\" lets a title that
  // already ends in "\" absorb the escape this adds as an *escaped backslash*
  // (`\\`) when Markdown renders it, leaving the following "]" unescaped and
  // closing the link's "[...]" text span early. CodeQL reports this ordering as
  // js/incomplete-sanitization; it is a real defect, not a naming false positive
  // — see the identical fix + rationale on escapeTableCell in
  // corresponding history and memory index escaping helpers.
  return String(value)
    .replace(/\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
    .trim();
}

function renderEntry(doc) {
  return `- [${escapeLinkText(doc.title)}](${doc.linkPath}) — ${doc.description}`;
}

/**
 * doc/README.md — the generated index. NON-CANONICAL: every fact here is a
 * projection of the doc's own frontmatter; never hand-add a judgement that is
 * not already stated in the doc itself, or this file becomes a second source.
 */
export function renderIndex(docs, profile = {}) {
  const hard = docs.filter((doc) => doc.authority === 'hard').sort(byLinkPath);
  const rest = docs.filter((doc) => doc.authority !== 'hard').sort(byLinkPath);

  const lines = [
    `<!-- GENERATED by ${profile.generatedBy ?? 'scripts/docs-index.mjs'}.`,
    `     Run \`${profile.syncCommand ?? 'node docs-index.mjs sync'}\` to update. NON-CANONICAL projection of each doc's`,
    '     own frontmatter (title / description / authority); never add a judgement',
    '     here that is not already in the doc itself, or the index becomes a',
    '     second source. -->',
    '',
    `# ${profile.title ?? 'Doc Index'}`,
    '',
    `共 ${docs.length} 篇，其中 ${hard.length} 篇是硬约定。按 frontmatter 的 title / description / authority 生成，`,
    '真源永远是各篇文档自己的 frontmatter，不要手改本文件。',
    '',
  ];

  if (hard.length > 0) {
    lines.push('## 硬约定 · 触发对应场景必须先读', '');
    for (const doc of hard) lines.push(renderEntry(doc));
    lines.push('');
  }

  lines.push('## 其余文档', '');
  if (rest.length === 0) {
    lines.push('（无）');
  } else {
    for (const doc of rest) lines.push(renderEntry(doc));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Extract every `](target)` link target from the rendered/actual index body. */
function collectIndexLinks(text) {
  const targets = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    targets.push(match[1]);
  }
  return targets;
}

export function runSync({ docRoot = DOC_ROOT, profile } = {}) {
  const { docs, problems } = scanDocs(docRoot);
  if (problems.length > 0) {
    throw new DocsIndexError(`cannot build index (${problems.length} problem(s)):\n  ${problems.join('\n  ')}`);
  }

  const content = renderIndex(docs, profile);
  const path = join(docRoot, README_NAME);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (existing === content) {
    console.log(`[docs] index already current (${docs.length} doc(s))`);
    return 0;
  }

  writeTextAtomically(path, content);
  console.log(`[docs] wrote doc/README.md (${docs.length} doc(s))`);
  return 0;
}

export function runCheck({ docRoot = DOC_ROOT, quiet = false, profile } = {}) {
  const { docs, problems } = scanDocs(docRoot);
  const allProblems = [...problems];

  const path = join(docRoot, README_NAME);
  const actual = existsSync(path) ? readFileSync(path, 'utf8') : undefined;

  if (problems.length === 0) {
    const expected = renderIndex(docs, profile);
    if (actual !== expected) {
      allProblems.push('doc/README.md is stale; run `pnpm docs:index`');
    }
  }

  // Dead-link check runs independently of drift: even a hand-edited or stale
  // README on disk must not point at a file that no longer exists.
  if (actual !== undefined) {
    for (const target of collectIndexLinks(actual)) {
      const absTarget = resolve(docRoot, target);
      if (!existsSync(absTarget)) {
        allProblems.push(`dead link in doc/README.md: ${target} does not exist`);
      }
    }
  }

  if (allProblems.length > 0) {
    if (!quiet) {
      console.error(`[docs] check failed (${allProblems.length} problem(s)):`);
      for (const problem of allProblems) console.error(`  ${problem}`);
    }
    return { exitCode: 1, problems: allProblems };
  }

  if (!quiet) {
    console.log(`[docs] check passed (${docs.length} doc(s))`);
  }
  return { exitCode: 0, problems: allProblems };
}

// Backwards-compatible standalone API: `root` names the project root while
// `docRoot` is the explicit store directory used by project adapters.
export function sync({ root = process.cwd(), ...options } = {}) {
  const docRoot = options.docRoot ?? join(root, 'doc');
  const expected = renderIndex(scanDocs(docRoot).docs, options.profile);
  const path = join(docRoot, README_NAME);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  runSync({ docRoot, profile: options.profile });
  return { changed: before !== expected, path };
}

export function check({ root = process.cwd(), ...options } = {}) {
  return runCheck({
    docRoot: options.docRoot ?? join(root, 'doc'),
    quiet: options.quiet,
    profile: options.profile,
  });
}

export async function main(argv = process.argv.slice(2), defaults = {}) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return command ? 0 : 1;
  }
  if (command === 'sync') return runSync(defaults);
  if (command === 'check') return runCheck(defaults).exitCode;
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
    if (error?.name === 'DocsIndexError') {
      console.error(`[docs] ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
    } else {
      throw error;
    }
  }
}
