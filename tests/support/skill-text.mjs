import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    })
    .sort();
}

// The text a skill ships: SKILL.md plus every markdown file under references/ that SKILL.md loads on demand.
// Wording the skill moves into references/ (e.g. f0de3fe: backlog-audit.md) is still part of the skill.
export function readSkillText(name) {
  const root = join(SKILLS_ROOT, name);
  const files = [join(root, 'SKILL.md')];
  try {
    files.push(...listFiles(join(root, 'references')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}
