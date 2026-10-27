#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkKit, getKitRegistration, inspectKit, prepareKit } from './src/dependencies/submodule.mjs';
import { syncProjectSkills } from './src/skills/project-sync.mjs';
import { composeSources } from './src/skills/composition.mjs';
import { isMainModule } from './src/lib/main-module.mjs';
import { isPathWithin, samePathIdentity } from './src/lib/path-identity.mjs';
import { sanitizedGitEnv } from './src/git-environment.mjs';

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
    const [key, inline] = value.slice(2).split('=', 2);
    const next = inline ?? rest[index + 1];
    if (inline === undefined) index += 1;
    if (!next || next.startsWith('--')) throw new Error(`Option --${key} requires a value`);
    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (normalized === 'skill') options.skill.push(next);
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

function install(root, options) {
  const allowed = new Set(['command', 'positional', 'skill', 'projectRoot', 'url', 'ref', 'identityName', 'identityEmail', 'mirrorPolicy', 'check']);
  const unsupported = Object.keys(options).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported install option(s): ${unsupported.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(', ')}`);
  if (options.positional.length) throw new Error(`Unexpected install argument(s): ${options.positional.join(' ')}`);
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
    const skills = syncProjectSkills({ projectRoot: rootReal, kitRoot: resolve(rootReal, KIT_PATH), checkOnly: true });
    if (!skills.ok) throw new Error(`Kit is initialized but skill projections need repair: ${skills.problems.join('; ')}. Run the project's skills:sync command.`);
    console.log(`Kit ${ready.commit} is ready; existing configuration and local files were preserved.`);
    return;
  }
  if (!options.identityName?.trim() || !options.identityEmail?.trim()) throw new Error('fresh install requires --identity-name and --identity-email');
  if (status.stdout.trim()) throw new Error(`Refusing first install into a dirty Git project; commit or remove existing changes first:\n${status.stdout.trim()}`);
  assertSafeInstallTargets(rootReal);
  assertProjectionTargetsAvailable(rootReal);
  assertNoSymlinkPaths(rootReal, ['.gitignore', 'package.json', '.vibe-coding/skills', 'engineering/automation/vibe-coding'].map((path) => resolve(rootReal, path)));
  // Validate all init options and conflicts before the first repository mutation.
  const plan = plannedInitFiles(rootReal, { ...options, url, mirrorPolicy });
  assertNoSymlinkPaths(rootReal, [...plan.entries.map(({ path }) => path), resolve(rootReal, '.gitmodules')]);
  if (plan.conflicts.length) throw new Error(`Install preflight found conflicts: ${plan.conflicts.join(', ')}`);
  validateSkillPlan(rootReal, plan.config);
  if (options.check) {
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
  const initArgs = ['init', '--project-root', rootReal, '--url', url, '--identity-name', options.identityName, '--identity-email', options.identityEmail, '--mirror-policy', mirrorPolicy];
  for (const skill of options.skill) initArgs.push('--skill', skill);
  const initialized = spawnSync(process.execPath, [targetCli, ...initArgs], { cwd: rootReal, stdio: 'inherit', env: sanitizedGitEnv(process.env) });
  if (initialized.error) throw initialized.error;
  if (initialized.status !== 0) throw new Error(`Kit submodule is registered${resolvedRef ? ` at ${resolvedRef}` : ''}, but project initialization failed. Existing files were preserved; resolve the reported conflict, then run "node ${KIT_PATH}/cli.mjs init" with the install identity and options.`);
}

function validateSkillPlan(projectRoot, config) {
  const scratch = mkdtempSync(resolve(tmpdir(), 'vibe-coding-kit-install-preflight-'));
  try {
    const localSkills = resolve(projectRoot, '.vibe-coding/skills');
    const scratchSkills = resolve(scratch, '.vibe-coding/skills');
    mkdirSync(scratchSkills, { recursive: true });
    if (existsSync(localSkills)) cpSync(localSkills, scratchSkills, { recursive: true });
    for (const [name, decision] of Object.entries(config.skills.skills)) {
      if (decision.mode === 'extend' && !existsSync(resolve(scratchSkills, name, 'EXTENSION.md'))) {
        const target = resolve(scratchSkills, name, 'EXTENSION.md');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `---\nname: ${name}\n---\n\nAdd project-specific guidance here.\n`);
      }
    }
    composeSources({ projectRoot: scratch, kitRoot: REPO_ROOT, skillsConfig: config.skills });
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

function plannedInitFiles(root, options) {
  const configPath = resolve(root, '.vibe-coding/project.config.json');
  const configTemplate = JSON.parse(readFileSync(resolve(REPO_ROOT, 'templates/project.config.json'), 'utf8'));
  configTemplate.kit.url = options.url || DEFAULT_URL;
  configTemplate.identity.name = options.identityName || '';
  configTemplate.identity.email = options.identityEmail || '';
  const mirrorPolicy = options.mirrorPolicy || 'local';
  if (!['local', 'tracked'].includes(mirrorPolicy)) throw new Error('--mirror-policy must be local or tracked');
  configTemplate.skills = { ...configTemplate.skills, mirrorPolicy, skills: {} };
  const selected = new Map();
  {
    const commonSkills = resolve(REPO_ROOT, 'skills');
    const commonNames = (awaitlessReaddir(commonSkills));
    const localRoot = resolve(root, '.vibe-coding/skills');
    const localNames = existsSync(localRoot) ? awaitlessReaddir(localRoot) : [];
    for (const specification of options.skill) {
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*):?(?:=)?(adopt|extend|replace|local|exclude)?(?::(.+))?$/.exec(specification);
      if (!match) throw new Error(`Invalid --skill '${specification}'; use name=adopt, name=extend, name=replace:rationale, or name=exclude:rationale`);
      const [, name, mode = 'adopt', rationale] = match;
      if (selected.has(name)) throw new Error(`Skill ${name} was selected more than once`);
      if (!commonNames.includes(name) && mode !== 'local') throw new Error(`Unknown public skill: ${name}`);
      const decision = { mode };
      if (mode === 'replace') { decision.rationale = rationale; decision.replaces = name; }
      if (mode === 'exclude') decision.rationale = rationale;
      selected.set(name, decision);
    }
    for (const name of commonNames) {
      if (selected.has(name)) continue;
      if (localNames.includes(name)) continue;
      selected.set(name, { mode: 'exclude', rationale: 'Not selected for this project during initialization.' });
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
    const current = readFileSync(entry.path, 'utf8');
    if (entry.mergeExisting) {
      if (current !== entry.content) writes.push(entry);
      continue;
    }
    if (current !== entry.content) conflicts.push(entry.path);
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

function init(root, options) {
  const registration = getKitRegistration({ projectRoot: root });
  if (registration.name !== 'vibe-coding-kit') throw new Error(`Expected .gitmodules submodule name vibe-coding-kit, found ${registration.name}`);
  const expectedUrl = options.url || DEFAULT_URL;
  if (registration.url !== expectedUrl) {
    throw new Error(`Registered kit URL ${registration.url} differs from requested URL ${expectedUrl}; pass --url to select the registered source explicitly`);
  }
  const plan = plannedInitFiles(root, options);
  if (!existsSync(resolve(root, '.vibe-coding/project.config.json'))) assertProjectionTargetsAvailable(root);
  validateSkillPlan(root, plan.config);
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
    writeFileSync(entry.path, entry.content, entry.mergeExisting ? undefined : { flag: 'wx' });
  }
  prepareKit({ projectRoot: root });
  mkdirSync(resolve(root, '.vibe-coding/skills'), { recursive: true });
  syncProjectSkills({ projectRoot: root, kitRoot: resolve(root, '.vibe-coding/kit') });
  console.log('Initialization complete. No package.json or business dependencies were created.');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = projectRoot(options);
  switch (options.command) {
    case 'install': install(root, options); return;
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
    case 'init': init(root, options); return;
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
      console.log('Usage: vibe-coding-kit install --project-root <path> --identity-name <name> --identity-email <email> [--url <git-url>] [--ref <tag-or-commit>] [--skill <selection>] [--mirror-policy local|tracked] [--check]\n       node cli.mjs <init|check|prepare|inspect|skills|worktree|backend-check> --project-root <path> [options]\nBackend: --config <project-relative JSON path>');
      return;
    default: throw new Error(`Unknown command: ${options.command}`);
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`[vibe-coding-kit] ${error.message}`); process.exitCode = 1; }
}
