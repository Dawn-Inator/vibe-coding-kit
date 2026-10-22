import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES, checkItems, checkLedger, countWakeSections, findDuplicateItemIds, findStrayItemRows, parseItems } from '../../src/supervision/check-heartbeat-ledger.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'check-heartbeat-ledger.mjs');
const SKILL = join(HERE, '..', '..', 'vibe-coding', 'skills', 'agent-task-supervision', 'SKILL.md');

const GOOD = {
  1: '(1a) in-flight w1; (1b) empty -- `ls .todolist` shows nothing free',
  10: 'done -- `check-units --matrix stage-x-unit` every unit current',
};

const SOURCES = 'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T09:30Z) worker-health(✓)';

// One wake section. `rows` overrides individual row states by number; `omit` drops rows; `sources` toggles the line.
function wake(time, { rows = {}, omit = [], sources = true, sourcesLine = SOURCES, heading, extra = '' } = {}) {
  const lines = ['----', heading ?? `## ${time} wake (10-row ledger)`];
  if (sources) lines.push(sourcesLine);
  lines.push('', '| # | category | state |', '| --- | --- | --- |');
  CATEGORIES.forEach((name, index) => {
    const num = index + 1;
    if (omit.includes(num)) return;
    const state = rows[num] ?? GOOD[num] ?? 'empty -- `git log a..b` is empty';
    lines.push(`| ${num} | ${name} | ${state} |`);
  });
  return `${lines.join('\n')}\n${extra ? `${extra}\n` : ''}`;
}

const rules = (findings) => findings.map((f) => f.rule);

test('a complete wake section is green, whole-file and --latest', () => {
  const text = wake('2026-01-01T10:00Z') + wake('2026-01-01T10:20Z');
  assert.deepEqual(checkLedger(text), []);
  assert.deepEqual(checkLedger(text, { latest: true }), []);
  assert.equal(countWakeSections(text), 2);
});

test('a file without any wake heading is red', () => {
  assert.deepEqual(rules(checkLedger('# notes\nnothing here\n')), ['no-wake-sections']);
});

test('missing sources line, missing row and duplicate row are each red', () => {
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { sources: false }))), ['sources-missing']);
  const missing = checkLedger(wake('2026-01-01T10:00Z', { omit: [7] }));
  assert.deepEqual(rules(missing), ['row-missing']);
  assert.match(missing[0].message, /row 7 \(follow-ups from finished workers\)/);
  const dup = wake('2026-01-01T10:00Z') + '| 4 | long-lived knowledge artifacts | empty -- `ls doc` |\n';
  assert.deepEqual(rules(checkLedger(dup)), ['row-duplicate']);
});

test('heading without an ISO time is red', () => {
  const findings = checkLedger(wake('x', { heading: '## noon wake (10-row ledger)' }));
  assert.deepEqual(rules(findings), ['heading-time']);
});

test('row 1 must carry both (1a) and (1b)', () => {
  const findings = checkLedger(wake('2026-01-01T10:00Z', { rows: { 1: 'empty -- `ls`' } }));
  assert.deepEqual(rules(findings), ['goal-row-parts']);
});

test('a bare "blocked" or a vague resource is red; a named resource is green', () => {
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: 'blocked' } }))), ['blocked-resource']);
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: 'blocked <- in flight' } }))), ['blocked-resource']);
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: 'blocked because a worker is nearby' } }))), ['blocked-resource']);
  const ok = wake('2026-01-01T10:00Z', { rows: { 3: 'blocked <- src/api write set held by worker w2' } });
  assert.deepEqual(checkLedger(ok), []);
});

test('deferred needs the strict syntax', () => {
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 2: 'deferred to later' } }))), ['deferred-syntax']);
  const ok = wake('2026-01-01T10:00Z', { rows: { 2: 'deferred <- worker w3 final report ETA <=20m' } });
  assert.deepEqual(checkLedger(ok), []);
});

test('the same deferred input on two consecutive wakes is red, a changed input is green', () => {
  const deferred = (input) => ({ rows: { 8: `deferred <- ${input} ETA <=20m` } });
  const verdict = { extra: 're-split: rows(r8: cannot-split: owner-gated)\nsplittable: 0/1' };
  const repeated = wake('2026-01-01T10:00Z', deferred('w3 report')) + wake('2026-01-01T10:20Z', { ...deferred('W3 Report'), ...verdict });
  const findings = checkLedger(repeated);
  assert.deepEqual(rules(findings), ['deferred-repeat']);
  assert.deepEqual(rules(checkLedger(repeated, { latest: true })), ['deferred-repeat']);
  const changed = wake('2026-01-01T10:00Z', deferred('w3 report')) + wake('2026-01-01T10:20Z', deferred('w4 report'));
  assert.deepEqual(checkLedger(changed), []);
});

test('empty and done rows need evidence', () => {
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 5: 'empty' } }))), ['evidence-missing']);
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 5: 'done -- landed a1b2c3d4e5' } }))), []);
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 5: 'whatever' } }))), ['state-unknown']);
});

test('--latest ignores red history but still grades the newest section', () => {
  const history = wake('2026-01-01T10:00Z', { omit: [9], sources: false });
  const newest = wake('2026-01-01T10:20Z');
  assert.ok(checkLedger(history + newest).length > 0);
  assert.deepEqual(checkLedger(history + newest, { latest: true }), []);
  const badNewest = history + wake('2026-01-01T10:20Z', { omit: [2] });
  assert.deepEqual(rules(checkLedger(badNewest, { latest: true })), ['row-missing']);
});

test('the category names are the ones the supervision skill uses', () => {
  const skill = readFileSync(SKILL, 'utf8').replace(/\s+/g, ' ').toLowerCase();
  for (const name of CATEGORIES) assert.ok(skill.includes(name), `SKILL.md does not mention category "${name}"`);
});

// ---- `unchanged` shorthand ----

const unchangedRows = (...nums) => Object.fromEntries(nums.map((n) => [n, `unchanged — \`git log base..tip\``]));
const WAKE_A = '2026-01-01T10:00Z';
const WAKE_B = '2026-01-01T10:20Z';
const WAKE_C = '2026-01-01T10:40Z';
const unchangedRules = (text, opts) => checkLedger(text, opts).filter((f) => f.rule === 'unchanged-shorthand');

test('unchanged: rows 2-9 may carry a rerun command forward, wake after wake', () => {
  const text = wake(WAKE_A) + wake(WAKE_B, { rows: unchangedRows(2, 3, 4, 5, 6, 7, 8, 9) }) + wake(WAKE_C, { rows: unchangedRows(2, 9) });
  assert.deepEqual(checkLedger(text), []);
  assert.deepEqual(checkLedger(text, { latest: true }), []);
});

test('unchanged: refused on the first wake', () => {
  assert.equal(unchangedRules(wake(WAKE_A, { rows: unchangedRows(2) })).length, 1);
  // ...and under --latest, a lone first section is still a first wake.
  assert.equal(unchangedRules(wake(WAKE_A, { rows: unchangedRows(2) }), { latest: true }).length, 1);
});

test('unchanged: refused on a row that was deferred last wake, and the refusal sticks until it is restated', () => {
  const deferred = { rows: { 6: 'deferred <- worker w3 report ETA <=20m' } };
  const text = wake(WAKE_A, deferred) + wake(WAKE_B, { rows: unchangedRows(6) });
  assert.equal(unchangedRules(text).length, 1);
  assert.match(unchangedRules(text)[0].message, /deferred last wake/);
  const chain = text + wake(WAKE_C, { rows: unchangedRows(6) });
  assert.equal(unchangedRules(chain).length, 2, 'an unchanged chain inherits the deferred kind');
  const restated = text + wake(WAKE_C, { rows: { 6: 'done -- `git log -1 tip` shows the report landed' } });
  assert.equal(unchangedRules(restated).length, 1);
  assert.deepEqual(rules(checkLedger(restated, { latest: true })), []);
});

test('unchanged: refused on the goal row parts (1a/1b) and the drift row (10)', () => {
  const base = wake(WAKE_A);
  assert.equal(unchangedRules(base + wake(WAKE_B, { rows: { 1: '(1a) unchanged — `ls .todolist`; (1b) empty -- `ls`' } })).length, 1);
  assert.equal(unchangedRules(base + wake(WAKE_B, { rows: { 1: '(1a) in-flight w1; (1b) unchanged — `ls .todolist`' } })).length, 1);
  assert.equal(unchangedRules(base + wake(WAKE_B, { rows: unchangedRows(10) })).length, 1);
  assert.match(unchangedRules(base + wake(WAKE_B, { rows: unchangedRows(10) }))[0].message, /only rows 2-9/);
});

test('unchanged: must cite a backticked command', () => {
  const base = wake(WAKE_A);
  assert.equal(unchangedRules(base + wake(WAKE_B, { rows: { 3: 'unchanged' } })).length, 1);
  assert.equal(unchangedRules(base + wake(WAKE_B, { rows: { 3: 'unchanged — nothing moved' } })).length, 1);
  assert.match(unchangedRules(base + wake(WAKE_B, { rows: { 3: 'unchanged' } }))[0].message, /backticks/);
});

test('unchanged: refused when the previous wake has no valid state for the row', () => {
  assert.equal(unchangedRules(wake(WAKE_A, { omit: [4] }) + wake(WAKE_B, { rows: unchangedRows(4) })).length, 1);
  assert.equal(unchangedRules(wake(WAKE_A, { rows: { 4: 'garbage' } }) + wake(WAKE_B, { rows: unchangedRows(4) })).length, 1);
});

test('unchanged: --latest still resolves the carry-forward through older sections', () => {
  const history =
    wake(WAKE_A, { rows: { 6: 'deferred <- worker w3 report ETA <=20m' } }) +
    wake(WAKE_B, { rows: { ...unchangedRows(5), 6: 'deferred <- worker w4 report ETA <=20m' } });
  assert.equal(unchangedRules(history + wake(WAKE_C, { rows: unchangedRows(6) }), { latest: true }).length, 1);
  assert.equal(unchangedRules(history + wake(WAKE_C, { rows: unchangedRows(5) }), { latest: true }).length, 0);
  // Red history is not graded under --latest.
  assert.equal(unchangedRules(history + wake(WAKE_C, { rows: unchangedRows(2) }), { latest: true }).length, 0);
});

test('unchanged is listed as an allowed state and is not a way around the evidence rules', () => {
  const unknown = checkLedger(wake(WAKE_A, { rows: { 5: 'whatever' } }));
  assert.match(unknown[0].message, /in-flight \/ dispatched \/ blocked \/ deferred \/ empty \/ done \/ unchanged/);
  // `unchanged` after a done row is fine; after an `empty` row without evidence it is refused (no valid previous state).
  assert.equal(unchangedRules(wake(WAKE_A, { rows: { 5: 'empty' } }) + wake(WAKE_B, { rows: unchangedRows(5) })).length, 0);
});

// ---- `sources:` line and the drift row under --latest ----

const sourcesLine = (overrides = {}) => {
  const tokens = {
    sweep: '✓',
    landings: '✓',
    reports: '✓',
    'drift-matrix': '✓',
    'memory/handoff': '✓ at resume',
    'external-backlog': '✓ 2026-01-01T09:30Z',
    'worker-health': '✓',
    ...overrides,
  };
  return `sources: ${Object.entries(tokens).filter(([, v]) => v !== null).map(([k, v]) => `${k}(${v})`).join(' ')}`;
};
const latestRules = (text) => rules(checkLedger(text, { latest: true }));
const OWNER_ITEM = items('| I1 | owner:msg | open the external-backlog access question | owner <- security boundary + checked, no standing authorization covers the login | - |');

test('sources: the skill form is green under --latest and every required channel is enforced', () => {
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine() })), []);
  for (const channel of ['sweep', 'landings', 'reports', 'drift-matrix', 'memory/handoff', 'worker-health', 'external-backlog']) {
    const text = wake(WAKE_A, { sourcesLine: sourcesLine({ [channel]: null }) });
    const findings = checkLedger(text, { latest: true });
    assert.deepEqual(rules(findings), ['sources-incomplete'], channel);
    assert.ok(findings[0].message.includes(channel), channel);
  }
});

test('sources: default mode only needs the line to exist; a channel marked skipped is red under --latest', () => {
  assert.deepEqual(checkLedger(wake(WAKE_A, { sourcesLine: 'sources: landings(ok)' })), []);
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ landings: 'skipped' }) })), ['sources-token-unchecked']);
});

test('sources: external-backlog read within 6h of the wake is green, older is red', () => {
  const at = (stamp) => wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': `✓ ${stamp}` }) });
  assert.deepEqual(latestRules(at('2026-01-01T04:00Z')), [], 'exactly 6h');
  assert.deepEqual(latestRules(at('2026-01-01T03:59Z')), ['external-backlog-stale']);
  assert.deepEqual(latestRules(at('2025-12-30T10:00Z')), ['external-backlog-stale']);
  assert.deepEqual(checkLedger(at('2025-12-30T10:00Z')), [], 'default mode stays lenient');
});

test('sources: a read mark without a timestamp, or a free-form value, is red', () => {
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': '✓' }) })), ['external-backlog-timestamp-missing']);
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': '✓ yesterday' }) })), ['external-backlog-timestamp-missing']);
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': 'unreachable' }) })), ['external-backlog-format']);
});

test('sources: external-backlog blocked needs a matching owner item in the registry', () => {
  const blocked = wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': 'blocked ← tracker login expired' }), extra: 're-split: rows(I1: cannot-split: owner-gated)\nsplittable: 0/1' });
  assert.deepEqual(latestRules(blocked), ['external-backlog-owner-missing']);
  assert.deepEqual(latestRules(blocked + items('| I1 | report:w1 | unrelated | dispatched w1 | - |')), ['external-backlog-owner-missing']);
  assert.deepEqual(latestRules(blocked + items('| I1 | sweep:external-backlog | external-backlog login | blocked <- credential | - |')), ['external-backlog-owner-missing'], 'must be an owner row');
  assert.deepEqual(latestRules(blocked + OWNER_ITEM), []);
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': 'blocked <- tracker login expired' }) }) + OWNER_ITEM), []);
  assert.deepEqual(latestRules(wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': 'blocked ←' }) })), ['external-backlog-format']);
});

test('sources: a named backlog token is matched by its own name in the owner item', () => {
  const blocked = wake(WAKE_A, { sourcesLine: sourcesLine({ 'external-backlog': null }) + ' external-backlog:bugs(blocked ← no access)' });
  const named = items('| I1 | owner:msg | get access to the bugs tracker | owner <- owner decision + checked, no standing authorization covers new access | - |');
  assert.deepEqual(latestRules(blocked), ['external-backlog-owner-missing']);
  assert.deepEqual(latestRules(blocked + named), []);
});

test('drift row: under --latest an empty/done drift row must cite the matrix or name the unchecked units', () => {
  assert.deepEqual(latestRules(wake(WAKE_A, { rows: { 10: 'empty -- `curl /health` is current' } })), ['drift-matrix-missing']);
  assert.deepEqual(latestRules(wake(WAKE_A, { rows: { 10: 'done -- `check --matrix` all units current' } })), []);
  assert.deepEqual(latestRules(wake(WAKE_A, { rows: { 10: 'empty -- `git log` unchecked: unit-b (no build this cycle)' } })), []);
  assert.deepEqual(latestRules(wake(WAKE_A, { rows: { 10: 'dispatched w4' } })), []);
  assert.deepEqual(checkLedger(wake(WAKE_A, { rows: { 10: 'empty -- `curl /health` is current' } })), [], 'default mode stays lenient');
});

// ---- Audit of the skill's checkable claims ----

test('skill claims: the allowed state forms, sources tokens and checker bullets are all in the skill text', () => {
  const skill = readFileSync(SKILL, 'utf8');
  for (const form of ['in-flight', 'dispatched', 'blocked ←', 'deferred ←', 'empty —', 'done —', 'unchanged —']) assert.ok(skill.includes(form), form);
  for (const token of ['sweep(✓)', 'landings(✓)', 'reports(✓)', 'drift-matrix(✓)', 'memory/handoff(✓ at resume)', 'external-backlog(✓ <timestamp>|blocked ← <reason>)', 'worker-health(✓)']) {
    assert.ok(skill.includes(token), token);
  }
  assert.ok(skill.includes('rows 2–9'));
  assert.ok(skill.includes('--latest') && skill.includes('--items'));
});

test('skill claims: the glyph forms the skill shows (← and —) are accepted, a bare dash-less state is not', () => {
  const ok = wake(WAKE_A, { rows: { 2: 'blocked ← src/a.ts write set held by w2', 3: 'deferred ← worker w3 report ETA ≤20m', 4: 'empty — `git log a..b` is empty', 5: 'done — `node --test` green' }, extra: 're-split: rows(r2: cannot-split: same-file conflict: src/a.ts; r3: split->dispatched w3)\nsplittable: 1/1' });
  assert.deepEqual(checkLedger(ok, { latest: true }), []);
});

test('skill claims: in-flight and dispatched must name an agent or unit', () => {
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 2: 'in-flight' } }))), ['unit-missing']);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 2: 'dispatched' } }))), ['unit-missing']);
  assert.deepEqual(checkLedger(wake(WAKE_A, { rows: { 2: 'dispatched: w4 (review of abc1234)' } })), []);
});

test('skill claims: deferred has a fixed shape, 20 minutes at most', () => {
  for (const state of ['deferred <- worker report', 'deferred <- worker report ETA <=30m', 'deferred <- worker report ETA 20m', 'deferred ETA <=20m']) {
    assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 4: state } }))), ['deferred-syntax'], state);
  }
  assert.deepEqual(checkLedger(wake(WAKE_A, { rows: { 4: 'deferred ← worker report ETA ≤20m' } })), []);
});

test('skill claims: the goal row restates 1a and 1b separately, each part graded and deferral tracked per part', () => {
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 1: '(1a) bogus; (1b) empty -- `ls`' } }))), ['state-unknown']);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 1: '(1a) empty -- `ls`; (1b) done' } }))), ['evidence-missing']);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 1: '(1a) in-flight; (1b) empty -- `ls`' } }))), ['unit-missing']);
  const partDeferred = (input) => ({ rows: { 1: `(1a) in-flight w1; (1b) deferred <- ${input} ETA <=20m` } });
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, partDeferred('w3 report')) + wake(WAKE_B, partDeferred('w3 report')))), ['deferred-repeat']);
});

test('skill claims: a SHA counts as evidence only if it looks like one; a bare word of hex letters does not', () => {
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 5: 'done -- effaced' } }))), ['evidence-missing']);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 5: 'done -- landed as 1a2b3c4' } }))), []);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 5: 'empty -- looked around' } }))), ['evidence-missing']);
});

test('skill claims: rows outside 1..10 and a missing heading time are red', () => {
  const extra = wake(WAKE_A) + '| 11 | invented | empty -- `ls` |\n';
  assert.deepEqual(rules(checkLedger(extra)), ['row-number']);
});

test('skill claims: each ledger rule lives on the newest section only under --latest, except sources/rows grading of it', () => {
  const bad = wake(WAKE_A, { omit: [3], sources: false });
  assert.deepEqual(rules(checkLedger(bad + wake(WAKE_B), { latest: true })), []);
  assert.deepEqual(rules(checkLedger(wake(WAKE_A) + bad, { latest: true })).sort(), ['row-missing', 'sources-missing']);
});

// ---- Items registry ----

function items(...rows) {
  return ['## Items', '', '| id | source | item | status | evidence |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

test('a clean registry is green', () => {
  const text = items(
    '| I1 | landing:abc1234 | review the landing | dispatched w1 | - |',
    '| I2 | report:w1 | add missing fixture | done | `node --test` green on abc1234 |',
    '| I3 | sweep:release/deploy prep | publish | blocked <- release window | - |',
    '| I4 | owner:msg | rotate credential | owner <- irreversible + standing authorization checked, does not cover rotation | - |',
  );
  assert.deepEqual(checkItems(text), []);
});

test('registry red paths: ready, bad source, done without evidence, owner without proof, duplicate id', () => {
  const text = items(
    '| I1 | memory:notes | pending | ready | - |',
    '| I2 | whatever | bad source | dispatched w1 | - |',
    '| I3 | report:w1 | done no proof | done | - |',
    '| I4 | owner:msg | ask | owner <- irreversible | - |',
    '| I4 | owner:msg | ask again | blocked | - |',
  );
  assert.deepEqual(
    rules(checkItems(text)).sort(),
    ['item-blocked', 'item-done-evidence', 'item-id', 'item-owner-proof', 'item-ready', 'item-source'],
  );
});

test('a registry row appended below the table is red, wake-ledger rows are not mistaken for it', () => {
  const text = `${items('| I1 | landing:abc1234 | review | dispatched w1 | - |')}\n----\n## 2026-01-01T12:00Z wake (10-row ledger)\n| 1 | goal-derived remaining work | (1a) done -- \`x\`; (1b) done -- \`y\` |\n| I2 | report:w1 | follow-up | dispatched w2 | - |\n`;
  assert.deepEqual(rules(checkItems(text)), ['item-outside-table']);
  assert.deepEqual(findStrayItemRows(text).map((row) => row.id), ['I2']);
  assert.deepEqual(findStrayItemRows(items('| I1 | landing:abc1234 | review | done | `x` |')), []);
});

test('the registry parser and duplicate detector are exported for reuse', () => {
  const { found, rows } = parseItems(items('| I1 | memory:a | x | dispatched w | - |', '| I1 | memory:b | y | dispatched w | - |'));
  assert.equal(found, true);
  assert.deepEqual(findDuplicateItemIds(rows).map((dup) => dup.id), ['I1']);
});

test('missing or empty Items table is red', () => {
  assert.deepEqual(rules(checkItems('nothing')), ['no-items-table']);
  assert.deepEqual(rules(checkItems(items())), ['items-empty']);
});

test('replays: N>=3 without an audit item is red, with an audit item green', () => {
  const noAudit = items('| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=3 |');
  assert.deepEqual(rules(checkItems(noAudit)), ['replay-audit']);
  const withAudit = items(
    '| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=3 |',
    '| I2 | audit:publish-a | root-cause audit | dispatched w2 | - |',
  );
  assert.deepEqual(checkItems(withAudit), []);
  const viaReport = items(
    '| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=4 |',
    '| I2 | report:I1 | root-cause audit of the republish | done | `audit.md` |',
  );
  assert.deepEqual(checkItems(viaReport), []);
  assert.deepEqual(checkItems(items('| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=2 |')), []);
});

test('replays: a decreasing count is red', () => {
  const text = items(
    '| I1 | report:w1 | first | dispatched w1 | replays:publish-a=2 |',
    '| I2 | report:w1 | second | dispatched w1 | replays:publish-a=1 |',
  );
  assert.deepEqual(rules(checkItems(text)), ['replay-decreased']);
});

test('registry: every source prefix the skill lists is accepted, anything else is red', () => {
  for (const source of ['memory:f', 'handoff:f', 'report:w1', 'landing:abc1234', 'owner:msg', 'sweep:2', 'audit:unit', 'goal:topic']) {
    assert.deepEqual(checkItems(items(`| I1 | ${source} | x | dispatched w1 | - |`)), [], source);
  }
  assert.deepEqual(rules(checkItems(items('| I1 | todo:thing | x | dispatched w1 | - |'))), ['item-source']);
  assert.deepEqual(rules(checkItems(items('| I1 | report: | x | dispatched w1 | - |'))), ['item-source']);
});

test('registry: statuses are ready / dispatched <unit> / done / blocked <- / owner <- and nothing else', () => {
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | in progress | - |'))), ['item-status']);
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | dispatched | - |'))), ['item-status']);
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | | - |'))), ['item-status']);
  assert.deepEqual(checkItems(items('| I1 | report:w1 | x | dispatched: w2 | - |')), []);
});

test('registry: a blocked item names an exclusive resource, an owner item cites one of the four hard categories', () => {
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | blocked | - |'))), ['item-blocked']);
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | blocked <- in flight | - |'))), ['item-blocked']);
  assert.deepEqual(checkItems(items('| I1 | report:w1 | x | blocked ← port 3000 held by w2 | - |')), []);
  const owner = (status) => checkItems(items(`| I1 | owner:msg | x | ${status} | - |`));
  assert.deepEqual(rules(owner('owner <- irreversible')), ['item-owner-proof']);
  assert.deepEqual(rules(owner('owner <- + checked')), ['item-owner-proof']);
  assert.deepEqual(rules(owner('owner <- it is hard + checked, not covered')), ['item-owner-category']);
  for (const category of ['irreversible', 'security boundary', 'significant cost', 'owner decision']) {
    assert.deepEqual(owner(`owner ← ${category} + standing authorization checked, does not cover this`), [], category);
  }
});

test('registry: a done item needs evidence, a dash is not evidence', () => {
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | done | |'))), ['item-done-evidence']);
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | done | - |'))), ['item-done-evidence']);
});

test('registry: ready rows are counted red one by one', () => {
  const found = checkItems(items('| I1 | memory:a | x | ready | - |', '| I2 | memory:b | y | ready | - |', '| I3 | memory:c | z | dispatched w1 | - |'));
  assert.deepEqual(rules(found), ['item-ready', 'item-ready']);
});

test('registry: a duplicate id is red on the second row only', () => {
  const found = checkItems(items('| I1 | memory:a | x | dispatched w1 | - |', '| I1 | memory:b | y | dispatched w1 | - |'));
  assert.deepEqual(found.map((f) => f.rule), ['item-id']);
  assert.match(found[0].message, /line \d+/);
});

test('registry: replay audits only count when done or dispatched; every unit is tracked on its own', () => {
  const blockedAudit = items(
    '| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=3 |',
    '| I2 | audit:publish-a | root-cause audit | blocked <- reviewer | - |',
  );
  assert.deepEqual(rules(checkItems(blockedAudit)), ['replay-audit']);
  const otherUnit = items(
    '| I1 | report:w1 | republish | dispatched w1 | replays:publish-a=3 |',
    '| I2 | audit:publish-b | audit of another unit | done | `x` |',
  );
  assert.deepEqual(rules(checkItems(otherUnit)), ['replay-audit']);
  const units = items(
    '| I1 | report:w1 | a | dispatched w1 | replays:unit-a=2 |',
    '| I2 | report:w1 | b | dispatched w1 | replays:unit-b=1 |',
    '| I3 | report:w1 | a again | dispatched w1 | replays:unit-a=3 |',
    '| I4 | audit:unit-a | audit | done | `x` |',
  );
  assert.deepEqual(checkItems(units), []);
});

test('registry: a replay count can sit in the status or the evidence column', () => {
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | republish | dispatched w1 replays:publish-a=3 | - |'))), ['replay-audit']);
  assert.deepEqual(rules(checkItems(items('| I1 | report:w1 | x | dispatched w1 | replays:a=2 |', '| I2 | report:w1 | y | dispatched w1 | replays:a=2 |', '| I3 | report:w1 | z | dispatched w1 | replays:a=1 |'))), ['replay-decreased']);
});

// ---- CLI ----

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI: exit 0 green, exit 1 with one line per red row, exit 2 on usage', () => {
  const dir = mkdtempTracked('hb-ledger-');
  const ledger = join(dir, 'heartbeat.md');
  writeFileSync(ledger, wake('2026-01-01T10:00Z', { omit: [2, 3] }));
  const red = runCli([ledger]);
  assert.equal(red.status, 1);
  assert.equal(red.stdout.trim().split('\n').length, 2);
  assert.match(red.stdout, /RED \[row-missing\]/);

  writeFileSync(ledger, wake('2026-01-01T10:00Z') + items('| I1 | landing:abc1234 | x | dispatched w1 | - |'));
  assert.equal(runCli(['--', ledger, '--latest']).status, 0);
  assert.equal(runCli([ledger, '--items']).status, 0);

  assert.equal(runCli([]).status, 2);
  assert.equal(runCli([join(dir, 'missing.md')]).status, 2);
  assert.equal(runCli([ledger, '--bogus']).status, 2);
});

// ---- fake "blocked", stale blocked rows, dispatch freezes, write-set locks ----------------------------

const itemsTable = (rows) =>
  ['## Items', '', '| id | source | item | status | evidence |', '| --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`), ''].join('\n');
const NOW = new Date('2026-01-01T12:00:00Z');

test('blocked on landing-stage resources alone is red; with a genuine first-step resource it is green', () => {
  for (const reason of ['candidate-preflight slots', 'X landing in flight', 'host CPU reserved for the freeze', 'the finish lock']) {
    const found = checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: `blocked <- ${reason}` } }));
    assert.deepEqual(rules(found), ['blocked-landing-stage-resource'], reason);
    assert.match(found[0].message, /first step \(implementation on a branch\) is not blocked by .*; mark free and dispatch, landing waits on the resource/);
  }
  assert.deepEqual(checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: 'blocked <- landing in flight AND develop tip must not move' } })), []);
  const items = itemsTable([['I1', 'report:a', 'x', 'blocked <- preflight slots', '-'], ['I2', 'report:b', 'x', 'blocked <- finish lock + Owner approval', '-']]);
  assert.deepEqual(rules(checkItems(items, { now: NOW })), ['blocked-landing-stage-resource']);
});

test('a write-set reason must name files, not a branch', () => {
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 3: 'blocked <- write set of claude/big held by w1' } }))), ['write-set-no-paths']);
  assert.deepEqual(rules(checkItems(itemsTable([['I1', 'report:a', 'x', 'blocked <- whole-branch write set', '-']]), { now: NOW })), ['write-set-no-paths']);
});

test('blocked rows are stale when they cite a done unit, SHA or item, or have not changed for 24h', () => {
  const items = itemsTable([
    ['I1', 'report:ALPHA', 'a', 'done', 'landed 1234567abc'],
    ['I2', 'report:BETA', 'b', 'blocked <- item I1 not landed', '-'],
    ['I3', 'report:GAMMA', 'c', 'blocked <- report:ALPHA fixes', '-'],
    ['I4', 'report:DELTA', 'd', 'blocked <- branch 1234567abc00', '-'],
    ['I5', 'report:EPS', 'e', 'blocked <- stg receipt', 'since 2025-12-30T09:00Z'],
    ['I6', 'report:ZETA', 'f', 'blocked <- stg receipt', 'since 2025-12-30T09:00Z, verified 2026-01-01T11:00Z'],
  ]);
  assert.deepEqual(rules(checkItems(items, { now: NOW })), ['blocked-stale', 'blocked-stale', 'blocked-stale', 'blocked-stale']);
  const cell = 'blocked <- stg receipt cand75';
  const long = wake('2025-12-30T08:00Z', { rows: { 3: cell } }) + wake('2025-12-31T09:00Z', { rows: { 3: cell } }) + wake('2026-01-01T09:00Z', { rows: { 3: cell } });
  assert.deepEqual(rules(checkLedger(long)), ['blocked-stale', 'blocked-stale'], 'every wake past 24h of the unchanged streak is red');
});

test('blocked-stale matches a done unit only by explicit token, never a bare name or a path segment', () => {
  const items = itemsTable([
    ['I1', 'report:rot-gate', 'a', 'done', 'landed'],
    ['I2', 'report:b', 'b', 'blocked <- write set engineering/testing/rot-gate/** held by w1', '-'],
    ['I3', 'report:c', 'c', 'blocked <- rot-gate fixes required', '-'],
    ['I4', 'report:d', 'd', 'blocked <- audit:rot-gate follow-up', '-'],
  ]);
  const found = checkItems(items, { now: NOW });
  assert.deepEqual(rules(found), ['blocked-stale']);
  assert.match(found[0].message, /item I4 /);
});

test('an orchestrator dispatch freeze needs an expiry or recheck condition and may not outlive it', () => {
  const unbounded = itemsTable([['I1', 'sweep:load', 'no new write dispatches until the queue drains', 'dispatched orch', '-']]);
  assert.deepEqual(rules(checkItems(unbounded, { now: NOW })), ['dispatch-freeze-unbounded']);
  const expired = itemsTable([['I1', 'sweep:load', 'no new write dispatches', 'dispatched orch', 'expires 2026-01-01T06:00Z']]);
  assert.deepEqual(rules(checkItems(expired, { now: NOW })), ['dispatch-freeze-expired']);
  const ok = itemsTable([['I1', 'sweep:load', 'no new write dispatches', 'dispatched orch', 'expires 2026-01-01T18:00Z'], ['I2', 'sweep:load', 'pause dispatch', 'dispatched orch', 'recheck: load < 2x cores']]);
  assert.deepEqual(checkItems(ok, { now: NOW }), []);
  assert.deepEqual(rules(checkLedger(wake('2026-01-01T10:00Z', { rows: { 5: 'blocked <- no new write dispatches until the queue drains' } }))).sort(), ['blocked-landing-stage-resource', 'dispatch-freeze-unbounded']);
});

// --- Owner 2026-10-17: the default answer to "can it be split?" is yes ------------------------------------------

const UNLANDED_ROWS = ['claude/rotbatch unlanded output', 'claude/carrier0 unlanded output', 'claude/rotbatch + claude/astindex unlanded output (rot gate on gate/staging only meaningful after cure lands)', 'claude/preflightspeed unlanded output (SELECTGAP2 relaunch, I594)'];

test('blocked on another unit\'s unlanded branch/output is red without a tagged proof (the 2026-10-17 rows)', () => {
  for (const reason of UNLANDED_ROWS) {
    const found = checkLedger(wake(WAKE_A, { rows: { 7: `blocked ← ${reason}` } }));
    assert.deepEqual(rules(found), ['blocked-on-unlanded-branch-defaults-free'], reason);
    assert.match(found[0].message, /FREE by default/);
    assert.deepEqual(rules(checkItems(itemsTable([['I1', 'report:a', 'x', `blocked ← ${reason}`, '-']]), { now: NOW })), ['blocked-on-unlanded-branch-defaults-free'], reason);
  }
});

test('a tagged proof keeps an unlanded-branch block green; a malformed tag does not', () => {
  const ok = [
    'fleet roll waits on claude/carrier0 unlanded output; needs-landed: production effect (fleet roll needs the landed carrier SHA)',
    'claude/x unlanded output; branch-unstable: claude/x rewritten 12 min ago',
    'claude/x unlanded output; owner-gated',
    'claude/x unlanded output; same-file conflict: engineering/testing/rot-gate/run.mjs',
  ];
  for (const reason of ok) assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 7: `blocked ← ${reason}` } }))), [], reason);
  const bad = ['claude/x unlanded output; needs-landed: output', 'claude/x unlanded output; same-file conflict: claude/y', 'claude/x unlanded output; branch-unstable: soon'];
  for (const reason of bad) assert.deepEqual(rules(checkLedger(wake(WAKE_A, { rows: { 7: `blocked ← ${reason}` } }))), ['blocked-on-unlanded-branch-defaults-free'], reason);
});

const RESPLIT_DISPATCH = 're-split: prep-ahead(dispatched P1) lessons(done) audit(dispatched A1) rows(r6: split->dispatched CARRIER0; r7: cannot-split: owner-gated)';
const twoOpen = { rows: { 6: 'blocked ← green full run receipt', 7: 'deferred ← w9 report ETA <=20m' } };

test('re-split: every blocked/deferred row needs a verdict and the splittable token must add up', () => {
  const ok = wake(WAKE_A, { ...twoOpen, extra: `${RESPLIT_DISPATCH}\nsplittable: 1/1` });
  assert.deepEqual(latestRules(ok), []);
  assert.deepEqual(latestRules(wake(WAKE_A, twoOpen)), ['resplit-rows-missing', 'splittable-missing']);
  assert.deepEqual(latestRules(wake(WAKE_A, { ...twoOpen, extra: 're-split: prep-ahead(dispatched P1) lessons(done) audit(dispatched A1) rows(r6: split->dispatched C0)\nsplittable: 1/0' })), ['resplit-row-unverdicted']);
  assert.deepEqual(latestRules(wake(WAKE_A, { ...twoOpen, extra: `${RESPLIT_DISPATCH}\nsplittable: 2/0` })), ['splittable-mismatch']);
  assert.deepEqual(latestRules(wake(WAKE_A, { ...twoOpen, extra: 're-split: rows(r6: split->dispatched C0; r7: cannot-split: nothing to do here)\nsplittable: 1/0' })), ['resplit-verdict-invalid']);
  assert.deepEqual(latestRules(wake(WAKE_A, { rows: { 6: 'empty -- `git log a..b` is empty' } })), [], 'no open rows: nothing to enumerate');
});

test('re-split: a bare "none" in prep-ahead/audit is rejected while an open row lacks a proof', () => {
  const lazy = wake(WAKE_A, { ...twoOpen, extra: 're-split: prep-ahead(none — nothing to prepare today) lessons(done) audit(none — audited yesterday) rows(r6: cannot-split: owner-gated)\nsplittable: 0/1' });
  const found = checkLedger(lazy, { latest: true });
  assert.deepEqual(rules(found), ['resplit-row-unverdicted', 'resplit-none-without-proof', 'resplit-none-without-proof']);
  const proven = wake(WAKE_A, { ...twoOpen, extra: 're-split: prep-ahead(none — nothing to prepare today) lessons(done) audit(none — audited yesterday) rows(r6: cannot-split: owner-gated; r7: cannot-split: needs-landed: production effect)\nsplittable: 0/2' });
  assert.deepEqual(latestRules(proven), []);
});

test('re-split: Items registry blocked rows are enumerated too', () => {
  const registry = items('| I12 | report:a | follow-up | blocked ← claude/a unlanded output; same-file conflict: src/a.ts | - |', '| I13 | report:b | other | dispatched w2 | - |');
  assert.deepEqual(latestRules(wake(WAKE_A) + registry), ['resplit-rows-missing', 'splittable-missing']);
  assert.deepEqual(latestRules(wake(WAKE_A, { extra: 're-split: rows(I-12: cannot-split: same-file conflict: src/a.ts)\nsplittable: 0/1' }) + registry), []);
});
