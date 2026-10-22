// PreToolUse guard for `pnpm heartbeat:arm`: the first arming in a session is denied until the
// transcript shows the `agent-task-supervision` skill was loaded (a Skill tool call, or a read of
// its SKILL.md). Wired on the Bash matcher via heartbeat-arm-guard-hook.mjs.
//
// The guard only checks a precondition against the transcript it is handed. It keeps no state, runs
// no timer and writes nothing, so there is nothing for it to get out of sync with.
//
// Fail OPEN on anything we cannot read (no transcript path, unreadable file, bad JSON): a guard bug
// must never block a legitimate tool call. Only the one entry point is recognised on purpose -- the
// supervision skill says heartbeats are armed with `pnpm heartbeat:arm` and nothing else.

import { readFileSync } from 'node:fs';

const ARM_COMMAND_RE =
  /(?:^|[\s;&|(])(?:(?:pnpm|npm|yarn)\s+(?:run\s+)?heartbeat:arm|node\s+\S*heartbeat-arm\.mjs)(?=$|[\s;&|)])/;
const SKILL_NAME = 'agent-task-supervision';
// A hand-rolled heartbeat: a sleep timer whose command names itself a heartbeat. These are redirected
// to `pnpm heartbeat:arm` instead of slipping past the guard. A plain `sleep` that waits on a concrete
// event (no heartbeat wording) is untouched.
const SLEEP_RE = /\bsleep\s+\d/;
const HEARTBEAT_WORD_RE = /heartbeat/i;

export function isHeartbeatArmCommand(command) {
  return typeof command === 'string' && ARM_COMMAND_RE.test(command);
}

export function isHandRolledHeartbeat(command) {
  return (
    typeof command === 'string' &&
    !isHeartbeatArmCommand(command) &&
    SLEEP_RE.test(command) &&
    HEARTBEAT_WORD_RE.test(command)
  );
}

export function transcriptShowsSkillLoaded(transcriptText) {
  for (const line of transcriptText.split('\n')) {
    if (!line.includes(SKILL_NAME)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const input = block.input || {};
      if (block.name === 'Skill' && String(input.skill || '').endsWith(SKILL_NAME)) return true;
      if (block.name === 'Read' && String(input.file_path || '').includes(`${SKILL_NAME}/SKILL.md`)) return true;
    }
  }
  return false;
}

export function decideHeartbeatArm({ toolName, toolInput, transcriptPath, readFile = readFileSync }) {
  if ((toolName === 'Bash' || toolName === 'Monitor') && isHandRolledHeartbeat(toolInput?.command)) {
    return {
      allow: false,
      reason:
        'Hand-rolled heartbeat timers are not allowed. Load the `agent-task-supervision` skill, then arm with ' +
        '`pnpm heartbeat:arm -- --ledger .workspace/task/<session>/heartbeat.md` (background shell; ' +
        'probe first with `pnpm heartbeat:arm -- --probe`).',
    };
  }
  if (toolName !== 'Bash' || !isHeartbeatArmCommand(toolInput?.command)) return { allow: true };
  if (!transcriptPath) return { allow: true };
  let text;
  try {
    text = readFile(transcriptPath, 'utf8');
  } catch {
    return { allow: true };
  }
  if (transcriptShowsSkillLoaded(text)) return { allow: true };
  return {
    allow: false,
    reason:
      'Before arming a heartbeat, load the `agent-task-supervision` skill and follow it: ' +
      'arm the 75 s delivery probe first (`pnpm heartbeat:arm -- --probe`), yield, and only then arm the real timer ' +
      'with `--ledger .workspace/task/<session>/heartbeat.md`. Then re-run this command.',
  };
}

export function formatHookOutput(decision) {
  if (decision.allow) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}
