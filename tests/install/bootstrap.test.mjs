import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

after(cleanupTempDirs);

test('cold bootstrap rehydrates only an uninitialized child even with unrelated dirty parent files', () => {
  const fixture = makeProject();
  const runtime = join(fixture.source, 'src/dependencies/submodule.mjs');
  mkdirSync(join(fixture.source, 'src/dependencies'), { recursive: true });
  writeFileSync(runtime, `export function prepareKit(){return {applicable:true,path:'kit',commit:'fixture',initialized:true}}\nexport function checkKit(){return {applicable:true,path:'kit',commit:'fixture',initialized:true}}\n`);
  const commitWithRuntime = commit(fixture.source, 'add minimal runtime for bootstrap fixture');
  const child = join(fixture.project, '.vibe-coding/kit');
  git(child, ['fetch', 'origin']);
  git(child, ['checkout', '--detach', commitWithRuntime]);
  git(fixture.project, ['add', '.vibe-coding/kit']);
  writeFileSync(join(fixture.project, '.vibe-coding/project.config.json'), `${JSON.stringify({
    schemaVersion: 1,
    kit: { path: '.vibe-coding/kit', url: `file://${fixture.source}` },
    adapter: 'project-adapter.mjs',
    identity: { name: 'Fixture User', email: 'fixture@example.invalid' },
  })}\n`);
  const projectPin = commit(fixture.project, 'record runtime pin and config');
  assert.equal(git(fixture.project, ['rev-parse', 'HEAD']).stdout.trim(), projectPin);
  git(fixture.project, ['submodule', 'deinit', '-f', '--', '.vibe-coding/kit']);
  writeFileSync(join(fixture.project, 'unrelated-parent-change.txt'), 'keep me\n');
  const bootstrapPath = join(fixture.project, 'engineering/automation/vibe-coding/bootstrap.mjs');
  mkdirSync(join(fixture.project, 'engineering/automation/vibe-coding'), { recursive: true });
  const template = new URL('../../templates/bootstrap.mjs', import.meta.url);
  writeFileSync(bootstrapPath, readFileSync(template, 'utf8'));
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const result = spawnSync(process.execPath, [bootstrapPath, 'prepare', '--offline'], { cwd: fixture.project, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/kit/src/dependencies/submodule.mjs')), true);
  assert.equal(readFileSync(join(fixture.project, 'unrelated-parent-change.txt'), 'utf8'), 'keep me\n');
});
