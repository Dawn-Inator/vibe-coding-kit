import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { main as runNativeProof, NATIVE_CASES, nativeProofOutputVerdict } from '../run-windows-native-proof.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/windows-system-diagnostic.yml', import.meta.url), 'utf8');
const JOB_ORDER = [
  'native-process-safety',
  'git-hook-context',
  'packaged-installer',
  'cli-process-tree',
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

test('Windows system diagnostic runs on main pushes or manual dispatch, never on per-attempt branches', () => {
  const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
  assert.match(trigger, /push:\s+branches:\s+- main\s+paths:/u);
  assert.match(trigger, /\n  workflow_dispatch:\s*$/u, 'manual dispatch takes no caller-supplied inputs');
  assert.doesNotMatch(workflow, /diagnostic\/|candidate\/|refs\/heads\/|\n    if:|inputs:|secrets\.|github\.event/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /permissions:\s+contents: read/u);
  assert.deepEqual([...workflow.matchAll(/^  ([a-z-]+):$/gmu)].map((match) => match[1]).filter((name) => JOB_ORDER.includes(name)), JOB_ORDER);
  assert.doesNotMatch(workflow, /run-windows-diagnostic|matrix\.group|tests\/run\.mjs/u, 'the full manifest on Windows runs in ci.yml');
});

test('every repository script the Windows system diagnostic invokes exists', () => {
  const scripts = [...workflow.matchAll(/\b(tests\/[\w./-]+\.mjs)\b/gu)].map((match) => match[1]);
  assert.ok(scripts.length >= 4);
  for (const script of scripts) assert.ok(existsSync(new URL(`../../${script}`, import.meta.url)), `${script} exists`);
});

test('native process safety proof runs on Node 22 with pinned actions and no persisted credentials', () => {
  const proof = jobBlock('native-process-safety');
  assert.match(proof, /runs-on: windows-latest/u);
  assert.match(proof, /node-version: 22/u);
  assert.match(proof, /timeout-minutes: 15/u);
  assert.match(proof, /persist-credentials: false/u);
  assert.match(proof, /run: node tests\/run-windows-native-proof\.mjs/u);
  assert.doesNotMatch(proof, /needs:/u);
  assert.equal(NATIVE_CASES.length, 10);
});

test('Git hook context runs only its fixed Node 20/22 regressions after native proofs', () => {
  const hook = jobBlock('git-hook-context');
  assert.match(hook, /needs: native-process-safety/u);
  assert.match(hook, /runs-on: windows-latest/u);
  assert.match(hook, /matrix:\s+node: \['20', '22'\]/u);
  assert.match(hook, /node --test tests\/contracts\/project-adapter\.test\.mjs tests\/worktrees\/git-environment-boundary\.test\.mjs/u);
});

test('packaged installer runs its fixed Node 20/22 tests and packaged CLI smoke independently', () => {
  const installer = jobBlock('packaged-installer');
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
  assert.doesNotMatch(installer, /needs:/u, 'the installer check runs independently of native-process proof');
});

test('CLI process-tree check runs its fixed transport proof on Node 20/22 after native proofs', () => {
  const transport = jobBlock('cli-process-tree');
  assert.match(transport, /needs: native-process-safety/u);
  assert.match(transport, /runs-on: windows-latest/u);
  assert.match(transport, /matrix:\s+node: \['20', '22'\]/u);
  assert.match(transport, /run: node tests\/run-windows-transport-proof\.mjs/u);
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
