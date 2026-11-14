import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runReuseCatalog, validateReuseCatalog } from '../../src/contracts/reuse-catalog.mjs';

async function setup(t, selection = { frontend: {} }) {
  const root = await mkdtemp(join(tmpdir(), 'reuse-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const catalog = { schemaVersion: 1, kind: 'frontend', title: 'Components', entries: [{ id:'button', name:'Button', category:'Controls', owner:'UI', scope:['web'], source:'src/button.ts', publicEntry:{ module:'ui', symbol:'Button' }, summary:'Button', useWhen:'Actions', constraints:['Public only'], examples:['src/example.ts'], tests:['test/button.test.ts'] }] };
  await put('.vibe-coding/project.config.json', { schemaVersion: 1, contracts: { reuseCatalogs: selection } });
  for (const path of ['src/button.ts','src/example.ts','test/button.test.ts']) await put(path, 'content');
  await put('registries/architecture/frontend-components.json', catalog);
  return { root, put, catalog };
}

test('regen and check are deterministic and check identifies stale documents', async (t) => {
  const { root } = await setup(t);
  const missing = await runReuseCatalog({ projectRoot: root });
  assert.equal(missing.ok, false); assert.equal(missing.findings[0].code, 'stale-document');
  const generated = await runReuseCatalog({ projectRoot: root, action: 'regen' });
  assert.equal(generated.ok, true); assert.equal(generated.catalogs[0].publicSurface, 'unverified');
  const path = join(root, 'doc/frontend-components.md'); const first = await readFile(path, 'utf8');
  assert.match(first, /covers:\n  - "src\/button\.ts"/); assert.match(first, /NON-CANONICAL/); assert.match(first, /Button/); assert.match(first, /SHA-256/);
  assert.equal((await runReuseCatalog({ projectRoot: root })).ok, true);
  await runReuseCatalog({ projectRoot: root, action: 'regen' }); assert.equal(await readFile(path, 'utf8'), first);
  await writeFile(path, 'stale'); assert.equal((await runReuseCatalog({ projectRoot: root })).findings[0].code, 'stale-document');
});

test('disabled and absent config explicitly skip without output', async (t) => {
  const { root, put } = await setup(t, { frontend: false });
  assert.equal((await runReuseCatalog({ projectRoot: root, action: 'regen' })).skipped, true);
  await put('.vibe-coding/project.config.json', { schemaVersion: 1, contracts: {} });
  assert.equal((await runReuseCatalog({ projectRoot: root })).skipped, true);
  await assert.rejects(readFile(join(root, 'doc/frontend-components.md')));
});

test('config override and adapter verification', async (t) => {
  const { root, put, catalog } = await setup(t, { frontend: { source:'custom/catalog.json', document:'custom/output.md' } });
  await put('custom/catalog.json', catalog);
  await put('.vibe-coding/project.config.json', { schemaVersion:1, adapter:'adapter.mjs', contracts:{ reuseCatalogs:{frontend:{source:'custom/catalog.json',document:'custom/output.md'}} } });
  await put('adapter.mjs', `export const adapterContract = { schemaVersion: 1, hooks: {} }; export function validateReuseCatalog({catalog}) { return {ok: catalog.entries[0].publicEntry.symbol === 'Button'}; }`);
  assert.equal((await runReuseCatalog({ projectRoot:root, action:'regen' })).catalogs[0].publicSurface, 'verified');
  const rejected = await runReuseCatalog({ projectRoot:root, action:'regen', validatePublicSurface: () => ({ok:false}) });
  assert.equal(rejected.ok, false); assert.match(rejected.findings[0].message, /rejected/);
});

test('schema, duplicate ids and missing or escaping paths fail closed', async (t) => {
  const { root, put, catalog } = await setup(t);
  catalog.entries.push({ ...catalog.entries[0], source:'../outside' });
  let result = await validateReuseCatalog({ projectRoot:root, kind:'frontend', catalog });
  assert.ok(result.findings.some((f) => f.code === 'duplicate-id'));
  assert.ok(result.findings.some((f) => f.code === 'invalid-path'));
  catalog.entries[0].tests = ['missing'];
  catalog.entries[1].extra = true;
  result = await validateReuseCatalog({ projectRoot:root, kind:'frontend', catalog });
  assert.ok(result.findings.some((f) => f.code === 'invalid-path'));
  assert.ok(result.findings.some((f) => f.code === 'invalid-catalog'));
  await put('registries/architecture/frontend-components.json', catalog);
  assert.equal((await runReuseCatalog({ projectRoot:root, action:'regen' })).ok, false);
  await assert.rejects(readFile(join(root, 'doc/frontend-components.md')));
});

test('malformed configuration and opted-in missing inputs fail', async (t) => {
  const { root, put } = await setup(t, { frontend: true });
  assert.equal((await runReuseCatalog({ projectRoot:root })).ok, false);
  await put('.vibe-coding/project.config.json', { schemaVersion:1, contracts:{reuseCatalogs:{backend:{}}} });
  assert.equal((await runReuseCatalog({ projectRoot:root })).ok, false);
});
