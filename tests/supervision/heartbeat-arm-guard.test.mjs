import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import {
  decideHeartbeatArm,
  formatHookOutput,
  isHandRolledHeartbeat,
  isHeartbeatArmCommand,
  transcriptShowsSkillLoaded,
} from '../../src/supervision/heartbeat-arm-guard.mjs';

after(cleanupTempDirs);

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '../../src/supervision/heartbeat-arm-guard-hook.mjs');
const ARM = 'pnpm heartbeat:arm -- --ledger .workspace/2026-01-01-demo/heartbeat.md';

const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const SKILL_LOADED = toolUse('Skill', { skill: 'agent-task-supervision' });
const SKILL_READ = toolUse('Read', { file_path: '/repo/.claude/skills/agent-task-supervision/SKILL.md' });
const OTHER = toolUse('Read', { file_path: '/repo/README.md' });

function transcript(...lines) {
  const dir = mkdtempTracked('hb-guard-');
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('command recognition: the arm entry only; plain sleeps are untouched', () => {
  assert.ok(isHeartbeatArmCommand(ARM));
  assert.ok(isHeartbeatArmCommand('cd repo && pnpm run heartbeat:arm -- --probe'));
  assert.ok(isHeartbeatArmCommand('node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --probe'));
  assert.ok(!isHeartbeatArmCommand('pnpm heartbeat:armed'));
  assert.ok(!isHeartbeatArmCommand('git log'));
  assert.ok(isHandRolledHeartbeat('sleep 1200; echo "HEARTBEAT due"'));
  assert.ok(!isHandRolledHeartbeat('sleep 30; curl localhost:3000/health'));
  assert.ok(!isHandRolledHeartbeat(ARM));
});

test('transcriptShowsSkillLoaded: Skill call or SKILL.md read counts, a bare mention does not', () => {
  assert.equal(transcriptShowsSkillLoaded(`${OTHER}\n${SKILL_LOADED}`), true);
  assert.equal(transcriptShowsSkillLoaded(SKILL_READ), true);
  assert.equal(transcriptShowsSkillLoaded(OTHER), false);
  const mention = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'use agent-task-supervision please' }] } });
  assert.equal(transcriptShowsSkillLoaded(mention), false);
  assert.equal(transcriptShowsSkillLoaded('not json agent-task-supervision\n{broken'), false);
});

test('first arming is denied until the skill was loaded in the transcript', () => {
  const denied = decideHeartbeatArm({ toolName: 'Bash', toolInput: { command: ARM }, transcriptPath: transcript(OTHER) });
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /agent-task-supervision/);
  const out = formatHookOutput(denied);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');

  for (const lines of [[SKILL_LOADED], [OTHER, SKILL_READ]]) {
    assert.deepEqual(decideHeartbeatArm({ toolName: 'Bash', toolInput: { command: ARM }, transcriptPath: transcript(...lines) }), { allow: true });
  }
  assert.deepEqual(formatHookOutput({ allow: true }), {});
});

test('hand-rolled heartbeat timers are denied on Bash and Monitor regardless of the transcript', () => {
  for (const toolName of ['Bash', 'Monitor']) {
    const decision = decideHeartbeatArm({ toolName, toolInput: { command: 'sleep 1200; echo HEARTBEAT' }, transcriptPath: transcript(SKILL_LOADED) });
    assert.equal(decision.allow, false);
    assert.match(decision.reason, /heartbeat:arm/);
  }
});

test('the guard fails open: no transcript path, unreadable file, other tools, other commands', () => {
  assert.deepEqual(decideHeartbeatArm({ toolName: 'Bash', toolInput: { command: ARM } }), { allow: true });
  assert.deepEqual(decideHeartbeatArm({ toolName: 'Bash', toolInput: { command: ARM }, transcriptPath: '/nonexistent/t.jsonl' }), { allow: true });
  assert.deepEqual(decideHeartbeatArm({ toolName: 'Edit', toolInput: { command: ARM }, transcriptPath: transcript(OTHER) }), { allow: true });
  assert.deepEqual(decideHeartbeatArm({ toolName: 'Bash', toolInput: { command: 'ls' }, transcriptPath: transcript(OTHER) }), { allow: true });
  assert.deepEqual(decideHeartbeatArm({ toolName: 'Bash', toolInput: undefined }), { allow: true });
});

function runHook(input) {
  return spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input });
}

test('hook CLI: prints hook-output JSON and always exits 0', () => {
  const path = transcript(OTHER);
  const deny = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: ARM }, transcript_path: path }));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const allow = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: ARM }, transcript_path: transcript(SKILL_LOADED) }));
  assert.equal(allow.status, 0);
  assert.deepEqual(JSON.parse(allow.stdout), {});
});

test('hook CLI: garbage, empty or non-object stdin fails open with {} and exit 0', () => {
  for (const input of ['{{{ not json', '', 'null', '[]', '42']) {
    const result = runHook(input);
    assert.equal(result.status, 0, `input ${JSON.stringify(input)}`);
    assert.deepEqual(JSON.parse(result.stdout), {}, `input ${JSON.stringify(input)}`);
  }
});
