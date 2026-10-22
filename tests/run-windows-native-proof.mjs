import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_CASES = Object.freeze([
  'probeWindowsDirectoryDeleteSafety: live Windows child CWD blocks its nested directory, then succeeds after exit',
  'probeWindowsDirectoryDeleteSafety: Windows DELETE denial is reported unsafe and ACL is restored',
  'native job captures stdout, stderr, and exit status',
  'native job enforces a combined output-byte cap while continuing to drain pipes',
  'native cancellation contains a parent-exited descendant and preserves unrelated processes',
  'native timeout terminates all job members but leaves unrelated process alive',
  'native setup and assignment failures never resume the requested command',
  'native bare git.exe resolves through the child PATH and missing commands fail closed',
  'native immediate cancellation before controller readiness never runs the target',
  'native expired startup deadline cancels before the target entry point',
]);
const PATTERN = `^(?:${NATIVE_CASES.map(escapeRegExp).join('|')})$`;
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

export function nativeProofOutputVerdict(output) {
  const results = new Map(NATIVE_CASES.map((name) => [name, []]));
  const resultLine = /^\s*(not )?ok\s+\d+\s+-\s+(.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/u;
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const match = resultLine.exec(line);
    if (!match || !results.has(match[2])) continue;
    results.get(match[2]).push({ passed: !match[1] && !match[3], skipped: Boolean(match[3]) });
  }
  const missingOrDuplicate = NATIVE_CASES.filter((name) => results.get(name).length !== 1);
  const notPassed = NATIVE_CASES.filter((name) => results.get(name).length === 1 && !results.get(name)[0].passed);
  return { ok: missingOrDuplicate.length === 0 && notPassed.length === 0, missingOrDuplicate, notPassed };
}

export function runNativeProof({ platform = process.platform, spawn = spawnSync, cwd = root, log = console.log, error = console.error } = {}) {
  if (platform !== 'win32') {
    error(`[windows-native-proof] requires Windows; got ${platform}`);
    return 1;
  }
  const args = [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    `--test-name-pattern=${PATTERN}`,
    'tests/worktrees/process-provenance.test.mjs',
    'tests/worktrees/windows-git-job.test.mjs',
  ];
  const result = spawn(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.signal) {
    error(`[windows-native-proof] node --test failed: ${result.error?.message || result.signal || `exit ${result.status}`}\n${childTranscript(result)}`);
    return 1;
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const verdict = nativeProofOutputVerdict(output);
  if (!verdict.ok) {
    error(`[windows-native-proof] expected exactly one passed result for each native case; missing/duplicate=${verdict.missingOrDuplicate.join(' | ') || '(none)'}; failed/skipped=${verdict.notPassed.join(' | ') || '(none)'}\n${childTranscript(result)}`);
    return 1;
  }
  log(`[windows-native-proof] all ${NATIVE_CASES.length} native process-safety cases passed exactly once`);
  return 0;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length !== 0) {
    (dependencies.error ?? console.error)('[windows-native-proof] this fixed proof accepts no arguments');
    return 2;
  }
  return runNativeProof(dependencies);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
