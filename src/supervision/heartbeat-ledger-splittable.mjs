// Default-yes re-split for the heartbeat ledger (Owner 2026-10-17).
//
// Question "can the remaining work be split and run in parallel?": the default answer is YES and the
// heartbeat has to go and find the split; "no" is the exception and needs a per-item proof.
//
// Incident: a checker-style open question ("anything to re-split?") was answered by the AI for the
// checker, from the previous wake's answer, and a bare `none — <reason>` cost nothing. Rows such as
// `blocked <- claude/<unit> unlanded output` ran for hours while several units were startable.
//
// Rule (graded on the newest wake only): the wake's `re-split:` line carries
//   rows(<id>: <verdict>; <id>: <verdict>; ...)
// with one entry for EVERY `blocked <-` / `deferred <-` row of the wake table (ids r1a, r1b, r2..r10) and
// every `blocked <-` row of the `## Items` registry (ids as in the table). A verdict is exactly
//   split->dispatched <unit>            (the arrow may be `→`)
//   cannot-split: <tagged proof>        needs-landed: production effect | branch-unstable: <branch>
//                                       rewritten in the last 60 min | owner-gated | same-file
//                                       conflict: <path>
// and the section carries `splittable: <dispatched-this-wake>/<rows-with-proof>` matching the verdicts.
// A bare `none — <reason>` in prep-ahead(...) / audit(...) is rejected while any open row lacks a
// `split->dispatched` / valid `cannot-split` verdict. Pure helpers, byte-identical in the starter kit
// and in the consuming project.

import { findBlockedProofTag, PROOF_TAG_HELP } from './heartbeat-blocked-reason.mjs';

const OPEN_RE = /^(blocked|deferred)\s*(?:←|<-)\s*(\S.*)$/i;
const ITEM_BLOCKED_RE = /^blocked\s*(?:←|<-)\s*(\S.*)$/i;
const SPLIT_RE = /^split\s*(?:→|->)\s*dispatched\s+(\S.*)$/i;
const CANNOT_RE = /^cannot-split\s*:\s*(\S.*)$/i;
const ENTRY_RE = /^(r\d+[ab]?|I-?\d+)\s*[:=]?\s*(\S.*)$/i;
const TOKEN_RE = /\bsplittable:\s*(\d+)\s*\/\s*(\d+)/i;

const normId = (id) => String(id).replace(/-/g, '').toUpperCase();
const err = (rule, message) => ({ severity: 'error', rule, message });

// `name(` ... matching `)`, parentheses inside the group allowed (reasons often cite `(why)`).
function groupOf(line, name) {
  const start = line.search(new RegExp(`${name}\\(`, 'i'));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + name.length; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')' && (depth -= 1) === 0) return line.slice(start + name.length + 1, i);
  }
  return null;
}

/** Entries of a `rows(...)` group: [{id, verdict: 'dispatched'|'cannot-split'|'invalid', detail, proof}]. */
export function parseRowVerdicts(group) {
  return String(group ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const entry = part.match(ENTRY_RE);
      if (!entry) return { id: null, verdict: 'invalid', detail: part, proof: null };
      const body = entry[2].trim();
      const id = normId(entry[1]);
      if (SPLIT_RE.test(body)) return { id, verdict: 'dispatched', detail: body, proof: null };
      const cannot = body.match(CANNOT_RE);
      if (cannot) {
        const proof = findBlockedProofTag(cannot[1]);
        return { id, verdict: proof ? 'cannot-split' : 'invalid', detail: body, proof };
      }
      return { id, verdict: 'invalid', detail: body, proof: null };
    });
}

/** Open (`blocked <-` / `deferred <-`) rows of one wake: wake-table cells plus `## Items` rows. */
export function openRows({ cells = [], itemRows = [] }) {
  const out = [];
  for (const cell of cells) {
    const m = String(cell.state ?? '').trim().match(OPEN_RE);
    if (m) out.push({ id: normId(`r${cell.key}`), label: `r${cell.key}`, kind: m[1].toLowerCase(), reason: m[2].trim() });
  }
  for (const row of itemRows) {
    const m = String(row.status ?? '').trim().match(ITEM_BLOCKED_RE);
    if (m && row.id) out.push({ id: normId(row.id), label: String(row.id), kind: 'blocked', reason: m[1].trim() });
  }
  return out;
}

/**
 * Findings for the newest wake. `sectionLines` are the wake section's lines (heading excluded), `cells`
 * [{key, state}] its table cells (keys `1a`, `1b`, `2`..`10`), `itemRows` the registry [{id, status}].
 */
export function checkSplittable({ loc, sectionLines, cells, itemRows }) {
  const open = openRows({ cells, itemRows });
  if (open.length === 0) return [];
  const findings = [];
  const line = sectionLines.find((l) => /^\s*re-split:/i.test(l));
  const group = line ? groupOf(line, 'rows') : null;
  const verdicts = group === null ? [] : parseRowVerdicts(group);
  const byId = new Map(verdicts.filter((v) => v.id).map((v) => [v.id, v]));
  const labels = (rows) => rows.map((r) => r.label).join(', ');

  if (group === null) {
    findings.push(err('resplit-rows-missing', `${loc}: ${open.length} row(s) are blocked/deferred (${labels(open)}); the default answer to "can it be split?" is yes, so the wake's "re-split:" line must carry rows(<id>: split->dispatched <unit> | <id>: cannot-split: <tagged proof>; ...) for every one — proofs: ${PROOF_TAG_HELP}`));
  } else {
    for (const v of verdicts.filter((x) => x.verdict === 'invalid')) {
      findings.push(err('resplit-verdict-invalid', `${loc}: rows(...) entry "${v.id ?? ''} ${v.detail}" must be "split->dispatched <unit>" or "cannot-split: <tagged proof>" (${PROOF_TAG_HELP})`));
    }
    const missing = open.filter((r) => !byId.has(r.id));
    if (missing.length > 0) {
      findings.push(err('resplit-row-unverdicted', `${loc}: rows(...) has no verdict for ${labels(missing)} — every blocked/deferred row needs "split->dispatched <unit>" or "cannot-split: <tagged proof>"`));
    }
  }

  const unproven = open.filter((r) => !['dispatched', 'cannot-split'].includes(byId.get(r.id)?.verdict));
  if (line && unproven.length > 0) {
    for (const source of ['prep-ahead', 'audit']) {
      const answer = groupOf(line, source);
      if (answer !== null && /^\s*none\b/i.test(answer)) {
        findings.push(err('resplit-none-without-proof', `${loc}: ${source}(none …) is rejected while ${labels(unproven)} lack a split->dispatched / tagged cannot-split verdict — find the split first, then say none`));
      }
    }
  }

  const dispatched = verdicts.filter((v) => v.verdict === 'dispatched').length;
  const withProof = verdicts.filter((v) => v.verdict === 'cannot-split').length;
  const token = sectionLines.join('\n').match(TOKEN_RE);
  if (!token) {
    findings.push(err('splittable-missing', `${loc}: add "splittable: <dispatched-this-wake>/<blocked-rows-with-proof>" (here ${dispatched}/${withProof}) to the wake and to the chat status line`));
  } else if (group !== null && (Number(token[1]) !== dispatched || Number(token[2]) !== withProof)) {
    findings.push(err('splittable-mismatch', `${loc}: "splittable: ${token[1]}/${token[2]}" does not match the rows(...) verdicts (${dispatched} dispatched / ${withProof} with proof)`));
  }
  return findings;
}
