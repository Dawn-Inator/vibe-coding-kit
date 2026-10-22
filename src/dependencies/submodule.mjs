import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CONFIG_PATH = '.vibe-coding/project.config.json';
const DEFAULT_KIT_PATH = '.vibe-coding/kit';

function git(projectRoot, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', env });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function readProjectConfig(projectRoot) {
  const path = join(projectRoot, CONFIG_PATH);
  if (!existsSync(path)) throw new Error(`Required project config is missing: ${CONFIG_PATH}`);
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Invalid ${CONFIG_PATH}: ${error.message}`); }
  if (config?.schemaVersion !== 1) throw new Error(`${CONFIG_PATH} must declare schemaVersion: 1`);
  if (config?.kit?.path !== DEFAULT_KIT_PATH) throw new Error(`${CONFIG_PATH} kit.path must be ${DEFAULT_KIT_PATH}`);
  if (typeof config?.kit?.url !== 'string' || !config.kit.url.trim()) throw new Error(`${CONFIG_PATH} kit.url is required`);
  if (typeof config?.adapter !== 'string' || !config.adapter.trim()) throw new Error(`${CONFIG_PATH} adapter is required`);
  if (!config?.identity || !['name', 'email'].every((key) => typeof config.identity[key] === 'string' && config.identity[key].trim())) {
    throw new Error(`${CONFIG_PATH} identity.name and identity.email are required`);
  }
  return config;
}

function readSubmodule(projectRoot, expectedPath) {
  const path = join(projectRoot, '.gitmodules');
  if (!existsSync(path)) return null;
  const raw = git(projectRoot, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { allowFailure: true });
  if (raw.status === 1 && !raw.stdout.trim() && !raw.stderr.trim()) return null;
  if (raw.status !== 0) throw new Error(`Could not parse .gitmodules: ${raw.stderr.trim()}`);
  const sections = new Map();
  for (const line of raw.stdout.split(/\r?\n/).filter(Boolean)) {
    const splitAt = line.indexOf(' ');
    if (splitAt < 0) continue;
    const key = line.slice(0, splitAt);
    const value = line.slice(splitAt + 1);
    const match = /^submodule\.(.+)\.(path|url)$/.exec(key);
    if (!match) continue;
    const record = sections.get(match[1]) || {};
    record.name = match[1];
    record[match[2]] = value;
    sections.set(match[1], record);
  }
  const matches = [...sections.values()].filter((item) => item.path === expectedPath);
  if (matches.length > 1) throw new Error(`More than one .gitmodules entry registers ${expectedPath}`);
  return matches[0] || null;
}

function gitlinkAt(projectRoot, revision, path) {
  const args = revision === 'INDEX'
    ? ['ls-files', '--stage', '--', path]
    : ['ls-tree', revision, '--', path];
  const { stdout } = git(projectRoot, args, { allowFailure: revision === 'INDEX' });
  if (!stdout.trim()) return null;
  const match = revision === 'INDEX'
    ? /^160000 ([0-9a-f]+) 0\t/.exec(stdout.trim())
    : /^160000 commit ([0-9a-f]+)\t/.exec(stdout.trim());
  return match?.[1] || null;
}

function targetPin(projectRoot, path) {
  const indexPin = gitlinkAt(projectRoot, 'INDEX', path);
  if (indexPin) return indexPin;
  const stagedChange = git(projectRoot, ['diff', '--cached', '--quiet', 'HEAD', '--', path], { allowFailure: true });
  if (stagedChange.status === 1) throw new Error(`The index has a staged change that removes or replaces ${path}, so its target pin is ambiguous`);
  if (stagedChange.status !== 0) throw new Error(`Could not determine the staged gitlink state for ${path}`);
  return gitlinkAt(projectRoot, 'HEAD', path);
}

function assertDeclaration(projectRoot, config, entry) {
  if (!entry) return;
  if (entry.url !== config.kit.url) {
    throw new Error(`Submodule URL mismatch for ${config.kit.path}: .gitmodules has ${entry.url}, project config has ${config.kit.url}`);
  }
}

function inspect(projectRoot, { requireConfig = true } = {}) {
  const root = resolve(projectRoot);
  const configExists = existsSync(join(root, CONFIG_PATH));
  const config = configExists && requireConfig ? readProjectConfig(root) : null;
  const entry = readSubmodule(root, DEFAULT_KIT_PATH);
  if (entry && !configExists && requireConfig) throw new Error(`Required project config is missing: ${CONFIG_PATH}`);
  if (!entry && configExists) throw new Error(`Project config declares kit access, but .gitmodules has no ${DEFAULT_KIT_PATH} registration`);
  if (!entry) return { applicable: false, path: join(root, DEFAULT_KIT_PATH), commit: null, initialized: false };
  if (configExists && !config && requireConfig) throw new Error(`Could not load required ${CONFIG_PATH}`);
  if (config) assertDeclaration(root, config, entry);
  const commit = targetPin(root, DEFAULT_KIT_PATH);
  if (!commit) throw new Error(`No gitlink pin is recorded for ${DEFAULT_KIT_PATH} in the index or HEAD tree`);
  const path = join(root, DEFAULT_KIT_PATH);
  const initialized = existsSync(join(path, '.git'));
  return { applicable: true, path, commit, initialized };
}

function workingTreeSafety(submodulePath) {
  const status = git(submodulePath, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], { allowFailure: true });
  if (status.status !== 0) throw new Error('Cannot establish submodule working-tree cleanliness');
  if (status.stdout.trim()) throw new Error(`Refusing to change dirty submodule ${submodulePath}:\n${status.stdout.trim()}`);
  const refs = git(submodulePath, ['for-each-ref', '--format=%(refname) %(objectname)'], { allowFailure: true });
  if (refs.status !== 0) throw new Error('Cannot inspect local submodule refs');
  const remotes = git(submodulePath, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], { allowFailure: true });
  if (remotes.status !== 0) throw new Error('Cannot inspect remote-tracking submodule refs');
  const remoteRefs = remotes.stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [ref, object] = line.split(' ');
    if (ref.startsWith('refs/remotes/') || ref === 'refs/stash' || ref.startsWith('refs/stash/')) continue;
    let allowedRemoteRefs = remoteRefs;
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length);
      const remote = git(submodulePath, ['config', '--get', `branch.${branch}.remote`], { allowFailure: true });
      const merge = git(submodulePath, ['config', '--get', `branch.${branch}.merge`], { allowFailure: true });
      if (remote.status !== 0 || merge.status !== 0 || !remote.stdout.trim() || !merge.stdout.trim()) {
        throw new Error(`Refusing to change submodule with a local branch lacking an upstream: ${ref}`);
      }
      const upstream = `refs/remotes/${remote.stdout.trim()}/${merge.stdout.trim().replace(/^refs\/heads\//, '')}`;
      allowedRemoteRefs = remoteRefs.includes(upstream) ? [upstream] : [];
    }
    const knownUpstream = allowedRemoteRefs.some((remoteRef) =>
      git(submodulePath, ['merge-base', '--is-ancestor', object, remoteRef], { allowFailure: true }).status === 0);
    if (!knownUpstream) throw new Error(`Refusing to change submodule with a local-only ref: ${ref}`);
  }
  const unreachable = git(submodulePath, ['fsck', '--no-reflogs', '--unreachable'], { allowFailure: true });
  if (unreachable.status !== 0) throw new Error('Cannot prove that the kit object database has no private objects');
  if (unreachable.stdout.trim()) throw new Error(`Refusing to change submodule with unreachable objects:\n${unreachable.stdout.trim()}`);
  const stash = git(submodulePath, ['for-each-ref', '--format=%(refname)', 'refs/stash'], { allowFailure: true });
  if (stash.status !== 0) throw new Error('Cannot inspect submodule stash state');
  if (stash.stdout.trim()) throw new Error('Refusing to change submodule with a stash reference');
}

export function inspectKit({ projectRoot } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  return inspect(projectRoot);
}

export function getKitRegistration({ projectRoot, path = DEFAULT_KIT_PATH } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const entry = readSubmodule(resolve(projectRoot), path);
  if (!entry) throw new Error(`No .gitmodules entry registers ${path}`);
  return { name: entry.name, path: entry.path, url: entry.url };
}

export function checkKit({ projectRoot } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const result = inspect(projectRoot);
  if (!result.applicable) return result;
  if (!result.initialized) throw new Error(`Kit submodule is not initialized: ${result.path}; run the project bootstrap prepare command`);
  const current = git(result.path, ['rev-parse', 'HEAD']).stdout.trim();
  if (current !== result.commit) throw new Error(`Kit checkout ${current} does not match parent gitlink ${result.commit}`);
  workingTreeSafety(result.path);
  return result;
}

export function prepareKit({ projectRoot, allowNetwork = true } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const root = resolve(projectRoot);
  const target = inspect(root);
  if (!target.applicable || target.initialized) {
    if (target.initialized) {
      workingTreeSafety(target.path);
      const current = git(target.path, ['rev-parse', 'HEAD']).stdout.trim();
      if (current === target.commit) return target;
    }
    if (!target.applicable) return target;
  }
  const args = ['submodule', 'update', '--init', '--checkout'];
  if (!allowNetwork) args.push('--no-fetch');
  args.push('--', DEFAULT_KIT_PATH);
  git(root, args, { env: allowNetwork ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const prepared = inspect(root);
  if (!prepared.initialized) throw new Error(`Submodule prepare completed without initializing ${prepared.path}`);
  const actual = git(prepared.path, ['rev-parse', 'HEAD']).stdout.trim();
  if (actual !== prepared.commit) throw new Error(`Prepared kit commit ${actual} does not match parent gitlink ${prepared.commit}`);
  workingTreeSafety(prepared.path);
  return { ...prepared, initialized: true };
}

export function assertKitSafeToRemove({ projectRoot } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const root = resolve(projectRoot);
  const result = inspect(root);
  if (!result.applicable) return result;
  if (!result.initialized) throw new Error(`Cannot prove safety for uninitialized kit path ${result.path}`);
  const committedPin = gitlinkAt(root, 'HEAD', DEFAULT_KIT_PATH);
  const stagedPin = gitlinkAt(root, 'INDEX', DEFAULT_KIT_PATH);
  if (!committedPin || stagedPin !== committedPin || committedPin !== result.commit) {
    throw new Error('Cannot remove kit: parent HEAD and index do not agree on the registered gitlink');
  }
  workingTreeSafety(result.path);
  const actual = git(result.path, ['rev-parse', 'HEAD']).stdout.trim();
  if (actual !== committedPin) throw new Error(`Cannot remove kit at ${actual}; parent gitlink is ${committedPin}`);
  const nested = git(result.path, ['submodule', 'status', '--recursive'], { allowFailure: true });
  if (nested.status !== 0 || nested.stdout.trim()) throw new Error('Cannot prove safety for nested submodule state');
  return { ...result, commit: committedPin, safeToRemove: true };
}

export { readProjectConfig };
