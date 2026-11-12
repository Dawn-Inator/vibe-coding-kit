import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { checkHeartbeatV2 } from '../../src/supervision/heartbeat-ledger-v2.mjs';
import { checkV2Guards } from '../../src/supervision/heartbeat-ledger-v2-guards.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const ITEMS_HEADER = [
  '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function item({ id = 'I-1', source = 'owner:msg', name = 'wait for decision', status, evidence = '-', owner = 'owner', repository = 'repo-a', worktree = '/worktrees/owner', mode = 'read-only', writeSet = '[]', dispatchRef = '-' }) {
  return `| ${id} | ${source} | ${name} | ${status} | ${evidence} | ${owner} | ${repository} | ${worktree} | ${mode} | ${writeSet} | ${dispatchRef} |`;
}

function wake(minute, { row6, oneB, decompositionRows = [], verdicts = '', split = '0/0' } = {}) {
  const timestamp = `2026-01-01T10:${minute}Z`;
  const categories = CATEGORIES.map((name, index) => {
    const n = index + 1;
    let state = `done -- \`audit ${n}\``;
    if (n === 1) state = `(1a) done -- \`goal checked\`; (1b) ${oneB ?? 'done -- \`backlog checked\`'}`;
    if (n === 6 && row6) state = row6;
    if (n === 10) state = 'done -- `check --matrix stage-x-unit` current';
    return `| ${n} | ${name} | ${state} |`;
  });
  return [
    '----',
    `## ${timestamp} wake (10-row ledger)`,
    'contract: heartbeat/v2',
    `sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ ${timestamp}) worker-health(✓)`,
    '',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...categories,
    '',
    '### Decomposition',
    '| item | next_step | disposition | owner | evidence |',
    '| --- | --- | --- | --- | --- |',
    ...decompositionRows,
    `re-split: rows(${verdicts})`,
    `splittable: ${split}`,
    '',
  ].join('\n');
}

function ledger(items = [], wakes = []) {
  return `## Items\n\n${ITEMS_HEADER}\n${items.join('\n')}\n\n${wakes.join('\n')}`;
}

function fixture(text, receipts = {}) {
  const cwd = mkdtempTracked('heartbeat-v2-guards-');
  const ledgerPath = join(cwd, '.workspace', 'task', 'demo', 'heartbeat.md');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  for (const [name, value] of Object.entries(receipts)) {
    const path = join(dirname(ledgerPath), name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }
  return { text, ledgerPath };
}

const accepted = (owner) => ({
  tool: 'collaboration.spawn_agent',
  event: 'accepted',
  agent_id: owner,
  result: { task_name: owner },
});
const findingsFor = (candidate) => checkHeartbeatV2(candidate.text, { ledgerPath: candidate.ledgerPath, now: new Date('2026-01-01T11:00:00Z') });
const rulesFor = (candidate, rule) => findingsFor(candidate).filter((finding) => finding.rule === rule);

function directGuardFindings(items, oneB, verdicts = '') {
  const latestWake = {
    heading: '## 2026-01-01T10:40Z wake (10-row ledger)',
    line: 1,
    rows: [{ num: 1, state: `(1a) done -- \`goal checked\`; (1b) ${oneB}` }],
    sectionLines: verdicts ? ['contract: heartbeat/v2', `re-split: rows(${verdicts})`] : [],
  };
  return checkV2Guards({ items, wakes: [latestWake], latestWake });
}

test('three repeated owner-gated verdicts exempt only a matching owner Item, case-insensitively', () => {
  const decision = 'owner <- owner decision + checked standing authorization does not cover this decision';
  const ownerRow = item({ id: 'i-1', status: decision });
  const decomp = ['| i-1 | wait for decision | owner | owner | owner decision remains open |'];
  const repeated = ['00', '20', '40'].map((minute) => wake(minute, {
    decompositionRows: decomp,
    verdicts: 'I-1: cannot-split: owner-gated',
    split: '0/1',
  }));
  const exempt = fixture(ledger([ownerRow], repeated));
  assert.deepEqual(rulesFor(exempt, 'cannot-split-stale'), [], 'mixed-case row ID still matches the owner Item exemption');

  const blockedRow = item({ id: 'i-1', status: 'blocked <- release pipeline lock' });
  const blockedDecomp = ['| i-1 | wait for decision | blocked | owner | release pipeline lock |'];
  const notExempt = fixture(ledger([blockedRow], ['00', '20', '40'].map((minute) => wake(minute, {
    decompositionRows: blockedDecomp,
    verdicts: 'I-1: cannot-split: owner-gated',
    split: '0/1',
  }))));
  assert.equal(rulesFor(notExempt, 'cannot-split-stale').length, 1, 'the owner-gated tag alone does not exempt a non-owner Item');
});

test('v2 generic Item IDs participate in stale cannot-split checks while unmarked history keeps legacy parsing', () => {
  const rows = [item({ id: 'W1', status: 'blocked <- same-file conflict: src/worker.mjs' })];
  const v2Wakes = ['00', '20', '40'].map((minute) => wake(minute, {
    decompositionRows: ['| W1 | resolve worker boundary | blocked | owner | same-file conflict remains |'],
    verdicts: 'W1: cannot-split: same-file conflict: `src/worker.mjs`',
    split: '0/1',
  }));
  const v2 = fixture(ledger(rows, v2Wakes));
  assert.equal(rulesFor(v2, 'cannot-split-stale').length, 1, 'the v2 generic ID must be parsed consistently across all three wakes');

  const legacyWakes = v2Wakes.map((text) => text.replace('contract: heartbeat/v2\n', ''));
  const legacy = fixture(ledger(rows, legacyWakes));
  assert.deepEqual(rulesFor(legacy, 'cannot-split-stale'), [], 'an unmarked historical wake retains the legacy restricted ID grammar');
});

test('re-split after the Decomposition table still reaches blocker and stale checks', () => {
  const blocked = fixture(ledger([], [wake('20', {
    row6: 'blocked <- release pipeline lock',
    verdicts: 'r6: cannot-split: owner-gated',
    split: '0/1',
  })]));
  const findings = findingsFor(blocked);
  assert.deepEqual(findings.filter((finding) => ['resplit-rows-missing', 'resplit-row-unverdicted', 'splittable-missing'].includes(finding.rule)), []);

  const decision = 'owner <- owner decision + checked standing authorization does not cover this decision';
  const repeatedOwner = fixture(ledger([item({ id: 'i-1', status: decision })], ['00', '20', '40'].map((minute) => wake(minute, {
    decompositionRows: ['| i-1 | wait for decision | owner | owner | decision scope still outstanding |'],
    verdicts: 'I-1: cannot-split: owner-gated',
    split: '0/1',
  }))));
  assert.deepEqual(rulesFor(repeatedOwner, 'cannot-split-stale'), [], 'the trailing verdict remains visible to stale-split checks');
});

test('standing authorization covers an owner-gated Item referenced by the trailing rows(...) group', () => {
  const auth = item({
    id: 'I-3',
    name: 'standing authorization: strategy-switch',
    status: 'owner <- owner decision + checked standing authorization covers strategy-switch',
    evidence: 'standing-auth: strategy-switch',
  });
  const waiting = item({
    id: 'I-4',
    name: 'strategy-switch requested by worker',
    status: 'owner <- owner decision + checked standing authorization does not cover new request',
  });
  const decompositionRows = [
    '| I-3 | confirm whether strategy-switch is in scope | owner | owner | standing authorization record |',
    '| I-4 | resolve strategy-switch request | owner | owner | owner decision needed |',
  ];
  const candidate = fixture(ledger([auth, waiting], [wake('40', {
    decompositionRows,
    verdicts: 'I-4: cannot-split: owner-gated',
    split: '0/1',
  })]));
  assert.equal(rulesFor(candidate, 'standing-auth-covers-wait').length, 1, 'standing-auth matching must inspect owner-gated Item IDs in rows(...), not only wake table cells');

  const withoutAuth = fixture(ledger([waiting], [wake('40', {
    decompositionRows: [decompositionRows[1]],
    verdicts: 'I-4: cannot-split: owner-gated',
    split: '0/1',
  })]));
  assert.deepEqual(rulesFor(withoutAuth, 'standing-auth-covers-wait'), []);

  const revokedAuth = item({
    id: 'I-3',
    name: 'strategy-switch authorization',
    status: 'done revoked by Owner',
    evidence: 'standing-auth: strategy-switch; revocation recorded',
  });
  const afterRevocation = fixture(ledger([revokedAuth, waiting], [wake('40', {
    decompositionRows: [decompositionRows[1]],
    verdicts: 'I-4: cannot-split: owner-gated',
    split: '0/1',
  })]));
  assert.deepEqual(rulesFor(afterRevocation, 'standing-auth-covers-wait'), [], 'revoked/done authority does not cover a later owner-gated Item');
});

test('v2 standing-authorization guard matches generic IDs and keeps A-B distinct from AB', () => {
  const authorization = {
    id: 'AB',
    item: 'standing authorization switch',
    status: 'owner <- checked prior authorization recorded',
    evidence: 'standing-auth: switch',
  };
  const genericWait = {
    id: 'W1',
    item: 'request needs switch decision',
    status: 'owner <- owner decision remains open',
    evidence: '-',
  };
  const matchesGeneric = directGuardFindings([authorization, genericWait], 'done -- `backlog checked`', 'W1: cannot-split: owner-gated');
  assert.deepEqual(matchesGeneric.map((finding) => finding.rule), ['standing-auth-covers-wait']);

  const hyphenWait = {
    id: 'A-B',
    item: 'wait for retention decision',
    status: 'owner <- owner decision remains open',
    evidence: '-',
  };
  const keepsHyphenDistinct = directGuardFindings([authorization, hyphenWait], 'done -- `backlog checked`', 'A-B: cannot-split: owner-gated');
  assert.deepEqual(keepsHyphenDistinct, [], 'A-B must not resolve to the unrelated AB authorization row');
});

test('capacity does not count an accepted dispatch receipt as evidence of active work', () => {
  const worker = 'worker-7';
  const activeItem = item({
    id: 'I-7',
    source: 'report:worker-7',
    name: 'implement feature',
    status: `dispatched ${worker}`,
    evidence: 'dispatch receipt accepted; no active-session evidence yet',
    owner: worker,
    worktree: '/worktrees/worker-7',
    mode: 'write',
    writeSet: '["src/future-file.mjs"]',
    dispatchRef: 'receipts/worker-7.json',
  });
  const candidate = fixture(ledger([activeItem], [wake('40', {
    oneB: 'empty -- `session probe` found no active worker; capacity in-flight=1 free=0',
    decompositionRows: ['| I-7 | confirm session activity | dispatched | worker-7 | accepted receipt only |'],
    verdicts: '',
    split: '0/0',
  })]), { 'receipts/worker-7.json': accepted(worker) });
  const findings = findingsFor(candidate);
  assert.deepEqual(findings.filter((finding) => finding.severity === 'error'), []);
  assert.equal(findings.filter((finding) => finding.rule === 'decompose-now-capacity-unknown').length, 1, 'an accepted dispatch receipt cannot certify the claimed active-worker count');
});

test('ready registry rows produce a non-blocking decompose-now advisory', () => {
  const findings = directGuardFindings([
    { id: 'I-1', status: 'ready' },
    { id: 'I-2', status: 'ready' },
  ], 'done -- `backlog checked`');

  assert.deepEqual(findings.map((finding) => finding.rule), ['decompose-now']);
  assert.ok(findings.every((finding) => finding.severity === 'advisory'), 'readiness guidance must not add a certification error');
});

test('(1b) idle with ready or unknown registry work produces non-blocking advisories', () => {
  const findings = directGuardFindings([
    { id: 'I-1', status: 'ready' },
    { id: 'I-2', status: 'pending review' },
  ], 'empty -- `worker probe` found none');

  assert.deepEqual(findings.map((finding) => finding.rule), ['decompose-now', 'decompose-now-1b-idle']);
  assert.ok(findings.every((finding) => finding.severity === 'advisory'), 'readiness guidance must not add a certification error');
});

test('tracking parents do not create idle-work advisories while leaf unknown work remains visible', () => {
  const childrenDone = directGuardFindings([
    { id: 'I-1', status: 'tracking', children: '["I-2"]' },
    { id: 'I-2', status: 'done — child shipped' },
  ], 'empty -- `worker probe` found none');
  assert.deepEqual(childrenDone, [], 'a parent row is registry structure, not undispatched worker capacity or completion');

  const withLeafUnknown = directGuardFindings([
    { id: 'I-1', status: 'tracking', children: '["I-2"]' },
    { id: 'I-2', status: 'done — child shipped' },
    { id: 'I-3', status: 'pending review' },
  ], 'empty -- `worker probe` found none');
  assert.deepEqual(withLeafUnknown.map((finding) => finding.rule), ['decompose-now-1b-idle']);
  assert.match(withLeafUnknown[0].message, /1 undispatched non-terminal row/);
});

