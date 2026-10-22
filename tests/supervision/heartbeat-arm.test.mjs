import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES } from '../../src/supervision/check-heartbeat-ledger.mjs';
import {
  DEFAULT_LEDGER_PATH_RE,
  PROBE_SECONDS,
  SOURCES_TEMPLATE,
  STATE_LEGEND,
  STATUS_LINE_FORMAT,
  armsPathFor,
  checkLedgerBeforeArm,
  formatWakeMessage,
  holdIdleAwake,
  keepAwakeCommand,
  ledgerTemplate,
  parseArgs,
} from '../../src/supervision/heartbeat-arm.mjs';

after(cleanupTempDirs);
delete process.env.HEARTBEAT_LEDGER_RE; // keep the in-process parseArgs tests hermetic

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '../../src/supervision/check-heartbeat-ledger.mjs');
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/supervision/heartbeat-arm.mjs');
const LEDGER_REL = '.workspace/2026-01-01-demo/heartbeat.md';

function wakeSection(time) {
  return `----\n## ${time} wake (10-row ledger)\nsources: landings(ok)\n\n| # | category | state |\n| --- | --- | --- |\n`;
}

function arm(cwd, extra = []) {
  return spawnSync(process.execPath, [CLI, '--ledger', LEDGER_REL, '--seconds', '1', ...extra], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HEARTBEAT_LEDGER_RE: '', HEARTBEAT_KEEP_AWAKE: '0' },
  });
}

function fixture() {
  const cwd = mkdtempTracked('hb-arm-');
  mkdirSync(join(cwd, '.workspace/2026-01-01-demo'), { recursive: true });
  return { cwd, ledger: join(cwd, LEDGER_REL), arms: join(cwd, '.workspace/2026-01-01-demo/heartbeat.arms') };
}

test('parseArgs: a real heartbeat needs a ledger that matches the pattern; the probe needs none', () => {
  assert.throws(() => parseArgs([]), /needs --ledger/);
  assert.throws(() => parseArgs(['--ledger', 'notes/heartbeat.md']), /--ledger must match/);
  assert.throws(() => parseArgs(['--ledger', LEDGER_REL, '--minutes', '0']), /positive number/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.deepEqual(parseArgs(['--', '--ledger', LEDGER_REL]), { seconds: 1200, probe: false, ledger: LEDGER_REL });
  assert.equal(parseArgs(['--ledger', LEDGER_REL, '--minutes', '15']).seconds, 900);
  assert.equal(parseArgs(['--ledger', LEDGER_REL, '--seconds', '90']).seconds, 90);
  assert.deepEqual(parseArgs(['--probe']), { seconds: PROBE_SECONDS, probe: true, ledger: null });
  assert.equal(PROBE_SECONDS, 75);
});

test('HEARTBEAT_LEDGER_RE overrides the ledger path pattern', () => {
  const env = { HEARTBEAT_LEDGER_RE: '^notes/[a-z]+/hb\\.md$' };
  assert.equal(parseArgs(['--ledger', 'notes/demo/hb.md'], env).ledger, 'notes/demo/hb.md');
  assert.throws(() => parseArgs(['--ledger', LEDGER_REL], env), /--ledger must match/);
  assert.throws(() => parseArgs(['--ledger', LEDGER_REL], { HEARTBEAT_LEDGER_RE: '(' }), /not a valid regular expression/);
  assert.ok(DEFAULT_LEDGER_PATH_RE.test(LEDGER_REL));
  assert.ok(DEFAULT_LEDGER_PATH_RE.test(`/abs/repo/${LEDGER_REL}`));
  assert.ok(DEFAULT_LEDGER_PATH_RE.test('.workspace/task/2026-01-01-demo/heartbeat.md'));
  assert.ok(!DEFAULT_LEDGER_PATH_RE.test('.workspace/task/nested/2026-01-01-demo/heartbeat.md'));
});

test('checkLedgerBeforeArm: arming k+1 needs at least k-1 wake sections', () => {
  const sections = (n) => Array.from({ length: n }, (_, i) => wakeSection(`2026-01-01T10:0${i}Z`)).join('');
  assert.equal(checkLedgerBeforeArm('', 0), null);
  assert.equal(checkLedgerBeforeArm('', 1), null);
  assert.match(checkLedgerBeforeArm('', 2), /previous wake wrote no ledger block/);
  assert.equal(checkLedgerBeforeArm(sections(1), 2), null);
  assert.notEqual(checkLedgerBeforeArm(sections(1), 3), null);
  assert.equal(checkLedgerBeforeArm(sections(2), 3), null);
});

test('formatWakeMessage: re-arm first, one chat line, no project-specific commands, ASCII only', () => {
  const now = new Date('2026-01-01T10:20:05Z');
  const text = formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now });
  assert.ok(text.indexOf('re-arm FIRST') < text.indexOf('(2) audit'));
  assert.ok(text.includes(`## 2026-01-01T10:20Z wake (10-row ledger)`));
  assert.ok(text.includes(STATUS_LINE_FORMAT));
  assert.ok(text.includes(`pnpm check:heartbeat-ledger -- ${LEDGER_REL} --latest`));
  assert.ok(text.includes('pnpm heartbeat:check-stall'));
  assert.ok(!text.includes('worktree:'));
  assert.ok(/^[\x20-\x7e\n·✓←—]*$/.test(text), 'checklist should stay English-neutral (the skill\'s own glyphs aside)');
  const probe = formatWakeMessage({ seconds: 75, probe: true, ledger: null, now });
  assert.match(probe, /^HEARTBEAT_PROBE delivered 10:20:05/);
});

test('CLI: arming sleeps, logs one arm, prints the checklist; the third arming without a ledger block is refused with exit 3', () => {
  const { cwd, ledger, arms } = fixture();
  const first = arm(cwd);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^HEARTBEAT due /);
  assert.match(first.stdout, new RegExp(LEDGER_REL.replace(/\./g, '\\.')));
  assert.equal(readFileSync(arms, 'utf8').trim().split('\n').length, 1);

  assert.equal(arm(cwd).status, 0); // arming #2 needs >= 0 wake sections
  assert.equal(readFileSync(arms, 'utf8').trim().split('\n').length, 2);

  const refused = arm(cwd); // arming #3 needs >= 1 wake section; the ledger has none
  assert.equal(refused.status, 3);
  assert.match(refused.stdout, /^HEARTBEAT_ARM_REFUSED /);
  assert.equal(readFileSync(arms, 'utf8').trim().split('\n').length, 2, 'a refused arming must not be counted');

  writeFileSync(ledger, wakeSection('2026-01-01T10:20Z'));
  assert.equal(arm(cwd).status, 0);
  assert.equal(readFileSync(arms, 'utf8').trim().split('\n').length, 3);
});

test('CLI: heartbeat.arms survives a script that rewrites the whole ledger', () => {
  const { cwd, ledger, arms } = fixture();
  assert.equal(arm(cwd).status, 0);
  assert.equal(arm(cwd).status, 0);
  writeFileSync(ledger, wakeSection('2026-01-01T10:20Z'));
  assert.equal(arm(cwd).status, 0); // 3 armings, 1 wake section
  // A script regenerates the ledger from scratch and drops the wake sections...
  writeFileSync(ledger, '# heartbeat\n(rewritten)\n');
  assert.equal(readFileSync(arms, 'utf8').trim().split('\n').length, 3, 'the counter file is untouched');
  // ...yet the gate still sees 3 prior armings, so the next one is refused.
  assert.equal(arm(cwd).status, 3);
  assert.equal(armsPathFor(ledger), arms);
});

test('CLI: usage errors exit 2 and the probe needs no ledger and logs nothing', () => {
  const { cwd, arms } = fixture();
  const noLedger = spawnSync(process.execPath, [CLI, '--seconds', '1'], { cwd, encoding: 'utf8' });
  assert.equal(noLedger.status, 2);
  assert.match(noLedger.stderr, /needs --ledger/);

  const probe = spawnSync(process.execPath, [CLI, '--probe', '--seconds', '1'], { cwd, encoding: 'utf8' });
  assert.equal(probe.status, 0);
  assert.match(probe.stdout, /^HEARTBEAT_PROBE delivered/);
  assert.equal(existsSync(arms), false);
});

// Pull the printed ledger block back out of a wake message (indented two spaces under "Ledger:").
function extractBlock(message) {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => line === '  ----');
  const end = lines.findIndex((line, i) => i > start && line.startsWith('  | ') && line.includes(CATEGORIES.at(-1)));
  assert.ok(start >= 0 && end > start, 'wake message must carry the ledger block');
  return lines.slice(start, end + 1).map((line) => line.slice(2)).join('\n');
}

function runChecker(cwd, text) {
  const file = join(cwd, 'wake-ledger.md');
  writeFileSync(file, text);
  return spawnSync(process.execPath, [CHECKER, file, '--latest'], { cwd, encoding: 'utf8' });
}

const WAKE_NOW = new Date('2026-01-01T10:20:05Z');

test('ledgerTemplate: one row per checker category, in order', () => {
  const rows = ledgerTemplate('2026-01-01T10:20Z').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, CATEGORIES.length);
  rows.forEach((row, i) => assert.ok(row.startsWith(`| ${i + 1} | ${CATEGORIES[i]} |`), row));
  assert.match(rows[0], /\(1a\) <state>; \(1b\) <state>/);
});

// Fills the printed block the way a model would: one allowed state per row (row 10 cites the matrix),
// the backlog timestamp with the wake time. `rowStates` overrides individual rows by number.
function fillBlock(block, rowStates = {}) {
  const defaults = {
    2: 'in-flight reviewer-1',
    3: 'dispatched status-writer',
    4: 'blocked <- exclusive-port-3000',
    5: 'deferred <- reviewer reply ETA <=20m',
    6: 'empty -- `git status` = clean',
    7: 'done -- `node --test` = pass',
    8: 'done -- abc1234',
    9: 'empty -- `git worktree list` = only primary',
    10: 'done -- `check-units --matrix` = every unit current',
  };
  const states = { ...defaults, ...rowStates };
  return block
    .replace('<timestamp>', '2026-01-01T10:20Z')
    .replace('(1a) <state>; (1b) <state>', '(1a) in-flight unit-a; (1b) empty -- `ls .todolist` = nothing free')
    .replace(/^\| (\d+) \| ([^|]+) \| <state> \|$/gm, (_, num, name) => `| ${num} | ${name} | ${states[num]} |`)
    .concat('\n\nre-split: rows(r4: cannot-split: owner-gated; r5: split->dispatched reviewer-2)\nsplittable: 1/1');
}

test('wake message: the printed block passes the real checker once every placeholder is filled', () => {
  const cwd = mkdtempTracked('hb-arm-tpl-');
  const block = extractBlock(formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now: WAKE_NOW }));
  assert.ok(!/<state>|<timestamp>/.test(fillBlock(block)), 'every placeholder is replaced');
  const result = runChecker(cwd, `# heartbeat\n\n${fillBlock(block)}\n`);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /OK/);
});

test('wake message: the next wake may use the unchanged shorthand the legend teaches, but not on row 10', () => {
  const cwd = mkdtempTracked('hb-arm-tpl-');
  const block = extractBlock(formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now: WAKE_NOW }));
  const second = block.replace('2026-01-01T10:20Z', '2026-01-01T10:40Z');
  const carried = { 2: 'unchanged — `git log base..tip`', 5: 'blocked <- reviewer reply', 9: 'unchanged — `git worktree list`' };
  const green = runChecker(cwd, `${fillBlock(block)}\n\n${fillBlock(second, carried)}\n`);
  assert.equal(green.status, 0, green.stdout);
  const red = runChecker(cwd, `${fillBlock(block)}\n\n${fillBlock(second, { ...carried, 10: 'unchanged — `check-units`' })}\n`);
  assert.equal(red.status, 1);
  assert.match(red.stdout, /unchanged-shorthand/);
});

test('wake message: the block shipped unedited is red, so a model cannot skip filling it', () => {
  const cwd = mkdtempTracked('hb-arm-tpl-');
  const block = extractBlock(formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now: WAKE_NOW }));
  const result = runChecker(cwd, `# heartbeat\n\n${block}\n`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /state-unknown/);
  assert.match(result.stdout, /external-backlog-timestamp-missing/);
});

test('sources template: the skill\'s tokens, in the skill\'s order, with the backlog timestamp left to fill', () => {
  assert.equal(
    SOURCES_TEMPLATE,
    'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ <timestamp>) worker-health(✓)',
  );
  const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'agent-task-supervision', 'SKILL.md'), 'utf8');
  for (const token of ['sweep(✓)', 'landings(✓)', 'reports(✓)', 'drift-matrix(✓)', 'memory/handoff(✓ at resume)', 'worker-health(✓)']) {
    assert.ok(skill.includes(token) && SOURCES_TEMPLATE.includes(token), token);
  }
  assert.ok(skill.includes('external-backlog(✓ <timestamp>|blocked ← <reason>)'));
});

test('legend: every state form of the skill is listed, with the unchanged conditions and the blocked-backlog rule', () => {
  const legend = STATE_LEGEND.join('\n');
  for (const form of ['in-flight <unit>', 'dispatched <unit>', 'blocked ← ', 'deferred ← <input> ETA <=20m', 'empty — `', 'done — `', 'unchanged — `<command rerun this wake>`']) {
    assert.ok(legend.includes(form), form);
  }
  assert.match(legend, /rows 2-9 only/);
  assert.match(legend, /first\s+wake.*deferred last wake.*row 10/s);
  assert.match(legend, /external-backlog\(blocked ← <reason>\)\s+AND an `owner ←` item/);
  assert.match(legend, /unchecked: <units>/);
  const text = formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now: WAKE_NOW });
  for (const line of STATE_LEGEND) assert.ok(text.includes(`  ${line}`), line);
});

test('wake message: audit steps include the re-split and dispatch line', () => {
  const text = formatWakeMessage({ seconds: 1200, probe: false, ledger: LEDGER_REL, now: WAKE_NOW });
  assert.match(text, /4\. decomposition: if fewer workers are in flight than free independent units, re-split/);
  assert.ok(text.indexOf('discovery first') < text.indexOf('4. decomposition'));
  assert.match(text, /default answer is YES/);
  assert.match(text, /cannot-split: <tagged proof>/);
  assert.match(text, /splittable: D\/P/);
  assert.ok(text.includes('run ONCE: pnpm check:heartbeat-ledger'));
});

test('keepAwakeCommand / holdIdleAwake: darwin spawns caffeinate tied to the pid; others and failures are silent', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 4242), ['caffeinate', ['-i', '-w', '4242']]);
  assert.equal(keepAwakeCommand('linux', 4242), null);
  assert.equal(keepAwakeCommand('win32', 4242), null);

  const calls = [];
  const fake = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => calls.push('unref');
    calls.push({ cmd, args, opts });
    return child;
  };
  assert.equal(holdIdleAwake({ platform: 'darwin', pid: 7, env: {}, spawnFn: fake }), true);
  assert.deepEqual(calls[0], { cmd: 'caffeinate', args: ['-i', '-w', '7'], opts: { detached: true, stdio: 'ignore' } });
  assert.equal(calls[1], 'unref');

  calls.length = 0;
  assert.equal(holdIdleAwake({ platform: 'linux', pid: 7, env: {}, spawnFn: fake }), false);
  assert.equal(holdIdleAwake({ platform: 'darwin', pid: 7, env: { HEARTBEAT_KEEP_AWAKE: '0' }, spawnFn: fake }), false);
  assert.equal(calls.length, 0);

  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(holdIdleAwake({ platform: 'darwin', pid: 7, env: {}, spawnFn: throwing }), false);
  // A late async spawn error (missing binary) must be swallowed by the listener, not crash the arm.
  const emitter = new EventEmitter();
  emitter.unref = () => {};
  assert.equal(holdIdleAwake({ platform: 'darwin', pid: 7, env: {}, spawnFn: () => emitter }), true);
  assert.doesNotThrow(() => emitter.emit('error', new Error('ENOENT')));
});
