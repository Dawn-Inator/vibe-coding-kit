import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES, checkLedger } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { checkHeartbeatV2 } from '../../src/supervision/heartbeat-ledger-v2.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'src', 'supervision', 'check-heartbeat-ledger.mjs');
const CATEGORIES_TABLE = CATEGORIES.map((name, index) => index === 0
  ? `| 1 | ${name} | (1a) done -- \`audit 1a\`; (1b) done -- \`audit 1b\` |`
  : index === 9
    ? `| 10 | ${name} | done -- \`check --matrix stage-x-unit\` all units current |`
    : `| ${index + 1} | ${name} | done -- \`audit ${index + 1}\` |`).join('\n');
const SOURCES = 'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T10:20Z) worker-health(✓)';
const ITEMS_HEADER = [
  '## Items',
  '',
  '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function item({ id = 'I1', source = 'report:worker-1', item = 'implement feature', status = 'dispatched worker-1', evidence = '-', owner = 'worker-1', repository = 'repo-a', worktree = '/worktrees/worker-1', mode = 'write', writeSet = '[]', dispatchRef = 'receipts/worker-1.json' } = {}) {
  return `| ${id} | ${source} | ${item} | ${status} | ${evidence} | ${owner} | ${repository} | ${worktree} | ${mode} | ${writeSet} | ${dispatchRef} |`;
}

function decomposition(rows = []) {
  return [
    '### Decomposition',
    '',
    '| item | next_step | disposition | owner | evidence |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function v2({
  items = [],
  decompositionRows = [],
  marker = 'contract: heartbeat/v2',
  extra = '',
  wake = '2026-01-01T10:20Z',
  includeResplit = true,
  includeSplitCount = true,
  includeDecomposition = true,
} = {}) {
  const section = [
    '----',
    `## ${wake} wake (10-row ledger)`,
    marker,
    SOURCES,
    '',
    '| # | category | state |',
    '| --- | --- | --- |',
    CATEGORIES_TABLE,
    '',
    ...(includeResplit ? ['re-split: rows()'] : []),
    ...(includeSplitCount ? ['splittable: 0/0'] : []),
    ...(includeDecomposition ? ['', decomposition(decompositionRows)] : []),
    extra,
  ].filter(Boolean).join('\n');
  return `${section}\n\n${ITEMS_HEADER}\n${items.join('\n')}\n`;
}

function fixture(text, receipts = {}, prepare = () => {}) {
  const cwd = mkdtempTracked('heartbeat-v2-');
  const ledgerPath = join(cwd, '.workspace', 'task', 'demo', 'heartbeat.md');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  prepare(cwd, ledgerPath);
  for (const [name, body] of Object.entries(receipts)) {
    const path = join(dirname(ledgerPath), name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  }
  const ledgerText = typeof text === 'function' ? text(cwd, ledgerPath) : text;
  writeFileSync(ledgerPath, ledgerText);
  return { text: ledgerText, ledgerPath, cwd };
}

function wakeOnly(text) {
  const marker = text.indexOf('\n\n## Items');
  return marker < 0 ? text : text.slice(0, marker);
}

function registryOnly(text) {
  const marker = text.indexOf('\n\n## Items');
  return marker < 0 ? '' : text.slice(marker + 2);
}

function withWakeHistory(...sections) {
  const newest = sections.at(-1);
  const text = `${sections.map(wakeOnly).join('\n')}\n\n${registryOnly(newest)}`;
  assert.equal((text.match(/^## Items$/gm) ?? []).length, 1, 'a heartbeat history retains one current Items registry');
  return text;
}

const accepted = (owner) => ({
  tool: 'collaboration.spawn_agent',
  event: 'accepted',
  agent_id: owner,
  result: { task_name: owner },
});
const latestRules = (text, options = {}) => checkHeartbeatV2(text, options).map((finding) => finding.rule);

test('--latest accepts the v2 contract only with an explicit zero-blocker split audit and empty decomposition', () => {
  const good = fixture(v2());
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), []);
  const cli = spawnSync(process.execPath, [CLI, good.ledgerPath, '--latest'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout);
  assert.match(cli.stdout, /OK/);

  const missingChecklist = fixture(v2({ includeDecomposition: false }));
  assert.ok(latestRules(missingChecklist.text, { ledgerPath: missingChecklist.ledgerPath }).length > 0, 'zero blockers do not waive the decomposition checklist');

  const missingResplit = fixture(v2({ includeResplit: false }));
  assert.ok(latestRules(missingResplit.text, { ledgerPath: missingResplit.ledgerPath }).length > 0, 'zero blockers still require rows()');

  const missingCount = fixture(v2({ includeSplitCount: false }));
  assert.ok(latestRules(missingCount.text, { ledgerPath: missingCount.ledgerPath }).length > 0, 'the split count is required even when there are no blocked items');
});

test('--latest requires the newest contract marker and cannot downgrade after v2', () => {
  const legacy = v2({ marker: 'contract: heartbeat/v1' });
  const good = fixture(withWakeHistory(legacy, v2({ wake: '2026-01-01T10:20Z' })));
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), []);

  const downgraded = fixture(withWakeHistory(v2({ wake: '2026-01-01T10:00Z' }), v2({ wake: '2026-01-01T10:20Z', marker: 'contract: heartbeat/v1' })));
  assert.ok(latestRules(downgraded.text, { ledgerPath: downgraded.ledgerPath }).length > 0);

  const legacyOnly = fixture(legacy);
  assert.ok(latestRules(legacyOnly.text, { ledgerPath: legacyOnly.ledgerPath }).length > 0);
  assert.deepEqual(checkLedger(legacyOnly.text), [], 'legacy parser keeps historical ledger behavior');
  const historical = spawnSync(process.execPath, [CLI, legacyOnly.ledgerPath, '--latest', '--legacy'], { encoding: 'utf8' });
  assert.equal(historical.status, 1);
  assert.match(historical.stdout, /legacy-read-only/);
});

test('every open Items row needs one matching decomposition and no ready disposition remains', () => {
  const active = item({ writeSet: '["src/future-file.mjs"]' });
  const table = v2({ items: [active], decompositionRows: ['| I1 | implement feature | dispatched | worker-1 | receipts/worker-1.json |'] });
  const good = fixture(table, { 'receipts/worker-1.json': accepted('worker-1') });
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), [], 'a future file need not exist yet');

  const uncovered = fixture(v2({ items: [active] }), { 'receipts/worker-1.json': accepted('worker-1') });
  assert.ok(latestRules(uncovered.text, { ledgerPath: uncovered.ledgerPath }).length > 0, 'an open item omitted from decomposition is red');

  const ready = fixture(v2({ items: [item({ status: 'ready' })], decompositionRows: ['| I1 | implement feature | ready | worker-1 | - |'] }), { 'receipts/worker-1.json': accepted('worker-1') });
  assert.ok(latestRules(ready.text, { ledgerPath: ready.ledgerPath }).length > 0, 'ready work remains red even when listed');

  const duplicate = fixture(v2({ items: [active], decompositionRows: [
    '| I1 | implement feature | dispatched | worker-1 | receipts/worker-1.json |',
    '| I1 | duplicate item | dispatched | worker-1 | receipts/worker-1.json |',
  ] }), { 'receipts/worker-1.json': accepted('worker-1') });
  assert.ok(latestRules(duplicate.text, { ledgerPath: duplicate.ledgerPath }).length > 0, 'duplicate decomposition IDs are red');

  const unknown = fixture(v2({ decompositionRows: ['| I9 | unrelated work | done | worker-9 | - |'] }));
  assert.ok(latestRules(unknown.text, { ledgerPath: unknown.ledgerPath }).length > 0, 'decomposition IDs absent from Items are red');

  const mismatch = fixture(v2({ items: [active], decompositionRows: ['| I1 | implement feature | continuing | someone-else | receipts/worker-1.json |'] }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.ok(latestRules(mismatch.text, { ledgerPath: mismatch.ledgerPath }).length > 0, 'decomposition owner and disposition must match current item status/owner');
});

test('a second Items registry cannot hide an otherwise omitted dispatched owner', () => {
  const hidden = item({ writeSet: '["src/hidden.mjs"]', dispatchRef: 'receipts/worker-1.json' });
  const candidate = fixture(`${v2()}\n${ITEMS_HEADER}\n${hidden}\n`, {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).length > 0, 'duplicate registries or the hidden non-done Item must make latest certification red');
});

test('dispatched writers need safe explicit file sets and disjoint logical ownership', () => {
  const writer = item({ writeSet: '["src/shared.mjs"]' });
  const rows = ['| I1 | implement feature | dispatched | worker-1 | receipts/worker-1.json |'];
  const safe = fixture(v2({ items: [writer], decompositionRows: rows }), { 'receipts/worker-1.json': accepted('worker-1') });
  assert.deepEqual(latestRules(safe.text, { ledgerPath: safe.ledgerPath }), []);

  const nextDynamic = fixture(v2({ items: [item({ writeSet: '["src/app/[id]/page.tsx"]' })], decompositionRows: rows }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.deepEqual(latestRules(nextDynamic.text, { ledgerPath: nextDynamic.ledgerPath }), [], 'literal Next [id] path segments are allowed');

  const multipleDynamic = fixture(v2({ items: [item({ writeSet: '["src/app/[locale]/[slug]/page.tsx"]' })], decompositionRows: rows }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.deepEqual(latestRules(multipleDynamic.text, { ledgerPath: multipleDynamic.ledgerPath }), [], 'literal Next [locale] and [slug] segments are allowed');

  const catchAllDynamic = fixture(v2({ items: [item({ writeSet: '["src/app/[...slug]/page.tsx"]' })], decompositionRows: rows }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.deepEqual(latestRules(catchAllDynamic.text, { ledgerPath: catchAllDynamic.ledgerPath }), [], 'literal Next [...slug] segments are allowed');

  const optionalCatchAllDynamic = fixture(v2({ items: [item({ writeSet: '["src/app/[[...slug]]/page.tsx"]' })], decompositionRows: rows }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.deepEqual(latestRules(optionalCatchAllDynamic.text, { ledgerPath: optionalCatchAllDynamic.ledgerPath }), [], 'literal Next [[...slug]] segments are allowed');

  for (const bad of ['[]', '["src/"]', '["src/**/*.mjs"]', '["../secret"]', '["src\\\\..\\\\secret"]', '["/tmp/file"]', 'not-json']) {
    const candidate = fixture(v2({ items: [item({ writeSet: bad })], decompositionRows: rows }), { 'receipts/worker-1.json': accepted('worker-1') });
    assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).length > 0, `unsafe or empty writer set accepted: ${bad}`);
  }

  const conflictItems = [
    writer,
    item({ id: 'I2', item: 'update same file', owner: 'worker-2', worktree: '/worktrees/worker-2', writeSet: '["src/shared.mjs"]', dispatchRef: 'receipts/worker-2.json' }),
  ];
  const conflictDecomposition = [
    rows[0],
    '| I2 | update same file | dispatched | worker-2 | receipts/worker-2.json |',
  ];
  const conflict = fixture(v2({ items: conflictItems, decompositionRows: conflictDecomposition }), {
    'receipts/worker-1.json': accepted('worker-1'),
    'receipts/worker-2.json': accepted('worker-2'),
  });
  assert.ok(latestRules(conflict.text, { ledgerPath: conflict.ledgerPath }).length > 0, 'same-repository overlap stays red across worktrees');

  const separatorConflict = fixture(v2({ items: [
    item({ writeSet: '["src\\\\shared.mjs"]' }),
    item({ id: 'I2', item: 'update same file', owner: 'worker-2', worktree: '/worktrees/worker-2', writeSet: '["src/shared.mjs"]', dispatchRef: 'receipts/worker-2.json' }),
  ], decompositionRows: conflictDecomposition }), {
    'receipts/worker-1.json': accepted('worker-1'),
    'receipts/worker-2.json': accepted('worker-2'),
  });
  assert.ok(latestRules(separatorConflict.text, { ledgerPath: separatorConflict.ledgerPath }).length > 0, 'slash and backslash spellings refer to the same repository path');

  const existingDirectory = fixture((cwd) => {
    const worktree = join(cwd, 'worktrees', 'worker-1');
    mkdirSync(join(worktree, 'src', 'existing-dir'), { recursive: true });
    return v2({ items: [item({ worktree, writeSet: '["src/existing-dir"]' })], decompositionRows: rows });
  }, { 'receipts/worker-1.json': accepted('worker-1') });
  assert.ok(latestRules(existingDirectory.text, { ledgerPath: existingDirectory.ledgerPath }).length > 0, 'an existing directory under the row worktree is not an exact file path');

  const symlinkAliasConflict = (aliasPath, canonicalPath, existing) => fixture((cwd) => {
    const worktree1 = join(cwd, 'worktrees', 'worker-1');
    const worktree2 = join(cwd, 'worktrees', 'worker-2');
    for (const worktree of [worktree1, worktree2]) {
      mkdirSync(join(worktree, 'src', 'actual'), { recursive: true });
      const target = process.platform === 'win32' ? join(worktree, 'src', 'actual') : 'actual';
      symlinkSync(target, join(worktree, 'src', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      if (existing) writeFileSync(join(worktree, 'src', 'actual', 'existing.mjs'), 'tracked target');
    }
    const aliasWriter = item({ worktree: worktree1, writeSet: JSON.stringify([aliasPath]) });
    const canonicalWriter = item({ id: 'I2', item: 'write through the canonical path', owner: 'worker-2', worktree: worktree2, writeSet: JSON.stringify([canonicalPath]), dispatchRef: 'receipts/worker-2.json' });
    const decomp = [
      '| I1 | write alias target | dispatched | worker-1 | receipts/worker-1.json |',
      '| I2 | write canonical target | dispatched | worker-2 | receipts/worker-2.json |',
    ];
    return v2({ items: [aliasWriter, canonicalWriter], decompositionRows: decomp });
  }, {
    'receipts/worker-1.json': accepted('worker-1'),
    'receipts/worker-2.json': accepted('worker-2'),
  });

  for (const [aliasPath, canonicalPath, existing] of [
    ['src/alias/existing.mjs', 'src/actual/existing.mjs', true],
    ['src/alias/future.mjs', 'src/actual/future.mjs', false],
  ]) {
    const alias = symlinkAliasConflict(aliasPath, canonicalPath, existing);
    assert.ok(latestRules(alias.text, { ledgerPath: alias.ledgerPath }).includes('v2-write-conflict'), `symlink alias escaped conflict for ${aliasPath}`);
  }
});

test('read-only rows can share paths, while dispatch receipts prove acceptance only and must match owner', () => {
  const readOnly = [
    item({ mode: 'read-only', writeSet: '[]' }),
    item({ id: 'I2', item: 'inspect same file', owner: 'worker-2', worktree: '/worktrees/worker-2', mode: 'read-only', writeSet: '[]', dispatchRef: 'receipts/worker-2.json' }),
  ];
  const decompositionRows = [
    '| I1 | inspect feature | dispatched | worker-1 | receipts/worker-1.json |',
    '| I2 | inspect same file | dispatched | worker-2 | receipts/worker-2.json |',
  ];
  const sharedReads = fixture(v2({ items: readOnly, decompositionRows }), {
    'receipts/worker-1.json': accepted('worker-1'),
    'receipts/worker-2.json': accepted('worker-2'),
  });
  assert.deepEqual(latestRules(sharedReads.text, { ledgerPath: sharedReads.ledgerPath }), []);

  const missing = fixture(v2({ items: [item()], decompositionRows: [decompositionRows[0]] }));
  assert.ok(latestRules(missing.text, { ledgerPath: missing.ledgerPath }).length > 0, 'missing receipt is red');
  const mismatch = fixture(v2({ items: [item()], decompositionRows: [decompositionRows[0]] }), {
    'receipts/worker-1.json': accepted('different-agent'),
  });
  assert.ok(latestRules(mismatch.text, { ledgerPath: mismatch.ledgerPath }).length > 0, 'receipt for another agent is red');

  const acceptedOnly = fixture(v2({ items: [item({ mode: 'read-only', writeSet: '[]' })], decompositionRows: [decompositionRows[0]] }), {
    'receipts/worker-1.json': accepted('worker-1'),
  });
  assert.deepEqual(latestRules(acceptedOnly.text, { ledgerPath: acceptedOnly.ledgerPath }), [], 'acceptance is sufficient for dispatch bookkeeping, not a claim of live/completed/landed status');
});

test('a done disposition cannot override a dispatched, blocked, or owner registry status, and owners must match', () => {
  const cases = [
    { status: 'dispatched worker-1', owner: 'worker-1', receipt: accepted('worker-1'), writeSet: '["src/future.mjs"]' },
    { status: 'blocked <- release pipeline lock', owner: 'worker-1', writeSet: '[]', mode: 'read-only' },
    { status: 'owner <- owner decision + checked standing authorization does not cover this', owner: 'owner', writeSet: '[]', mode: 'read-only', source: 'owner:msg' },
  ];
  for (const [index, current] of cases.entries()) {
    const id = `I${index + 1}`;
    const row = item({ ...current, id });
    const receiptPath = `receipts/${current.owner}.json`;
    const candidate = fixture(v2({
      items: [row],
      decompositionRows: [`| ${id} | continue current work | done | ${current.owner} | not completed |`],
    }), current.receipt ? { [receiptPath]: current.receipt } : {});
    assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).includes('v2-decomposition-status'), `done disposition incorrectly matched ${current.status}`);
  }

  const blocked = item({ id: 'I1', status: 'blocked <- release pipeline lock', owner: 'worker-1', writeSet: '[]', mode: 'read-only' });
  const wrongOwner = fixture(v2({
    items: [blocked],
    decompositionRows: ['| I1 | wait for the lock | blocked | someone-else | release pipeline lock |'],
  }));
  assert.ok(latestRules(wrongOwner.text, { ledgerPath: wrongOwner.ledgerPath }).includes('v2-decomposition-owner'), 'blocked decomposition must preserve the registry owner');
});

test('malformed JSON dispatch receipts produce findings instead of throwing', () => {
  const row = item({ writeSet: '["src/future.mjs"]' });
  const decompositionRows = ['| I1 | implement feature | dispatched | worker-1 | receipt is malformed |'];
  for (const receipt of [null, [], 'primitive receipt', 17, true]) {
    const candidate = fixture(v2({ items: [row], decompositionRows }), { 'receipts/worker-1.json': receipt });
    let findings;
    assert.doesNotThrow(() => { findings = checkHeartbeatV2(candidate.text, { ledgerPath: candidate.ledgerPath }); }, `receipt ${JSON.stringify(receipt)} must not throw`);
    assert.ok(findings.some((finding) => finding.rule === 'v2-dispatch-receipt'), `receipt ${JSON.stringify(receipt)} must produce a validation finding`);
  }
});

