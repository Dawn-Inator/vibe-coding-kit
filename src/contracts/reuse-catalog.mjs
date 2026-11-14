import { createHash } from 'node:crypto';
import { readFile, realpath, stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadProjectAdapter } from './project-adapter.mjs';

const defaults = {
  frontend: { source: 'registries/architecture/frontend-components.json', document: 'doc/frontend-components.md' },
  backend: { source: 'registries/architecture/backend-capabilities.json', document: 'doc/backend-capabilities.md' },
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && !!v.trim() && !/[\r\n]/.test(v);
const strings = (v) => Array.isArray(v) && v.every(string);
const keys = (v, allowed, required = allowed) => object(v) && Object.keys(v).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(v, k));
const inside = (root, p) => { const r = relative(root, p); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const finding = (code, message, path) => ({ code, message, ...(path ? { path } : {}) });

// Reject traversal and symlink escapes, including output paths whose final components do not exist yet.
async function projectPath(root, value, mustExist = true) {
  if (!string(value) || isAbsolute(value) || value.includes('\\') || value.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`invalid project-relative path: ${value}`);
  const target = resolve(root, value);
  if (!inside(root, target)) throw new Error(`path escapes project root: ${value}`);
  let probe = target;
  while (true) {
    try { const actual = await realpath(probe); if (!inside(root, actual)) throw new Error(`path resolves outside project root: ${value}`); break; }
    catch (error) { if (error.code !== 'ENOENT' || mustExist) throw error; const parent = dirname(probe); if (parent === probe) throw error; probe = parent; }
  }
  if (mustExist && !(await stat(target)).isFile()) throw new Error(`path is not a file: ${value}`);
  if (!mustExist) {
    let component = root;
    for (const part of value.split('/')) {
      component = resolve(component, part);
      try { if ((await lstat(component)).isSymbolicLink()) throw new Error(`output path contains symlink: ${value}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return target;
}

async function writeIdentity(target) {
  let ancestor = target; const suffix = [];
  while (true) {
    try { const canonical = resolve(await realpath(ancestor), ...suffix.reverse()); return process.platform === 'win32' ? canonical.toLowerCase() : canonical; }
    catch (error) { if (error.code !== 'ENOENT') throw error; suffix.push(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor); }
  }
}

function ownershipMarker(kind, source) {
  return `<!-- reuse-catalog: ${JSON.stringify({ kind, source })} -->`;
}

/** Validate a catalog and its referenced files. Findings are stable, structured diagnostics. */
export async function validateReuseCatalog({ projectRoot, catalog, kind }) {
  const findings = [];
  const bad = (message, path) => findings.push(finding('invalid-catalog', message, path));
  if (!keys(catalog, ['schemaVersion', 'kind', 'title', 'entries', 'publicSurfaces'], ['schemaVersion', 'kind', 'title', 'entries']) || catalog.schemaVersion !== 1 || catalog.kind !== kind || !['frontend', 'backend'].includes(kind) || !string(catalog.title) || !Array.isArray(catalog.entries) || (catalog.publicSurfaces !== undefined && !Array.isArray(catalog.publicSurfaces))) {
    bad('catalog must match schemaVersion 1, expected kind, title and entries'); return { ok: false, findings };
  }
  const seen = new Set(); const paths = [];
  for (const [i, e] of catalog.entries.entries()) {
    const label = `entries[${i}]`;
    if (!keys(e, ['id','name','category','owner','scope','source','publicEntry','summary','useWhen','constraints','examples','tests']) || !['id','name','category','owner','source','summary','useWhen'].every((k) => string(e[k])) || !['scope','constraints','examples','tests'].every((k) => strings(e[k])) || !keys(e.publicEntry, ['module','symbol']) || !string(e.publicEntry.module) || !string(e.publicEntry.symbol)) { bad(`${label} has invalid or unknown fields`); continue; }
    if (seen.has(e.id)) findings.push(finding('duplicate-id', `duplicate entry id: ${e.id}`));
    seen.add(e.id); paths.push(e.source, ...e.examples, ...e.tests);
  }
  for (const [i, surface] of (catalog.publicSurfaces || []).entries()) {
    if (!keys(surface, ['source','module','kind']) || !Object.values(surface).every(string)) bad(`publicSurfaces[${i}] has invalid or unknown fields`);
    else paths.push(surface.source);
  }
  const root = await realpath(projectRoot);
  for (const path of [...new Set(paths)]) {
    try { await projectPath(root, path); } catch (error) { findings.push(finding('invalid-path', `${path}: ${error.message}`, path)); }
  }
  return { ok: findings.length === 0, findings };
}

const link = (from, path) => relative(dirname(from), path).split(sep).join('/') || path;
const md = (text) => text.replace(/[\\`*_\[\]<>]/g, '\\$&');
const code = (text) => '`' + text.replace(/`/g, '\\`') + '`';
/** Deterministic, non-canonical projection of a validated catalog. */
export function renderReuseCatalog({ catalog, source, document, sourceHash }) {
  const covers = [...new Set([...catalog.entries.map((e) => e.source), ...(catalog.publicSurfaces || []).map((s) => s.source)])].sort();
  const coverage = covers.length ? ['covers:', ...covers.map((path) => `  - ${JSON.stringify(path)}`)] : ['covers: []'];
  const lines = ['---', `title: ${JSON.stringify(catalog.title)}`, `description: ${JSON.stringify(`Generated ${catalog.kind} reuse catalog`)}`, 'authority: normal', ...coverage, '---', '', ownershipMarker(catalog.kind, source), '', `# ${md(catalog.title)}`, '', `> NON-CANONICAL generated projection. Source: [${md(source)}](${link(document, source)}); SHA-256: ${sourceHash}.`, ''];
  const groups = new Map();
  for (const e of [...catalog.entries].sort((a,b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) { if (!groups.has(e.category)) groups.set(e.category, []); groups.get(e.category).push(e); }
  for (const [category, entries] of groups) { lines.push(`## ${md(category)}`, ''); for (const e of entries) {
    lines.push(`### ${md(e.name)} (${md(e.id)})`, '', `- Owner: ${md(e.owner)}`, `- Source: [${md(e.source)}](${link(document,e.source)})`, `- Public entry: ${code(e.publicEntry.module)} / ${code(e.publicEntry.symbol)}`, `- Scope: ${e.scope.map(md).join(', ') || 'None'}`, `- Purpose: ${md(e.summary)}`, `- Use when: ${md(e.useWhen)}`, `- Boundaries: ${e.constraints.map(md).join('; ') || 'None'}`, `- Examples: ${e.examples.map((p) => `[${md(p)}](${link(document,p)})`).join(', ') || 'None'}`, `- Tests: ${e.tests.map((p) => `[${md(p)}](${link(document,p)})`).join(', ') || 'None'}`, '');
  } }
  return lines.join('\n');
}

/**
 * Run check or regeneration; no output is written until every configured catalog validates.
 * A consumer-supplied validateReuseCatalog callback is trusted project code and MUST be
 * read-only. It receives action and readOnly: true; this is a contract, not a sandbox.
 */
export async function runReuseCatalog({ projectRoot, action = 'check', validatePublicSurface } = {}) {
  if (!['check', 'regen'].includes(action)) throw new Error('action must be check or regen');
  const root = await realpath(projectRoot); let config;
  try { config = JSON.parse(await readFile(resolve(root, '.vibe-coding/project.config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { ok: true, skipped: true, findings: [], catalogs: [] }; return { ok: false, skipped: false, findings: [finding('invalid-config', error.message)], catalogs: [] }; }
  if (!object(config) || config.schemaVersion !== 1 || (config.contracts !== undefined && !object(config.contracts))) return { ok: false, skipped: false, findings: [finding('invalid-config', 'invalid project config or contracts')], catalogs: [] };
  const selection = config.contracts?.reuseCatalogs;
  if (selection === undefined || selection === false) return { ok: true, skipped: true, findings: [], catalogs: [] };
  if (!keys(selection, ['frontend','backend'], [])) return { ok: false, skipped: false, findings: [finding('invalid-config', 'reuseCatalogs must contain only frontend and backend')], catalogs: [] };
  const enabled = Object.entries(selection).filter(([, value]) => value !== false);
  if (!enabled.length) return { ok: true, skipped: true, findings: [], catalogs: [] };
  const findings = []; const catalogs = []; const prepared = []; const outputs = new Set(); const inputs = new Set();
  let callback = validatePublicSurface;
  if (callback !== undefined && typeof callback !== 'function') return { ok: false, skipped: false, findings: [finding('invalid-adapter', 'validatePublicSurface must be a function')], catalogs: [] };
  if (!callback && config.adapter) {
    try { const adapter = await loadProjectAdapter({ projectRoot: root }); callback = adapter.handlers?.validateReuseCatalog; if (callback !== undefined && typeof callback !== 'function') throw new Error('validateReuseCatalog must be a function'); }
    catch (error) { return { ok: false, skipped: false, findings: [finding('invalid-adapter', error.message)], catalogs: [] }; }
  }
  for (const [kind, options] of enabled) {
    if (!keys(options, ['source','document'], []) || Object.values(options).some((v) => !string(v))) { findings.push(finding('invalid-config', `${kind} must be false or an object with source and document paths`)); continue; }
    const { source, document } = { ...defaults[kind], ...options };
    try {
      if (!document.endsWith('.md')) throw new Error('document must be a Markdown (.md) path');
      const sourcePath = await projectPath(root, source); const documentPath = await projectPath(root, document, false);
      const identity = await writeIdentity(documentPath);
      if (sourcePath === documentPath || document === '.vibe-coding/project.config.json' || document === config.adapter || outputs.has(identity)) throw new Error('source and document paths must be distinct and outputs unique');
      outputs.add(identity);
      const raw = await readFile(sourcePath, 'utf8'); const catalog = JSON.parse(raw); inputs.add(await realpath(sourcePath));
      const validation = await validateReuseCatalog({ projectRoot: root, catalog, kind }); findings.push(...validation.findings);
      if (!validation.ok) continue;
      for (const input of [...catalog.entries.flatMap((e) => [e.source, ...e.examples, ...e.tests]), ...(catalog.publicSurfaces || []).map((s) => s.source)]) inputs.add(await realpath(resolve(root, input)));
      let publicSurface = 'unverified';
      if (callback) { const result = await callback({ projectRoot: root, kind, catalog, source, document, action, readOnly: true }); if (!result || result.ok !== true || result.skipped === true || result.skip === true) throw new Error('public-surface adapter rejected or did not verify catalog'); publicSurface = 'verified'; }
      const content = renderReuseCatalog({ catalog, source, document, sourceHash: createHash('sha256').update(raw).digest('hex') });
      catalogs.push({ kind, source, document, publicSurface }); prepared.push({ documentPath, document, content, kind, source });
    } catch (error) { findings.push(finding('catalog-error', `${kind}: ${error.message}`, source)); }
  }
  for (const entry of prepared) {
    let actual = entry.documentPath; let current;
    try { actual = await realpath(actual); current = await readFile(actual, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') { findings.push(finding('invalid-path', `${entry.document}: ${error.message}`, entry.document)); continue; } }
    if (inputs.has(actual) || actual === resolve(root, '.vibe-coding/project.config.json') || (config.adapter && actual === resolve(root, config.adapter))) findings.push(finding('invalid-path', `output overlaps a protected input: ${entry.document}`, entry.document));
    if (action === 'regen' && current !== undefined && !current.split('\n').includes(ownershipMarker(entry.kind, entry.source))) findings.push(finding('unowned-document', `refusing to replace non-generated document: ${entry.document}`, entry.document));
  }
  if (!findings.length && action === 'check') for (const entry of prepared) { let current; try { current = await readFile(entry.documentPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (current !== entry.content) findings.push(finding('stale-document', `generated document missing or stale: ${entry.document}`, entry.document)); }
  if (!findings.length && action === 'regen') for (const entry of prepared) { await mkdir(dirname(entry.documentPath), { recursive: true }); await writeFile(entry.documentPath, entry.content); }
  return { ok: findings.length === 0, skipped: false, findings, catalogs };
}
