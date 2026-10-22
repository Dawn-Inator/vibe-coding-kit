#!/usr/bin/env node
// `pnpm heartbeat:arm` -- the single entry point for arming a long-task heartbeat timer.
//
// Run it through your AI tool's background shell facility (Claude Code: Bash with
// `run_in_background: true`). It sleeps for the interval, prints the audit checklist, and exits;
// that completion notification is what wakes the orchestrating session. One-shot: every wake
// re-arms the next timer FIRST, then audits, so an interrupted audit cannot break the chain.
//
// Why a script instead of a hand-typed `sleep 1200; echo HEARTBEAT`: a hand-typed timer carries no
// checklist, no ledger path and no status-line format, so sessions drift into long chat essays and
// never write the ledger. Printing the checklist on EVERY wake keeps the audit in front of the model,
// and the PreToolUse guard (heartbeat-arm-guard.mjs) forces the supervision skill to be read before
// the first arming.
//
// Ledger gate: every real arming appends one line to `heartbeat.arms`, a file NEXT TO the ledger that
// only this script writes. Arming number k+1 is refused (exit 3) unless the ledger holds at least k-1
// `## <time> wake (10-row ledger)` sections -- every wake before the current one wrote its block.
// Because the order is "re-arm first, then audit", the gate lags one cycle by design. The counter is a
// separate append-only file so that a script which rewrites the whole ledger cannot erase it.
//
// Usage:
//   pnpm heartbeat:arm -- --probe                                   # 75 s delivery probe, no ledger
//   pnpm heartbeat:arm -- --ledger .workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md   # 20 min
//   pnpm heartbeat:arm -- --ledger <path> --minutes 15
//   pnpm heartbeat:arm -- --ledger <path> --seconds 90              # tests
//
// Keep-awake: on macOS a sleeping machine freezes `sleep`, so an overnight chain silently stalls. While a
// real timer sleeps, a detached `caffeinate -i -w <pid>` holds an idle-sleep assertion that ends with
// this process. Any other platform, a missing `caffeinate` or a spawn error is a silent no-op;
// HEARTBEAT_KEEP_AWAKE=0 turns it off.
//
// Ledger path pattern: DEFAULT_LEDGER_PATH_RE below; override with env HEARTBEAT_LEDGER_RE (a
// regular-expression source string) if your project keeps session scratch elsewhere.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, countWakeSections } from './check-heartbeat-ledger.mjs';
import { exitDrained } from '../lib/exit-drained.mjs';

// Realpath on both sides: Node resolves symlinks in import.meta.url, argv[1] keeps the caller's spelling (starter kit is copied into
// other repos, so this is an inline copy of the shared helper rather than an import).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

export const DEFAULT_INTERVAL_MINUTES = 20;
export const PROBE_SECONDS = 75;
// `.workspace/<category>/<yyyy-mm-dd>-<topic-slug>/heartbeat.md`: one optional lowercase category
// directory (e.g. `task/`) above the session; a root-level session directory is still accepted.
export const DEFAULT_LEDGER_PATH_RE =
  /(^|\/)\.workspace\/(?:[a-z0-9][a-z0-9-]*\/)?\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\/heartbeat\.md$/;
export const LEDGER_PATH_EXAMPLE = '.workspace/task/<yyyy-mm-dd>-<topic-slug>/heartbeat.md';
// The one chat line a wake may print. Detail goes into the ledger, never into chat.
export const STATUS_LINE_FORMAT = '[heartbeat] in-flight N · xx% · splittable: D/P · blocked: <none|item>';
// The per-wake `sources:` line, in the supervision skill's token form. `<timestamp>` is left for the
// model to fill with the time the external backlog was really read, so an unfilled block stays red.
export const SOURCES_TEMPLATE =
  'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ <timestamp>) worker-health(✓)';

export function resolveLedgerRe(env = process.env) {
  const source = env.HEARTBEAT_LEDGER_RE;
  if (!source) return DEFAULT_LEDGER_PATH_RE;
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`HEARTBEAT_LEDGER_RE is not a valid regular expression: ${error.message}`);
  }
}

export function parseArgs(argv, env = process.env) {
  let seconds = DEFAULT_INTERVAL_MINUTES * 60;
  let probe = false;
  let ledger = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--probe') {
      probe = true;
      seconds = PROBE_SECONDS;
    } else if (arg === '--ledger') {
      ledger = argv[i + 1];
      if (!ledger) throw new Error('--ledger needs a path');
      i += 1;
    } else if (arg === '--minutes' || arg === '--seconds') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} needs a positive number`);
      seconds = arg === '--minutes' ? Math.round(value * 60) : Math.round(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (ledger && !resolveLedgerRe(env).test(ledger)) {
    throw new Error(`--ledger must match ${LEDGER_PATH_EXAMPLE} (got ${ledger})`);
  }
  if (!probe && !ledger) {
    throw new Error(`a real heartbeat needs --ledger <path> (e.g. ${LEDGER_PATH_EXAMPLE}); only --probe runs without one`);
  }
  return { seconds, probe, ledger };
}

export function armsPathFor(ledger) {
  return join(dirname(ledger), 'heartbeat.arms');
}

export function countArms(armsPath) {
  if (!existsSync(armsPath)) return 0;
  return readFileSync(armsPath, 'utf8').split('\n').filter(Boolean).length;
}

// Returns null when arming may proceed, or a refusal message. `priorArms` = armings already logged.
export function checkLedgerBeforeArm(ledgerText, priorArms) {
  const wakes = countWakeSections(ledgerText);
  if (wakes >= priorArms - 1) return null;
  return (
    `Refusing to re-arm: ${priorArms} armings logged but only ${wakes} wake section(s) in the ledger ` +
    `(need ${priorArms - 1}). The previous wake wrote no ledger block. Append it first (\`----\`, then ` +
    '`## <time from the wake message> wake (10-row ledger)` with a `sources:` line and the 10-row table), ' +
    'run `pnpm check:heartbeat-ledger -- <ledger> --latest`, then re-arm.'
  );
}

export function armLogLine(now, seconds) {
  return `${now.toISOString()} interval=${Math.round(seconds / 60)}m`;
}

// A block that passes `check-heartbeat-ledger --latest` once each <state> is replaced by an allowed
// form and <timestamp> by the time the external backlog was read. Printed on every wake so the block is right the first time instead of being rewritten after
// the checker goes red. Row names come from the checker's own CATEGORIES, so the two cannot drift.
export function ledgerTemplate(wakeIso) {
  return [
    '----',
    `## ${wakeIso} wake (10-row ledger)`,
    SOURCES_TEMPLATE,
    '',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...CATEGORIES.map((name, index) =>
      index === 0 ? `| 1 | ${name} | (1a) <state>; (1b) <state> |` : `| ${index + 1} | ${name} | <state> |`,
    ),
  ];
}

// Every state form a ledger cell may take, printed under the template. Kept next to ledgerTemplate so the
// two are edited together; check-heartbeat-ledger.mjs is the enforcement.
export const STATE_LEGEND = [
  '<state> = in-flight <unit> | dispatched <unit> | blocked ← <named exclusive resource>',
  '          | deferred ← <input> ETA <=20m | empty — `<command run this wake>` = <result>',
  '          | done — `<command>` or <commit sha>',
  '          | unchanged — `<command rerun this wake>`',
  '  unchanged: rows 2-9 only, for a state that did not change since the previous wake; never on the first',
  '  wake, on a row that was deferred last wake, on row 1 (1a/1b) or on row 10.',
  '  Row 10 (drift): cite the stage x unit matrix you checked, or name the units `unchecked: <units>`.',
  '  external-backlog(✓ <timestamp>) = read within the last 6h; unreachable: external-backlog(blocked ← <reason>)',
  '  AND an `owner ←` item naming the blocker in the Items table.',
  '  Below the table, whenever a row (or an Items row) is blocked/deferred: `re-split: rows(<id>: split->dispatched <unit>; <id>: cannot-split: <tagged proof>)`',
  '  (ids r1a r1b r2..r10 or the Items id) and `splittable: <dispatched-this-wake>/<rows-with-proof>`.',
];

export function keepAwakeCommand(platform, pid) {
  return platform === 'darwin' ? ['caffeinate', ['-i', '-w', String(pid)]] : null;
}

// Best effort: never throws and never blocks the arm. `spawnFn` is the test seam.
export function holdIdleAwake({ platform = process.platform, pid = process.pid, env = process.env, spawnFn = spawn } = {}) {
  if (env.HEARTBEAT_KEEP_AWAKE === '0') return false;
  const command = keepAwakeCommand(platform, pid);
  if (!command) return false;
  try {
    const child = spawnFn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function formatWakeMessage({ seconds, probe, ledger, now }) {
  const stamp = now.toISOString().slice(11, 19);
  if (probe) {
    return (
      `HEARTBEAT_PROBE delivered ${stamp} -- the mechanism works. Now arm the real timer: ` +
      `\`pnpm heartbeat:arm -- --ledger ${LEDGER_PATH_EXAMPLE}\` (background shell).`
    );
  }
  const wakeIso = `${now.toISOString().slice(0, 16)}Z`;
  return [
    `HEARTBEAT due ${stamp} (interval ${Math.max(1, Math.round(seconds / 60))} min) -- ledger: ${ledger}`,
    `Order: (1) re-arm FIRST: pnpm heartbeat:arm -- --ledger ${ledger} (background), (2) audit, (3) ledger, (4) one chat line.`,
    'Audit (agent-task-supervision):',
    '  0. the heartbeat chain is alive (step 1 just re-armed it); quota and host load per your project thresholds',
    '  1. in-flight workers: run the stall detector on EVERY worker notification that completed since the last wake',
    '     (pnpm heartbeat:check-stall -- "<text>"); a worker with an interim last notification and no live child',
    '     is STALLED, nudge it now; 2x expected duration or the same step 3+ times = circuit-breaker row',
    `  2. discovery first: pnpm heartbeat:sweep -- --ledger ${ledger} (ingest every printed row into the Items registry);`,
    '     then the backlog sweep: each item free or `blocked ← <named exclusive resource>`; never bare "in flight"',
    '  3. direction check: is this still the cheapest path to the goal? flag only on a known signal',
    '  4. decomposition: if fewer workers are in flight than free independent units, re-split the remaining goal',
    '     (1a/1b) now and dispatch the free units; do not wait to be asked what can run in parallel',
    '     default answer is YES: every blocked/deferred row gets a verdict in the wake\'s re-split: rows(<id>: split->dispatched <unit> | <id>: cannot-split: <tagged proof>)',
    '     (needs-landed: production effect | branch-unstable: <branch> rewritten in the last 60 min | owner-gated | same-file conflict: <path>) and a splittable: D/P token',
    `Ledger: APPEND this block to ${ledger} (never rewrite or regenerate the file; keep the heading time as-is):`,
    ...ledgerTemplate(wakeIso).map((line) => `  ${line}`),
    ...STATE_LEGEND.map((line) => `  ${line}`),
    '  then one line: environment state & blockers. Keep the Items table where it already sits in the file.',
    `  then run ONCE: pnpm check:heartbeat-ledger -- ${ledger} --latest  (fix every red row)`,
    `Chat: ONE line only -- \`${STATUS_LINE_FORMAT}\`; expand only on an anomaly. No invented numbers.`,
    'The next re-arm is refused if this wake writes no ledger block.',
    'Between timer wakes: a worker interim notification (background work still running, no terminal result) gets an EMPTY reply.',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { seconds, probe, ledger } = parseArgs(process.argv.slice(2));
  if (!probe) {
    const text = existsSync(ledger) ? readFileSync(ledger, 'utf8') : '';
    const armsPath = armsPathFor(ledger);
    const refusal = checkLedgerBeforeArm(text, countArms(armsPath));
    if (refusal) {
      process.stdout.write(`HEARTBEAT_ARM_REFUSED ${refusal}\n`);
      exitDrained(3);
      return;
    }
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(armsPath, `${armLogLine(new Date(), seconds)}\n`);
    holdIdleAwake();
  }
  await sleep(seconds * 1000);
  process.stdout.write(`${formatWakeMessage({ seconds, probe, ledger, now: new Date() })}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`heartbeat:arm: ${error.message}\n`);
    exitDrained(2);
  });
}
