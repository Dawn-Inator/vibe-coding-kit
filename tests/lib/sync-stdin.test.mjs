// lib/sync-stdin.test.mjs
//
// Coverage for sync-stdin.mjs. Run with:
//   node --test lib/sync-stdin.test.mjs
//
// Regression: touching process.stdin (even `.isTTY`) flips a pipe on fd 0 to O_NONBLOCK, so a
// following readFileSync(0) throws EAGAIN when the writer has not produced data yet and the payload
// is silently lost. readStdinSync never touches process.stdin and retries EAGAIN until EOF.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readStdin, readStdinSync } from '../../src/lib/sync-stdin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', '..');
const MODULE_URL = pathToFileURL(join(KIT, 'src', 'lib', 'sync-stdin.mjs')).href;
const STALL_CLI = join(KIT, 'src', 'supervision', 'detect-announcement-stall.mjs');

// Spawn with a stdin pipe whose payload arrives only after `delayMs`, like a hook runner that
// starts the process before it writes the JSON.
function runWithDelayedStdin(args, payload, delayMs = 200) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    setTimeout(() => child.stdin.end(payload), delayMs);
  });
}

test('readStdin gets a late payload even after process.stdin.isTTY was touched', async () => {
  const result = await runWithDelayedStdin(
    ['--input-type=module', '-e', `
import { readStdin } from ${JSON.stringify(MODULE_URL)};
void process.stdin.isTTY;
process.stdout.write(JSON.stringify(await readStdin({ timeoutMs: 5000 })));
`],
    '{"tool_name":"Bash"}',
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out), '{"tool_name":"Bash"}');
});

test('readStdin accepts fd 0 when Windows reports no POSIX stat file type', async () => {
  const result = await runWithDelayedStdin(
    ['--input-type=module', '-e', `
import { readStdin } from ${JSON.stringify(MODULE_URL)};
void process.stdin.isTTY;
const stat = { isFIFO: () => false, isSocket: () => false, isFile: () => false, isCharacterDevice: () => false };
process.stdout.write(JSON.stringify(await readStdin({ timeoutMs: 5000, deps: { isatty: () => false, fstat: () => stat } })));
`],
    '{"late":true}',
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out), '{"late":true}');
});

test('detect-announcement-stall reads a late piped payload instead of exiting with usage', async () => {
  const result = await runWithDelayedStdin([STALL_CLI], 'Checked the config.\nNext, I\'ll update the tests.\n');
  assert.equal(result.code, 1, result.err);
  assert.equal(JSON.parse(result.out).stall, true);
});

test('readStdin resolves at its deadline when a pipe stays open without data', async () => {
  const script = `
import { readStdin } from ${JSON.stringify(MODULE_URL)};
process.stdout.write(JSON.stringify(await readStdin({ timeoutMs: 30 })));
`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    setTimeout(() => child.stdin.end(), 100);
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out), '');
});

test('readStdinSync returns "" for an unusable fd and honours its deadline on an empty pipe', () => {
  assert.equal(readStdinSync({ fd: 987654 }), '');
  let clock = 0;
  const text = readStdinSync({
    timeoutMs: 50,
    deps: {
      isatty: () => false,
      fstat: () => ({ isFIFO: () => true, isSocket: () => false, isFile: () => false, isCharacterDevice: () => false }),
      read: () => {
        const error = new Error('again');
        error.code = 'EAGAIN';
        throw error;
      },
      sleep: (ms) => { clock += ms; },
      now: () => clock,
      lstat: () => {},
    },
  });
  assert.equal(text, '');
  assert.ok(clock >= 50);
});

test('readStdin keeps TTY and closed descriptors as immediate empty input', async () => {
  let statCalls = 0;
  assert.equal(await readStdin({ deps: { isatty: () => true, fstat: () => { statCalls += 1; throw new Error('should not stat a TTY'); } } }), '');
  assert.equal(statCalls, 0);
  assert.equal(await readStdin({ deps: { isatty: () => false, fstat: () => { throw new Error('closed fd'); } } }), '');
});

function kitSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...kitSources(path));
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) out.push(path);
  }
  return out;
}

test('class guard: no kit source reads stdin with readFileSync(0) or /dev/stdin', () => {
  const offenders = kitSources(join(KIT, 'src'))
    .filter((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .some((line) => !/^\s*(?:\/\/|\*)/u.test(line) && /readFileSync\(\s*(?:0\b|['"]\/dev\/stdin['"])/u.test(line)),
    )
    .map((path) => relative(KIT, path));
  assert.deepEqual(offenders, []);
});
