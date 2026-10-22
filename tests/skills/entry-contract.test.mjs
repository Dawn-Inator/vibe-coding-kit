import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mkdtempTracked } from '../support/temp-dirs.mjs';
import { CORE_SKILLS, entryViolations } from '../../src/skills/entry-contract.mjs';
import { syncProjectSkills } from '../../src/skills/project-sync.mjs';

const PUBLIC_SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));
const readPublicSkill = (name) => readFileSync(join(PUBLIC_SKILLS_ROOT, name, 'SKILL.md'), 'utf8');

test('core skill entries remain short routers with real on-demand references', () => {
  assert.equal(CORE_SKILLS.includes('ai-model-effort-routing'), false);
  for (const name of CORE_SKILLS) {
    assert.deepEqual(
      entryViolations(readPublicSkill(name), {
        hasReference: (ref) => existsSync(join(PUBLIC_SKILLS_ROOT, name, 'references', ref)),
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

test('copied installation keeps core contracts and projects the right platform rules from kit config', () => {
  const repo = mkdtempTracked('kit-entry-installed-');
  const installedModule = join(repo, 'src', 'skills', 'entry-contract.mjs');
  mkdirSync(join(repo, 'src', 'skills'), { recursive: true });
  cpSync(new URL('../../src/skills/entry-contract.mjs', import.meta.url), installedModule);
  const vibe = join(repo, '.vibe-coding');
  const kitRoot = join(vibe, 'kit');
  mkdirSync(join(vibe, 'skills'), { recursive: true });
  mkdirSync(join(kitRoot, 'skills'), { recursive: true });
  for (const name of CORE_SKILLS)
    cpSync(join(PUBLIC_SKILLS_ROOT, name), join(kitRoot, 'skills', name), { recursive: true });
  const config = JSON.parse(readFileSync(new URL('../../templates/project.config.json', import.meta.url), 'utf8'));
  config.identity = { name: 'Fixture Owner', email: 'fixture@example.test' };
  config.skills.skills = Object.fromEntries(CORE_SKILLS.map((name) => [name, { mode: 'adopt' }]));
  writeFileSync(join(vibe, 'project.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  syncProjectSkills({ projectRoot: repo, kitRoot });
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
      "import { existsSync, readFileSync } from 'node:fs'; import { join } from 'node:path'; import { CORE_SKILLS, entryViolations } from './src/skills/entry-contract.mjs'; const root = join('.vibe-coding', 'kit', 'skills'); for (const name of CORE_SKILLS) { const skill = join(root, name); const errors = entryViolations(readFileSync(join(skill, 'SKILL.md'), 'utf8'), { hasReference: ref => existsSync(join(skill, 'references', ref)) }); if (errors.length) throw new Error(name + ': ' + errors.join('; ')); }",
    ],
    { cwd: repo, encoding: 'utf8', timeout: 15000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
