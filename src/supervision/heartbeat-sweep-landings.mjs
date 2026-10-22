// Landings discovery for heartbeat-sweep: commits that reached a tracked base branch and that no
// `landing:` registry item names yet. Read-only, local refs only (the sweep never fetches).
//
// "Last reviewed point" = among registry items with source `landing:<sha>` (or a range
// `landing:<a>..<b>`, whose end counts) and status `done`, the one that is an ancestor of the
// branch tip and nearest to it. Everything after it that no `landing:` item names -- in any status --
// is listed as contiguous ranges, one candidate each.

import { execFileSync } from 'node:child_process';
import { sanitizedGitEnv } from '../git-environment.mjs';

const GIT_TIMEOUT_MS = 10_000;
const MAX_SCAN = 2000;
const SHA_TOKEN = /^[0-9a-f]{7,40}$/i;

export function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, env: sanitizedGitEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // A missing ref or an odd repo state means "not found", never a crash: every caller treats null as absent.
    return null;
  }
}

const lines = (text) => (text ? text.split('\n').filter(Boolean) : []);

export function resolveCommit(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

// The default tracked base: the remote-tracking ref of the repo's default branch, else a local main/master.
export function defaultBase(cwd) {
  for (const remote of lines(git(cwd, ['remote']) ?? '')) {
    const head = git(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (head && resolveCommit(cwd, head)) return head;
    for (const name of ['main', 'master']) if (resolveCommit(cwd, `${remote}/${name}`)) return `${remote}/${name}`;
  }
  for (const name of ['main', 'master']) if (resolveCommit(cwd, name)) return name;
  return null;
}

// Split a `landing:` source into its sha tokens; `a..b` is a range, a single token is one commit.
function landingTokens(source) {
  const body = source.replace(/^landing:/i, '');
  const [from, to] = body.split('..');
  return { from: SHA_TOKEN.test(from ?? '') ? from : null, to: SHA_TOKEN.test(to ?? '') ? to : null, single: to === undefined && SHA_TOKEN.test(from ?? '') ? from : null };
}

function coveredCommits(cwd, rows) {
  const covered = new Set();
  for (const row of rows) {
    if (!/^landing:/i.test(row.source)) continue;
    const { from, to, single } = landingTokens(row.source);
    if (single) {
      const sha = resolveCommit(cwd, single);
      if (sha) covered.add(sha);
    } else if (from && to) {
      const start = resolveCommit(cwd, from);
      const end = resolveCommit(cwd, to);
      if (!start || !end) continue;
      covered.add(start);
      covered.add(end);
      for (const sha of lines(git(cwd, ['rev-list', `${start}..${end}`]) ?? '')) covered.add(sha);
    }
  }
  return covered;
}

function lastReviewedPoint(cwd, rows, tip) {
  let best = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    if (!/^landing:/i.test(row.source) || !/^done\b/i.test(row.status)) continue;
    const { to, single } = landingTokens(row.source);
    const sha = resolveCommit(cwd, to ?? single ?? '');
    if (!sha || git(cwd, ['merge-base', '--is-ancestor', sha, tip]) === null) continue;
    const distance = Number(git(cwd, ['rev-list', '--count', `${sha}..${tip}`]));
    if (Number.isFinite(distance) && distance < bestDistance) {
      best = sha;
      bestDistance = distance;
    }
  }
  return best;
}

const subjectOf = (cwd, sha) => git(cwd, ['log', '-1', '--format=%s', sha]) ?? '';

// -> { candidates: [{source, item, evidence}], notes: [string] } for one base ref.
// `proposed` is shared across bases: a commit reachable from several tracked branches is proposed once.
export function discoverLandings(cwd, base, rows, { maxRows, proposed = new Set() }) {
  const tip = resolveCommit(cwd, base);
  if (!tip) return { candidates: [], notes: [`landings: ${base} does not resolve to a commit (skipped)`] };
  const last = lastReviewedPoint(cwd, rows, tip);
  const covered = coveredCommits(cwd, rows);
  for (const sha of proposed) covered.add(sha);
  const range = last ? [`${last}..${tip}`] : [tip];
  const walk = lines(git(cwd, ['rev-list', '--topo-order', '-n', String(MAX_SCAN), ...range]) ?? '').reverse();

  const ranges = [];
  let open = null;
  for (const sha of walk) {
    if (covered.has(sha)) {
      open = null;
    } else if (open) {
      open.push(sha);
    } else {
      open = [sha];
      ranges.push(open);
    }
  }

  const notes = [];
  if (!last) notes.push(`landings: ${base} has no done landing: item that is an ancestor of it; scanning the newest ${Math.min(walk.length, MAX_SCAN)} commits`);
  const candidates = ranges.slice(0, maxRows).map((shas) => {
    for (const sha of shas) proposed.add(sha);
    const first = shas[0];
    const end = shas[shas.length - 1];
    const short = (sha) => sha.slice(0, 10);
    const hasParent = git(cwd, ['rev-parse', '--verify', '--quiet', `${first}^`]) !== null;
    const log = hasParent ? `git log --oneline ${short(first)}^..${short(end)}` : `git log --oneline ${short(end)}`;
    const source = shas.length === 1 ? `landing:${short(first)}` : `landing:${short(first)}..${short(end)}`;
    const subjects = shas.length === 1 ? subjectOf(cwd, first) : `${subjectOf(cwd, first)} .. ${subjectOf(cwd, end)}`;
    return { source, item: `review ${shas.length} commit(s) on ${base}: ${subjects}`, evidence: `\`${log}\`` };
  });
  const overflow = ranges.length - candidates.length;
  if (overflow > 0) {
    candidates.push({
      source: `sweep:landings-overflow:${base.replace(/[^\w./-]/g, '_')}`,
      item: `${overflow} more uncovered landing range(s) on ${base} beyond the ${maxRows}-row cap`,
      evidence: 'ingest the rows above, then re-run the sweep to list the rest',
      always: true,
    });
  }
  return { candidates, notes };
}
