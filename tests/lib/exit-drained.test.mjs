// lib/exit-drained.test.mjs
//
// Coverage for exit-drained.mjs, plus the class guard that keeps every kit CLI on it. Run with:
//   node --test lib/exit-drained.test.mjs
//
// The truncation itself only reproduces where stdout pipes are asynchronous (macOS, Windows); on
// Linux Node writes pipes synchronously. So the regression layer is the contract (a large document
// and the exit code arrive intact through a pipe) and the class guard (no bare process.exit in kit
// sources, so a new CLI cannot reintroduce the write-then-exit shape on any platform).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..');
const MODULE_URL = pathToFileURL(join(HERE, 'exit-drained.mjs')).href;

function runChild(source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

test('exitDrained delivers a multi-megabyte stdout document and the exit code through a pipe', () => {
  const size = 4 * 1024 * 1024;
  const result = runChild(`
import { exitDrained } from ${JSON.stringify(MODULE_URL)};
process.stdout.write(JSON.stringify({ data: 'x'.repeat(${size}) }) + '\\n');
process.stderr.write('done\\n');
exitDrained(3);
`);
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).data.length, size);
  assert.equal(result.stderr, 'done\n');
});

test('exitDrained still ends the process when a handle would keep it alive', () => {
  const result = runChild(`
import { exitDrained } from ${JSON.stringify(MODULE_URL)};
setInterval(() => {}, 1000);
process.stdout.write('ok\\n');
exitDrained(0);
`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok\n');
});

test('exitDrainedHalt never lets the awaiting caller run on', () => {
  const result = runChild(`
import { exitDrainedHalt } from ${JSON.stringify(MODULE_URL)};
async function finish() { process.stdout.write('first\\n'); return exitDrainedHalt(4); }
await finish();
process.stdout.write('must not print\\n');
`);
  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'first\n');
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

test('class guard: no kit source exits with a bare process.exit (use exitDrained, or mark a signal exit)', () => {
  const offenders = [];
  for (const path of kitSources(KIT)) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(?:\/\/|\*)/u.test(line)) return;
        if (/\bprocess\.exit\(/u.test(line) && !line.includes('exit-drained-ok')) {
          offenders.push(`${relative(KIT, path)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});
