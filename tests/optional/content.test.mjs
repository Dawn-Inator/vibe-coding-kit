import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { inspectOptionalComponent, installOptionalComponent } from '../../src/optional/runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const optionalRoot = join(root, 'optional');
const catalog = JSON.parse(readFileSync(join(optionalRoot, 'catalog.json'), 'utf8'));
const hyperframesSkills = [
  'embedded-captions', 'faceless-explainer', 'figma', 'general-video', 'hyperframes',
  'hyperframes-animation', 'hyperframes-audio', 'hyperframes-cli', 'hyperframes-core',
  'hyperframes-creative', 'hyperframes-keyframes', 'hyperframes-registry', 'hyperframes-studio',
  'media-use', 'motion-graphics', 'music-to-video', 'pr-to-video', 'product-launch-video',
  'remotion-to-hyperframes', 'slideshow', 'talking-head-recut',
];
const larkSkills = [
  'lark', 'lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar',
  'lark-cli-install', 'lark-contact', 'lark-doc', 'lark-drive', 'lark-event', 'lark-im',
  'lark-mail', 'lark-markdown', 'lark-minutes', 'lark-note', 'lark-okr', 'lark-openapi-explorer',
  'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task', 'lark-vc',
  'lark-vc-agent', 'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary',
  'lark-workflow-standup-report', 'feishu-bugfix-workflow',
];

function listFiles(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path);
    return [path];
  });
}

function treeHash(dir) {
  const hash = createHash('sha256');
  for (const path of listFiles(dir)) {
    hash.update(relative(dir, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('optional catalog exposes the five opted-in components and frozen group questions', () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(Object.keys(catalog.components).sort(), [
    'aliyun-skill-discovery', 'codex-task-progress', 'hyperframes', 'lark', 'presentations',
  ]);
  assert.deepEqual(catalog.groups, {
    aliyun: { question: '是否使用阿里云？', components: ['aliyun-skill-discovery'] },
    lark: { question: '是否使用飞书？', components: ['lark'] },
    'non-code': { question: '是否需要非代码能力，例如演示文稿、视频制作？', components: ['hyperframes', 'presentations'] },
    'task-progress': { question: '是否安装任务进度插件？', components: ['codex-task-progress'] },
  });
});

test('catalog memberships point at complete staged content and retain factual provenance', () => {
  const expected = {
    'aliyun-skill-discovery': ['alibabacloud-find-skills'],
    lark: larkSkills,
    hyperframes: hyperframesSkills,
    presentations: ['animated-presentations'],
    'codex-task-progress': [],
  };
  for (const [id, skills] of Object.entries(expected)) {
    const component = catalog.components[id];
    assert.deepEqual([...component.skills].sort(), [...skills].sort(), `${id} skill membership`);
    assert.ok(component.path.startsWith('optional/'));
    assert.equal(typeof component.provenance, 'object');
  }
  assert.equal(catalog.components['codex-task-progress'].type, 'plugin');
  assert.equal(catalog.components['codex-task-progress'].nativePluginSkill, true);
  assert.equal(catalog.components.lark.pack.entry, 'lark');
  assert.equal(catalog.components.lark.requirements[0].command, 'lark-cli --version');
  assert.deepEqual(catalog.components.lark.provenance.externalReferenceUrls, ['https://github.com/larksuite/cli/blob/v1.0.98/events/im/message_receive.go']);
  assert.equal(catalog.components['aliyun-skill-discovery'].requirements[0].command, 'curl --version');
  assert.equal(catalog.components.hyperframes.provenance.license, 'Apache-2.0');
  assert.equal(catalog.components.hyperframes.provenance.sourceRevision, 'bf881bf79d68cc78b52624f6431644ac152b2723');
  assert.match(catalog.components['aliyun-skill-discovery'].provenance.upstreamSkillSha256, /^[a-f0-9]{64}$/);
  assert.equal(catalog.components['aliyun-skill-discovery'].provenance.license, 'not-stated-in-imported-files');
  assert.equal(catalog.components.lark.provenance.license, 'not-stated-in-imported-files');
  assert.equal(catalog.components.presentations.provenance.license, 'not-stated-in-imported-files');
  for (const id of ['aliyun-skill-discovery', 'lark', 'hyperframes', 'presentations']) {
    const component = catalog.components[id];
    assert.match(component.provenance.stagedTreeSha256, /^[a-f0-9]{64}$/);
    assert.equal(component.provenance.stagedTreeSha256, treeHash(join(root, component.path)), `${id} provenance hash`);
  }
});

test('catalog provides platform, detection, and installation metadata for the optional installer', () => {
  for (const [id, component] of Object.entries(catalog.components)) {
    assert.deepEqual(component.platforms, id === 'codex-task-progress' ? ['darwin-arm64'] : ['*'], `${id} supported platforms`);
    assert.deepEqual(component.detection, { entry: 'src/optional/runtime.mjs', export: 'inspectOptionalComponent' });
    assert.ok(existsSync(join(root, component.detection.entry)), `${id} detection entry exists`);
    assert.equal(typeof inspectOptionalComponent, 'function', `${id} detection export exists`);
    assert.equal(component.installation.entry, 'src/optional/runtime.mjs');
    assert.equal(component.installation.export, 'installOptionalComponent');
    assert.ok(existsSync(join(root, component.installation.entry)), `${id} installation entry exists`);
    assert.equal(typeof installOptionalComponent, 'function', `${id} installation export exists`);
  }
  assert.equal(catalog.components['codex-task-progress'].installation.script, 'optional/codex-task-progress/scripts/install-from-kit.mjs');
  assert.ok(existsSync(join(root, catalog.components['codex-task-progress'].installation.script)));
  for (const id of ['aliyun-skill-discovery', 'lark', 'hyperframes', 'presentations']) {
    assert.equal(catalog.components[id].installation.script, undefined, `${id} uses the runtime without a plugin installer script`);
  }
});

test('skill IDs, local navigation, third-party notices, and project-private markers stay coherent', () => {
  for (const [id, component] of Object.entries(catalog.components)) {
    if (component.type !== 'skills') continue;
    for (const skill of component.skills) {
      const dir = join(root, component.path, component.skillsPath, skill);
      const skillFile = join(dir, 'SKILL.md');
      assert.ok(existsSync(skillFile), `${id}/${skill} is present`);
      const source = readFileSync(skillFile, 'utf8');
      assert.ok(source.startsWith(`---\nname: ${skill}\n`), `${id}/${skill} frontmatter name`);
      assert.doesNotMatch(source, /lingofly|glosight|dawn-inator/i, `${id}/${skill} has no project/private branding`);
    }
  }

  const hyperframes = catalog.components.hyperframes;
  assert.ok(existsSync(join(root, hyperframes.path, 'skills', 'hyperframes', 'LICENSE')));
  const allMarkdown = ['aliyun-skill-discovery', 'lark', 'hyperframes', 'presentations']
    .flatMap((id) => listFiles(join(root, catalog.components[id].path)).filter((path) => extname(path) === '.md'));
  for (const file of allMarkdown) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /lingofly|glosight|dawn-inator/i, `${relative(root, file)} has no project/private branding`);
  }
  for (const file of allMarkdown) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].split('#')[0];
      if (!raw.startsWith('./') && !raw.startsWith('../')) continue;
      if (/[<>]/.test(raw) || raw.includes('://')) continue;
      // These are literal sample paths in explanations that local images are unsupported, not documentation links.
      if (raw === './a.png' && /\/lark-im-messages-(?:reply|send)\.md$/.test(file)) continue;
      const target = resolve(dirname(file), raw);
      const component = Object.entries(catalog.components).find(([, value]) => value.type === 'skills' && file.startsWith(join(root, value.path) + '/'))?.[1];
      assert.ok(component, `component found for ${file}`);
      const componentRoot = join(root, component.path);
      // Upstream examples may link to source-tree paths outside this component; validate navigation kept inside the pack.
      if (target.startsWith(componentRoot + '/')) assert.ok(existsSync(target), `${relative(root, file)} -> ${raw}`);
      if (file.endsWith('/feishu-bugfix-workflow/SKILL.md') && raw.includes('/skills/bugfix-regression-tests/')) {
        assert.ok(existsSync(target), `${relative(root, file)} resolves Kit core link ${raw}`);
      }
    }
  }
});
