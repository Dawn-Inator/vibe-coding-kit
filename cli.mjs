#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { arch, platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runReuseCatalog } from './src/contracts/reuse-catalog.mjs';
import { checkKit, getKitRegistration, inspectKit, prepareKit } from './src/dependencies/submodule.mjs';
import { syncProjectSkills } from './src/skills/project-sync.mjs';
import { composeSources } from './src/skills/composition.mjs';
import { isMainModule } from './src/lib/main-module.mjs';
import { isPathWithin, samePathIdentity } from './src/lib/path-identity.mjs';
import { sanitizedGitEnv } from './src/git-environment.mjs';
import { planSecrets, createSecretRepository, verifySecretRepository } from './src/secrets-setup.mjs';
import { createInterface } from 'node:readline/promises';
import { loadOptionalCatalog, resolveOptionalSelection } from './src/optional/catalog.mjs';
import { planOptionalConfiguration } from './src/optional/configuration.mjs';
import { OPTIONAL_GROUPS, validateOptionalPreferences } from './src/optional/preferences.mjs';
import { inspectOptionalComponent, installOptionalComponent } from './src/optional/runtime.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://github.com/Dawn-Inator/vibe-coding-kit.git';
const KIT_PATH = '.vibe-coding/kit';
const MIRROR_IGNORE_BEGIN = '# BEGIN vibe-coding-kit local skill mirrors';
const MIRROR_IGNORE_END = '# END vibe-coding-kit local skill mirrors';
const MIRROR_IGNORE_BLOCK = `${MIRROR_IGNORE_BEGIN}\n/.agents/skills/\n/.claude/skills/\n${MIRROR_IGNORE_END}\n`;

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, positional: [] };
  options.skill = [];
  options.optional = [];
  if (command === 'worktree' || command === 'worktrees') {
    options.forwarded = [];
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === '--project-root') {
        const next = rest[index + 1];
        if (!next || next.startsWith('--')) throw new Error('Option --project-root requires a value');
        options.projectRoot = next;
        index += 1;
        continue;
      }
      if (value === '--offline') { options.offline = true; continue; }
      if (value.startsWith('--project-root=')) {
        options.projectRoot = value.slice('--project-root='.length);
        if (!options.projectRoot) throw new Error('Option --project-root requires a value');
        continue;
      }
      options.forwarded.push(value);
      if (value.startsWith('--') && !value.includes('=')) {
        const next = rest[index + 1];
        if (next && !next.startsWith('--')) { options.forwarded.push(next); index += 1; }
      }
    }
    return options;
  }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) { options.positional.push(value); continue; }
    if (value === '--check') { options.check = true; continue; }
    if (value === '--offline') { options.offline = true; continue; }
    const optionText = value.slice(2);
    const equalsAt = optionText.indexOf('=');
    const key = equalsAt < 0 ? optionText : optionText.slice(0, equalsAt);
    const inline = equalsAt < 0 ? undefined : optionText.slice(equalsAt + 1);
    const next = inline ?? rest[index + 1];
    if (inline === undefined) index += 1;
    if (!next || next.startsWith('--')) throw new Error(`Option --${key} requires a value`);
    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (normalized === 'skill') options.skill.push(next);
    else if (normalized === 'optional') options.optional.push(next);
    else options[normalized] = next;
  }
  return options;
}

function git(root, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: sanitizedGitEnv(env) });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function install(root, options) {
  const allowed = new Set(['command', 'positional', 'skill', 'optional', 'projectRoot', 'url', 'ref', 'identityName', 'identityEmail', 'mirrorPolicy', 'check', 'secrets']);
  const unsupported = Object.keys(options).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported install option(s): ${unsupported.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(', ')}`);
  if (options.positional.length) throw new Error(`Unexpected install argument(s): ${options.positional.join(' ')}`);
  const optionalOverrides = parseOptionalOverrides(options.optional);
  const url = options.url || DEFAULT_URL;
  const mirrorPolicy = options.mirrorPolicy || 'local';
  if (!['local', 'tracked'].includes(mirrorPolicy)) throw new Error('--mirror-policy must be local or tracked');
  if (url.startsWith('-') || !url.trim() || /[\0\r\n]/.test(url)) throw new Error('--url must be a non-empty Git URL');
  if (options.ref && (options.ref.startsWith('-') || /[\0\r\n]/.test(options.ref))) throw new Error('--ref must be a non-empty Git ref or commit');
  const rootReal = realpathSync(root);
  const top = git(rootReal, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (!samePathIdentity(top, rootReal)) throw new Error(`--project-root must be the existing Git project root (${top})`);
  assertNoSymlinkPaths(rootReal, [resolve(rootReal, '.gitmodules')]);
  const status = git(rootReal, ['status', '--porcelain=v1', '--untracked-files=all']);
  git(rootReal, ['rev-parse', '--verify', 'HEAD']);
  const registration = getKitRegistrationOrNull(rootReal);
  if (registration) {
    if (registration.name !== 'vibe-coding-kit' || registration.path !== KIT_PATH) throw new Error(`Kit registration must be named vibe-coding-kit at ${KIT_PATH}`);
    if (registration.url !== url) throw new Error(`Registered kit URL ${registration.url} differs from requested URL ${url}; pass --url to select the registered source explicitly`);
    const ready = checkKit({ projectRoot: rootReal });
    if (options.ref) {
      const requested = git(ready.path, ['rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`], { allowFailure: true });
      if (requested.status !== 0) {
        throw new Error(`Requested --ref '${options.ref}' is not a locally known commit in the installed kit. Repeats do not fetch; use the project's explicit kit update workflow to change the pin.`);
      }
      const requestedCommit = requested.stdout.trim();
      if (requestedCommit !== ready.commit) {
        throw new Error(`Project is pinned to ${ready.commit}, while --ref '${options.ref}' resolves locally to ${requestedCommit}; install does not upgrade registered kits. Use the project's explicit kit update workflow to change the pin.`);
      }
    }
    if (options.check) {
      if (options.optional.length) await configureOptional(rootReal, resolve(rootReal, KIT_PATH), optionalOverrides, { interactive: false, checkOnly: true });
      const skills = syncProjectSkills({ projectRoot: rootReal, kitRoot: resolve(rootReal, KIT_PATH), checkOnly: true });
      if (!skills.ok) throw new Error(`Kit is initialized but skill projections need repair: ${skills.problems.join('; ')}. Run the project's skills:sync command.`);
      console.log(`Kit ${ready.commit} is ready; check performed without changing configuration or starting optional setup.`);
      return;
    }
    if (options.optional.length) await configureOptional(rootReal, resolve(rootReal, KIT_PATH), optionalOverrides, { interactive: false });
    const skills = syncProjectSkills({ projectRoot: rootReal, kitRoot: resolve(rootReal, KIT_PATH), checkOnly: true });
    if (!skills.ok) throw new Error(`Kit is initialized but skill projections need repair: ${(skills.problems || []).join('; ')}. Run the project's skills:sync command.`);
    console.log(options.optional.length
      ? `Kit ${ready.commit} is ready; requested optional configuration was applied.`
      : `Kit ${ready.commit} is ready; existing configuration and local files were preserved.`);
    return;
  }
  if (!options.identityName?.trim() || !options.identityEmail?.trim()) throw new Error('fresh install requires --identity-name and --identity-email');
  if (status.stdout.trim()) throw new Error(`Refusing first install into a dirty Git project; commit or remove existing changes first:\n${status.stdout.trim()}`);
  assertSafeInstallTargets(rootReal);
  assertProjectionTargetsAvailable(rootReal);
  assertNoSymlinkPaths(rootReal, ['.gitignore', 'package.json', '.vibe-coding/skills', 'engineering/automation/vibe-coding'].map((path) => resolve(rootReal, path)));
  // Validate all init options and conflicts before the first repository mutation.
  const secrets = options.secrets ? planSecrets(rootReal, options.secrets) : undefined;
  const optional = Object.fromEntries(OPTIONAL_GROUPS.map((group) => [group, false]));
  const currentConfig = projectConfig(rootReal);
  const detected = options.check ? new Map() : await inspectPluginComponents(REPO_ROOT, process.env);
  applyInstalledPluginDefaults(REPO_ROOT, optional, detected, currentConfig.optional, optionalOverrides);
  Object.assign(optional, optionalOverrides);
  if (!options.optional.length && process.stdin.isTTY && process.stdout.isTTY && !options.check) {
    const asked = await askOptionalCategories(REPO_ROOT, optional, detected, currentConfig.optional);
    Object.assign(optional, asked);
  }
  const selectionPlan = resolveOptionalSelection({ kitRoot: REPO_ROOT, projectRoot: rootReal, projectConfig: {}, overrides: optional, fresh: true });
  const optionalStatuses = options.check ? new Map() : await preflightOptionalComponents(REPO_ROOT, selectionPlan.components, process.env, detected);
  if (!options.check) assertOptionalPreflight(selectionPlan.components, optionalStatuses);
  const plan = plannedInitFiles(rootReal, { ...options, url, mirrorPolicy, secretsPlan: secrets, optionalSelection: optional });
  assertNoSymlinkPaths(rootReal, [...plan.entries.map(({ path }) => path), resolve(rootReal, '.gitmodules')]);
  if (plan.conflicts.length) throw new Error(`Install preflight found conflicts: ${plan.conflicts.join(', ')}`);
  validateSkillPlan(rootReal, plan.config, plan.entries);
  if (options.check) {
    if (secrets) console.log(`Secrets choice: ${secrets.method}${secrets.repository ? `; would create private ${secrets.repository} and clone to ${secrets.localPath}` : '; Vault setup remains project-owned'}.`);
    printOptionalSummary(optional, selectionPlan);
    console.log(`Would register ${url} at ${KIT_PATH}, initialize the selected kit revision, and create ${plan.writes.length} project file(s). Remote state was not checked.`);
    process.exitCode = 1;
    return;
  }
  const add = ['submodule', 'add', '--name', 'vibe-coding-kit', '--', url, KIT_PATH];
  try { git(rootReal, add, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
  catch (error) {
    throw new Error(`${error.message}\nNo rollback was attempted. Inspect .gitmodules, the index, and ${KIT_PATH} for partial registration before retrying.`);
  }
  let resolvedRef;
  if (options.ref) {
    const fetched = git(resolve(rootReal, KIT_PATH), ['fetch', '--no-tags', 'origin', options.ref], {
      allowFailure: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetched.status !== 0) throw new Error(`Submodule registered and initialized, but --ref '${options.ref}' could not be fetched. Registration and checkout remain in place; repair with git -C ${KIT_PATH} fetch origin ${options.ref}.`);
    resolvedRef = git(resolve(rootReal, KIT_PATH), ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).stdout.trim();
    const tagRef = options.ref.startsWith('refs/tags/') ? options.ref : `refs/tags/${options.ref}`;
    const looksLikeCommit = /^[0-9a-f]{7,64}$/i.test(options.ref);
    const validTagRef = !looksLikeCommit && git(resolve(rootReal, KIT_PATH), ['check-ref-format', tagRef], { allowFailure: true }).status === 0;
    if (validTagRef) {
      let localTag = git(resolve(rootReal, KIT_PATH), ['rev-parse', '--verify', '--end-of-options', `${tagRef}^{commit}`], { allowFailure: true });
      if (localTag.status !== 0) {
        const tagFetch = git(resolve(rootReal, KIT_PATH), ['fetch', '--no-tags', 'origin', `${tagRef}:${tagRef}`], {
          allowFailure: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (tagFetch.status !== 0) {
          throw new Error(`Submodule is registered and initialized, but requested tag '${options.ref}' could not be retained as a local ref for repeat installs. Registration remains at its initial pin; repair with git -C ${KIT_PATH} fetch origin ${tagRef}:${tagRef}.`);
        }
        localTag = git(resolve(rootReal, KIT_PATH), ['rev-parse', '--verify', '--end-of-options', `${tagRef}^{commit}`], { allowFailure: true });
      }
      if (localTag.status !== 0 || localTag.stdout.trim() !== resolvedRef) throw new Error(`Requested --ref '${options.ref}' resolved to ${resolvedRef}, but its local tag ref ${tagRef} resolves differently. Registration remains; inspect the tag and submodule pin before retrying.`);
    }
    try {
      git(resolve(rootReal, KIT_PATH), ['checkout', '--detach', resolvedRef]);
      git(rootReal, ['add', '--', KIT_PATH]);
    } catch (error) {
      throw new Error(`Submodule is registered at ${KIT_PATH}; ref ${options.ref} was fetched as ${resolvedRef}, but pinning did not complete. No rollback was attempted. Inspect the checkout and parent index before retrying. ${error.message}`);
    }
  }
  const targetCli = resolve(rootReal, KIT_PATH, 'cli.mjs');
  if (!existsSync(targetCli)) throw new Error(`Kit submodule is registered at ${KIT_PATH}${resolvedRef ? ` (${resolvedRef})` : ''}, but that revision has no cli.mjs to run init. Registration remains; inspect the pin and use a supported kit revision.`);
  const help = spawnSync(process.execPath, [targetCli, 'help'], { cwd: rootReal, encoding: 'utf8' });
  if (help.error || help.status !== 0 || !help.stdout.includes('--identity-name')) throw new Error(`Selected kit revision does not support the required init options; kit registration remains. Choose a compatible revision before configuring project configuration.`);
  if (secrets?.method === 'github') {
    try { createSecretRepository(rootReal, secrets); } catch (error) {
      throw new Error(`${error.message} To recover, inspect GitHub ${secrets.repository} and sibling ${secrets.localPath}; create a private repository only if absent, verify its ownership and privacy, clone it to that sibling path, then run init with these arguments: ${JSON.stringify(['init', '--project-root', rootReal, '--url', url, '--identity-name', options.identityName, '--identity-email', options.identityEmail, '--mirror-policy', mirrorPolicy, '--secrets', 'github', '--secrets-repository', secrets.repository, '--secrets-local-path', secrets.localPath, ...options.skill.flatMap((skill) => ['--skill', skill])])}. Pass each JSON string as one argument.`);
    }
    console.log(`Created private secret repository ${secrets.repository} and cloned it to ${secrets.localPath}; it will be preserved if later setup fails.`);
  }
  const initArgs = ['init', '--project-root', rootReal, '--url', url, '--identity-name', options.identityName, '--identity-email', options.identityEmail, '--mirror-policy', mirrorPolicy];
  if (secrets?.method) initArgs.push('--secrets', secrets.method);
  if (secrets?.method === 'github') initArgs.push('--secrets-repository', secrets.repository, '--secrets-local-path', secrets.localPath);
  for (const skill of options.skill) initArgs.push('--skill', skill);
  for (const [group, enabled] of Object.entries(optional)) initArgs.push('--optional', `${group}=${enabled ? 'on' : 'off'}`);
  const initialized = spawnSync(process.execPath, [targetCli, ...initArgs], { cwd: rootReal, stdio: 'inherit', env: sanitizedGitEnv(process.env) });
  if (initialized.error) throw initialized.error;
  if (initialized.status !== 0) throw new Error(`Kit submodule is registered${resolvedRef ? ` at ${resolvedRef}` : ''}, but project initialization did not complete. Registration and some setup may remain; no rollback was attempted. Inspect the project config, generated projections, and reported setup failure before retrying. Recovery arguments (pass each JSON string as one argument): ${JSON.stringify(initArgs)}.`);
  const readyKit = resolve(rootReal, KIT_PATH);
  const selected = resolveOptionalSelection({ kitRoot: readyKit, projectRoot: rootReal, projectConfig: JSON.parse(readFileSync(resolve(rootReal, '.vibe-coding/project.config.json'), 'utf8')), fresh: true });
  printOptionalSummary(optional, selected);
}

function validateSkillPlan(projectRoot, config, entries = [], kitRoot = REPO_ROOT) {
  const scratch = mkdtempSync(resolve(tmpdir(), 'vibe-coding-kit-install-preflight-'));
  try {
    const localSkills = resolve(projectRoot, '.vibe-coding/skills');
    const scratchSkills = resolve(scratch, '.vibe-coding/skills');
    mkdirSync(scratchSkills, { recursive: true });
    if (existsSync(localSkills)) cpSync(localSkills, scratchSkills, { recursive: true });
    for (const entry of entries.filter((item) => item.skillSnapshot)) {
      const destination = resolve(scratchSkills, entry.skillSnapshot);
      mkdirSync(dirname(destination), { recursive: true });
      if (!existsSync(destination)) writeFileSync(destination, entry.content, { mode: entry.mode });
    }
    for (const [name, decision] of Object.entries(config.skills.skills)) {
      if (decision.mode === 'extend' && !existsSync(resolve(scratchSkills, name, 'EXTENSION.md'))) {
        const target = resolve(scratchSkills, name, 'EXTENSION.md');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `---\nname: ${name}\n---\n\nAdd project-specific guidance here.\n`);
      }
    }
    composeSources({ projectRoot: scratch, kitRoot, skillsConfig: config.skills, projectConfig: config });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function getKitRegistrationOrNull(root) {
  try { return getKitRegistration({ projectRoot: root, path: KIT_PATH }); }
  catch (error) { if (error.message.startsWith('No .gitmodules entry registers ')) return null; throw error; }
}

function assertSafeInstallTargets(root) {
  const target = resolve(root, KIT_PATH);
  for (const path of [resolve(root, '.vibe-coding'), target]) {
    if (isSymlink(path)) throw new Error(`Refusing symlink install target: ${path}`);
  }
  if (existsSync(target)) {
    if (readdirSync(target).length) throw new Error(`Install target is occupied and will be preserved: ${target}`);
    throw new Error(`Install target already exists; remove or register it explicitly: ${target}`);
  }
  const modules = git(root, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { allowFailure: true });
  if (modules.status === 0) {
    const entries = new Map();
    for (const line of modules.stdout.split(/\r?\n/).filter(Boolean)) {
      const at = line.indexOf(' ');
      if (at < 0) continue;
      const match = /^submodule\.(.+)\.(path|url)$/.exec(line.slice(0, at));
      if (match) entries.set(match[1], { ...(entries.get(match[1]) || {}), [match[2]]: line.slice(at + 1) });
    }
    for (const [name, entry] of entries) {
      if ((name === 'vibe-coding-kit' && entry.path !== KIT_PATH) || (entry.path === KIT_PATH && name !== 'vibe-coding-kit')) {
        throw new Error(`Conflicting .gitmodules registration '${name}' targets ${entry.path || '(unknown path)'}`);
      }
    }
  }
  if (modules.status > 1) throw new Error(`Could not parse .gitmodules: ${modules.stderr.trim()}`);
}

function assertNoSymlinkPaths(root, paths) {
  for (const target of paths) {
    let current = target;
    while (true) {
      if (isSymlink(current)) throw new Error(`Refusing symlink install path: ${current}`);
      if (!isPathWithin(root, current)) throw new Error(`Refusing install path outside the project root: ${current}`);
      if (samePathIdentity(root, current)) break;
      if (dirname(current) === current) throw new Error(`Refusing install path outside the project root: ${current}`);
      current = dirname(current);
    }
  }
}

function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

function assertProjectionTargetsAvailable(root) {
  const targets = ['AGENTS.md', 'CLAUDE.md', '.agents/skills', '.claude/skills'].map((path) => resolve(root, path));
  for (const target of targets) {
    if (isSymlink(target)) throw new Error(`Refusing symlink skill projection target: ${target}`);
    if (existsSync(target)) throw new Error(`Skill projection target already exists and will be preserved: ${target}. Move or merge it manually before installing.`);
  }
  assertNoSymlinkPaths(root, targets);
}

function projectRoot(options) {
  return resolve(options.projectRoot || process.cwd());
}

function parseOptionalOverrides(values = []) {
  const result = {};
  for (const value of values) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(on|off)$/.exec(value);
    if (!match || !OPTIONAL_GROUPS.includes(match[1])) throw new Error(`Invalid --optional '${value}'; use aliyun|lark|non-code|task-progress=on|off`);
    if (Object.hasOwn(result, match[1])) throw new Error(`Optional category ${match[1]} was selected more than once`);
    result[match[1]] = match[2] === 'on';
  }
  return result;
}

function projectConfig(root) {
  const path = resolve(root, '.vibe-coding/project.config.json');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project config must be an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function inspectPluginComponents(kitRoot, env) {
  const catalog = loadOptionalCatalog(kitRoot);
  const detected = new Map();
  if (!catalog) return detected;
  for (const [id, component] of Object.entries(catalog.components)) {
    if (component.type !== 'plugin') continue;
    detected.set(id, await inspectOptionalComponent({ kitRoot, component: { id, ...component }, platform: platform(), arch: arch(), env }));
    if (!['installed', 'missing', 'unsupported', 'error'].includes(detected.get(id)?.status)) {
      detected.set(id, { status: 'error', message: `invalid inspection result for ${id}` });
    }
  }
  return detected;
}

function applyInstalledPluginDefaults(kitRoot, preferences, detected, savedPreferences, overrides = {}) {
  const catalog = loadOptionalCatalog(kitRoot);
  if (!catalog) return;
  for (const [group, descriptor] of Object.entries(catalog.groups)) {
    for (const id of descriptor.components) {
      const component = catalog.components[id];
      if (component.type !== 'plugin') continue;
      const status = detected.get(id);
      if (status?.status === 'error') {
        console.log(`${group}: plugin detection failed (${status.message || 'inspection failed'}); it will not be offered or reused.`);
        if (overrides[group] === true || (overrides[group] !== false && savedPreferences?.[group] === true)) {
          throw new Error(`Could not detect selected optional plugin ${id}: ${status.message || 'inspection failed'}. Plugin setup was not started.`);
        }
        preferences[group] = false;
        continue;
      }
      if (status?.status === 'unsupported') {
        preferences[group] = false;
        console.log(`${group}: unavailable (${status.message || 'unsupported platform'})`);
        continue;
      }
      const mayDefaultInstalled = savedPreferences === undefined || savedPreferences[group] === true;
      if (status?.status === 'installed' && mayDefaultInstalled && overrides[group] !== false) preferences[group] = true;
    }
  }
}

async function askOptionalCategories(kitRoot, current, detected = new Map(), savedPreferences = {}) {
  const catalog = loadOptionalCatalog(kitRoot);
  if (!catalog) return Object.fromEntries(OPTIONAL_GROUPS.map((group) => [group, false]));
  const available = optionalWizardGroups(catalog, detected);
  for (const [group, descriptor] of Object.entries(catalog.groups)) {
    for (const id of descriptor.components.filter((componentId) => catalog.components[componentId].type === 'plugin')) {
        const mayDefaultInstalled = savedPreferences === undefined || savedPreferences[group] === true;
        if (detected.get(id)?.status === 'installed' && mayDefaultInstalled) current[group] = true;
    }
  }
  if (!available.length) return { ...current };
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Optional category selection needs a terminal; pass --optional <group>=on|off or run optional configure with explicit flags');
  const defaults = available.filter((group) => current[group] === true);
  const questions = available.map((group) => `${group}: ${catalog.groups[group].question}`).join('\n');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`Optional categories to enable [${defaults.join(',') || 'none'}]:\n${questions}\nEnter comma-separated category IDs, or none (Enter keeps defaults): `)).trim();
    if (!answer) return { ...current, ...Object.fromEntries(available.map((group) => [group, defaults.includes(group)])) };
    const chosen = answer.toLowerCase() === 'none' ? [] : answer.split(',').map((item) => item.trim()).filter(Boolean);
    for (const group of chosen) {
      if (!available.includes(group)) throw new Error(`Optional category ${group} is unavailable or already installed and was not offered`);
    }
    return { ...current, ...Object.fromEntries(available.map((group) => [group, chosen.includes(group)])) };
  } finally { prompt.close(); }
}

function optionalWizardGroups(catalog, detected) {
  const hidden = new Set();
  for (const [group, descriptor] of Object.entries(catalog.groups)) {
    for (const id of descriptor.components.filter((componentId) => catalog.components[componentId].type === 'plugin')) {
      if (['installed', 'unsupported', 'error'].includes(detected.get(id)?.status)) hidden.add(group);
    }
  }
  return OPTIONAL_GROUPS.filter((group) => !hidden.has(group));
}

async function preflightOptionalComponents(kitRoot, components, env, knownStatuses = new Map()) {
  const statuses = new Map(knownStatuses);
  for (const component of components) {
    if (statuses.has(component.id)) continue;
    statuses.set(component.id, await inspectOptionalComponent({ kitRoot, component, platform: platform(), arch: arch(), env }));
    if (!['installed', 'missing', 'unsupported', 'error'].includes(statuses.get(component.id)?.status)) {
      statuses.set(component.id, { status: 'error', message: `invalid inspection result for ${component.id}` });
    }
  }
  return statuses;
}

function assertOptionalPreflight(components, statuses) {
  for (const component of components) {
    const status = statuses.get(component.id);
    if (status?.status === 'error') throw new Error(`Could not inspect optional ${component.id}: ${status.message || 'inspection failed'}. No project files were changed.`);
    if (status?.status === 'unsupported') throw new Error(`Optional ${component.id} is unsupported (${status.message || 'unsupported platform'}); remove the selection before continuing. No project files were changed.`);
  }
}

async function installOptionalComponents(kitRoot, components, env, statuses) {
  for (const component of components) {
    const inspected = statuses?.get(component.id);
    if (inspected?.status === 'installed') {
      console.log(`Optional ${component.id}: already installed; reused.`);
      continue;
    }
    if (inspected?.status === 'unsupported') {
      throw new Error(`Optional ${component.id} is unsupported (${inspected.message || 'unsupported platform'}). Optional setup was not completed; core setup is preserved.`);
    }
    if (inspected?.status === 'error') throw new Error(`Optional ${component.id} could not be inspected: ${inspected.message || 'inspection failed'}. Optional setup was not completed; core setup is preserved.`);
    const result = await installOptionalComponent({ kitRoot, component, env });
    if (!result || result.status !== 'installed') {
      const status = result?.status || 'invalid-result';
      throw new Error(`Optional ${component.id} setup is incomplete (${status}): ${result?.message || 'no successful installation was confirmed'}. Core setup is preserved; optional setup may need repair.`);
    }
    console.log(`Optional ${component.id}: ready.`);
  }
}

function printOptionalSummary(preferences, selection) {
  console.log('Optional categories:');
  for (const group of OPTIONAL_GROUPS) {
    const enabled = preferences?.[group] ?? selection.selection[group];
    console.log(`  ${group}: ${enabled ? 'on' : 'off'}`);
  }
  if (selection.components.length) console.log(`Selected components: ${selection.components.map(({ id }) => id).join(', ')}`);
}

async function configureOptional(root, kitRoot, overrides, { interactive = false, checkOnly = false } = {}) {
  const config = projectConfig(root);
  const currentSelection = resolveOptionalSelection({ kitRoot, projectRoot: root, projectConfig: config });
  let next = { ...currentSelection.selection, ...overrides };
  const explicitGroups = new Set(Object.keys(overrides));
  const detected = checkOnly ? new Map() : await inspectPluginComponents(kitRoot, process.env);
  if (!checkOnly) applyInstalledPluginDefaults(kitRoot, next, detected, config.optional, overrides);
  if (!checkOnly) {
    const catalog = loadOptionalCatalog(kitRoot);
    if (catalog) {
      for (const [group, descriptor] of Object.entries(catalog.groups)) {
        const installedPlugin = descriptor.components.some((id) => catalog.components[id].type === 'plugin' && detected.get(id)?.status === 'installed');
        if (installedPlugin && config.optional?.[group] === undefined && overrides[group] !== false && next[group]) explicitGroups.add(group);
      }
    }
  }
  if (interactive && !checkOnly && Object.keys(overrides).length === 0) {
    const catalog = loadOptionalCatalog(kitRoot);
    const offered = catalog ? optionalWizardGroups(catalog, detected) : [];
    next = await askOptionalCategories(kitRoot, next, detected, config.optional);
    for (const group of offered) explicitGroups.add(group);
  }
  validateOptionalPreferences(next);
  const nextProjectConfig = planOptionalConfiguration({ kitRoot, projectRoot: root, projectConfig: config, nextSelection: next, explicitGroups: [...explicitGroups] });
  const selection = resolveOptionalSelection({ kitRoot, projectRoot: root, projectConfig: nextProjectConfig });
  if (checkOnly) {
    validateSkillPlan(root, nextProjectConfig, [], kitRoot);
    printOptionalSummary(nextProjectConfig.optional, selection);
    console.log('Optional configuration check is read-only; no setup was started.');
    return;
  }
  const statuses = await preflightOptionalComponents(kitRoot, selection.components, process.env, detected);
  assertOptionalPreflight(selection.components, statuses);
  validateSkillPlan(root, nextProjectConfig, [], kitRoot);
  const configPath = resolve(root, '.vibe-coding/project.config.json');
  assertNoSymlinkPaths(root, [configPath]);
  const serialized = `${JSON.stringify(nextProjectConfig, null, 2)}\n`;
  if (existsSync(configPath)) writeFileSync(configPath, serialized);
  else throw new Error(`Project is not initialized: missing ${configPath}`);
  let synced;
  try { synced = syncProjectSkills({ projectRoot: root, kitRoot }); }
  catch (error) {
    throw new Error(`Optional preferences were saved, but generated skill projections did not finish synchronizing. Some mirrors may be partial; local sources and other project files were preserved. Repair with the project's skills:sync command. ${error.message}`);
  }
  if (!synced || !Number.isInteger(synced.written)) {
    throw new Error('Optional preferences were saved, but the skill synchronization result was invalid. Generated mirrors may be partial; verify them with the project skills:check command.');
  }
  console.log(`Synchronized ${synced.written} generated skill projection file(s).`);
  await installOptionalComponents(kitRoot, selection.components, process.env, statuses);
  printOptionalSummary(nextProjectConfig.optional, selection);
}

function plannedInitFiles(root, options) {
  const configPath = resolve(root, '.vibe-coding/project.config.json');
  const configTemplate = JSON.parse(readFileSync(resolve(REPO_ROOT, 'templates/project.config.json'), 'utf8'));
  configTemplate.kit.url = options.url || DEFAULT_URL;
  configTemplate.identity.name = options.identityName || '';
  configTemplate.identity.email = options.identityEmail || '';
  const existingConfig = projectConfig(root);
  const existingOptional = existingConfig.optional;
  const optionalOverrides = parseOptionalOverrides(options.optional || []);
  const freshProject = !existsSync(configPath);
  if (options.optionalSelection) {
    configTemplate.optional = options.optionalSelection;
  } else if (freshProject || existingOptional !== undefined || Object.keys(optionalOverrides).length) {
    configTemplate.optional = { ...(existingOptional || {}), ...optionalOverrides };
    if (freshProject) configTemplate.optional = { ...Object.fromEntries(OPTIONAL_GROUPS.map((group) => [group, false])), ...configTemplate.optional };
  } else delete configTemplate.optional;
  if (options.secretsPlan) configTemplate.secrets = options.secretsPlan;
  else if (options.secrets === 'vault') configTemplate.secrets = { method: 'vault', status: 'not-provisioned' };
  else if (options.secrets === 'github' && options.secretsRepository && options.secretsLocalPath) configTemplate.secrets = { method: 'github', repository: options.secretsRepository, localPath: options.secretsLocalPath };
  else if (options.secrets) throw new Error('init requires a valid secrets method and GitHub repository details');
  const mirrorPolicy = options.mirrorPolicy || 'local';
  if (!['local', 'tracked'].includes(mirrorPolicy)) throw new Error('--mirror-policy must be local or tracked');
  configTemplate.skills = { ...configTemplate.skills, mirrorPolicy, skills: {} };
  const selected = new Map();
  const snapshots = new Map();
  const optionalSkills = [];
  {
    const commonSkills = resolve(REPO_ROOT, 'skills');
    const commonNames = awaitlessReaddir(commonSkills);
    const localRoot = resolve(root, '.vibe-coding/skills');
    const localNames = existsSync(localRoot) ? awaitlessReaddir(localRoot) : [];
    const optionalProjectConfig = { ...existingConfig };
    if (configTemplate.optional !== undefined) optionalProjectConfig.optional = configTemplate.optional;
    const optionalSelection = resolveOptionalSelection({
      kitRoot: REPO_ROOT,
      projectRoot: root,
      projectConfig: optionalProjectConfig,
      overrides: options.optionalSelection ? {} : optionalOverrides,
      fresh: freshProject,
    });
    const optionalCatalog = loadOptionalCatalog(REPO_ROOT);
    const optionalSourceRoots = optionalSelection.skills;
    const optionalNames = new Set(Object.values(optionalCatalog?.components ?? {}).flatMap((component) => component.skills));
    const optionalGroups = new Map();
    for (const [group, descriptor] of Object.entries(optionalCatalog?.groups ?? {})) {
      for (const id of descriptor.components) for (const name of optionalCatalog.components[id].skills) optionalGroups.set(name, group);
    }
    const knownNames = new Set([...commonNames, ...optionalSourceRoots.keys()]);
    for (const specification of options.skill) {
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*):?(?:=)?(adopt|extend|replace|local|exclude)?(?::(.+))?$/.exec(specification);
      if (!match) throw new Error(`Invalid --skill '${specification}'; use name=adopt, name=extend, name=replace:rationale, or name=exclude:rationale`);
      const [, name, mode = 'adopt', rationale] = match;
      if (selected.has(name)) throw new Error(`Skill ${name} was selected more than once`);
      if (optionalNames.has(name) && !optionalSourceRoots.has(name) && mode !== 'exclude') {
        throw new Error(`Optional skill ${name} belongs to the disabled ${optionalGroups.get(name)} category; enable it with --optional ${optionalGroups.get(name)}=on before selecting this mode`);
      }
      if (!knownNames.has(name) && mode !== 'local' && !(optionalNames.has(name) && mode === 'exclude')) throw new Error(`Unknown public skill: ${name}`);
      const decision = { mode };
      if (mode === 'replace') { decision.rationale = rationale; decision.replaces = name; }
      if (mode === 'exclude') decision.rationale = rationale;
      selected.set(name, decision);
      if (mode === 'replace' && !existsSync(configPath) && optionalSourceRoots.has(name)) snapshots.set(name, optionalSourceRoots.get(name).root);
    }
    // Secret access is an installer-selected project-owned skill, not a new
    // public skill that would force a decision on existing kit consumers.
    const method = configTemplate.secrets?.method;
    const optionalName = method === 'github' ? 'secret-repository-access' : method === 'vault' ? 'vault-secret-access' : null;
    if (optionalName) {
      const otherName = method === 'github' ? 'vault-secret-access' : 'secret-repository-access';
      if (localNames.includes(otherName) || selected.has(otherName)) throw new Error(`Conflicting secret access skill ${otherName}; preserve it and resolve the project authority before installing`);
      if (selected.has(optionalName)) throw new Error(`Secret access skill ${optionalName} is selected automatically; do not pass --skill for it`);
      selected.set(optionalName, { mode: 'local' });
      optionalSkills.push(optionalName);
    }
    for (const name of commonNames) {
      if (selected.has(name)) continue;
      if (localNames.includes(name) && !existsSync(configPath)) continue;
      selected.set(name, { mode: 'replace', rationale: 'Project-owned snapshot initialized from the kit.', replaces: name });
      if (!existsSync(configPath)) snapshots.set(name, commonSkills);
    }
    for (const name of optionalSourceRoots.keys()) {
      if (selected.has(name)) continue;
      selected.set(name, { mode: 'adopt' });
    }
    configTemplate.skills.skills = Object.fromEntries(selected);
  }
  const adapterPath = resolve(root, 'engineering/automation/vibe-coding/project-adapter.mjs');
  const bootstrapPath = resolve(root, 'engineering/automation/vibe-coding/bootstrap.mjs');
  const loadingPath = resolve(root, '.vibe-coding/loading.md');
  const configContent = `${JSON.stringify(configTemplate, null, 2)}\n`;
  const entries = [
    { path: configPath, content: configContent },
    { path: adapterPath, content: readFileSync(resolve(REPO_ROOT, 'templates/project-adapter.mjs'), 'utf8') },
    { path: bootstrapPath, content: readFileSync(resolve(REPO_ROOT, 'templates/bootstrap.mjs'), 'utf8') },
    { path: loadingPath, content: readFileSync(resolve(REPO_ROOT, 'templates/loading.md'), 'utf8') },
  ];
  const addSnapshot = (source, target, skillPath) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
      const sourcePath = resolve(source, entry.name);
      const targetPath = resolve(target, entry.name);
      const snapshotPath = `${skillPath}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in skill source: ${sourcePath}`);
      if (entry.isDirectory()) addSnapshot(sourcePath, targetPath, snapshotPath);
      else if (entry.isFile()) entries.push({ path: targetPath, content: readFileSync(sourcePath), mode: lstatSync(sourcePath).mode & 0o777, skillSnapshot: snapshotPath });
    }
  };
  for (const [name, sourceRoot] of snapshots) addSnapshot(resolve(sourceRoot, name), resolve(root, '.vibe-coding/skills', name), name);
  for (const name of optionalSkills) addSnapshot(resolve(REPO_ROOT, 'templates/optional-skills', name), resolve(root, '.vibe-coding/skills', name), name);
  const gitignorePath = resolve(root, '.gitignore');
  const currentGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const mergedGitignore = mergeMirrorIgnoreBlock(currentGitignore, mirrorPolicy);
  if (existsSync(gitignorePath) || mergedGitignore) {
    entries.push({ path: gitignorePath, content: mergedGitignore, mergeExisting: true });
  }
  for (const [name, decision] of selected) {
    if (decision.mode !== 'extend') continue;
    entries.push({
      path: resolve(root, `.vibe-coding/skills/${name}/EXTENSION.md`),
      content: `---\nname: ${name}\n---\n\nAdd project-specific guidance here.\n`,
    });
  }
  const conflicts = [];
  const packagePath = resolve(root, 'package.json');
  if (existsSync(packagePath)) {
    let packageJson;
    try { packageJson = JSON.parse(readFileSync(packagePath, 'utf8')); }
    catch (error) { throw new Error(`Cannot merge runtime scripts into invalid package.json: ${error.message}`); }
    const requestedScripts = {
      'skills:sync': 'node engineering/automation/vibe-coding/bootstrap.mjs skills sync',
      'skills:check': 'node engineering/automation/vibe-coding/bootstrap.mjs skills check',
      'worktree:begin': 'node engineering/automation/vibe-coding/bootstrap.mjs worktree begin',
      'worktree:end': 'node engineering/automation/vibe-coding/bootstrap.mjs worktree finish',
      'worktree:status': 'node engineering/automation/vibe-coding/bootstrap.mjs worktree status',
      'worktree:cleanup': 'node engineering/automation/vibe-coding/bootstrap.mjs worktree cleanup',
      'worktree:sync-primary': 'node engineering/automation/vibe-coding/bootstrap.mjs worktree sync-primary',
    };
    packageJson.scripts = packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
      ? packageJson.scripts : {};
    const collisions = Object.entries(requestedScripts).filter(([name, command]) => packageJson.scripts[name] && packageJson.scripts[name] !== command);
    if (collisions.length) {
      for (const [name] of collisions) conflicts.push(`package.json scripts.${name}`);
    } else {
      Object.assign(packageJson.scripts, requestedScripts);
      entries.push({ path: packagePath, content: `${JSON.stringify(packageJson, null, 2)}\n`, mergeExisting: true });
    }
  }
  const writes = [];
  for (const entry of entries) {
    if (!existsSync(entry.path)) { writes.push(entry); continue; }
    const current = readFileSync(entry.path, Buffer.isBuffer(entry.content) ? undefined : 'utf8');
    const same = Buffer.isBuffer(entry.content) ? current.equals(entry.content) : current === entry.content;
    if (entry.mergeExisting) {
      if (!same) writes.push(entry);
      continue;
    }
    if (!same) conflicts.push(entry.path);
  }
  if (!configTemplate.identity.name.trim() || !configTemplate.identity.email.trim()) {
    conflicts.push('identity.name and identity.email (pass --identity-name and --identity-email)');
  }
  return { entries, writes, conflicts, config: configTemplate };
}

function mergeMirrorIgnoreBlock(current, policy) {
  const beginAt = current.indexOf(MIRROR_IGNORE_BEGIN);
  const endAt = current.indexOf(MIRROR_IGNORE_END);
  if ((beginAt < 0) !== (endAt < 0) || (beginAt >= 0 && current.indexOf(MIRROR_IGNORE_BEGIN, beginAt + 1) >= 0)
      || (endAt >= 0 && current.indexOf(MIRROR_IGNORE_END, endAt + 1) >= 0)) {
    throw new Error('Cannot merge malformed or duplicated vibe-coding-kit mirror block in .gitignore');
  }
  let base = current;
  if (beginAt >= 0) {
    const lineStart = beginAt === 0 || current[beginAt - 1] === '\n';
    const endLine = endAt + MIRROR_IGNORE_END.length;
    const lineEnd = endLine === current.length || current[endLine] === '\n' || current.slice(endLine, endLine + 2) === '\r\n';
    if (!lineStart || !lineEnd || endAt < beginAt) throw new Error('Cannot merge malformed vibe-coding-kit mirror block in .gitignore');
    let after = endLine;
    if (current.slice(after, after + 2) === '\r\n') after += 2;
    else if (current[after] === '\n') after += 1;
    base = `${current.slice(0, beginAt)}${current.slice(after)}`;
  }
  if (policy === 'tracked') return base;
  if (beginAt >= 0) return `${base.slice(0, beginAt)}${MIRROR_IGNORE_BLOCK}${base.slice(beginAt)}`;
  if (!base) return MIRROR_IGNORE_BLOCK;
  return `${base}${base.endsWith('\n') ? '\n' : '\n\n'}${MIRROR_IGNORE_BLOCK}`;
}

function awaitlessReaddir(path) {
  return requireReaddirSync(path).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name));
}

function requireReaddirSync(path) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function init(root, options) {
  if (options.secrets === 'github') verifySecretRepository(root, { repository: options.secretsRepository, localPath: options.secretsLocalPath });
  const registration = getKitRegistration({ projectRoot: root });
  if (registration.name !== 'vibe-coding-kit') throw new Error(`Expected .gitmodules submodule name vibe-coding-kit, found ${registration.name}`);
  const expectedUrl = options.url || DEFAULT_URL;
  if (registration.url !== expectedUrl) {
    throw new Error(`Registered kit URL ${registration.url} differs from requested URL ${expectedUrl}; pass --url to select the registered source explicitly`);
  }
  const plan = plannedInitFiles(root, options);
  const selected = resolveOptionalSelection({ kitRoot: REPO_ROOT, projectRoot: root, projectConfig: plan.config, overrides: options.optional?.length ? parseOptionalOverrides(options.optional) : {}, fresh: !existsSync(resolve(root, '.vibe-coding/project.config.json')) });
  const optionalStatuses = options.check ? new Map() : await preflightOptionalComponents(REPO_ROOT, selected.components, process.env);
  if (!options.check) assertOptionalPreflight(selected.components, optionalStatuses);
  if (!existsSync(resolve(root, '.vibe-coding/project.config.json'))) assertProjectionTargetsAvailable(root);
  assertNoSymlinkPaths(root, plan.entries.map(({ path }) => path));
  validateSkillPlan(root, plan.config, plan.entries);
  for (const entry of plan.writes) console.log(`create ${entry.path}`);
  for (const entry of plan.entries.filter(({ path }) => existsSync(path))) {
    if (plan.conflicts.includes(entry.path)) continue;
    console.log(`${entry.mergeExisting && plan.writes.includes(entry) ? 'merge' : 'keep '} ${entry.path}`);
  }
  if (plan.conflicts.length) {
    for (const conflict of plan.conflicts) console.error(`conflict ${conflict}`);
    throw new Error('Initialization needs an explicit conflict or missing-identity resolution');
  }
  if (options.check) {
    if (plan.writes.length) process.exitCode = 1;
    return;
  }
  for (const entry of plan.writes) {
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, entry.content, entry.mergeExisting ? undefined : { flag: 'wx', mode: entry.mode });
  }
  prepareKit({ projectRoot: root });
  mkdirSync(resolve(root, '.vibe-coding/skills'), { recursive: true });
  syncProjectSkills({ projectRoot: root, kitRoot: resolve(root, '.vibe-coding/kit') });
  await installOptionalComponents(resolve(root, '.vibe-coding/kit'), selected.components, process.env, optionalStatuses);
  printOptionalSummary(plan.config.optional, selected);
  console.log('Initialization complete. No package.json or business dependencies were created.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = projectRoot(options);

  switch (options.command) {
    case 'reuse-catalog': {
      const allowed = new Set(['command', 'positional', 'skill', 'optional', 'projectRoot']);
      if (Object.keys(options).some((key) => !allowed.has(key)) || options.skill.length || options.optional.length || options.positional.length !== 1 || !['check', 'regen'].includes(options.positional[0])) throw new Error('Usage: cli.mjs reuse-catalog <check|regen> --project-root <path>');
      const result = await runReuseCatalog({ projectRoot: root, action: options.positional[0] });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'install': await install(root, options); return;
    case 'backend-check': {
      const result = spawnSync(process.execPath, [resolve(REPO_ROOT, 'src/backend/dispatch.mjs'),
        '--project-root', root, '--config', options.config || '.vibe-coding/backend-architecture.json'], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      return;
    }
    case 'init': await init(root, options); return;
    case 'optional': {
      const action = options.positional[0];
      if (action !== 'configure') throw new Error('Usage: cli.mjs optional configure --project-root <path> [--optional <group>=on|off]');
      const allowed = new Set(['command', 'positional', 'skill', 'optional', 'projectRoot', 'check']);
      const unsupported = Object.keys(options).filter((key) => !allowed.has(key));
      if (unsupported.length) throw new Error(`Unsupported optional option(s): ${unsupported.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(', ')}`);
      if (options.positional.length !== 1) throw new Error('Usage: cli.mjs optional configure --project-root <path> [--optional <group>=on|off]');
      const kitState = checkKit({ projectRoot: root });
      if (!kitState.applicable) throw new Error('Optional configuration requires a registered .vibe-coding/kit submodule');
      const overrides = parseOptionalOverrides(options.optional);
      await configureOptional(root, resolve(root, KIT_PATH), overrides, { interactive: Object.keys(overrides).length === 0, checkOnly: options.check });
      return;
    }
    case 'check': {
      const result = checkKit({ projectRoot: root });
      console.log(result.applicable ? `Kit ${result.commit} is ready.` : 'No vibe-coding-kit submodule is registered.');
      return;
    }
    case 'prepare': {
      const result = prepareKit({ projectRoot: root, allowNetwork: !options.offline });
      console.log(result.applicable ? `Prepared kit ${result.commit}.` : 'No vibe-coding-kit submodule is registered.');
      return;
    }
    case 'inspect': {
      console.log(JSON.stringify(inspectKit({ projectRoot: root }), null, 2));
      return;
    }
    case 'skills': {
      const action = options.positional[0] || 'check';
      if (!['check', 'sync'].includes(action)) throw new Error('Usage: cli.mjs skills <check|sync> --project-root <path>');
      const kitState = checkKit({ projectRoot: root });
      if (!kitState.applicable) throw new Error('No vibe-coding-kit submodule is registered');
      const result = syncProjectSkills({
        projectRoot: root,
        kitRoot: resolve(root, '.vibe-coding/kit'),
        checkOnly: action === 'check',
      });
      if (action === 'check' && !result.ok) {
        for (const problem of result.problems) console.error(problem);
        process.exitCode = 1;
      } else {
        console.log(action === 'check' ? 'Skill projections are current.' : `Synchronized ${result.written} skill projection file(s).`);
      }
      return;
    }
    case 'worktree':
    case 'worktrees': {
      const prepared = prepareKit({ projectRoot: root, allowNetwork: !options.offline });
      if (!prepared.applicable) throw new Error('Worktree commands require a registered .vibe-coding/kit submodule');
      checkKit({ projectRoot: root });
      const forwarded = options.forwarded;
      const command = forwarded[0] || 'status';
      const result = spawnSync(process.execPath, [resolve(REPO_ROOT, 'src/worktrees/cli.mjs'), command, ...forwarded.slice(1)], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      return;
    }
    case 'help':
      console.log('Usage: vibe-coding-kit install --project-root <path> --identity-name <name> --identity-email <email> [--url <git-url>] [--ref <tag-or-commit>] [--skill <selection>] [--optional <group>=on|off] [--mirror-policy local|tracked] [--secrets github|vault] [--check]\n       node cli.mjs <init|check|prepare|inspect|skills|optional configure|worktree|backend-check|reuse-catalog> --project-root <path> [options]\nOptional groups: aliyun, lark, non-code, task-progress. Backend: --config <project-relative JSON path>');
      return;
    default: throw new Error(`Unknown command: ${options.command}`);
  }
}

if (isMainModule(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`[vibe-coding-kit] ${error.message}`); process.exitCode = 1; }
}
