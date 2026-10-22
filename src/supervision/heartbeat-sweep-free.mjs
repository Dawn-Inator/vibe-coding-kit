// Computed "free candidates" for the heartbeat registry.
//
// Incident (2026-10-16): an orchestrator left splittable work undispatched for about 8 h because its
// heartbeat answered "free 0 / blocked" from habit. Whether a blocked row is really blocked is a
// mechanical question, so this module answers it: every `blocked <- reason` row is classified from
// the reason text plus git evidence, and the rows that are NOT genuinely blocked come back as a list
// the orchestrator has to ingest and dispatch the same turn.
//
// Classes (first match wins):
//   stale        every unit / item id / SHA the reason names is done or an ancestor of the base, or the
//                only gate is an ISO timestamp that has passed
//   time         an ISO timestamp (with a time of day) in the reason is still in the future
//   base-on-branch  reason waits only on another unit's unlanded branch/output and carries no tagged proof
//                (needs-landed / branch-unstable / owner-gated / same-file conflict: <path>): FREE by default,
//                first step "begin on <branch>, land after it" (Owner 2026-10-17); with a proof it stays blocked
//   owner        Owner / OTP / stg / prod / approval gate
//   write-set    reason says "write set": no file paths -> FREE (needs file evidence); with paths ->
//                `git diff --name-only <base>...<branch>` of every in-flight branch named in the reason
//                (else every local claude/* branch with a live worktree); no overlap -> FREE,
//                overlap -> still blocked and the overlapping files are listed
//   landing      landing-stage or load resource (preflight slot, finish lock, landing in flight, queue,
//                host load / CPU) -> FREE: start the work now, only the final landing waits
//   dependency   names a unit or item that is still open -> genuinely blocked
//   unclassified nothing matched -> reported as blocked, never silently free
// `ready` rows that nobody dispatched are FREE as well.
//
// "In flight" is computed from evidence, never from the mere word `dispatched` (2026-10-16, I510: 55 dispatched
// rows were never closed and inflated the count). A dispatched unit is in flight when a live worktree:end/agent
// process names it, or a claude/* / codex/* branch for it has commits in the last 24 h that have not landed. A
// unit whose branches have all landed (ancestor of the base, or every commit patch-id-equivalent upstream) is
// reported as `stale-dispatched` and not counted; a unit with no evidence at all is `unverified`, not counted.
//
// Speed (I510): every git question is batched and memoized in one GitIndex: one `cat-file --batch-check` for
// all SHAs, one `rev-list <ref>` per ref for ancestry, one `for-each-ref` for all branches, one
// `diff --name-only` per branch. A sweep run costs a handful of git processes, not hundreds.
//
// Read-only: git queries only, no fetch, no writes.

import { execFile, spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

import { sanitizedGitEnv } from '../git-environment.mjs';
import { findBlockedProofTag, waitsOnUnlandedBranch } from './heartbeat-blocked-reason.mjs';

const GIT_TIMEOUT_MS = 10_000;
const FILE_EXT = 'mjs|cjs|js|jsx|ts|tsx|py|json|md|ya?ml|sql|sh|toml|css|html|plist|txt';
const STOP_UNITS = new Set(['OTP', 'CPU', 'SHA', 'UTC', 'ISO', 'API', 'CLI', 'DNS', 'RAM', 'STG', 'PROD', 'HEAD', 'TODO', 'ECS', 'NAT', 'PID']);

const OWNER_RE = /\b(owner|otp|stg|staging|prod|production|approval|authori[sz]\w*)\b|紫色|绿色|授权/i;
const LANDING_RE = /\b(preflight|finish)[- ]?(slots?|locks?|queue|windows?)\b|\bslots?\b|finish\.lock|\blandings?\b|\blands?\b|\bunlanded\b|\bqueue[ds]?\b|\bhost[- ]load\b|\bunder load\b|\bload (avg|average|\d)|\bCPU\b|worktree:end/i;
const WRITE_SET_RE = /write[- ]?set/i;
const BRANCH_RE = /\b(?:claude|codex)\/[A-Za-z0-9._-]+/g;
const STATUS_HEAD_RE = /^blocked\s*(?:←|<-|:|—|-)?\s*/i;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g;

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, env: sanitizedGitEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // A missing ref, odd repo state, a timeout, or `merge-base --is-ancestor` exit 1 means "no / not", never a crash: callers treat null as absent.
  if (res.error || res.status !== 0) return null;
  return String(res.stdout).trim();
}

const lines = (text) => (text ? text.split('\n').filter(Boolean) : []);
const DAY_MS = 24 * 3600e3;
const BIG_GIT_TIMEOUT_MS = 60_000;

function gitRaw(cwd, args, input) {
  const res = spawnSync('git', args, { cwd, env: sanitizedGitEnv(), encoding: 'utf8', timeout: BIG_GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  // Same contract as git(): a failed query is "unknown", callers fail closed (not landed / not resolvable).
  if (res.error || res.status !== 0) return null;
  return String(res.stdout);
}

/**
 * Batched, memoized, read-only git facts for one repo. Share one instance across a whole sweep run.
 * commit(token) -> full SHA | null; isAncestor(token, ref) -> true | false | null (null = not a commit);
 * reachable(ref) -> Set of SHAs | null; branches() -> [{name, ref, sha, ts, remote}].
 */
export function createGitIndex(repoDir) {
  const cache = new Map();
  const q = (args) => {
    const key = args.join('\u0000');
    if (!cache.has(key)) cache.set(key, git(repoDir, args));
    return cache.get(key);
  };
  const resolved = new Map();
  const reach = new Map();
  let branchList = null;
  const prefetch = (tokens) => {
    const todo = [...new Set(tokens)].filter((token) => /^[0-9a-fA-F]{4,40}$/.test(token) && !resolved.has(token));
    if (todo.length === 0) return;
    const out = gitRaw(repoDir, ['cat-file', '--batch-check'], `${todo.join('\n')}\n`);
    const rows = out === null ? [] : out.split('\n');
    todo.forEach((token, i) => resolved.set(token, /^([0-9a-f]{40}) commit \d+$/.exec(rows[i] ?? '')?.[1] ?? null));
  };
  const commit = (token) => {
    prefetch([token]);
    return resolved.get(token) ?? null;
  };
  const reachable = (ref) => {
    if (!reach.has(ref)) {
      const ok = q(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      const out = ok ? gitRaw(repoDir, ['rev-list', ref]) : null;
      reach.set(ref, out === null ? null : new Set(lines(out)));
    }
    return reach.get(ref);
  };
  const isAncestor = (token, ref) => {
    const full = commit(token);
    if (!full) return null;
    const set = reachable(ref);
    return set ? set.has(full) : false;
  };
  const branches = () => {
    if (branchList === null) {
      const out = q(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads/claude', 'refs/heads/codex', 'refs/remotes/origin/claude', 'refs/remotes/origin/codex']);
      branchList = lines(out ?? '').map((line) => {
        const [ref, sha, ts] = line.split('\t');
        const remote = ref.startsWith('refs/remotes/origin/');
        return { name: ref.replace(/^refs\/(?:heads|remotes\/origin)\//, ''), ref, sha, ts: Number(ts) * 1000, remote };
      });
    }
    return branchList;
  };
  const branchRef = (name) => {
    const found = branches().filter((b) => b.name === name);
    return (found.find((b) => !b.remote) ?? found[0])?.ref ?? null;
  };
  // Landed = tip is an ancestor of the base, or every commit unique to the branch has a patch-id twin upstream.
  const branchLanded = (entry, base) => {
    const set = reachable(base);
    if (set?.has(entry.sha)) return 'ancestor';
    if (!set) return null;
    const cherry = lines(q(['cherry', base, entry.ref]) ?? '');
    return cherry.length > 0 && cherry.every((line) => line.startsWith('-')) ? 'patch-id' : null;
  };
  // Run many independent read-only git queries a few at a time and prime the q() memo with their results.
  const warm = async (argsList, concurrency = 8) => {
    const queue = argsList.filter((args) => !cache.has(args.join('\u0000')));
    const worker = async () => {
      for (let args = queue.shift(); args !== undefined; args = queue.shift()) {
        const result = await new Promise((done) => {
          execFile('git', args, { cwd: repoDir, env: sanitizedGitEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => done(err ? null : stdout.trim()));
        });
        cache.set(args.join('\u0000'), result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  };
  return { q, prefetch, commit, reachable, isAncestor, branches, branchRef, branchLanded, warm };
}

const normName = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// Branches that belong to a dispatched unit: named in the row text, or whose name contains the unit name.
function branchesOfUnit(idx, unit, unitRowList) {
  const wanted = normName(unit);
  const explicit = new Set(unitRowList.flatMap((row) => `${row.status} ${row.evidence ?? ''}`.match(BRANCH_RE) ?? []));
  return idx.branches().filter((b) => explicit.has(b.name) || (wanted.length >= 3 && normName(b.name.replace(/^[^/]+\//, '')).includes(wanted)));
}

function dispatchedUnitRows(rows) {
  const unitRows = new Map();
  for (const row of rows) {
    if (statusKind(row.status) !== 'dispatched') continue;
    for (const unit of dispatchedUnits(row.status)) unitRows.set(unit, [...(unitRows.get(unit) ?? []), row]);
  }
  return unitRows;
}

/**
 * Optional async pre-pass for a shared GitIndex: runs the per-branch queries computeFree will need
 * (`diff --name-only` for write-set rows, `cherry` for dispatched units' unlanded branches) in parallel, so the
 * synchronous classification reads them from the memo. computeFree gives the same answer without it, just slower.
 */
export async function warmFree(rows, ctx) {
  const idx = ctx.index;
  const { base } = ctx;
  if (!idx || !base) return;
  const jobs = [];
  const blockedRows = rows.filter((row) => statusKind(row.status) === 'blocked');
  if (blockedRows.some((row) => WRITE_SET_RE.test(row.status))) {
    const named = new Set(blockedRows.flatMap((row) => (WRITE_SET_RE.test(row.status) ? row.status.match(BRANCH_RE) ?? [] : [])));
    for (const name of [...named, ...liveWorktreeBranches(idx.q)]) {
      const ref = idx.branchRef(name);
      if (ref) jobs.push(['diff', '--name-only', `${base}...${ref}`]);
    }
  }
  for (const [unit, unitRowList] of dispatchedUnitRows(rows)) {
    for (const b of branchesOfUnit(idx, unit, unitRowList)) if (!idx.reachable(base)?.has(b.sha)) jobs.push(['cherry', base, b.ref]);
  }
  await idx.warm(jobs);
}
const statusKind = (status) => (/^(blocked|owner|dispatched|done|ready)\b/i.exec(status.trim())?.[1] ?? 'other').toLowerCase();
const wordRe = (word, flags = '') => new RegExp(`(^|[^A-Za-z0-9-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`, flags);

// Unit names a `dispatched` status hands out: the head before any "(" / "->" / ";" detail.
function dispatchedUnits(status) {
  let head = status.replace(/^dispatched\s*:?\s*/i, '');
  while (/\([^()]*\)/.test(head)) head = head.replace(/\([^()]*\)/g, '');
  head = head.split(/[→;—]/)[0];
  return head.split(/[,/]|\band\b/).map((part) => /^\s*([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/.exec(part)?.[1]).filter(Boolean);
}

function expandItemIds(text, selfId) {
  const ids = new Set();
  for (const m of text.matchAll(/\bI-?(\d+)(?:\s*[-–]\s*I?-?(\d+))?\b/g)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to >= from && to - from <= 50) for (let n = from; n <= to; n += 1) ids.add(`I${n}`);
  }
  ids.delete(String(selfId).replace(/^I-/, 'I'));
  return ids;
}

function pathTokens(text, topLevel = new Set()) {
  const out = [];
  for (const raw of text.match(/[\w.@*~-]+(?:\/[\w.@*~-]*)+\/?|[\w.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|json|md|ya?ml|sql|sh|toml|css|html|plist)\b/g) ?? []) {
    const token = raw.replace(/[.,;:]+$/, '');
    if (/^(?:claude|codex)\//.test(token) || /^\d/.test(token) || token.startsWith('~')) continue;
    const hasExt = new RegExp(`\\.(?:${FILE_EXT})$`).test(token);
    const first = token.split('/')[0];
    if (hasExt || token.endsWith('/') || topLevel.has(first)) out.push(token);
  }
  return [...new Set(out)];
}

function pathMatches(token, file) {
  if (token.includes('*')) {
    const body = token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${body}`).test(file);
  }
  if (!token.includes('/')) return file === token || file.endsWith(`/${token}`);
  return file === token || file.startsWith(token.endsWith('/') ? token : `${token}/`);
}

function liveWorktreeBranches(q) {
  const out = [];
  for (const line of lines(q(['worktree', 'list', '--porcelain']) ?? '')) {
    const m = /^branch refs\/heads\/((?:claude|codex)\/.+)$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function defaultPs() {
  const res = spawnSync('ps', ['-eo', 'command'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  // In-flight counting from live processes is best effort: no `ps` (spawn error or non-zero status) means only ledger rows are counted.
  if (res.error || res.status !== 0) return [];
  return String(res.stdout).split('\n');
}

/**
 * Classify every blocked / ready row of an Items table.
 * rows: [{id, source, item, status, evidence}]. ctx: {repoDir, base, now?, psLines?, ledgerPath?}.
 * A live landing process counts as in-flight only when its command line names a dispatched unit or the
 * ledger's session directory; other sessions' landings on the same host are returned as `unattributed`.
 * Returns {free, stale, blocked, inFlight, summary}.
 */
export function computeFree(rows, ctx) {
  const { repoDir, base, now = new Date(), psLines } = ctx;
  // Every git query is read-only and repeats across rows (same branches, same SHAs): one shared, memoized index.
  const idx = ctx.index ?? createGitIndex(repoDir);
  const q = idx.q;
  const idKind = new Map(rows.map((row) => [String(row.id).replace(/^I-/, 'I'), statusKind(row.status)]));
  const dispatched = new Set();
  for (const row of rows) if (statusKind(row.status) === 'dispatched') for (const unit of dispatchedUnits(row.status)) dispatched.add(unit);
  const doneText = rows.filter((row) => statusKind(row.status) === 'done').map((row) => `${row.status} ${row.item}`).join('\n');
  const topLevel = new Set(lines(q(['ls-tree', '--name-only', base ?? 'HEAD']) ?? ''));
  const isAncestor = (sha) => idx.isAncestor(sha, base);
  idx.prefetch(rows.filter((row) => statusKind(row.status) === 'blocked').flatMap((row) => row.status.replace(STATUS_HEAD_RE, '').match(/\b[0-9a-f]{7,40}\b/g) ?? []));

  const free = [];
  const stale = [];
  const blocked = [];

  const classify = (row) => {
    const reason = row.status.replace(STATUS_HEAD_RE, '');
    // References: [{label, resolved}]
    const refs = [];
    for (const id of expandItemIds(reason, row.id)) if (idKind.has(id)) refs.push({ label: id, kind: 'id', resolved: idKind.get(id) === 'done' });
    for (const m of reason.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      const landed = isAncestor(m[0]);
      if (landed !== null) refs.push({ label: m[0].slice(0, 10), kind: 'sha', resolved: landed });
    }
    for (const unit of new Set(reason.match(/\b[A-Z][A-Z0-9]{3,}(?:-[A-Z0-9]+)*\b/g) ?? [])) {
      if (STOP_UNITS.has(unit)) continue;
      if (dispatched.has(unit)) refs.push({ label: unit, kind: 'unit', resolved: false });
      else if (wordRe(unit).test(doneText)) refs.push({ label: unit, kind: 'unit', resolved: true });
    }
    const open = refs.filter((ref) => !ref.resolved);
    const stamps = (reason.match(TIMESTAMP_RE) ?? []).map((s) => new Date(/Z$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`)).filter((d) => !Number.isNaN(d.getTime()));
    const future = stamps.filter((d) => d > now);
    if (future.length > 0) return { cls: 'time', why: `time gate ${future[0].toISOString()}` };
    // A unit name that merely shows up in a done row does not clear an Owner / stg / prod gate in the same sentence.
    if (refs.length > 0 && open.length === 0 && (!OWNER_RE.test(reason) || refs.every((ref) => ref.kind !== 'unit'))) {
      return { cls: 'stale', why: `every reference is done or landed on ${base ?? 'base'}: ${refs.map((r) => r.label).join(', ')}` };
    }
    if (!WRITE_SET_RE.test(reason) && waitsOnUnlandedBranch(reason)) {
      const proof = findBlockedProofTag(reason);
      if (proof) return { cls: 'proof', why: `tagged proof: ${proof}` };
      const branch = reason.match(BRANCH_RE)?.[0] ?? "the other unit's branch";
      return { cls: 'free', kind: 'base-on-branch', why: 'waits only on an unlanded branch/output with no tagged proof: the first step bases on that branch, only the landing waits', firstStep: `begin on ${branch}, land after it: ${row.item}` };
    }
    if (OWNER_RE.test(reason)) return { cls: 'owner', why: 'Owner / OTP / stg / prod gate' };

    if (WRITE_SET_RE.test(reason)) {
      const tokens = pathTokens(reason, topLevel);
      if (tokens.length === 0) return { cls: 'free', kind: 'write-set-no-paths', why: 'write set named without file paths: needs file evidence, not a wait' };
      const named = [...new Set(reason.match(BRANCH_RE) ?? [])].filter((name) => idx.branchRef(name));
      const branches = named.length > 0 ? named : liveWorktreeBranches(q).filter((name) => idx.branchRef(name));
      const overlap = new Map();
      for (const name of branches) {
        const files = lines(q(['diff', '--name-only', `${base}...${idx.branchRef(name)}`]) ?? '');
        for (const file of files) if (tokens.some((token) => pathMatches(token, file))) overlap.set(file, name);
      }
      if (overlap.size > 0) return { cls: 'overlap', why: `write-set overlap: ${[...overlap].map(([file, name]) => `${file} (${name})`).join(', ')}` };
      return { cls: 'free', kind: 'write-set-disjoint', why: `no overlap of ${tokens.join(', ')} with ${branches.length > 0 ? branches.join(', ') : 'any in-flight branch'}` };
    }
    if (LANDING_RE.test(reason)) return { cls: 'free', kind: 'landing-resource', why: 'only a landing-stage / load resource is missing: start the work now, queue only the final landing' };
    if (open.length > 0) return { cls: 'dependency', why: `waiting on open ${open.map((r) => r.label).join(', ')}` };
    if (stamps.length > 0) return { cls: 'stale', why: `time gate ${stamps[0].toISOString()} already passed` };
    return { cls: 'unclassified', why: 'no mechanical rule matched; decide by hand, do not assume blocked' };
  };

  for (const row of rows) {
    const kind = statusKind(row.status);
    const entry = { id: row.id, item: row.item, status: row.status };
    if (kind === 'ready') free.push({ ...entry, kind: 'ready-undispatched', why: 'ready row nobody dispatched', firstStep: row.item });
    else if (kind === 'owner') blocked.push({ ...entry, cls: 'owner', why: 'Owner decision row' });
    else if (kind === 'blocked') {
      const c = classify(row);
      if (c.cls === 'free') free.push({ ...entry, kind: c.kind, why: c.why, firstStep: c.firstStep ?? row.item });
      else if (c.cls === 'stale') stale.push({ ...entry, why: c.why });
      else blocked.push({ ...entry, cls: c.cls, why: c.why });
    }
  }

  const nowMs = now.getTime();
  const marker = ctx.ledgerPath ? basename(dirname(resolve(ctx.ledgerPath))) : null;
  const procs = [];
  for (const line of psLines ?? defaultPs()) {
    if (!line || /\bgrep\b|heartbeat[-:]sweep/.test(line)) continue;
    if (/worktree[:-]end|\bclaude\b|\bcodex\b|\bsubagent\b|\bagent\b/i.test(line)) procs.push(line);
  }
  const unitRows = dispatchedUnitRows(rows); // unit -> rows that dispatched it
  const verdict = new Map(); // unit -> {state: 'live'|'recent'|'landed'|'none', why}
  for (const [unit, urows] of unitRows) {
    const unitRe = wordRe(unit, 'i');
    const proc = procs.find((line) => unitRe.test(line));
    if (proc) {
      verdict.set(unit, { state: 'live', why: 'live process names the unit' });
      continue;
    }
    const matched = branchesOfUnit(idx, unit, urows);
    if (matched.length === 0) {
      verdict.set(unit, { state: 'none', why: 'no live process and no branch for the unit' });
      continue;
    }
    const tags = matched.map((b) => ({ b, landed: base ? idx.branchLanded(b, base) : null }));
    const open = tags.filter((t) => !t.landed);
    if (open.length === 0) verdict.set(unit, { state: 'landed', why: `branch ${tags[0].b.name} landed on ${base} (${tags[0].landed})` });
    else if (open.some((t) => nowMs - t.b.ts < DAY_MS)) verdict.set(unit, { state: 'recent', why: `branch ${open[0].b.name} has commits in the last 24h` });
    else verdict.set(unit, { state: 'none', why: `branch ${open[0].b.name} has no commit in the last 24h and has not landed` });
  }
  const inFlightUnits = [...verdict].filter(([, v]) => v.state === 'live' || v.state === 'recent').map(([unit]) => unit);
  const staleDispatched = [];
  const unverified = [];
  for (const row of rows) {
    if (statusKind(row.status) !== 'dispatched') continue;
    const units = dispatchedUnits(row.status);
    if (units.length === 0 || units.some((unit) => inFlightUnits.includes(unit))) continue;
    const entry = { id: row.id, item: row.item, status: row.status };
    if (units.every((unit) => verdict.get(unit)?.state === 'landed')) staleDispatched.push({ ...entry, why: units.map((unit) => verdict.get(unit).why).join('; ') });
    else unverified.push({ ...entry, why: units.map((unit) => `${unit}: ${verdict.get(unit)?.why}`).join('; ') });
  }
  const extras = new Set();
  const others = new Set();
  for (const line of procs) {
    if (!/worktree[:-]end/.test(line)) continue;
    if ([...unitRows.keys()].some((unit) => wordRe(unit, 'i').test(line))) continue;
    (marker && line.includes(marker) ? extras : others).add(/--message-file\s+(\S+)/.exec(line)?.[1] ?? line.trim());
  }
  const inFlight = inFlightUnits.length + extras.size;
  const ownerTime = blocked.filter((b) => b.cls === 'owner' || b.cls === 'time').length;
  const tail = `${stale.length > 0 ? ` · stale ${stale.length}` : ''}${staleDispatched.length > 0 ? ` · stale-dispatched ${staleDispatched.length}` : ''}${unverified.length > 0 ? ` · unverified-dispatched ${unverified.length}` : ''}`;
  const summary = `in-flight ${inFlight} · free-undispatched ${free.length} · blocked ${blocked.length} (owner/time ${ownerTime})${tail}`;
  return { free, stale, blocked, inFlight, inFlightUnits: inFlightUnits.map((unit) => `${unit} (${verdict.get(unit).state})`), staleDispatched, unverified, unattributed: others.size, summary };
}

const clip = (text, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Human-readable `free-candidates:` + `stale:` sections; empty string when there is nothing to say. */
export function formatFree({ free, stale, staleDispatched = [], unverified = [] }) {
  const out = [];
  if (free.length > 0) {
    out.push('free-candidates: (not blocked: dispatch or ingest each this wake)');
    for (const f of free) out.push(`  - ${f.id} [${f.kind}] ${f.why}; first step: ${clip(f.firstStep)}`);
  }
  if (stale.length > 0) {
    out.push('stale: (blocker already cleared: re-open as ready or mark done)');
    for (const s of stale) out.push(`  - ${s.id} ${s.why}`);
  }
  if (staleDispatched.length > 0) {
    out.push('stale-dispatched: (branch already landed: mark done or close the row; not counted as in-flight)');
    for (const s of staleDispatched) out.push(`  - ${s.id} ${clip(s.why)}`);
  }
  if (unverified.length > 0) {
    out.push('unverified-dispatched: (no live process and no recent branch: verify the worker, re-dispatch or close; not counted as in-flight)');
    for (const s of unverified) out.push(`  - ${s.id} ${clip(s.why)}`);
  }
  return out.join('\n');
}
