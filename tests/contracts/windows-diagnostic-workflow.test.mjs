import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { filesForGroup } from '../run-windows-diagnostic.mjs';
import { main as runNativeProof, NATIVE_CASES, nativeProofOutputVerdict } from '../run-windows-native-proof.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/windows-diagnostic.yml', import.meta.url), 'utf8');

test('Windows diagnostic requires native directory and Job Object proofs before running the full manifest groups', () => {
  const proofStart = workflow.indexOf('\n  windows-native-proof:');
  const groupsStart = workflow.indexOf('\n  windows-diagnostic:');
  assert.ok(proofStart >= 0 && groupsStart > proofStart, 'the native proof job is declared before the manifest matrix');

  const proof = workflow.slice(proofStart, groupsStart);
  assert.match(proof, /runs-on: windows-latest/u);
  assert.match(proof, /node-version: 22/u);
  assert.match(proof, /timeout-minutes: 15/u);
  assert.match(proof, /persist-credentials: false/u);
  assert.match(proof, /run: node tests\/run-windows-native-proof\.mjs/u);
  assert.equal(NATIVE_CASES.length, 10);

  const groups = workflow.slice(groupsStart);
  assert.match(groups, /needs: windows-native-proof/u);
  assert.match(groups, /max-parallel: 3/u);
  assert.match(groups, /group: \['1', '2', '3'\]/u);
  assert.match(groups, /node tests\/run-windows-diagnostic\.mjs "\$\{\{ matrix\.group \}\}"/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:|secrets\./u);
});

test('native-only diagnostic refs run the bounded proof without running or claiming the full manifest groups', () => {
  const proofStart = workflow.indexOf('\n  windows-native-proof:');
  const groupsStart = workflow.indexOf('\n  windows-diagnostic:');
  const proof = workflow.slice(proofStart, groupsStart);
  const groups = workflow.slice(groupsStart);
  assert.match(proof, /if: startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-'\)/u);
  assert.match(proof, /run: node tests\/run-windows-native-proof\.mjs/u);
  assert.match(groups, /if: \$\{\{ !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-native-'\) \}\}/u);
  assert.match(groups, /needs: windows-native-proof/u);
  assert.match(groups, /node tests\/run-windows-diagnostic\.mjs/u);
  assert.doesNotMatch(proof, /run:.*run-windows-diagnostic|tests\/run\.mjs/u);
});

const passingTap = `TAP version 13\n${NATIVE_CASES.map((name, index) => `ok ${index + 1} - ${name}`).join('\n')}\n`;

test('native proof accepts exactly ten passed native results without depending on unrelated TAP counts', () => {
  assert.deepEqual(nativeProofOutputVerdict(passingTap), { ok: true, missingOrDuplicate: [], notPassed: [] });
  assert.equal(nativeProofOutputVerdict(`${passingTap}1..2\n# tests 2\n# pass 2\n` ).ok, true);
});

test('native proof rejects missing, renamed, skipped, duplicate, and failed cases', () => {
  const [cwdCase, aclCase] = NATIVE_CASES;
  for (const output of [
    `ok 1 - ${cwdCase}\n`,
    `ok 1 - renamed test\nok 2 - ${aclCase}\n`,
    `ok 1 - ${cwdCase} # SKIP not Windows\nok 2 - ${aclCase}\n`,
    `ok 1 - ${cwdCase}\nok 2 - ${cwdCase}\nok 3 - ${aclCase}\n`,
    `not ok 1 - ${cwdCase}\nok 2 - ${aclCase}\n`,
    `ok 1 - ${cwdCase} # TODO later\nok 2 - ${aclCase}\n`,
  ]) assert.equal(nativeProofOutputVerdict(output).ok, false);
  for (const skippedTitle of NATIVE_CASES) {
    const outputWithOneSkip = NATIVE_CASES.map((name, index) => `ok ${index + 1} - ${name}${name === skippedTitle ? ' # SKIP host lacks Windows Job Objects' : ''}`).join('\n');
    assert.equal(nativeProofOutputVerdict(outputWithOneSkip).ok, false, `${skippedTitle} cannot be skipped in the native proof`);
  }
});

test('native proof executes only its fixed Windows command and propagates child failure', () => {
  const calls = [];
  const errors = [];
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, stdout: passingTap, stderr: '' };
  };
  assert.equal(runNativeProof([], { platform: 'win32', spawn, error: (message) => errors.push(message) }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.match(calls[0].args[0], /--test/u);
  assert.ok(calls[0].args.includes('--test-reporter=tap'));
  assert.ok(calls[0].args.includes('--test-concurrency=1'));
  assert.ok(calls[0].args.includes('tests/worktrees/process-provenance.test.mjs'));
  assert.ok(calls[0].args.includes('tests/worktrees/windows-git-job.test.mjs'));
  assert.ok(calls[0].args.some((arg) => arg.startsWith('--test-name-pattern=')));

  assert.equal(runNativeProof([], { platform: 'win32', spawn: () => ({ status: 1, stdout: passingTap, stderr: '' }), error: (message) => errors.push(message) }), 1);
  assert.match(errors[0], /stdout \(TAP\):\nTAP version 13/u, 'the failed child TAP transcript remains visible');
  assert.equal(runNativeProof([], { platform: 'linux', spawn: () => { throw new Error('must not spawn'); }, error: (message) => errors.push(message) }), 1);
  assert.equal(runNativeProof(['node', 'arbitrary'], { platform: 'win32', spawn: () => { throw new Error('must not spawn'); }, error: (message) => errors.push(message) }), 2);
  assert.equal(errors.length, 3);
});

test('native proof preserves bounded child stdout and stderr when results fail validation', () => {
  const errors = [];
  const stdout = `TAP version 13\n${NATIVE_CASES.slice(1).map((name, index) => `ok ${index + 1} - ${name}`).join('\n')}\n${'extra transcript line\n'.repeat(2000)}`;
  const stderr = `native stderr diagnostic\n${'detail\n'.repeat(2000)}`;
  const status = runNativeProof([], {
    platform: 'win32',
    spawn: () => ({ status: 0, stdout, stderr }),
    error: (message) => errors.push(message),
  });
  assert.equal(status, 1);
  assert.match(errors[0], /stdout \(TAP\) \(first 12288 of .* bytes; truncated\):/u);
  assert.match(errors[0], /stderr \(first 12288 of .* bytes; truncated\):/u);
  assert.match(errors[0], /native job|probeWindowsDirectoryDeleteSafety/u);
  assert.match(errors[0], /native stderr diagnostic/u);
  assert.ok(Buffer.byteLength(errors[0]) < 30 * 1024, 'diagnostics are bounded across both child streams');
});

test('Windows diagnostic groups partition the complete registered test manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const groups = ['1', '2', '3'].map((id) => filesForGroup(manifest, id));
  const selected = groups.flat();
  assert.equal(new Set(selected).size, selected.length, 'a manifest test belongs to one group only');
  assert.deepEqual([...selected].sort(), [...manifest].sort(), 'every registered test belongs to a group');
  assert.ok(groups.every((files) => files.length > 0));
});
