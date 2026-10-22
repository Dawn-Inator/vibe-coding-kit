import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

const cliPath = new URL('../../cli.mjs', import.meta.url);
after(cleanupTempDirs);

function cli(args) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], { encoding: 'utf8' });
}

function freshRegisteredProject() {
  const fixture = makeProject();
  unlinkSync(join(fixture.project, '.vibe-coding/project.config.json'));
  commit(fixture.project, 'remove initial fixture config');
  return fixture;
}

test('init check is read-only, init creates minimal files, and reruns are idempotent', () => {
  const fixture = freshRegisteredProject();
  const args = [
    'init', '--project-root', fixture.project,
    '--url', `file://${fixture.source}`,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ];
  const check = cli([...args, '--check']);
  assert.equal(check.status, 1);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/project.config.json')), false);
  assert.equal(existsSync(join(fixture.project, 'package.json')), false);

  assert.equal(cli(args).status, 0);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.identity.email, 'fixture@example.invalid');
  assert.equal(existsSync(join(fixture.project, 'engineering/automation/vibe-coding/bootstrap.mjs')), true);
  assert.equal(existsSync(join(fixture.project, 'package.json')), false);
  assert.equal(cli([...args, '--check']).status, 0);
  assert.equal(cli(args).status, 0);
});

test('init reports and preserves existing project files that differ from templates', () => {
  const fixture = freshRegisteredProject();
  const adapter = join(fixture.project, 'engineering/automation/vibe-coding/project-adapter.mjs');
  mkdirSync(join(fixture.project, 'engineering/automation/vibe-coding'), { recursive: true });
  writeFileSync(adapter, 'export const localAdapter = true;\n');
  const result = cli([
    'init', '--project-root', fixture.project,
    '--url', `file://${fixture.source}`,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflict .*project-adapter\.mjs/);
  assert.equal(readFileSync(adapter, 'utf8'), 'export const localAdapter = true;\n');
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/project.config.json')), false);
});

test('init merges runtime scripts into an existing JavaScript package without replacing its scripts', () => {
  const fixture = freshRegisteredProject();
  const packagePath = join(fixture.project, 'package.json');
  writeFileSync(packagePath, `${JSON.stringify({ name: 'consumer-app', scripts: { test: 'node app-test.mjs' }, dependencies: { example: '1.0.0' } }, null, 2)}\n`);
  const result = cli([
    'init', '--project-root', fixture.project,
    '--url', `file://${fixture.source}`,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(packageJson.name, 'consumer-app');
  assert.equal(packageJson.scripts.test, 'node app-test.mjs');
  assert.equal(packageJson.scripts['worktree:begin'], 'node engineering/automation/vibe-coding/bootstrap.mjs worktree begin');
  assert.equal(packageJson.scripts['skills:sync'], 'node engineering/automation/vibe-coding/bootstrap.mjs skills sync');
  assert.deepEqual(packageJson.dependencies, { example: '1.0.0' });
});
