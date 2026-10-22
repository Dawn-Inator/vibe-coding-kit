import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { main } from '../../src/worktrees/cli.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

const roots = [];
after(() => {
  cleanupTempDirs();
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function configureCli(fn) {
  const original = {
    cwd: process.cwd(),
    configPath: process.env.WTG_CONFIG_PATH,
    tool: process.env.WTG_WORKTREE_TOOL,
    log: process.env.LIFECYCLE_TEST_LOG,
    failPhase: process.env.LIFECYCLE_FAIL_PHASE,
    mutatePhase: process.env.LIFECYCLE_MUTATE_PHASE,
  };
  const configDir = mkdtempSync(join(tmpdir(), 'kit-lifecycle-cli-config-'));
  roots.push(configDir);
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ identity: { name: 'Lifecycle CI Agent', email: 'lifecycle-agent@example.com' } }));
  process.env.WTG_CONFIG_PATH = configPath;
  process.env.WTG_WORKTREE_TOOL = 'claude';
  try { return await fn(); }
  finally {
    process.chdir(original.cwd);
    for (const [key, value] of [
      ['WTG_CONFIG_PATH', original.configPath],
      ['WTG_WORKTREE_TOOL', original.tool],
      ['LIFECYCLE_TEST_LOG', original.log],
      ['LIFECYCLE_FAIL_PHASE', original.failPhase],
      ['LIFECYCLE_MUTATE_PHASE', original.mutatePhase],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function withCwd(cwd, fn) {
  const original = process.cwd();
  process.chdir(cwd);
  try { return await fn(); }
  finally { process.chdir(original); }
}

function installLifecycleAdapter(project, root) {
  const adapterPath = join(project, 'engineering/automation/vibe-coding/project-adapter.mjs');
  mkdirSync(join(project, 'engineering/automation/vibe-coding'), { recursive: true });
  writeFileSync(adapterPath, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const adapterContract = { schemaVersion: 1, hooks: {
  afterCreate: 'record', beforeCandidate: 'record', verifyCandidate: 'record', beforePush: 'record', afterLand: 'record'
} };
export async function record(context) {
  appendFileSync(process.env.LIFECYCLE_TEST_LOG, JSON.stringify({ phase: context.phase, candidateSha: context.candidateSha, pin: context.pin }) + '\\n');
  if (process.env.LIFECYCLE_FAIL_PHASE === context.phase) throw new Error('fixture hook rejected');
  if (process.env.LIFECYCLE_MUTATE_PHASE === context.phase) writeFileSync(join(context.projectRoot, 'README.md'), 'adapter mutation\\n');
}
`);
  const configPath = join(project, '.vibe-coding/project.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.adapter = 'engineering/automation/vibe-coding/project-adapter.mjs';
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  commit(project, 'configure lifecycle adapter');

  const remote = join(root, 'remote.git');
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(project, ['remote', 'add', 'origin', remote]);
  git(project, ['push', '-u', 'origin', 'main']);
  return { remote, baseSha: git(remote, ['rev-parse', 'refs/heads/main']).stdout.trim() };
}

function makeLifecycleRepo() {
  const fixture = makeProject();
  roots.push(fixture.root);
  const log = join(fixture.root, 'lifecycle.jsonl');
  writeFileSync(log, '');
  const { remote, baseSha } = installLifecycleAdapter(fixture.project, fixture.root);
  return { ...fixture, remote, baseSha, log, worktreeRoot: join(fixture.root, 'worktrees') };
}

async function createWorktree(fixture) {
  const code = await withCwd(fixture.project, () => main([
    'create', '--name', 'lifecycle task', '--worktree-root', fixture.worktreeRoot,
  ]));
  assert.equal(code, 0);
  const listed = git(fixture.project, ['worktree', 'list', '--porcelain']).stdout;
  const path = listed.split(/\n/u).find((line) => line.startsWith('worktree ') && line.includes(fixture.worktreeRoot))?.slice('worktree '.length);
  assert.ok(path, 'create must register and hand out the prepared worktree');
  return path;
}

function assertWorktreeAndBranchRetained(fixture, worktreePath) {
  const listing = git(fixture.project, ['worktree', 'list', '--porcelain']).stdout;
  const block = listing.split(/\n\n/u).find((entry) => entry.startsWith(`worktree ${worktreePath}\n`));
  assert.ok(block, 'failed candidate worktree must remain registered');
  const branch = block.match(/^branch refs\/heads\/(.+)$/mu)?.[1];
  assert.ok(branch, 'failed candidate must keep its branch registered');
  assert.equal(git(fixture.project, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status, 0);
}

test('consumer lifecycle hooks run from begin through finish before the worktree is removed', async () => {
  const fixture = makeLifecycleRepo();
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'finished lifecycle task\n');
    const finish = await withCwd(path, () => main(['finish', '--no-wait']));
    assert.equal(finish, 0);
    return path;
  });
  const phases = readFileSync(fixture.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(phases.map((entry) => entry.phase), ['afterCreate', 'beforeCandidate', 'verifyCandidate', 'beforePush', 'afterLand']);
  for (const entry of phases.filter((item) => item.phase === 'verifyCandidate' || item.phase === 'beforePush')) {
    assert.match(entry.candidateSha, /^[0-9a-f]{40}$/u);
    assert.match(entry.pin, /^[0-9a-f]{40}$/u);
  }
  assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim() === fixture.baseSha, false);
  assert.ok(!git(fixture.project, ['worktree', 'list', '--porcelain']).stdout.includes(`worktree ${worktreePath}\n`));
});

test('a beforePush gate rejection preserves the local candidate and never pushes', async () => {
  const fixture = makeLifecycleRepo();
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'candidate content\n');
    process.env.LIFECYCLE_FAIL_PHASE = 'beforePush';
    const result = await withCwd(path, () => main(['finish', '--no-wait']));
    assert.equal(result, 1);
    return path;
  });
  assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim(), fixture.baseSha);
  assertWorktreeAndBranchRetained(fixture, worktreePath);
});

test('a verifyCandidate mutation invalidates the candidate and prevents push', async () => {
  const fixture = makeLifecycleRepo();
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'candidate content\n');
    process.env.LIFECYCLE_MUTATE_PHASE = 'verifyCandidate';
    const result = await withCwd(path, () => main(['finish', '--no-wait']));
    assert.equal(result, 1);
    return path;
  });
  assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim(), fixture.baseSha);
  assertWorktreeAndBranchRetained(fixture, worktreePath);
});

test('an afterLand gate failure reports the landed push and preserves the worktree', async () => {
  const fixture = makeLifecycleRepo();
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'candidate content\n');
    process.env.LIFECYCLE_FAIL_PHASE = 'afterLand';
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    let result;
    try { result = await withCwd(path, () => main(['finish', '--no-wait'])); }
    finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.match(errors.join('\n'), /push DID land/u);
    return path;
  });
  assert.notEqual(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim(), fixture.baseSha);
  assertWorktreeAndBranchRetained(fixture, worktreePath);
});
