import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { check, sync } from './sync-skills.mjs';
import { composeSources } from './composition.mjs';
import { readProjectConfig } from '../dependencies/submodule.mjs';
import { overrideSkillPacks } from './skill-packs.mjs';

function materializeSkills(root, skills) {
  for (const [name, skill] of skills) {
    for (const [relativePath, contents] of skill.files) {
      const destination = join(root, name, relativePath);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, contents, { mode: skill.fileModes.get(relativePath) ?? 0o644 });
    }
  }
}

/** Compose the configured public and project skill sources, then sync/check generated projections. */
export function syncProjectSkills({ projectRoot, kitRoot, checkOnly = false }) {
  if (!projectRoot || !kitRoot) throw new Error('projectRoot and kitRoot are required');
  const root = resolve(projectRoot);
  const kit = resolve(kitRoot);
  const projectConfig = readProjectConfig(root);
  const composition = composeSources({ projectRoot: root, kitRoot: kit, skillsConfig: projectConfig.skills });
  overrideSkillPacks(composition.packs);
  const scratch = mkdtempSync(join(tmpdir(), 'vibe-coding-kit-skills-'));
  try {
    const sourceSkillsDir = join(scratch, 'skills');
    mkdirSync(sourceSkillsDir, { recursive: true });
    materializeSkills(sourceSkillsDir, composition.skills);
    return checkOnly ? check({ root, sourceSkillsDir }) : sync({ root, sourceSkillsDir });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
