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

test('regen protects unrelated existing files, adapter, config and catalog inputs', async (t) => {
  const { root, put, catalog } = await setup(t);
  const config = (document) => ({ schemaVersion:1, adapter:'adapter.md', contracts:{reuseCatalogs:{frontend:{document}}} });
  await put('adapter.md', `export const adapterContract = {schemaVersion:1,hooks:{}};`);
  await put('doc/existing.md', 'handwritten');
  await put('src/input.md', 'source'); catalog.entries[0].source = 'src/input.md';
  await put('registries/architecture/frontend-components.json', catalog);
  for (const target of ['doc/existing.md', 'adapter.md', '.vibe-coding/project.config.json', 'src/input.md']) {
    await put('.vibe-coding/project.config.json', config(target));
    const before = await readFile(join(root,target), 'utf8');
    const result = await runReuseCatalog({projectRoot:root, action:'regen'});
    assert.equal(result.ok, false, target);
    assert.equal(await readFile(join(root,target), 'utf8'), before, target);
  }
});

test('output symlinks and symlinked parent aliases fail closed', async (t) => {
  if (process.platform === 'win32') { t.skip('symlink creation may require Windows privileges'); return; }
  const { symlink } = await import('node:fs/promises');
  const { root, put } = await setup(t);
  await put('doc/real.md', 'handwritten'); await symlink('real.md', join(root,'doc/link.md'));
  await symlink('doc', join(root,'alias'));
  for (const document of ['doc/link.md','alias/real.md']) {
    await put('.vibe-coding/project.config.json', {schemaVersion:1,contracts:{reuseCatalogs:{frontend:{document}}}});
    const result = await runReuseCatalog({projectRoot:root, action:'regen'});
    assert.equal(result.ok, false); assert.match(result.findings[0].message, /symlink/);
  }
  assert.equal(await readFile(join(root,'doc/real.md'),'utf8'),'handwritten');
});

test('schema and runtime agree on string boundaries across every field', async (t) => {
  const { root, catalog } = await setup(t);
  const schema = JSON.parse(await readFile(new URL('../../schemas/reuse-catalog.schema.json', import.meta.url), 'utf8'));
  const entrySchema = schema.properties.entries.items.properties;
  const surfaceSchema = schema.properties.publicSurfaces.items.properties;
  const fields = [
    [schema.properties.title, (c, v) => { c.title = v; }],
    ...['id','name','category','owner','source','summary','useWhen'].map((field) => [entrySchema[field], (c, v) => { c.entries[0][field] = v; }]),
    ...['scope','constraints','examples','tests'].map((field) => [entrySchema[field].items, (c, v) => { c.entries[0][field] = [v]; }]),
    ...['module','symbol'].map((field) => [entrySchema.publicEntry.properties[field], (c, v) => { c.entries[0].publicEntry[field] = v; }]),
    ...['source','module','kind'].map((field) => [surfaceSchema[field], (c, v) => { c.publicSurfaces = [{source:'src/button.ts',module:'ui',kind:'module',[field]:v}]; }]),
  ];
  const boundaries = ['\r','\n','\u2028','\u2029'].flatMap((c) => [c + 'Title', 'Ti' + c + 'tle', 'Title' + c]);
  const values = ['Title', '文字', 'a\\n', 'a\\u2028', '', ' ', '\t', '\u00a0', '\u2003', ...boundaries];
  for (const [fieldSchema, assign] of fields) for (const value of values) {
    const schemaAccepts = value.length >= fieldSchema.minLength && new RegExp(fieldSchema.pattern).test(value);
    const copy = structuredClone(catalog); assign(copy, value);
    const result = await validateReuseCatalog({projectRoot:root, kind:'frontend', catalog:copy});
    // Missing or forbidden file paths are independently checked; compare only shape validation.
    const runtimeAccepts = !result.findings.some((item) => item.code === 'invalid-catalog');
    assert.equal(runtimeAccepts, schemaAccepts, JSON.stringify(value));
  }
});

test('check is read-only and supplies a read-only contract to trusted adapter', async (t) => {
  const { root, put } = await setup(t);
  await put('.vibe-coding/project.config.json', {schemaVersion:1,adapter:'adapter.mjs',contracts:{reuseCatalogs:{frontend:{}}}});
  await put('adapter.mjs', `export const adapterContract={schemaVersion:1,hooks:{}}; export function validateReuseCatalog(context) { if (context.readOnly !== true || context.action !== 'check') throw Error('missing read-only context'); return {ok:true}; }`);
  const configPath = join(root,'.vibe-coding/project.config.json'); const before = await readFile(configPath,'utf8');
  const result = await runReuseCatalog({projectRoot:root,action:'check'});
  assert.equal(result.findings[0].code,'stale-document'); assert.equal(await readFile(configPath,'utf8'),before);
  await assert.rejects(readFile(join(root,'doc/frontend-components.md')));
});

test('different configured output paths cannot alias through a symlink', async (t) => {
  if (process.platform === 'win32') { t.skip('symlink creation may require Windows privileges'); return; }
  const { symlink } = await import('node:fs/promises');
  const { root, put, catalog } = await setup(t);
  await mkdir(join(root,'doc'), {recursive:true}); await symlink('doc', join(root,'alias'));
  await put('registries/architecture/backend-capabilities.json', {...catalog,kind:'backend'});
  await put('.vibe-coding/project.config.json', {schemaVersion:1,contracts:{reuseCatalogs:{frontend:{document:'doc/shared.md'},backend:{document:'alias/shared.md'}}}});
  const result = await runReuseCatalog({projectRoot:root,action:'regen'});
  assert.equal(result.ok,false); assert.ok(result.findings.some((item) => /symlink|unique/.test(item.message)));
  await assert.rejects(readFile(join(root,'doc/shared.md')));
});
