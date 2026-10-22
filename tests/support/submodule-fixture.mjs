import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fixtureGitIdentityArgs, isolatedFixtureGitEnv } from './isolated-git-env.mjs';
import { mkdtempTracked } from './temp-dirs.mjs';

export const fixtureEnv = isolatedFixtureGitEnv();
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
process.env.GIT_CONFIG_VALUE_0 = 'always';

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, env: fixtureEnv, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function commit(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, [...fixtureGitIdentityArgs(), 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

export function makeProject() {
  const root = mkdtempTracked('vibe-kit-submodule-test-');
  const source = join(root, 'source');
  const project = join(root, 'project');
  mkdirSync(source);
  mkdirSync(project);
  mkdirSync(join(source, 'skills'));
  writeFileSync(join(source, 'skills', '.gitkeep'), '');
  git(source, ['init', '-q', '--initial-branch=main']);
  writeFileSync(join(source, 'README.md'), 'public kit fixture\n');
  writeFileSync(join(source, '.gitignore'), 'ignored.txt\n');
  const sourceCommit = commit(source, 'source initial');
  git(project, ['init', '-q', '--initial-branch=main']);
  writeFileSync(join(project, 'README.md'), 'consumer fixture\n');
  commit(project, 'project initial');
  git(project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'vibe-coding-kit', `file://${source}`, '.vibe-coding/kit']);
  const configPath = join(project, '.vibe-coding/project.config.json');
  mkdirSync(join(project, '.vibe-coding'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    kit: { path: '.vibe-coding/kit', url: `file://${source}` },
    adapter: 'engineering/automation/vibe-coding/project-adapter.mjs',
    identity: { name: 'Fixture User', email: 'fixture@example.invalid' },
  })}\n`);
  const parentCommit = commit(project, 'register kit and config');
  return { root, source, project, sourceCommit, parentCommit };
}
