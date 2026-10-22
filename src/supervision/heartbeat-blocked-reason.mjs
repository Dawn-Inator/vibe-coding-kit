// Fake-"blocked" detection for the heartbeat ledger checker (2026-10-16).
//
// Owner complaint: splittable items sat `blocked ← candidate-preflight slots` /
// `blocked ← <X> landing in flight` / `blocked ← host CPU reserved…` for hours
// and the checker passed them. `blocked ←` is valid only when the item's FIRST
// step needs a named exclusive resource. Landing-stage resources (preflight
// slots, the finish lock, another branch landing, queued landings, host load)
// never block implementation: code, local tests and light-host verification
// proceed on a branch; only the landing waits.
//
// Pure helpers shared by the ten-row wake tables and `--items` (and byte-identical
// in the starter kit). Rules:
//   blocked-landing-stage-resource  reason names ONLY landing/load resources
//   blocked-stale                   row cites a unit/SHA/item the registry shows
//                                   done, or has been blocked > 24 h unchanged
//   write-set-no-paths              a `write set` reason names no file path
//   dispatch-freeze-unbounded/-expired  orchestrator-imposed dispatch throttle
//                                   without `expires <ISO>` / `recheck: <cond>`
//   blocked-on-unlanded-branch-defaults-free  reason waits only on another unit's unlanded
//                                   branch/output (2026-10-17): FREE by default, the first
//                                   step bases on that branch; needs a tagged proof to stay blocked

const BLOCKED_STALE_HOURS = 24;

const LANDING_STAGE_PATTERNS = [
  ['preflight slot', /preflight[- ]slots?/i],
  ['finish lock', /finish[.\s_-]?lock/i],
  ['landing in flight', /landings?\s+(?:is\s+|are\s+)?in[- ]flight|in[- ]flight\s+landings?/i],
  ['landings queued', /landings?\s+(?:is\s+|are\s+)?queued|queued\s+landings?/i],
  ['host CPU reserved', /(?:host\s+)?cpu\s+reserved/i],
  ['host load', /host\s+load|shared[- ]mac\s+load/i],
  ['queue drains', /queue\s+drains?|drains?\s+the\s+queue/i],
];

// A genuine first-step resource named alongside a landing-stage one keeps the
// row valid: a ref that must not move, an unlanded branch the item must build
// on, an Owner OTP/approval, a scarce remote machine, an exclusive write set.
const GENUINE_FIRST_STEP_PATTERNS = [
  /must not move|frozen\s+(?:ref|sha|tip|branch)|freeze\s+sha|tip\s+held|held\s+tip|pinned\s+sha/i,
  /unlanded|not[- ]yet[- ]landed|cannot\s+base|can'?t\s+base|must\s+build\s+on/i,
  /\bowner\b|\botp\b|approval|授权/i,
  /\b32c\b|test-sz|heavy-test|scarce|light\s+host|remote\s+(?:test\s+)?(?:machine|runner|host)|test\s+machine|real\s+device/i,
  /write\s+set|same\s+files?\b/i,
];

/**
 * Landing-stage resources named by a `blocked ← <reason>`, or null when the
 * reason names none, or also names a genuine first-step resource.
 */
export function findLandingStageOnlyResources(reason) {
  const text = String(reason ?? '');
  const hits = LANDING_STAGE_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (hits.length === 0) return null;
  if (GENUINE_FIRST_STEP_PATTERNS.some((re) => re.test(text))) return null;
  return hits;
}

export function landingStageMessage(rowLoc, hits) {
  return `${rowLoc}: first step (implementation on a branch) is not blocked by ${hits.join(', ')}; mark free and dispatch, landing waits on the resource`;
}

const WAKE_TIME_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/;

export function parseWakeTime(heading) {
  const m = String(heading ?? '').match(WAKE_TIME_RE);
  if (!m) return null;
  const iso = /Z$/.test(m[1]) ? m[1] : `${m[1]}Z`;
  const ms = Date.parse(iso.length === 17 ? `${iso.slice(0, 16)}:00Z` : iso);
  return Number.isNaN(ms) ? null : ms;
}

const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Wake-table staleness: a blocked cell whose text is identical to the same
 * row's text in every previous consecutive wake since > 24 h ago.
 */
export function createBlockedStreakTracker() {
  const streaks = new Map(); // key -> { text, since }
  return {
    observe(key, kind, stateText, wakeMs) {
      if (kind !== 'blocked' || wakeMs === null) {
        streaks.delete(key);
        return null;
      }
      const text = normalize(stateText);
      const prev = streaks.get(key);
      const since = prev && prev.text === text ? prev.since : wakeMs;
      streaks.set(key, { text, since });
      return wakeMs - since > BLOCKED_STALE_HOURS * 3600e3 ? since : null;
    },
  };
}

export function staleStreakMessage(rowLoc, sinceMs) {
  return `${rowLoc}: blocked reason unchanged since ${new Date(sinceMs).toISOString()} (> ${BLOCKED_STALE_HOURS}h) — re-verify that the resource is still held and update the row, or dispatch it`;
}

// --- Items registry staleness -------------------------------------------------

const ITEM_REF_RE = /\bI-?\d+\b/g;
const SHA_TOKEN_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{10,40}\b/gi;
const MARKER_TS_RE =
  /(?:since|as of|verified|re-verified|checked|rechecked|@)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/gi;

function unitOfSource(source) {
  const m = String(source ?? '').trim().match(/^(?:report|audit):(\S+)$/i);
  return m ? m[1] : null;
}

/** Latest `since|as of|verified|checked <ISO>` marker in the row, in ms, or null. */
function latestMarkerTime(row) {
  let best = null;
  for (const m of `${row.status ?? ''} ${row.evidence ?? ''}`.matchAll(MARKER_TS_RE)) {
    const t = parseWakeTime(m[1]);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * Stale `blocked ←` registry rows. `rows` are {id, source, item, status, evidence, loc};
 * `blockedReason(row)` returns the reason or null; `isDone(row)` says whether the row is done;
 * `wakeSpan(reasonKey)` (optional) returns {since, until} ms of the wake sections that carry the
 * same reason text (best-effort clock when the row has no `since|verified|checked <ISO>` marker).
 */
export function findStaleBlockedRows({ rows, blockedReason, isDone, wakeSpan = () => null, nowMs }) {
  const findings = [];
  const byId = new Map(rows.map((row) => [String(row.id ?? '').trim().toUpperCase(), row]));
  const unitRows = new Map();
  for (const row of rows) {
    const unit = unitOfSource(row.source);
    if (unit) unitRows.set(unit, [...(unitRows.get(unit) ?? []), row]);
  }
  const doneUnits = [...unitRows].filter(([, rs]) => rs.every((r) => isDone(r))).map(([unit]) => unit);
  const doneText = rows.filter((row) => isDone(row)).map((row) => ({ row, text: `${row.item ?? ''} ${row.evidence ?? ''}`.toLowerCase() }));

  for (const row of rows) {
    const reason = blockedReason(row);
    if (!reason) continue;
    const selfUnit = unitOfSource(row.source);
    const reasons = [];
    for (const ref of new Set(reason.match(ITEM_REF_RE) ?? [])) {
      const target = byId.get(ref.toUpperCase());
      if (target && target !== row && isDone(target)) reasons.push(`item ${ref} is done`);
    }
    for (const unit of doneUnits) {
      if (unit === selfUnit) continue;
      // Explicit tokens only (`report:<unit>` / `audit:<unit>`); a bare unit name or a path segment
      // (`engineering/testing/rot-gate/**`) is never a reference to the unit (I514).
      if (new RegExp(`\\b(?:report|audit):${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i').test(reason)) {
        reasons.push(`unit ${unit} is done`);
      }
    }
    for (const sha of new Set((reason.match(SHA_TOKEN_RE) ?? []).map((x) => x.toLowerCase().slice(0, 10)))) {
      if (doneText.some(({ row: d, text }) => d !== row && text.includes(sha))) reasons.push(`SHA ${sha} appears on a done row`);
    }
    if (reasons.length > 0) {
      findings.push({
        rule: 'blocked-stale',
        message: `${row.loc}: still "blocked ←" but the registry shows ${reasons.join('; ')} — re-verify the blocker (it may have cleared) and update the row`,
      });
      continue;
    }
    const marker = latestMarkerTime(row);
    let sinceMs = null;
    let untilMs = nowMs;
    if (marker !== null) sinceMs = marker;
    else {
      const span = wakeSpan(normalize(reason).slice(0, 80));
      if (span) {
        sinceMs = span.since;
        untilMs = span.until;
      }
    }
    if (sinceMs !== null && untilMs - sinceMs > BLOCKED_STALE_HOURS * 3600e3) {
      findings.push({
        rule: 'blocked-stale',
        message: `${row.loc}: blocked unchanged since ${new Date(sinceMs).toISOString()} (> ${BLOCKED_STALE_HOURS}h) — re-verify the blocker is still held and update the row (add "verified <ISO>" to the evidence cell), or dispatch it`,
      });
    }
  }
  return findings;
}

// --- write-set reasons must name files ------------------------------------------------------

const BRANCH_REF_RE = /\b(?:claude|codex|origin|refs|gate|release|hotfix)\/\S+/gi;
const PATH_TOKEN_RE =
  /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*-]+|[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|md|json|ya?ml|sh|toml|sql|css|html)\b/;

/** True when the reason claims a `write set` conflict but names no file path (a branch name is not a path). */
export function writeSetWithoutPaths(reason) {
  const text = String(reason ?? '');
  if (!/write[- ]set/i.test(text)) return false;
  return !PATH_TOKEN_RE.test(text.replace(BRANCH_REF_RE, ' '));
}

export function writeSetMessage(rowLoc) {
  return `${rowLoc}: a "write set" reason must name the overlapping FILES (a branch name is not a path); an item that only overlaps a branch bases on that branch and lands after it — mark free and dispatch`;
}

// --- orchestrator-imposed dispatch freezes -----------------------------------------------------

const FREEZE_RE = new RegExp(
  [
    String.raw`\bno new (?:write )?(?:agent )?dispatch(?:es)?\b`,
    String.raw`until (?:the )?queue (?:drains?|empties)`,
    String.raw`\b(?:paus\w*|freez\w*|froze\w*|halt\w*|hold\w*)\s+(?:all |new |further )?(?:write )?(?:agent )?dispatch(?:es)?\b`,
    String.raw`\bdispatch(?:es)?\s+(?:is |are )?(?:frozen|paused|halted|on hold)\b`,
    String.raw`throttl\w*[^|]{0,40}\b(?:dispatch|agents?|workers?)\b`,
    String.raw`\b(?:dispatch|agents?|workers?)\b[^|]{0,40}throttl`,
  ].join('|'),
  'i',
);
const EXPIRES_RE = /expires\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/i;
const RECHECK_RE = /re-?check\s*[:=]\s*\S{3,}/i;

/**
 * A dispatch freeze/throttle must carry `expires <ISO>` or `recheck: <condition>`; an `expires` in the
 * past (relative to nowMs) is still active text and fails as expired. Returns null | {rule,message}.
 */
export function freezeProblem(text, nowMs) {
  const t = String(text ?? '');
  if (!FREEZE_RE.test(t)) return null;
  const exp = t.match(EXPIRES_RE);
  const expMs = exp ? parseWakeTime(exp[1]) : null;
  if (expMs !== null && nowMs !== null && expMs <= nowMs) {
    return { rule: 'dispatch-freeze-expired', detail: `expired ${new Date(expMs).toISOString()} but still active — re-evaluate it and lift or renew it with a new expiry` };
  }
  if (expMs === null && !RECHECK_RE.test(t)) {
    return { rule: 'dispatch-freeze-unbounded', detail: 'an orchestrator-imposed dispatch freeze/throttle needs "expires <ISO>" or "recheck: <condition>", re-evaluated every wake (load pauses new heavy LOCAL processes only, never agent dispatch)' };
  }
  return null;
}

// --- another unit's unlanded branch/output defaults to FREE (Owner 2026-10-17) ------------------
//
// Incident: for ~4 h the ledger carried `blocked <- claude/<unit> unlanded output` rows. The name of a
// branch made them pass every rule, yet the first step of each could start at once by basing on that
// branch (only the landing waits); seven units were startable when the Owner asked "can this be split?".
// The default answer to "can it be split?" is YES: such a reason is a block only with a tagged proof.

const UNLANDED_RE = new RegExp(
  [
    String.raw`unlanded|not[- ]yet[- ]landed`,
    String.raw`(?:cannot|can'?t)\s+base\b|must\s+build\s+on`,
    String.raw`(?:until|after|awaiting|waiting\s+(?:for|on))\s+[^;|]{0,60}?\blands?\b`,
    String.raw`\b(?:claude|codex)/[\w.-]+[^|;]{0,40}\b(?:output|branch|landing)\b`,
  ].join('|'),
  'i',
);
const SAME_FILE_RE = /same-file conflict\s*:\s*(\S[^;|]*)/i;

/** Names the tagged proof found in a blocked/cannot-split reason, or null. */
export function findBlockedProofTag(reason) {
  const text = String(reason ?? '');
  if (/needs-landed\s*:[^;|]*\b(?:production|prod|deploy\w*|fleet|roll\w*|publish\w*|migration|landed\s+sha)\b/i.test(text)) return 'needs-landed';
  if (/branch-unstable\s*:\s*\S+\s+rewritten\b/i.test(text)) return 'branch-unstable';
  if (/\bowner-gated\b/i.test(text)) return 'owner-gated';
  const sameFile = text.match(SAME_FILE_RE);
  if (sameFile && PATH_TOKEN_RE.test(sameFile[1].replace(BRANCH_REF_RE, ' '))) return 'same-file conflict';
  return null;
}

export const PROOF_TAG_HELP =
  'needs-landed: production effect | branch-unstable: <branch> rewritten in the last 60 min | owner-gated | same-file conflict: <path>';

/** True when the reason waits on another unit's unlanded branch/output (proof or not). */
export function waitsOnUnlandedBranch(reason) {
  return UNLANDED_RE.test(String(reason ?? ''));
}

/** True when the reason waits on another unit's unlanded branch/output and carries no tagged proof. */
export function waitsOnUnlandedBranchWithoutProof(reason) {
  return waitsOnUnlandedBranch(reason) && findBlockedProofTag(reason) === null;
}

export function unlandedBranchMessage(rowLoc) {
  return `${rowLoc}: waiting only on another unit's unlanded branch/output is FREE by default (the first step bases on that branch, only the landing waits) — dispatch it, or keep "blocked ←" with one tagged proof: ${PROOF_TAG_HELP}`;
}
