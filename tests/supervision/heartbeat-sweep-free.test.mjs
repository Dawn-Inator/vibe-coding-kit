// Tests for the computed free-candidate list, against a real throwaway git repo (no git mocks).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeFree, createGitIndex, formatFree, warmFree } from '../../src/supervision/heartbeat-sweep-free.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_MODULE = existsSync(join(HERE, '../support/isolated-git-env.mjs')) ? '../support/isolated-git-env.mjs' : '../../testing/fixtures/isolated-git-env.mjs';
const { isolatedFixtureGitEnv, withFixtureCommitIdentity } = await import(ENV_MODULE);

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd, args) {
  return execFileSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: isolatedFixtureGitEnv() }).trim();
}

function commitFiles(cwd, files, message) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A repo whose origin/develop is the base, plus two in-flight claude/* branches with live worktrees.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hb-free-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet', '--initial-branch=develop']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const landed = commitFiles(repo, { 'apps/svc/core.py': 'a\n', 'doc/readme.md': 'r\n' }, 'base');
  git(repo, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  for (const [name, files] of [['claude/alpha', { 'apps/svc/core.py': 'changed\n' }], ['claude/beta', { 'engineering/tool/run.mjs': 'x\n' }]]) {
    const wt = join(root, name.replace('/', '-'));
    git(repo, ['worktree', 'add', '-b', name, wt, 'develop']);
    commitFiles(wt, files, `work on ${name}`);
  }
  return { repo, landed };
}

const row = (id, status, item = 'unit of work') => ({ id, source: 'report:X', item, status, evidence: 'e' });
const NOW = new Date('2026-10-16T12:00:00Z');
const run = (rows, fx, extra = {}) => computeFree(rows, { repoDir: fx.repo, base: 'origin/develop', now: NOW, psLines: [], ...extra });
const freeIds = (r) => r.free.map((f) => f.id);

test('landing-stage and load resources are FREE candidates with the row item as first step', () => {
  const fx = makeRepo();
  const reasons = [
    'blocked ← candidate-preflight slots (scarce: ~2 concurrent) required for a develop landing',
    'blocked ← live finish.lock makes cleanup stand down',
    'blocked ← ROTBATCH landing in flight',
    'blocked ← host load too high, CPU saturated',
    'blocked ← waiting in the finish queue',
  ];
  const r = run(reasons.map((reason, i) => row(`I${i + 1}`, reason, `do thing ${i + 1}`)), fx);
  assert.deepEqual(freeIds(r), ['I1', 'I2', 'I3', 'I4', 'I5']);
  assert.ok(r.free.every((f) => f.kind === 'landing-resource'));
  assert.equal(r.free[0].firstStep, 'do thing 1');
  assert.equal(r.blocked.length, 0);
});

test('write set without paths is FREE; with paths it uses git diff of the named in-flight branch', () => {
  const fx = makeRepo();
  const r = run([
    row('I1', 'blocked ← ROTBATCH unlanded resource-budget write set'),
    row('I2', 'blocked ← write set apps/svc/core.py held by claude/alpha'),
    row('I3', 'blocked ← write set apps/svc/core.py held by claude/beta'),
    row('I4', 'blocked ← write set doc/ held by claude/alpha'),
  ], fx);
  assert.deepEqual(freeIds(r).sort(), ['I1', 'I3', 'I4']);
  assert.equal(r.free.find((f) => f.id === 'I1').kind, 'write-set-no-paths');
  assert.equal(r.free.find((f) => f.id === 'I3').kind, 'write-set-disjoint');
  const overlap = r.blocked.find((b) => b.id === 'I2');
  assert.equal(overlap.cls, 'overlap');
  assert.match(overlap.why, /apps\/svc\/core\.py \(claude\/alpha\)/);
});

test('write set paths with no branch named check every live claude/* worktree; bare file names match by basename', () => {
  const fx = makeRepo();
  const r = run([
    row('I1', 'blocked ← unlanded write set (run.mjs, other.mjs)'),
    row('I2', 'blocked ← unlanded write set apps/svc/'),
    row('I3', 'blocked ← unlanded write set apps/elsewhere/'),
  ], fx);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.cls]), [['I1', 'overlap'], ['I2', 'overlap']]);
  assert.match(r.blocked[0].why, /engineering\/tool\/run\.mjs \(claude\/beta\)/);
  assert.deepEqual(freeIds(r), ['I3']);
});

test('STALE: references that are done, an ancestor SHA, or a passed time gate', () => {
  const fx = makeRepo();
  const r = run([
    row('I1', 'done — shipped'),
    row('I2', 'dispatched OPENUNIT'),
    row('I3', 'blocked ← I1 not done'),
    row('I4', `blocked ← waiting for ${fx.landed.slice(0, 10)} to reach develop`),
    row('I5', 'blocked ← soak eligibility 2026-10-14T13:07:46Z (72h window)'),
    row('I6', 'blocked ← I1 and OPENUNIT'),
    row('I7', 'blocked ← FINISHEDUNIT comes first', 'x'),
    row('I8', 'done — FINISHEDUNIT shipped'),
  ], fx);
  assert.deepEqual(r.stale.map((s) => s.id), ['I3', 'I4', 'I5', 'I7']);
  assert.match(r.stale[0].why, /I1/);
  assert.match(r.stale[2].why, /already passed/);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.cls]), [['I6', 'dependency']]);
  assert.deepEqual(freeIds(r), []);
});

test('a SHA that exists but is not an ancestor of the base is an open reference, not stale', () => {
  const fx = makeRepo();
  const branchTip = git(fx.repo, ['rev-parse', 'claude/alpha']).slice(0, 10);
  const r = run([row('I1', `blocked ← ${branchTip} must reach develop first`)], fx);
  assert.equal(r.stale.length, 0);
  assert.deepEqual(r.blocked.map((b) => b.cls), ['dependency']);
});

test('Owner / OTP / stg / prod / future time gates stay blocked; unclassified is never silently free', () => {
  const fx = makeRepo();
  const r = run([
    row('I1', 'blocked ← Owner naming required'),
    row('I2', 'blocked ← purple OTP window'),
    row('I3', 'blocked ← stg publish required'),
    row('I4', 'blocked ← prod release'),
    row('I5', 'blocked ← gate opens 2026-10-17T17:07Z'),
    row('I6', 'owner ← security boundary'),
    row('I7', 'blocked ← something nobody classified'),
  ], fx);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.cls]), [['I1', 'owner'], ['I2', 'owner'], ['I3', 'owner'], ['I4', 'owner'], ['I5', 'time'], ['I6', 'owner'], ['I7', 'unclassified']]);
  assert.equal(r.free.length, 0);
});

test('a ready row nobody dispatched is FREE', () => {
  const fx = makeRepo();
  const r = run([row('I1', 'ready', 'sweep:worktree cleanup candidate')], fx);
  assert.deepEqual(r.free.map((f) => [f.id, f.kind, f.firstStep]), [['I1', 'ready-undispatched', 'sweep:worktree cleanup candidate']]);
});

test('summary counts dispatched units once, live worktree:end processes of this ledger session not already named, and owner/time blocks', () => {
  const fx = makeRepo();
  const rows = [
    row('I1', 'dispatched ALPHA, BETA (detail)'),
    row('I2', 'dispatched ALPHA'),
    row('I3', 'blocked ← preflight slots'),
    row('I4', 'blocked ← Owner naming'),
    row('I5', 'blocked ← 2026-12-01T00:00:00Z'),
    row('I6', 'blocked ← I2 still running'),
    row('I7', 'blocked ← OLDTHING'),
    row('I8', 'done — OLDTHING'),
  ];
  const psLines = [
    'node pnpm worktree:end -- --message-file /t/ALPHA/msg.txt',
    'node pnpm worktree:end -- --message-file /t/session-a/GAMMA/msg.txt',
    'node pnpm worktree:end -- --message-file /t/session-a/GAMMA/msg.txt',
    'node pnpm worktree:end -- --message-file /t/other-session/DELTA/msg.txt',
    'grep worktree:end',
    'unrelated process',
  ];
  const r = run(rows, fx, { psLines, ledgerPath: '/ledgers/session-a/heartbeat.md' });
  assert.equal(r.inFlight, 3);
  assert.equal(r.unattributed, 1);
  assert.equal(r.summary, 'in-flight 3 · free-undispatched 1 · blocked 3 (owner/time 2) · stale 1');
});

test('formatFree lists id, class, and first step; empty when nothing to say', () => {
  const fx = makeRepo();
  const r = run([row('I1', 'blocked ← preflight slots', 'land the guard fix')], fx);
  assert.match(formatFree(r), /^free-candidates:[^\n]*\n {2}- I1 \[landing-resource\] .*first step: land the guard fix$/);
  assert.equal(formatFree({ free: [], stale: [] }), '');
});

test('dispatched unit lists drop parenthetical detail; bare file names and branch names are not mistaken for dirs', () => {
  const fx = makeRepo();
  const psLines = ['node pnpm worktree:end -- --message-file /t/REDS-A/msg.txt', 'node pnpm worktree:end -- --message-file /t/REDS-B/msg.txt'];
  const r = run([
    row('I1', 'dispatched REDS-A (VOD), REDS-B (auth, env) → then FINAL'),
    row('I2', 'blocked ← write set (run.mjs) on claude/beta, see e.g. v1.2'),
  ], fx, { psLines });
  assert.equal(r.inFlight, 2);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.cls]), [['I2', 'overlap']]);
});

test('a future time gate beats a landed SHA, and a done unit name does not clear a stg gate in the same sentence', () => {
  const fx = makeRepo();
  const r = run([
    row('I1', 'done — STGROLL round one'),
    row('I2', `blocked ← replicas restarted on ${fx.landed.slice(0, 10)}; gate now opens 2026-10-17T17:07Z`),
    row('I3', 'blocked ← STGROLL not-yet-finished stg publish'),
    row('I4', 'blocked ← I1 stg publish'),
  ], fx);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.cls]), [['I2', 'time'], ['I3', 'owner']]);
  assert.deepEqual(r.stale.map((s) => s.id), ['I4']);
});

// ---- in-flight from evidence, stale-dispatched, and batching (I510) -----------------------------------------------------

function commitAt(cwd, files, message, iso) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  const env = { ...isolatedFixtureGitEnv(), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  execFileSync('git', withFixtureCommitIdentity(['add', '-A']), { cwd, env });
  execFileSync('git', withFixtureCommitIdentity(['commit', '-m', message]), { cwd, env });
}

// Branches: claude/fresh (commit 1 h before NOW), claude/old (3 days before), claude/merged (ancestor of the base),
// claude/picked (not an ancestor, but its patch is on the base through a cherry-pick).
function makeEvidenceRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hb-free-ev-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet', '--initial-branch=develop']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  commitAt(repo, { 'a.txt': 'a\n' }, 'base', '2026-10-01T00:00:00Z');
  const branchWith = (name, file, iso) => {
    git(repo, ['checkout', '--quiet', '-b', name, 'develop']);
    commitAt(repo, { [file]: `${name}\n` }, `work ${name}`, iso);
    git(repo, ['checkout', '--quiet', 'develop']);
  };
  branchWith('claude/fresh', 'fresh.py', '2026-10-16T11:00:00Z');
  branchWith('claude/old', 'old.txt', '2026-10-13T11:00:00Z');
  branchWith('claude/merged', 'merged.txt', '2026-10-16T09:00:00Z');
  git(repo, ['merge', '--quiet', '--no-ff', '-m', 'merge merged', 'claude/merged']);
  branchWith('claude/picked', 'picked.txt', '2026-10-16T10:00:00Z');
  execFileSync('git', withFixtureCommitIdentity(['cherry-pick', 'claude/picked']), { cwd: repo, env: { ...isolatedFixtureGitEnv(), GIT_COMMITTER_DATE: '2026-10-16T10:30:00Z' } });
  git(repo, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  return { repo };
}

test('in-flight comes from evidence: a recent unlanded branch or a live process counts, an idle or unknown unit does not', () => {
  const fx = makeEvidenceRepo();
  const r = run([
    row('I1', 'dispatched FRESH'),
    row('I2', 'dispatched OLD'),
    row('I3', 'dispatched NOBRANCH'),
    row('I4', 'dispatched LIVEONE'),
  ], fx, { psLines: ['node pnpm worktree:end -- --message-file /t/LIVEONE/msg.txt'] });
  assert.equal(r.inFlight, 2, 'FRESH (branch commit < 24h) and LIVEONE (live process)');
  assert.deepEqual(r.unverified.map((u) => u.id), ['I2', 'I3']);
  assert.match(r.unverified[0].why, /no commit in the last 24h/);
  assert.equal(r.staleDispatched.length, 0);
  assert.match(r.summary, /^in-flight 2 · free-undispatched 0 · blocked 0 \(owner\/time 0\) · unverified-dispatched 2$/);
});

test('a dispatched row whose branch has landed (ancestor or patch-id twin) is stale-dispatched and not in flight', () => {
  const fx = makeEvidenceRepo();
  const r = run([
    row('I1', 'dispatched MERGED'),
    row('I2', 'dispatched PICKED'),
    row('I3', 'dispatched FRESH'),
  ], fx);
  assert.deepEqual(r.staleDispatched.map((s) => s.id), ['I1', 'I2']);
  assert.match(r.staleDispatched[0].why, /claude\/merged landed on origin\/develop \(ancestor\)/);
  assert.match(r.staleDispatched[1].why, /claude\/picked landed on origin\/develop \(patch-id\)/);
  assert.equal(r.inFlight, 1);
  assert.match(r.summary, /· stale-dispatched 2$/);
  assert.match(formatFree(r), /stale-dispatched:[^\n]*\n {2}- I1 .*\n {2}- I2 /);
});

test('an explicit branch in the row text attributes a differently named unit; a live process beats a landed branch', () => {
  const fx = makeEvidenceRepo();
  const r = run([
    row('I1', 'dispatched WORKERX', 'x'),
    row('I2', 'dispatched MERGED'),
  ], fx, { psLines: ['node pnpm worktree:end -- --message-file /t/MERGED/msg.txt'] });
  assert.deepEqual(r.unverified.map((u) => u.id), ['I1']);
  assert.equal(r.inFlight, 1);
  const explicit = run([{ id: 'I1', source: 'report:X', item: 'x', status: 'dispatched WORKERX', evidence: 'branch claude/merged' }], fx);
  assert.deepEqual(explicit.staleDispatched.map((s) => s.id), ['I1']);
});

test('classification is batched: 150 SHA-bearing blocked rows start only a handful of git processes', () => {
  const fx = makeEvidenceRepo();
  const trace = join(dirname(fx.repo), 'trace2.json');
  const rowsMany = Array.from({ length: 150 }, (_, i) => row(`I${i + 1}`, `blocked ← waiting for ${String(i + 1).padStart(2, '0')}abcdef${i % 10}12 and ${git(fx.repo, ['rev-parse', 'HEAD']).slice(0, 10)}`));
  rowsMany.push(row('I900', 'dispatched FRESH'), row('I901', 'dispatched MERGED'), row('I902', 'blocked ← write set apps/x/ held by claude/fresh'));
  process.env.GIT_TRACE2_EVENT = trace;
  let result;
  try {
    result = run(rowsMany, fx);
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
  }
  const started = readFileSync(trace, 'utf8').split('\n').filter((line) => line.includes('"event":"start"')).length;
  assert.ok(started <= 14, `expected a handful of git processes, saw ${started}`);
  assert.equal(result.stale.length, 150, 'every row names the base tip, an ancestor');
});

test('warmFree primes the shared index in parallel and changes no answer', async () => {
  const fx = makeEvidenceRepo();
  const rows = [
    row('I1', 'dispatched FRESH'),
    row('I2', 'dispatched PICKED'),
    row('I3', 'blocked ← write set apps/x/ held by claude/fresh'),
    row('I4', 'blocked ← write set fresh.py held by claude/fresh'),
  ];
  const cold = run(rows, fx);
  const index = createGitIndex(fx.repo);
  await warmFree(rows, { index, base: 'origin/develop' });
  const warm = run(rows, fx, { index });
  assert.deepEqual(warm, cold);
  assert.deepEqual(warm.staleDispatched.map((s) => s.id), ['I2']);
  assert.deepEqual(warm.blocked.map((b) => [b.id, b.cls]), [['I4', 'overlap']]);
  assert.deepEqual(warm.free.map((f) => f.id), ['I3']);
});

test('a live process names a unit only as a whole token, not as a substring of another word', () => {
  const fx = makeEvidenceRepo();
  const r = run([row('I1', 'dispatched KNOW'), row('I2', 'dispatched ROTG1')], fx, {
    psLines: ['claude --append-system-prompt use manage-knowledge-artifacts skill', 'node pnpm worktree:end -- --message-file /t/ROTG1/commit-msg.txt', 'node heartbeat-sweep.mjs --ledger /t/KNOW/heartbeat.md claude'],
  });
  assert.equal(r.inFlight, 1);
  assert.deepEqual(r.unverified.map((u) => u.id), ['I1']);
});

test('unlanded output/branch without a tagged proof is a base-on-branch FREE candidate; a proof keeps it blocked', () => {
  const fx = makeRepo();
  const result = run(
    [
      row('I1', 'blocked ← claude/preflightspeed unlanded output (SELECTGAP2 relaunch)', 'SELECTGAP2 relaunch'),
      row('I2', 'blocked ← claude/carrier0 unlanded output', 'CARRIER0 fleet-roll prep'),
      row('I3', 'blocked ← fleet roll needs the landed carrier SHA; needs-landed: production effect (claude/carrier0 unlanded)'),
      row('I4', 'blocked ← claude/alpha unlanded output; same-file conflict: apps/svc/core.py'),
      row('I5', 'blocked ← claude/x unlanded output; branch-unstable: claude/x rewritten 10 min ago'),
      row('I6', 'blocked ← claude/y unlanded output; owner-gated'),
    ],
    fx,
  );
  assert.deepEqual(freeIds(result), ['I1', 'I2']);
  assert.deepEqual(new Set(result.free.map((f) => f.kind)), new Set(['base-on-branch']));
  assert.match(result.free[0].firstStep, /^begin on claude\/preflightspeed, land after it: SELECTGAP2 relaunch$/);
  assert.match(formatFree(result), /\[base-on-branch\].*begin on claude\/carrier0, land after it/);
  assert.deepEqual(result.blocked.map((b) => [b.id, b.cls]), [['I3', 'proof'], ['I4', 'proof'], ['I5', 'proof'], ['I6', 'proof']]);
});
