#!/usr/bin/env node
// orchestration/dispatch-guard-hook.mjs
//
// Claude Code PreToolUse hook wrapper for dispatch-guard.mjs (Agent|Task|mcp__claude-code-remote__create_session matcher; tool_name is passed to decideDispatch unchanged): hook input JSON on stdin
// (`tool_name`, `tool_input`, `cwd`), hook output JSON on stdout, ALWAYS exit 0 (the decision is carried by
// hookSpecificOutput.permissionDecision, not the exit code). Any parse or runtime failure is treated as
// "allow" (fail open). Project knobs come from config `dispatchGuard` (loaded relative to the process cwd).
// Role definitions are looked up in $CLAUDE_PROJECT_DIR (or the input cwd)/.claude/agents, then
// ~/.claude/agents.
//
// Hand-test:
//   echo '{"tool_name":"Agent","tool_input":{"prompt":"x","subagent_type":"general-purpose"}}' | node dispatch-guard-hook.mjs

import { decideDispatch, defaultAgentDirs, formatHookOutput, readDispatchGuardSettings } from './dispatch-guard.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';
import { isMainModule } from '../lib/main-module.mjs';

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => done(raw));
    process.stdin.on('error', () => done(raw));
  });
}

async function main() {
  let output = {};
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' ? input.cwd : process.cwd());
    const decision = decideDispatch(
      { toolName: input.tool_name, toolInput: input.tool_input || {} },
      { ...readDispatchGuardSettings(), agentDirs: defaultAgentDirs({ projectDir }) },
    );
    output = formatHookOutput(decision);
  } catch {
    output = {}; // garbage on stdin: fail open
  }
  process.stdout.write(JSON.stringify(output));
}

if (isMainModule(import.meta.url)) {
  main().then(() => exitDrained(0), () => exitDrained(0));
}
