import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { detectAnnouncementStall } from '../../src/supervision/detect-announcement-stall.mjs';

after(cleanupTempDirs);

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/supervision/detect-announcement-stall.mjs');

test('flags a report that ends on an announced next step with nothing behind it', () => {
  for (const text of [
    'I read the module and found the cause. Now let\'s implement the fix.',
    'Checked the config.\nNext, I\'ll update the tests.',
    'The parser looks fine. I\'ll check the fixtures next.',
    'Let me now run the whole suite.',
    'Going to patch the handler.',
  ]) {
    assert.equal(detectAnnouncementStall(text).stall, true, text);
  }
});

test('does not flag a report that carries execution evidence', () => {
  assert.equal(detectAnnouncementStall('Fixed it, committed a1b2c3d4e5 and pushed.\nNow let\'s move on.').stall, false);
  assert.equal(detectAnnouncementStall('```\nok 12 tests\n```\nNow I\'ll write the docs.').stall, false);
  assert.equal(detectAnnouncementStall('Verdict: green.\nNext I\'ll look at the docs.').stall, false);
});

test('false-negative guard: text that mentions a running background task is NOT flagged', () => {
  const text = 'Started the test run in the background and I am polling its output.\nNow let\'s wait for it.';
  const result = detectAnnouncementStall(text);
  assert.equal(result.stall, false);
  assert.match(result.reason, /background/);
  assert.equal(detectAnnouncementStall('Kicked off run_in_background for the build. Next I\'ll check the log.').stall, false);
});

test('ordinary prose, final reports and empty text are not flagged', () => {
  assert.equal(detectAnnouncementStall('All three files are updated and the checks are clean.').stall, false);
  assert.equal(detectAnnouncementStall('We could implement this later if the team wants it.').stall, false);
  assert.equal(detectAnnouncementStall('').stall, false);
  assert.equal(detectAnnouncementStall(undefined).stall, false);
});

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: input ?? '' });
}

test('CLI: text argument, stdin and --file; exit 1 on a stall, 0 otherwise, 2 without input', () => {
  const stall = 'Found the cause. Now let\'s implement the fix.';
  assert.equal(run([stall]).status, 1);
  assert.equal(run(['--', stall]).status, 1);
  assert.equal(run([], stall).status, 1);
  assert.equal(run([], 'Done: all checks pass.').status, 0);

  const dir = mkdtempTracked('hb-stall-');
  const file = join(dir, 'note.txt');
  writeFileSync(file, stall);
  assert.equal(run(['--file', file]).status, 1);
  assert.equal(run(['--file']).status, 2);
  assert.equal(run([], '  \n').status, 2);
  assert.equal(JSON.parse(run([stall]).stdout).stall, true);
});
