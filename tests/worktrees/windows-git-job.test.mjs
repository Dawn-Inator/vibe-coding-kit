import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
    env: { SystemRoot: 'C:\\Windows' }, // hermetic: never the host's (possibly case-duplicated) variables
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
    env: { SystemRoot: 'C:\\Windows' }, // hermetic: never the host's (possibly case-duplicated) variables
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
    env: { SystemRoot: 'C:\\Windows' }, // hermetic: never the host's (possibly case-duplicated) variables
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
    env: { SystemRoot: 'C:\\Windows' }, // hermetic: never the host's (possibly case-duplicated) variables
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

