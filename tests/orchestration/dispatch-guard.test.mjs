// orchestration/dispatch-guard.test.mjs
//
// Decision table for the Agent/Task dispatch guard, role-definition lookup through real temp directories,
// the hook CLI as a child process, and a class guard on the settings snippet wiring.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../../src/worktrees/config.mjs';
import {
  GUARDED_TOOL_NAMES,
  RULE_IDS,
  decideDispatch,
  defaultAgentDirs,
  formatHookOutput,
  pinnedRoleModel,
  readDispatchGuardSettings,
} from '../../src/orchestration/dispatch-guard.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', '..', 'src', 'orchestration', 'dispatch-guard-hook.mjs');

function agentsDir(files) {
  const root = mkdtempTracked('dispatch-guard-agents-');
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { root, dir };
}

const role = (name, model) => `---\nname: ${name}\ndescription: test role\n${model === undefined ? '' : `model: ${model}\n`}---\n\nBody.\n`;

test('decision table: explicit model, pinned roles, fork and other tools', () => {
  const { dir } = agentsDir({
    'pinned.md': role('pinned', 'sonnet'),
    'inherits.md': role('inherits', 'inherit'),
    'unset.md': role('unset'),
    'broken.md': 'no frontmatter here',
  });
  const options = { agentDirs: [dir] };
  const cases = [
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'general-purpose' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x' } }, 'explicit-model'],
    [{ toolName: 'Task', toolInput: { prompt: 'x', subagent_type: 'Explore' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', model: '   ' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', model: 'sonnet' } }, null],
    [{ toolName: 'Task', toolInput: { prompt: 'x', subagent_type: 'Explore', model: 'haiku' } }, null],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'pinned' } }, null],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'inherits' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'unset' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'broken' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: '../pinned' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'plugin:pinned' } }, 'explicit-model'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'fork' } }, 'fork-dispatch'],
    [{ toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'fork', model: 'opus' } }, 'fork-dispatch'],
    [{ toolName: 'Bash', toolInput: { command: 'ls' } }, null],
    [{ toolName: 'Edit', toolInput: {} }, null],
  ];
  for (const [call, rule] of cases) {
    const decision = decideDispatch(call, options);
    assert.equal(decision.allow, rule === null, JSON.stringify(call));
    if (rule) {
      assert.equal(decision.rule, rule);
      assert.match(decision.reason, new RegExp(`\\(${rule}\\)`));
    }
  }
});

test('disabled rules behave as if deleted, and hints are appended', () => {
  const missing = { toolName: 'Agent', toolInput: { prompt: 'x' } };
  const fork = { toolName: 'Agent', toolInput: { prompt: 'x', subagent_type: 'fork' } };
  assert.equal(decideDispatch(missing, { disabledRules: ['explicit-model'] }).allow, true);
  assert.equal(decideDispatch(fork, { disabledRules: ['explicit-model'] }).allow, false);
  assert.equal(decideDispatch(fork, { disabledRules: ['fork-dispatch'] }).allow, true);
  assert.equal(decideDispatch(missing, { disabledRules: ['fork-dispatch'] }).allow, false);
  const hinted = decideDispatch(missing, { hints: { 'explicit-model': 'Project tier map: docs/models.md.' } });
  assert.match(hinted.reason, /Project tier map: docs\/models\.md\.$/);
  assert.deepEqual([...RULE_IDS].sort(), ['explicit-model', 'fork-dispatch']);
});

test('role lookup prefers the project directory and resolves only plain names', () => {
  const project = agentsDir({ 'shared.md': role('shared', 'haiku') });
  const user = agentsDir({ 'shared.md': role('shared', 'opus'), 'user-only.md': role('user-only', 'sonnet') });
  const dirs = [project.dir, user.dir];
  assert.equal(pinnedRoleModel('shared', dirs), 'haiku');
  assert.equal(pinnedRoleModel('user-only', dirs), 'sonnet');
  assert.equal(pinnedRoleModel('absent', dirs), null);
  assert.equal(pinnedRoleModel('a/b', dirs), null);
  assert.equal(pinnedRoleModel('', dirs), null);
  assert.deepEqual(defaultAgentDirs({ projectDir: '/p', home: '/h' }), [join('/p', '.claude', 'agents'), join('/h', '.claude', 'agents')]);
});

test('settings fall back per key and never throw', () => {
  assert.deepEqual(DEFAULT_CONFIG.dispatchGuard, { disabledRules: [], hints: {} });
  assert.deepEqual(readDispatchGuardSettings({ dispatchGuard: { disabledRules: ['fork-dispatch'] } }), { disabledRules: ['fork-dispatch'], hints: {} });
  assert.deepEqual(readDispatchGuardSettings({ dispatchGuard: { disabledRules: 'all', hints: [] } }), { disabledRules: [], hints: {} });
  assert.deepEqual(readDispatchGuardSettings({}), { disabledRules: [], hints: {} });
});

test('hook output carries a deny only for a blocked dispatch', () => {
  assert.deepEqual(formatHookOutput({ allow: true }), {});
  const out = formatHookOutput({ allow: false, rule: 'explicit-model', reason: 'r' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'r');
});

test('hook CLI: denies, allows through a project role, and fails open on garbage', () => {
  const project = agentsDir({ 'vck-module-owner.md': role('vck-module-owner', 'sonnet') });
  const home = mkdtempTracked('dispatch-guard-home-');
  const runHook = (input, env = {}) => spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: project.root,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project.root, WTG_CONFIG_PATH: '', ...env },
  });
  const denied = runHook({ tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'general-purpose' } });
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const pinned = runHook({ tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'vck-module-owner' } });
  assert.equal(pinned.status, 0);
  assert.deepEqual(JSON.parse(pinned.stdout), {});
  const explicit = runHook({ tool_name: 'Task', tool_input: { prompt: 'x', model: 'haiku' } });
  assert.deepEqual(JSON.parse(explicit.stdout), {});
  const garbage = runHook('not json');
  assert.equal(garbage.status, 0);
  assert.deepEqual(JSON.parse(garbage.stdout), {});
});

test('class guard: the settings snippet wires the hook exactly once on the Agent|Task matcher', () => {
  const snippet = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'claude-settings-snippet.json'), 'utf8'));
  const wired = snippet.hooks.PreToolUse.filter((entry) =>
    entry.hooks.some((h) => String(h.command).includes('dispatch-guard-hook.mjs')));
  assert.equal(wired.length, 1);
  assert.deepEqual(new Set(wired[0].matcher.split('|')), new Set(GUARDED_TOOL_NAMES));
  assert.equal(wired[0].matcher.split('|').length, GUARDED_TOOL_NAMES.length);
  assert.match(wired[0].hooks[0].command, /\.vibe-coding\/kit\/src\/orchestration\/dispatch-guard-hook\.mjs/);
  assert.equal(wired[0].hooks[0].type, 'command');
});
