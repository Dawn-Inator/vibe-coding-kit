import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncProjectSkills } from '../../src/skills/project-sync.mjs';
import test from 'node:test';
import { loadOptionalCatalog, resolveOptionalSelection } from '../../src/optional/catalog.mjs';
import { readOptionalGroupPreference } from '../../src/optional/preferences.mjs';
import { composeSources, resolveSkillSourcePath } from '../../src/skills/composition.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kit-optional-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kitRoot = join(root, 'kit'), projectRoot = join(root, 'project');
  const groups = { aliyun: { components: ['aliyun-skill-discovery'] }, lark: { components: ['lark'] }, 'non-code': { components: ['hyperframes', 'presentations'] }, 'task-progress': { components: ['codex-task-progress'] } };
  const components = Object.fromEntries(Object.values(groups).flatMap((g) => g.components).map((id) => [id, { type: id === 'codex-task-progress' ? 'plugin' : 'skills', path: `optional/${id}`, skillsPath: 'skills', skills: id === 'presentations' ? ['animated-presentations'] : id === 'lark' ? ['lark', 'feishu-bugfix-workflow'] : id === 'codex-task-progress' ? [] : [id] }]));
  components.lark.pack = { entry: 'lark', memberPrefix: 'feishu-' };
  mkdirSync(join(kitRoot, 'skills'), { recursive: true });
  mkdirSync(join(projectRoot, '.vibe-coding', 'skills'), { recursive: true });
  for (const component of Object.values(components)) for (const name of component.skills) {
    const dir = join(kitRoot, component.path, component.skillsPath, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\ncommon\n`);
  }
  mkdirSync(join(kitRoot, 'optional', 'codex-task-progress'), { recursive: true });
  const catalog = { schemaVersion: 1, groups, components };
  const writeCatalog = () => writeFileSync(join(kitRoot, 'optional', 'catalog.json'), JSON.stringify(catalog));
  writeCatalog();
  return { kitRoot, projectRoot, catalog, writeCatalog };
}

test('fresh selection is opt in and validates preferences', (t) => {
  const f = fixture(t);
  assert.deepEqual(resolveOptionalSelection({ ...f, fresh: true }).selection, { aliyun: false, lark: false, 'non-code': false, 'task-progress': false });
  const chosen = resolveOptionalSelection({ ...f, overrides: { lark: true }, fresh: true });
  assert.deepEqual([...chosen.skills.keys()], ['lark', 'feishu-bugfix-workflow']);
  assert.deepEqual(chosen.packs[0].members, ['feishu-bugfix-workflow']);
  assert.throws(() => resolveOptionalSelection({ ...f, overrides: { typo: true } }), /unknown optional group/);
  assert.throws(() => resolveOptionalSelection({ ...f, overrides: { lark: 'yes' } }), /boolean/);
});

test('disabled groups suppress local and configured sources; legacy keeps decisions and source lookup', (t) => {
  const f = fixture(t), name = 'animated-presentations';
  const dir = join(f.projectRoot, '.vibe-coding', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'EXTENSION.md'), `---\nname: ${name}\n---\nlocal extension\n`);
  const skillsConfig = { skills: { [name]: { mode: 'extend' } } };
  const composed = composeSources({ ...f, skillsConfig });
  assert.match(composed.skills.get(name).content, /local extension/);
  assert.match(resolveSkillSourcePath({ ...f, skillsConfig, name, path: 'SKILL.md' }), /optional\/presentations/);
  const projectConfig = { optional: { 'non-code': false } };
  assert.equal(composeSources({ ...f, skillsConfig, projectConfig }).skills.has(name), false);
  assert.throws(() => resolveSkillSourcePath({ ...f, skillsConfig, projectConfig, name, path: 'SKILL.md' }), /disabled/);
});

test('catalog rejects unsafe IDs and missing selected sources', (t) => {
  const f = fixture(t);
  f.catalog.components.hyperframes.path = '../escape'; f.writeCatalog();
  assert.throws(() => loadOptionalCatalog(f.kitRoot), /invalid component/);
  f.catalog.components.hyperframes.path = 'optional/hyperframes'; f.writeCatalog();
  rmSync(join(f.kitRoot, 'optional', 'hyperframes', 'skills', 'hyperframes', 'SKILL.md'));
  assert.throws(() => resolveOptionalSelection({ ...f, overrides: { 'non-code': true } }), /missing source/);
});

test('preference reader is synchronous and rejects malformed configuration', (t) => {
  const f = fixture(t), path = join(f.projectRoot, '.vibe-coding', 'project.config.json');
  assert.equal(readOptionalGroupPreference(f.projectRoot, 'lark'), undefined);
  writeFileSync(path, JSON.stringify({ optional: { lark: false } }));
  assert.equal(readOptionalGroupPreference(f.projectRoot, 'lark'), false);
  writeFileSync(path, JSON.stringify({ optional: { lark: 'false' } }));
  assert.throws(() => readOptionalGroupPreference(f.projectRoot, 'lark'), /boolean/);
  assert.throws(() => readOptionalGroupPreference(f.projectRoot, '../bad'), /unknown/);
});

test('catalog components come from its references and invalid references fail closed', (t) => {
  const f = fixture(t);
  f.catalog.components['alternate-lark'] = { ...f.catalog.components.lark, path: 'optional/alternate-lark', skills: [] };
  delete f.catalog.components.lark;
  f.catalog.groups.lark.components = ['alternate-lark'];
  delete f.catalog.components['alternate-lark'].pack;
  f.writeCatalog();
  assert.ok(loadOptionalCatalog(f.kitRoot).components['alternate-lark']);
  f.catalog.groups.lark.components.push('missing'); f.writeCatalog();
  assert.throws(() => loadOptionalCatalog(f.kitRoot), /component reference/);
  f.catalog.groups.lark.components.pop();
  f.catalog.groups.aliyun.components.push('alternate-lark'); f.writeCatalog();
  assert.throws(() => loadOptionalCatalog(f.kitRoot), /component reference/);
});

test('legacy exclude alone does not select a group and omitted new groups are off', (t) => {
  const f = fixture(t);
  const skillsConfig = { skills: { 'animated-presentations': { mode: 'exclude', rationale: 'unused' } } };
  const legacy = resolveOptionalSelection({ ...f, projectConfig: { skills: skillsConfig } });
  assert.equal(legacy.selection['non-code'], false);
  assert.equal(composeSources({ ...f, skillsConfig }).skills.has('animated-presentations'), false);
  const configured = { skills: { 'animated-presentations': { mode: 'adopt' } } };
  assert.equal(composeSources({ ...f, skillsConfig: configured, projectConfig: { optional: {} } }).skills.has('animated-presentations'), false);
});

test('legacy local decisions and pack configuration retain their prior behavior', (t) => {
  const f = fixture(t);
  for (const name of ['lark', 'feishu-bugfix-workflow']) {
    const dir = join(f.projectRoot, '.vibe-coding', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: local\n---\nlocal\n`);
  }
  const skillsConfig = { skills: { lark: { mode: 'local' }, 'feishu-bugfix-workflow': { mode: 'local' } }, packs: [] };
  const legacy = composeSources({ ...f, skillsConfig });
  assert.match(legacy.skills.get('lark').content, /local/);
  assert.deepEqual(legacy.packs, []);
  assert.match(resolveSkillSourcePath({ ...f, skillsConfig, name: 'lark', path: 'SKILL.md' }), /project\/\.vibe-coding/);
  const selected = resolveOptionalSelection({ ...f, projectConfig: { optional: { lark: true } } });
  assert.equal(selected.packs.length, 1);
});

const realKitRoot = fileURLToPath(new URL('../..', import.meta.url));
function realProject(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kit-optional-real-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(join(projectRoot, '.vibe-coding', 'skills'), { recursive: true });
  const skills = Object.fromEntries(readdirSync(join(realKitRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => [entry.name, { mode: 'adopt' }]));
  return { projectRoot, kitRoot: realKitRoot, skillsConfig: { skills } };
}

test('all sixteen combinations compose the actual catalog skills and packs', (t) => {
  const f = realProject(t);
  const catalog = loadOptionalCatalog(realKitRoot);
  const groups = Object.keys(catalog.groups);
  for (let mask = 0; mask < 16; mask++) {
    const optional = Object.fromEntries(groups.map((group, index) => [group, Boolean(mask & (1 << index))]));
    const result = composeSources({ ...f, projectConfig: { optional } });
    const expectedPacks = [];
    for (const group of groups) for (const id of catalog.groups[group].components) {
      const component = catalog.components[id];
      for (const name of component.skills) assert.equal(result.skills.has(name), optional[group], `${mask}: ${group}/${name}`);
      if (optional[group] && component.pack) expectedPacks.push(id);
    }
    assert.deepEqual(result.packs.map((pack) => pack.id).sort(), expectedPacks.sort(), `packs for ${mask}`);
  }
});

test('project sync removes disabled mirrors while preserving extension, credentials, and history', (t) => {
  const f = realProject(t);
  const configPath = join(f.projectRoot, '.vibe-coding', 'project.config.json');
  const extension = join(f.projectRoot, '.vibe-coding', 'skills', 'animated-presentations', 'EXTENSION.md');
  const credentials = join(f.projectRoot, '.vibe-coding', 'credentials.json');
  const history = join(f.projectRoot, '.workspace', 'history.md');
  for (const path of [extension, credentials, history]) mkdirSync(join(path, '..'), { recursive: true });
  const preserved = new Map([[extension, '---\nname: animated-presentations\n---\ncustom appendix\n'], [credentials, '{"token":"example"}\n'], [history, 'historical notes\n']]);
  for (const [path, content] of preserved) writeFileSync(path, content);
  const config = { schemaVersion: 1, kit: { path: '.vibe-coding/kit', url: 'https://example.invalid/kit.git' }, adapter: 'test', identity: { name: 'Test', email: 'test@example.invalid' }, skills: { skills: { ...f.skillsConfig.skills, 'animated-presentations': { mode: 'extend' } } }, optional: { lark: true, 'non-code': true } };
  const writeConfig = () => writeFileSync(configPath, JSON.stringify(config));
  writeConfig();
  syncProjectSkills(f);
  const entry = join(f.projectRoot, '.agents', 'skills', 'lark', 'SKILL.md');
  const member = join(f.projectRoot, '.agents', 'skill-packs', 'lark-doc', 'SKILL.md');
  const slides = join(f.projectRoot, '.agents', 'skills', 'animated-presentations', 'SKILL.md');
  assert.ok(existsSync(entry)); assert.ok(existsSync(member));
  assert.match(readFileSync(slides, 'utf8'), /custom appendix/);
  config.optional = { lark: false, 'non-code': false }; writeConfig();
  syncProjectSkills(f);
  for (const path of [entry, member, slides]) assert.equal(existsSync(path), false, path);
  for (const [path, content] of preserved) assert.equal(readFileSync(path, 'utf8'), content);
});

test('selected optional skill detects undeclared customization collisions without altering local source', (t) => {
  const f = realProject(t);
  const dir = join(f.projectRoot, '.vibe-coding', 'skills', 'animated-presentations');
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'SKILL.md'), contents = '---\nname: animated-presentations\ndescription: local\n---\ncustom\n';
  writeFileSync(source, contents);
  assert.throws(() => composeSources({ ...f, projectConfig: { optional: { 'non-code': true } } }), /collision/);
  assert.equal(readFileSync(source, 'utf8'), contents);
});
