#!/usr/bin/env node
// Branch registry for the heartbeat. Every branch a dispatched worker or child session creates is
// appended to `branches.md` next to the heartbeat ledger, so each wake can see every one of them,
// land the finished ones and clean the landed ones instead of leaving branches and worktrees behind.
//
// Usage:
//   heartbeat-branches.mjs record --ledger <ledger> --branch <name> --base <target-branch> --owner <agent-id|session:<id>>
//                                 [--worktree <path>] [--item <id>] [--note <text>] [--remote <name>]
//   heartbeat-branches.mjs check  --ledger <ledger> [--remote <name>] [--json]
//   heartbeat-branches.mjs clean  --ledger <ledger> --branch <name> [--apply] [--remote <name>]
//   (--registry <path> overrides the default `<ledger dir>/branches.md`.)
// Exit codes: record 0 recorded or already live; check 0 nothing to act on, 1 at least one branch to
// clean or land, or a finished child session not yet archived; clean 0 cleaned (dry run: would clean),
// 1 refused; 2 usage error.
//
// `check` is read-only and offline: it reads whatever the remote-tracking refs hold (fetch first).
// `clean` without --apply is a dry run on the same offline facts. With --apply it fetches the base and
// asks the remote for the branch's real tip, re-assesses, and only then (1) removes the worktree after
// the kit's removal proof, (2) deletes the remote branch with a lease on the tip it assessed, (3)
// deletes the local ref with the same compare-and-swap, and (4) appends a `cleaned` row. It never
// removes anything unlanded, dirty, in use, protected, or missing from this session's own registry:
// branches another session created are not this session's to clean.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseItems } from './check-heartbeat-ledger.mjs';
import { stateDirOf } from './heartbeat-sweep-worktrees.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';
import { isPathWithin, samePathIdentity } from '../lib/path-identity.mjs';
import { assertKitSafeToRemove } from '../dependencies/submodule.mjs';
import { loadConfig } from '../worktrees/config.mjs';
import { finishLockIsLive, livePathsFromFinishQueue, liveProcessCwds } from '../worktrees/reclaim-stale.mjs';
import { makeOwnedTreeWritable } from '../worktrees/writable-tree.mjs';
import { assessHeadLanded, discoverRepo, git, gitRaw } from '../worktrees/worktree-core.mjs';

// Inline copy of the shared helper (the kit is copied into other repos; see heartbeat-sweep.mjs).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

export const REGISTRY_FILE = 'branches.md';
// `start` is the branch tip when it was registered (empty when the branch did not exist yet): a tip still
// equal to it has no work of its own, so being "on the base" proves nothing about it being finished.
export const COLUMNS = ['time', 'event', 'branch', 'base', 'start', 'owner', 'worktree', 'item', 'note'];
export const EVENTS = ['created', 'cleaned'];
// Long-lived shared lines are never a worker's branch to register or delete, whatever a row says.
const PROTECTED_RES = [/^(HEAD|main|master|trunk|develop|development|staging|production|release)$/, /(^|\/)develop$/, /^(gate|release)\//];
// States a wake has to act on. `in-progress` / `dirty` / `busy` are reported, never acted on.
export const ACTIONABLE = new Set(['cleanable', 'gone', 'land-pending']);

class UsageError extends Error {}

const cell = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim() || '-';
const value = (text) => (text === '-' ? '' : text);
const short = (sha) => (sha ? sha.slice(0, 12) : '-');

export function isProtectedBranch(branch, base = '') {
  return PROTECTED_RES.some((re) => re.test(branch)) || (Boolean(base) && branch === base);
}

export function registryPathFor(ledger, registry = null) {
  return resolve(registry || join(dirname(resolve(ledger)), REGISTRY_FILE));
}

export function registryHeader() {
  return [
    '# Branch registry',
    '',
    'Append-only; written by `heartbeat-branches.mjs record` / `clean --apply`. The newest row per branch is its state.',
    '',
    `| ${COLUMNS.join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
  ].join('\n');
}

export function parseRegistry(text) {
  const rows = [];
  String(text ?? '').split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line)) return;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells[0] === 'time' || /^-+$/.test(cells[0])) return;
    const row = Object.fromEntries(COLUMNS.map((name, i) => [name, value(cells[i] ?? '-')]));
    if (!row.branch || !EVENTS.includes(row.event)) return;
    rows.push({ ...row, line: index + 1 });
  });
  return rows;
}

// The newest `created` row of every branch whose newest event is not `cleaned`.
export function liveBranches(rows) {
  const latest = new Map();
  for (const row of rows) latest.set(row.branch, { last: row, created: row.event === 'created' ? row : latest.get(row.branch)?.created });
  return [...latest.values()].filter((entry) => entry.last.event !== 'cleaned' && entry.created).map((entry) => entry.created);
}

function readRegistry(path) {
  return existsSync(path) ? parseRegistry(readFileSync(path, 'utf8')) : [];
}

function appendRow(path, row, now = new Date()) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${registryHeader()}\n`);
  }
  const full = { time: `${now.toISOString().slice(0, 16)}Z`, ...row };
  appendFileSync(path, `| ${COLUMNS.map((name) => cell(full[name])).join(' | ')} |\n`);
}

const refSha = (repoDir, ref) => {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoDir, { retry: false });
  return result.status === 0 ? result.stdout : '';
};

export function resolveBaseRef(repoDir, base, remote) {
  if (refSha(repoDir, `refs/remotes/${remote}/${base}`)) return `refs/remotes/${remote}/${base}`;
  if (refSha(repoDir, `refs/heads/${base}`)) return `refs/heads/${base}`;
  return '';
}

function worktreeState(entry, { liveCwds, livePaths, currentPath }) {
  const status = gitRaw(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], entry.path, { retry: false });
  const reasons = [];
  if (!existsSync(entry.path)) reasons.push(`worktree ${entry.path} is registered but its directory is missing (git worktree prune)`);
  else if (status.status !== 0) reasons.push(`git status failed in ${entry.path}`);
  else if (status.stdout.trim()) return { dirty: true, busy: [], reasons: [`worktree ${entry.path} has uncommitted, untracked, or ignored files`] };
  const busy = [];
  if (isPathWithin(entry.path, currentPath)) busy.push('this command runs inside it');
  if (!liveCwds) busy.push('the live-process inventory is unavailable');
  else if (liveCwds.unknownPids?.length) busy.push(`cannot verify working directories of ${liveCwds.unknownPids.length} process(es)`);
  else if ([...liveCwds].some((cwd) => isPathWithin(entry.path, cwd))) busy.push('a running process has it as its working directory');
  if ([...livePaths].some((path) => samePathIdentity(path, entry.path))) busy.push('a live finish ticket names it');
  return { dirty: reasons.length > 0, busy, reasons };
}

// One registered branch -> {state, reasons, ...}. States: gone (nothing left, only the `cleaned` row is
// owed), cleanable (landed, idle, and its item is done or it has commits of its own), land-pending (its
// item is done but the work is not on the base), in-progress, dirty, busy, protected, no-base.
export function assessBranch(repoDir, row, ctx) {
  const { remote, repo, items } = ctx;
  const out = { branch: row.branch, base: row.base, owner: row.owner, item: row.item, reasons: [], local: '', remote: '', worktree: null, landedVia: '' };
  const done = (state, reason) => {
    if (reason) out.reasons.push(reason);
    return { ...out, state };
  };
  if (isProtectedBranch(row.branch, row.base)) return done('protected', `${row.branch} is a protected shared branch; it is never cleaned by the heartbeat`);
  out.local = refSha(repoDir, `refs/heads/${row.branch}`);
  out.remote = refSha(repoDir, `refs/remotes/${remote}/${row.branch}`);
  const entry = repo.worktrees.find((wt) => wt.branch === row.branch)
    || (row.worktree ? repo.worktrees.find((wt) => samePathIdentity(wt.path, row.worktree)) : null);
  if (entry) out.worktree = entry.path;
  if (entry && entry.branch !== row.branch) return done('protected', `recorded worktree ${entry.path} is now on ${entry.branch || 'a detached HEAD'}, not ${row.branch}`);
  if (entry && repo.primaryWorktree && samePathIdentity(entry.path, repo.primaryWorktree.path)) {
    return done('protected', `${row.branch} is checked out in the primary worktree`);
  }
  if (!out.local && !out.remote && !entry) return done('gone', 'no local ref, remote-tracking ref or worktree is left; record it as cleaned');
  if (out.local && ctx.prefixes && !ctx.prefixes.some((prefix) => row.branch.startsWith(prefix))) {
    return done('protected', `local ${row.branch} does not use a managed prefix (${ctx.prefixes.join(', ')}); the heartbeat deletes only managed local branches`);
  }

  const item = row.item ? items.find((it) => it.id === row.item) : null;
  const itemDone = Boolean(item && /^done\b/i.test(item.status));
  // Its owner is still on it: no landing analysis (patch-id can be slow) and nothing to act on yet.
  if (row.item && !itemDone) return done('in-progress', `item ${row.item} is not done yet (${item ? item.status : 'no such Items row'})`);

  const baseRef = row.base ? resolveBaseRef(repoDir, row.base, remote) : '';
  if (!baseRef) return done('no-base', `base ${row.base || '(none)'} resolves neither as ${remote}/${row.base} nor as a local branch`);
  out.baseRef = baseRef;
  const tips = [...new Set([out.local, out.remote, entry?.head].filter(Boolean))];
  const unlanded = [];
  for (const tip of tips) {
    const verdict = assessHeadLanded(repoDir, baseRef, { headRef: tip });
    if (verdict.landed) out.landedVia ||= verdict.via;
    else unlanded.push(`${short(tip)} is not on ${baseRef} (${verdict.reason})`);
  }
  if (entry) {
    const wt = worktreeState(entry, ctx);
    if (wt.dirty) return done('dirty', [...wt.reasons, ...unlanded].join('; '));
    if (unlanded.length === 0 && wt.busy.length > 0) return done('busy', `worktree ${entry.path}: ${wt.busy.join('; ')}`);
  }
  if (unlanded.length > 0) {
    if (itemDone) return done('land-pending', `item ${item.id} is done but ${unlanded.join('; ')}: land it through the project's finish path`);
    return done('in-progress', unlanded.join('; '));
  }
  // Landed tips alone do not prove the unit finished: a branch nobody has committed to yet sits on its base too.
  if (!row.item && row.start && tips.every((tip) => tip === row.start)) {
    return done('in-progress', `no commits since it was registered at ${short(row.start)} and no --item links it to a done row`);
  }
  return done('cleanable', `every tip is on ${baseRef} (via ${out.landedVia || 'ancestry'})${itemDone ? `; item ${row.item} is done` : ''}`);
}

// `session:<id>` references in Items rows: a row not done means the session must be polled this wake;
// a done row whose evidence never says it was archived means the archive step is still owed.
export function childSessions(items, registryRows = []) {
  const byId = new Map();
  const note = (id, entry) => { if (!byId.has(id)) byId.set(id, entry); };
  for (const row of items) {
    const text = `${row.item} ${row.status} ${row.evidence}`;
    for (const match of text.matchAll(/\bsession:([A-Za-z0-9_-]+)/g)) {
      const id = match[1];
      if (!/^done\b/i.test(row.status)) note(id, { id, item: row.id, action: 'poll' });
      else if (!/\barchiv/i.test(row.evidence)) note(id, { id, item: row.id, action: 'archive' });
      else note(id, { id, item: row.id, action: 'archived' });
    }
  }
  for (const row of liveBranches(registryRows)) {
    const id = /^session:([A-Za-z0-9_-]+)$/.exec(row.owner)?.[1];
    if (id) note(id, { id, item: row.item || '-', action: 'poll' });
  }
  return [...byId.values()].filter((entry) => entry.action !== 'archived');
}

function checkContext(repoDir, { remote, ledger, config = null, getLiveProcessCwds = liveProcessCwds } = {}) {
  const repo = discoverRepo(repoDir);
  const worktreeConfig = loadConfig(config);
  const stateDir = stateDirOf(repo, worktreeConfig);
  const prefixes = Object.values(worktreeConfig.tools || {}).map((tool) => tool.prefix).filter(Boolean);
  // The same sanctioned primary-lock bypass the kit's finish and reclaim use for their own verified
  // removals; it is only ever passed to the removal commands below, after every gate has passed.
  const removalEnv = { ...process.env, [worktreeConfig.envVars.primaryLockBypass]: worktreeConfig.primaryLockBypassToken };
  let liveCwds = null;
  try {
    liveCwds = getLiveProcessCwds({});
  } catch {
    liveCwds = null;
  }
  const items = ledger && existsSync(ledger) ? parseItems(readFileSync(ledger, 'utf8')).rows : [];
  return { remote, repo, items, stateDir, prefixes, removalEnv, liveCwds, livePaths: livePathsFromFinishQueue(stateDir), currentPath: process.cwd() };
}

export function checkRegistry({ ledger, registry, remote = 'origin', cwd = process.cwd(), ...options }) {
  const path = registryPathFor(ledger, registry);
  const rows = readRegistry(path);
  const ctx = checkContext(cwd, { remote, ledger: resolve(ledger), ...options });
  const branches = liveBranches(rows).map((row) => assessBranch(cwd, row, ctx));
  const sessions = childSessions(ctx.items, rows);
  const actionable = branches.filter((b) => ACTIONABLE.has(b.state)).length + sessions.filter((s) => s.action === 'archive').length;
  return { registry: path, total: new Set(rows.map((row) => row.branch)).size, branches, sessions, actionable };
}

// heartbeat-sweep's view: one candidate per branch or child session this wake has to act on.
export function discoverBranchRegistry(cwd, ledgerPath, options = {}) {
  const registry = registryPathFor(ledgerPath, options.registry);
  if (!existsSync(registry)) return { candidates: [], notes: [] };
  let result;
  try {
    result = inDirectory(cwd, () => checkRegistry({ ledger: ledgerPath, cwd, ...options }));
  } catch (error) {
    return { candidates: [], notes: [`branches: registry check failed (${String(error.message).split('\n')[0]})`] };
  }
  const command = `heartbeat-branches.mjs clean --ledger ${ledgerPath} --branch`;
  const candidates = [];
  for (const b of result.branches.filter((entry) => ACTIONABLE.has(entry.state))) {
    candidates.push({
      source: `sweep:branches:${b.branch.replace(/[^\w./-]/g, '_')}`,
      item: b.state === 'land-pending'
        ? `land ${b.branch} onto ${b.base} (its item is done, the work is not on the base), then clean it`
        : `clean ${b.state} registered branch ${b.branch}${b.worktree ? ` and worktree ${b.worktree}` : ''}`,
      evidence: b.state === 'land-pending' ? b.reasons.join('; ') : `\`${command} ${b.branch}\` is the dry run; re-run with --apply (${b.reasons.join('; ')})`,
    });
  }
  for (const s of result.sessions.filter((entry) => entry.action === 'archive')) {
    candidates.push({
      source: `sweep:child-session:${s.id}`,
      item: `archive finished child session session:${s.id} (${s.item}) after confirming its work landed`,
      evidence: `item ${s.item} is done but its evidence never records the archive`,
    });
  }
  const polls = result.sessions.filter((entry) => entry.action === 'poll').map((entry) => `session:${entry.id}`);
  const notes = [`branches: ${result.branches.length} live of ${result.total} registered (${result.registry})`];
  if (polls.length > 0) notes.push(`child sessions to poll this wake: ${polls.join(', ')}`);
  return { candidates, notes };
}

function inDirectory(dir, fn) {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(original);
  }
}

export function formatCheck(result, { ledger, script = 'heartbeat-branches.mjs' } = {}) {
  const lines = [`registry: ${result.registry} (${result.branches.length} live of ${result.total} registered)`];
  for (const b of result.branches) {
    lines.push(`  ${b.state.padEnd(12)} ${b.branch} -> ${b.base || '-'} [owner ${b.owner || '-'}${b.item ? `, ${b.item}` : ''}] ${b.reasons.join('; ')}`);
    if (b.state === 'cleanable' || b.state === 'gone') lines.push(`               next: ${script} clean --ledger ${ledger} --branch ${b.branch} --apply`);
  }
  if (result.sessions.length > 0) {
    lines.push('child-sessions:');
    for (const s of result.sessions) {
      lines.push(s.action === 'poll'
        ? `  poll    session:${s.id} (${s.item}) -- check its state this wake; finished: verify its work landed, then archive it`
        : `  archive session:${s.id} (${s.item}) -- item is done but its evidence never records the archive`);
    }
  }
  lines.push(`summary: ${result.actionable} to act on · ${result.branches.filter((b) => b.state === 'in-progress').length} in progress · ${result.sessions.filter((s) => s.action === 'poll').length} child session(s) to poll`);
  return lines.join('\n');
}

export function recordBranch({ ledger, registry, branch, base, owner, worktree = '', item = '', note = '', remote = 'origin', cwd = process.cwd(), now = new Date() }) {
  if (git(['check-ref-format', '--branch', branch], cwd, { retry: false }).status !== 0) throw new UsageError(`"${branch}" is not a valid branch name`);
  if (isProtectedBranch(branch, base)) throw new UsageError(`${branch} is a protected shared branch; register only the branches workers create`);
  const path = registryPathFor(ledger, registry);
  const live = liveBranches(readRegistry(path)).find((row) => row.branch === branch);
  if (live) return { path, recorded: false, message: `${branch} is already registered (line ${live.line})` };
  const start = refSha(cwd, `refs/heads/${branch}`) || refSha(cwd, `refs/remotes/${remote}/${branch}`);
  appendRow(path, { event: 'created', branch, base, start, owner, worktree: worktree ? resolve(cwd, worktree) : '', item, note }, now);
  return { path, recorded: true, message: `registered ${branch} -> ${base} (owner ${owner})` };
}

function freshen(repoDir, row, remote) {
  git(['fetch', '--quiet', remote, `+refs/heads/${row.base}:refs/remotes/${remote}/${row.base}`], repoDir, { retry: false });
  const listed = git(['ls-remote', '--heads', remote, `refs/heads/${row.branch}`], repoDir, { retry: false });
  if (listed.status !== 0) throw new Error(`cannot ask ${remote} for ${row.branch}: ${listed.stderr || listed.stdout}`);
  const remoteSha = listed.stdout.split(/\s+/)[0] || '';
  if (remoteSha) git(['fetch', '--quiet', remote, `+refs/heads/${row.branch}:refs/remotes/${remote}/${row.branch}`], repoDir, { retry: false });
  else if (refSha(repoDir, `refs/remotes/${remote}/${row.branch}`)) git(['update-ref', '-d', `refs/remotes/${remote}/${row.branch}`], repoDir, { retry: false });
  return remoteSha;
}

export function cleanBranch({ ledger, registry, branch, remote = 'origin', apply = false, cwd = process.cwd(), ...options }) {
  const path = registryPathFor(ledger, registry);
  const row = liveBranches(readRegistry(path)).find((r) => r.branch === branch);
  if (!row) return { ok: false, log: [`refused: ${branch} has no live row in ${path}; only branches this session registered are cleaned`] };
  const log = [];
  let ctx = checkContext(cwd, { remote, ledger: resolve(ledger), ...options });
  if (apply) {
    if (finishLockIsLive(ctx.stateDir)) return { ok: false, log: ['refused: a worktree finish is in flight (live finish lock); retry next wake'] };
    try {
      freshen(cwd, row, remote);
    } catch (error) {
      return { ok: false, log: [`refused: ${error.message}`] };
    }
    ctx = checkContext(cwd, { remote, ledger: resolve(ledger), ...options });
  }
  const verdict = assessBranch(cwd, row, ctx);
  if (verdict.state !== 'cleanable' && verdict.state !== 'gone') {
    return { ok: false, log: [`refused: ${branch} is ${verdict.state}: ${verdict.reasons.join('; ')}`] };
  }
  const plan = [
    verdict.worktree && `remove worktree ${verdict.worktree}`,
    verdict.remote && `delete ${remote}/${branch} (lease ${short(verdict.remote)})`,
    verdict.local && `delete local ${branch} (expect ${short(verdict.local)})`,
    `append a cleaned row to ${path}`,
  ].filter(Boolean);
  if (!apply) return { ok: true, log: [`dry run (${verdict.state}, ${verdict.reasons.join('; ')}); --apply would:`, ...plan.map((step) => `  ${step}`)] };

  const primaryPath = ctx.repo.primaryWorktree?.path || ctx.repo.topLevel;
  if (verdict.worktree) {
    let proof;
    try {
      proof = assertKitSafeToRemove({ projectRoot: verdict.worktree });
    } catch (error) {
      return { ok: false, log: [`refused: kit removal proof failed for ${verdict.worktree}: ${error.message}`] };
    }
    process.chdir(primaryPath);
    makeOwnedTreeWritable(verdict.worktree);
    const removed = git(['worktree', 'remove', ...(proof.applicable ? ['--force'] : []), verdict.worktree], primaryPath, { retry: false, env: ctx.removalEnv });
    if (removed.status !== 0) return { ok: false, log: [`stopped: git worktree remove ${verdict.worktree} failed: ${removed.stderr || removed.stdout}`] };
    log.push(`removed worktree ${verdict.worktree}`);
  }
  if (verdict.remote) {
    const pushed = git(['push', `--force-with-lease=refs/heads/${branch}:${verdict.remote}`, remote, `:refs/heads/${branch}`], primaryPath, { retry: false });
    if (pushed.status !== 0) return { ok: false, log: [...log, `stopped: deleting ${remote}/${branch} failed (it may have moved): ${pushed.stderr || pushed.stdout}`] };
    log.push(`deleted ${remote}/${branch} (was ${short(verdict.remote)})`);
  }
  if (verdict.local) {
    const deleted = git(['update-ref', '-d', `refs/heads/${branch}`, verdict.local], primaryPath, { retry: false, env: ctx.removalEnv });
    if (deleted.status !== 0) return { ok: false, log: [...log, `stopped: deleting local ${branch} failed (it may have moved): ${deleted.stderr || deleted.stdout}`] };
    git(['config', '--remove-section', `branch.${branch}`], primaryPath, { retry: false, env: ctx.removalEnv });
    log.push(`deleted local ${branch} (was ${short(verdict.local)})`);
  }
  const removedWhat = log.length > 0 ? log.join('; ') : 'nothing was left';
  appendRow(path, { event: 'cleaned', branch, base: row.base, start: row.start, owner: row.owner, worktree: verdict.worktree || row.worktree, item: row.item, note: `${removedWhat}; ${verdict.reasons.join('; ')}` });
  log.push(`recorded ${branch} as cleaned in ${path}`);
  return { ok: true, log };
}

const VALUED = { '--ledger': 'ledger', '--registry': 'registry', '--branch': 'branch', '--base': 'base', '--owner': 'owner', '--worktree': 'worktree', '--item': 'item', '--note': 'note', '--remote': 'remote', '--config': 'config' };
const FLAGS = { '--apply': 'apply', '--json': 'json' };

export function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const command = args.shift();
  if (!['record', 'check', 'clean'].includes(command)) throw new UsageError(`first argument must be record, check or clean (got "${command ?? ''}")`);
  const opts = { command, remote: 'origin', apply: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    if (FLAGS[args[i]]) {
      opts[FLAGS[args[i]]] = true;
      continue;
    }
    const key = VALUED[args[i]];
    const next = args[i + 1];
    if (!key) throw new UsageError(`unknown argument "${args[i]}"`);
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${args[i]} needs a value`);
    opts[key] = next;
    i += 1;
  }
  const required = { record: ['ledger', 'branch', 'base', 'owner'], check: ['ledger'], clean: ['ledger', 'branch'] }[command];
  for (const name of required) if (!opts[name]) throw new UsageError(`${command} needs --${name}`);
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.command === 'record') {
      const result = recordBranch(opts);
      process.stdout.write(`heartbeat-branches: ${result.message} (${result.path})\n`);
      exitDrained(0);
    } else if (opts.command === 'check') {
      const result = checkRegistry(opts);
      process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCheck(result, { ledger: opts.ledger })}\n`);
      exitDrained(result.actionable > 0 ? 1 : 0);
    } else {
      const result = cleanBranch(opts);
      process.stdout.write(`${result.log.map((line) => `heartbeat-branches: ${line}`).join('\n')}\n`);
      exitDrained(result.ok ? 0 : 1);
    }
  } catch (error) {
    process.stderr.write(`heartbeat-branches: ${error.message}\n`);
    if (error instanceof UsageError || !opts) process.stderr.write('usage: heartbeat-branches.mjs <record|check|clean> --ledger <ledger> [--branch <name>] [--base <branch>] [--owner <id>] [--apply] [--json]\n');
    exitDrained(2);
  }
}

if (isMainModule(import.meta.url)) main();
