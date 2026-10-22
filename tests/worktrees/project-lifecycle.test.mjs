import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { main } from '../../src/worktrees/cli.mjs';
import { isPathWithin, samePathIdentity } from '../../src/lib/path-identity.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { commit, git, makeProject } from '../support/submodule-fixture.mjs';

const roots = [];
after(() => {
  cleanupTempDirs();
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function configureCli(fn, { maxHoldMs } = {}) {
  const original = {
    cwd: process.cwd(),
    configPath: process.env.WTG_CONFIG_PATH,
    tool: process.env.WTG_WORKTREE_TOOL,
    log: process.env.LIFECYCLE_TEST_LOG,
    failPhase: process.env.LIFECYCLE_FAIL_PHASE,
    mutatePhase: process.env.LIFECYCLE_MUTATE_PHASE,
    hangPhase: process.env.LIFECYCLE_HANG_PHASE,
    gitConfigCount: process.env.GIT_CONFIG_COUNT,
    gitConfigKey: process.env.GIT_CONFIG_KEY_0,
    gitConfigValue: process.env.GIT_CONFIG_VALUE_0,
  };
  const configDir = mkdtempSync(join(tmpdir(), 'kit-lifecycle-cli-config-'));
  roots.push(configDir);
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    identity: { name: 'Lifecycle CI Agent', email: 'lifecycle-agent@example.com' },
    ...(maxHoldMs ? { queue: { maxHoldMs } } : {}),
  }));
  process.env.WTG_CONFIG_PATH = configPath;
  process.env.WTG_WORKTREE_TOOL = 'claude';
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
  process.env.GIT_CONFIG_VALUE_0 = 'always';
  try { return await fn(); }
  finally {
    process.chdir(original.cwd);
    for (const [key, value] of [
      ['WTG_CONFIG_PATH', original.configPath],
      ['WTG_WORKTREE_TOOL', original.tool],
      ['LIFECYCLE_TEST_LOG', original.log],
      ['LIFECYCLE_FAIL_PHASE', original.failPhase],
      ['LIFECYCLE_MUTATE_PHASE', original.mutatePhase],
      ['LIFECYCLE_HANG_PHASE', original.hangPhase],
      ['GIT_CONFIG_COUNT', original.gitConfigCount],
      ['GIT_CONFIG_KEY_0', original.gitConfigKey],
      ['GIT_CONFIG_VALUE_0', original.gitConfigValue],
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

function installLifecycleAdapter(project, root, hookPhases = ['afterCreate', 'beforeCandidate', 'verifyCandidate', 'beforePush', 'afterLand']) {
  const adapterPath = join(project, 'engineering/automation/vibe-coding/project-adapter.mjs');
  mkdirSync(join(project, 'engineering/automation/vibe-coding'), { recursive: true });
  const hooks = Object.fromEntries(hookPhases.map((phase) => [phase, 'record']));
  writeFileSync(adapterPath, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const adapterContract = { schemaVersion: 1, hooks: ${JSON.stringify(hooks)} };
export async function record(context) {
  appendFileSync(process.env.LIFECYCLE_TEST_LOG, JSON.stringify({ phase: context.phase, pid: process.pid, candidateSha: context.candidateSha, pin: context.pin }) + '\\n');
  if (process.env.LIFECYCLE_FAIL_PHASE === context.phase) throw new Error('fixture hook rejected');
  if (process.env.LIFECYCLE_MUTATE_PHASE === context.phase) writeFileSync(join(context.projectRoot, 'README.md'), 'adapter mutation\\n');
  if (process.env.LIFECYCLE_HANG_PHASE === context.phase) await new Promise(() => {});
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

function makeLifecycleRepo({ hookPhases } = {}) {
  const fixture = makeProject();
  roots.push(fixture.root);
  const log = join(fixture.root, 'lifecycle.jsonl');
  writeFileSync(log, '');
  const { remote, baseSha } = installLifecycleAdapter(fixture.project, fixture.root, hookPhases);
  return { ...fixture, remote, baseSha, log, worktreeRoot: join(fixture.root, 'worktrees') };
}

async function createWorktree(fixture) {
  const code = await withCwd(fixture.project, () => main([
    'create', '--name', 'lifecycle task', '--worktree-root', fixture.worktreeRoot,
  ]));
  assert.equal(code, 0);
  const listed = git(fixture.project, ['worktree', 'list', '--porcelain']).stdout;
  const path = listed.split(/\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((candidate) => isPathWithin(fixture.worktreeRoot, candidate));
  assert.ok(path, 'create must register and hand out the prepared worktree');
  return path;
}

function assertWorktreeAndBranchRetained(fixture, worktreePath) {
  const listing = git(fixture.project, ['worktree', 'list', '--porcelain']).stdout;
  const block = listing.split(/\n\n/u).find((entry) => {
    const pathLine = entry.split(/\n/u).find((line) => line.startsWith('worktree '));
    return pathLine && samePathIdentity(pathLine.slice('worktree '.length), worktreePath);
  });
  assert.ok(block, 'failed candidate worktree must remain registered');
  const branch = block.match(/^branch refs\/heads\/(.+)$/mu)?.[1];
  assert.ok(branch, 'failed candidate must keep its branch registered');
  assert.equal(git(fixture.project, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status, 0);
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function waitForPidExit(pid) {
  const deadline = Date.now() + 3000;
  while (isPidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isPidAlive(pid), false, `hook process ${pid} must be terminated when its finish-lock budget expires`);
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

test('finish-lock remaining budget cancels a hanging verify hook and reaps its child', async () => {
  const fixture = makeLifecycleRepo();
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'candidate content\n');
    process.env.LIFECYCLE_HANG_PHASE = 'verifyCandidate';
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    let result;
    try { result = await withCwd(path, () => main(['finish', '--no-wait'])); }
    finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.match(errors.join('\n'), /finish lock hold limit of 12000ms reached during `project adapter hook verifyCandidate`/u);
    return path;
  }, { maxHoldMs: 12_000 });

  const hooks = readFileSync(fixture.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const hangingHook = hooks.find((entry) => entry.phase === 'verifyCandidate');
  assert.ok(hangingHook, 'verifyCandidate must start before its remaining budget expires');
  await waitForPidExit(hangingHook.pid);
  assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim(), fixture.baseSha);
  assertWorktreeAndBranchRetained(fixture, worktreePath);
});

test('an afterLand hold timeout preserves timeout type and reports that push already landed', async () => {
  const fixture = makeLifecycleRepo({ hookPhases: ['afterLand'] });
  const worktreePath = await configureCli(async () => {
    process.env.LIFECYCLE_TEST_LOG = fixture.log;
    const path = await createWorktree(fixture);
    writeFileSync(join(path, 'README.md'), 'candidate content\n');
    process.env.LIFECYCLE_HANG_PHASE = 'afterLand';
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    let result;
    try { result = await withCwd(path, () => main(['finish', '--no-wait'])); }
    finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.match(errors.join('\n'), /push DID land .*finish lock hold limit of 12000ms reached during `project adapter hook afterLand`/u);
    return path;
  }, { maxHoldMs: 12_000 });

  const hooks = readFileSync(fixture.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const hangingHook = hooks.find((entry) => entry.phase === 'afterLand');
  assert.ok(hangingHook, 'afterLand must start before its remaining budget expires');
  await waitForPidExit(hangingHook.pid);
  assert.notEqual(git(fixture.remote, ['rev-parse', 'refs/heads/main']).stdout.trim(), fixture.baseSha);
  assertWorktreeAndBranchRetained(fixture, worktreePath);
});
