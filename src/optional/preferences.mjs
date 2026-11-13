import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OPTIONAL_GROUPS = Object.freeze(['aliyun', 'lark', 'non-code', 'task-progress']);

export function validateOptionalPreferences(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('optional must be an object');
  for (const [group, enabled] of Object.entries(value)) {
    if (!OPTIONAL_GROUPS.includes(group)) throw new Error(`unknown optional group: ${group}`);
    if (typeof enabled !== 'boolean') throw new Error(`optional.${group} must be a boolean`);
  }
}

export function readOptionalGroupPreference(projectRoot, group) {
  if (!OPTIONAL_GROUPS.includes(group)) throw new Error(`unknown optional group: ${group}`);
  let text;
  try { text = readFileSync(join(projectRoot, '.vibe-coding', 'project.config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('project config must be an object');
  validateOptionalPreferences(config.optional);
  return config.optional === undefined ? undefined : (config.optional[group] ?? false);
}
