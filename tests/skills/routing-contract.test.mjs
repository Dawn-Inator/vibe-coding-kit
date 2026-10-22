// rot-gate: static-guard pattern=/(active instructions|class guard|copied installation)/ (recursive retired-consumer scan and portable installation contract)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
    const bundled = join(ancestor, 'vibe-coding', 'skills');
    const installed = join(ancestor, '.vibe-coding', 'skills');
    if (existsSync(join(bundled, GUARDRAILS_SKILL, 'SKILL.md')))
      return { root: ancestor, skillsRoot: bundled, vibeRoot: join(ancestor, 'vibe-coding') };
    if (existsSync(join(installed, GUARDRAILS_SKILL, 'SKILL.md')))
      return { root: ancestor, skillsRoot: installed, vibeRoot: join(ancestor, '.vibe-coding') };
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot locate ${GUARDRAILS_SKILL} from ${modulePath}`);
    ancestor = parent;
  }
}

const layout = findLayout(fileURLToPath(import.meta.url));
const loadingPath = join(layout.vibeRoot, 'loading.md');

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
  const kitSkills = join(layout.root, 'vibe-coding', 'skills');
  if (existsSync(kitSkills)) assert.equal(existsSync(join(kitSkills, RETIRED_SKILL)), false);
});

test('active instructions cannot route through the retired skill or require its startup pause', () => {
  const paths = [...markdownFiles(layout.skillsRoot), loadingPath];
  assert.ok(paths.length > 10, 'scan must cover skill entries and references');
  assert.deepEqual(paths.filter((path) => staleRoutingConsumer(readFileSync(path, 'utf8'))), []);
});

test('dispatch-only model choice remains in the existing orchestration authority', () => {
  const guardrails = readFileSync(join(layout.skillsRoot, GUARDRAILS_SKILL, 'SKILL.md'), 'utf8');
  const loading = readFileSync(loadingPath, 'utf8');
  assert.match(guardrails, /Keep the developer-selected model and effort/);
  assert.doesNotMatch(guardrails, /Session-start model advice is optional|Session-start routing is optional/);
  assert.match(guardrails, /Every dispatch sets `model` explicitly/);
  assert.match(guardrails, /explicit model, explicit effort/);
  assert.match(guardrails, /never mix an override with a full-history fork/);
  assert.match(guardrails, /Haiku read-only only; Sonnet for every write-capable task/);
  assert.match(guardrails, /Luna is the default executor/);
  assert.match(guardrails, /Terra is the fallback/);
  assert.match(loading, /派发任一 subagent \/ worker[^\n]*agent-orchestration-guardrails/);
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

test('copied installation finds retired-entry and dispatch rules without cwd or git', () => {
  const fixture = mkdtempTracked('routing-retirement-installed-');
  const project = join(fixture, 'project');
  const installedVibe = join(project, '.vibe-coding');
  const automation = join(project, 'engineering', 'automation');
  const sourceKit = join(dirname(fileURLToPath(import.meta.url)), '..');
  mkdirSync(project, { recursive: true });
  cpSync(layout.vibeRoot, installedVibe, { recursive: true });
  mkdirSync(automation, { recursive: true });
  for (const directory of ['agent-skills', 'testing-support'])
    cpSync(join(sourceKit, directory), join(automation, directory), { recursive: true });

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const installedTest = join(automation, 'agent-skills', 'routing-contract.test.mjs');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-name-pattern=^(retired startup model-routing skill|active instructions|dispatch-only model choice|class guard)',
      installedTest,
    ],
    { cwd: tmpdir(), encoding: 'utf8', env: childEnv },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /tests 4/);
  assert.match(output, /pass 4/);
});
