import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { CATEGORIES, checkLedger } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { checkHeartbeatV2, parseItemsV2 } from '../../src/supervision/heartbeat-ledger-v2.mjs';

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
const ITEMS_HEADER_WITH_CHILDREN = [
  '## Items',
  '',
  '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref | children |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function item({ id = 'I1', source = 'report:worker-1', item = 'implement feature', status = 'dispatched worker-1', evidence = '-', owner = 'worker-1', repository = 'repo-a', worktree = '/worktrees/worker-1', mode = 'write', writeSet = '[]', dispatchRef = 'receipts/worker-1.json', children } = {}) {
  const row = `| ${id} | ${source} | ${item} | ${status} | ${evidence} | ${owner} | ${repository} | ${worktree} | ${mode} | ${writeSet} | ${dispatchRef} |`;
  return children === undefined ? row : `${row.slice(0, -2)} | ${children} |`;
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
  includeChildren = false,
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
  return `${section}\n\n${includeChildren ? ITEMS_HEADER_WITH_CHILDREN : ITEMS_HEADER}\n${items.join('\n')}\n`;
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
  assert.match(historical.stdout, /HISTORY INSPECTION ONLY/);
  assert.match(historical.stdout, /deprecated-legacy-alias/);
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

test('deferred disposition matches an unfinished deferred Item with evidence and owner', () => {
  const deferred = item({
    status: 'deferred <- original historical provenance has not been restored; new dispatch and active writer are unconfirmed',
    evidence: '`git log --all -- artifact` found no restored provenance',
    owner: 'provenance-owner',
    mode: 'read-only',
    writeSet: '[]',
    dispatchRef: '-',
  });
  const candidate = fixture(v2({
    items: [deferred],
    decompositionRows: ['| I1 | verify the original provenance source, then decide whether to dispatch | deferred | provenance-owner | `git log --all -- artifact` found no restored provenance |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: cannot-split: owner-gated)\nsplittable: 0/1',
  }));
  assert.deepEqual(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath, now: new Date('2026-01-01T10:21:00Z') }), []);

  const mismatched = fixture(v2({
    items: [item({ status: 'blocked <- external runner unavailable', evidence: 'runner status checked', mode: 'read-only', writeSet: '[]', dispatchRef: '-' })],
    decompositionRows: ['| I1 | resume later | deferred | worker-1 | concrete follow-up evidence |'],
  }));
  assert.ok(latestRules(mismatched.text, { ledgerPath: mismatched.ledgerPath }).includes('v2-decomposition-status'), 'deferred cannot reclassify a blocked item');

  const missingOwner = fixture(v2({
    items: [item({ status: 'deferred <- historical provenance has not been restored', evidence: '`git log --all -- artifact` found no restored provenance', owner: '', mode: 'read-only', writeSet: '[]', dispatchRef: '-' })],
    decompositionRows: ['| I1 | verify provenance then decide whether to dispatch | deferred | - | `git log --all -- artifact` found no restored provenance |'],
  }));
  assert.ok(latestRules(missingOwner.text, { ledgerPath: missingOwner.ledgerPath }).includes('v2-decomposition-owner'), 'deferred work still needs a matching owner');
  assert.ok(latestRules(missingOwner.text, { ledgerPath: missingOwner.ledgerPath }).includes('item-deferred-owner'), 'the registry checker also requires a concrete deferred owner');

  const missingEvidence = fixture(v2({
    items: [item({ status: 'deferred <- historical provenance has not been restored', evidence: '-', mode: 'read-only', writeSet: '[]', dispatchRef: '-' })],
    decompositionRows: ['| I1 | verify provenance then decide whether to dispatch | deferred | provenance-owner | concrete follow-up reference |'],
  }));
  assert.ok(latestRules(missingEvidence.text, { ledgerPath: missingEvidence.ledgerPath }).includes('item-deferred-evidence'), 'a decomposition citation cannot replace registry evidence');

  for (const status of ['deferred <-', 'deferred <- TBD']) {
    const invalidReason = fixture(v2({
      items: [item({ status, evidence: '`git log --all -- artifact` found no restored provenance', owner: 'provenance-owner', mode: 'read-only', writeSet: '[]', dispatchRef: '-' })],
      decompositionRows: ['| I1 | verify provenance then decide whether to dispatch | deferred | provenance-owner | `git log --all -- artifact` found no restored provenance |'],
    }));
    assert.ok(latestRules(invalidReason.text, { ledgerPath: invalidReason.ledgerPath }).includes('item-deferred'), `deferred reason ${status} must be rejected`);
  }

  const readyProof = fixture(v2({
    items: [item({ status: 'ready' })],
    decompositionRows: ['| I1 | resume later | deferred | worker-1 | ready proof |'],
  }));
  assert.ok(latestRules(readyProof.text, { ledgerPath: readyProof.ledgerPath }).includes('v2-item-ready'), 'deferred does not make ready work valid');
});

test('deferred history proof validates its audit reference structure without claiming truth or physical inactivity', () => {
  const deferred = item({
    status: 'deferred <- original historical provenance is not restored; new dispatch and active writer are unconfirmed',
    evidence: '`git log --all -- artifact` found no restored provenance',
    owner: 'provenance-owner',
    mode: 'read-only',
    writeSet: '[]',
    dispatchRef: '-',
  });
  const audit = {
    itemId: 'I1',
    originalGoal: 'implement feature',
    originalRowSha256: 'a'.repeat(64),
    checkedSources: [{ path: 'records/legacy.md', locator: { heading: 'Historical worker report', excerpt: 'source row absent' }, missing: true }],
    transitions: {
      accepted: { state: 'unknown', source: { path: 'receipts/dispatch.json', result: 'file not found', sha256: 'c'.repeat(64) } },
      privateFinal: { state: 'unknown', source: { path: 'reports/worker-final.md', locator: { section: 'Private final', result: 'not found' } } },
      landed: { state: 'unknown', source: { path: 'git:repo-a', result: 'no matching landed revision' } },
    },
    missingFields: ['accepted dispatch receipt', 'private final output', 'landed revision'],
    auditor: { taskName: 'codex audit session 2026-11-11', requestedModel: 'gpt-6.1-terra' },
    checkedAt: '2026-11-11T14:00:00Z',
    historicalDispatchState: 'unknown',
    currentWriter: { state: 'unknown', evidence: { path: 'reports/writer-check.json', result: 'no verified current writer record was found' } },
  };
  const make = (payload = audit, { current = deferred, ref = 'audit/evidence.json', receipts = {} } = {}) => fixture(v2({
    items: [current],
    decompositionRows: [`| I1 | verify historical provenance, then decide whether new dispatch is needed | deferred | provenance-owner | ${current.evidence} |`],
    includeResplit: false,
    includeSplitCount: false,
    extra: `re-split: rows(I1: cannot-split: audit-evidence-unrecoverable ${ref})\nsplittable: 0/1`,
  }), { ...receipts, ...(payload ? { [ref]: payload } : {}) });
  const valid = make();
  assert.deepEqual(latestRules(valid.text, { ledgerPath: valid.ledgerPath, now: new Date('2026-11-11T14:01:00Z') }), [], 'unknown history plus a structured audit does not assert a recovered dispatch or inactive physical writer');

  const missingFile = make(null, { ref: 'audit/missing.json' });
  assert.ok(latestRules(missingFile.text, { ledgerPath: missingFile.ledgerPath }).includes('audit-evidence-ref'));

  for (const [label, override, rule] of [
    ['item ID mismatch', { itemId: 'I9' }, 'audit-evidence-item'],
    ['goal mismatch', { originalGoal: 'different goal' }, 'audit-evidence-goal'],
    ['active writer', { currentWriter: { state: 'active', evidence: 'writer process confirmed' } }, 'audit-evidence-current-writer'],
    ['empty missing fields', { missingFields: [] }, 'audit-evidence-missing-fields'],
    ['empty source list', { checkedSources: [] }, 'audit-evidence-sources'],
    ['source without sha or missing marker', { checkedSources: [{ path: 'records/legacy.md', locator: 'section 4' }] }, 'audit-evidence-sources'],
    ['transition without source', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: '-' } } }, 'audit-evidence-transitions'],
    ['missing auditor', { auditor: '' }, 'audit-evidence-auditor'],
    ['empty auditor object', { auditor: {} }, 'audit-evidence-auditor'],
    ['auditor array', { auditor: [] }, 'audit-evidence-auditor'],
    ['numeric auditor', { auditor: 7 }, 'audit-evidence-auditor'],
    ['boolean auditor', { auditor: false }, 'audit-evidence-auditor'],
    ['empty transition source object', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: {} } } }, 'audit-evidence-transitions'],
    ['transition source array', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: [] } } }, 'audit-evidence-transitions'],
    ['numeric transition source', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: 12 } } }, 'audit-evidence-transitions'],
    ['boolean transition source', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: true } } }, 'audit-evidence-transitions'],
    ['empty writer evidence object', { currentWriter: { state: 'unknown', evidence: {} } }, 'audit-evidence-current-writer'],
    ['writer evidence array', { currentWriter: { state: 'unknown', evidence: [] } }, 'audit-evidence-current-writer'],
    ['numeric writer evidence', { currentWriter: { state: 'unknown', evidence: 12 } }, 'audit-evidence-current-writer'],
    ['boolean writer evidence', { currentWriter: { state: 'unknown', evidence: true } }, 'audit-evidence-current-writer'],
    ['empty source locator object', { checkedSources: [{ path: 'records/legacy.md', locator: {}, missing: true }] }, 'audit-evidence-sources'],
    ['source locator array', { checkedSources: [{ path: 'records/legacy.md', locator: [], missing: true }] }, 'audit-evidence-sources'],
    ['numeric source locator', { checkedSources: [{ path: 'records/legacy.md', locator: 12, missing: true }] }, 'audit-evidence-sources'],
    ['boolean source locator', { checkedSources: [{ path: 'records/legacy.md', locator: false, missing: true }] }, 'audit-evidence-sources'],
    ['malformed reference sha', { transitions: { ...audit.transitions, landed: { state: 'unknown', source: { path: 'git:repo-a', result: 'no revision', sha256: 'not-sha256' } } } }, 'audit-evidence-transitions'],
    ['malformed source sha', { checkedSources: [{ path: 'records/legacy.md', locator: 'section 4', sha256: 'not-sha256' }] }, 'audit-evidence-sources'],
    ['invalid check time', { checkedAt: 'not-a-time' }, 'audit-evidence-time'],
    ['impossible calendar date', { checkedAt: '2026-02-30T14:00:00Z' }, 'audit-evidence-time'],
  ]) {
    const candidate = make({ ...audit, ...override });
    assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).includes(rule), `${label} is rejected`);
  }

  const selfHashed = make({ ...audit, originalRowSha256: createHash('sha256').update(deferred).digest('hex') });
  assert.ok(latestRules(selfHashed.text, { ledgerPath: selfHashed.ledgerPath }).includes('audit-evidence-row-hash'), 'current deferred row cannot be passed off as the historical row');

  const dispatched = item({
    status: 'dispatched agent:worker-1', owner: 'agent:worker-1', repository: 'repo-a', worktree: '/worktrees/worker-1',
    mode: 'write', writeSet: '["src/current.mjs"]', dispatchRef: 'receipts/worker-1.json',
  });
  const dispatchedCandidate = fixture(v2({
    items: [dispatched],
    decompositionRows: ['| I1 | implement feature | dispatched | agent:worker-1 | receipts/worker-1.json |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: cannot-split: audit-evidence-unrecoverable audit/evidence.json)\nsplittable: 0/1',
  }), {
    'audit/evidence.json': audit,
  });
  assert.ok(latestRules(dispatchedCandidate.text, { ledgerPath: dispatchedCandidate.ledgerPath }).includes('audit-evidence-item-status'), 'the audit proof cannot excuse a dispatched Item or its receipt rules');
  assert.ok(latestRules(dispatchedCandidate.text, { ledgerPath: dispatchedCandidate.ledgerPath }).includes('v2-dispatch-receipt'), 'the audit proof cannot replace a current dispatched receipt');

  const ready = item({ status: 'ready', owner: 'provenance-owner', mode: 'read-only', writeSet: '[]', dispatchRef: '-' });
  const readyCandidate = fixture(v2({
    items: [ready],
    decompositionRows: ['| I1 | verify provenance then decide whether to dispatch | deferred | provenance-owner | `git log --all -- artifact` found no restored provenance |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: cannot-split: audit-evidence-unrecoverable audit/evidence.json)\nsplittable: 0/1',
  }), { 'audit/evidence.json': audit });
  assert.ok(latestRules(readyCandidate.text, { ledgerPath: readyCandidate.ledgerPath }).includes('audit-evidence-item-status'), 'the proof tag cannot make a ready Item deferred');

  const activeWriter = item({
    id: 'I2', status: 'dispatched agent:worker-2', evidence: 'active tool result observed', owner: 'agent:worker-2',
    repository: 'repo-a', worktree: '/worktrees/worker-2', mode: 'write',
    writeSet: '["src/current-writer.mjs"]', dispatchRef: 'receipts/worker-2.json',
  });
  const visibleWriter = fixture(v2({
    items: [deferred, activeWriter],
    decompositionRows: [
      '| I1 | verify historical provenance, then decide whether new dispatch is needed | deferred | provenance-owner | `git log --all -- artifact` found no restored provenance |',
      '| I2 | continue the confirmed active writer | continuing | agent:worker-2 | active tool output.md |',
    ],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: cannot-split: audit-evidence-unrecoverable audit/evidence.json; I2: continuing: active active tool output.md)\nsplittable: 0/2',
  }), { 'audit/evidence.json': audit });
  assert.ok(latestRules(visibleWriter.text, { ledgerPath: visibleWriter.ledgerPath }).includes('v2-dispatch-receipt'), 'unknown historical writer state cannot hide a separate dispatched Item missing its receipt');
});

test('current v2 permits a continuing activity assessment for an already-dispatched item', () => {
  const active = item({
    owner: 'agent:worker-1', worktree: 'worktrees/worker-1',
    writeSet: '["src/one.mjs"]', dispatchRef: 'receipts/worker-1.json',
  });
  const decompositionRows = ['| I1 | probe current activity | continuing | agent:worker-1 | active probe/tool-result.json |'];
  const extra = 're-split: rows(I1: continuing: active probe/tool-result.json)\nsplittable: 0/1';
  const acceptedAssessment = fixture(v2({
    items: [active], decompositionRows, includeResplit: false, includeSplitCount: false, extra,
  }), { 'receipts/worker-1.json': accepted('agent:worker-1') });
  assert.deepEqual(latestRules(acceptedAssessment.text, { ledgerPath: acceptedAssessment.ledgerPath }), [], 'continuing is an assessed outcome, not a new dispatch');

  const wrongDispatchCount = fixture(v2({
    items: [active], decompositionRows, includeResplit: false, includeSplitCount: false,
    extra: extra.replace('splittable: 0/1', 'splittable: 1/1'),
  }), { 'receipts/worker-1.json': accepted('agent:worker-1') });
  assert.ok(latestRules(wrongDispatchCount.text, { ledgerPath: wrongDispatchCount.ledgerPath }).includes('splittable-mismatch'), 'continuing does not increment the dispatch numerator');

  const privateFinal = fixture(v2({
    items: [active],
    decompositionRows: ['| I1 | inspect worker result | continuing | agent:worker-1 | private-final worker-1/final |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: continuing: private-final worker-1/final)\nsplittable: 0/1',
  }), { 'receipts/worker-1.json': accepted('agent:worker-1') });
  assert.deepEqual(latestRules(privateFinal.text, { ledgerPath: privateFinal.ledgerPath }), [], 'a concrete private-final reference is a valid continuing assessment');

  for (const reference of [
    'accepted receipt only',
    'probe/tool-result.json',
    'archived probe/tool-result.json',
    'active TODO',
    'private-final TBD',
  ]) {
    const invalidEvidence = fixture(v2({
      items: [active],
      decompositionRows: [`| I1 | probe current activity | continuing | agent:worker-1 | ${reference} |`],
      includeResplit: false,
      includeSplitCount: false,
      extra: `re-split: rows(I1: continuing: ${reference})\nsplittable: 0/1`,
    }), { 'receipts/worker-1.json': accepted('agent:worker-1') });
    assert.ok(latestRules(invalidEvidence.text, { ledgerPath: invalidEvidence.ledgerPath }).includes('resplit-verdict-invalid'), `continuing evidence ${reference} must be rejected`);
  }
});

test('current v2 continuing assessments require one existing active dispatched item', () => {
  const active = item({
    owner: 'agent:worker-1', worktree: 'worktrees/worker-1',
    writeSet: '["src/one.mjs"]', dispatchRef: 'receipts/worker-1.json',
  });
  const decomp = ['| I1 | probe current activity | continuing | agent:worker-1 | active probe/tool-result.json |'];
  const receipts = { 'receipts/worker-1.json': accepted('agent:worker-1') };
  const base = { items: [active], decompositionRows: decomp, includeResplit: false, includeSplitCount: false };

  const unknown = fixture(v2({ ...base, extra: 're-split: rows(I999: continuing: active probe/tool-result.json)\nsplittable: 0/1' }), receipts);
  assert.ok(latestRules(unknown.text, { ledgerPath: unknown.ledgerPath }).some((rule) => rule.startsWith('resplit-row-')), 'an assessment for a nonexistent item is rejected');

  const duplicate = fixture(v2({ ...base, extra: 're-split: rows(I1: continuing: active probe/tool-result.json; I1: continuing: active second/tool-result.json)\nsplittable: 0/1' }), receipts);
  assert.ok(latestRules(duplicate.text, { ledgerPath: duplicate.ledgerPath }).includes('resplit-row-duplicate'), 'an item can be assessed only once');

  const done = item({
    status: 'done -- `work completed`', mode: 'read-only', writeSet: '[]', dispatchRef: '-',
  });
  const inactive = fixture(v2({
    items: [done],
    decompositionRows: ['| I1 | record completion | done | worker-1 | `work completed` |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: continuing: active probe/tool-result.json)\nsplittable: 0/1',
  }));
  assert.ok(latestRules(inactive.text, { ledgerPath: inactive.ledgerPath }).some((rule) => rule.startsWith('resplit-')), 'continuing cannot assess an item that is no longer active-dispatched');
});

test('current v2 split counts include explicitly assessed accepted independent dispatches', () => {
  const workers = [
    { id: 'I1', owner: 'agent:worker-1', path: 'src/one.mjs' },
    { id: 'I2', owner: 'agent:worker-2', path: 'src/two.mjs' },
    { id: 'I3', owner: 'agent:worker-3', path: 'src/three.mjs' },
  ];
  const items = workers.map(({ id, owner, path }, index) => item({
    id,
    item: `implement unit ${index + 1}`,
    owner,
    worktree: `worktrees/${owner}`,
    writeSet: JSON.stringify([path]),
    dispatchRef: `receipts/${owner}.json`,
  }));
  const decompositionRows = workers.map(({ id, owner }) => `| ${id} | implement independent unit | dispatched | ${owner} | receipts/${owner}.json |`);
  const receipts = Object.fromEntries(workers.map(({ owner }) => [`receipts/${owner}.json`, accepted(owner)]));
  const splitRows = workers.map(({ id, owner }) => `${id}: split->dispatched ${owner}`).join('; ');

  const good = fixture(v2({ items, decompositionRows, includeResplit: false, includeSplitCount: false, extra: `re-split: rows(${splitRows})\nsplittable: 3/3` }), receipts);
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), [], 'three explicitly assessed accepted workers with disjoint exact file sets pass');

  const wrongDenominator = fixture(v2({ items, decompositionRows, includeResplit: false, includeSplitCount: false, extra: `re-split: rows(${splitRows})\nsplittable: 3/0` }), receipts);
  assert.ok(latestRules(wrongDenominator.text, { ledgerPath: wrongDenominator.ledgerPath }).includes('splittable-mismatch'), 'a zero denominator cannot hide three explicit assessments');
});

test('current v2 split counts use the actual receipt path across API and CLI entry points', (t) => {
  const owner = 'agent:shared-worker';
  const makeCandidate = (refs, expectedCount, { files = {}, prepare = () => {} } = {}) => {
    const candidate = fixture((cwd) => {
      const actualRefs = typeof refs === 'function' ? refs(cwd) : refs;
      const rows = actualRefs.map((dispatchRef, index) => item({
        id: `I${index + 1}`, owner, status: 'dispatched active', evidence: 'accepted dispatch receipt',
        worktree: `worktrees/worker-${index + 1}`, mode: 'read-only', writeSet: '[]', dispatchRef,
      }));
      const decomp = actualRefs.map((_, index) => `| I${index + 1} | inspect dispatched unit | dispatched | ${owner} | accepted receipt |`);
      const split = actualRefs.map((_, index) => `I${index + 1}: split->dispatched unitItemID:I${index + 1}`).join('; ');
      return v2({
        items: rows,
        decompositionRows: decomp,
        includeResplit: false,
        includeSplitCount: false,
        extra: `re-split: rows(${split})\nsplittable: ${expectedCount}/${actualRefs.length}`,
      });
    }, { 'receipts/shared.json': accepted(owner), ...files }, prepare);
    return candidate;
  };
  const hasMismatch = (candidate) => latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).includes('splittable-mismatch');

  const relative = makeCandidate(['receipts/shared.json', 'receipts/shared.json'], 1);
  assert.deepEqual(latestRules(relative.text, { ledgerPath: relative.ledgerPath }), [], 'same relative receipt and owner count once');
  const duplicateCount = makeCandidate(['receipts/shared.json', 'receipts/shared.json'], 2);
  assert.ok(hasMismatch(duplicateCount), 'counting one actual receipt twice is red');

  const absolute = makeCandidate((cwd) => ['receipts/shared.json', join(cwd, '.workspace/task/demo/receipts/shared.json')], 1);
  assert.deepEqual(latestRules(absolute.text, { ledgerPath: absolute.ledgerPath }), [], 'relative and absolute spellings resolve to one file');

  const dotSegments = makeCandidate(['receipts/shared.json', './receipts/../receipts/shared.json'], 1);
  assert.deepEqual(latestRules(dotSegments.text, { ledgerPath: dotSegments.ledgerPath }), [], './ and .. aliases resolve to one file');

  let symlinkUnavailable = false;
  const symlink = makeCandidate(['receipts/shared.json', 'receipts/alias.json'], 1, {
    prepare: (cwd, ledgerPath) => {
      mkdirSync(join(dirname(ledgerPath), 'receipts'), { recursive: true });
      try {
        symlinkSync(join(dirname(ledgerPath), 'receipts/shared.json'), join(dirname(ledgerPath), 'receipts/alias.json'));
      } catch (error) {
        if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) symlinkUnavailable = true;
        else throw error;
      }
    },
  });
  if (symlinkUnavailable) t.diagnostic('SKIP symlink alias assertion: Windows denied symlink creation');
  else assert.deepEqual(latestRules(symlink.text, { ledgerPath: symlink.ledgerPath }), [], 'a real symlink and target count as one receipt file');

  const distinct = makeCandidate(['receipts/one.json', 'receipts/two.json'], 2, {
    files: { 'receipts/one.json': accepted(owner), 'receipts/two.json': accepted(owner) },
  });
  assert.deepEqual(latestRules(distinct.text, { ledgerPath: distinct.ledgerPath }), [], 'distinct receipt files count separately');

  const differentOwners = (() => {
    const owner2 = 'agent:other-worker';
    const rows = [
      item({ id: 'I1', owner, status: 'dispatched active', evidence: 'accepted receipt', mode: 'read-only', writeSet: '[]', dispatchRef: 'receipts/shared.json' }),
      item({ id: 'I2', owner: owner2, status: 'dispatched active', evidence: 'accepted receipt', mode: 'read-only', writeSet: '[]', dispatchRef: 'receipts/shared.json' }),
    ];
    const candidate = fixture(v2({ items: rows, decompositionRows: [
      `| I1 | inspect unit | dispatched | ${owner} | accepted receipt |`,
      `| I2 | inspect unit | dispatched | ${owner2} | accepted receipt |`,
    ], includeResplit: false, includeSplitCount: false, extra: 're-split: rows(I1: split->dispatched unitItemID:I1; I2: split->dispatched unitItemID:I2)\nsplittable: 1/2' }), {
      'receipts/shared.json': accepted(owner),
    });
    const rules = latestRules(candidate.text, { ledgerPath: candidate.ledgerPath });
    assert.ok(rules.includes('splittable-mismatch'), 'same file with different owners must count as two dispatch identities');
    assert.ok(rules.includes('v2-dispatch-receipt'), 'a receipt cannot authenticate a different owner');
    return candidate;
  })();

  const missing = makeCandidate(['receipts/phantom.json', './receipts/phantom.json'], 1);
  assert.ok(latestRules(missing.text, { ledgerPath: missing.ledgerPath }).includes('v2-dispatch-receipt'), 'missing receipt aliases remain fail closed');
  const malformed = makeCandidate(['receipts/shared.json', 'receipts/shared.json'], 1, { files: { 'receipts/shared.json': '{bad json' } });
  assert.ok(latestRules(malformed.text, { ledgerPath: malformed.ledgerPath }).includes('v2-dispatch-receipt'), 'parse errors remain fail closed');

  const cliCandidate = symlinkUnavailable ? relative : symlink;
  const cli = spawnSync(process.execPath, [CLI, cliCandidate.ledgerPath, '--latest', '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).passed, true, 'CLI current mode shares API receipt identity semantics');
  const historyCli = spawnSync(process.execPath, [CLI, cliCandidate.ledgerPath, '--history', '--latest', '--json'], { encoding: 'utf8' });
  assert.equal(historyCli.status, 1, 'history remains inspection-only');
  assert.equal(JSON.parse(historyCli.stdout).findings.some((finding) => finding.rule === 'splittable-mismatch'), false, 'marked v2 history uses the same ledger path base as current mode');
  // Keep the distinct-owner case live in this E2E matrix; it proves receipt identity is owner-scoped.
  assert.ok(differentOwners.ledgerPath);
  assert.ok(!hasMismatch(relative));
});

test('current v2 counts an explicit blocked proof with an independent dispatch', () => {
  const dispatch = item({
    id: 'I1', owner: 'agent:worker-1', worktree: 'worktrees/worker-1',
    writeSet: '["src/one.mjs"]', dispatchRef: 'receipts/worker-1.json',
  });
  const blocked = item({
    id: 'I2', item: 'resolve owner-gated dependency', status: 'blocked <- owner-gated', owner: 'worker-2',
    worktree: 'worktrees/worker-2', mode: 'read-only', writeSet: '[]', dispatchRef: '-',
  });
  const decompositionRows = [
    '| I1 | implement independent unit | dispatched | agent:worker-1 | receipts/worker-1.json |',
    '| I2 | wait for owner decision | blocked | worker-2 | owner-gated |',
  ];
  const mixedRows = 'I1: split->dispatched agent:worker-1; I2: cannot-split: owner-gated';
  const good = fixture(v2({ items: [dispatch, blocked], decompositionRows, includeResplit: false, includeSplitCount: false, extra: `re-split: rows(${mixedRows})\nsplittable: 1/2` }), {
    'receipts/worker-1.json': accepted('agent:worker-1'),
  });
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), [], 'one explicit dispatch and one tagged blocker are both assessed');

  const wrong = fixture(v2({ items: [dispatch, blocked], decompositionRows, includeResplit: false, includeSplitCount: false, extra: `re-split: rows(${mixedRows})\nsplittable: 1/1` }), {
    'receipts/worker-1.json': accepted('agent:worker-1'),
  });
  assert.ok(latestRules(wrong.text, { ledgerPath: wrong.ledgerPath }).includes('splittable-mismatch'), 'the denominator must include both explicit valid outcomes');
});

test('current v2 rejects duplicate split audit and count markers', () => {
  const duplicateMarkers = fixture(v2({
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows()\nsplittable: 0/0\nre-split: rows()\nsplittable: 0/0',
  }));
  assert.ok(latestRules(duplicateMarkers.text, { ledgerPath: duplicateMarkers.ledgerPath }).length > 0, 'duplicate audit markers cannot be silently accepted by first-match parsing');
});

test('v2 registry scope ignores auxiliary tables and rejects missing metadata on the real Items registry', () => {
  const legacyItems = [
    '## Items',
    '| id | source | item | status | evidence |',
    '| --- | --- | --- | --- | --- |',
    '| I1 | report:worker-1 | implement feature | dispatched worker-1 | branch codex/worker-1 |',
  ].join('\n');
  const auxiliary = [
    '### Auxiliary dispatch notes',
    '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| I2 | report:worker-2 | auxiliary only | dispatched worker-2 | accepted | worker-2 | repo-a | worktrees/worker-2 | write | ["src/two.mjs"] | receipts/worker-2.json |',
  ].join('\n');
  const wakeOnlyText = v2({ extra: 're-split: rows()\nsplittable: 0/0' }).replace(`${ITEMS_HEADER}\n`, '');
  const text = `${wakeOnlyText}${legacyItems}\n\n${auxiliary}\n`;
  const candidate = fixture(text, { 'receipts/worker-2.json': accepted('worker-2') });
  const findings = checkHeartbeatV2(candidate.text, { ledgerPath: candidate.ledgerPath });
  assert.ok(findings.some((finding) => finding.rule === 'v2-item-column'), 'the actual dispatched row inside the single Items registry still requires v2 metadata');
  assert.ok(!findings.some((finding) => finding.rule.startsWith('v2-') && /item I2/.test(finding.message)), 'an auxiliary table cannot supply or create a v2 registry row');
  assert.ok(findings.some((finding) => finding.rule === 'item-outside-table'), 'the historical stray-row guard still reports the auxiliary row');
});

test('a corrective latest wake must cover every later non-done registry addition', () => {
  const firstWake = v2({
    wake: '2026-01-01T10:00Z',
    items: [],
    decompositionRows: [],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows()\nsplittable: 0/0',
  });
  const secondWake = v2({
    wake: '2026-01-01T10:20Z',
    items: [],
    decompositionRows: ['| I1 | implement first unit | dispatched | agent:worker-1 | receipts/worker-1.json |'],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows()\nsplittable: 0/0',
  });
  const items = [
    item({ id: 'I1', owner: 'agent:worker-1', worktree: 'worktrees/worker-1', writeSet: '["src/one.mjs"]', dispatchRef: 'receipts/worker-1.json' }),
    item({ id: 'I2', owner: 'agent:worker-2', worktree: 'worktrees/worker-2', writeSet: '["src/two.mjs"]', dispatchRef: 'receipts/worker-2.json' }),
  ];
  const receipts = { 'receipts/worker-1.json': accepted('agent:worker-1'), 'receipts/worker-2.json': accepted('agent:worker-2') };
  const uncovered = fixture(withWakeHistory(firstWake, secondWake).replace(`${ITEMS_HEADER}\n`, `${ITEMS_HEADER}\n${items.join('\n')}\n`), receipts);
  assert.ok(latestRules(uncovered.text, { ledgerPath: uncovered.ledgerPath }).includes('v2-decomposition-item-missing'), 'a later non-done item absent from the latest decomposition is uncovered');

  const correctedWake = v2({
    wake: '2026-01-01T10:40Z',
    items: [],
    decompositionRows: [
      '| I1 | continue first unit | dispatched | agent:worker-1 | receipts/worker-1.json |',
      '| I2 | implement second unit | dispatched | agent:worker-2 | receipts/worker-2.json |',
    ],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows()\nsplittable: 0/0',
  });
  const corrected = fixture(withWakeHistory(firstWake, secondWake, correctedWake).replace(`${ITEMS_HEADER}\n`, `${ITEMS_HEADER}\n${items.join('\n')}\n`), receipts);
  assert.deepEqual(latestRules(corrected.text, { ledgerPath: corrected.ledgerPath }), [], 'a new corrective wake covering both current items clears the gap');
});

test('tracking parents and nested trackers validate without claiming dispatch ownership', () => {
  const parent = (id, children, overrides = {}) => item({
    id,
    source: `report:${id.toLowerCase()}`,
    item: `track child work for ${id}`,
    status: 'tracking',
    evidence: 'tracking parent plan',
    owner: `agent:${id.toLowerCase()}`,
    repository: 'repo-a',
    worktree: `worktrees/${id.toLowerCase()}`,
    mode: 'read-only',
    writeSet: '[]',
    dispatchRef: '-',
    children: '[]',
    ...overrides,
  });
  const leaf = item({
    id: 'I3', source: 'report:leaf', item: 'implement leaf unit', status: 'dispatched agent:leaf',
    evidence: 'accepted dispatch', owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf',
    mode: 'write', writeSet: '["src/leaf.mjs"]', dispatchRef: 'receipts/leaf.json', children: '[]',
  });
  const items = [
    parent('I1', [], { children: '["I2"]' }),
    parent('I2', [], { children: '["I3"]' }),
    leaf,
  ];
  const decompositionRows = [
    '| I1 | track child completion | continuing | agent:i1 | tracking parent/progress.md |',
    '| I2 | track leaf completion | continuing | agent:i2 | tracking child/progress.md |',
    '| I3 | implement leaf unit | dispatched | agent:leaf | receipts/leaf.json |',
  ];
  const nested = fixture(v2({
    items, includeChildren: true, decompositionRows, includeResplit: false, includeSplitCount: false,
    extra: 're-split: rows(I1: continuing: tracking parent/progress.md; I2: continuing: tracking child/progress.md)\nsplittable: 0/2',
  }), { 'receipts/leaf.json': accepted('agent:leaf') });
  assert.deepEqual(latestRules(nested.text, { ledgerPath: nested.ledgerPath }), [], 'tracking may nest and a real accepted receipt belongs only to the dispatched leaf');
  assert.equal(parseItemsV2(nested.text).rows.find((row) => row.id === 'I2').children, '["I3"]', 'optional children metadata is parsed from Items');

  const completedLeaf = item({
    id: 'I2', source: 'report:leaf', item: 'finished leaf unit', status: 'done -- `work completed`',
    evidence: '`work completed`', owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf',
    mode: 'read-only', writeSet: '[]', dispatchRef: '-', children: '[]',
  });
  const parentWithDoneChild = fixture(v2({
    items: [parent('I1', [], { children: '["I2"]' }), completedLeaf],
    includeChildren: true,
    decompositionRows: [
      '| I1 | retain tracking until reviewed | continuing | agent:i1 | tracking parent/review.md |',
      '| I2 | record completed leaf | done | agent:leaf | `work completed` |',
    ],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(I1: continuing: tracking parent/review.md)\nsplittable: 0/1',
  }));
  assert.deepEqual(latestRules(parentWithDoneChild.text, { ledgerPath: parentWithDoneChild.ledgerPath }), [], 'all children being done does not auto-complete the tracking parent');
});

test('tracking graph rejects dangling, self, duplicate and cyclic child references', () => {
  const parent = (id, children) => item({
    id, source: `report:${id.toLowerCase()}`, item: 'track child work', status: 'tracking', evidence: 'tracking plan',
    owner: `agent:${id.toLowerCase()}`, repository: 'repo-a', worktree: `worktrees/${id.toLowerCase()}`,
    mode: 'read-only', writeSet: '[]', dispatchRef: '-', children: JSON.stringify(children),
  });
  const validRows = (ids) => ids.map((id) => `| ${id} | track child work | continuing | agent:${id.toLowerCase()} | tracking ${id.toLowerCase()}/progress.md |`);
  const cases = [
    { name: 'dangling', items: [parent('I1', ['I9'])], ids: ['I1'] },
    { name: 'self', items: [parent('I1', ['I1'])], ids: ['I1'] },
    { name: 'duplicate', items: [parent('I1', ['I2', 'I2']), parent('I2', [])], ids: ['I1', 'I2'] },
    { name: 'cycle', items: [parent('I1', ['I2']), parent('I2', ['I1'])], ids: ['I1', 'I2'] },
  ];
  for (const current of cases) {
    const candidate = fixture(v2({
      items: current.items,
      includeChildren: true,
      decompositionRows: validRows(current.ids),
      includeResplit: false,
      includeSplitCount: false,
      extra: `re-split: rows(${current.ids.map((id) => `${id}: continuing: tracking ${id.toLowerCase()}/progress.md`).join('; ')})\nsplittable: 0/${current.ids.length}`,
    }));
    const findings = checkHeartbeatV2(candidate.text, { ledgerPath: candidate.ledgerPath });
    assert.ok(findings.some((finding) => /children|tracking/i.test(`${finding.rule} ${finding.message}`)), `${current.name} child graph must be rejected`);
  }
});

test('tracking items require read-only tracking metadata and cannot claim dispatch receipts', () => {
  const tracker = (overrides = {}) => item({
    id: 'I1', source: 'report:tracker', item: 'track child work', status: 'tracking', evidence: 'tracking plan',
    owner: 'agent:tracker', repository: 'repo-a', worktree: 'worktrees/tracker', mode: 'read-only',
    writeSet: '[]', dispatchRef: '-', children: '["I2"]', ...overrides,
  });
  const child = item({
    id: 'I2', source: 'report:leaf', item: 'finished leaf unit', status: 'done -- `work completed`', evidence: '`work completed`',
    owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf', mode: 'read-only', writeSet: '[]', dispatchRef: '-', children: '[]',
  });
  const rejected = (parentRow, label) => {
    const candidate = fixture(v2({
      items: [parentRow, child],
      includeChildren: true,
      decompositionRows: [
        '| I1 | track child work | continuing | agent:tracker | tracking progress.md |',
        '| I2 | record completed leaf | done | agent:leaf | `work completed` |',
      ],
      includeResplit: false,
      includeSplitCount: false,
      extra: 're-split: rows(I1: continuing: tracking progress.md)\nsplittable: 0/1',
    }));
    const findings = checkHeartbeatV2(candidate.text, { ledgerPath: candidate.ledgerPath });
    assert.ok(findings.some((finding) => /tracking|dispatch|mode|work.?set|owner|worktree|repository/i.test(`${finding.rule} ${finding.message}`)), `${label} tracking metadata must be rejected`);
  };

  rejected(tracker({ mode: 'write', writeSet: '["src/claimed-parent.mjs"]' }), 'writer mode');
  rejected(tracker({ owner: '' }), 'missing owner');
  rejected(tracker({ repository: '' }), 'missing repository');
  rejected(tracker({ worktree: '' }), 'missing worktree');
  rejected(tracker({ dispatchRef: 'receipts/fake-tracker.json' }), 'fake dispatch receipt');
});

test('current v2 assessment IDs support generic nested parent IDs such as ALL and W1', () => {
  const tracker = (id, child) => item({
    id, source: `report:${id.toLowerCase()}`, item: `track child ${child}`,
    status: 'tracking', evidence: 'tracking plan', owner: `agent:${id.toLowerCase()}`,
    repository: 'repo-a', worktree: `worktrees/${id.toLowerCase()}`, mode: 'read-only',
    writeSet: '[]', dispatchRef: '-', children: JSON.stringify([child]),
  });
  const leaf = item({
    id: 'I1', source: 'report:leaf', item: 'implement leaf unit', status: 'dispatched agent:leaf',
    evidence: '-', owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf',
    mode: 'write', writeSet: '["src/leaf.mjs"]', dispatchRef: 'receipts/leaf.json', children: '[]',
  });
  const candidate = fixture(v2({
    items: [tracker('ALL', 'W1'), tracker('W1', 'I1'), leaf],
    includeChildren: true,
    decompositionRows: [
      '| ALL | track worker group | continuing | agent:all | tracking raw-ref |',
      '| W1 | track leaf work | continuing | agent:w1 | tracking raw-ref |',
      '| I1 | implement leaf unit | dispatched | agent:leaf | receipts/leaf.json |',
    ],
    includeResplit: false,
    includeSplitCount: false,
    extra: 're-split: rows(ALL: continuing: tracking raw-ref; W1: continuing: tracking raw-ref; I1: split->dispatched agent:leaf)\nsplittable: 1/3',
  }), { 'receipts/leaf.json': accepted('agent:leaf') });
  assert.deepEqual(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }), [], 'generic and real parent IDs, plus a real accepted leaf dispatch, count as three assessments');
});

test('current v2 keeps hyphenated assessment IDs distinct and rejects duplicate or unknown IDs', () => {
  const owners = [
    { id: 'A-B', owner: 'agent:hyphen', path: 'src/hyphen.mjs', receipt: 'receipts/hyphen.json' },
    { id: 'AB', owner: 'agent:plain', path: 'src/plain.mjs', receipt: 'receipts/plain.json' },
  ];
  const items = owners.map(({ id, owner, path, receipt }) => item({
    id, source: `report:${owner}`, item: `implement ${id}`, status: `dispatched ${owner}`,
    evidence: '-', owner, repository: 'repo-a', worktree: `worktrees/${owner}`,
    mode: 'write', writeSet: JSON.stringify([path]), dispatchRef: receipt,
  }));
  const decompositionRows = owners.map(({ id, owner, receipt }) => `| ${id} | implement leaf | dispatched | ${owner} | ${receipt} |`);
  const receipts = Object.fromEntries(owners.map(({ owner, receipt }) => [receipt, accepted(owner)]));
  const good = fixture(v2({
    items, decompositionRows, includeResplit: false, includeSplitCount: false,
    extra: 're-split: rows(A-B: split->dispatched agent:hyphen; AB: split->dispatched agent:plain)\nsplittable: 2/2',
  }), receipts);
  assert.deepEqual(latestRules(good.text, { ledgerPath: good.ledgerPath }), [], 'A-B and AB are separate registry and assessment IDs');

  const duplicate = fixture(v2({
    items, decompositionRows, includeResplit: false, includeSplitCount: false,
    extra: 're-split: rows(A-B: split->dispatched agent:hyphen; A-B: split->dispatched agent:hyphen)\nsplittable: 1/1',
  }), receipts);
  assert.ok(latestRules(duplicate.text, { ledgerPath: duplicate.ledgerPath }).includes('resplit-row-duplicate'), 'an exact repeated generic ID is rejected');

  const unknown = fixture(v2({
    items, decompositionRows, includeResplit: false, includeSplitCount: false,
    extra: 're-split: rows(UNKNOWN: continuing: tracking raw-ref)\nsplittable: 0/1',
  }), receipts);
  assert.ok(latestRules(unknown.text, { ledgerPath: unknown.ledgerPath }).includes('resplit-row-unknown'), 'an unknown generic ID is rejected');
});

test('tracking metadata and coordination evidence reject blank and placeholder values', () => {
  const placeholders = ['', '-', '—', 'none', 'unknown', 'n-a', 'n/a', 'todo', 'tbd', '?', '未知', '待补'];
  const parentFor = (field, value) => item({
    id: 'I1', source: 'report:tracker', item: 'track child work', status: 'tracking', evidence: 'tracking plan',
    owner: 'agent:tracker', repository: 'repo-a', worktree: 'worktrees/tracker', mode: 'read-only',
    writeSet: '[]', dispatchRef: '-', children: '["I2"]', [field]: value,
  });
  const child = item({
    id: 'I2', source: 'report:leaf', item: 'finished leaf work', status: 'done -- `work completed`', evidence: '`work completed`',
    owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf', mode: 'read-only', writeSet: '[]', dispatchRef: '-', children: '[]',
  });

  for (const [field, rule] of [
    ['owner', 'tracking-parent-metadata'],
    ['repository', 'tracking-parent-metadata'],
    ['worktree', 'tracking-parent-metadata'],
    ['evidence', 'tracking-parent-evidence'],
  ]) {
    for (const value of placeholders) {
      const candidate = fixture(v2({
        items: [parentFor(field, value), child],
        includeChildren: true,
        decompositionRows: [
          '| I1 | track child work | continuing | agent:tracker | tracking progress.md |',
          '| I2 | record completed leaf | done | agent:leaf | `work completed` |',
        ],
        includeResplit: false,
        includeSplitCount: false,
        extra: 're-split: rows(I1: continuing: tracking progress.md)\nsplittable: 0/1',
      }));
      assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).includes(rule), `tracking ${field} placeholder ${JSON.stringify(value)} must be rejected`);
    }
  }
});

test('dispatched owner, repository and worktree placeholders fail even when the receipt matches', () => {
  const placeholders = ['', '-', '—', 'none', 'unknown', 'n-a', 'n/a', 'todo', 'tbd', '?', '未知', '待补'];
  for (const [field, rule] of [
    ['owner', 'v2-dispatch-owner'],
    ['repository', 'v2-repository'],
    ['worktree', 'v2-worktree'],
  ]) {
    for (const value of placeholders) {
      const owner = field === 'owner' ? value : 'agent:worker-1';
      const row = item({
        id: 'I1', source: 'report:worker-1', item: 'implement leaf unit', status: 'dispatched agent:worker-1', evidence: '-',
        owner, repository: field === 'repository' ? value : 'repo-a', worktree: field === 'worktree' ? value : 'worktrees/worker-1',
        mode: 'write', writeSet: '["src/leaf.mjs"]', dispatchRef: 'receipts/worker-1.json',
      });
      const candidate = fixture(v2({
        items: [row],
        decompositionRows: [`| I1 | implement leaf unit | dispatched | ${owner} | receipts/worker-1.json |`],
      }), { 'receipts/worker-1.json': accepted(owner) });
      assert.ok(latestRules(candidate.text, { ledgerPath: candidate.ledgerPath }).includes(rule), `dispatched ${field} placeholder ${JSON.stringify(value)} must fail despite a receipt bound to that value`);
    }
  }
});

test('completed legacy Items may omit dispatch metadata while unfinished legacy rows remain strict', () => {
  const terminal = item({
    id: 'I1', source: 'report:legacy', item: 'historical migration task',
    status: 'done -- terminal oracle verified by `git show abc1234`',
    evidence: 'terminal oracle verified by `git show abc1234`',
    owner: '', repository: '', worktree: '', mode: '', writeSet: '', dispatchRef: '',
  });
  const leaf = item({
    id: 'I2', source: 'report:leaf', item: 'implement current unit', status: 'dispatched agent:leaf',
    evidence: '-', owner: 'agent:leaf', repository: 'repo-a', worktree: 'worktrees/leaf',
    mode: 'write', writeSet: '["src/leaf.mjs"]', dispatchRef: 'receipts/leaf.json',
  });
  const doneLegacy = fixture(v2({
    items: [terminal, leaf],
    decompositionRows: [
      '| I1 | retain terminal verification | done | - | terminal oracle verified |',
      '| I2 | implement current unit | dispatched | agent:leaf | receipts/leaf.json |',
    ],
  }), { 'receipts/leaf.json': accepted('agent:leaf') });
  assert.deepEqual(latestRules(doneLegacy.text, { ledgerPath: doneLegacy.ledgerPath }), [], 'verified completion does not require reconstructing the historical spawn metadata');

  const activeLegacy = item({
    id: 'I1', source: 'report:legacy', item: 'historical migration task',
    status: 'dispatched agent:legacy',
    evidence: '-',
    owner: '', repository: '', worktree: '', mode: '', writeSet: '', dispatchRef: '',
  });
  const unfinished = fixture(v2({
    items: [activeLegacy],
    decompositionRows: ['| I1 | continue legacy task | dispatched | - | missing receipt |'],
  }));
  const findings = latestRules(unfinished.text, { ledgerPath: unfinished.ledgerPath });
  for (const rule of ['v2-dispatch-owner', 'v2-repository', 'v2-worktree', 'v2-mode', 'v2-write-set-json', 'v2-dispatch-receipt']) {
    assert.ok(findings.includes(rule), `unfinished legacy row must remain strict for ${rule}`);
  }
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

