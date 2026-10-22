// worktree-guard/git-identity.mjs
//
// AI git identity helpers: building the `git -c user.name=... -c
// user.email=...` args / env for child git invocations, detecting a leaked
// test-fixture identity (fail-closed -- never silently overwrite it), and
// reauthoring a range of unpushed commits onto the configured AI identity.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { spawnSync } from 'node:child_process';

import { hasFirstParentMerge, listUnpublishedCommitsTopo, readCommitObject } from './merge-topology.mjs';
import { assertNoForbiddenMergeStrategy } from './forbid-auto-resolve-strategy.mjs';

/**
 * Build the `git -c user.name=... -c user.email=...` args used to make a
 * single git invocation commit as the configured AI identity, independent
 * of whatever local/global git config is in effect.
 *
 * @param {{identity: {name: string, email: string}}} config
 * @returns {string[]}
 */
export function gitIdentityArgs(config) {
  return [
    '-c', `user.name=${config.identity.name}`,
    '-c', `user.email=${config.identity.email}`,
  ];
}

/**
 * Build a child-process env that forces the configured AI identity for both
 * author and committer, on top of a base env (defaults to process.env).
 *
 * @param {{identity: {name: string, email: string}}} config
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitIdentityEnv(config, base = process.env) {
  return {
    ...base,
    GIT_AUTHOR_NAME: config.identity.name,
    GIT_AUTHOR_EMAIL: config.identity.email,
    GIT_COMMITTER_NAME: config.identity.name,
    GIT_COMMITTER_EMAIL: config.identity.email,
  };
}

/**
 * True when `name` or `email` matches config.fixtureIdentityPattern -- i.e.
 * looks like a leaked test-fixture / rehearsal identity rather than a real
 * human or the configured AI identity.
 *
 * @param {string} name
 * @param {string} email
 * @param {{fixtureIdentityPattern: string}} config
 * @returns {boolean}
 */
export function looksLikeFixtureGitIdentity(name, email, config) {
  const pattern = new RegExp(config.fixtureIdentityPattern);
  return pattern.test(String(name || '')) || pattern.test(String(email || ''));
}

/**
 * Read the local (per-repo) git user.name / user.email, best-effort. Returns
 * { name: '', email: '' } when either is unset or the git invocation fails
 * (e.g. not inside a git repo) -- never throws.
 *
 * @param {string} cwd
 * @returns {{name: string, email: string}}
 */
export function readLocalGitIdentityPair(cwd) {
  const result = spawnSync(
    'git',
    ['config', '--local', '--get-regexp', '^user\\.(name|email)$'],
    { cwd, encoding: 'utf8' },
  );

  const pair = { name: '', email: '' };
  if (result.status !== 0 || !result.stdout) {
    return pair;
  }

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) continue;
    const key = trimmed.slice(0, spaceIndex);
    const value = trimmed.slice(spaceIndex + 1);
    if (key === 'user.name') pair.name = value;
    if (key === 'user.email') pair.email = value;
  }

  return pair;
}

/**
 * Throw a fail-closed error when the local git identity in `cwd` looks like
 * a leaked test-fixture identity. Includes a remediation hint in the error
 * message.
 *
 * @param {string} cwd
 * @param {{fixtureIdentityPattern: string}} config
 */
export function assertNoFixtureGitIdentity(cwd, config) {
  const { name, email } = readLocalGitIdentityPair(cwd);
  if (looksLikeFixtureGitIdentity(name, email, config)) {
    throw new Error(
      `Local git identity looks like a leaked test-fixture identity ` +
      `(name="${name}", email="${email}"). Fix it with: ` +
      `git config --local --unset user.name && git config --local --unset user.email`,
    );
  }
}

/**
 * Reauthor every unpushed commit in `baseRef..HEAD` onto the configured AI
 * identity (both author and committer), fail-closed against any fixture
 * identity found in the range, and a no-op when the range is already fully
 * authored as the configured identity.
 *
 * Design note: `git rebase --exec 'git commit --amend --reset-author
 * --no-edit'` is required (not just running the rebase under an
 * identity-forcing env) because a clean rebase replay preserves the
 * original author by default -- env-forced identity only affects the
 * committer during a plain rebase, so an explicit reauthor pass on the
 * range is the only way to also rewrite the author.
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @param {{identity: {name: string, email: string}, fixtureIdentityPattern: string}} config
 * @returns {{rewritten: boolean, count: number}}
 */
export function reauthorUnpushedCommitsToAiIdentity(cwd, baseRef, config) {
  const range = `${baseRef}..HEAD`;

  const revList = spawnSync('git', ['rev-list', range], { cwd, encoding: 'utf8' });
  const shas = (revList.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (shas.length === 0) {
    return { rewritten: false, count: 0 };
  }

  // `rebase --exec amend` linearizes the range and would silently drop a merge
  // commit (and re-author published second-parent history). A range carrying a
  // first-parent merge is re-created with plumbing instead.
  if (hasFirstParentMerge(cwd, range)) return reauthorRangePreservingMerges(cwd, baseRef, config);

  const log = spawnSync(
    'git',
    ['log', range, '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce'],
    { cwd, encoding: 'utf8' },
  );

  const rows = (log.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, authorName, authorEmail, committerName, committerEmail] = line.split('\x1f');
      return { sha, authorName, authorEmail, committerName, committerEmail };
    });

  // Fail-closed: never silently rewrite a fixture identity out of history.
  const fixtureHits = [];
  for (const row of rows) {
    const fields = [
      ['authorName', row.authorName],
      ['authorEmail', row.authorEmail],
      ['committerName', row.committerName],
      ['committerEmail', row.committerEmail],
    ];
    for (const [field, value] of fields) {
      if (looksLikeFixtureGitIdentity(value, value, config)) {
        fixtureHits.push(`${row.sha} ${field}="${value}"`);
      }
    }
  }
  if (fixtureHits.length > 0) {
    throw new Error(
      `Refusing to reauthor commits: fixture identity found in range ${range}:\n` +
      fixtureHits.join('\n'),
    );
  }

  // No-op check: already fully authored/committed as the configured identity.
  const alreadyCorrect = rows.every((row) => (
    row.authorName === config.identity.name &&
    row.authorEmail === config.identity.email &&
    row.committerName === config.identity.name &&
    row.committerEmail === config.identity.email
  ));
  if (alreadyCorrect) {
    return { rewritten: false, count: rows.length };
  }

  const rebaseArgs = [
    ...gitIdentityArgs(config),
    'rebase', baseRef, '--exec',
    'git commit --amend --reset-author --no-edit',
  ];
  assertNoForbiddenMergeStrategy(rebaseArgs);
  const rebase = spawnSync(
    'git',
    rebaseArgs,
    { cwd, env: gitIdentityEnv(config) },
  );

  if (rebase.status !== 0) {
    spawnSync('git', ['rebase', '--abort'], { cwd });
    throw new Error(
      `git rebase --exec reauthor failed for range ${range} (exit ${rebase.status}): ` +
      `${rebase.stderr || rebase.stdout || ''}`,
    );
  }

  return { rewritten: true, count: rows.length };
}

function authorDateOf(identityLine) {
  const match = /> (\d+ [+-]\d{4})$/.exec(identityLine || '');
  return match ? match[1] : undefined;
}

function identityOf(identityLine) {
  const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(identityLine || '');
  return match ? { name: match[1], email: match[2] } : { name: '', email: '' };
}

/**
 * Merge-preserving counterpart of the rebase-based reauthor above. Re-creates
 * ONLY the commits in `baseRef..HEAD` that are not already published (not
 * reachable from `baseRef` nor from any `config.sharedHistoryRefs` ref),
 * parents first, with `git commit-tree`: same tree, parents remapped onto the
 * already re-created commits, original message and author date, configured AI
 * identity as author and committer. A merge commit therefore keeps both parents
 * and its tree (including any conflict resolution), and published second-parent
 * history keeps its original ids -- which is what makes the merged-in branch an
 * ancestor of the target after the push. Fails closed on a fixture-shaped
 * identity, like the linear path.
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @param {{identity: {name: string, email: string}, fixtureIdentityPattern: string, sharedHistoryRefs?: string[]}} config
 * @returns {{rewritten: boolean, count: number, preservedMerges: true}}
 */
export function reauthorRangePreservingMerges(cwd, baseRef, config) {
  const range = `${baseRef}..HEAD`;
  const shas = listUnpublishedCommitsTopo(cwd, baseRef, config);
  if (shas.length === 0) return { rewritten: false, count: 0, preservedMerges: true };

  const commits = shas.map((sha) => readCommitObject(cwd, sha));
  const fixtureHits = [];
  for (const commit of commits) {
    for (const [field, line] of [['author', commit.author], ['committer', commit.committer]]) {
      const { name, email } = identityOf(line);
      for (const [kind, value] of [['name', name], ['email', email]]) {
        if (value && looksLikeFixtureGitIdentity(value, value, config)) {
          fixtureHits.push(`${commit.sha.slice(0, 10)} ${field} ${kind}="${value}"`);
        }
      }
    }
  }
  if (fixtureHits.length > 0) {
    throw new Error(
      `Refusing to reauthor commits: fixture identity found in range ${range}:\n${fixtureHits.join('\n')}`,
    );
  }

  const isAi = (line) => {
    const { name, email } = identityOf(line);
    return name === config.identity.name && email === config.identity.email;
  };
  const remap = new Map();
  let rewrittenCount = 0;
  for (const commit of commits) {
    const parents = commit.parents.map((parent) => remap.get(parent) || parent);
    const parentsChanged = parents.some((parent, index) => parent !== commit.parents[index]);
    if (!parentsChanged && isAi(commit.author) && isAi(commit.committer)) {
      remap.set(commit.sha, commit.sha);
      continue;
    }
    const env = gitIdentityEnv(config);
    const date = authorDateOf(commit.author);
    if (date) env.GIT_AUTHOR_DATE = date;
    const created = spawnSync(
      'git',
      [...gitIdentityArgs(config), 'commit-tree', commit.tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'],
      { cwd, encoding: 'utf8', input: commit.message, env },
    );
    if (created.status !== 0) {
      throw new Error(`merge-preserving reauthor of ${commit.sha.slice(0, 10)} failed: ${(created.stderr || '').trim()}`);
    }
    remap.set(commit.sha, created.stdout.trim());
    rewrittenCount += 1;
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const newHead = remap.get(head) || head;
  if (newHead !== head) {
    const reset = spawnSync('git', ['reset', '--hard', newHead], { cwd, encoding: 'utf8', env: gitIdentityEnv(config) });
    if (reset.status !== 0) {
      throw new Error(`merge-preserving reauthor could not move HEAD to ${newHead}: ${(reset.stderr || '').trim()}`);
    }
  }
  return { rewritten: newHead !== head, count: rewrittenCount, preservedMerges: true };
}
