#!/usr/bin/env node
// Minimal pre-hydration entrypoint. Once the gitlink exists, safety and
// lifecycle decisions belong to the pinned public runtime.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this list in sync with src/git-environment.mjs. This entrypoint must
// remain self-contained until the pinned kit has been hydrated and validated.
const GIT_REPOSITORY_SELECTION_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
]);

function sanitizedGitEnv(env = process.env) {
  const result = { ...env };
  const blocked = new Set(GIT_REPOSITORY_SELECTION_ENV);
  for (const key of Object.keys(result)) {
    if (blocked.has(key.toUpperCase())) delete result[key];
  }
  return result;
}

function git(root, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: sanitizedGitEnv(env) });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result;
}

function findRoot(start) {
  const result = git(start, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status !== 0) throw new Error('Run bootstrap from inside a Git project');
  return resolve(result.stdout.trim());
}

function isInitializedSubmodule(root, path) {
  const target = resolve(root, path);
  // `git -C` requires the directory to exist. A cold clone may have only the
  // gitlink in its index, so treat an absent or empty target as uninitialized.
  let info;
  try { info = lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  const result = git(target, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  return result.status === 0 && resolve(result.stdout.trim()) === target;
}

function assertHydrationTargetSafe(root, path) {
  const target = resolve(root, path);
  let info;
  try { info = lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Cannot hydrate kit into ${path}: target exists and is not a directory; move it aside and retry`);
  }
  if (isInitializedSubmodule(root, path)) return;
  if (readdirSync(target).length > 0) {
    throw new Error(`Cannot hydrate kit into non-empty uninitialized directory ${path}; preserve or move its contents aside, then retry`);
  }
}

function hydrationMarkerPath(root) {
  const path = git(root, ['rev-parse', '--git-path', 'vibe-coding-kit-bootstrap.json']).stdout.trim();
  return resolve(root, path);
}

function targetPin(root, path) {
  const result = git(root, ['ls-files', '--stage', '--', path], { allowFailure: true });
  const match = /^160000 ([0-9a-f]+) 0\t/m.exec(result.stdout);
  if (result.status !== 0 || !match) throw new Error(`Cannot determine the staged gitlink pin for ${path}`);
  return match[1];
}

function assertOfflinePinCached(root, path) {
  const pin = targetPin(root, path);
  const gitPath = git(root, ['rev-parse', '--git-path', 'modules/vibe-coding-kit']).stdout.trim();
  const modulePath = resolve(root, gitPath);
  if (!existsSync(modulePath)) {
    throw new Error(`Offline kit prepare requires the registered module cache at ${modulePath}; fetch or initialize the kit while online first`);
  }
  const object = git(modulePath, ['cat-file', '-e', `${pin}^{commit}`], {
    allowFailure: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  if (object.status !== 0) {
    throw new Error(`Offline kit prepare cannot find pinned commit ${pin} in the registered module cache; fetch or initialize the kit while online first`);
  }
}

function readHydrationMarker(root, path) {
  const markerPath = hydrationMarkerPath(root);
  if (!existsSync(markerPath)) return null;
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); }
  catch { throw new Error('A previous bootstrap prepare left an invalid recovery marker; inspect Git state before retrying'); }
  if (marker?.path !== path || marker?.pin !== targetPin(root, path)) {
    throw new Error('A previous bootstrap prepare marker does not match the current kit pin; inspect Git state before retrying');
  }
  return markerPath;
}

function hydrate(root, path, allowNetwork, { recoverIncomplete = false } = {}) {
  assertHydrationTargetSafe(root, path);
  const marker = readHydrationMarker(root, path);
  if (recoverIncomplete && isInitializedSubmodule(root, path)) {
    const status = git(resolve(root, path), ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], { allowFailure: true });
    const interruptedCheckout = status.stdout.trim().split(/\r?\n/).filter(Boolean).every((line) => /^D  /.test(line));
    if (!marker || status.status !== 0 || !interruptedCheckout) {
      throw new Error(`Cannot recover incomplete initialized kit ${path}: no matching bootstrap recovery marker or the checkout contains other changes; inspect Git state before retrying`);
    }
  }
  const markerPath = marker || hydrationMarkerPath(root);
  if (!marker) writeFileSync(markerPath, `${JSON.stringify({ path, pin: targetPin(root, path), startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  const updateArgs = ['submodule', 'update', '--init', '--checkout'];
  if (!allowNetwork) {
    assertOfflinePinCached(root, path);
    updateArgs.push('--no-fetch');
  }
  updateArgs.push('--', path);
  try {
    git(root, updateArgs, {
      env: allowNetwork ? process.env : {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
    });
  } catch (error) {
    const mode = allowNetwork ? 'with network access' : 'offline';
    throw new Error(`Kit hydration failed ${mode}; no local files were removed. Resolve the reported Git error, then rerun bootstrap prepare. Original error: ${error.message}`);
  }
  if (existsSync(resolve(root, path, 'src/dependencies/submodule.mjs'))) unlinkSync(markerPath);
}

async function main() {
  const root = findRoot(process.cwd());
  const configPath = resolve(root, '.vibe-coding/project.config.json');
  if (!existsSync(configPath)) throw new Error('Required .vibe-coding/project.config.json is missing');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || config.kit?.path !== '.vibe-coding/kit' || !config.kit?.url) {
    throw new Error('Invalid project config: expected schemaVersion 1 and kit path .vibe-coding/kit');
  }
  const section = git(root, ['config', '-f', '.gitmodules', '--get', 'submodule.vibe-coding-kit.path'], { allowFailure: true });
  if (section.status !== 0 || section.stdout.trim() !== config.kit.path) throw new Error('The configured kit path is not registered in .gitmodules');
  const url = git(root, ['config', '-f', '.gitmodules', '--get', 'submodule.vibe-coding-kit.url']).stdout.trim();
  if (url !== config.kit.url) throw new Error('The .gitmodules URL does not match project config');

  const [command = 'prepare', ...args] = process.argv.slice(2);
  const allowNetwork = !args.includes('--offline');
  const kitRoot = resolve(root, config.kit.path);
  const runtimePath = resolve(kitRoot, 'src/dependencies/submodule.mjs');
  if (command === 'check') {
    if (!isInitializedSubmodule(root, config.kit.path) || !existsSync(runtimePath)) {
      throw new Error('The pinned kit checkout is not initialized; run bootstrap prepare first');
    }
    const { checkKit } = await import(pathToFileURL(runtimePath).href);
    const result = checkKit({ projectRoot: root });
    console.log(`vibe-coding-kit ${result.commit} check OK`);
    return;
  }

  if (command === 'prepare') {
    if (!isInitializedSubmodule(root, config.kit.path)) {
      hydrate(root, config.kit.path, allowNetwork);
    } else if (!existsSync(runtimePath)) {
      hydrate(root, config.kit.path, allowNetwork, { recoverIncomplete: true });
    }
    if (!existsSync(runtimePath)) throw new Error('The pinned kit checkout is incomplete; rerun bootstrap prepare');
    const { prepareKit, checkKit } = await import(pathToFileURL(runtimePath).href);
    await prepareKit({ projectRoot: root, allowNetwork });
    const result = checkKit({ projectRoot: root });
    console.log(`vibe-coding-kit ${result.commit} prepare OK`);
    return;
  }

  if (!['skills', 'worktree', 'worktrees'].includes(command)) throw new Error(`Unknown bootstrap command: ${command}`);
  if (!isInitializedSubmodule(root, config.kit.path)) {
    hydrate(root, config.kit.path, allowNetwork);
  } else if (!existsSync(runtimePath)) {
    hydrate(root, config.kit.path, allowNetwork, { recoverIncomplete: true });
  }
  if (!existsSync(runtimePath)) throw new Error('The pinned kit checkout is incomplete; rerun bootstrap prepare');
  const { prepareKit } = await import(pathToFileURL(runtimePath).href);
  await prepareKit({ projectRoot: root, allowNetwork });
  const delegateArgs = [resolve(kitRoot, 'cli.mjs'), command, ...args.filter((argument) => argument !== '--offline'), '--project-root', root];
  const delegated = spawnSync(process.execPath, delegateArgs, { cwd: root, stdio: 'inherit' });
  if (delegated.error) throw delegated.error;
  process.exitCode = delegated.status ?? 1;
}

try { await main(); }
catch (error) { console.error(`[vibe-coding-kit bootstrap] ${error.message}`); process.exitCode = 1; }
