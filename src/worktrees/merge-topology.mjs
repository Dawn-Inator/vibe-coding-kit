// worktree-guard/merge-topology.mjs
//
// Git-topology helpers for finishing a branch that carries a MERGE commit of its
// own (typically a back-merge: `git merge --no-ff origin/main` made inside a
// worktree whose base branch is `develop`).
//
// Why this exists: `git rebase <target>` replays only the non-merge commits of a
// branch, so the merge commit silently disappears. The back-merge then lands as
// nothing (or as empty provenance commits) and the ancestry link the merge was
// made to create never reaches the remote. A finish must therefore not rebase such
// a branch; it either keeps the merge as it is or re-does the merge on the new tip.
//
// Vocabulary: a "preserved merge" is a merge commit on the FIRST-PARENT chain of
// `<target>..HEAD`, i.e. a merge this branch itself performed. Merge commits that
// merely sit inside the second-parent side (the other branch's own history) are
// already published and are never touched.
//
// Plain git plumbing only. Nothing here depends on the identity or lock modules,
// so git-identity.mjs can import it without a cycle.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { gitLines, gitRaw } from './worktree-core.mjs';

/** Used when a config object carries no `sharedHistoryRefs` (an override that dropped the key). */
export const DEFAULT_SHARED_HISTORY_REFS = Object.freeze(['refs/remotes/origin/main']);

/**
 * Refs whose commits are already published: `finish` must never rewrite a commit
 * reachable from one of these, or everyone who already has it is desynchronised.
 *
 * @param {{sharedHistoryRefs?: string[]}} [config]
 * @returns {string[]}
 */
export function sharedHistoryRefsOf(config) {
  return Array.isArray(config?.sharedHistoryRefs) ? config.sharedHistoryRefs : [...DEFAULT_SHARED_HISTORY_REFS];
}

/** Shared-history refs that actually exist in this repo. */
export function sharedHistoryTips(cwd, config) {
  return sharedHistoryRefsOf(config).filter(
    (ref) => gitRaw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).status === 0,
  );
}

/**
 * First-parent merge commits in `range`, oldest first, with their parents.
 *
 * @param {string} cwd
 * @param {string} range e.g. `origin/develop..HEAD`
 * @returns {{sha: string, parents: string[]}[]}
 */
export function listFirstParentMerges(cwd, range) {
  return gitLines(['rev-list', '--merges', '--first-parent', '--reverse', '--parents', range], cwd).map((line) => {
    const [sha, ...parents] = line.trim().split(/\s+/);
    return { sha, parents };
  });
}

export function hasFirstParentMerge(cwd, range) {
  return listFirstParentMerges(cwd, range).length > 0;
}

export function isAncestor(cwd, ancestor, descendant) {
  return gitRaw(['merge-base', '--is-ancestor', ancestor, descendant], cwd).status === 0;
}

/**
 * Commits that are unpublished -- reachable from HEAD but not from `baseRef` and
 * not from any shared-history ref -- parents first. These are the only commits a
 * finish may re-create.
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @param {{sharedHistoryRefs?: string[]}} [config]
 * @returns {string[]}
 */
export function listUnpublishedCommitsTopo(cwd, baseRef, config) {
  const exclude = sharedHistoryTips(cwd, config).map((ref) => `^${ref}`);
  return gitLines(['rev-list', '--reverse', '--topo-order', 'HEAD', `^${baseRef}`, ...exclude], cwd);
}

/**
 * Parse `git cat-file commit <sha>` into header fields and the raw message.
 *
 * @param {string} cwd
 * @param {string} sha
 * @returns {{sha: string, tree: string, parents: string[], author: string, committer: string, message: string}}
 */
export function readCommitObject(cwd, sha) {
  const result = gitRaw(['cat-file', 'commit', sha], cwd);
  if (result.status !== 0) throw new Error(`git cat-file commit ${sha} failed: ${result.stderr.trim()}`);
  const split = result.stdout.indexOf('\n\n');
  const header = split === -1 ? result.stdout : result.stdout.slice(0, split);
  const message = split === -1 ? '' : result.stdout.slice(split + 2);
  const commit = { sha, tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

function conflictedFiles(cwd) {
  return gitRaw(['diff', '--name-only', '-z', '--diff-filter=U'], cwd).stdout.split('\0').filter(Boolean);
}

/**
 * Re-do a branch's first-parent history on a moved target tip: reset to
 * `remoteRef`, then replay the first-parent chain `merge-base..origHead` --
 * cherry-pick every plain commit, `merge --no-ff` every merge with its original
 * message and non-first parents. Nothing is rebased, so the merge survives.
 *
 * On any conflict the merge/cherry-pick is aborted and HEAD is put back on
 * `origHead` exactly as it was; the returned `error` names the manual commands.
 * Never throws for a conflict.
 *
 * @param {string} cwd
 * @param {string} remoteRef the new target tip, e.g. `origin/develop`
 * @param {string} origHead HEAD before the redo
 * @param {{identityArgs: string[], env: NodeJS.ProcessEnv, run: (args: string[], cwd: string, options?: object) => {status: number|null, stdout: string, stderr: string}}} io
 *   identityArgs are spliced before every commit-creating git call; `run` is the
 *   caller's git runner (kept injectable so the caller can apply its own env/limits).
 * @returns {{ok: true, redone: number} | {ok: false, error: string, conflicts: string[]}}
 */
export function redoMergesOnTip(cwd, remoteRef, origHead, io) {
  const { identityArgs, env, run } = io;
  const mergeBase = run(['merge-base', remoteRef, origHead], cwd).stdout;
  if (!mergeBase) {
    return { ok: false, conflicts: [], error: `cannot redo the merge: no merge-base between ${remoteRef} and HEAD` };
  }
  const chain = gitLines(['rev-list', '--first-parent', '--reverse', '--parents', `${mergeBase}..${origHead}`], cwd).map((line) => {
    const [sha, ...parents] = line.trim().split(/\s+/);
    return { sha, parents };
  });

  const restore = () => {
    if (run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], cwd).status === 0) run(['merge', '--abort'], cwd);
    if (run(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], cwd).status === 0) run(['cherry-pick', '--abort'], cwd);
    run(['reset', '--hard', origHead], cwd);
  };

  const reset = run(['reset', '--hard', remoteRef], cwd, { env });
  if (reset.status !== 0) {
    restore();
    return { ok: false, conflicts: [], error: `could not move to ${remoteRef}: ${reset.stderr || reset.stdout}` };
  }
  for (const { sha, parents } of chain) {
    const isMerge = parents.length > 1;
    const step = isMerge
      ? run(
        [...identityArgs, 'merge', '--no-ff', '--no-verify', '-m', readCommitObject(cwd, sha).message.replace(/\n+$/, ''), ...parents.slice(1)],
        cwd,
        { env },
      )
      : run([...identityArgs, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', sha], cwd, { env });
    if (step.status !== 0) {
      const conflicts = conflictedFiles(cwd);
      const detail = (step.stderr || step.stdout || '').trim();
      restore();
      const source = isMerge ? parents.slice(1).map((p) => p.slice(0, 10)).join(' ') : sha.slice(0, 10);
      return {
        ok: false,
        conflicts,
        error:
          `could not re-do ${isMerge ? 'merge' : 'commit'} ${sha.slice(0, 10)} on the new ${remoteRef} tip `
          + `(HEAD restored to ${origHead.slice(0, 10)})`
          + `${conflicts.length ? `; conflicted file(s): ${conflicts.join(', ')}` : ''}. `
          + `Nothing was pushed. Redo it by hand in this worktree: git reset --hard ${remoteRef} && git merge --no-ff ${isMerge ? source : '<source branch>'} `
          + `(resolve the conflicts, commit), then run finish again; the pre-redo state is ${origHead}`
          + `${detail ? `. git said: ${detail}` : ''}`,
      };
    }
  }
  return { ok: true, redone: chain.length };
}
