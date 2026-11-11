// Reusable heartbeat guidance guards promoted from LingoFly. These checks report ledger evidence;
// none authorizes an action, terminates a worker, or blocks work by itself.
import { parseRowVerdicts } from './heartbeat-ledger-splittable.mjs';

const error = (rule, message) => ({ severity: 'error', rule, message });
const advisory = (rule, message) => ({ severity: 'advisory', rule, message });
const normId = (id) => String(id ?? '').replace(/-/g, '').toUpperCase();
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const oneB = (wake) => wake.rows.find((row) => row.num === 1)?.state.match(/\(1b\)\s*([\s\S]*)$/i)?.[1]?.trim() ?? '';
const spans = (text) => [...String(text ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
const reasonKey = (detail) => String(detail).replace(/`[^`]+`/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

function splitVerdicts(wake) {
  const line = wake.sectionLines.find((entry) => /^\s*re-split:/i.test(entry));
  if (!line) return [];
  const start = line.search(/rows\s*\(/i);
  if (start < 0) return [];
  const opening = line.indexOf('(', start);
  let depth = 0;
  let ticks = false;
  let end = -1;
  for (let i = opening; i < line.length; i += 1) {
    if (line[i] === '`') ticks = !ticks;
    else if (!ticks && line[i] === '(') depth += 1;
    else if (!ticks && line[i] === ')' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  const groupStart = opening + 1;
  return parseRowVerdicts(line.slice(groupStart, end)).filter((v) => v.verdict === 'cannot-split' && v.id).map((v, index) => ({
    id: normId(v.id), detail: v.detail, key: reasonKey(v.detail), spans: spans(v.detail), proof: v.proof,
    label: line.slice(groupStart, end).split(';')[index]?.trim().split(/[:=\s]/)[0] ?? v.id,
  }));
}

function staleSplit(wakes, items) {
  if (wakes.length < 3) return [];
  const recent = wakes.slice(-3);
  const verdicts = recent.map(splitVerdicts);
  const findings = [];
  for (const current of verdicts[2]) {
    const before = verdicts.slice(0, 2).map((set) => set.find((v) => v.id === current.id));
    if (before.some((v) => !v || v.key !== current.key)) continue;
    const isOwnerItem = items.some((row) => normId(row.id) === current.id && /^owner\s*(?:←|<-)/i.test(row.status));
    if (current.proof === 'owner-gated' && isOwnerItem) continue;
    const seen = new Set(before.flatMap((v) => v.spans));
    if (current.spans.some((span) => !seen.has(span))) continue;
    findings.push(error('cannot-split-stale', `${recent[2].heading}: rows(${current.label}: cannot-split …) repeated the same reason for three wakes without fresh command evidence; re-check this wake's item or dispatch the split`));
  }
  return findings;
}

function idleRote(wakes) {
  const findings = [];
  if (wakes.length >= 2) {
    const pair = wakes.slice(-2);
    if (pair.every((wake) => /^(blocked|empty|unchanged)\b/i.test(oneB(wake)))) {
      const line = pair[1].sectionLines.find((entry) => /^\s*re-split:/i.test(entry));
      if (!line) findings.push(error('resplit-missing', `${pair[1].heading}: row 1 (1b) has been blocked/empty for two wakes; add re-split prep-ahead(...), lessons(...), and audit(...)`));
      else for (const source of ['prep-ahead', 'lessons', 'audit']) {
        const answer = line.match(new RegExp(`${source}\\(([^)]*)\\)`, 'i'))?.[1]?.trim() ?? '';
        if (!answer) findings.push(error('resplit-incomplete', `${pair[1].heading}: re-split ${source}(…) is missing`));
        else if (/^none\b/i.test(answer) && !/^none\s*(?:—|-{1,2})\s*\S.{6,}/i.test(answer)) findings.push(error('resplit-incomplete', `${pair[1].heading}: ${source}(none …) must give a concrete reason`));
      }
    }
  }
  if (wakes.length >= 3) {
    const trio = wakes.slice(-3);
    const answers = {
      'prep-ahead': (wake) => wake.sectionLines.find((entry) => /^\s*re-split:/i.test(entry))?.match(/prep-ahead\(([^)]*)\)/i)?.[1],
      '(1b)': (wake) => oneB(wake),
    };
    for (const [label, answer] of Object.entries(answers)) {
      const values = trio.map(answer).map((value) => value && norm(value));
      if (values[0] && values.every((value) => value === values[0] && /^none\s*(?:—|-{1,2})\s*\S/i.test(value))) findings.push(error('resplit-rote', `${trio[2].heading}: ${label} repeated the identical none verdict for three wakes; cite a concrete check run from this wake`));
    }
  }
  return findings;
}

function standingAuth(items, wake) {
  const auths = [];
  for (const row of items) {
    if (/revoked|expired|撤销|失效|^\s*done\b/i.test(row.status)) continue;
    const match = `${row.item} ${row.status} ${row.evidence}`.match(/standing-auth\s*:\s*([^|;\n]+)/i);
    if (match) auths.push({ id: row.id, keywords: match[1].split(/[,，、]/).map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean) });
  }
  const waitMap = new Map();
  const addWait = (label, text) => waitMap.set(label, `${waitMap.get(label) ?? ''} ${text}`);
  for (const row of wake.rows) if (/等\s*Owner|Owner\s*当轮|owner-gated/i.test(row.state)) addWait(`R${row.num}`, row.state);
  for (const verdict of splitVerdicts(wake)) {
    if (!/owner-gated/i.test(verdict.detail)) continue;
    const wakeRow = wake.rows.find((row) => normId(`r${row.num}`) === verdict.id);
    const item = items.find((row) => normId(row.id) === verdict.id);
    addWait(verdict.id, [verdict.detail, wakeRow?.state, item?.item, item?.status].filter(Boolean).join(' '));
  }
  return [...waitMap].flatMap(([label, text]) => {
    const auth = auths.find((entry) => entry.keywords.some((kw) => norm(text).includes(kw)));
    if (!auth) return [];
    return [error('standing-auth-covers-wait', `${wake.heading} (line ${wake.line}): ${label} waits on the Owner for a phrase also recorded in Items ${auth.id} standing-auth; verify the recorded claim and scope`)];
  });
}

function capacity(items, wake) {
  const row = wake.rows.find((entry) => entry.num === 1);
  const match = row?.state.match(/capacity\s+in-flight\s*=\s*(\d+)\s+free\s*=\s*(\d+)/i);
  if (!match) return [];
  return [advisory('decompose-now-capacity-unknown', `${wake.heading}: capacity in-flight=${match[1]} free=${match[2]} is recorded, but the ledger has no host-active evidence to verify live worker capacity`)];
}

export function checkV2Guards({ wakes, items, latestWake }) {
  return [...staleSplit(wakes, items), ...idleRote(wakes), ...standingAuth(items, latestWake), ...capacity(items, latestWake)];
}
