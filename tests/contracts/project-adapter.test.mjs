import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProjectAdapter, PROJECT_ADAPTER_PHASES, runProjectHook } from '../../src/contracts/project-adapter.mjs';

async function consumer(adapterSource, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-project-adapter-'));
  const configDir = join(root, '.vibe-coding');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'project.config.json'), JSON.stringify({ schemaVersion: 1, adapter: 'adapter.mjs', ...config }));
  if (adapterSource !== null) await writeFile(join(root, 'adapter.mjs'), adapterSource);
  return root;
}

async function close(root) {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  while (true) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code) || Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50 * (attempt + 1), 300)));
      attempt += 1;
    }
  }
}

test('projects without config preserve legacy no-op behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-project-legacy-'));
  try {
    assert.equal((await loadProjectAdapter({ projectRoot: root })).applicable, false);
    assert.deepEqual(await runProjectHook({ projectRoot: root, phase: 'beforePush' }), {
      applicable: false, phase: 'beforePush', ok: true,
    });
  } finally { await close(root); }
});

test('loads two distinct consumer adapters and forwards lifecycle context', async () => {
  const first = await consumer(`export const adapterContract = { schemaVersion: 1, hooks: { beforeCandidate: 'checkFirst' } };\nexport async function checkFirst(context) { return { consumer: 'first', context }; }\n`);
  const second = await consumer(`export const adapterContract = { schemaVersion: 1, hooks: { beforeCandidate: 'checkSecond' } };\nexport async function checkSecond(context) { return { consumer: 'second', context }; }\n`);
  try {
    const context = { candidateSha: 'abc123', pin: 'def456', root: '/worktree' };
    const firstResult = await runProjectHook({ projectRoot: first, phase: 'beforeCandidate', context });
    const secondResult = await runProjectHook({ projectRoot: second, phase: 'beforeCandidate', context });
    const firstRoot = (await loadProjectAdapter({ projectRoot: first })).projectRoot;
    const secondRoot = (await loadProjectAdapter({ projectRoot: second })).projectRoot;
    assert.equal(firstResult.result.consumer, 'first');
    assert.equal(secondResult.result.consumer, 'second');
    assert.deepEqual(firstResult.result.context, { ...context, projectRoot: firstRoot, phase: 'beforeCandidate' });
    assert.deepEqual(secondResult.result.context, { ...context, projectRoot: secondRoot, phase: 'beforeCandidate' });
    assert.deepEqual(PROJECT_ADAPTER_PHASES, ['afterCreate', 'beforeCandidate', 'verifyCandidate', 'beforePush', 'afterLand']);
  } finally { await Promise.all([close(first), close(second)]); }
});

test('hook runner does not inherit Node test-worker ownership markers', async () => {
  const root = await consumer(`export const adapterContract = { schemaVersion: 1, hooks: { afterLand: 'readTestContext' } };\nexport async function readTestContext() { return process.env.NODE_TEST_CONTEXT ?? null; }\n`);
  const previous = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'test-worker-private-marker';
  try {
    const result = await runProjectHook({ projectRoot: root, phase: 'afterLand' });
    assert.equal(result.result, null, 'the adapter process is independent of Node test-runner worker ownership');
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
    await close(root);
  }
});

test('each hook phase executes a fresh transitive module graph', async () => {
  const root = await consumer(`import { policy } from './policy.mjs';\nexport const adapterContract = { schemaVersion: 1, hooks: { beforeCandidate: 'inspectPolicy' } };\nexport async function inspectPolicy() { return policy; }\n`);
  try {
    await writeFile(join(root, 'policy.mjs'), 'export const policy = "policy-A";\n');
    assert.equal((await runProjectHook({ projectRoot: root, phase: 'beforeCandidate' })).result, 'policy-A');
    await writeFile(join(root, 'policy.mjs'), 'export const policy = "policy-B";\n');
    assert.equal((await runProjectHook({ projectRoot: root, phase: 'beforeCandidate' })).result, 'policy-B');
  } finally { await close(root); }
});

test('fresh phase resolution follows changed transitive hook declarations', async () => {
  const changing = await consumer(`import { adapterContract } from './policy.mjs';\nexport { adapterContract };\nexport async function oldHandler() { return 'old-handler'; }\nexport async function newHandler(context) { return { selected: 'new-handler', phase: context.phase }; }\n`);
  const added = await consumer(`import { adapterContract } from './policy.mjs';\nexport { adapterContract };\nexport async function newlyAdded() { console.log('hook-log'); return 'added-handler'; }\n`);
  try {
    await writeFile(join(changing, 'policy.mjs'), `export const adapterContract = { schemaVersion: 1, hooks: { beforeCandidate: 'oldHandler' } };\n`);
    assert.equal((await runProjectHook({ projectRoot: changing, phase: 'beforeCandidate' })).result, 'old-handler');
    await writeFile(join(changing, 'policy.mjs'), `export const adapterContract = { schemaVersion: 1, hooks: { beforeCandidate: 'newHandler' } };\n`);
    assert.deepEqual((await runProjectHook({ projectRoot: changing, phase: 'beforeCandidate' })).result, {
      selected: 'new-handler', phase: 'beforeCandidate',
    });

    await writeFile(join(added, 'policy.mjs'), `export const adapterContract = { schemaVersion: 1, hooks: {} };\n`);
    assert.equal((await runProjectHook({ projectRoot: added, phase: 'afterLand' })).ran, false);
    await writeFile(join(added, 'policy.mjs'), `export const adapterContract = { schemaVersion: 1, hooks: { afterLand: 'newlyAdded' } };\n`);
    const logs = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk, ...args) => { logs.push(Buffer.from(chunk).toString('utf8')); return true; };
    try {
      const result = await runProjectHook({ projectRoot: added, phase: 'afterLand' });
      assert.equal(result.result, 'added-handler');
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(logs.join(''), /hook-log/u);
  } finally { await Promise.all([close(changing), close(added)]); }
});

test('configured adapter must exist, be valid, and stay under project root', async (t) => {
  const missing = await consumer(null);
  const malformed = await consumer('export const adapterContract = { schemaVersion: 2, hooks: {} };\n');
  const missingHandler = await consumer('export const adapterContract = { schemaVersion: 1, hooks: { afterLand: "notExported" } };\n');
  const escaping = await consumer(null, { adapter: '../outside.mjs' });
  try {
    await t.test('missing module', async () => assert.rejects(loadProjectAdapter({ projectRoot: missing }), /adapter is missing/));
    await t.test('invalid contract', async () => assert.rejects(loadProjectAdapter({ projectRoot: malformed }), /invalid contract/));
    await t.test('missing callback', async () => assert.rejects(loadProjectAdapter({ projectRoot: missingHandler }), /missing exported function/));
    await t.test('path traversal', async () => assert.rejects(loadProjectAdapter({ projectRoot: escaping }), /escapes the project root/));
    for (const value of [0, -1, 1.5, '250', 2_147_483_648, null]) {
      const invalidTimeout = await consumer('export const adapterContract = { schemaVersion: 1, hooks: {} };\n', {
        contracts: { hookTimeoutMs: value },
      });
      try {
        await t.test(`invalid hook timeout ${String(value)}`, async () =>
          assert.rejects(runProjectHook({ projectRoot: invalidTimeout, phase: 'afterLand' }), /hookTimeoutMs must be/u));
      } finally { await close(invalidTimeout); }
    }
  } finally { await Promise.all([close(missing), close(malformed), close(missingHandler), close(escaping)]); }
});

test('configured timeout, AbortSignal, and parent interruption terminate hook process trees', async (t) => {
  const adapterSource = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export const adapterContract = { schemaVersion: 1, hooks: { verifyCandidate: 'waitForAbort' } };
export async function waitForAbort({ pidFile }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, String(child.pid));
  await new Promise(() => {});
}
`;
  const timeoutRoot = await consumer(adapterSource, { contracts: { hookTimeoutMs: 400 } });
  const abortRoot = await consumer(adapterSource, { contracts: { hookTimeoutMs: 5_000 } });
  const parentExitRoot = await consumer(adapterSource, { contracts: { hookTimeoutMs: 5_000 } });
  const hardKillRoot = await consumer(adapterSource, { contracts: { hookTimeoutMs: 5_000 } });
  const overflowRoot = await consumer(`
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export const adapterContract = { schemaVersion: 1, hooks: { verifyCandidate: 'overflow' } };
export async function overflow({ pidFile }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, String(child.pid));
  process.stdout.write('x'.repeat(1_100_000));
  await new Promise(() => {});
}
`, { contracts: { hookTimeoutMs: 5_000 } });
  let interruptedParent;
  let interruptedParentExit;
  let timeoutTask;
  let abortTask;
  let controller;
  t.after(async () => {
    controller?.abort();
    await Promise.all([timeoutTask?.catch(() => {}), abortTask?.catch(() => {})]);
    if (interruptedParent && interruptedParent.exitCode === null && interruptedParent.signalCode === null) {
      interruptedParent.kill('SIGTERM');
      await Promise.race([interruptedParentExit?.catch(() => {}), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
      if (interruptedParent.exitCode === null && interruptedParent.signalCode === null) interruptedParent.kill('SIGKILL');
    }
    await Promise.all([close(timeoutRoot), close(abortRoot), close(parentExitRoot), close(hardKillRoot), close(overflowRoot)]);
  });

  const waitForPid = async (path) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { return Number((await readFile(path, 'utf8')).trim()); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error('hook did not start its descendant process');
  };
  const assertPidGone = async (pid) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.fail(`hook descendant ${pid} remained alive after lifecycle cancellation`);
  };

  const timedPidFile = join(timeoutRoot, 'descendant.pid');
  timeoutTask = runProjectHook({
    projectRoot: timeoutRoot,
    phase: 'verifyCandidate',
    context: { pidFile: timedPidFile },
  });
  const timedRejection = assert.rejects(timeoutTask, /timed out after 400ms/u);
  const timedPid = await waitForPid(timedPidFile);
  await timedRejection;
  await assertPidGone(timedPid);

  const abortedPidFile = join(abortRoot, 'descendant.pid');
  controller = new AbortController();
  abortTask = runProjectHook({
    projectRoot: abortRoot,
    phase: 'verifyCandidate',
    context: { pidFile: abortedPidFile },
    signal: controller.signal,
  });
  const abortRejection = assert.rejects(abortTask, (error) => error.name === 'AbortError');
  const abortedPid = await waitForPid(abortedPidFile);
  controller.abort();
  await abortRejection;
  await assertPidGone(abortedPid);

  const overflowPidFile = join(overflowRoot, 'descendant.pid');
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const overflowTask = runProjectHook({
      projectRoot: overflowRoot,
      phase: 'verifyCandidate',
      context: { pidFile: overflowPidFile },
    });
    const overflowRejection = assert.rejects(overflowTask, /exceeded its stdout output limit/u);
    const overflowPid = await waitForPid(overflowPidFile);
    await overflowRejection;
    await assertPidGone(overflowPid);
  } finally {
    process.stdout.write = originalWrite;
  }

  const moduleUrl = new URL('../../src/contracts/project-adapter.mjs', import.meta.url).href;
  const launcherSource = `
import { runProjectHook } from ${JSON.stringify(moduleUrl)};
const [projectRoot, pidFile] = process.argv.slice(1);
runProjectHook({ projectRoot, phase: 'verifyCandidate', context: { pidFile } }).catch(() => {});
`;
  for (const [project, parentSignal] of [[parentExitRoot, 'SIGTERM'], [hardKillRoot, 'SIGKILL']]) {
    const pidFile = join(project, 'descendant.pid');
    interruptedParent = spawn(process.execPath, ['--input-type=module', '-e', launcherSource, project, pidFile], {
      stdio: 'ignore', windowsHide: true,
    });
    const descendantPid = await waitForPid(pidFile);
    interruptedParentExit = new Promise((resolvePromise, rejectPromise) => {
      interruptedParent.once('error', rejectPromise);
      // On Windows, exit may precede close while the OS still owns the process
      // handle and cwd. Wait for close before removing its project fixture.
      interruptedParent.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    interruptedParent.kill(parentSignal);
    const exit = await interruptedParentExit;
    assert.ok(exit.signal === parentSignal || (parentSignal === 'SIGTERM' && exit.code === 143),
      `parent exited after ${parentSignal}: ${JSON.stringify(exit)}`);
    interruptedParent = null;
    await assertPidGone(descendantPid);
  }
});

test('hook failure, explicit skip, and thrown errors fail closed', async () => {
  const cases = [
    ['return false', 'return false;'],
    ['return not-ok', 'return { ok: false };'],
    ['return skip', 'return { skip: true };'],
    ['throw', 'throw new Error("hook exploded");'],
  ];
  const roots = await Promise.all(cases.map(([, body]) => consumer(
    `export const adapterContract = { schemaVersion: 1, hooks: { verifyCandidate: 'verify' } };\nexport async function verify() { ${body} }\n`,
  )));
  try {
    for (let i = 0; i < roots.length; i += 1) {
      await assert.rejects(runProjectHook({ projectRoot: roots[i], phase: 'verifyCandidate' }),
        i === cases.length - 1 ? /hook exploded/ : /rejected the operation/, cases[i][0]);
    }
  } finally { await Promise.all(roots.map(close)); }
});

test('adapter source never invokes shell commands and config parsing fails closed', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/adapter.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.hooks.additionalProperties, false);
  const root = await consumer('export const adapterContract = { schemaVersion: 1, hooks: {} };\n');
  await writeFile(join(root, '.vibe-coding', 'project.config.json'), '{broken');
  try {
    await assert.rejects(loadProjectAdapter({ projectRoot: root }), /invalid project config JSON/);
  } finally { await close(root); }
});
