// rot-gate: static-guard pattern=/(active instructions|class guard|copied installation)/ (recursive retired-consumer scan and portable installation contract)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempTracked } from '../support/temp-dirs.mjs';

const RETIRED_SKILL = 'ai-model-effort-routing';
const GUARDRAILS_SKILL = 'agent-orchestration-guardrails';

function findLayout(modulePath) {
  let ancestor = dirname(modulePath);
  while (true) {
    const publicRoot = join(ancestor, 'skills');
    if (existsSync(join(publicRoot, GUARDRAILS_SKILL, 'SKILL.md')))
      return {
        root: ancestor,
        skillsRoot: publicRoot,
        publicSkillsRoot: publicRoot,
        loadingPath: join(ancestor, 'templates', 'loading.md'),
      };
    const installedKit = join(ancestor, '.vibe-coding', 'kit', 'skills');
    if (existsSync(join(installedKit, GUARDRAILS_SKILL, 'SKILL.md')))
      return {
        root: ancestor,
        skillsRoot: installedKit,
        publicSkillsRoot: installedKit,
        loadingPath: join(ancestor, '.vibe-coding', 'loading.md'),
      };
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot locate ${GUARDRAILS_SKILL} from ${modulePath}`);
    ancestor = parent;
  }
}

const layout = findLayout(fileURLToPath(import.meta.url));
const loadingPath = layout.loadingPath;

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith('.md') && entry.name !== 'history.md' ? [path] : [];
  });
}

function staleRoutingConsumer(text) {
  return text.includes(`\`${RETIRED_SKILL}\``) ||
    /\]\([^)]*ai-model-effort-routing\/SKILL\.md(?:#[^)]*)?\)/u.test(text) ||
    /(?:At the beginning of a new conversation[^\n]*routing card|session-start model advice is optional|Session-start routing is optional)/iu.test(text) ||
    /(?:After the initial card, pause and wait|pause and wait for the developer to switch)/iu.test(text) ||
    /(?:high-stakes|high impact|failure cost)[^\n]{0,80}(?:maps to|means use|should use|choose|select|use)[^\n]{0,40}(?:strongest|frontier(?:-tier)?|highest tier)/iu.test(text) ||
    /(?:必须|新会话)[^\n]*(?:模型路由卡和切换等待|暂停一次供其切换)/u.test(text);
}

test('retired startup model-routing skill is absent from both discoverable source trees', () => {
  assert.equal(existsSync(join(layout.skillsRoot, RETIRED_SKILL)), false);
  assert.equal(existsSync(join(layout.publicSkillsRoot, RETIRED_SKILL)), false);
});

test('active instructions cannot route through the retired skill or require its startup pause', () => {
  const paths = [...markdownFiles(layout.skillsRoot), loadingPath];
  assert.ok(paths.length > 10, 'scan must cover skill entries and references');
  assert.deepEqual(paths.filter((path) => staleRoutingConsumer(readFileSync(path, 'utf8'))), []);
});

test('dispatch-only model choice remains in the existing orchestration authority', () => {
  const guardrails = readFileSync(join(layout.skillsRoot, GUARDRAILS_SKILL, 'SKILL.md'), 'utf8');
  assert.match(guardrails, /Keep the developer-selected model and effort/);
  assert.doesNotMatch(guardrails, /Session-start model advice is optional|Session-start routing is optional/);
  assert.match(guardrails, /Every dispatch sets `model` explicitly/);
  assert.match(guardrails, /explicit model, explicit effort/);
  assert.match(guardrails, /never mix an override with a full-history fork/);
  assert.match(guardrails, /Haiku read-only only; Sonnet for every write-capable task/);
  assert.match(guardrails, /Luna is the default executor/);
  assert.match(guardrails, /Terra is the fallback/);
});

test('class guard catches stale consumers in arbitrary paths and allows historical prose', () => {
  for (const [path, text] of [
    ['references/escaped-trigger.md', `Load \`${RETIRED_SKILL}\` before routing.`],
    ['templates/old-card.md', 'At the beginning of a new conversation, emit one routing card before the first read.'],
    ['references/old-pause.md', 'After the initial card, pause and wait for the developer to switch.'],
    ['references/optional-advice.md', 'Session-start model advice is optional and non-blocking.'],
    ['references/risk-tier-shortcut.md', 'High-stakes work should use the strongest tier.'],
  ]) assert.equal(staleRoutingConsumer(text), true, path);
  assert.equal(staleRoutingConsumer('History: the old model-routing skill has been retired.'), false);
  assert.equal(staleRoutingConsumer('Keep the developer-selected model and effort.'), false);
});

test('copied installation finds retired-entry and dispatch rules without cwd or git', async () => {
  const fixture = mkdtempTracked('routing-retirement-installed-');
  const project = join(fixture, 'project');
  const installedVibe = join(project, '.vibe-coding');
  const kitRoot = join(installedVibe, 'kit');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(kitRoot, 'skills'), { recursive: true });
  cpSync(layout.publicSkillsRoot, join(kitRoot, 'skills'), { recursive: true });
  mkdirSync(join(installedVibe, 'skills'), { recursive: true });
  cpSync(join(layout.root, 'templates', 'loading.md'), join(installedVibe, 'loading.md'));
  const config = JSON.parse(readFileSync(join(layout.root, 'templates', 'project.config.json'), 'utf8'));
  config.identity = { name: 'Fixture Owner', email: 'fixture@example.test' };
  config.skills.skills = Object.fromEntries(
    readdirSync(layout.publicSkillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, { mode: 'adopt' }]),
  );
  writeFileSync(join(installedVibe, 'project.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const { syncProjectSkills } = await import('../../src/skills/project-sync.mjs');
  syncProjectSkills({ projectRoot: project, kitRoot });
  const projected = readFileSync(join(project, '.agents', 'skills', GUARDRAILS_SKILL, 'SKILL.md'), 'utf8');
  assert.match(projected, /Every dispatch sets `model` explicitly/);
  const claudeProjection = readFileSync(join(project, '.claude', 'skills', GUARDRAILS_SKILL, 'SKILL.md'), 'utf8');
  assert.match(claudeProjection, /Workers never run package-level\/full tests/);

  const installedTests = join(project, 'tests');
  mkdirSync(join(installedTests, 'skills'), { recursive: true });
  cpSync(new URL('./routing-contract.test.mjs', import.meta.url), join(installedTests, 'skills/routing-contract.test.mjs'));
  cpSync(new URL('../support/', import.meta.url), join(installedTests, 'support'), { recursive: true });

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const installedTest = join(installedTests, 'skills', 'routing-contract.test.mjs');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=^(retired startup model-routing skill|active instructions|dispatch-only model choice|class guard)',
      installedTest,
    ],
    { cwd: tmpdir(), encoding: 'utf8', env: childEnv },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  for (const name of [
    'retired startup model-routing skill is absent from both discoverable source trees',
    'active instructions cannot route through the retired skill or require its startup pause',
    'dispatch-only model choice remains in the existing orchestration authority',
    'class guard catches stale consumers in arbitrary paths and allows historical prose',
  ]) {
    assert.ok(
      output.split(/\r?\n/).some((line) => /^ok \d+ - /.test(line) && line.endsWith(`- ${name}`)),
      name,
    );
  }
  assert.match(output, /^# pass 4$/m, output);
  assert.match(output, /^# fail 0$/m, output);
});
