import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { startWindowsJob } from '../../src/worktrees/windows-git-job.mjs';

function fakeController({
  emitReady = true,
  onStart,
  onCancel,
  record = { protocol: 1, status: 0, stdoutBase64: '', stderrBase64: '', signal: null, timedOut: false, cancelled: false, confirmedZero: true },
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.stdinData = '';
  child.controls = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const input = chunk.toString();
      child.stdinData += input;
      for (const line of input.split('\n').filter(Boolean)) {
        if (line === 'start') {
          child.controls.push('start');
          if (onStart) onStart(child, record);
        } else if (line === 'cancel') {
          child.controls.push('cancel');
          if (onCancel) onCancel(child, record);
        }
      }
      callback();
    },
  });
  child.kill = () => true;
  child.finish = (value = record) => {
    child.stdout.end(`${JSON.stringify(value)}\n`);
    child.stderr.end();
    child.exitCode = 0;
    child.emit('close', 0, null);
  };
  if (emitReady) queueMicrotask(() => child.stdout.write('{"protocol":1,"event":"ready"}\n'));
  return child;
}

function nativeChildEnvironment() {
  const environment = { ...process.env };
  // `node --test` marks its file workers with this internal variable. The
  // native descendants here are ordinary Node programs, not nested test
  // workers; keep the harness marker out of these process-lifetime fixtures.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

test('Windows Job Object contract rejects unsupported platforms before spawning', async () => {
  let spawned = false;
  const job = startWindowsJob('must-not-run', [], {
    platform: 'linux',
    spawn() { spawned = true; throw new Error('should not spawn'); },
  });
  await assert.rejects(job.result, /only available on win32/);
  assert.equal(spawned, false);
});

test('controller configuration is base64 data and cancellation waits for zero-process proof', async () => {
  let controller;
  let receivedArgs;
  let receivedOptions;
  const targetEnvironment = { PATH: 'C:\\Windows', SAMPLE: 'quotes " and $; ` remain data' };
  const started = startWindowsJob('git.exe', ['-c', 'user.name=a "quoted" value', 'status'], {
    platform: 'win32',
    cwd: 'C:\\work tree',
    env: targetEnvironment,
    resolveExecutable(command, cwd, env) {
      assert.equal(command, 'git.exe');
      assert.equal(cwd, 'C:\\work tree');
      assert.equal(env.PATH, 'C:\\Windows');
      return 'C:\\Program Files\\Git\\cmd\\git.exe';
    },
    spawn(_executable, args, options) {
      receivedArgs = args;
      receivedOptions = options;
      controller = fakeController({
        onCancel(child, record) {
          child.finish({ ...record, status: 0, cancelled: true, signal: 'SIGTERM', confirmedZero: true });
        },
      });
      return controller;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const config = JSON.parse(controller.stdinData.split('\n')[0]);
  assert.equal(config.command, 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.deepEqual(config.args, ['-c', 'user.name=a "quoted" value', 'status']);
  assert.equal(config.cwd, 'C:\\work tree');
  assert.equal(Buffer.from(config.environmentBase64, 'base64').toString('utf16le').includes('SAMPLE=quotes " and $; ` remain data'), true);
  assert.equal(receivedOptions.windowsHide, true);
  assert.equal(receivedOptions.env, process.env, 'controller keeps the host PATH independent of the target environment');
  assert.equal(Object.hasOwn(receivedOptions.env, 'SAMPLE'), Object.hasOwn(process.env, 'SAMPLE'));
  assert.ok(receivedArgs.at(-1).length < 30_000, 'the PowerShell controller source must fit in the native command-line limit');
  assert.equal(receivedArgs.at(-1).includes('SAMPLE=quotes'), false, 'environment values stay on stdin rather than the controller command line');
  assert.deepEqual(controller.controls, ['start'], 'the controller must receive an explicit launch grant after readiness');

  const cancel = started.cancel('test cancellation');
  await cancel;
  assert.deepEqual(controller.controls, ['start', 'cancel']);
  const result = await started.result;
  assert.equal(result.status, 0);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
});

test('an omitted working directory is sent to CreateProcess as an absolute path', async () => {
  let controller;
  const job = startWindowsJob('anything.exe', [], {
    platform: 'win32',
    resolveExecutable: () => 'C:\\tools\\anything.exe',
    spawn() {
      controller = fakeController();
      return controller;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const config = JSON.parse(controller.stdinData.split('\n')[0]);
  assert.equal(config.cwd, path.win32.resolve(process.cwd()));
  assert.ok(config.cwd.length > 0);
  controller.finish();
  await job.result;
});

test('controller cleanup response without ActiveProcesses zero proof fails closed', async () => {
  const started = startWindowsJob('anything', [], {
    platform: 'win32',
    resolveExecutable: () => 'C:\\tools\\anything.exe',
    spawn() {
      const child = fakeController({ emitReady: false });
      queueMicrotask(() => child.finish({
        protocol: 1, status: null, stdoutBase64: '', stderrBase64: '', signal: 'SIGTERM',
        timedOut: false, cancelled: true, confirmedZero: false, error: 'query failed',
      }));
      return child;
    },
  });
  await assert.rejects(started.result, /did not confirm ActiveProcesses=0/);
});

test('cancellation before controller readiness never sends a launch grant', async () => {
  let controller;
  const job = startWindowsJob('anything', [], {
    platform: 'win32',
    resolveExecutable: () => 'C:\\tools\\anything.exe',
    spawn() {
      controller = fakeController({
        emitReady: false,
      });
      return controller;
    },
  });

  const cancellation = job.cancel('cancel before readiness');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.controls, ['cancel']);
  controller.stdout.write('{"protocol":1,"event":"ready"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.controls, ['cancel'], 'a late readiness event must not grant launch after cancellation');
  controller.finish({
    protocol: 1,
    status: null,
    stdoutBase64: '',
    stderrBase64: '',
    signal: 'SIGTERM',
    timedOut: false,
    cancelled: true,
    confirmedZero: true,
  });
  await cancellation;
  const result = await job.result;
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
});

test('deadline cancellation is represented as a timeout after controller confirms cleanup', async () => {
  const started = startWindowsJob('anything', [], {
    platform: 'win32',
    timeoutMs: 20,
    resolveExecutable: () => 'C:\\tools\\anything.exe',
    spawn() {
      return fakeController({
        onCancel(child, record) {
          child.finish({ ...record, cancelled: true, signal: 'SIGTERM', confirmedZero: true });
        },
      });
    },
  });
  const result = await started.result;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
});

const windowsOnly = { skip: process.platform === 'win32' ? false : 'requires native Windows PowerShell and Job Objects' };

test('native job captures stdout, stderr, and exit status', windowsOnly, async () => {
  const job = startWindowsJob(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"], {
    env: nativeChildEnvironment(),
    timeoutMs: 20_000,
  });
  const result = await job.result;
  assert.equal(result.status, 7, JSON.stringify(result));
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test('native job enforces a combined output-byte cap while continuing to drain pipes', windowsOnly, async () => {
  const code = "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000))";
  const result = await startWindowsJob(process.execPath, ['-e', code], {
    env: nativeChildEnvironment(),
    timeoutMs: 20_000,
    maxOutputBytes: 17,
  }).result;
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 17);
  assert.equal(result.status, 0, JSON.stringify(result));
});

test('native cancellation contains a parent-exited descendant and preserves unrelated processes', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-cwd-'));
  const ready = path.join(root, 'child-ready');
  const stop = path.join(root, 'child-stop');
  const childCode = [
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
    `setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 20);`,
  ].join('\n');
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { cwd: ${JSON.stringify(root)}, stdio: 'inherit', windowsHide: true, detached: true });`,
    'child.unref();',
    `const ready = ${JSON.stringify(ready)}; const until = Date.now() + 10000; while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    'if (!fs.existsSync(ready)) process.exit(12);',
    'process.exit(0);',
  ].join('\n');
  const isolatedEnvironment = nativeChildEnvironment();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    env: isolatedEnvironment,
  });
  let job;
  let childPid = null;
  t.after(async () => {
    if (job) await job.cancel('test cleanup').catch(() => {});
    if (unrelated.exitCode === null) unrelated.kill();
    if (childPid !== null) {
      await writeFile(stop, 'stop').catch(() => {});
      const childDeadline = Date.now() + 2000;
      while (Date.now() < childDeadline) {
        try { process.kill(childPid, 0); } catch (error) { if (error.code !== 'EPERM') break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  job = startWindowsJob(process.execPath, ['-e', parentCode], {
    cwd: root,
    env: isolatedEnvironment,
    timeoutMs: 20_000,
    testHooks: { traceProcessLifecycle: true },
  });
  const resultObserved = job.result.then((result) => ({ result }), (error) => ({ error }));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await readFile(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  childPid = Number(await readFile(ready, 'utf8'));
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'descendant must publish its process ID');
  try {
    process.kill(childPid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') throw new Error(`descendant exited before cancellation: ${error.message}`);
  }
  const beforeCancel = await Promise.race([
    resultObserved.then((outcome) => ({ completed: outcome })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 100)),
  ]);
  assert.equal(beforeCancel.pending, true, `job completed while its descendant was live: ${JSON.stringify(beforeCancel.completed)}`);
  await job.cancel('terminate descendant holding CWD and pipes');
  const outcome = await resultObserved;
  if (outcome.error) throw outcome.error;
  const { result } = outcome;
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.signal, 'SIGTERM', JSON.stringify(result));
  assert.equal(unrelated.exitCode, null, 'unrelated process must remain alive');
  await rm(root, { recursive: true, force: false });
  assert.equal(unrelated.exitCode, null, 'unrelated process must remain alive after deleting CWD');
});

test('native timeout terminates all job members but leaves unrelated process alive', windowsOnly, async (t) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    env: nativeChildEnvironment(),
  });
  t.after(() => { if (unrelated.exitCode === null) unrelated.kill(); });
  const job = startWindowsJob(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: nativeChildEnvironment(),
    timeoutMs: 2500,
  });
  const result = await job.result;
  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.equal(result.signal, 'SIGTERM', JSON.stringify(result));
  assert.equal(unrelated.exitCode, null);
});

test('native setup and assignment failures never resume the requested command', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-fail-'));
  const marker = path.join(root, 'executed');
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  for (const failAt of ['create-job', 'create-process', 'assign']) {
    const job = startWindowsJob(process.execPath, ['-e', code], {
      cwd: root,
      env: nativeChildEnvironment(),
      timeoutMs: 10_000,
      testHooks: { failAt },
    });
    const result = await job.result;
    assert.equal(result.status, null, `${failAt} must prevent command execution`);
    assert.match(result.error ?? '', /failure/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

test('native immediate cancellation before controller readiness never runs the target', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-prelaunch-cancel-'));
  const marker = path.join(root, 'executed');
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  const job = startWindowsJob(process.execPath, ['-e', code], {
    cwd: root,
    env: nativeChildEnvironment(),
    timeoutMs: 20_000,
  });
  const resultObserved = job.result.then((result) => ({ result }), (error) => ({ error }));
  await job.cancel('cancel before controller readiness');
  const outcome = await resultObserved;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.result.status, null);
  assert.equal(outcome.result.signal, 'SIGTERM');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('native expired startup deadline cancels before the target entry point', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-expired-startup-'));
  const marker = path.join(root, 'executed');
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  const job = startWindowsJob(process.execPath, ['-e', code], {
    cwd: root,
    env: nativeChildEnvironment(),
    timeoutMs: 100,
    testHooks: { delayControllerMs: 300 },
  });
  const outcome = await job.result.then((result) => ({ result }), (error) => ({ error }));
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.result.timedOut, true);
  assert.equal(outcome.result.status, null);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('native bare git.exe resolves through the child PATH and missing commands fail closed', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitDirectory = String(process.env.PATH ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .find((entry) => entry && existsSync(path.join(entry, 'git.exe')));
  assert.ok(gitDirectory, 'native Windows test host must provide git.exe on PATH');
  const childEnv = {
    PATH: gitDirectory,
    PATHEXT: '.EXE',
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir ?? process.env.SystemRoot,
  };

  const git = await startWindowsJob('git.exe', ['--version'], { cwd: root, env: childEnv, timeoutMs: 20_000 }).result;
  assert.equal(git.status, 0);
  assert.match(git.stdout, /git version/i);
  const pathext = await startWindowsJob('git', ['--version'], { cwd: root, env: childEnv, timeoutMs: 20_000 }).result;
  assert.equal(pathext.status, 0);
  assert.match(pathext.stdout, /git version/i);

  const missing = startWindowsJob('vibe-coding-kit-command-that-does-not-exist.exe', [], {
    cwd: root,
    env: childEnv,
    timeoutMs: 20_000,
  });
  await assert.rejects(missing.result, /could not be resolved/);
});
