import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { startWindowsJob } from '../../src/worktrees/windows-git-job.mjs';

function fakeController({ onCancel, record = { protocol: 1, status: 0, stdoutBase64: '', stderrBase64: '', signal: null, timedOut: false, cancelled: false, confirmedZero: true } } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.stdinData = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const input = chunk.toString();
      child.stdinData += input;
      if (input.includes('cancel') && onCancel) onCancel(child, record);
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
  const started = startWindowsJob('C:\\Program Files\\Git\\bin\\git.exe', ['-c', 'user.name=a "quoted" value', 'status'], {
    platform: 'win32',
    cwd: 'C:\\work tree',
    env: { PATH: 'C:\\Windows', SAMPLE: 'quotes " and $; ` remain data' },
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
  assert.equal(config.command, 'C:\\Program Files\\Git\\bin\\git.exe');
  assert.deepEqual(config.args, ['-c', 'user.name=a "quoted" value', 'status']);
  assert.equal(config.cwd, 'C:\\work tree');
  assert.equal(Buffer.from(config.environmentBase64, 'base64').toString('utf16le').includes('SAMPLE=quotes " and $; ` remain data'), true);
  assert.equal(receivedOptions.windowsHide, true);
  assert.equal(receivedOptions.env.SAMPLE, 'quotes " and $; ` remain data');
  assert.ok(receivedArgs.at(-1).length < 30_000, 'the PowerShell controller source must fit in the native command-line limit');
  assert.equal(receivedArgs.at(-1).includes('SAMPLE=quotes'), false, 'environment values stay on stdin rather than the controller command line');

  const cancel = started.cancel('test cancellation');
  await cancel;
  const result = await started.result;
  assert.equal(result.status, 0);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
});

test('controller cleanup response without ActiveProcesses zero proof fails closed', async () => {
  const started = startWindowsJob('anything', [], {
    platform: 'win32',
    spawn() {
      const child = fakeController();
      queueMicrotask(() => child.finish({
        protocol: 1, status: null, stdoutBase64: '', stderrBase64: '', signal: 'SIGTERM',
        timedOut: false, cancelled: true, confirmedZero: false, error: 'query failed',
      }));
      return child;
    },
  });
  await assert.rejects(started.result, /did not confirm ActiveProcesses=0/);
});

test('deadline cancellation is represented as a timeout after controller confirms cleanup', async () => {
  const started = startWindowsJob('anything', [], {
    platform: 'win32',
    timeoutMs: 20,
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
  const job = startWindowsJob(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"], { timeoutMs: 20_000 });
  const result = await job.result;
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

test('native job enforces a combined output-byte cap while continuing to drain pipes', windowsOnly, async () => {
  const code = "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000))";
  const result = await startWindowsJob(process.execPath, ['-e', code], { timeoutMs: 20_000, maxOutputBytes: 17 }).result;
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 17);
  assert.equal(result.status, 0);
});

test('native cancellation contains a parent-exited descendant and preserves unrelated processes', windowsOnly, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'windows-git-job-cwd-'));
  const ready = path.join(root, 'child-ready');
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`;
  const parentCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { cwd: ${JSON.stringify(root)}, stdio: 'inherit', windowsHide: true });`,
    'child.unref();',
    `const ready = ${JSON.stringify(ready)}; const until = Date.now() + 10000; while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    'if (!fs.existsSync(ready)) process.exit(12);',
    'process.exit(0);',
  ].join('\n');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (unrelated.exitCode === null) unrelated.kill();
    await rm(root, { recursive: true, force: true });
  });

  const job = startWindowsJob(process.execPath, ['-e', parentCode], { cwd: root, timeoutMs: 20_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await readFile(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  await readFile(ready);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await job.cancel('terminate descendant holding CWD and pipes');
  const result = await job.result;
  assert.equal(result.status, 0);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(unrelated.exitCode, null, 'unrelated process must remain alive');
  await rm(root, { recursive: true, force: false });
  assert.equal(unrelated.exitCode, null, 'unrelated process must remain alive after deleting CWD');
});

test('native timeout terminates all job members but leaves unrelated process alive', windowsOnly, async (t) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (unrelated.exitCode === null) unrelated.kill(); });
  const job = startWindowsJob(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 2500 });
  const result = await job.result;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
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
      timeoutMs: 10_000,
      testHooks: { failAt },
    });
    const result = await job.result;
    assert.equal(result.status, null, `${failAt} must prevent command execution`);
    assert.match(result.error ?? '', /failure/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});
