import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sync, check, parseSkillDescription, JOINT_ROOT_DOC_REFERENCE } from '../../src/skills/sync-skills.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../src/skills/sync-skills.mjs');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'sync-skills-test-'));
}

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const ALPHA_SKILL = `---
name: alpha
description: Alpha skill for testing.
allowed-tools: Read, Write
---

# Alpha Skill

Some content mentioning AGENTS.md and .agents/skills paths.
`;

const BETA_SKILL = `---
name: beta
description: Beta skill for testing.
---

# Beta Skill

Plain skill content with no platform-specific fields.
`;

const LOADING_MD = `# Loading

Shared intro line.

<!-- BEGIN: claude-only -->
This paragraph is for Claude only. See AGENTS.md notes.
<!-- END: claude-only -->

<!-- BEGIN: agent-only -->
This paragraph is for other agents only. See AGENTS.md notes.
<!-- END: agent-only -->

Both docs are the same file conceptually: ${JOINT_ROOT_DOC_REFERENCE}.

Skill listings live under .agents/skills.
`;

function seedRepo(root) {
  writeFile(join(root, '.vibe-coding', 'skills', 'alpha', 'SKILL.md'), ALPHA_SKILL);
  writeFile(join(root, '.vibe-coding', 'skills', 'beta', 'SKILL.md'), BETA_SKILL);
  writeFile(join(root, '.vibe-coding', 'loading.md'), LOADING_MD);
}

test('sync generates .agents/skills, .claude/skills, AGENTS.md, CLAUDE.md', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const agentsAlpha = readFileSync(join(root, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8');
  const claudeAlpha = readFileSync(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8');
  const agentsBeta = readFileSync(join(root, '.agents', 'skills', 'beta', 'SKILL.md'), 'utf8');
  const claudeBeta = readFileSync(join(root, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8');
  const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

  // allowed-tools: stripped for .agents, kept for .claude
  assert.ok(!/^allowed-tools:/m.test(agentsAlpha), '.agents/skills/alpha/SKILL.md should not contain allowed-tools:');
  assert.ok(/^allowed-tools:/m.test(claudeAlpha), '.claude/skills/alpha/SKILL.md should keep allowed-tools:');

  // beta has no allowed-tools field to begin with; both projections still generated
  assert.ok(agentsBeta.includes('Plain skill content'));
  assert.ok(claudeBeta.includes('Plain skill content'));

  // generated banner present with correct Source: line
  assert.ok(agentsAlpha.includes('GENERATED FILE - DO NOT EDIT.'));
  assert.ok(agentsAlpha.includes('Source: .vibe-coding/skills/alpha/SKILL.md'));
  assert.ok(claudeAlpha.includes('Source: .vibe-coding/skills/alpha/SKILL.md'));
  assert.ok(agentsMd.includes('Source: .vibe-coding/loading.md'));
  assert.ok(claudeMd.includes('Source: .vibe-coding/loading.md'));

  rmSync(root, { recursive: true, force: true });
});

test('claude-only / agent-only markers are kept/dropped per target', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

  assert.ok(agentsMd.includes('This paragraph is for other agents only.'));
  assert.ok(!agentsMd.includes('This paragraph is for Claude only.'));

  assert.ok(claudeMd.includes('This paragraph is for Claude only.'));
  assert.ok(!claudeMd.includes('This paragraph is for other agents only.'));

  // shared, unmarked content present in both
  assert.ok(agentsMd.includes('Shared intro line.'));
  assert.ok(claudeMd.includes('Shared intro line.'));

  rmSync(root, { recursive: true, force: true });
});

test('joint "AGENTS.md/CLAUDE.md" reference is protected from double substitution', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8');

  assert.ok(
    claudeMd.includes('Both docs are the same file conceptually: `AGENTS.md`/`CLAUDE.md`.'),
    'joint reference must survive the claude vendor transform unchanged',
  );
  assert.ok(!claudeMd.includes('`CLAUDE.md`/`CLAUDE.md`'), 'joint reference must not collapse into a duplicate');

  assert.ok(agentsMd.includes('Both docs are the same file conceptually: `AGENTS.md`/`CLAUDE.md`.'));

  // sanity: other, non-joint mentions of AGENTS.md ARE transformed for claude
  assert.ok(claudeMd.includes('This paragraph is for Claude only. See CLAUDE.md notes.'));
  assert.ok(claudeMd.includes('Skill listings live under .claude/skills.'));
  assert.ok(agentsMd.includes('Skill listings live under .agents/skills.'));

  rmSync(root, { recursive: true, force: true });
});

test('check passes after a clean sync', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);

  rmSync(root, { recursive: true, force: true });
});

test('check detects changed: after a generated file is hand-edited', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const claudeAlphaPath = join(root, '.claude', 'skills', 'alpha', 'SKILL.md');
  const original = readFileSync(claudeAlphaPath, 'utf8');
  writeFileSync(claudeAlphaPath, `${original}\nHand-edited extra line.\n`, 'utf8');

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.startsWith('changed:') && p.includes('.claude/skills/alpha/SKILL.md')),
    `expected a changed: problem for the hand-edited file, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('check detects missing: after a generated file is deleted', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const agentsBetaPath = join(root, '.agents', 'skills', 'beta', 'SKILL.md');
  rmSync(agentsBetaPath, { force: true });

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.startsWith('missing:') && p.includes('.agents/skills/beta/SKILL.md')),
    `expected a missing: problem, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('check detects extra: for an unexpected managed file', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const extraPath = join(root, '.claude', 'skills', 'zzz-extra', 'SKILL.md');
  writeFile(extraPath, '---\nname: zzz-extra\n---\n\nNot part of the source tree.\n');

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.startsWith('extra:') && p.includes('.claude/skills/zzz-extra/SKILL.md')),
    `expected an extra: problem, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('check does not depend on any business-specific external file', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  // No doc/ directory at all exists in this temp root — if check() secretly
  // called some org-specific gate (e.g. checking doc/testing-workflow.md),
  // it would throw or fail here. It must not.
  const result = check({ root });
  assert.equal(result.ok, true);

  rmSync(root, { recursive: true, force: true });
});

test('sync removes stale generated files when a source skill is deleted', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  rmSync(join(root, '.vibe-coding', 'skills', 'beta'), { recursive: true, force: true });
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, true, `expected check to pass after re-sync, got: ${JSON.stringify(result.problems)}`);

  assert.equal(existsSync(join(root, '.agents', 'skills', 'beta')), false);
  assert.equal(existsSync(join(root, '.claude', 'skills', 'beta')), false);

  rmSync(root, { recursive: true, force: true });
});

test('check: matching skill names and SKILL.md in every directory is green', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems.filter((p) => p.startsWith('skill-')), []);

  rmSync(root, { recursive: true, force: true });
});

test('check: frontmatter name different from the directory fails with skill-name-mismatch', () => {
  const root = makeTempRoot();
  seedRepo(root);
  writeFile(join(root, '.vibe-coding', 'skills', 'gamma', 'SKILL.md'), '---\nname: not-gamma\ndescription: x\n---\n\n# G\n');
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, false);
  const hit = result.problems.filter((p) => p.startsWith('skill-name-mismatch'));
  assert.equal(hit.length, 1);
  assert.match(hit[0], /gamma\/SKILL\.md/);
  assert.match(hit[0], /not-gamma/);

  rmSync(root, { recursive: true, force: true });
});

test('check: a skill without a frontmatter name is a name mismatch', () => {
  const root = makeTempRoot();
  seedRepo(root);
  writeFile(join(root, '.vibe-coding', 'skills', 'delta', 'SKILL.md'), '# Delta without frontmatter\n');
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith('skill-name-mismatch') && p.includes('delta')));

  rmSync(root, { recursive: true, force: true });
});

test('check: a skill directory without SKILL.md fails with skill-directory-invalid', () => {
  const root = makeTempRoot();
  seedRepo(root);
  writeFile(join(root, '.vibe-coding', 'skills', 'orphan', 'notes.md'), '# not a skill\n');
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith('skill-directory-invalid') && p.includes('orphan')));

  rmSync(root, { recursive: true, force: true });
});

test('check: a non-kebab-case skill directory name is skill-directory-invalid', () => {
  const root = makeTempRoot();
  seedRepo(root);
  writeFile(join(root, '.vibe-coding', 'skills', 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n');
  sync({ root });

  const result = check({ root });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith('skill-directory-invalid') && p.includes('Bad_Name')));

  rmSync(root, { recursive: true, force: true });
});

test('CLI check exits non-zero and names the offending directories', () => {
  const root = makeTempRoot();
  seedRepo(root);
  writeFile(join(root, '.vibe-coding', 'skills', 'gamma', 'SKILL.md'), '---\nname: other\ndescription: x\n---\n');
  writeFile(join(root, '.vibe-coding', 'skills', 'orphan', 'notes.md'), 'x\n');
  sync({ root });

  const run = spawnSync(process.execPath, [SCRIPT, 'check', '--root', root], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, `expected non-zero exit, stdout=${run.stdout} stderr=${run.stderr}`);
  assert.match(run.stderr, /gamma/);
  assert.match(run.stderr, /orphan/);

  rmSync(root, { recursive: true, force: true });
});

test('parseSkillDescription reads plain, quoted and block-scalar descriptions', () => {
  const fm = (body) => `---\nname: x\n${body}\n---\n# x\n`;
  assert.equal(parseSkillDescription(fm('description: Use when X.')), 'Use when X.');
  assert.equal(parseSkillDescription(fm('description: "Use when \\"X\\"."')), 'Use when "X".');
  assert.equal(parseSkillDescription(fm("description: 'it''s X'")), "it's X");
  assert.equal(parseSkillDescription(fm('description: >\n  Use when\n  X happens.')), 'Use when X happens.');
  assert.equal(parseSkillDescription(fm('description: Use when\n  X continues.\nother: y')), 'Use when X continues.');
  assert.equal(parseSkillDescription('# no frontmatter\n'), '');
});

test('check reports the per-turn listing budget (skills and description chars) without failing on it', () => {
  const root = makeTempRoot();
  seedRepo(root);
  sync({ root });
  const result = check({ root });
  assert.equal(result.ok, true);
  assert.equal(result.listing.skills, 2);
  const expectedChars = ['alpha', 'beta']
    .map((name) => [...parseSkillDescription(readFileSync(join(root, '.vibe-coding', 'skills', name, 'SKILL.md'), 'utf8'))].length)
    .reduce((a, b) => a + b, 0);
  assert.ok(expectedChars > 0);
  assert.equal(result.listing.descriptionChars, expectedChars);

  const run = spawnSync(process.execPath, [SCRIPT, 'check', '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, new RegExp(`listing: 2 skill\\(s\\), description chars=${expectedChars}`));
  rmSync(root, { recursive: true, force: true });
});
