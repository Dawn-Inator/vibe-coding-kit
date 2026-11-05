// Tests for heartbeat-branches against real throwaway repos: a bare "remote", a primary clone and
// worktrees made by the kit's own `create` command. No git mocks; the live-process inventory is
// injected so a test runner's own processes never decide a verdict.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { main as worktreeCli } from '../../src/worktrees/cli.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';
import {
  checkRegistry,
  childSessions,
  cleanBranch,
  isProtectedBranch,
  liveBranches,
  parseArgs,
  parseRegistry,
  recordBranch,
  registryPathFor,
} from '../../src/supervision/heartbeat-branches.mjs';
import { sweep } from '../../src/supervision/heartbeat-sweep.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'src', 'supervision', 'heartbeat-branches.mjs');
const GIT_ENV = isolatedFixtureGitEnv();
const NO_LIVE = () => new Set();

function git(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempTracked('hb-branches-');
  const remote = join(root, 'remote.git');
  const primary = join(root, 'primary');
  git(['init', '--bare', '--initial-branch=main', remote], root);
  git(['clone', '--shared', remote, primary], root);
  writeFileSync(join(primary, 'README.md'), '# fixture\n');
  git(['add', '-A'], primary);
  git(['commit', '-m', 'initial commit'], primary);
  git(['push', 'origin', 'HEAD:refs/heads/main'], primary);
  git(['branch', '--set-upstream-to=origin/main', 'main'], primary);
  const ledger = join(root, 'session', 'heartbeat.md');
  return { root, remote, primary, worktreeRoot: join(root, 'worktrees'), ledger };
}

function writeLedger(fx, ...rows) {
  const head = ['## Items', '', '| id | source | item | status | evidence |', '| --- | --- | --- | --- | --- |'];
  spawnSync('mkdir', ['-p', dirname(fx.ledger)]);
  writeFileSync(fx.ledger, `${[...head, ...rows].join('\n')}\n`);
}

// Process-wide cwd matters to the kit's config loader and to `clean`'s chdir; restore it every time.
function inDir(dir, fn) {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(original);
  }
}

async function createWorktree(fx, name) {
  const original = process.cwd();
  process.chdir(fx.primary);
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await worktreeCli(['create', '--name', name, '--tool', 'claude', '--worktree-root', fx.worktreeRoot]), 0);
  } finally {
    console.log = log;
    process.chdir(original);
  }
  const entry = discoverRepo(fx.primary).worktrees.find((w) => w.branch === `claude/${name}`);
  assert.ok(entry, `expected claude/${name} worktree`);
  return entry.path;
}

function commitIn(path, name) {
  writeFileSync(join(path, `${name}.txt`), `${name}\n`);
  git(['add', '-A'], path);
  git(['commit', '-m', `work ${name}`], path);
  return git(['rev-parse', 'HEAD'], path);
}

// Land a worker commit on origin/main the way a rebasing finish does: a new SHA, the same patch.
function landByCherryPick(fx, sha, source) {
  const landing = join(fx.root, `landing-${sha.slice(0, 8)}`);
  git(['clone', '--shared', source, landing], fx.root);
  git(['remote', 'set-url', 'origin', fx.remote], landing);
  git(['fetch', 'origin', 'main'], landing);
  git(['checkout', '--detach', 'FETCH_HEAD'], landing);
  git(['cherry-pick', sha], landing);
  git(['push', 'origin', 'HEAD:refs/heads/main'], landing);
  git(['fetch', 'origin', 'main'], fx.primary);
}

const check = (fx) => inDir(fx.primary, () => checkRegistry({ ledger: fx.ledger, cwd: fx.primary, getLiveProcessCwds: NO_LIVE }));
const clean = (fx, branch, apply = false) => inDir(fx.primary, () => cleanBranch({ ledger: fx.ledger, branch, apply, cwd: fx.primary, getLiveProcessCwds: NO_LIVE }));
const stateOf = (result, branch) => result.branches.find((b) => b.branch === branch)?.state;

test('record appends one created row next to the ledger, is idempotent, and refuses shared or invalid names', () => {
  const fx = makeRepo();
  writeLedger(fx);
  const first = recordBranch({ ledger: fx.ledger, branch: 'claude/a', base: 'main', owner: 'agent:w1', item: 'I1', cwd: fx.primary });
  assert.equal(first.recorded, true);
  assert.equal(first.path, join(dirname(fx.ledger), 'branches.md'));
  assert.equal(registryPathFor(fx.ledger), first.path);
  assert.equal(recordBranch({ ledger: fx.ledger, branch: 'claude/a', base: 'main', owner: 'agent:w1', cwd: fx.primary }).recorded, false);
  const rows = parseRegistry(readFileSync(first.path, 'utf8'));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].event, rows[0].branch, rows[0].base, rows[0].start, rows[0].owner, rows[0].item], ['created', 'claude/a', 'main', '', 'agent:w1', 'I1']);
  for (const shared of ['main', 'develop', 'staging', 'dawninator/develop', 'gate/staging']) {
    assert.throws(() => recordBranch({ ledger: fx.ledger, branch: shared, base: 'main', owner: 'x', cwd: fx.primary }), /protected shared branch/, shared);
  }
  assert.throws(() => recordBranch({ ledger: fx.ledger, branch: 'claude/x', base: 'claude/x', owner: 'x', cwd: fx.primary }), /protected/);
  assert.throws(() => recordBranch({ ledger: fx.ledger, branch: 'bad..name', base: 'main', owner: 'x', cwd: fx.primary }), /not a valid branch name/);
  assert.equal(isProtectedBranch('claude/develop-docs'), false);
});

test('a registered branch with unlanded commits is in-progress, or land-pending once its item is done', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'wip');
  commitIn(path, 'wip');
  writeLedger(fx, '| I1 | owner:chat | do the wip | dispatched agent:w1 | owner: agent:w1 @ wt |');
  recordBranch({ ledger: fx.ledger, branch: 'claude/wip', base: 'main', owner: 'agent:w1', worktree: path, item: 'I1', cwd: fx.primary });
  let result = check(fx);
  assert.equal(stateOf(result, 'claude/wip'), 'in-progress');
  assert.equal(result.actionable, 0);
  assert.match(clean(fx, 'claude/wip', true).log[0], /refused: claude\/wip is in-progress/);
  assert.ok(existsSync(path), 'an unlanded worktree is never removed');

  writeLedger(fx, '| I1 | owner:chat | do the wip | done | worker reported done |');
  result = check(fx);
  assert.equal(stateOf(result, 'claude/wip'), 'land-pending');
  assert.equal(result.actionable, 1);
});

test('a landed (rebased) branch is cleanable: --apply removes worktree, remote and local refs, then records cleaned', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'done');
  const sha = commitIn(path, 'done');
  git(['push', 'origin', 'HEAD:refs/heads/claude/done'], path);
  git(['fetch', 'origin'], fx.primary);
  writeLedger(fx, '| I1 | owner:chat | ship it | done | landed |');
  recordBranch({ ledger: fx.ledger, branch: 'claude/done', base: 'main', owner: 'agent:w1', worktree: path, item: 'I1', cwd: fx.primary });
  landByCherryPick(fx, sha, path);

  const result = check(fx);
  assert.equal(stateOf(result, 'claude/done'), 'cleanable', JSON.stringify(result.branches));
  const dry = clean(fx, 'claude/done');
  assert.equal(dry.ok, true);
  assert.match(dry.log.join('\n'), /remove worktree[\s\S]*delete origin\/claude\/done[\s\S]*delete local claude\/done/);
  assert.ok(existsSync(path), 'a dry run removes nothing');

  const applied = clean(fx, 'claude/done', true);
  assert.equal(applied.ok, true, applied.log.join('\n'));
  assert.equal(existsSync(path), false);
  assert.equal(git(['ls-remote', '--heads', fx.remote, 'claude/done'], fx.primary), '');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/claude/done'], { cwd: fx.primary, env: GIT_ENV }).status, 1);
  const rows = parseRegistry(readFileSync(registryPathFor(fx.ledger), 'utf8'));
  assert.deepEqual(rows.map((row) => row.event), ['created', 'cleaned']);
  assert.equal(liveBranches(rows).length, 0);
  assert.equal(check(fx).branches.length, 0);
});

test('clean --apply re-reads the remote: a commit pushed to the branch after landing blocks deletion', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'moved');
  recordBranch({ ledger: fx.ledger, branch: 'claude/moved', base: 'main', owner: 'session:abc', cwd: fx.primary });
  const sha = commitIn(path, 'moved');
  git(['push', 'origin', 'HEAD:refs/heads/claude/moved'], path);
  git(['fetch', 'origin'], fx.primary);
  landByCherryPick(fx, sha, path);
  git(['worktree', 'remove', path], fx.primary);
  assert.equal(stateOf(check(fx), 'claude/moved'), 'cleanable');

  const other = join(fx.root, 'other');
  git(['clone', '--shared', fx.remote, other], fx.root);
  git(['checkout', '-B', 'claude/moved', 'origin/claude/moved'], other);
  commitIn(other, 'late');
  git(['push', 'origin', 'claude/moved'], other);

  const applied = clean(fx, 'claude/moved', true);
  assert.equal(applied.ok, false);
  assert.match(applied.log[0], /refused: claude\/moved is in-progress/);
  assert.notEqual(git(['ls-remote', '--heads', fx.remote, 'claude/moved'], fx.primary), '', 'the late commit survives');
});

test('a registered branch with no commits of its own is never cleanable until its item is done', async () => {
  const fx = makeRepo();
  const fresh = await createWorktree(fx, 'fresh');
  writeLedger(fx, '| I1 | owner:chat | unit | dispatched agent:w9 | owner: agent:w9 |');
  recordBranch({ ledger: fx.ledger, branch: 'claude/fresh', base: 'main', owner: 'agent:w9', worktree: fresh, cwd: fx.primary });
  const start = parseRegistry(readFileSync(registryPathFor(fx.ledger), 'utf8'))[0].start;
  assert.equal(start, git(['rev-parse', 'refs/heads/claude/fresh'], fx.primary), 'record keeps the tip it saw');
  let result = check(fx);
  assert.equal(stateOf(result, 'claude/fresh'), 'in-progress', 'a tip still equal to its start proves no finished work');
  assert.match(result.branches[0].reasons.join(' '), /no commits since it was registered/);
  assert.equal(clean(fx, 'claude/fresh', true).ok, false);
  assert.ok(existsSync(fresh), 'a worker that has not committed yet keeps its worktree');

  const linked = await createWorktree(fx, 'linked');
  recordBranch({ ledger: fx.ledger, branch: 'claude/linked', base: 'main', owner: 'agent:w9', worktree: linked, item: 'I1', cwd: fx.primary });
  assert.equal(stateOf(check(fx), 'claude/linked'), 'in-progress', 'its item is still dispatched');
  writeLedger(fx, '| I1 | owner:chat | unit | done | read-only unit, nothing to land |');
  assert.equal(stateOf(check(fx), 'claude/linked'), 'cleanable', 'a done item with nothing unlanded is closed out');
});

test('a landed but dirty worktree is refused, and an unregistered branch is never cleaned', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'dirty');
  const sha = commitIn(path, 'dirty');
  recordBranch({ ledger: fx.ledger, branch: 'claude/dirty', base: 'main', owner: 'agent:w2', worktree: path, cwd: fx.primary });
  landByCherryPick(fx, sha, path);
  writeFileSync(join(path, 'scratch.txt'), 'unsaved\n');
  assert.equal(stateOf(check(fx), 'claude/dirty'), 'dirty');
  assert.equal(clean(fx, 'claude/dirty', true).ok, false);
  assert.ok(existsSync(join(path, 'scratch.txt')));

  const foreign = await createWorktree(fx, 'foreign');
  const refused = clean(fx, 'claude/foreign', true);
  assert.equal(refused.ok, false);
  assert.match(refused.log[0], /has no live row/);
  assert.ok(existsSync(foreign));
});

test('a registered branch that never materialised is gone; cleaning it only records the row', () => {
  const fx = makeRepo();
  recordBranch({ ledger: fx.ledger, branch: 'claude/never', base: 'main', owner: 'agent:w3', cwd: fx.primary });
  const result = check(fx);
  assert.equal(stateOf(result, 'claude/never'), 'gone');
  assert.equal(result.actionable, 1);
  const applied = clean(fx, 'claude/never', true);
  assert.equal(applied.ok, true, applied.log.join('\n'));
  assert.match(applied.log.join('\n'), /recorded claude\/never as cleaned/);
  assert.equal(check(fx).branches.length, 0);

  git(['branch', 'feature/plain'], fx.primary);
  recordBranch({ ledger: fx.ledger, branch: 'feature/plain', base: 'main', owner: 'agent:w3', cwd: fx.primary });
  assert.equal(stateOf(check(fx), 'feature/plain'), 'protected', 'a local branch outside the managed prefixes is never deleted');
  assert.equal(clean(fx, 'feature/plain', true).ok, false);
});

test('child sessions: not-done rows are polled, done rows without archive evidence are owed an archive', () => {
  const items = [
    { id: 'I1', item: 'unit a', status: 'dispatched child session session:session_aaa', evidence: '-' },
    { id: 'I2', item: 'unit b', status: 'done', evidence: 'owner: session:session_bbb; landed abc123' },
    { id: 'I3', item: 'unit c', status: 'done', evidence: 'owner: session:session_ccc; landed def456; archived' },
  ];
  const registry = [{ event: 'created', branch: 'claude/x', base: 'main', owner: 'session:session_ddd', item: 'I4', line: 1 }];
  assert.deepEqual(childSessions(items, registry), [
    { id: 'session_aaa', item: 'I1', action: 'poll' },
    { id: 'session_bbb', item: 'I2', action: 'archive' },
    { id: 'session_ddd', item: 'I4', action: 'poll' },
  ]);
});

test('CLI: check exits 1 while something is actionable and 0 once it is cleaned; usage errors exit 2', () => {
  const fx = makeRepo();
  writeLedger(fx);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: fx.primary, encoding: 'utf8', env: GIT_ENV });
  assert.equal(run('record', '--ledger', fx.ledger, '--branch', 'claude/cli', '--base', 'main', '--owner', 'agent:w4').status, 0);
  const before = run('check', '--ledger', fx.ledger);
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /gone\s+claude\/cli/);
  assert.match(before.stdout, /next: heartbeat-branches\.mjs clean --ledger .* --branch claude\/cli --apply/);
  assert.equal(run('clean', '--ledger', fx.ledger, '--branch', 'claude/cli', '--apply').status, 0);
  const afterClean = run('check', '--ledger', fx.ledger, '--json');
  assert.equal(afterClean.status, 0, afterClean.stdout);
  assert.equal(JSON.parse(afterClean.stdout).branches.length, 0);
  assert.equal(run('check').status, 2);
  assert.throws(() => parseArgs(['record', '--ledger', 'x', '--branch', 'y']), /record needs --base/);
});

test('heartbeat-sweep proposes a row for every actionable branch and every finished, unarchived child session', async () => {
  const fx = makeRepo();
  writeLedger(fx,
    '| I1 | owner:chat | unit a | dispatched child session session:session_live | - |',
    '| I2 | owner:chat | unit b | done | owner: session:session_fin; landed abc123 |');
  recordBranch({ ledger: fx.ledger, branch: 'claude/left', base: 'main', owner: 'session:session_fin', item: 'I2', cwd: fx.primary });
  const result = await inDir(fx.primary, () => sweep(
    { ledger: fx.ledger, bases: ['origin/main'], staleDays: 1, worktreeRoot: fx.worktreeRoot, probes: null, maxRows: 20, config: null },
    { cwd: fx.primary, worktreeOptions: { getLiveProcessCwds: NO_LIVE } },
  ));
  const sources = result.lines.map((line) => line.split('|')[2].trim());
  assert.ok(sources.includes('sweep:branches:claude/left'), result.lines.join('\n'));
  assert.ok(sources.includes('sweep:child-session:session_fin'), result.lines.join('\n'));
  assert.ok(result.notes.some((note) => note.includes('child sessions to poll this wake: session:session_live')), result.notes.join('\n'));
});
