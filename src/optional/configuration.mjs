import { composeSources } from '../skills/composition.mjs';
import { loadOptionalCatalog } from './catalog.mjs';
import { OPTIONAL_GROUPS, validateOptionalPreferences } from './preferences.mjs';

export const GENERATED_EXCLUDE_RATIONALE = 'Kit preserved this skill as disabled during optional configuration migration.';
const LOCAL_REPLACEMENT_RATIONALE = 'Kit preserved the existing project-local skill during optional configuration migration.';

/** Produce a complete configuration while preserving decisions made before optional groups existed. */
export function planOptionalConfiguration({ kitRoot, projectRoot, projectConfig, nextSelection, explicitGroups }) {
  validateOptionalPreferences(nextSelection);
  if (!Array.isArray(explicitGroups) && !(explicitGroups instanceof Set)) throw new Error('explicitGroups must be an array or Set');
  const explicit = new Set(explicitGroups);
  for (const group of explicit) if (!OPTIONAL_GROUPS.includes(group)) throw new Error(`unknown optional group: ${group}`);
  for (const group of OPTIONAL_GROUPS) if (typeof nextSelection?.[group] !== 'boolean') throw new Error(`nextSelection.${group} must be a boolean`);
  const catalog = loadOptionalCatalog(kitRoot);
  if (!catalog) throw new Error('optional catalog is missing');
  const config = structuredClone(projectConfig);
  const legacy = config.optional === undefined;
  const baseline = legacy ? composeSources({ projectRoot, kitRoot, skillsConfig: config.skills, projectConfig: config }) : null;
  config.skills ??= { skills: {} };
  config.skills.skills ??= {};
  const decisions = config.skills.skills;
  if (legacy) {
    config.skills.packs = [...baseline.packs];
    for (const group of OPTIONAL_GROUPS) {
      for (const id of catalog.groups[group].components) for (const name of catalog.components[id].skills) {
        if (!explicit.has(group) && !baseline.skills.has(name) && !decisions[name]) decisions[name] = { mode: 'exclude', rationale: GENERATED_EXCLUDE_RATIONALE };
        if (nextSelection[group] && baseline.skills.has(name) && baseline.skills.get(name).mode === 'local') {
          decisions[name] = { mode: 'replace', rationale: LOCAL_REPLACEMENT_RATIONALE, replaces: name };
        }
      }
    }
  }
  for (const group of explicit) if (nextSelection[group]) {
    for (const id of catalog.groups[group].components) for (const name of catalog.components[id].skills) {
      if (decisions[name]?.mode === 'exclude' && decisions[name].rationale === GENERATED_EXCLUDE_RATIONALE) delete decisions[name];
    }
  }
  config.optional = { ...nextSelection };
  if (Object.hasOwn(config.skills, 'packs')) {
    const composition = composeSources({ projectRoot, kitRoot, skillsConfig: config.skills, projectConfig: config });
    for (const group of explicit) if (nextSelection[group]) {
      for (const id of catalog.groups[group].components) {
        const component = catalog.components[id];
        if (!component.pack || !composition.skills.has(component.pack.entry) || config.skills.packs.some((pack) => pack.id === id)) continue;
        config.skills.packs.push({ id, entry: component.pack.entry, members: component.skills.filter((name) => name !== component.pack.entry && composition.skills.has(name)), memberPrefix: component.pack.memberPrefix ?? null });
      }
    }
  }
  return config;
}
