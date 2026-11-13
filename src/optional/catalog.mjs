import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OPTIONAL_GROUPS, validateOptionalPreferences } from './preferences.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function fail(message) { throw new Error(`[optional] ${message}`); }
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function assertRealInside(root, path) {
  if (!existsSync(path)) fail(`missing source: ${path}`);
  if (!inside(realpathSync(root), realpathSync(path))) fail(`source escapes kit: ${path}`);
}

export function loadOptionalCatalog(kitRoot) {
  const path = join(kitRoot, 'optional', 'catalog.json');
  let catalog;
  try { catalog = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!catalog || catalog.schemaVersion !== 1 || !catalog.groups || !catalog.components) fail('invalid catalog');
  if (Object.keys(catalog.groups).sort().join() !== [...OPTIONAL_GROUPS].sort().join()) fail('unknown or missing catalog groups');
  if (typeof catalog.groups !== 'object' || Array.isArray(catalog.groups) || typeof catalog.components !== 'object' || Array.isArray(catalog.components)) fail('invalid catalog');
  const names = new Set();
  const referenced = new Set();
  for (const group of OPTIONAL_GROUPS) {
    const entry = catalog.groups[group];
    if (!entry || !Array.isArray(entry.components)) fail(`invalid components for ${group}`);
    for (const id of entry.components) {
      if (typeof id !== 'string' || !ID.test(id) || referenced.has(id) || !Object.hasOwn(catalog.components, id)) fail(`invalid component reference: ${id}`);
      referenced.add(id);
    }
  }
  for (const [id, component] of Object.entries(catalog.components)) {
    if (!referenced.has(id)) fail(`unreferenced component: ${id}`);
    if (!ID.test(id) || !component || !['skills', 'plugin'].includes(component.type) || component.path !== `optional/${id}` || !safePath(component.skillsPath) || !Array.isArray(component.skills)) fail(`invalid component ${id}`);
    for (const name of component.skills) {
      if (!ID.test(name) || names.has(name)) fail(`invalid or duplicate skill: ${name}`);
      names.add(name);
    }
    if (component.pack && (!component.skills.includes(component.pack.entry) || (component.pack.memberPrefix != null && !ID.test(component.pack.memberPrefix.replace(/-$/, ''))))) fail(`invalid pack for ${id}`);
  }
  return catalog;
}

export function resolveOptionalSelection({ kitRoot, projectRoot, projectConfig = {}, overrides = {}, fresh = false }) {
  validateOptionalPreferences(projectConfig.optional);
  validateOptionalPreferences(overrides);
  const catalog = loadOptionalCatalog(kitRoot);
  const selection = Object.fromEntries(OPTIONAL_GROUPS.map((group) => [group, false]));
  const components = [], skills = new Map(), packs = [], disabledSkills = new Set();
  const legacy = !fresh && projectConfig.optional === undefined;
  if (!catalog) {
    if (Object.values(overrides).some(Boolean) || Object.values(projectConfig.optional ?? {}).some(Boolean)) fail('optional catalog is missing');
    return { selection, components, skills, packs, disabledSkills, legacy };
  }
  for (const group of OPTIONAL_GROUPS) {
    const explicit = overrides[group] ?? projectConfig.optional?.[group];
    const entries = catalog.groups[group].components.map((id) => ({ id, ...catalog.components[id] }));
    const legacyNames = new Set(entries.flatMap((component) => component.skills).filter((name) => {
      const definition = projectConfig.skills?.skills?.[name];
      return definition?.mode !== 'exclude' && (definition || existsSync(join(projectRoot, '.vibe-coding', 'skills', name)));
    }));
    selection[group] = explicit ?? (legacy && legacyNames.size > 0);
    if (!selection[group]) {
      for (const component of entries) for (const name of component.skills) disabledSkills.add(name);
      continue;
    }
    for (const component of entries) {
      const candidates = explicit === undefined && legacy ? component.skills.filter((name) => legacyNames.has(name)) : component.skills;
      const activeNames = candidates.filter((name) => {
        const definition = projectConfig.skills?.skills?.[name];
        if (definition?.mode !== 'exclude') return true;
        if (!definition.rationale) fail(`${name}: exclude requires an explicit rationale`);
        disabledSkills.add(name);
        return false;
      });
      if (!activeNames.length && component.type === 'skills') continue;
      const componentRoot = resolve(kitRoot, component.path);
      assertRealInside(kitRoot, componentRoot);
      const root = resolve(componentRoot, component.skillsPath);
      if (activeNames.length) assertRealInside(componentRoot, root);
      for (const name of activeNames) {
        const skill = join(root, name, 'SKILL.md');
        assertRealInside(root, skill);
        if (!statSync(skill).isFile()) fail(`missing skill source: ${skill}`);
        skills.set(name, { root, componentId: component.id });
      }
      components.push(component);
      if (!legacy && component.pack && activeNames.includes(component.pack.entry)) packs.push({ id: component.id, entry: component.pack.entry, members: activeNames.filter((name) => name !== component.pack.entry), memberPrefix: component.pack.memberPrefix ?? null });
    }
  }
  return { selection, components, skills, packs, disabledSkills, legacy };
}
