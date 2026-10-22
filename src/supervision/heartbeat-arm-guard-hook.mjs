#!/usr/bin/env node
// Claude Code PreToolUse hook CLI wrapper for heartbeat-arm-guard.mjs (Bash matcher). Reads the
// hook input JSON on stdin, prints hook output JSON, always exits 0; any failure fails open.

import { decideHeartbeatArm, formatHookOutput } from './heartbeat-arm-guard.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';

function readStdin() {
  return new Promise((resolveP) => {
    let raw = '';
    if (process.stdin.isTTY) {
      resolveP('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolveP(raw));
    process.stdin.on('error', () => resolveP(raw));
  });
}

async function main() {
  let output = {};
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    output = formatHookOutput(
      decideHeartbeatArm({
        toolName: input.tool_name,
        toolInput: input.tool_input || {},
        transcriptPath: input.transcript_path,
      }),
    );
  } catch {
    output = {};
  }
  process.stdout.write(JSON.stringify(output));
}

main().then(() => exitDrained(0));
