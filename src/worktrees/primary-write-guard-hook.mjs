#!/usr/bin/env node
// worktree-guard/primary-write-guard-hook.mjs
//
// Claude Code PreToolUse hook wrapper for primary-write-guard.mjs: hook input JSON on
// stdin (`tool_name`, `tool_input`, `cwd`), hook output JSON on stdout, ALWAYS exit 0
// (the decision is carried by hookSpecificOutput.permissionDecision, not the exit
// code). Any parse or runtime failure is treated as "allow" (fail open).
//
// Hand-test:
//   echo '{"tool_name":"Write","tool_input":{"file_path":"/abs/primary/x.txt"},"cwd":"/abs/primary"}' \
//     | node primary-write-guard-hook.mjs

import { decidePrimaryWrite, formatHookOutput } from './primary-write-guard.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';

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
  let decision = { allow: true };
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    decision = decidePrimaryWrite({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      cwd: input.cwd,
    });
  } catch {
    // Garbage on stdin: fail open.
  }
  process.stdout.write(JSON.stringify(formatHookOutput(decision)));
}

main().then(() => exitDrained(0), () => exitDrained(0));
