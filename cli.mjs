#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKit, getKitRegistration, inspectKit, prepareKit } from './src/dependencies/submodule.mjs';
import { syncProjectSkills } from './src/skills/project-sync.mjs';
import { sync as syncLocalSkills } from './src/skills/sync-skills.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://github.com/Dawn-Inator/vibe-coding-kit.git';

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

function projectRoot(options) {
  return resolve(options.projectRoot || process.cwd());
}

function plannedInitFiles(root, options) {
  const configPath = resolve(root, '.vibe-coding/project.config.json');
  const configTemplate = JSON.parse(readFileSync(resolve(REPO_ROOT, 'templates/project.config.json'), 'utf8'));
  configTemplate.kit.url = options.url || DEFAULT_URL;
  configTemplate.identity.name = options.identityName || '';
  configTemplate.identity.email = options.identityEmail || '';
  const selected = new Map();
  if (options.skill.length) {
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
      if (selected.has(name) || localNames.includes(name)) continue;
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
  mkdirSync(resolve(root, '.vibe-coding/skills'), { recursive: true });
  if (options.skill.length) {
    syncProjectSkills({ projectRoot: root, kitRoot: resolve(root, '.vibe-coding/kit') });
  } else {
    syncLocalSkills({ root });
  }
  console.log('Initialization complete. No package.json or business dependencies were created.');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = projectRoot(options);
  switch (options.command) {
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
      console.log('Usage: node cli.mjs <init|check|prepare|inspect|skills|worktree> --project-root <path> [options]');
      return;
    default: throw new Error(`Unknown command: ${options.command}`);
  }
}

try { main(); }
catch (error) { console.error(`[vibe-coding-kit] ${error.message}`); process.exitCode = 1; }
