// Tests for heartbeat-sweep against real throwaway repos: a bare "remote", a primary clone, and
// worktrees made by the kit's own `create` command with ages faked via utimes. No git mocks.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from '../support/isolated-git-env.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { main as worktreeCli } from '../../src/worktrees/cli.mjs';
import { discoverRepo } from '../../src/worktrees/worktree-core.mjs';
import { checkItems, parseItems } from '../../src/supervision/check-heartbeat-ledger.mjs';
import { parseArgs, sweep as runSweep } from '../../src/supervision/heartbeat-sweep.mjs';
import { discoverWorktrees } from '../../src/supervision/heartbeat-sweep-worktrees.mjs';
import { ageWorktreeReflogs } from '../support/worktree-age.mjs';

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'src', 'supervision', 'heartbeat-sweep.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_ENV = isolatedFixtureGitEnv();

function git(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempTracked('hb-sweep-');
  const remote = join(root, 'remote.git');
  const primary = join(root, 'primary');
  git(['init', '--bare', '--initial-branch=main', remote], root);
  git(['clone', '--shared', remote, primary], root);
  writeFileSync(join(primary, 'README.md'), '# fixture\n');
  git(['add', '-A'], primary);
  git(['commit', '-m', 'initial commit'], primary);
  git(['push', 'origin', 'HEAD:refs/heads/main'], primary);
  git(['branch', '--set-upstream-to=origin/main', 'main'], primary);
  git(['remote', 'set-head', 'origin', 'main'], primary);
  return { root, remote, primary, worktreeRoot: join(root, 'worktrees'), ledger: join(root, 'heartbeat.md') };
}

// Commit on main in the primary and push, so origin/main moves like a real landing.
function land(fx, name) {
  writeFileSync(join(fx.primary, `${name}.txt`), `${name}\n`);
  git(['add', '-A'], fx.primary);
  git(['commit', '-m', `land ${name}`], fx.primary);
  git(['push', 'origin', 'HEAD:refs/heads/main'], fx.primary);
  return git(['rev-parse', 'HEAD'], fx.primary);
}

const ITEMS_HEAD = ['## Items', '', '| id | source | item | status | evidence |', '| --- | --- | --- | --- | --- |'];
function writeLedger(fx, ...rows) {
  writeFileSync(fx.ledger, `${[...ITEMS_HEAD, ...rows].join('\n')}\n`);
}

function sweep(fx, args = [], { env = {}, cwd = fx.primary } = {}) {
  const result = spawnSync(process.execPath, [CLI, '--ledger', fx.ledger, ...args], { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } });
  const rows = result.stdout.split('\n').filter(Boolean);
  return { status: result.status, rows, cells: rows.map(cells), stderr: result.stderr };
}

function cells(line) {
  const [id, source, item, status, ...evidence] = line.slice(1, -1).split('|').map((cell) => cell.trim());
  return { id, source, item, status, evidence: evidence.join(' | ') };
}

const sources = (out) => out.cells.map((row) => row.source);

// ---- worktree fixtures -----------------------------------------------------------------------

async function createWorktree(fx, name, tool = 'claude') {
  const original = process.cwd();
  process.chdir(fx.primary);
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await worktreeCli(['create', '--name', name, '--tool', tool, '--worktree-root', fx.worktreeRoot]), 0);
  } finally {
    console.log = log;
    process.chdir(original);
  }
  const entry = discoverRepo(fx.primary).worktrees.find((w) => w.branch === `${tool}/${name}`);
  assert.ok(entry, `expected ${tool}/${name} worktree`);
  return entry.path;
}

function commitIn(path, name) {
  writeFileSync(join(path, `${name}.txt`), `${name}\n`);
  git(['add', '-A'], path);
  git(['commit', '-m', `work ${name}`], path);
  return git(['rev-parse', 'HEAD'], path);
}

function landByCherryPick(fx, sha, sourceWorktree) {
  fx.landingSequence = (fx.landingSequence ?? 0) + 1;
  const landing = join(fx.root, `landing-${fx.landingSequence}`);
  git(['clone', '--shared', sourceWorktree, landing], fx.root);
  git(['remote', 'set-url', 'origin', fx.remote], landing);
  git(['fetch', 'origin', 'main'], landing);
  git(['checkout', '--detach', 'FETCH_HEAD'], landing);
  git(['cherry-pick', sha], landing);
  git(['push', 'origin', 'HEAD:refs/heads/main'], landing);
  // Updating origin/main is a permitted remote-tracking ref change on primary.
  git(['fetch', 'origin', 'main'], fx.primary);
}

test('createWorktree fixture pins the requested tool prefix', async () => {
  const fx = makeRepo();
  const claudePath = await createWorktree(fx, 'fixture-claude');
  const codexPath = await createWorktree(fx, 'fixture-codex', 'codex');
  const branches = discoverRepo(fx.primary).worktrees.map((worktree) => worktree.branch);
  assert.ok(branches.includes('claude/fixture-claude'));
  assert.ok(branches.includes('codex/fixture-codex'));
  assert.ok(existsSync(claudePath));
  assert.ok(existsSync(codexPath));
});

function setTreeTimes(path, ms) {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) setTreeTimes(join(path, name), ms);
  const when = new Date(ms);
  utimesSync(path, when, when);
}

function age(path, days) {
  const ms = Date.now() - days * DAY_MS;
  ageWorktreeReflogs(path, ms);
  const admin = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'))[1].trim();
  setTreeTimes(admin, ms);
  setTreeTimes(path, ms);
}

// ---- landings --------------------------------------------------------------------------------

test('landings: an unreviewed range on the default base is one candidate row, and the printed row obeys the registry rules', () => {
  const fx = makeRepo();
  const first = land(fx, 'a');
  land(fx, 'b');
  const last = land(fx, 'c');
  writeLedger(fx);

  const out = sweep(fx);
  assert.equal(out.status, 1, out.stderr);
  const landings = out.cells.filter((row) => row.source.startsWith('landing:'));
  assert.equal(landings.length, 1, 'contiguous commits group into one range');
  assert.equal(landings[0].source, `landing:${git(['rev-list', '--max-parents=0', 'HEAD'], fx.primary).slice(0, 10)}..${last.slice(0, 10)}`);
  assert.match(landings[0].item, /origin\/main/);
  assert.match(landings[0].evidence, /git log --oneline/);
  assert.equal(landings[0].status, 'ready');
  assert.ok(first);

  // Ingest the printed rows into the registry: the checker's own parser reads them back, and with
  // the status moved off `ready` the registry is green.
  const text = `${ITEMS_HEAD.join('\n')}\n${out.rows.join('\n')}\n`;
  const { rows } = parseItems(text);
  assert.deepEqual(rows.map((row) => row.status), out.cells.map(() => 'ready'));
  assert.deepEqual(checkItems(text).map((finding) => finding.rule), out.rows.map(() => 'item-ready'));
  assert.deepEqual(checkItems(text.replaceAll('| ready |', '| dispatched w1 |')), []);
});

test('landings: a range already named by a landing: item, in any status, is not proposed again', () => {
  const fx = makeRepo();
  land(fx, 'a');
  land(fx, 'b');
  writeLedger(fx);
  const first = sweep(fx).cells.find((row) => row.source.startsWith('landing:'));
  assert.ok(first);
  writeLedger(fx, `| I-1 | ${first.source} | reviewed | done | \`git log --oneline\` clean |`);
  assert.deepEqual(sweep(fx).cells.filter((row) => row.source.startsWith('landing:')), []);
  writeLedger(fx, `| I-1 | ${first.source} | reviewing | dispatched w1 | - |`);
  assert.deepEqual(sweep(fx).cells.filter((row) => row.source.startsWith('landing:')), []);
});

test('landings: only the commits after the nearest done landing are listed', () => {
  const fx = makeRepo();
  const a = land(fx, 'a');
  const b = land(fx, 'b');
  const c = land(fx, 'c');
  writeLedger(
    fx,
    `| I-1 | landing:${a.slice(0, 10)} | old review | done | \`x\` |`,
    `| I-2 | landing:${b.slice(0, 10)} | newer review | done | \`y\` |`,
  );
  const out = sweep(fx);
  assert.equal(out.status, 1);
  assert.deepEqual(sources(out), [`landing:${c.slice(0, 10)}`]);
});

test('landings: a covered commit splits the list; rows are capped and the overflow is summarised as a row', () => {
  const fx = makeRepo();
  const initial = git(['rev-parse', 'HEAD'], fx.primary);
  const shas = ['a', 'b', 'c', 'd', 'e'].map((name) => land(fx, name));
  writeLedger(
    fx,
    `| I-1 | landing:${initial.slice(0, 10)} | seed | done | \`x\` |`,
    `| I-2 | landing:${shas[1].slice(0, 10)} | b | dispatched w1 | - |`,
    `| I-3 | landing:${shas[3].slice(0, 10)} | d | dispatched w2 | - |`,
  );
  const all = sweep(fx);
  assert.deepEqual(sources(all), [shas[0], shas[2], shas[4]].map((sha) => `landing:${sha.slice(0, 10)}`));

  const capped = sweep(fx, ['--max-rows', '2']);
  assert.equal(capped.cells.length, 3);
  assert.deepEqual(sources(capped).slice(0, 2), [shas[0], shas[2]].map((sha) => `landing:${sha.slice(0, 10)}`));
  assert.match(capped.cells[2].source, /^sweep:landings-overflow:/);
  assert.match(capped.cells[2].item, /^1 more uncovered landing range/);
});

test('landings: repeated --base tracks several branches, and an unknown base is a note, not a crash', () => {
  const fx = makeRepo();
  git(['checkout', '-b', 'develop'], fx.primary);
  writeFileSync(join(fx.primary, 'dev-only.txt'), 'dev\n');
  git(['add', '-A'], fx.primary);
  git(['commit', '-m', 'land dev-only'], fx.primary);
  const dev = git(['rev-parse', 'HEAD'], fx.primary);
  git(['push', 'origin', 'develop'], fx.primary);
  git(['checkout', 'main'], fx.primary);
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'main'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);

  const out = sweep(fx, ['--base', 'origin/main', '--base', 'origin/develop', '--base', 'origin/nope']);
  assert.deepEqual(sources(out), [`landing:${dev.slice(0, 10)}`]);
  assert.match(out.cells[0].item, /origin\/develop/);
  assert.match(out.stderr, /origin\/nope does not resolve/);
});

test('landings: a commit reachable from two tracked bases is proposed once', () => {
  const fx = makeRepo();
  land(fx, 'a');
  writeLedger(fx);
  const out = sweep(fx, ['--base', 'origin/main', '--base', 'main']);
  assert.equal(out.cells.filter((row) => row.source.startsWith('landing:')).length, 1);
});

// ---- worktrees -------------------------------------------------------------------------------

test('worktrees: only a landed, clean, idle, process-free tree is proposed, with the exact reclaim command', async () => {
  const fx = makeRepo();

  const reclaimable = await createWorktree(fx, 'reclaimable');
  landByCherryPick(fx, commitIn(reclaimable, 'reclaimable'), reclaimable);
  age(reclaimable, 30);

  const recent = await createWorktree(fx, 'recent');
  landByCherryPick(fx, commitIn(recent, 'recent'), recent);
  age(recent, 30);
  utimesSync(join(recent, 'recent.txt'), new Date(), new Date());

  const dirty = await createWorktree(fx, 'dirty');
  landByCherryPick(fx, commitIn(dirty, 'dirty'), dirty);
  writeFileSync(join(dirty, 'scratch.txt'), 'uncommitted\n');
  age(dirty, 30);

  const unlanded = await createWorktree(fx, 'unlanded');
  commitIn(unlanded, 'unlanded');
  age(unlanded, 30);

  const busy = await createWorktree(fx, 'busy');
  landByCherryPick(fx, commitIn(busy, 'busy'), busy);
  age(busy, 30);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: busy, stdio: 'ignore' });

  try {
    writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);
    const out = sweep(fx, ['--worktree-root', fx.worktreeRoot, '--stale-days', '14']);
    assert.equal(out.status, 1, out.stderr);
    const worktrees = out.cells.filter((row) => row.source.startsWith('sweep:worktrees:'));
    assert.deepEqual(worktrees.map((row) => row.source), ['sweep:worktrees:claude/reclaimable']);
    assert.ok(worktrees[0].item.includes(reclaimable));
    assert.ok(worktrees[0].evidence.includes(`pnpm worktree:cleanup -- --reclaim-stale --stale-days 14 --worktree-root ${fx.worktreeRoot}`));
    assert.ok(!worktrees[0].evidence.includes('--apply`'), 'the proposed command is the dry run');
    assert.ok(existsSync(reclaimable), 'the sweep never removes anything');
  } finally {
    holder.kill();
  }
});

test('worktrees: a tracked worktree row suppresses its candidate until the row is done', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'old');
  landByCherryPick(fx, commitIn(path, 'old'), path);
  age(path, 30);
  const args = ['--worktree-root', fx.worktreeRoot, '--stale-days', '14', '--base', 'origin/nope'];

  writeLedger(fx, '| I-1 | sweep:worktrees:claude/old | reclaim | dispatched w1 | - |');
  assert.deepEqual(sweep(fx, args).rows, []);
  writeLedger(fx, '| I-1 | sweep:worktrees:claude/old | reclaim | done | `x` |');
  assert.deepEqual(sources(sweep(fx, args)), ['sweep:worktrees:claude/old']);
});

test('worktrees: Windows unknown cwd records use the directory safety probe', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'unknown-cwd');
  landByCherryPick(fx, commitIn(path, 'unknown-cwd'), path);
  age(path, 30);

  const liveCwds = new Set();
  Object.defineProperty(liveCwds, 'unknownPids', { value: [42] });
  const probed = [];
  const result = discoverWorktrees(fx.primary, {
    staleDays: 14,
    worktreeRoot: fx.worktreeRoot,
    platform: 'win32',
    getLiveProcessCwds: () => liveCwds,
    probeDirectoryDeleteSafety: (candidate, options) => {
      probed.push({ candidate, options });
      return { safe: true, reason: 'safe', checked: 1 };
    },
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['sweep:worktrees:claude/unknown-cwd']);
  assert.deepEqual(probed, [{ candidate: path, options: { platform: 'win32' } }]);
});

test('worktrees: process inventory failure suppresses reclaim rows but preserves other sweep results', async () => {
  const fx = makeRepo();
  const path = await createWorktree(fx, 'inventory-failure');
  landByCherryPick(fx, commitIn(path, 'independent-landing'), path);
  writeLedger(fx);

  const result = await runSweep(parseArgs(['--ledger', fx.ledger]), {
    cwd: fx.primary,
    worktreeOptions: {
      platform: 'win32',
      getLiveProcessCwds() { throw new Error('PowerShell CIM unavailable'); },
    },
  });

  assert.ok(result.lines.some((line) => line.includes('landing:')));
  assert.ok(!result.lines.some((line) => line.includes('sweep:worktrees:')));
  assert.ok(result.notes.some((note) => /process CWD inventory failed \(PowerShell CIM unavailable\).*suppressing worktree reclaim suggestions/.test(note)));
});

test('worktrees: a spent time budget stops the pass after the oldest tree and says how many were left', async () => {
  const fx = makeRepo();
  const oldest = await createWorktree(fx, 'oldest');
  landByCherryPick(fx, commitIn(oldest, 'oldest'), oldest);
  age(oldest, 40);
  const newer = await createWorktree(fx, 'newer');
  landByCherryPick(fx, commitIn(newer, 'newer'), newer);
  age(newer, 30);
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'origin/main'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);

  const out = sweep(fx, ['--worktree-root', fx.worktreeRoot, '--stale-days', '14'], { env: { HEARTBEAT_SWEEP_WORKTREE_BUDGET_MS: '0' } });
  assert.equal(out.status, 1, out.stderr);
  assert.deepEqual(sources(out), ['sweep:worktrees:claude/oldest']);
  assert.match(out.stderr, /assessed 1 of 2 within the time budget/);
});

// ---- registry hygiene ------------------------------------------------------------------------

test('registry: a row outside the table and a duplicate id each become a candidate', () => {
  const fx = makeRepo();
  const seed = `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`;
  writeFileSync(fx.ledger, `${[...ITEMS_HEAD, seed, '| I-1 | memory:notes | twin | dispatched w1 | - |'].join('\n')}\n\n## later\n\n| I-9 | report:w1 | stranded | dispatched w2 | - |\n`);
  const out = sweep(fx);
  assert.equal(out.status, 1);
  assert.deepEqual(sources(out).sort(), ['sweep:registry:duplicate-id-I-1', 'sweep:registry:outside-table-line-10']);
  assert.deepEqual(out.cells.map((row) => row.id), ['I-2', 'I-3'], 'new ids continue the registry numbering');
});

// ---- exit codes, offline behaviour -----------------------------------------------------------

test('exit codes: 0 when nothing is left, 1 for a candidate, 2 for usage errors', () => {
  const fx = makeRepo();
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);
  const clean = sweep(fx, ['--worktree-root', fx.worktreeRoot]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.rows, []);

  land(fx, 'new');
  assert.equal(sweep(fx).status, 1);

  for (const args of [['--bogus'], ['--stale-days', '0'], ['--stale-days', 'abc'], ['--max-rows', '0'], ['--base']]) {
    assert.equal(sweep(fx, args).status, 2, JSON.stringify(args));
  }
  const noLedger = spawnSync(process.execPath, [CLI], { cwd: fx.primary, encoding: 'utf8', env: GIT_ENV });
  assert.equal(noLedger.status, 2);
  const missing = spawnSync(process.execPath, [CLI, '--ledger', join(fx.root, 'nope.md')], { cwd: fx.primary, encoding: 'utf8', env: GIT_ENV });
  assert.equal(missing.status, 2);
});

test('a ledger without an Items table still sweeps', () => {
  const fx = makeRepo();
  writeFileSync(fx.ledger, '# notes\n');
  const out = sweep(fx);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no "## Items" table yet/);
});

test('offline: no network git command is ever spawned, even with an unreachable remote', async () => {
  const fx = makeRepo();
  land(fx, 'a');
  const path = await createWorktree(fx, 'offline');
  landByCherryPick(fx, commitIn(path, 'offline'), path);
  age(path, 30);
  git(['remote', 'set-url', 'origin', join(fx.root, 'does-not-exist.git')], fx.primary);
  writeLedger(fx);

  const trace = join(fx.root, 'git-trace.jsonl');
  const out = sweep(fx, ['--worktree-root', fx.worktreeRoot, '--stale-days', '14'], { env: { GIT_TRACE2_EVENT: trace } });
  assert.equal(out.status, 1, out.stderr);
  assert.ok(out.cells.some((row) => row.source.startsWith('sweep:worktrees:')), 'the worktree is still found offline');
  const events = readFileSync(trace, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const starts = events.filter((event) => event.event === 'start' && Array.isArray(event.argv));
  assert.ok(starts.length > 0, 'Git Trace2 observed the sweep run git');
  const gitCommand = (argv) => {
    const args = argv[0] === 'git' ? argv.slice(1) : argv;
    let index = 0;
    const withValue = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
    while (index < args.length) {
      if (withValue.has(args[index])) { index += 2; continue; }
      if (args[index].startsWith('-')) { index += 1; continue; }
      break;
    }
    return args.slice(index, index + 2).join(' ');
  };
  const networkCommands = starts.map(({ argv }) => gitCommand(argv))
    .filter((command) => /^(fetch|pull|push|clone|ls-remote|remote update)\b/.test(command));
  assert.deepEqual(networkCommands, []);
});

// ---- free candidates -------------------------------------------------------------------------

test('free candidates: a landing-resource block is listed, exits 1, and the summary line goes to stderr', () => {
  const fx = makeRepo();
  writeLedger(fx, '| I-1 | report:X | ship the guard fix | blocked ← preflight slots are taken, landing queued | e |');
  const result = spawnSync(process.execPath, [CLI, '--ledger', fx.ledger, '--base', 'origin/main'], { cwd: fx.primary, encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /free-candidates:[^\n]*\n {2}- I-1 \[landing-resource\] .*first step: ship the guard fix/);
  assert.match(result.stderr, /in-flight 0 · free-undispatched 1 · blocked 0 \(owner\/time 0\)/);
});

test('free candidates: only genuinely blocked rows keep exit 0 and print no free section', () => {
  const fx = makeRepo();
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`, '| I-2 | report:X | publish | blocked ← Owner naming and purple OTP | e |');
  const result = spawnSync(process.execPath, [CLI, '--ledger', fx.ledger, '--base', 'origin/main'], { cwd: fx.primary, encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /free-candidates:/);
  assert.match(result.stderr, /in-flight 0 · free-undispatched 0 · blocked 1 \(owner\/time 1\)/);
});

// ---- probes ----------------------------------------------------------------------------------

test('probes: a JSON list and an ES module both add candidates; foreign sources are namespaced; tracked ones are suppressed', () => {
  const fx = makeRepo();
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);
  const json = join(fx.root, 'probes.json');
  writeFileSync(json, JSON.stringify([
    { source: 'sweep:deployed-drift:staging', item: 'staging runs an older version | than main', evidence: '`curl -s https://staging.example.test/health`' },
    { source: 'external ticket 7', item: 'ticket 7 is open', evidence: 'tracker query' },
  ]));
  const viaJson = sweep(fx, ['--probes', json, '--worktree-root', fx.worktreeRoot]);
  assert.equal(viaJson.status, 1);
  assert.deepEqual(sources(viaJson), ['sweep:deployed-drift:staging', 'sweep:probe:external_ticket_7']);
  assert.ok(!viaJson.cells[0].item.includes('|'), 'pipes inside a cell are neutralised');

  const mod = join(fx.root, 'probes.mjs');
  writeFileSync(mod, "export default async (ctx) => [{ source: 'sweep:backlog', item: `rows seen: ${ctx.rows.length}`, evidence: 'example probe' }];\n");
  const viaModule = sweep(fx, ['--probes', mod, '--worktree-root', fx.worktreeRoot]);
  assert.deepEqual(viaModule.cells.map((row) => [row.source, row.item]), [['sweep:backlog', 'rows seen: 1']]);

  writeLedger(fx, '| I-1 | sweep:backlog | tracked | dispatched w1 | - |');
  assert.equal(sweep(fx, ['--probes', mod, '--worktree-root', fx.worktreeRoot, '--base', 'origin/nope']).status, 0);
  const viaEnv = sweep(fx, ['--worktree-root', fx.worktreeRoot], { env: { HEARTBEAT_SWEEP_PROBES: json } });
  assert.equal(viaEnv.status, 1);
});

test('probes: a throwing module becomes a visible candidate, an unreadable probes file is a usage error', () => {
  const fx = makeRepo();
  writeLedger(fx, `| I-1 | landing:${git(['rev-parse', 'HEAD'], fx.primary).slice(0, 10)} | seed | done | \`x\` |`);
  const broken = join(fx.root, 'broken.mjs');
  writeFileSync(broken, "export default () => { throw new Error('tracker is down'); };\n");
  const out = sweep(fx, ['--probes', broken, '--worktree-root', fx.worktreeRoot]);
  assert.equal(out.status, 1);
  assert.equal(out.cells[0].source, 'sweep:probe-error');
  assert.match(out.cells[0].item, /tracker is down/);
  assert.equal(sweep(fx, ['--probes', join(fx.root, 'missing.json')]).status, 2);
});
