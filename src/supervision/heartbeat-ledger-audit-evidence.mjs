// Structural validation for the marked-v2 historical audit evidence proof.
// This checks that the referenced record is readable and internally complete; it does not certify
// that the auditor's source checks or conclusions are truthful. In particular, currentWriter=unknown
// is not evidence that the physical writer is inactive.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { isConcreteCoordinationField } from './heartbeat-ledger-tracking.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/i;
const ISO_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const add = (findings, rule, message) => findings.push({ severity: 'error', rule, message });
const concrete = (value) => typeof value === 'string' && isConcreteCoordinationField(value);

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(ISO_TIME_RE);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(offsetHour) > 14 || Number(offsetMinute) > 59 || (Number(offsetHour) === 14 && Number(offsetMinute) !== 0))) return false;
  return !Number.isNaN(Date.parse(value));
}

function validSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const hasLocator = concrete(source.locator);
  const hasResult = concrete(source.result);
  const hasSha = typeof source.sha256 === 'string' && SHA256_RE.test(source.sha256);
  const explicitlyMissing = source.missing === true;
  return concrete(source.path) && (hasLocator || hasResult) && (hasSha !== explicitlyMissing);
}

function validateTransitions(transitions) {
  const findings = [];
  if (!transitions || typeof transitions !== 'object' || Array.isArray(transitions)) {
    add(findings, 'audit-evidence-transitions', 'transitions must be an object');
    return findings;
  }
  for (const key of ['accepted', 'privateFinal', 'landed']) {
    const transition = transitions[key];
    if (!transition || typeof transition !== 'object' || Array.isArray(transition) || !['known', 'unknown'].includes(transition.state) || !concrete(transition.source)) {
      add(findings, 'audit-evidence-transitions', `transitions.${key} must have state known/unknown and a concrete source`);
    }
  }
  return findings;
}

/** Validate one audit evidence JSON record against a current deferred Item row. */
export function validateDeferredAuditEvidence({ auditRef, item, currentRowText, baseDir = process.cwd() }) {
  const findings = [];
  const loc = `item ${String(item?.id ?? '(unknown)')}`;
  if (!isConcreteCoordinationField(auditRef)) {
    add(findings, 'audit-evidence-ref', `${loc}: audit-evidence-unrecoverable needs a concrete audit-ref`);
    return findings;
  }

  const file = isAbsolute(auditRef) ? auditRef : resolve(baseDir, auditRef);
  let audit;
  try { audit = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    add(findings, 'audit-evidence-ref', `${loc}: cannot read audit evidence ${auditRef}: ${error.message}`);
    return findings;
  }
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    add(findings, 'audit-evidence-shape', `${loc}: audit evidence must be a JSON object`);
    return findings;
  }

  if (audit.itemId !== item.id) add(findings, 'audit-evidence-item', `${loc}: audit itemId must match ${item.id}`);
  if (audit.originalGoal !== item.item) add(findings, 'audit-evidence-goal', `${loc}: audit originalGoal must exactly match the current Item goal`);
  if (typeof audit.originalRowSha256 !== 'string' || !SHA256_RE.test(audit.originalRowSha256)) {
    add(findings, 'audit-evidence-row-hash', `${loc}: originalRowSha256 must be a 64-character SHA-256`);
  } else if (typeof currentRowText === 'string' && createHash('sha256').update(currentRowText).digest('hex').toLowerCase() === audit.originalRowSha256.toLowerCase()) {
    add(findings, 'audit-evidence-row-hash', `${loc}: originalRowSha256 must identify historical provenance, not this current deferred Item row`);
  }

  if (!Array.isArray(audit.checkedSources) || audit.checkedSources.length === 0 || audit.checkedSources.some((source) => !validSource(source))) {
    add(findings, 'audit-evidence-sources', `${loc}: checkedSources must be a nonempty array of {path, locator/result, sha256 or missing:true} records`);
  }
  findings.push(...validateTransitions(audit.transitions));
  if (!Array.isArray(audit.missingFields) || audit.missingFields.length === 0 || audit.missingFields.some((field) => !concrete(field))) {
    add(findings, 'audit-evidence-missing-fields', `${loc}: missingFields must be a nonempty array of concrete field names`);
  }
  if (!concrete(audit.auditor)) add(findings, 'audit-evidence-auditor', `${loc}: auditor must be concrete`);
  if (!validTimestamp(audit.checkedAt)) add(findings, 'audit-evidence-time', `${loc}: checkedAt must be a valid ISO timestamp with timezone`);
  if (audit.historicalDispatchState !== 'unknown') add(findings, 'audit-evidence-dispatch-state', `${loc}: historicalDispatchState must be unknown`);
  const writer = audit.currentWriter;
  if (!writer || typeof writer !== 'object' || Array.isArray(writer) || !['inactive', 'unknown', 'active'].includes(writer.state) || !concrete(writer.evidence)) {
    add(findings, 'audit-evidence-current-writer', `${loc}: currentWriter needs state inactive/unknown/active and concrete evidence`);
  } else if (writer.state === 'active') {
    add(findings, 'audit-evidence-current-writer', `${loc}: an active current writer cannot be covered by audit-evidence-unrecoverable`);
  }
  return findings;
}
