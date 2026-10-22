import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';

const MODES = new Set(['adopt', 'extend', 'replace', 'local', 'exclude']);
const PLATFORM_BEGIN = {
  claude: '<!-- BEGIN: claude-only -->',
  agents: '<!-- BEGIN: agent-only -->',
};

function fail(message) {
  throw new Error(`[skills:compose] ${message}`);
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseFrontmatter(text, path) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) fail(`${path} must begin with YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { raw: match[0], fields, body: text.slice(match[0].length) };
}

function listFiles(root) {
  const files = new Map();
  const modes = new Map();
  if (!root) return { files, modes };
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`symlinks are not supported inside a skill source: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const relPath = relative(root, path).split(sep).join('/');
        files.set(relPath, readFileSync(path));
        modes.set(relPath, statSync(path).mode & 0o777);
      }
    }
  };
  visit(root);
  return { files, modes };
}

function mergeFiles(commonFiles, localFiles, name) {
  const output = new Map(commonFiles.files);
  const modes = new Map(commonFiles.modes);
  for (const [path, bytes] of localFiles.files) {
    if (path === 'SKILL.md' || path === 'EXTENSION.md') continue;
    const existing = output.get(path);
    if (existing && !existing.equals(bytes)) fail(`${name}: common and local sources both define ${path}`);
    output.set(path, bytes);
    modes.set(path, localFiles.modes.get(path));
  }
  return { files: output, modes };
}

function sourceDigest(content, files, definition) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(definition));
  hash.update(content);
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update('\0').update(path).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

function stripMarkerBlocks(text, platform) {
  const keep = PLATFORM_BEGIN[platform];
  const keepEnd = keep?.replace('BEGIN', 'END');
  const drop = PLATFORM_BEGIN[platform === 'claude' ? 'agents' : 'claude'];
  const dropEnd = drop.replace('BEGIN', 'END');
  const lines = text.split('\n');
  const output = [];
  let mode = null;
  for (const line of lines) {
    const marker = line.trim();
    if (!mode && marker === keep) { mode = 'keep'; continue; }
    if (!mode && marker === drop) { mode = 'drop'; continue; }
    if (mode === 'keep' && marker === keepEnd) { mode = null; continue; }
    if (mode === 'drop' && marker === dropEnd) { mode = null; continue; }
    if (!mode || mode === 'keep') output.push(line);
  }
  if (mode) fail(`unclosed ${mode} platform marker for ${platform}`);
  return output.join('\n');
}

/**
 * Compose one skill. Roots contain `<name>/SKILL.md`; extensions live in
 * `<name>/EXTENSION.md`, while replacements use a complete local SKILL.md.
 */
export function composeSkill({ name, commonRoot, localRoot, mode, platform = null, rationale = null, replaces = null }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '')) fail(`invalid skill name: ${name}`);
  if (!MODES.has(mode) || mode === 'exclude') fail(`${name}: mode must be one of adopt, extend, replace, local`);
  if (platform !== null && !['claude', 'agents'].includes(platform)) fail(`unknown platform: ${platform}`);

  const commonDir = commonRoot ? join(commonRoot, name) : null;
  const localDir = localRoot ? join(localRoot, name) : null;
  const commonText = commonDir ? readOptional(join(commonDir, 'SKILL.md')) : null;
  const localText = localDir ? readOptional(join(localDir, 'SKILL.md')) : null;
  const extensionText = localDir ? readOptional(join(localDir, 'EXTENSION.md')) : null;
  if (commonText === null && mode !== 'local' && mode !== 'replace') fail(`${name}: common SKILL.md is missing`);
  if (mode === 'extend' && !extensionText) fail(`${name}: extend mode requires local EXTENSION.md`);
  if ((mode === 'replace' || mode === 'local') && localText === null) fail(`${name}: ${mode} mode requires local SKILL.md`);
  if ((mode === 'adopt' || mode === 'extend') && localText !== null) {
    fail(`${name}: local SKILL.md conflicts with ${mode}; move project content to EXTENSION.md or declare replace`);
  }
  if (mode === 'adopt' && extensionText !== null) fail(`${name}: adopt mode cannot include EXTENSION.md`);
  if (mode === 'replace' && extensionText !== null) fail(`${name}: replacement must be a complete SKILL.md, without EXTENSION.md`);

  const selectedText = mode === 'replace' || mode === 'local' ? localText : commonText;
  const selectedDir = mode === 'replace' || mode === 'local' ? localDir : commonDir;
  const selected = parseFrontmatter(selectedText, join(selectedDir, 'SKILL.md'));
  if (selected.fields.name !== name) fail(`${name}: frontmatter name must equal directory name`);
  let body = selected.body;
  if (mode === 'extend') {
    const extension = parseFrontmatter(extensionText, join(localDir, 'EXTENSION.md'));
    if (extension.fields.name && extension.fields.name !== name) fail(`${name}: extension frontmatter name must equal directory name`);
    const extensionBody = extension.body.trim();
    if (extensionBody) body = `${body.trimEnd()}\n\n<!-- BEGIN: project-extension -->\n${extensionBody}\n<!-- END: project-extension -->\n`;
  }
  if (platform) body = stripMarkerBlocks(body, platform);

  const emptyFiles = { files: new Map(), modes: new Map() };
  const commonFiles = mode === 'adopt' || mode === 'extend' ? listFiles(commonDir) : emptyFiles;
  const localFiles = mode === 'extend' || mode === 'replace' || mode === 'local' ? listFiles(localDir) : emptyFiles;
  const merged = mergeFiles(commonFiles, localFiles, name);
  const files = merged.files;
  files.set('SKILL.md', Buffer.from(`${selected.raw}${body}`, 'utf8'));
  merged.modes.set('SKILL.md', 0o644);
  const content = `${selected.raw}${body}`;
  const definition = { mode, rationale, replaces };
  return {
    name,
    mode,
    frontmatter: Object.freeze({ ...selected.fields }),
    content,
    files,
    fileModes: merged.modes,
    provenance: Object.freeze({
      common: commonText === null ? null : join(commonRoot, name, 'SKILL.md'),
      local: mode === 'extend' ? join(localRoot, name, 'EXTENSION.md') : (localText === null ? null : join(localRoot, name, 'SKILL.md')),
      mode,
      digest: sourceDigest(content, files, definition),
      configuration: Object.freeze(definition),
    }),
  };
}

function configEntries(skillsConfig) {
  const entries = skillsConfig?.skills;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) fail('skillsConfig.skills must be an object keyed by skill name');
  return Object.entries(entries);
}

/** Resolve a project config against the public kit and project-local source. */
export function composeSources({ projectRoot, kitRoot, skillsConfig }) {
  if (!projectRoot || !kitRoot) fail('projectRoot and kitRoot are required');
  const commonRoot = join(kitRoot, 'skills');
  const localRoot = join(projectRoot, '.vibe-coding', 'skills');
  const configured = new Map(configEntries(skillsConfig));
  const listSkillNames = (root) => {
    const names = new Set();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail(`symlink skill directory is not supported: ${join(root, entry.name)}`);
      if (entry.isDirectory()) names.add(entry.name);
    }
    return names;
  };
  const commonNames = listSkillNames(commonRoot);
  const localNames = listSkillNames(localRoot);
  for (const name of localNames) {
    if (commonNames.has(name) && !configured.has(name)) fail(`${name}: common/local name collision requires an explicit skillsConfig.skills entry`);
  }
  const results = new Map();
  for (const [name, definition] of configured) {
    if (!definition || typeof definition !== 'object' || !MODES.has(definition.mode)) fail(`${name}: config needs an explicit mode`);
    if (definition.mode === 'exclude') {
      if (!commonNames.has(name) || !definition.rationale) fail(`${name}: exclude requires a common skill and an explicit rationale`);
      continue;
    }
    if (definition.mode === 'replace' && (!definition.rationale || definition.replaces !== name)) {
      fail(`${name}: replacement requires rationale and replaces: '${name}'`);
    }
    if (definition.mode === 'local' && commonNames.has(name)) fail(`${name}: a common skill exists; use replace with rationale or adopt/extend`);
    if (definition.mode === 'adopt' && !commonNames.has(name)) fail(`${name}: adopt requires a common skill`);
    results.set(name, composeSkill({ name, commonRoot, localRoot, ...definition }));
  }
  for (const name of commonNames) {
    if (!configured.has(name)) fail(`${name}: common skill requires an explicit adopt/extend/replace/exclude decision`);
  }
  for (const name of localNames) {
    if (!commonNames.has(name) && !configured.has(name)) {
      results.set(name, composeSkill({ name, commonRoot, localRoot, mode: 'local' }));
    }
  }
  return Object.freeze({
    skills: results,
    aliases: Object.freeze({ ...(skillsConfig.aliases ?? {}) }),
    packs: Object.freeze([...(skillsConfig.packs ?? [])]),
    provenance: Object.freeze({ kitRoot, localRoot }),
  });
}

/** Resolve an executable/reference asset from canonical sources, never from a generated mirror. */
export function resolveSkillSourcePath({ projectRoot, kitRoot, skillsConfig, name, path }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '')) fail(`invalid skill name: ${name}`);
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    fail(`${name}: source path must be a safe relative path`);
  }
  const definition = skillsConfig?.skills?.[name];
  const localPath = join(projectRoot, '.vibe-coding', 'skills', name, path);
  const commonPath = join(kitRoot, 'skills', name, path);
  if (!definition) {
    if (existsFile(localPath)) return localPath;
    if (existsFile(commonPath)) fail(`${name}: public skill needs an explicit project.config.json decision`);
    fail(`${name}/${path}: no canonical source file`);
  }
  if (definition.mode === 'exclude') fail(`${name}: skill is explicitly excluded`);
  if (definition.mode === 'local' || definition.mode === 'replace') {
    if (existsFile(localPath)) return localPath;
    fail(`${name}/${path}: local source file is missing`);
  }
  if (definition.mode === 'extend' && existsFile(localPath)) return localPath;
  if ((definition.mode === 'adopt' || definition.mode === 'extend') && existsFile(commonPath)) return commonPath;
  fail(`${name}/${path}: no canonical source file for mode '${definition.mode}'`);
}

function existsFile(path) {
  try { return statSync(path).isFile(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

