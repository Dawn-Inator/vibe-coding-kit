import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { mkdtempTracked } from '../support/temp-dirs.mjs';
import { CORE_SKILLS, entryViolations, readSkill, skillRoot } from '../../src/skills/entry-contract.mjs';
import { sync } from '../../src/skills/sync-skills.mjs';

test('core skill entries remain short routers with real on-demand references', () => {
  assert.equal(CORE_SKILLS.includes('ai-model-effort-routing'), false);
  for (const name of CORE_SKILLS) {
    assert.deepEqual(
      entryViolations(readSkill(name), {
        hasReference: (ref) => existsSync(join(skillRoot(), name, 'references', ref)),
      }),
      [],
      name,
    );
  }
});

test('entry guard rejects the same failure in a different skill or reference', () => {
  const valid =
    '---\nname: another-skill\ndescription: Use for one concrete workflow.\n---\n# Entry\n';
  assert.deepEqual(entryViolations(valid), []);
  assert.match(entryViolations(valid + 'x'.repeat(12 * 1024)).join('\n'), /exceeds 12 KiB/);
  assert.match(
    entryViolations(valid.replace('Use for one concrete workflow.', 'x'.repeat(241))).join('\n'),
    /240/,
  );
  assert.match(
    entryViolations(valid + '[runbook](references/new-runbook.md)', {
      hasReference: () => false,
    }).join('\n'),
    /missing reference: new-runbook.md/,
  );
});

test('copied installation keeps core contracts and projects the right platform rules', () => {
  const repo = mkdtempTracked('kit-entry-installed-');
  const automation = join(repo, 'engineering', 'automation');
  mkdirSync(automation, { recursive: true });
  for (const directory of ['agent-skills', 'lib', 'testing-support'])
    cpSync(new URL(`../${directory}/`, import.meta.url), join(automation, directory), {
      recursive: true,
    });
  const vibe = join(repo, '.vibe-coding');
  mkdirSync(join(vibe, 'skills'), { recursive: true });
  for (const name of CORE_SKILLS)
    cpSync(join(skillRoot(), name), join(vibe, 'skills', name), { recursive: true });
  writeFileSync(join(vibe, 'loading.md'), '# Project rules\n');
  sync({ root: repo });
  const read = (platform) =>
    readFileSync(join(repo, platform, 'skills', CORE_SKILLS[0], 'SKILL.md'), 'utf8');
  assert.match(read('.agents'), /spawn_agent.*shares the current directory/);
  assert.match(read('.agents'), /fork_turns: "none"/);
  assert.doesNotMatch(read('.claude'), /fork_turns: "none"/);
  assert.match(read('.claude'), /Workers never run package-level\/full tests/);
  // Run only the pure entry probe to avoid recursively launching this installation test.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { existsSync } from 'node:fs'; import { join } from 'node:path'; import { CORE_SKILLS, entryViolations, readSkill, skillRoot } from './engineering/automation/agent-skills/entry-contract.mjs'; for (const name of CORE_SKILLS) { const errors = entryViolations(readSkill(name), { hasReference: ref => existsSync(join(skillRoot(), name, 'references', ref)) }); if (errors.length) throw new Error(name + ': ' + errors.join('; ')); }",
    ],
    { cwd: repo, encoding: 'utf8', timeout: 15000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
