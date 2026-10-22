import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit is checked both before export and after INSTALL copies it into a repo.
export function skillRoot(moduleUrl = import.meta.url) {
  const automation = join(dirname(fileURLToPath(moduleUrl)), '..');
  const bundled = join(automation, '..', 'vibe-coding', 'skills');
  return existsSync(bundled) ? bundled : join(automation, '..', '..', '.vibe-coding', 'skills');
}

export const CORE_SKILLS = Object.freeze([
  'agent-orchestration-guardrails',
  'agent-worktree-lifecycle',
]);

// Bounds match the repo's 12 KiB entry convention. References are loaded on demand.
export function entryViolations(text, { hasReference = () => true } = {}) {
  const problems = [];
  const description = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (!description || [...description].length > 240)
    problems.push('description must be a precise trigger of at most 240 characters');
  if (Buffer.byteLength(text, 'utf8') > 12 * 1024)
    problems.push('entry exceeds 12 KiB; move conditional detail to references');
  const references = [...text.matchAll(/references\/([a-z][a-z0-9-]*\.md)/g)].map((m) => m[1]);
  for (const name of new Set(references))
    if (!hasReference(name)) problems.push(`missing reference: ${name}`);
  return problems;
}

export function readSkill(name) {
  return readFileSync(join(skillRoot(), name, 'SKILL.md'), 'utf8');
}
