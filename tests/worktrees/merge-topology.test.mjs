// worktree-guard/merge-topology.test.mjs
//
// Tests for merge-preserving finish: the plumbing helpers, the re-author path in
// git-identity.mjs, and `finish` end to end against a real bare remote.
//
// The scenario that matters: a branch cut from `develop` that contains
// `git merge --no-ff origin/main` (a back-merge). A rebase would drop that merge
// commit; finish must land it, keep the merged-in main tip as its second parent,
// and leave main an ancestor of develop on the remote.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

import { main } from '../../src/worktrees/cli.mjs';
import { loadConfig } from '../../src/worktrees/config.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';
import { reauthorUnpushedCommitsToAiIdentity } from '../../src/worktrees/git-identity.mjs';
import {
  hasFirstParentMerge,
  isAncestor,
  listFirstParentMerges,
  listUnpublishedCommitsTopo,
  readCommitObject,
  sharedHistoryRefsOf,
  sharedHistoryTips,
} from '../../src/worktrees/merge-topology.mjs';

after(cleanupTempDirs);

const config = {
  ...loadConfig(undefined, {}),
  identity: { name: 'Synthetic Worktree Bot', email: 'worker@worktree-kit.test' },
};

function run(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: isolatedFixtureGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function withCwd(dir, fn) {
  const original = process.cwd();
  const originalConfigPath = process.env.WTG_CONFIG_PATH;
  const configDir = mkdtempTracked('wtg-merge-test-config-');
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ identity: config.identity }));
  process.chdir(dir);
  process.env.WTG_CONFIG_PATH = configPath;
  try {
    return await fn();
  } finally {
    if (originalConfigPath === undefined) delete process.env.WTG_CONFIG_PATH;
    else process.env.WTG_CONFIG_PATH = originalConfigPath;
    process.chdir(original);
  }
}

async function capture(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function commit(cwd, file, content, message = `edit ${file}`) {
  writeFileSync(join(cwd, file), content);
  run(['add', file], cwd);
  run(['commit', '-m', message], cwd);
  return run(['rev-parse', 'HEAD'], cwd);
}

/**
 * Bare remote with `main` and `develop` (develop cut from main), a primary clone
 * on `develop`, then one more commit on main so develop is behind it.
 */
function makeBackmergeFixture() {
  const root = mkdtempTracked('wtg-merge-topology-');
  const remoteDir = join(root, 'remote.git');
  const primaryDir = join(root, 'primary');
  run(['init', '--bare', '--initial-branch=main', remoteDir], root);
  run(['clone', '--shared', remoteDir, primaryDir], root);
  // Runtime worktree Git calls inherit the host's Git config, while fixture commands
  // use an isolated empty global config. Pin line-ending behavior locally so the
  // runtime checkout and fixture assertions interpret the same bytes on Windows.
  run(['config', 'core.autocrlf', 'false'], primaryDir);
  commit(primaryDir, 'shared.txt', 'base\n', 'initial commit');
  run(['push', 'origin', 'HEAD:refs/heads/main'], primaryDir);
  run(['branch', '-M', 'main'], primaryDir);
  run(['checkout', '-b', 'develop'], primaryDir);
  run(['push', '-u', 'origin', 'develop'], primaryDir);
  run(['checkout', 'main'], primaryDir);
  const mainTip = commit(primaryDir, 'main-only.txt', 'from main\n', 'main moves ahead');
  run(['push', 'origin', 'main'], primaryDir);
  run(['checkout', 'develop'], primaryDir);
  return { root, remoteDir, primaryDir, mainTip, worktreeRoot: join(root, 'worktrees') };
}

function pushBranchChange(fx, branch, file, content, message) {
  fx.changeSequence = (fx.changeSequence ?? 0) + 1;
  const changeClone = join(fx.root, `remote-change-${fx.changeSequence}`);
  run(['clone', '--shared', fx.remoteDir, changeClone], fx.root);
  run(['fetch', 'origin', branch], changeClone);
  run(['checkout', '-B', branch, `origin/${branch}`], changeClone);
  const sha = commit(changeClone, file, content, message);
  run(['push', 'origin', `HEAD:refs/heads/${branch}`], changeClone);
  // Keep the primary's remote-tracking view current without changing its branch.
  run(['fetch', 'origin', branch], fx.primaryDir);
  return sha;
}

async function createBackmergeWorktree(fx) {
  const out = await withCwd(fx.primaryDir, () => capture(() => (
    main(['create', '--name', 'backmerge', '--tool', 'claude', '--worktree-root', fx.worktreeRoot, '--base', 'origin/develop'])
  )));
  assert.equal(out.result, 0, out.errors.join('\n'));
  const entry = discoverRepo(fx.primaryDir).worktrees.find((w) => w.branch === 'claude/backmerge');
  assert.ok(entry);
  run(['merge', '--no-ff', '-m', 'Merge main into develop', 'origin/main'], entry.path);
  return entry.path;
}

const finish = (worktree, extra = []) => withCwd(worktree, () => capture(() => (
  main(['finish', '--message', 'finish message', '--no-wait', ...extra])
)));

// ---------------------------------------------------------------------------
// plumbing helpers
// ---------------------------------------------------------------------------

test('listFirstParentMerges / hasFirstParentMerge see only merges on the first-parent chain', () => {
  const root = mkdtempTracked('wtg-topology-unit-');
  run(['init', '-b', 'main'], root);
  const base = commit(root, 'a.txt', 'a\n', 'base');
  run(['checkout', '-b', 'side'], root);
  commit(root, 'side.txt', 's\n', 'side work');
  run(['checkout', 'main'], root);
  commit(root, 'main.txt', 'm\n', 'main work');
  run(['merge', '--no-ff', '-m', 'merge side', 'side'], root);
  const mergeSha = run(['rev-parse', 'HEAD'], root);

  const merges = listFirstParentMerges(root, `${base}..HEAD`);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].sha, mergeSha);
  assert.equal(merges[0].parents.length, 2);
  assert.equal(hasFirstParentMerge(root, `${base}..HEAD`), true);
  assert.equal(hasFirstParentMerge(root, `${mergeSha}..HEAD`), false);
  assert.equal(isAncestor(root, base, 'HEAD'), true);
  assert.equal(isAncestor(root, 'HEAD', base), false);

  const parsed = readCommitObject(root, mergeSha);
  assert.equal(parsed.parents.length, 2);
  assert.match(parsed.message, /^merge side/);
  assert.match(parsed.author, /<.+> \d+ [+-]\d{4}$/);
});

test('listUnpublishedCommitsTopo excludes everything reachable from the base or a shared-history ref, parents first', () => {
  const root = mkdtempTracked('wtg-topology-unpublished-');
  run(['init', '-b', 'main'], root);
  const base = commit(root, 'a.txt', 'a\n', 'base');
  run(['checkout', '-b', 'other'], root);
  const published = commit(root, 'other.txt', 'o\n', 'published on the shared branch');
  run(['update-ref', 'refs/remotes/origin/main', published], root);
  run(['checkout', '-b', 'work', base], root);
  const own = commit(root, 'own.txt', 'w\n', 'own work');
  run(['merge', '--no-ff', '-m', 'merge shared', 'other'], root);
  const merge = run(['rev-parse', 'HEAD'], root);

  assert.deepEqual(listUnpublishedCommitsTopo(root, base, config), [own, merge]);
  // With no shared-history ref the published commit counts as this branch's own.
  const none = listUnpublishedCommitsTopo(root, base, { sharedHistoryRefs: [] });
  assert.ok([own, published, merge].every((sha) => none.includes(sha)));
  assert.ok(none.indexOf(published) < none.indexOf(merge), 'parents come before the merge that uses them');
  assert.deepEqual(sharedHistoryTips(root, config), ['refs/remotes/origin/main']);
  assert.deepEqual(sharedHistoryTips(root, { sharedHistoryRefs: ['refs/remotes/origin/nope'] }), []);
  assert.deepEqual(sharedHistoryRefsOf({}), ['refs/remotes/origin/main'], 'a config without the key falls back to the default');
});

// ---------------------------------------------------------------------------
// git-identity: the re-author path keeps merges
// ---------------------------------------------------------------------------

test('reauthorUnpushedCommitsToAiIdentity keeps a merge commit and its published second parent, and re-authors only unpublished commits', () => {
  const root = mkdtempTracked('wtg-topology-reauthor-');
  run(['init', '-b', 'main'], root);
  const base = commit(root, 'a.txt', 'a\n', 'base');
  run(['branch', 'develop', base], root);
  const mainTip = commit(root, 'm.txt', 'm\n', 'main moves');
  run(['update-ref', 'refs/remotes/origin/main', mainTip], root);
  run(['checkout', 'develop'], root);
  commit(root, 'b.txt', 'b\n', 'develop work');
  run(['merge', '--no-ff', '-m', 'Merge main', 'main'], root);
  const treeBefore = run(['rev-parse', 'HEAD^{tree}'], root);

  const outcome = reauthorUnpushedCommitsToAiIdentity(root, base, config);
  assert.equal(outcome.rewritten, true);
  assert.equal(outcome.preservedMerges, true);

  assert.equal(run(['rev-list', '--merges', '--count', `${base}..HEAD`], root), '1');
  const head = readCommitObject(root, run(['rev-parse', 'HEAD'], root));
  assert.equal(head.parents[1], mainTip, 'the published second parent keeps its id');
  assert.equal(run(['rev-parse', 'HEAD^{tree}'], root), treeBefore);
  assert.match(head.author, new RegExp(`^${config.identity.name} <${config.identity.email}>`));
  assert.match(head.committer, new RegExp(`^${config.identity.name} <${config.identity.email}>`));
  assert.equal(run(['log', '-1', '--format=%an', mainTip], root), 'Vibe Coding Kit Fixture', 'published commit untouched');
  assert.equal(isAncestor(root, mainTip, 'HEAD'), true);

  // Second call is a no-op with stable ids.
  const headBefore = run(['rev-parse', 'HEAD'], root);
  assert.equal(reauthorUnpushedCommitsToAiIdentity(root, base, config).rewritten, false);
  assert.equal(run(['rev-parse', 'HEAD'], root), headBefore);
});

test('the preserving re-author path is fail-closed on a fixture identity, like the linear path', () => {
  const root = mkdtempTracked('wtg-topology-fixture-id-');
  run(['init', '-b', 'main'], root);
  const base = commit(root, 'a.txt', 'a\n', 'base');
  run(['checkout', '-b', 'side'], root);
  writeFileSync(join(root, 's.txt'), 's\n');
  run(['add', 's.txt'], root);
  spawnSync('git', ['commit', '-m', 'leaked identity'], {
    cwd: root,
    env: { ...isolatedFixtureGitEnv(), GIT_AUTHOR_NAME: 'Rehearsal Bot', GIT_AUTHOR_EMAIL: 'bot@example.test', GIT_COMMITTER_NAME: 'Rehearsal Bot', GIT_COMMITTER_EMAIL: 'bot@example.test' },
  });
  run(['checkout', 'main'], root);
  commit(root, 'm.txt', 'm\n', 'main work');
  run(['merge', '--no-ff', '-m', 'merge side', 'side'], root);
  assert.throws(() => reauthorUnpushedCommitsToAiIdentity(root, base, config), /fixture identity/);
});

// ---------------------------------------------------------------------------
// finish end to end
// ---------------------------------------------------------------------------

test('finish lands a main -> develop back-merge as a merge commit: second parent intact, main an ancestor of develop on the remote', async () => {
  const fx = makeBackmergeFixture();
  const worktree = await createBackmergeWorktree(fx);

  const out = await finish(worktree);
  assert.equal(out.result, 0, out.errors.join('\n'));
  assert.ok(out.logs.some((line) => /merge-preserving finish onto origin\/develop: 1 merge commit/.test(line)), out.logs.join('\n'));
  assert.ok(out.logs.some((line) => /merge ancestry verified/.test(line)), out.logs.join('\n'));
  assert.equal(existsSync(worktree), false, 'worktree cleaned up after a successful finish');

  const merges = run(['rev-list', '--merges', '--first-parent', 'develop'], fx.remoteDir).split('\n').filter(Boolean);
  assert.equal(merges.length, 1, 'the merge commit reached the remote');
  const merged = readCommitObject(fx.remoteDir, merges[0]);
  assert.equal(merged.parents[1], fx.mainTip, 'second parent is main\'s own commit, id unchanged');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', fx.mainTip, 'develop'], { cwd: fx.remoteDir, env: isolatedFixtureGitEnv() }).status, 0);
  assert.match(merged.author, new RegExp(`^${config.identity.name} <`));
  assert.match(merged.message, /^Merge main into develop/);
  assert.equal(run(['rev-parse', 'main'], fx.remoteDir), fx.mainTip, 'main itself was not touched');
});

test('finish with the target moved re-does the merge on the new tip instead of rebasing it away', async () => {
  const fx = makeBackmergeFixture();
  const worktree = await createBackmergeWorktree(fx);

  // develop moves on after the worktree's merge was made.
  const moved = pushBranchChange(fx, 'develop', 'develop-only.txt', 'later\n', 'develop moves');

  const out = await finish(worktree);
  assert.equal(out.result, 0, out.errors.join('\n'));
  assert.ok(out.logs.some((line) => /moved since this branch's merge was made/.test(line)), out.logs.join('\n'));

  const merges = run(['rev-list', '--merges', '--first-parent', 'develop'], fx.remoteDir).split('\n').filter(Boolean);
  assert.equal(merges.length, 1);
  const merged = readCommitObject(fx.remoteDir, merges[0]);
  assert.equal(merged.parents[0], moved, 'the re-done merge sits on the moved develop tip');
  assert.equal(merged.parents[1], fx.mainTip);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', fx.mainTip, 'develop'], { cwd: fx.remoteDir, env: isolatedFixtureGitEnv() }).status, 0);
  assert.equal(run(['show', 'develop:develop-only.txt'], fx.remoteDir), 'later');
  assert.equal(run(['show', 'develop:main-only.txt'], fx.remoteDir), 'from main');
});

test('finish with the target moved and a conflicting merge aborts, restores HEAD, pushes nothing and prints the manual steps', async () => {
  const fx = makeBackmergeFixture();
  // main also edits shared.txt, so a later conflicting edit on develop collides with it.
  const conflictingMain = pushBranchChange(fx, 'main', 'shared.txt', 'main version\n', 'main edits shared');

  const worktree = await createBackmergeWorktree(fx);
  const headBefore = run(['rev-parse', 'HEAD'], worktree);

  pushBranchChange(fx, 'develop', 'shared.txt', 'develop version\n', 'develop edits shared');
  const remoteBefore = run(['rev-parse', 'develop'], fx.remoteDir);

  const out = await finish(worktree);
  assert.equal(out.result, 1);
  const text = out.errors.join('\n');
  assert.match(text, /could not re-do merge/);
  assert.match(text, /shared\.txt/);
  assert.match(text, /Nothing was pushed/);
  assert.match(text, /git merge --no-ff/);
  assert.equal(run(['rev-parse', 'HEAD'], worktree), headBefore, 'HEAD restored exactly');
  assert.equal(run(['status', '--porcelain'], worktree), '');
  assert.equal(existsSync(join(worktree, '.git')), true);
  assert.equal(run(['rev-parse', 'develop'], fx.remoteDir), remoteBefore, 'the remote never saw a half state');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', conflictingMain, 'develop'], { cwd: fx.remoteDir, env: isolatedFixtureGitEnv() }).status, 1);
  assert.equal(existsSync(join(fx.primaryDir, '.git', 'worktree-guard-state', 'finish.lock')), false, 'lock released');
});

test('a linear branch still takes the rebase path: no merge commit, no merge-preserving message', async () => {
  const fx = makeBackmergeFixture();
  const out0 = await withCwd(fx.primaryDir, () => capture(() => (
    main(['create', '--name', 'linear', '--tool', 'claude', '--worktree-root', fx.worktreeRoot, '--base', 'origin/develop'])
  )));
  assert.equal(out0.result, 0, out0.errors.join('\n'));
  const entry = discoverRepo(fx.primaryDir).worktrees.find((w) => w.branch === 'claude/linear');
  commit(entry.path, 'feature.txt', 'feature\n', 'feature work');
  // develop moves, so the rebase actually has to replay.
  pushBranchChange(fx, 'develop', 'develop-only.txt', 'later\n', 'develop moves');

  const out = await finish(entry.path);
  assert.equal(out.result, 0, out.errors.join('\n'));
  assert.equal(out.logs.some((line) => /merge-preserving/.test(line)), false);
  assert.equal(run(['rev-list', '--merges', '--count', 'develop'], fx.remoteDir), '0');
  assert.equal(run(['show', 'develop:feature.txt'], fx.remoteDir), 'feature');
  assert.equal(run(['log', '-1', '--format=%an', 'develop'], fx.remoteDir), config.identity.name);
});
