import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, runTransportProof, TRANSPORT_CASES, transportProofOutputVerdict } from '../run-windows-transport-proof.mjs';

const passingTap = `TAP version 13\n${TRANSPORT_CASES.map((name, index) => `ok ${index + 1} - ${name}`).join('\n')}\n`;

test('transport proof accepts exactly two passed target results and ignores unrelated filter skips', () => {
  const output = `TAP version 13\nok 1 - another test # SKIP test name does not match pattern\n${passingTap}`;
  assert.deepEqual(transportProofOutputVerdict(output), {
    ok: true,
    missingOrDuplicate: [],
    notPassed: [],
    passedCount: 2,
  });
});

test('transport proof rejects zero, missing, skipped, cancelled, duplicate, and fewer-than-two passes', () => {
  const [hangCase, retryCase] = TRANSPORT_CASES;
  const failures = [
    '',
    `ok 1 - ${hangCase}\n`,
    `ok 1 - ${hangCase} # SKIP platform unsupported\nok 2 - ${retryCase}\n`,
    `not ok 1 - ${hangCase}\nok 2 - ${retryCase}\n`,
    `ok 1 - ${hangCase}\nok 2 - ${hangCase}\nok 3 - ${retryCase}\n`,
    `ok 1 - ${hangCase}\nnot ok 2 - ${retryCase} # cancelled\n`,
    `ok 1 - ${hangCase} # TODO later\nok 2 - ${retryCase}\n`,
  ];
  for (const output of failures) assert.equal(transportProofOutputVerdict(output).ok, false, output);
});

test('transport proof runs only its fixed Windows title pattern and CLI test file', () => {
  const calls = [];
  const errors = [];
  const logs = [];
  assert.equal(runTransportProof({
    platform: 'win32',
    cwd: 'fixture-root',
    spawn: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, stdout: passingTap, stderr: '' };
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args.slice(0, 3), ['--test', '--test-reporter=tap', '--test-concurrency=1']);
  assert.equal(calls[0].args[3], `--test-name-pattern=^(?:${TRANSPORT_CASES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`);
  assert.deepEqual(calls[0].args.slice(4), ['tests/worktrees/cli.test.mjs']);
  assert.equal(calls[0].options.cwd, 'fixture-root');
  assert.equal(calls[0].options.timeout, 90_000);
  assert.match(logs[0], /both transport-safety cases passed exactly once/u);
  assert.deepEqual(errors, []);

  assert.equal(main(['arbitrary'], { platform: 'win32', spawn: () => { throw new Error('must not spawn'); }, error: (message) => errors.push(message) }), 2);
  assert.equal(runTransportProof({ platform: 'linux', spawn: () => { throw new Error('must not spawn'); }, error: (message) => errors.push(message) }), 1);
  assert.equal(errors.length, 2);
});

test('transport proof fails when the child fails or the exact targets are absent', () => {
  const errors = [];
  assert.equal(runTransportProof({ platform: 'win32', spawn: () => ({ status: 1, stdout: passingTap, stderr: 'child failed' }), error: (message) => errors.push(message) }), 1);
  assert.match(errors[0], /node --test failed/u);
  assert.equal(runTransportProof({ platform: 'win32', spawn: () => ({ status: 0, stdout: 'TAP version 13\n# tests 0\n# pass 0\n', stderr: '' }), error: (message) => errors.push(message) }), 1);
  assert.match(errors[1], /passed=0\/2/u);
});
