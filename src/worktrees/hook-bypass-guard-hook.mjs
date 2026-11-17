#!/usr/bin/env node
// worktree-guard/hook-bypass-guard-hook.mjs
//
// Claude Code PreToolUse hook wrapper for hook-bypass-guard.mjs (Bash matcher): hook input JSON on stdin
// (`tool_name`, `tool_input`, `cwd`), hook output JSON on stdout, ALWAYS exit 0 (the decision is carried by
// hookSpecificOutput.permissionDecision, not the exit code). Any parse or runtime failure is treated as "allow"
// (fail open). Project knobs come from config `hookBypassGuard` (loaded relative to the process cwd).
//
// Hand-test:
//   echo '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}' | node hook-bypass-guard-hook.mjs

import { decideHookBypassTool, formatHookOutput, readHookBypassSettings } from './hook-bypass-guard.mjs';
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
    const decision = decideHookBypassTool(
      { toolName: input.tool_name, toolInput: input.tool_input || {} },
      readHookBypassSettings(),
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
