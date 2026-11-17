import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from './isolated-git-env.mjs';
import { mkdtempTracked } from './temp-dirs.mjs';
import { decidePrimaryWrite } from '../../src/worktrees/primary-write-guard.mjs';

const env = isolatedFixtureGitEnv();

export function git(cwd, ...args) {
  const r = spawnSync('git', withFixtureCommitIdentity(args), { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A primary checkout (one commit) plus a sibling linked worktree and one nested inside
// the primary directory. Everything is addressed through the realpath of the temp dir;
// `viaLink` is a symlink to the same primary.
export function fixture() {
  const base = realpathSync(mkdtempTracked('wtg-primary-guard-'));
  const primary = join(base, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  writeFileSync(join(primary, 'README.md'), 'x\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'init');
  const sibling = join(base, 'sibling-wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'feat-a', sibling);
  const nested = join(primary, 'nested-wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'feat-b', nested);
  const viaLink = join(base, 'link-to-primary');
  symlinkSync(primary, viaLink, process.platform === 'win32' ? 'junction' : 'dir');
  return { base, primary, sibling, nested, viaLink };
}

export const write = (file_path, cwd, extra = {}) =>
  decidePrimaryWrite({ toolName: 'Write', toolInput: { file_path }, cwd, ...extra });

