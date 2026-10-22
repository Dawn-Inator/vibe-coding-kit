// Shared, deliberately narrow heuristic for reports that end by announcing an action
// without evidence that it started. Consumers may add domain-specific background-wait
// markers while keeping the detection algorithm in one place.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinSync } from '../lib/sync-stdin.mjs';

const BACKGROUND_WAIT_PATTERNS = [
  /\b(background|backgrounded|nohup|disowned|run_in_background|monitor tool|polling|waiting for (its|the|a) notification|detached)\b/i,
];

const EXECUTION_EVIDENCE_RE =
  /(```|\bexit code\b|\bPASS\b|\bFAIL\b|\bcommitted\b|\bpushed\b|\bmerged\b|\b[0-9a-f]{7,40}\b.*\b(sha|commit)\b|\bcommit\b.*\b[0-9a-f]{7,40}\b|\bverdict\b|\bdone\.|\bfinished\b|\bcompleted\b)/i;

const ANNOUNCEMENT_RE =
  /^(now\s+(let'?s|i'?ll|i\s+will|i'?m\s+going\s+to)|let'?s\s+\w|let\s+me\s+now\b|next[,:]?\s+i'?ll|i'?ll\s+.+\snext\.?$|going\s+to\s+\w)/i;

function lastSubstantiveSentence(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  const sentences = lastLine.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.length > 0 ? sentences[sentences.length - 1] : lastLine;
}

/**
 * Detect a bare announced next action at the end of a report.
 * @param {string} text
 * @param {{ backgroundWaitPatterns?: RegExp[], backgroundWaitReason?: string }} options
 * @returns {{ stall: boolean, reason: string }}
 */
export function detectAnnouncementStall(text, {
  backgroundWaitPatterns = [],
  backgroundWaitReason = 'mentions a background/queued wait -- not treated as a stall',
} = {}) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { stall: false, reason: 'empty text' };
  if ([...BACKGROUND_WAIT_PATTERNS, ...backgroundWaitPatterns].some((pattern) => pattern.test(trimmed))) {
    return { stall: false, reason: backgroundWaitReason };
  }
  if (EXECUTION_EVIDENCE_RE.test(trimmed)) {
    return { stall: false, reason: 'contains execution evidence (code block, result, commit, verdict)' };
  }
  const last = lastSubstantiveSentence(trimmed);
  if (ANNOUNCEMENT_RE.test(last)) {
    return { stall: true, reason: `last line reads as an announcement with no evidence behind it: "${last}"` };
  }
  return { stall: false, reason: 'no announcement pattern matched on the final line' };
}

function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try {
    return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

function readInput(argv) {
  const fileFlag = argv.indexOf('--file');
  if (fileFlag !== -1) {
    const path = argv[fileFlag + 1];
    return path ? readFileSync(resolve(process.cwd(), path), 'utf8') : null;
  }
  const positional = argv.find((arg) => arg !== '--' && !arg.startsWith('--'));
  if (positional) return positional;
  return readStdinSync() || null;
}

if (isMainModule(import.meta.url)) {
  try {
    const text = readInput(process.argv.slice(2));
    if (text === null || text.trim() === '') {
      process.stderr.write('usage: detect-announcement-stall.mjs "<text>" | echo "<text>" | detect-announcement-stall.mjs | detect-announcement-stall.mjs --file <path>\n');
      process.exitCode = 2;
    } else {
      const result = detectAnnouncementStall(text);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.stall ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`detect-announcement-stall: ${error.message}\n`);
    process.exitCode = 2;
  }
}
