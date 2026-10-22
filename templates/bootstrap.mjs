#!/usr/bin/env node
// Minimal pre-hydration entrypoint. Once the gitlink exists, safety and
// lifecycle decisions belong to the pinned public runtime.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: process.env });
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
  const result = git(target, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  return result.status === 0 && resolve(result.stdout.trim()) === target;
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
    const { checkKit } = await import(runtimePath);
    const result = checkKit({ projectRoot: root });
    console.log(`vibe-coding-kit ${result.commit} check OK`);
    return;
  }

  if (command === 'prepare') {
    if (!isInitializedSubmodule(root, config.kit.path)) {
      const updateArgs = ['submodule', 'update', '--init', '--checkout'];
      if (!allowNetwork) updateArgs.push('--no-fetch');
      updateArgs.push('--', config.kit.path);
      git(root, updateArgs);
    } else if (!existsSync(runtimePath)) {
      throw new Error('The initialized kit checkout is incomplete; refusing to update it without its safety runtime');
    }
    if (!existsSync(runtimePath)) throw new Error('The pinned kit checkout is incomplete; rerun bootstrap prepare');
    const { prepareKit, checkKit } = await import(runtimePath);
    await prepareKit({ projectRoot: root, allowNetwork });
    const result = checkKit({ projectRoot: root });
    console.log(`vibe-coding-kit ${result.commit} prepare OK`);
    return;
  }

  if (!['skills', 'worktree', 'worktrees'].includes(command)) throw new Error(`Unknown bootstrap command: ${command}`);
  if (!isInitializedSubmodule(root, config.kit.path)) {
    const updateArgs = ['submodule', 'update', '--init', '--checkout'];
    if (!allowNetwork) updateArgs.push('--no-fetch');
    updateArgs.push('--', config.kit.path);
    git(root, updateArgs);
  } else if (!existsSync(runtimePath)) {
    throw new Error('The initialized kit checkout is incomplete; refusing to update it without its safety runtime');
  }
  if (!existsSync(runtimePath)) throw new Error('The pinned kit checkout is incomplete; rerun bootstrap prepare');
  const { prepareKit } = await import(runtimePath);
  await prepareKit({ projectRoot: root, allowNetwork });
  const delegateArgs = [resolve(kitRoot, 'cli.mjs'), command, ...args.filter((argument) => argument !== '--offline'), '--project-root', root];
  const delegated = spawnSync(process.execPath, delegateArgs, { cwd: root, stdio: 'inherit' });
  if (delegated.error) throw delegated.error;
  process.exitCode = delegated.status ?? 1;
}

try { await main(); }
catch (error) { console.error(`[vibe-coding-kit bootstrap] ${error.message}`); process.exitCode = 1; }
