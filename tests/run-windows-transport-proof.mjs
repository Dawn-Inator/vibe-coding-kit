import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TRANSPORT_CASES = Object.freeze([
  'finish: a git network call that hangs is killed at the hold limit, the lock is released, and the error says so',
  'finish: retry backoff consumes the same hold deadline and parent-exit descendants are reaped',
]);
const MAX_TARGET_DURATION_MS = 120_000;
const CLEANUP_MARGIN_MS = 30_000;
export const TRANSPORT_PROOF_TIMEOUT_MS = TRANSPORT_CASES.length * MAX_TARGET_DURATION_MS + CLEANUP_MARGIN_MS;
const PATTERN = `^(?:${TRANSPORT_CASES.map(escapeRegExp).join('|')})$`;
const MAX_TRANSCRIPT_STREAM_BYTES = 12 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function boundedStream(label, value) {
  const text = String(value ?? '');
  if (text.length === 0) return `${label}: (empty)`;
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_TRANSCRIPT_STREAM_BYTES) return `${label}:\n${text}`;
  const excerpt = bytes.subarray(0, MAX_TRANSCRIPT_STREAM_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
  return `${label} (first ${MAX_TRANSCRIPT_STREAM_BYTES} of ${bytes.length} bytes; truncated):\n${excerpt}\n...[${bytes.length - MAX_TRANSCRIPT_STREAM_BYTES} bytes omitted]`;
}

function childTranscript(result) {
  return [boundedStream('stdout (TAP)', result.stdout), boundedStream('stderr', result.stderr)].join('\n');
}

export function transportProofOutputVerdict(output) {
  const results = new Map(TRANSPORT_CASES.map((name) => [name, []]));
  const resultLine = /^\s*(not )?ok\s+\d+\s+-\s+(.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/u;
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const match = resultLine.exec(line);
    if (!match || !results.has(match[2])) continue;
    results.get(match[2]).push({ passed: !match[1] && !match[3], skipped: Boolean(match[3]) });
  }
  const missingOrDuplicate = TRANSPORT_CASES.filter((name) => results.get(name).length !== 1);
  const notPassed = TRANSPORT_CASES.filter((name) => results.get(name).length === 1 && !results.get(name)[0].passed);
  const passedCount = TRANSPORT_CASES.filter((name) => results.get(name).length === 1 && results.get(name)[0].passed).length;
  return { ok: missingOrDuplicate.length === 0 && notPassed.length === 0 && passedCount === 2, missingOrDuplicate, notPassed, passedCount };
}

export function runTransportProof({ platform = process.platform, spawn = spawnSync, cwd = root, log = console.log, error = console.error } = {}) {
  if (platform !== 'win32') {
    error(`[windows-transport-proof] requires Windows; got ${platform}`);
    return 1;
  }
  const args = [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    `--test-name-pattern=${PATTERN}`,
    'tests/worktrees/cli.test.mjs',
  ];
  const result = spawn(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TRANSPORT_PROOF_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) {
    error(`[windows-transport-proof] node --test failed: ${result.error?.message || result.signal || `exit ${result.status}`}\n${childTranscript(result)}`);
    return 1;
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const verdict = transportProofOutputVerdict(output);
  if (!verdict.ok) {
    error(`[windows-transport-proof] expected exactly two passed transport results; missing/duplicate=${verdict.missingOrDuplicate.join(' | ') || '(none)'}; failed/skipped=${verdict.notPassed.join(' | ') || '(none)'}; passed=${verdict.passedCount}/2\n${childTranscript(result)}`);
    return 1;
  }
  log(`[windows-transport-proof] both transport-safety cases passed exactly once`);
  return 0;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length !== 0) {
    (dependencies.error ?? console.error)('[windows-transport-proof] this fixed proof accepts no arguments');
    return 2;
  }
  return runTransportProof(dependencies);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
