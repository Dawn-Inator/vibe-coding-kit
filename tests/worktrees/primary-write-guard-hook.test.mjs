// worktree-guard/primary-write-guard-hook.test.mjs
//
// Runs the real hook CLI as a child process with hand-fed stdin JSON, against a real
// scratch git repo. Run with:
//   node --test primary-write-guard-hook.test.mjs
//
// Node built-ins only, zero third-party dependencies, ESM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isolatedFixtureGitEnv,
  withFixtureCommitIdentity,
} from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const hook = join(dirname(fileURLToPath(import.meta.url)), 'primary-write-guard-hook.mjs');
const env = isolatedFixtureGitEnv();

function git(cwd, ...args) {
  const r = spawnSync('git', withFixtureCommitIdentity(args), { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

function runHook(stdin) {
  const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fixture() {
  const base = realpathSync(mkdtempTracked('wtg-primary-guard-hook-'));
  const primary = join(base, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  writeFileSync(join(primary, 'README.md'), 'x\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'init');
  const worktree = join(base, 'wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'feat', worktree);
  return { primary, worktree };
}

const payload = (tool_name, file_path, cwd) => JSON.stringify({ tool_name, tool_input: { file_path }, cwd });

test('primary write: deny JSON on stdout, exit 0', () => {
  const { primary } = fixture();
  const r = runHook(payload('Edit', join(primary, 'a.txt'), primary));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /worktree/);
  assert.equal('continue' in out, false);
});

test('worktree write, allow-listed path and non-file tools: empty JSON, exit 0', () => {
  const { primary, worktree } = fixture();
  for (const input of [
    payload('Write', join(worktree, 'a.txt'), primary),
    payload('Write', join(primary, '.workspace', 'a.md'), primary),
    payload('Read', join(primary, 'a.txt'), primary),
    payload('Bash', join(primary, 'a.txt'), primary),
  ]) {
    const r = runHook(input);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {});
  }
});

test('garbage or empty stdin fails open', () => {
  for (const input of ['not json {{', '', '[]', 'null', '{"tool_name":"Write"}']) {
    const r = runHook(input);
    assert.equal(r.status, 0, input);
    assert.deepEqual(JSON.parse(r.stdout), {}, input);
  }
});
