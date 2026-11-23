#!/usr/bin/env node
// orchestration/handoff-contract.mjs
//
// Validators for the three structured documents that cross the orchestrator/worker boundary:
//   packet  -- the task packet the orchestrator dispatches   (schemas/task-packet.schema.json)
//   handoff -- the worker's single private final            (schemas/worker-handoff.schema.json)
//   verdict -- an independent reviewer's review verdict      (schemas/review-verdict.schema.json)
// The JSON Schema files document the same contract for other tooling; these hand-written validators are
// what the kit runs (no third-party dependencies). A document that fails validation is treated as if it
// had not arrived: an invalid handoff is `blocked`, an invalid verdict is "no review".
//
// `intakeDecision` applies the review-verdict intake rules: whether the orchestrator must open the raw
// diff itself, and whether the material must reach it verbatim.
//
// CLI:
//   node handoff-contract.mjs <packet|handoff|verdict> <file.json>
// prints "valid" or one problem per line; exit 0 valid, 1 invalid, 2 usage or unreadable file.

import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isMainModule } from '../lib/main-module.mjs';

export const SCHEMA_VERSION = 1;
export const ROLES = Object.freeze(['explorer', 'module-owner', 'reviewer', 'sub-planner']);
export const READ_ONLY_ROLES = Object.freeze(['explorer', 'reviewer', 'sub-planner']);
export const OUTCOMES = Object.freeze(['candidate', 'checkpoint', 'blocked']);
export const CHECK_RESULTS = Object.freeze(['passed', 'failed', 'not-run', 'queued']);
export const RECOMMENDATIONS = Object.freeze(['accept', 'return-for-fix', 'blocked']);
export const RISK_CLASSES = Object.freeze(['money', 'auth', 'migration', 'secrets', 'irreversible', 'contract']);
export const VERBATIM_RISK_CLASSES = Object.freeze(['money', 'auth', 'migration', 'secrets', 'irreversible']);
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

export const REQUIRED = Object.freeze({
  packet: Object.freeze(['schemaVersion', 'role', 'moduleId', 'target', 'writeScope', 'base', 'model', 'verification', 'offloadDir', 'attempt']),
  handoff: Object.freeze(['schemaVersion', 'role', 'moduleId', 'outcome', 'stayedInScope', 'checks', 'unverified', 'model', 'next']),
  verdict: Object.freeze(['schemaVersion', 'moduleId', 'candidateSha', 'baseSha', 'recommendation', 'findings', 'riskClasses', 'coverage', 'confidence', 'evidence', 'reviewer']),
});

const SHA_RE = /^[0-9a-f]{7,64}$/;
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isSha = (v) => typeof v === 'string' && SHA_RE.test(v);
const isAbsolutePath = (v) => isText(v) && (posix.isAbsolute(v) || win32.isAbsolute(v));

function base(doc, kind) {
  const problems = [];
  if (!isObject(doc)) return [`${kind} must be a JSON object`];
  for (const key of REQUIRED[kind]) if (!Object.hasOwn(doc, key)) problems.push(`missing field: ${key}`);
  if (Object.hasOwn(doc, 'schemaVersion') && doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (Object.hasOwn(doc, 'moduleId') && !(typeof doc.moduleId === 'string' && MODULE_ID_RE.test(doc.moduleId))) problems.push('moduleId must be a stable identifier');
  return problems;
}

/** Validate a task packet. Returns { ok, problems }. */
export function validateTaskPacket(doc) {
  const problems = base(doc, 'packet');
  if (!isObject(doc)) return { ok: false, problems };
  const role = doc.role;
  if (Object.hasOwn(doc, 'role') && !ROLES.includes(role)) problems.push(`role must be one of ${ROLES.join(', ')}`);
  if (Object.hasOwn(doc, 'target') && !isText(doc.target)) problems.push('target must be a non-empty string');

  if (Object.hasOwn(doc, 'writeScope')) {
    const scope = doc.writeScope;
    if (scope !== 'none' && !(Array.isArray(scope) && scope.length > 0 && isTextList(scope))) {
      problems.push('writeScope must be "none" or a non-empty list of paths');
    } else if (READ_ONLY_ROLES.includes(role) && scope !== 'none') {
      problems.push(`a ${role} packet must set writeScope to "none"`);
    } else if (role === 'module-owner' && scope === 'none') {
      problems.push('a module-owner packet must list its write scope');
    }
  }
  if (role === 'module-owner' && !isAbsolutePath(doc.worktree)) problems.push('a module-owner packet must name an absolute pre-created worktree');
  if (Object.hasOwn(doc, 'base') && !(isObject(doc.base) && isSha(doc.base.sha))) problems.push('base.sha must be a commit SHA');
  if (role === 'reviewer' && !isSha(doc.candidateSha)) problems.push('a reviewer packet must bind candidateSha to one commit');
  if (['module-owner', 'reviewer', 'sub-planner'].includes(role) && !(Array.isArray(doc.acceptanceCriteria) && doc.acceptanceCriteria.length > 0 && isTextList(doc.acceptanceCriteria))) {
    problems.push(`a ${role} packet must list acceptanceCriteria`);
  }
  if (Object.hasOwn(doc, 'model') && !(isObject(doc.model) && isText(doc.model.requested))) problems.push('model.requested must name the worker model explicitly');
  if (Object.hasOwn(doc, 'verification')) {
    if (!Array.isArray(doc.verification)) problems.push('verification must be a list');
    else doc.verification.forEach((check, i) => {
      if (!isObject(check) || !isText(check.command) || typeof check.heavy !== 'boolean') problems.push(`verification[${i}] needs a command and a boolean heavy flag`);
      else if (check.heavy && !isText(check.slot)) problems.push(`verification[${i}] is heavy and needs the granted slot`);
    });
  }
  if (Object.hasOwn(doc, 'offloadDir') && !isAbsolutePath(doc.offloadDir)) problems.push('offloadDir must be an absolute path');
  if (Object.hasOwn(doc, 'attempt') && !(isObject(doc.attempt) && Number.isInteger(doc.attempt.number) && doc.attempt.number >= 1)) problems.push('attempt.number must be a positive integer');
  if (doc.nestedDispatch === true && !['module-owner', 'sub-planner'].includes(role)) problems.push(`a ${role} packet cannot authorize nested dispatch`);
  if (Object.hasOwn(doc, 'nestedDispatch') && typeof doc.nestedDispatch !== 'boolean') problems.push('nestedDispatch must be a boolean');
  return { ok: problems.length === 0, problems };
}

/** Validate a worker's final handoff. Returns { ok, problems }. */
export function validateWorkerHandoff(doc) {
  const problems = base(doc, 'handoff');
  if (!isObject(doc)) return { ok: false, problems };
  const role = doc.role;
  if (Object.hasOwn(doc, 'role') && !ROLES.includes(role)) problems.push(`role must be one of ${ROLES.join(', ')}`);
  if (Object.hasOwn(doc, 'outcome') && !OUTCOMES.includes(doc.outcome)) problems.push(`outcome must be one of ${OUTCOMES.join(', ')}`);
  if (doc.outcome === 'candidate' && !(isSha(doc.candidateSha) && isSha(doc.baseSha))) problems.push('a candidate handoff must report candidateSha and baseSha');
  if (doc.outcome === 'checkpoint' && !isText(doc.continuation)) problems.push('a checkpoint handoff must state the exact continuation');
  if (doc.outcome === 'blocked' && !isText(doc.blocker)) problems.push('a blocked handoff must name the concrete blocker');
  if (Object.hasOwn(doc, 'stayedInScope')) {
    if (typeof doc.stayedInScope !== 'boolean') problems.push('stayedInScope must be a boolean');
    else if (!doc.stayedInScope && !isText(doc.scopeNote)) problems.push('a handoff outside its scope must explain it in scopeNote');
  }
  if (Object.hasOwn(doc, 'checks')) {
    if (!Array.isArray(doc.checks)) problems.push('checks must be a list');
    else doc.checks.forEach((check, i) => {
      if (!isObject(check) || !isText(check.command) || !CHECK_RESULTS.includes(check.result)) problems.push(`checks[${i}] needs a command and a result (${CHECK_RESULTS.join(', ')})`);
      else if (check.result === 'passed' && Object.hasOwn(check, 'exitCode') && check.exitCode !== 0) problems.push(`checks[${i}] is reported passed with a non-zero exit code`);
    });
  }
  if (Object.hasOwn(doc, 'unverified') && !(Array.isArray(doc.unverified) && isTextList(doc.unverified))) problems.push('unverified must be a list of strings');
  if (Object.hasOwn(doc, 'model') && !(isObject(doc.model) && isText(doc.model.requested) && isText(doc.model.actual))) problems.push('model must report requested and actual (use "unknown" when the runtime does not say)');
  if (Object.hasOwn(doc, 'next') && !(isObject(doc.next) && isText(doc.next.action) && isText(doc.next.owner))) problems.push('next must name an action and its owner');
  if (Object.hasOwn(doc, 'branches')) {
    if (!Array.isArray(doc.branches)) problems.push('branches must be a list');
    else doc.branches.forEach((branch, i) => {
      if (!isObject(branch) || !isText(branch.name) || !isText(branch.base) || !isSha(branch.tip) || typeof branch.landed !== 'boolean') problems.push(`branches[${i}] needs name, base, tip SHA and landed`);
    });
  }
  if (role === 'module-owner') {
    const bg = doc.backgroundProcesses;
    if (!(isObject(bg) && bg.stopped === true && isText(bg.psProof))) problems.push('a module-owner handoff must prove its background processes stopped (backgroundProcesses.stopped and psProof)');
  }
  for (const claim of ['accepted', 'acceptance']) if (Object.hasOwn(doc, claim)) problems.push(`a handoff never self-accepts: remove "${claim}"`);
  return { ok: problems.length === 0, problems };
}

/** Validate a review verdict. Returns { ok, problems }. */
export function validateReviewVerdict(doc) {
  const problems = base(doc, 'verdict');
  if (!isObject(doc)) return { ok: false, problems };
  for (const key of ['candidateSha', 'baseSha']) if (Object.hasOwn(doc, key) && !isSha(doc[key])) problems.push(`${key} must be a commit SHA`);
  if (Object.hasOwn(doc, 'recommendation') && !RECOMMENDATIONS.includes(doc.recommendation)) problems.push(`recommendation must be one of ${RECOMMENDATIONS.join(', ')}`);
  if (Object.hasOwn(doc, 'findings')) {
    if (!Array.isArray(doc.findings)) problems.push('findings must be a list');
    else doc.findings.forEach((f, i) => {
      if (!isObject(f) || !SEVERITIES.includes(f.severity) || !isText(f.location) || !isText(f.criterion) || !isText(f.fix)) problems.push(`findings[${i}] needs severity, location, criterion and fix`);
    });
    if (doc.recommendation === 'accept' && Array.isArray(doc.findings) && doc.findings.some((f) => isObject(f) && f.severity === 'high')) problems.push('an accept recommendation cannot carry a high-severity finding');
  }
  if (Object.hasOwn(doc, 'riskClasses')) {
    const classes = doc.riskClasses;
    if (!Array.isArray(classes) || classes.length === 0) problems.push('riskClasses must list every class checked, or ["none"]');
    else if (classes.includes('none') && classes.length > 1) problems.push('riskClasses "none" cannot be combined with other classes');
    else if (!classes.every((c) => c === 'none' || RISK_CLASSES.includes(c))) problems.push(`riskClasses must use ${[...RISK_CLASSES, 'none'].join(', ')}`);
  }
  if (Object.hasOwn(doc, 'coverage') && !(isObject(doc.coverage) && Array.isArray(doc.coverage.examined) && doc.coverage.examined.length > 0 && isTextList(doc.coverage.examined) && Array.isArray(doc.coverage.notExamined) && isTextList(doc.coverage.notExamined))) {
    problems.push('coverage must list what was examined and what was not');
  }
  if (Object.hasOwn(doc, 'confidence')) {
    if (!CONFIDENCE.includes(doc.confidence)) problems.push(`confidence must be one of ${CONFIDENCE.join(', ')}`);
    else if (doc.confidence !== 'high' && !isText(doc.confidenceReason)) problems.push('confidence below high needs a confidenceReason');
  }
  if (Object.hasOwn(doc, 'evidence') && !(Array.isArray(doc.evidence) && doc.evidence.length > 0 && isTextList(doc.evidence))) problems.push('evidence must name the files the review read');
  if (Object.hasOwn(doc, 'reviewer')) {
    const r = doc.reviewer;
    if (!(isObject(r) && isText(r.requestedModel) && isText(r.actualModel))) problems.push('reviewer must report requestedModel and actualModel');
    else if (r.contextIsolated !== true) problems.push('reviewer.contextIsolated must be true; a reviewer sharing the author or orchestrator context is not independent');
  }
  return { ok: problems.length === 0, problems };
}

const VALIDATORS = { packet: validateTaskPacket, handoff: validateWorkerHandoff, verdict: validateReviewVerdict };

/**
 * Apply the review-verdict intake rules for one candidate.
 * `context`: { ownerEvidenceAgrees, contractChanged, sampled, orchestratorAuthored }.
 * Returns { openDiff, verbatim, reasons }: reasons name each case that applied, `verbatim` is true when the
 * material must reach the orchestrator regardless of context budget.
 */
export function intakeDecision(verdict, context = {}) {
  if (verdict === null || verdict === undefined) return { openDiff: true, verbatim: false, reasons: ['no-verdict'] };
  const check = validateReviewVerdict(verdict);
  if (!check.ok) return { openDiff: true, verbatim: false, reasons: ['invalid-verdict'] };
  const reasons = [];
  const classes = verdict.riskClasses.filter((c) => c !== 'none');
  if (classes.length) reasons.push('risk-class');
  if (context.ownerEvidenceAgrees === false) reasons.push('disagreement');
  if (verdict.confidence !== 'high') reasons.push('low-confidence');
  if (context.contractChanged === true) reasons.push('contract-change');
  if (context.sampled === true) reasons.push('sampling');
  if (context.orchestratorAuthored === true) reasons.push('orchestrator-authored');
  return { openDiff: reasons.length > 0, verbatim: classes.some((c) => VERBATIM_RISK_CLASSES.includes(c)), reasons };
}

export function validateDocument(kind, doc) {
  const validator = VALIDATORS[kind];
  if (!validator) throw new Error(`unknown document kind: ${kind}`);
  return validator(doc);
}

function main(argv) {
  const [kind, file] = argv;
  if (!VALIDATORS[kind] || !file) {
    console.error('Usage: handoff-contract.mjs <packet|handoff|verdict> <file.json>');
    return 2;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${file}: ${error.message}`);
    return 2;
  }
  const result = validateDocument(kind, doc);
  if (result.ok) {
    console.log('valid');
    return 0;
  }
  for (const problem of result.problems) console.log(problem);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
