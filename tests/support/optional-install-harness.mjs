import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commit, git, makeProject } from './submodule-fixture.mjs';

// Shared real-subprocess harness for the optional-component install/configure suites.
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const cliPath = join(repoRoot, 'cli.mjs');

export function optionalProbeEnv(fixture, env = process.env) {
  const cleanEnv = { ...env };
  const codexProbeFails = cleanEnv.KIT_OPTIONAL_PROBE_CODEX_FAIL === '1';
  delete cleanEnv.KIT_OPTIONAL_PROBE_CODEX_FAIL;
  const home = env.HOME && env.HOME !== process.env.HOME ? env.HOME : join(fixture.root, 'isolated-home');
  const bin = join(fixture.root, 'optional-probe-bin');
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') writeFileSync(codex, codexProbeFails ? '@echo off\nexit /b 9\n' : '@echo off\necho {"installed":[]}\n');
  else writeFileSync(codex, codexProbeFails ? '#!/bin/sh\nexit 9\n' : '#!/bin/sh\nprintf \'{"installed":[]}\\n\'\n', { mode: 0o755 });
  return { ...cleanEnv, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${env.PATH || ''}` };
}

export function optionalConsumer() {
  const fixture = makeProject();
  for (const name of ['cli.mjs']) cpSync(join(repoRoot, name), join(fixture.source, name));
  for (const name of ['src', 'templates', 'skills']) cpSync(join(repoRoot, name), join(fixture.source, name), { recursive: true });
  const optionalRoot = join(repoRoot, 'optional');
  const excludedOptionalDirectories = new Set(['.git', '.tmp', '.cache', '.turbo', 'node_modules', 'dist', 'build', 'coverage', 'target', '.next', 'out']);
  cpSync(optionalRoot, join(fixture.source, 'optional'), {
    recursive: true,
    filter: (source) => !source.slice(optionalRoot.length).split(/[\\/]+/).some((part) => excludedOptionalDirectories.has(part)),
  });
  commit(fixture.source, 'seed runnable kit with optional catalog');
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  git(fixture.project, ['rm', '-f', '.vibe-coding/kit']);
  git(fixture.project, ['rm', '-f', '.vibe-coding/project.config.json']);
  git(fixture.project, ['config', '-f', '.gitmodules', '--remove-section', 'submodule.vibe-coding-kit'], { allowFailure: true });
  rmSync(join(fixture.project, '.gitmodules'), { force: true });
  rmSync(join(fixture.project, '.vibe-coding/kit'), { recursive: true, force: true });
  rmSync(join(fixture.project, '.git/modules/vibe-coding-kit'), { recursive: true, force: true });
  commit(fixture.project, 'remove fixture kit registration');
  return fixture;
}

export function install(fixture, options = [], env = process.env) {
  return spawnSync(process.execPath, [cliPath, 'install', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid', ...options], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture, env) });
}

export function configure(fixture, category, env = process.env) {
  return spawnSync(process.execPath, [cliPath, 'optional', 'configure', '--project-root', fixture.project,
    '--optional', category], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture, env) });
}
