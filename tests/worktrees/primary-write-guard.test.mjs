// worktree-guard/primary-write-guard.test.mjs
//
// Exercises primary-write-guard.mjs against REAL scratch git repositories and real
// `git worktree add` checkouts -- no mocking of git. Run with:
//   node --test primary-write-guard.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isolatedFixtureGitEnv,
  withFixtureCommitIdentity,
} from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
import {
  GUARDED_TOOL_NAMES,
  DEFAULT_ALLOW_PREFIXES,
  decidePrimaryWrite,
  formatHookOutput,
  readAllowPrefixes,
  resolvePrimaryRoot,
} from '../../src/worktrees/primary-write-guard.mjs';

after(cleanupTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const env = isolatedFixtureGitEnv();

function git(cwd, ...args) {
  const r = spawnSync('git', withFixtureCommitIdentity(args), { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A primary checkout (one commit) plus a sibling linked worktree and one nested inside
// the primary directory. Everything is addressed through the realpath of the temp dir;
// `viaLink` is a symlink to the same primary.
function fixture() {
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

const write = (file_path, cwd, extra = {}) =>
  decidePrimaryWrite({ toolName: 'Write', toolInput: { file_path }, cwd, ...extra });

test('write into the primary checkout is denied with an actionable reason', () => {
  const { primary } = fixture();
  const d = write(join(primary, 'src', 'new.txt'), primary);
  assert.equal(d.allow, false);
  assert.match(d.reason, /worktree:begin/);
  assert.doesNotMatch(d.reason, /WTG_|bypass|env/i);
  assert.equal(write(join(primary, 'README.md'), primary).allow, false);
});

test('the deny output carries permissionDecision only, never continue:false', () => {
  const out = formatHookOutput({ allow: false, reason: 'r' });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' },
  });
  assert.deepEqual(formatHookOutput({ allow: true }), {});
});

test('a path inside a linked worktree is allowed, from either cwd', () => {
  const { primary, sibling } = fixture();
  assert.equal(write(join(sibling, 'a.txt'), sibling).allow, true);
  assert.equal(write(join(sibling, 'a.txt'), primary).allow, true);
  assert.equal(samePathIdentity(resolvePrimaryRoot(sibling), primary), true);
});

test('a worktree nested under the primary directory is not primary-owned', () => {
  const { primary, nested } = fixture();
  assert.equal(write(join(nested, 'deep', 'a.txt'), nested).allow, true);
  assert.equal(write(join(nested, 'deep', 'a.txt'), primary).allow, true);
  assert.equal(write(join(primary, 'other.txt'), nested).allow, false);
});

test('allow-listed prefixes stay writable; look-alikes and edits elsewhere do not', () => {
  const { primary } = fixture();
  assert.deepEqual([...DEFAULT_ALLOW_PREFIXES], ['.workspace/']);
  assert.equal(write(join(primary, '.workspace', 'x', 'ledger.md'), primary).allow, true);
  assert.equal(write(join(primary, '.workspace-evil', 'x.md'), primary).allow, false);
  const custom = { allowPrefixes: ['notes/'] };
  assert.equal(write(join(primary, 'notes', 'a.md'), primary, custom).allow, true);
  assert.equal(write(join(primary, '.workspace', 'a.md'), primary, custom).allow, false);
});

test('readAllowPrefixes: config key wins, absent or malformed falls back to the default', () => {
  assert.deepEqual(readAllowPrefixes({ primaryWriteGuard: { allowPrefixes: ['a/'] } }), ['a/']);
  assert.deepEqual(readAllowPrefixes({}), ['.workspace/']);
  assert.deepEqual(readAllowPrefixes({ primaryWriteGuard: { allowPrefixes: 'a/' } }), ['.workspace/']);
  assert.deepEqual(readAllowPrefixes({ primaryWriteGuard: { allowPrefixes: [1] } }), ['.workspace/']);
});

test('a relative file_path resolves against the hook cwd', () => {
  const { primary, sibling } = fixture();
  assert.equal(write('src/a.txt', primary).allow, false);
  assert.equal(write('.workspace/a.md', primary).allow, true);
  assert.equal(write('src/a.txt', sibling).allow, true);
  assert.equal(write('../primary/src/a.txt', sibling).allow, false);
});

test('a symlinked path to the primary is still recognised, even for a new file', () => {
  const { primary, sibling, viaLink } = fixture();
  assert.equal(write(join(viaLink, 'new-dir', 'a.txt'), sibling).allow, false);
  assert.equal(write(join(viaLink, 'a.txt'), viaLink).allow, false);
  assert.equal(samePathIdentity(resolvePrimaryRoot(viaLink), primary), true);
});

test('Windows drive/case aliases still resolve to the protected primary tree', { skip: process.platform !== 'win32' && 'Windows path alias behavior' }, () => {
  const { primary } = fixture();
  const casingAlias = primary.replace(/[a-z]/g, (letter, index) => (index % 2 === 0 ? letter.toUpperCase() : letter));
  assert.notEqual(casingAlias, primary);
  assert.equal(write(join(casingAlias, 'new-dir', 'file.txt'), casingAlias).allow, false);
});

test('NotebookEdit uses notebook_path and MultiEdit uses file_path', () => {
  const { primary, sibling } = fixture();
  const nb = (notebook_path) =>
    decidePrimaryWrite({ toolName: 'NotebookEdit', toolInput: { notebook_path }, cwd: primary });
  assert.equal(nb(join(primary, 'n.ipynb')).allow, false);
  assert.equal(nb(join(sibling, 'n.ipynb')).allow, true);
  const me = decidePrimaryWrite({ toolName: 'MultiEdit', toolInput: { file_path: join(primary, 'a') }, cwd: primary });
  assert.equal(me.allow, false);
});

test('unrelated tools and unusable input are allowed', () => {
  const { primary } = fixture();
  const target = join(primary, 'a.txt');
  assert.equal(decidePrimaryWrite({ toolName: 'Read', toolInput: { file_path: target }, cwd: primary }).allow, true);
  assert.equal(decidePrimaryWrite({ toolName: 'Bash', toolInput: { command: `echo > ${target}` }, cwd: primary }).allow, true);
  assert.equal(decidePrimaryWrite({ toolName: 'Write', toolInput: {}, cwd: primary }).allow, true);
  assert.equal(decidePrimaryWrite({ toolName: 'Write', toolInput: { file_path: 7 }, cwd: primary }).allow, true);
  assert.equal(decidePrimaryWrite().allow, true);
});

test('fail open: cwd outside any git repository is allowed', () => {
  const outside = realpathSync(mkdtempTracked('wtg-primary-guard-nogit-'));
  assert.equal(resolvePrimaryRoot(outside), null);
  assert.equal(write(join(outside, 'a.txt'), outside).allow, true);
  assert.equal(write(join(outside, 'a.txt'), join(outside, 'does-not-exist')).allow, true);
});

test('class guard: the settings snippet matcher equals GUARDED_TOOL_NAMES', () => {
  assert.ok(Object.isFrozen(GUARDED_TOOL_NAMES));
  const snippet = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'claude-settings-snippet.json'), 'utf8'));
  const entries = snippet.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.deepEqual(new Set(entries[0].matcher.split('|')), new Set(GUARDED_TOOL_NAMES));
  assert.equal(entries[0].matcher.split('|').length, GUARDED_TOOL_NAMES.length);
  assert.match(entries[0].hooks[0].command, /\.vibe-coding\/kit\/src\/worktrees\/primary-write-guard-hook\.mjs/);
});
