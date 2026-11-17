// worktree-guard/hook-bypass-guard.test.mjs
//
// Pure-function table for the Bash hook-bypass guard, plus the real hook CLI as a child process and a
// class guard on the settings snippet. Platform neutral: no git repository and no platform branch.
//
// Node built-ins only, zero third-party dependencies, ESM.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DEFAULT_CONFIG } from '../../src/worktrees/config.mjs';
import {
  RULE_IDS,
  decideHookBypass,
  decideHookBypassTool,
  formatHookOutput,
  readHookBypassSettings,
} from '../../src/worktrees/hook-bypass-guard.mjs';
import { lexShell } from '../../src/worktrees/hook-bypass-guard-lexer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', '..', 'src', 'worktrees', 'hook-bypass-guard-hook.mjs');

// [command, expected rule | null (allow)].
const CASES = [
  // -- no-verify --
  ['git commit --no-verify -m "x"', 'no-verify'],
  ['git commit -n -m x', 'no-verify'],
  ['git commit -nm "x"', 'no-verify'],
  ['git commit -anm "x"', 'no-verify'],
  ['git push --no-verify origin HEAD', 'no-verify'],
  ['git push origin HEAD --no-verify', 'no-verify'],
  ['git merge --no-verify topic', 'no-verify'],
  ['git commit --no-ver -m x', 'no-verify'],
  ['git commit --no-"verify" -m x', 'no-verify'],
  ['git -C /some/dir commit --no-verify -m x', 'no-verify'],
  ['cd /x && git add -A && git commit --no-verify -m x', 'no-verify'],
  ['git add . ; git commit -n', 'no-verify'],
  ['npm run lint | tee l.txt && git commit -nm x', 'no-verify'],
  ['env GIT_AUTHOR_NAME=a git commit --no-verify', 'no-verify'],
  ['bash -c "git commit --no-verify -m x"', 'no-verify'],
  ["sh -lc 'cd w && git push --no-verify'", 'no-verify'],
  ['echo $(git commit -n -m x)', 'no-verify'],
  ['$GIT commit --no-verify', 'no-verify'],
  ['git commit -m "unterminated --no-verify', 'no-verify'],
  ['cat <<EOF | bash\ngit commit --no-verify\nEOF', 'no-verify'],
  // -- hooks-path --
  ['git -c core.hooksPath=/dev/null commit -m x', 'hooks-path'],
  ['git -c core.hooksPath= commit -m x', 'hooks-path'],
  ['git -ccore.hooksPath=/x push', 'hooks-path'],
  ['git --config core.hooksPath=/x commit', 'hooks-path'],
  ['git --config-env=core.hooksPath=HP commit', 'hooks-path'],
  ['git config core.hooksPath /dev/null', 'hooks-path'],
  ['GIT_CONFIG_KEY_0=core.hooksPath git commit', 'hooks-path'],
  // -- husky-skip --
  ['HUSKY=0 git commit -m x', 'husky-skip'],
  ['HUSKY=0 npm install', 'husky-skip'],
  ['env HUSKY=0 git push', 'husky-skip'],
  ['HUSKY_SKIP_HOOKS=1 git commit -m x', 'husky-skip'],
  ['SKIP=eslint git commit -m x', 'husky-skip'],
  ['SKIP=1 npm run release', 'husky-skip'],
  ['export HUSKY=0', 'husky-skip'],
  ['HUSKY=0; git commit -m x', 'husky-skip'],
  // -- git-stash --
  ['git stash', 'git-stash'],
  ['git stash pop', 'git-stash'],
  ['git stash push -m wip', 'git-stash'],
  ['git -C /w stash', 'git-stash'],
  ['git -c user.name=a stash list', 'git-stash'],
  ['git --git-dir=.git stash', 'git-stash'],
  ['cd w && git diff > p && git stash', 'git-stash'],
  ['git stash\ngit pull', 'git-stash'],
  // -- allowed: legitimate and false-positive shapes --
  ['git commit -m "fix: x"', null],
  ['git commit -am "wip"', null],
  ['git commit -m "--no-verify"', null],
  ['git commit -am "do not use -n"', null],
  ['git commit -mn', null],
  ['git commit -- -n', null],
  ['git commit -m x # --no-verify', null],
  ['git push -n origin HEAD', null],
  ['git push --dry-run', null],
  ['git push origin HEAD', null],
  ['git status && git diff --stat', null],
  ['git stash-helper', null],
  ['git log --grep=stash', null],
  ['git config --get core.hooksPath', null],
  ['git -c user.name=a commit -m x', null],
  ['grep -- --no-verify file', null],
  ['grep -rn "HUSKY=0" docs/', null],
  ['echo "git commit --no-verify"', null],
  ["echo 'git stash' > note.txt", null],
  ['cat <<EOF\ngit commit --no-verify\nHUSKY=0 git push\nEOF', null],
  ['cat > f.md <<\'EOF\'\nnever run git stash or --no-verify\nEOF\ngit status', null],
  ['printf "%s" "HUSKY=0" | wc -c', null],
  ['npm test', null],
  ['HUSKY=1 git commit -m x', null],
  ['bash -c "git status"', null],
  ['', null],
];

test('table: every command gets the expected verdict (>= 25 positive and >= 25 negative cases)', () => {
  const positives = CASES.filter(([, rule]) => rule !== null).length;
  const negatives = CASES.filter(([, rule]) => rule === null).length;
  assert.ok(positives >= 25, `positives=${positives}`);
  assert.ok(negatives >= 25, `negatives=${negatives}`);
  for (const [command, rule] of CASES) {
    const d = decideHookBypass(command);
    if (rule === null) assert.equal(d.allow, true, `should ALLOW: ${JSON.stringify(command)} (${d.reason ?? ''})`);
    else {
      assert.equal(d.allow, false, `should DENY [${rule}]: ${JSON.stringify(command)}`);
      assert.equal(d.rule, rule, `wrong rule for ${JSON.stringify(command)}`);
    }
  }
});

test('deny message names the rule and the guard', () => {
  for (const rule of RULE_IDS) {
    const sample = CASES.find(([, r]) => r === rule)[0];
    assert.match(decideHookBypass(sample).reason, new RegExp(`hook-bypass-guard/${rule}`));
  }
});

test('mutation proof: deleting one rule flips exactly that rule\'s cases to allowed', () => {
  for (const rule of RULE_IDS) {
    const own = CASES.filter(([, r]) => r === rule);
    assert.ok(own.length >= 5, `rule ${rule} needs >= 5 table cases, has ${own.length}`);
    for (const [command] of own) {
      assert.equal(decideHookBypass(command, { disabledRules: [rule] }).allow, true, `with ${rule} deleted, ${JSON.stringify(command)} must go through`);
    }
    for (const [command, other] of CASES) {
      if (other === null || other === rule) continue;
      assert.equal(decideHookBypass(command, { disabledRules: [rule] }).allow, false, `${rule} deleted must not weaken ${other}: ${JSON.stringify(command)}`);
    }
  }
});

test('config knobs: hints, extra bypass variables and skip-sensitive programs', () => {
  const hinted = decideHookBypass('git commit --no-verify', { hints: { 'no-verify': 'Run the project check script instead.' } });
  assert.match(hinted.reason, /hook-bypass-guard\/no-verify/);
  assert.match(hinted.reason, /Run the project check script instead\.$/);
  assert.doesNotMatch(decideHookBypass('git commit --no-verify').reason, /project check script/);

  assert.equal(decideHookBypass('LEFTHOOK=0 git commit -m x').allow, true);
  const extra = decideHookBypass('LEFTHOOK=0 git commit -m x', { extraBypassEnvNames: ['LEFTHOOK'] });
  assert.equal(extra.allow, false);
  assert.equal(extra.rule, 'husky-skip');

  assert.equal(decideHookBypass('SKIP=a make build').allow, false);
  assert.equal(decideHookBypass('SKIP=a make build', { skipSensitivePrograms: ['git'] }).allow, true);
  assert.equal(decideHookBypass('SKIP=a git commit -m x', { skipSensitivePrograms: ['git'] }).allow, false);
});

test('readHookBypassSettings: defaults, valid overrides, and invalid values fall back per key', () => {
  assert.deepEqual(readHookBypassSettings(DEFAULT_CONFIG), {
    disabledRules: [],
    skipSensitivePrograms: DEFAULT_CONFIG.hookBypassGuard.skipSensitivePrograms,
    extraBypassEnvNames: [],
    hints: {},
  });
  const custom = readHookBypassSettings({ hookBypassGuard: { disabledRules: ['git-stash'], extraBypassEnvNames: 'nope', hints: { 'git-stash': 'x' } } });
  assert.deepEqual(custom.disabledRules, ['git-stash']);
  assert.deepEqual(custom.extraBypassEnvNames, []);
  assert.deepEqual(custom.hints, { 'git-stash': 'x' });
  assert.deepEqual(readHookBypassSettings({}).disabledRules, []);
});

test('lexer: splits operators, unquotes words and collects heredoc bodies', () => {
  const lex = lexShell('a "b c" && d $(e f) <<EOF\nbody\nEOF\n');
  assert.deepEqual(lex.commands.map((c) => c.words.map((w) => w.text)), [['a', 'b c'], ['d', '$(…)']]);
  assert.deepEqual(lex.nested, ['e f']);
  assert.deepEqual(lex.heredocBodies, ['body']);
  assert.equal(lexShell("echo 'unterminated").ambiguous, true);
});

test('tool wrapper: Bash only, fail open on bad input, deny output shape', () => {
  const denied = decideHookBypassTool({ toolName: 'Bash', toolInput: { command: 'git commit --no-verify' } });
  assert.equal(denied.allow, false);
  const out = formatHookOutput(denied);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decideHookBypassTool({ toolName: 'Edit', toolInput: { command: 'git commit --no-verify' } }).allow, true);
  assert.equal(decideHookBypassTool({ toolName: 'Bash', toolInput: {} }).allow, true);
  assert.equal(decideHookBypassTool({ toolName: 'Bash', toolInput: { command: 42 } }).allow, true);
  assert.deepEqual(formatHookOutput({ allow: true }), {});
});

function runHook(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(r.error, undefined, `hook did not run: ${r.error?.message}`);
  return r;
}

test('hook CLI: exits 0, denies via JSON, passes clean commands and garbage stdin', () => {
  const bad = runHook({ tool_name: 'Bash', tool_input: { command: 'git stash' } });
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), {});
  const garbage = runHook('not json');
  assert.equal(garbage.status, 0);
  assert.deepEqual(JSON.parse(garbage.stdout), {});
});

test('class guard: the settings snippet wires the hook exactly once on the Bash matcher', () => {
  const snippet = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'claude-settings-snippet.json'), 'utf8'));
  const wired = snippet.hooks.PreToolUse.filter((entry) =>
    entry.hooks.some((h) => String(h.command).includes('hook-bypass-guard-hook.mjs')));
  assert.equal(wired.length, 1);
  assert.deepEqual(wired[0].matcher.split('|'), ['Bash']);
  assert.match(wired[0].hooks[0].command, /\.vibe-coding\/kit\/src\/worktrees\/hook-bypass-guard-hook\.mjs/);
  assert.equal(wired[0].hooks[0].type, 'command');
});
