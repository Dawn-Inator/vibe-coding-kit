import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

const cliPath = new URL('../../cli.mjs', import.meta.url);
const cliFilePath = fileURLToPath(cliPath);
after(cleanupTempDirs);

function cli(args) {
  return spawnSync(process.execPath, [cliFilePath, ...args], { encoding: 'utf8' });
}

function freshRegisteredProject() {
  const fixture = makeProject();
  const commonSkills = fileURLToPath(new URL('../../skills', import.meta.url));
  for (const entry of readdirSync(commonSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(fixture.source, 'skills', entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.fixture'), 'synthetic skill name for init coverage\n');
  }
  commit(fixture.source, 'seed synthetic skill source names');
  const skillTree = git(fixture.source, ['rev-parse', 'HEAD']).stdout.trim();
  git(fixture.project, ['-C', '.vibe-coding/kit', 'fetch', 'origin', skillTree]);
  git(fixture.project, ['-C', '.vibe-coding/kit', 'checkout', '--detach', skillTree]);
  commit(fixture.project, 'pin synthetic skill source names');
  unlinkSync(join(fixture.project, '.vibe-coding/project.config.json'));
  commit(fixture.project, 'remove initial fixture config');
  return fixture;
}

test('init check is read-only, init creates minimal files, and reruns are idempotent', () => {
  const fixture = freshRegisteredProject();
  const args = [
    'init', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ];
  const check = cli([...args, '--check']);
  assert.equal(check.status, 1);
  assert.equal(existsSync(join(fixture.project, '.vibe-coding/project.config.json')), false);
  assert.equal(existsSync(join(fixture.project, '.gitignore')), false);
  assert.equal(existsSync(join(fixture.project, 'package.json')), false);

  const initialized = cli(args);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.identity.email, 'fixture@example.invalid');
  assert.equal(config.skills.mirrorPolicy, 'local');
  const gitignore = readFileSync(join(fixture.project, '.gitignore'), 'utf8');
  assert.match(gitignore, /BEGIN vibe-coding-kit local skill mirrors[\s\S]*\/.agents\/skills\/[\s\S]*\/.claude\/skills\/[\s\S]*END vibe-coding-kit local skill mirrors/);
  const checkIgnored = (path) => git(fixture.project, ['check-ignore', '-q', path], { allowFailure: true }).status === 0;
  assert.equal(checkIgnored('.agents/skills/example/SKILL.md'), true);
  assert.equal(checkIgnored('.claude/skills/example/SKILL.md'), true);
  assert.equal(checkIgnored('.vibe-coding/skills/example/SKILL.md'), false);
  assert.equal(checkIgnored('AGENTS.md'), false);
  assert.equal(checkIgnored('CLAUDE.md'), false);
  assert.equal(existsSync(join(fixture.project, 'engineering/automation/vibe-coding/bootstrap.mjs')), true);
  assert.equal(existsSync(join(fixture.project, 'package.json')), false);
  assert.ok(Object.keys(config.skills.skills).length > 0);
  assert.ok(Object.values(config.skills.skills).every((skill) => skill.mode === 'exclude' && skill.rationale));
  assert.equal(cli(['skills', 'check', '--project-root', fixture.project]).status, 0);
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
    '--url', pathToFileURL(fixture.source).href,
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
    '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(packageJson.name, 'consumer-app');
  assert.equal(packageJson.scripts.test, 'node app-test.mjs');
  assert.equal(packageJson.scripts['worktree:begin'], 'node engineering/automation/vibe-coding/bootstrap.mjs worktree begin');
  assert.equal(packageJson.scripts['skills:sync'], 'node engineering/automation/vibe-coding/bootstrap.mjs skills sync');
  assert.equal(packageJson.scripts['worktree:status'], 'node engineering/automation/vibe-coding/bootstrap.mjs worktree status');
  assert.equal(packageJson.scripts['worktree:cleanup'], 'node engineering/automation/vibe-coding/bootstrap.mjs worktree cleanup');
  assert.equal(packageJson.scripts['worktree:sync-primary'], 'node engineering/automation/vibe-coding/bootstrap.mjs worktree sync-primary');
  assert.deepEqual(packageJson.dependencies, { example: '1.0.0' });
});

test('init merges only its managed mirror ignore block and preserves existing ignore bytes', () => {
  const fixture = freshRegisteredProject();
  const ignorePath = join(fixture.project, '.gitignore');
  const original = '# consumer ignore rules\nnode_modules/\nlocal-output/\n';
  writeFileSync(ignorePath, original);
  const args = [
    'init', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
  ];
  const result = cli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const merged = readFileSync(ignorePath, 'utf8');
  assert.ok(merged.startsWith(original));
  assert.equal((merged.match(/BEGIN vibe-coding-kit local skill mirrors/g) || []).length, 1);
  assert.match(merged, /node_modules\//);
  assert.match(merged, /local-output\//);
  assert.equal(cli([...args, '--check']).status, 0);
  assert.equal(cli(args).status, 0);
  assert.equal(readFileSync(ignorePath, 'utf8'), merged);
});

test('init tracked mirror policy omits its managed ignore block and records the policy', () => {
  const fixture = freshRegisteredProject();
  const result = cli([
    'init', '--project-root', fixture.project,
    '--url', pathToFileURL(fixture.source).href,
    '--identity-name', 'Fixture User',
    '--identity-email', 'fixture@example.invalid',
    '--mirror-policy', 'tracked',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8'));
  assert.equal(config.skills.mirrorPolicy, 'tracked');
  assert.equal(existsSync(join(fixture.project, '.gitignore')), false);
  assert.notEqual(git(fixture.project, ['check-ignore', '-q', '.agents/skills/example/SKILL.md'], { allowFailure: true }).status, 0);
});

test('root worktree command checks and prepares the configured kit before dispatch', () => {
  const fixture = makeProject();
  const result = cli(['worktree', 'status', '--project-root', fixture.project]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /primary|worktree|branch/iu);
});
