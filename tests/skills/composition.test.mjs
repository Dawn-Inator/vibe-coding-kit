import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { composeSkill, composeSources, resolveSkillSourcePath } from '../../src/skills/composition.mjs';

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-skill-composition-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const kitRoot = join(root, 'kit');
  mkdirSync(join(projectRoot, '.vibe-coding', 'skills'), { recursive: true });
  mkdirSync(join(kitRoot, 'skills'), { recursive: true });
  return { root, projectRoot, kitRoot, commonRoot: join(kitRoot, 'skills'), localRoot: join(projectRoot, '.vibe-coding', 'skills') };
}
function putSkill(root, name, text, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
function putExtension(root, name, text, files = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'EXTENSION.md'), text);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('adopt keeps the common body, frontmatter and relative assets intact', () => {
  const f = fixture();
  const source = '---\nname: agent-orchestration-guardrails\ndescription: common trigger\n---\n\n# Shared\n\n[details](references/rules.md)';
  putSkill(f.commonRoot, 'agent-orchestration-guardrails', source, { 'references/rules.md': 'common rules' });
  const result = composeSkill({ name: 'agent-orchestration-guardrails', commonRoot: f.commonRoot, localRoot: f.localRoot, mode: 'adopt' });
  assert.equal(result.content, source);
  assert.equal(result.files.get('references/rules.md').toString(), 'common rules');
  assert.equal(result.provenance.mode, 'adopt');
});

test('extend composes the two aligned native-layer skills from public bodies plus project appendices', () => {
  const f = fixture();
  for (const name of ['agent-orchestration-guardrails', 'agent-task-supervision']) {
    const publicBody = `---\nname: ${name}\ndescription: common\n---\n\n# ${name} shared body`;
    const projectBody = `---\nname: ${name}\n---\n\n## LingoFly Appendix\n\n[policy](references/policy.md)`;
    putSkill(f.commonRoot, name, publicBody, { 'references/rules.md': `${name} common rules` });
    putExtension(f.localRoot, name, projectBody, { 'references/policy.md': `${name} local policy` });
    const result = composeSkill({ name, commonRoot: f.commonRoot, localRoot: f.localRoot, mode: 'extend' });
    assert.ok(result.content.startsWith(publicBody));
    assert.ok(result.content.includes('## LingoFly Appendix'));
    assert.equal(result.files.get('references/rules.md').toString(), `${name} common rules`);
    assert.equal(result.files.get('references/policy.md').toString(), `${name} local policy`);
    assert.match(result.provenance.digest, /^[a-f0-9]{64}$/);
  }
});

test('composeSources fails closed on an undeclared same-name source collision', () => {
  const f = fixture();
  putSkill(f.commonRoot, 'same-name', '---\nname: same-name\n---\ncommon');
  putSkill(f.localRoot, 'same-name', '---\nname: same-name\n---\nlocal');
  assert.throws(() => composeSources({ ...f, skillsConfig: { skills: {} } }), /same-name.*collision/);
});

test('replacement requires an explicit rationale and preserves the local replacement only', () => {
  const f = fixture();
  putSkill(f.commonRoot, 'replaced', '---\nname: replaced\n---\ncommon body', { 'references/common.md': 'public' });
  putSkill(f.localRoot, 'replaced', '---\nname: replaced\n---\nlocal replacement', { 'references/local.md': 'local' });
  const config = { skills: { replaced: { mode: 'replace', rationale: 'Project policy deliberately replaces generic recipe.', replaces: 'replaced' } } };
  const result = composeSources({ ...f, skillsConfig: config }).skills.get('replaced');
  assert.equal(result.content, '---\nname: replaced\n---\nlocal replacement');
  assert.equal(result.files.has('references/common.md'), false);
  assert.equal(result.files.get('references/local.md').toString(), 'local');
  assert.equal(result.provenance.configuration.rationale, 'Project policy deliberately replaces generic recipe.');
  assert.throws(() => composeSources({ ...f, skillsConfig: { skills: { replaced: { mode: 'replace', replaces: 'replaced' } } } }), /requires rationale/);
});

test('project-local skills stay local and every public skill needs an explicit adoption decision', () => {
  const f = fixture();
  putSkill(f.commonRoot, 'optional-recipe', '---\nname: optional-recipe\n---\ncommon');
  putSkill(f.localRoot, 'project-rule', '---\nname: project-rule\n---\nlocal policy');
  const result = composeSources({
    ...f,
    skillsConfig: { skills: { 'optional-recipe': { mode: 'exclude', rationale: 'Covered by project-rule.' } } },
  });
  assert.deepEqual([...result.skills.keys()], ['project-rule']);
  assert.throws(() => composeSources({ ...f, skillsConfig: { skills: {} } }), /optional-recipe.*explicit/);
});

test('platform markers are resolved and local composition never writes into the public source', () => {
  const f = fixture();
  const common = '---\nname: platform-skill\n---\n\nbase\n<!-- BEGIN: claude-only -->\nclaude line\n<!-- END: claude-only -->\n<!-- BEGIN: agent-only -->\nagent line\n<!-- END: agent-only -->';
  const local = '---\nname: platform-skill\n---\n\nlocal appendix';
  const commonDir = putSkill(f.commonRoot, 'platform-skill', common, { 'scripts/run.mjs': 'common script' });
  putExtension(f.localRoot, 'platform-skill', local, { 'assets/local.txt': 'local asset' });
  const before = readFileSync(join(commonDir, 'SKILL.md'), 'utf8');
  const result = composeSkill({ name: 'platform-skill', commonRoot: f.commonRoot, localRoot: f.localRoot, mode: 'extend', platform: 'claude' });
  assert.match(result.content, /claude line/);
  assert.doesNotMatch(result.content, /agent line/);
  assert.equal(result.files.get('scripts/run.mjs').toString(), 'common script');
  assert.equal(result.files.get('assets/local.txt').toString(), 'local asset');
  assert.equal(readFileSync(join(commonDir, 'SKILL.md'), 'utf8'), before);
});

test('runtime source lookup prefers local extensions and resolves common scripts without mirrors', () => {
  const f = fixture();
  putSkill(f.commonRoot, 'runtime-skill', '---\nname: runtime-skill\n---\ncommon', { 'scripts/run.mjs': 'public' });
  putExtension(f.localRoot, 'runtime-skill', '---\nname: runtime-skill\n---\nextension', { 'references/local.md': 'local' });
  const skillsConfig = { skills: { 'runtime-skill': { mode: 'extend' } } };
  assert.equal(
    resolveSkillSourcePath({ projectRoot: f.projectRoot, kitRoot: f.kitRoot, skillsConfig, name: 'runtime-skill', path: 'scripts/run.mjs' }),
    join(f.kitRoot, 'skills/runtime-skill/scripts/run.mjs'),
  );
  assert.equal(
    resolveSkillSourcePath({ projectRoot: f.projectRoot, kitRoot: f.kitRoot, skillsConfig, name: 'runtime-skill', path: 'references/local.md' }),
    join(f.projectRoot, '.vibe-coding/skills/runtime-skill/references/local.md'),
  );
});

