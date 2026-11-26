// orchestration/handoff-contract.test.mjs
//
// Valid task packets, worker handoffs and review verdicts pass; each targeted mutation fails with a named
// problem. The review-verdict intake rules are exercised case by case, the CLI is run as a child process,
// and a class guard keeps the JSON Schema files' required fields and enums equal to the validator's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECK_RESULTS,
  CONFIDENCE,
  OUTCOMES,
  RECOMMENDATIONS,
  REQUIRED,
  RISK_CLASSES,
  ROLES,
  intakeDecision,
  validateReviewVerdict,
  validateTaskPacket,
  validateWorkerHandoff,
} from '../../src/orchestration/handoff-contract.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'orchestration', 'handoff-contract.mjs');
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const BASE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';

const packet = () => ({
  schemaVersion: 1,
  role: 'module-owner',
  moduleId: 'points-ledger',
  target: 'Ledger storage with migration and idempotent writes',
  writeScope: ['services/points/ledger/**'],
  worktree: '/work/trees/points-ledger',
  base: { ref: 'origin/main', sha: BASE },
  acceptanceCriteria: ['Writes are idempotent per request ID', 'Migration has a down path'],
  model: { requested: 'sonnet' },
  verification: [{ command: 'pnpm test --filter points-ledger', heavy: true, slot: 'host-a:1' }],
  offloadDir: '/scratch/points-ledger',
  attempt: { number: 1 },
});

const handoff = () => ({
  schemaVersion: 1,
  role: 'module-owner',
  moduleId: 'points-ledger',
  outcome: 'candidate',
  candidateSha: SHA,
  baseSha: BASE,
  stayedInScope: true,
  checks: [{ command: 'pnpm test --filter points-ledger', result: 'passed', exitCode: 0 }],
  unverified: ['load behavior above 1k writes/s'],
  branches: [{ name: 'wt/points-ledger', base: 'origin/main', tip: SHA, landed: false }],
  backgroundProcesses: { stopped: true, psProof: 'PID TTY TIME CMD (no children)' },
  model: { requested: 'sonnet', actual: 'unknown' },
  next: { action: 'independent review', owner: 'orchestrator' },
});

const verdict = () => ({
  schemaVersion: 1,
  moduleId: 'points-ledger',
  candidateSha: SHA,
  baseSha: BASE,
  recommendation: 'return-for-fix',
  findings: [{ severity: 'medium', location: 'services/points/ledger/write.ts:42', criterion: 'idempotent writes', fix: 'key the upsert on request ID' }],
  riskClasses: ['none'],
  coverage: { examined: ['services/points/ledger/**'], notExamined: [] },
  confidence: 'high',
  evidence: ['/scratch/review/points-ledger.diff'],
  reviewer: { requestedModel: 'sonnet', actualModel: 'unknown', contextIsolated: true },
});

function failsWith(validate, doc, pattern) {
  const result = validate(doc);
  assert.equal(result.ok, false, `expected failure matching ${pattern}`);
  assert.ok(result.problems.some((p) => pattern.test(p)), `${pattern} not in ${JSON.stringify(result.problems)}`);
}

test('task packets: valid per role, and each role rule is enforced', () => {
  assert.deepEqual(validateTaskPacket(packet()).problems, []);
  const explorer = { ...packet(), role: 'explorer', writeScope: 'none' };
  delete explorer.worktree;
  delete explorer.acceptanceCriteria;
  assert.deepEqual(validateTaskPacket(explorer).problems, []);
  const reviewer = { ...packet(), role: 'reviewer', writeScope: 'none', candidateSha: SHA, verification: [] };
  assert.deepEqual(validateTaskPacket(reviewer).problems, []);

  const without = (key) => { const p = packet(); delete p[key]; return p; };
  for (const key of REQUIRED.packet) failsWith(validateTaskPacket, without(key), new RegExp(`missing field: ${key}$`));
  failsWith(validateTaskPacket, { ...packet(), model: { requested: '' } }, /model\.requested/);
  failsWith(validateTaskPacket, { ...packet(), writeScope: 'none' }, /module-owner packet must list its write scope/);
  failsWith(validateTaskPacket, { ...explorer, writeScope: ['src/**'] }, /explorer packet must set writeScope/);
  failsWith(validateTaskPacket, { ...packet(), worktree: 'relative/path' }, /absolute pre-created worktree/);
  failsWith(validateTaskPacket, { ...reviewer, candidateSha: undefined }, /bind candidateSha/);
  failsWith(validateTaskPacket, { ...packet(), acceptanceCriteria: [] }, /acceptanceCriteria/);
  failsWith(validateTaskPacket, { ...packet(), verification: [{ command: 'build', heavy: true }] }, /granted slot/);
  failsWith(validateTaskPacket, { ...packet(), attempt: { number: 0 } }, /attempt\.number/);
  failsWith(validateTaskPacket, { ...reviewer, nestedDispatch: true }, /cannot authorize nested dispatch/);
  failsWith(validateTaskPacket, { ...packet(), schemaVersion: 2 }, /schemaVersion must be 1/);
  failsWith(validateTaskPacket, { ...packet(), base: { sha: 'HEAD' } }, /base\.sha/);
  failsWith(validateTaskPacket, [], /must be a JSON object/);
});

test('worker handoffs: outcomes, scope, checks, ps proof and no self-acceptance', () => {
  assert.deepEqual(validateWorkerHandoff(handoff()).problems, []);
  const checkpoint = { ...handoff(), outcome: 'checkpoint', continuation: 'run queued suite on slot host-a:1' };
  delete checkpoint.candidateSha;
  assert.deepEqual(validateWorkerHandoff(checkpoint).problems, []);
  const explorer = { ...handoff(), role: 'explorer', outcome: 'blocked', blocker: 'ledger schema owner has not published v2' };
  delete explorer.backgroundProcesses;
  assert.deepEqual(validateWorkerHandoff(explorer).problems, []);

  const without = (key) => { const h = handoff(); delete h[key]; return h; };
  for (const key of REQUIRED.handoff) failsWith(validateWorkerHandoff, without(key), new RegExp(`missing field: ${key}$`));
  failsWith(validateWorkerHandoff, { ...handoff(), candidateSha: 'abc' }, /candidateSha and baseSha/);
  failsWith(validateWorkerHandoff, { ...handoff(), outcome: 'checkpoint' }, /exact continuation/);
  failsWith(validateWorkerHandoff, { ...handoff(), outcome: 'blocked' }, /concrete blocker/);
  failsWith(validateWorkerHandoff, { ...handoff(), outcome: 'done' }, /outcome must be one of/);
  failsWith(validateWorkerHandoff, { ...handoff(), stayedInScope: false }, /scopeNote/);
  failsWith(validateWorkerHandoff, { ...handoff(), checks: [{ command: 'test', result: 'passed', exitCode: 1 }] }, /passed with a non-zero exit code/);
  failsWith(validateWorkerHandoff, { ...handoff(), checks: [{ command: 'test', result: 'green' }] }, /checks\[0\]/);
  failsWith(validateWorkerHandoff, { ...handoff(), backgroundProcesses: { stopped: false, psProof: 'x' } }, /background processes stopped/);
  failsWith(validateWorkerHandoff, without('backgroundProcesses'), /background processes stopped/);
  failsWith(validateWorkerHandoff, { ...handoff(), model: { requested: 'sonnet' } }, /requested and actual/);
  failsWith(validateWorkerHandoff, { ...handoff(), branches: [{ name: 'x', base: 'main', tip: 'nope', landed: false }] }, /branches\[0\]/);
  failsWith(validateWorkerHandoff, { ...handoff(), accepted: true }, /never self-accepts/);
});

test('review verdicts: risk classes, confidence, isolation and consistency', () => {
  assert.deepEqual(validateReviewVerdict(verdict()).problems, []);
  const without = (key) => { const v = verdict(); delete v[key]; return v; };
  for (const key of REQUIRED.verdict) failsWith(validateReviewVerdict, without(key), new RegExp(`missing field: ${key}$`));
  failsWith(validateReviewVerdict, { ...verdict(), riskClasses: [] }, /riskClasses must list/);
  failsWith(validateReviewVerdict, { ...verdict(), riskClasses: ['none', 'money'] }, /cannot be combined/);
  failsWith(validateReviewVerdict, { ...verdict(), riskClasses: ['pii'] }, /riskClasses must use/);
  failsWith(validateReviewVerdict, { ...verdict(), confidence: 'medium' }, /confidenceReason/);
  failsWith(validateReviewVerdict, { ...verdict(), reviewer: { requestedModel: 'sonnet', actualModel: 'sonnet', contextIsolated: false } }, /not independent/);
  failsWith(validateReviewVerdict, { ...verdict(), recommendation: 'accept', findings: [{ ...verdict().findings[0], severity: 'high' }] }, /accept recommendation cannot carry a high-severity finding/);
  failsWith(validateReviewVerdict, { ...verdict(), coverage: { examined: [], notExamined: [] } }, /coverage/);
  failsWith(validateReviewVerdict, { ...verdict(), evidence: [] }, /evidence/);
  failsWith(validateReviewVerdict, { ...verdict(), findings: [{ severity: 'high', location: 'a.ts:1' }] }, /findings\[0\]/);
});

test('intake decision: verdict alone, or the case that opens the diff', () => {
  const clean = { ...verdict(), recommendation: 'accept', findings: [] };
  assert.deepEqual(intakeDecision(clean), { openDiff: false, verbatim: false, reasons: [] });
  assert.deepEqual(intakeDecision(null).reasons, ['no-verdict']);
  assert.deepEqual(intakeDecision({ ...clean, reviewer: { ...clean.reviewer, contextIsolated: false } }).reasons, ['invalid-verdict']);
  assert.deepEqual(intakeDecision({ ...clean, riskClasses: ['money'] }), { openDiff: true, verbatim: true, reasons: ['risk-class'] });
  assert.deepEqual(intakeDecision({ ...clean, riskClasses: ['contract'] }), { openDiff: true, verbatim: false, reasons: ['risk-class'] });
  assert.deepEqual(intakeDecision({ ...clean, confidence: 'low', confidenceReason: 'logs missing' }).reasons, ['low-confidence']);
  assert.deepEqual(intakeDecision(clean, { ownerEvidenceAgrees: false }).reasons, ['disagreement']);
  assert.deepEqual(intakeDecision(clean, { contractChanged: true }).reasons, ['contract-change']);
  assert.deepEqual(intakeDecision(clean, { sampled: true }).reasons, ['sampling']);
  assert.deepEqual(intakeDecision(clean, { orchestratorAuthored: true }).reasons, ['orchestrator-authored']);
});

test('CLI validates a file and reports problems with a failing exit code', () => {
  const dir = mkdtempTracked('handoff-contract-cli-');
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  writeFileSync(good, JSON.stringify(verdict()));
  writeFileSync(bad, JSON.stringify({ ...verdict(), confidence: 'low' }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const ok = run('verdict', good);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'valid');
  const failed = run('verdict', bad);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /confidenceReason/);
  assert.equal(run('nonsense', good).status, 2);
  assert.equal(run('packet', join(dir, 'absent.json')).status, 2);
});

test('class guard: schema files state the same required fields and enums as the validator', () => {
  const schema = (name) => JSON.parse(readFileSync(join(ROOT, 'schemas', name), 'utf8'));
  const packetSchema = schema('task-packet.schema.json');
  const handoffSchema = schema('worker-handoff.schema.json');
  const verdictSchema = schema('review-verdict.schema.json');
  assert.deepEqual(packetSchema.required, [...REQUIRED.packet]);
  assert.deepEqual(handoffSchema.required, [...REQUIRED.handoff]);
  assert.deepEqual(verdictSchema.required, [...REQUIRED.verdict]);
  assert.deepEqual(packetSchema.properties.role.enum, [...ROLES]);
  assert.deepEqual(handoffSchema.properties.role.enum, [...ROLES]);
  assert.deepEqual(handoffSchema.properties.outcome.enum, [...OUTCOMES]);
  assert.deepEqual(handoffSchema.properties.checks.items.properties.result.enum, [...CHECK_RESULTS]);
  assert.deepEqual(verdictSchema.properties.recommendation.enum, [...RECOMMENDATIONS]);
  assert.deepEqual(verdictSchema.properties.riskClasses.items.enum, [...RISK_CLASSES, 'none']);
  assert.deepEqual(verdictSchema.properties.confidence.enum, [...CONFIDENCE]);
});
