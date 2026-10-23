import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { filesForGroup } from '../run-windows-diagnostic.mjs';
import { main as runNativeProof, NATIVE_CASES, nativeProofOutputVerdict } from '../run-windows-native-proof.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/windows-diagnostic.yml', import.meta.url), 'utf8');
const JOB_ORDER = [
  'windows-native-proof',
  'windows-hook-context',
  'windows-installer-proof',
  'windows-transport-proof',
  'windows-diagnostic',
];

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `workflow declares ${name}`);
  const nextStart = JOB_ORDER
    .map((job) => workflow.indexOf(`\n  ${job}:`))
    .filter((offset) => offset > start)
    .sort((left, right) => left - right)[0] ?? workflow.length;
  return workflow.slice(start, nextStart);
}

test('Windows diagnostic requires native directory and Job Object proofs before running the full manifest groups', () => {
  const proof = jobBlock('windows-native-proof');
  const groups = jobBlock('windows-diagnostic');
  assert.match(proof, /runs-on: windows-latest/u);
  assert.match(proof, /node-version: 22/u);
  assert.match(proof, /timeout-minutes: 15/u);
  assert.match(proof, /persist-credentials: false/u);
  assert.match(proof, /run: node tests\/run-windows-native-proof\.mjs/u);
  assert.equal(NATIVE_CASES.length, 10);

  assert.match(groups, /needs: windows-native-proof/u);
  assert.match(groups, /max-parallel: 3/u);
  assert.match(groups, /group: \['1', '2', '3'\]/u);
  assert.match(groups, /node tests\/run-windows-diagnostic\.mjs "\$\{\{ matrix\.group \}\}"/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:|secrets\./u);
});

test('native-only diagnostic refs run the bounded proof without running or claiming the full manifest groups', () => {
  const proof = jobBlock('windows-native-proof');
  const groups = jobBlock('windows-diagnostic');
  assert.match(proof, /if: startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-'\) && !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-installer-'\)/u);
  assert.match(proof, /run: node tests\/run-windows-native-proof\.mjs/u);
  assert.match(groups, /if: \$\{\{ !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-native-'\) && !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-hook-context-'\) && !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-transport-'\) && !startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-installer-'\) \}\}/u);
  assert.match(groups, /needs: windows-native-proof/u);
  assert.match(groups, /node tests\/run-windows-diagnostic\.mjs/u);
  assert.doesNotMatch(proof, /run:.*run-windows-diagnostic|tests\/run\.mjs/u);
});

test('Git hook context diagnostic runs only its fixed Node 20/22 regressions after native proofs', () => {
  const hook = jobBlock('windows-hook-context');
  assert.match(hook, /if: startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-hook-context-'\)/u);
  assert.match(hook, /needs: windows-native-proof/u);
  assert.match(hook, /runs-on: windows-latest/u);
  assert.match(hook, /matrix:\s+node: \['20', '22'\]/u);
  assert.match(hook, /node --test tests\/contracts\/project-adapter\.test\.mjs tests\/worktrees\/git-environment-boundary\.test\.mjs/u);
  assert.doesNotMatch(hook, /matrix\.group|run-windows-diagnostic|tests\/run\.mjs|\$\{\{\s*github\.event/u, 'the job accepts no caller-supplied test selection');

  const groups = jobBlock('windows-diagnostic');
  assert.match(groups, /!startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-hook-context-'\)/u);
  assert.match(groups, /matrix\.group/u);
});

test('installer diagnostic runs its fixed Node 20/22 tests and packaged CLI smoke without native or full groups', () => {
  const installer = jobBlock('windows-installer-proof');
  const native = jobBlock('windows-native-proof');
  const groups = jobBlock('windows-diagnostic');

  assert.match(installer, /if: startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-installer-'\)/u);
  assert.match(installer, /runs-on: windows-latest/u);
  assert.match(installer, /timeout-minutes: 15/u);
  assert.match(installer, /matrix:\s+node: \['20', '22'\]/u);
  assert.match(installer, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/u);
  assert.match(installer, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/u);
  assert.match(installer, /node-version: \$\{\{ matrix\.node \}\}/u);
  assert.match(installer, /persist-credentials: false/u);
  assert.match(installer, /node --test tests\/install\/command\.test\.mjs tests\/install\/init\.test\.mjs tests\/install\/bootstrap\.test\.mjs/u);
  assert.match(installer, /npm pack --pack-destination "\$RUNNER_TEMP"/u);
  assert.match(installer, /version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/u);
  assert.match(installer, /npm exec --offline --yes --cache "\$RUNNER_TEMP\/npm-cache" --package="\$RUNNER_TEMP\/vibe-coding-kit-\$version\.tgz" -- vibe-coding-kit help/u);
  assert.doesNotMatch(installer, /matrix\.group|github\.event|workflow_dispatch|input:/u, 'the installer proof accepts no caller-selected test list');
  assert.doesNotMatch(installer, /needs: windows-native-proof/u, 'the installer proof runs independently of native-process proof');
  assert.match(native, /!startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-installer-'\)/u);
  assert.match(groups, /!startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-installer-'\)/u);
});

test('transport diagnostic runs its fixed CLI proof on Node 20/22 after native proofs and excludes full groups', () => {
  const transport = jobBlock('windows-transport-proof');
  assert.match(transport, /if: startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-transport-'\)/u);
  assert.match(transport, /needs: windows-native-proof/u);
  assert.match(transport, /runs-on: windows-latest/u);
  assert.match(transport, /matrix:\s+node: \['20', '22'\]/u);
  assert.match(transport, /run: node tests\/run-windows-transport-proof\.mjs/u);
  assert.doesNotMatch(transport, /run-windows-diagnostic|matrix\.group|github\.event/u);

  const groups = jobBlock('windows-diagnostic');
  assert.match(groups, /!startsWith\(github\.ref, 'refs\/heads\/diagnostic\/windows-transport-'\)/u);
  assert.match(groups, /matrix\.group/u);
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
  assert.equal(runNativeProof([], {
    platform: 'win32',
    spawn,
    env: { PATH: 'proof-path', PROOF_TEST_SENTINEL: 'preserved', VIBE_KIT_REQUIRE_PRIVILEGED_DELETE_PROOF: '0' },
    error: (message) => errors.push(message),
  }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.match(calls[0].args[0], /--test/u);
  assert.ok(calls[0].args.includes('--test-reporter=tap'));
  assert.ok(calls[0].args.includes('--test-concurrency=1'));
  assert.ok(calls[0].args.includes('tests/worktrees/process-provenance.test.mjs'));
  assert.ok(calls[0].args.includes('tests/worktrees/windows-git-job.test.mjs'));
  assert.ok(calls[0].args.some((arg) => arg.startsWith('--test-name-pattern=')));
  assert.equal(calls[0].options.env.VIBE_KIT_REQUIRE_PRIVILEGED_DELETE_PROOF, '1');
  assert.equal(calls[0].options.env.PROOF_TEST_SENTINEL, 'preserved');
  assert.equal(calls[0].options.env.PATH, 'proof-path');

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
