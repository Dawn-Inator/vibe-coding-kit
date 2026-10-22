import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncProjectSkills } from '../../src/skills/project-sync.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-project-skills-test-'));
  const kitRoot = join(root, '.vibe-coding', 'kit');
  const commonSkill = join(kitRoot, 'skills', 'public-skill');
  const commonExtendedSkill = join(kitRoot, 'skills', 'extended-skill');
  mkdirSync(commonSkill, { recursive: true });
  mkdirSync(commonExtendedSkill, { recursive: true });
  mkdirSync(join(root, '.vibe-coding', 'skills'), { recursive: true });
  writeFileSync(join(commonSkill, 'SKILL.md'), '---\nname: public-skill\ndescription: Public skill.\n---\n\nPublic body.\n');
  writeFileSync(join(commonExtendedSkill, 'SKILL.md'), '---\nname: extended-skill\ndescription: Shared skill.\n---\n\nShared body.\n');
  mkdirSync(join(root, '.vibe-coding', 'skills', 'extended-skill'), { recursive: true });
  writeFileSync(join(root, '.vibe-coding', 'skills', 'extended-skill', 'EXTENSION.md'), '---\nname: extended-skill\n---\n\nProject appendix.\n');
  writeFileSync(join(root, '.vibe-coding', 'project.config.json'), `${JSON.stringify({
    schemaVersion: 1,
    kit: { path: '.vibe-coding/kit', url: 'https://example.invalid/kit.git' },
    adapter: 'project-adapter.mjs',
    identity: { name: 'Synthetic User', email: 'synthetic@example.invalid' },
    skills: { skills: {
      'public-skill': { mode: 'adopt' },
      'extended-skill': { mode: 'extend' },
    } },
  })}\n`);
  return { root, kitRoot };
}

test('project skill sync composes configured sources and check mode is read-only', () => {
  const f = fixture();
  try {
    const before = syncProjectSkills({ projectRoot: f.root, kitRoot: f.kitRoot, checkOnly: true });
    assert.equal(before.ok, false);
    assert.match(before.problems.join('\n'), /missing: \.agents\/skills\/public-skill\/SKILL\.md/);
    const synced = syncProjectSkills({ projectRoot: f.root, kitRoot: f.kitRoot });
    assert.ok(synced.written > 0);
    const output = readFileSync(join(f.root, '.agents', 'skills', 'public-skill', 'SKILL.md'), 'utf8');
    assert.match(output, /Public body\./);
    assert.match(output, /Source: \.vibe-coding\/kit\/skills\/public-skill\/SKILL\.md/);
    assert.match(output, /Run `pnpm skills:sync` after editing source files\./);
    const extended = readFileSync(join(f.root, '.agents', 'skills', 'extended-skill', 'SKILL.md'), 'utf8');
    assert.match(extended, /Project appendix\./);
    assert.match(extended, /Source: \.vibe-coding\/kit\/skills\/extended-skill\/SKILL\.md \+ \.vibe-coding\/skills\/extended-skill\/EXTENSION\.md/);
    assert.equal(syncProjectSkills({ projectRoot: f.root, kitRoot: f.kitRoot, checkOnly: true }).ok, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
