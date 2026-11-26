// orchestration/roles.test.mjs
//
// Role-definition sync into a temp project (ownership marker, drift, conflicts, exclusion), its wiring into
// syncProjectSkills, and class guards on the shipped roles: pinned models that match the tier map, and tool
// allowlists that make read-only roles read-only and keep module owners from dispatching.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ROLE_SOURCE_DIR,
  expectedRoles,
  isGenerated,
  parseRole,
  roleTools,
  syncRoleDefinitions,
} from '../../src/orchestration/roles.mjs';
import { syncProjectSkills } from '../../src/skills/project-sync.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED = readdirSync(join(KIT, ROLE_SOURCE_DIR)).filter((n) => n.endsWith('.md')).sort();
const agentsPath = (root, name) => join(root, '.claude', 'agents', name);

test('sync writes every shipped role with the generated marker, and check is then clean', () => {
  const root = mkdtempTracked('roles-sync-');
  const before = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {}, checkOnly: true });
  assert.equal(before.ok, false);
  assert.equal(before.problems.length, SHIPPED.length);
  assert.ok(before.problems.every((p) => p.startsWith('missing: .claude/agents/')));
  assert.equal(existsSync(join(root, '.claude')), false, 'check mode must not write');

  const synced = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} });
  assert.equal(synced.written, SHIPPED.length);
  assert.deepEqual(synced.roles, SHIPPED);
  for (const name of SHIPPED) {
    const text = readFileSync(agentsPath(root, name), 'utf8');
    assert.ok(isGenerated(text), name);
    assert.equal(parseRole(name, text).fields.name, name.replace(/\.md$/, ''));
  }
  assert.deepEqual(syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {}, checkOnly: true }).problems, []);
  assert.equal(syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} }).written, 0);
});

test('drift is reported in check mode and repaired by sync; stale or legacy generated roles (such as vck-*) are removed', () => {
  const root = mkdtempTracked('roles-drift-');
  syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} });
  const target = agentsPath(root, SHIPPED[0]);
  writeFileSync(target, `${readFileSync(target, 'utf8')}\nlocal edit\n`);
  writeFileSync(agentsPath(root, 'vck-retired.md'), readFileSync(target, 'utf8').replace(/^name: .+$/m, 'name: vck-retired'));
  const check = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {}, checkOnly: true });
  assert.deepEqual(check.problems.sort(), [`stale: .claude/agents/${SHIPPED[0]}`, 'unexpected: .claude/agents/vck-retired.md'].sort());
  const repaired = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} });
  assert.equal(repaired.written, 1);
  assert.equal(repaired.removed, 1);
  assert.equal(existsSync(agentsPath(root, 'vck-retired.md')), false);
  assert.ok(syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {}, checkOnly: true }).ok);
});

test('a project-owned file is never overwritten or removed, even when it shares a kit role name', () => {
  const root = mkdtempTracked('roles-conflict-');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  const own = '---\nname: reviewer\ndescription: our own reviewer\nmodel: sonnet\n---\n\nProject body.\n';
  writeFileSync(agentsPath(root, 'reviewer.md'), own);
  writeFileSync(agentsPath(root, 'local-helper.md'), '---\nname: local-helper\nmodel: haiku\n---\n\nOurs.\n');
  const result = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['conflict: .claude/agents/reviewer.md exists and is not kit-generated; rename or remove it to receive the kit role']);
  assert.equal(readFileSync(agentsPath(root, 'reviewer.md'), 'utf8'), own);
  assert.equal(existsSync(agentsPath(root, 'local-helper.md')), true);
});

test('excluding the orchestration skill removes generated roles and keeps project files', () => {
  const root = mkdtempTracked('roles-exclude-');
  syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: {} });
  writeFileSync(agentsPath(root, 'ours.md'), '---\nname: ours\nmodel: haiku\n---\n\nOurs.\n');
  const excluded = { skills: { skills: { 'agent-orchestration-guardrails': { mode: 'exclude', rationale: 'test' } } } };
  assert.equal(expectedRoles(KIT, excluded).size, 0);
  const result = syncRoleDefinitions({ projectRoot: root, kitRoot: KIT, projectConfig: excluded });
  assert.equal(result.removed, SHIPPED.length);
  assert.deepEqual(readdirSync(join(root, '.claude', 'agents')), ['ours.md']);
});

test('a kit without role sources is a no-op', () => {
  const root = mkdtempTracked('roles-none-');
  const emptyKit = mkdtempTracked('roles-empty-kit-');
  const result = syncRoleDefinitions({ projectRoot: root, kitRoot: emptyKit, projectConfig: {} });
  assert.deepEqual(result, { ok: true, problems: [], written: 0, removed: 0, roles: [] });
  assert.equal(existsSync(join(root, '.claude')), false);
});

test('syncProjectSkills keeps role definitions current alongside skill mirrors', () => {
  const root = mkdtempTracked('roles-project-');
  const kitRoot = join(root, '.vibe-coding', 'kit');
  mkdirSync(join(kitRoot, 'skills', 'public-skill'), { recursive: true });
  writeFileSync(join(kitRoot, 'skills', 'public-skill', 'SKILL.md'), '---\nname: public-skill\ndescription: Public skill.\n---\n\nBody.\n');
  cpSync(join(KIT, ROLE_SOURCE_DIR), join(kitRoot, ROLE_SOURCE_DIR), { recursive: true });
  mkdirSync(join(root, '.vibe-coding', 'skills'), { recursive: true });
  writeFileSync(join(root, '.vibe-coding', 'project.config.json'), `${JSON.stringify({
    schemaVersion: 1,
    kit: { path: '.vibe-coding/kit', url: 'https://example.invalid/kit.git' },
    adapter: 'project-adapter.mjs',
    identity: { name: 'Synthetic User', email: 'synthetic@example.invalid' },
    skills: { skills: { 'public-skill': { mode: 'adopt' } } },
  })}\n`);
  const before = syncProjectSkills({ projectRoot: root, kitRoot, checkOnly: true });
  assert.equal(before.ok, false);
  assert.ok(before.problems.some((p) => p === `missing: .claude/agents/${SHIPPED[0]}`));
  const synced = syncProjectSkills({ projectRoot: root, kitRoot });
  assert.ok(Number.isInteger(synced.written) && synced.written > 0);
  assert.equal(synced.roles.written, SHIPPED.length);
  const after = syncProjectSkills({ projectRoot: root, kitRoot, checkOnly: true });
  assert.deepEqual(after.problems, []);
  assert.equal(after.ok, true);
});

function tierMapModels() {
  const text = readFileSync(join(KIT, 'skills', 'agent-orchestration-guardrails', 'references', 'model-selection.md'), 'utf8');
  const rows = new Map();
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || !['Read-only', 'Write', 'Review', 'Planning'].includes(cells[1])) continue;
    rows.set(cells[1], cells[2].split(/[;\s]/)[0].toLowerCase());
  }
  return rows;
}

test('class guard: shipped roles pin the tier map models and least-privilege tools', () => {
  const tiers = tierMapModels();
  assert.deepEqual([...tiers.keys()].sort(), ['Planning', 'Read-only', 'Review', 'Write']);
  const expected = {
    'explorer.md': { tier: 'Read-only', readOnly: true },
    'module-owner.md': { tier: 'Write', readOnly: false },
    'reviewer.md': { tier: 'Review', readOnly: true },
    'sub-planner.md': { tier: 'Planning', readOnly: true },
  };
  assert.deepEqual(SHIPPED, Object.keys(expected).sort());
  for (const name of SHIPPED) {
    const { fields } = parseRole(name, readFileSync(join(KIT, ROLE_SOURCE_DIR, name), 'utf8'));
    assert.equal(fields.model, tiers.get(expected[name].tier), `${name} model must match the ${expected[name].tier} tier`);
    const tools = roleTools(fields);
    assert.ok(tools.length > 0, `${name} must list its tools`);
    assert.ok(!tools.includes('Agent') && !tools.includes('Task'), `${name} must not be able to dispatch`);
    if (expected[name].readOnly) {
      for (const writer of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.ok(!tools.includes(writer), `${name} must not have ${writer}`);
    } else {
      for (const needed of ['Edit', 'Write', 'Bash']) assert.ok(tools.includes(needed), `${name} needs ${needed}`);
    }
    assert.ok(fields.description && fields.description.length <= 240, `${name} needs a short description`);
  }
});

test('class guard: the mirror .gitignore block lists exactly the shipped role files', () => {
  const cli = readFileSync(join(KIT, 'cli.mjs'), 'utf8');
  const block = cli.match(/const MIRROR_IGNORE_BLOCK = `([^`]*)`/);
  assert.ok(block, 'cli.mjs must define MIRROR_IGNORE_BLOCK');
  const listed = [...block[1].matchAll(/\/\.claude\/agents\/([^\\]+)\\n/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, SHIPPED);
});
