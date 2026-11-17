import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commit, git, makeProject } from './submodule-fixture.mjs';

const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

export function consumerProject() {
  const fixture = makeProject();
  requireExplicitFixtureIdentity(fixture);
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  for (const name of ['cli.mjs']) cpSync(join(repo, name), join(fixture.source, name));
  for (const name of ['src', 'templates']) cpSync(join(repo, name), join(fixture.source, name), { recursive: true });
  cpSync(join(repo, 'skills'), join(fixture.source, 'skills'), { recursive: true });
  const adapterTemplate = join(fixture.source, 'templates/project-adapter.mjs');
  writeFileSync(adapterTemplate, `${readFileSync(adapterTemplate, 'utf8')}\n// older-template-marker\n`);
  fixture.sourceCommit = commit(fixture.source, 'seed runnable kit CLI and templates');
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

export function requireExplicitFixtureIdentity(fixture) {
  for (const repo of [fixture.source, fixture.project]) {
    git(repo, ['config', 'user.useConfigOnly', 'true']);
    const identityFallbackProbe = git(repo, ['commit', '--allow-empty', '-m', 'identity fallback must fail'], { allowFailure: true });
    assert.notEqual(identityFallbackProbe.status, 0, 'bare commit must fail when the isolated fixture has no explicit identity');
  }
}

export function optionalProbeEnv(fixture, env = process.env) {
  const home = join(fixture.root, 'isolated-home');
  const bin = join(fixture.root, 'optional-probe-bin');
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') writeFileSync(codex, '@echo off\necho {"installed":[]}\n');
  else writeFileSync(codex, '#!/bin/sh\nprintf \'{"installed":[]}\\n\'\n', { mode: 0o755 });
  return { ...env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${env.PATH || ''}` };
}

export function run(fixture, more = [], projectRoot = fixture.project) {
  return spawnSync(process.execPath, [cliPath, 'install', '--project-root', projectRoot,
    '--url', pathToFileURL(fixture.source).href, '--identity-name', 'Install User',
    '--identity-email', 'install@example.invalid', '--secrets', 'vault', ...more], { cwd: fixture.project, encoding: 'utf8', env: optionalProbeEnv(fixture) });
}
