#!/usr/bin/env node
// `pnpm heartbeat:arm` -- the single entry point for arming a long-task heartbeat timer.
//
// Run it through your AI tool's background shell facility (Claude Code: Bash with
// `run_in_background: true`). It sleeps for the interval, prints the audit checklist, and exits;
// that completion notification is the delivered wake. One-shot: every wake
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
//   node heartbeat-arm.mjs --template                              # read-only ledger template, no wake/arming
//   pnpm heartbeat:arm -- --ledger <path> --minutes 15
//   pnpm heartbeat:arm -- --ledger <path> --seconds 90              # tests
// Claude Code's Bash tool stops a run_in_background command after 30 minutes unless the call passes a larger
// `timeout` (ms, max 7200000), so for --minutes above ~25 pass timeout > interval; the wake checklist repeats this.
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
export const STATUS_LINE_FORMAT = '[heartbeat] active N · dispatched X · landed Y · splittable: D/P · blocked: <none|item>';
// The per-wake `sources:` line, in the supervision skill's token form. `<timestamp>` is left for the
// model to fill with the time the external backlog was really read, so an unfilled block stays red.
export const SOURCES_TEMPLATE =
  'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ <timestamp>) worker-health(✓)';

export const DEFAULT_COMMANDS = Object.freeze({
  arm: 'node .vibe-coding/kit/src/supervision/heartbeat-arm.mjs --ledger {ledger}{interval}',
  due: 'node .vibe-coding/kit/src/supervision/heartbeat-audit-due-cli.mjs {ledger} --minutes {minutes} --json',
  check: 'node .vibe-coding/kit/src/supervision/check-heartbeat-ledger.mjs {ledger} --latest',
  sweep: 'node .vibe-coding/kit/src/supervision/heartbeat-sweep.mjs --ledger {ledger}',
  inflight: 'node .vibe-coding/kit/cli.mjs worktree status --stale',
  branches: 'node .vibe-coding/kit/src/supervision/heartbeat-branches.mjs check --ledger {ledger}',
});

const COMMAND_KEYS = Object.keys(DEFAULT_COMMANDS);

export function normalizeCommands(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--commands must be a JSON object');
  const commands = { ...DEFAULT_COMMANDS };
  for (const [key, command] of Object.entries(value)) {
    if (!COMMAND_KEYS.includes(key)) throw new Error(`unknown heartbeat command key: ${key}`);
    if (typeof command !== 'string' || !command.trim()) throw new Error(`heartbeat command ${key} must be a non-empty string`);
    commands[key] = command;
  }
  return commands;
}

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
  let template = false;
  let intervalSpecified = false;
  let commandsSpecified = false;
  let ledger = null;
  let commands = DEFAULT_COMMANDS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--template') {
      template = true;
    } else if (arg === '--probe') {
      probe = true;
      seconds = PROBE_SECONDS;
    } else if (arg === '--ledger') {
      ledger = argv[i + 1];
      if (!ledger) throw new Error('--ledger needs a path');
      i += 1;
    } else if (arg === '--commands') {
      commandsSpecified = true;
      try { commands = normalizeCommands(JSON.parse(argv[i + 1])); }
      catch (error) { throw new Error(`--commands needs a valid JSON mapping: ${error.message}`); }
      i += 1;
    } else if (arg === '--minutes' || arg === '--seconds') {
      intervalSpecified = true;
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} needs a positive number`);
      seconds = arg === '--minutes' ? Math.round(value * 60) : Math.round(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (template) {
    if (probe || intervalSpecified || ledger || commandsSpecified) {
      throw new Error('--template cannot be combined with --probe, --ledger, --minutes, --seconds, or --commands');
    }
    return { template: true };
  }
  if (ledger && !resolveLedgerRe(env).test(ledger)) {
    throw new Error(`--ledger must match ${LEDGER_PATH_EXAMPLE} (got ${ledger})`);
  }
  if (!probe && !ledger) {
    throw new Error(`a real heartbeat needs --ledger <path> (e.g. ${LEDGER_PATH_EXAMPLE}); only --probe runs without one`);
  }
  return { seconds, probe, ledger, commands };
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
    '`## <time from the wake message> wake (10-row ledger)` with a standalone `contract: heartbeat/v2` line, ' +
    'a `sources:` line, and the ten category rows), run `node .vibe-coding/kit/src/supervision/check-heartbeat-ledger.mjs <ledger> --latest`, then re-arm.'
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
    'contract: heartbeat/v2',
    SOURCES_TEMPLATE,
    '',
    '| # | category | state |',
    '| --- | --- | --- |',
    ...CATEGORIES.map((name, index) =>
      index === 0 ? `| 1 | ${name} | (1a) <state>; (1b) <state> |` : `| ${index + 1} | ${name} | <state> |`,
    ),
    '',
    '### Decomposition',
    '| item | next_step | disposition | owner | evidence |',
    '| --- | --- | --- | --- | --- |',
    're-split: rows()',
    'splittable: 0/0',
  ];
}

// Every state form a ledger cell may take, printed under the template. Kept next to ledgerTemplate so the
// two are edited together; check-heartbeat-ledger.mjs is the enforcement.
export const STATE_LEGEND = [
  '<state> = in-flight <unit> | dispatched <unit> | blocked ← <named exclusive resource>',
  '          | deferred ← <input> ETA <=20m | empty — `<command run this wake>` = <result>',
  '          | done — `<command>` = <result> or <landed commit sha>',
  '  Row 1 must answer `(1a)` and `(1b)` separately. Empty and done states need evidence; blocked names its exclusive resource; deferred names its input and ETA <=20m.',
  '          | unchanged — `<command rerun this wake>`',
  '  unchanged: rows 2-9 only, for a state that did not change since the previous wake; never on the first',
  '  wake, on a row that was deferred last wake, on row 1 (1a/1b) or on row 10.',
  '  Row 10 (drift): cite the stage x unit matrix you checked, or name the units `unchecked: <units>`.',
  '  external-backlog(✓ <timestamp>) = read within the last 6h; unreachable: external-backlog(blocked ← <reason>)',
  '  AND an `owner ←` item naming the blocker in the Items table.',
  '  In Decomposition, include every current non-done Item with its concrete next step and disposition dispatched|continuing|blocked|owner|done.',
  '  Every accepted dispatch is only an accepted request; record later active/final/landed evidence separately. Never infer execution from acceptance.',
  '  rows(...) verdicts: split->dispatched <new unit> | cannot-split: <tagged proof> | continuing: active <source-ref> | continuing: private-final <source-ref> | continuing: tracking <source-ref> for a real parent aggregate. Cite actual current tool/child-state evidence, never acceptance alone; use real Item/wake-cell IDs.',
  '  The orchestrator resolves and cross-checks source refs against original tool evidence; the checker validates only kind/ref syntax. Do not add an activity-receipt JSON registry.',
  '  End with standalone `re-split: rows(...)` and `splittable: D/P` lines. D counts new dispatches; P counts all valid assessed verdicts, including continuing. If no additional split assessment is needed, rows() and 0/0 are valid when Decomposition covers every unfinished Item.',
  '  Add one Decomposition data row per current non-done Item; the emitted table is intentionally empty until populated. Do not leave ready items.',
];

const OPTIONAL_CHILDREN_GUIDE = [
  'Optional Items registry extension (append `children` after `dispatch_ref` only for true aggregates; aggregate arrays must be nonempty):',
  '| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref | children |',
  'For leaf Items omit the column or use `[]`; children is a JSON array of unique IDs already in this one Items registry. No self-links, cycles, or dangling IDs.',
  'Keep owner, repository, worktree, mode, write_set, and accepted receipt/write scope accurate; read-only rows use write_set `[]`. Never invent acceptance or writer authority.',
  'Children finishing does not finish their parent before its own acceptance criteria pass. Do not bypass leaf work/receipts or hide unknown legacy state.',
];

export function formatLedgerTemplate(now = new Date(), { includeChildrenGuide = false } = {}) {
  const wakeIso = `${now.toISOString().slice(0, 16)}Z`;
  return [...ledgerTemplate(wakeIso), ...STATE_LEGEND, ...(includeChildrenGuide ? OPTIONAL_CHILDREN_GUIDE : [])].join('\n');
}

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

// The re-arm command must carry the interval this timer was armed with, or a --minutes 60 session silently
// falls back to the default. Claude Code's Bash tool stops a run_in_background command after 30 minutes unless
// the call passes a larger `timeout`, so long intervals also get that hint.
const BASH_BACKGROUND_LIMIT_MINUTES = 30;
const LONG_INTERVAL_HINT_MINUTES = 25;

function wholeMinutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

function rearmInterval(seconds) {
  const minutes = wholeMinutes(seconds);
  return minutes === DEFAULT_INTERVAL_MINUTES ? '' : ` --minutes ${minutes}`;
}

function rearmHint(seconds) {
  const minutes = wholeMinutes(seconds);
  if (minutes < LONG_INTERVAL_HINT_MINUTES) return '';
  return (
    `; Bash run_in_background stops a command at ${BASH_BACKGROUND_LIMIT_MINUTES} min by default, ` +
    `so give this call timeout >= ${(minutes + 10) * 60000} ms`
  );
}

function command(commands, key, ledger, seconds) {
  const formatted = commands[key]
    .replaceAll('{ledger}', ledger ?? '<ledger>')
    .replaceAll('{minutes}', String(wholeMinutes(seconds)))
    .replaceAll('{interval}', rearmInterval(seconds));
  if (key !== 'arm') return formatted;
  const overrides = Object.fromEntries(COMMAND_KEYS.filter((name) => commands[name] !== DEFAULT_COMMANDS[name]).map((name) => [name, commands[name]]));
  if (!Object.keys(overrides).length) return formatted;
  const serialized = JSON.stringify(overrides).replaceAll("'", "'\\''");
  return `${formatted} --commands '${serialized}'`;
}

export function formatWakeMessage({ seconds, probe, ledger, now, commands = DEFAULT_COMMANDS }) {
  const stamp = now.toISOString().slice(11, 19);
  if (probe) {
    return (
      `HEARTBEAT_PROBE delivered ${stamp} -- the mechanism works. Now arm the real timer: ` +
      `\`${command(commands, 'arm', LEDGER_PATH_EXAMPLE, seconds)}\` (background shell).`
    );
  }
  return [
    `HEARTBEAT due ${stamp} (interval ${Math.max(1, Math.round(seconds / 60))} min) -- ledger: ${ledger}`,
    `Order: (1) re-arm FIRST: ${command(commands, 'arm', ledger, seconds)} (background${rearmHint(seconds)}), (2) audit, (3) ledger, (4) one chat line.`,
    'Audit (agent-task-supervision):',
    '  0. the heartbeat chain is alive (step 1 just re-armed it); quota and host load per your project thresholds',
    `  1. in-flight workers: ${command(commands, 'inflight', ledger, seconds)}; audit EVERY worker notification that completed since the last wake`,
    '     a worker with an interim last notification and no live child',
    '     is STALLED, nudge it now; 2x expected duration or the same step 3+ times = circuit-breaker row',
    `  1b. child sessions and branches: ${command(commands, 'branches', ledger, seconds)}; inspect each listed owner and record evidence.`,
    '     This command is a configured project probe; the shared policy grants no finish, archive, cleanup, or deletion authority.',
    `  2. discovery first: ${command(commands, 'sweep', ledger, seconds)} (ingest every printed row into the Items registry);`,
    '     then the backlog sweep: each item free or `blocked ← <named exclusive resource>`; never bare "in flight"',
    '  3. direction check: is this still the cheapest path to the goal? flag only on a known signal',
    '  4. re-split immediately: decompose every remaining non-done Item, dispatch each free independent unit, and assign a clear owner and exact file write set.',
    '     Check every accepted dispatch for evidence it became active; re-split stale/idle work or record its concrete blocker.',
    `Ledger: APPEND this block to ${ledger} (never rewrite or regenerate the file; keep the heading time as-is):`,
    ...formatLedgerTemplate(now).split('\n').map((line) => `  ${line}`),
    '  Keep ## Items with id/source/item/status/evidence followed by owner | repository | worktree | mode | write_set | dispatch_ref.',
    '  A dispatched row needs mode write|read-only, explicit repository/worktree, JSON exact relative file array (no broad paths/globs), and accepted receipt path.',
    '  dispatch_ref proves acceptance only: tool, event=accepted, agent_id=owner, and returned task_name|agent_id|session_id|id=owner. It does not prove running or completion.',
    '  Decomposition lists all current non-done Items; dispositions dispatched|continuing|blocked|owner|done; standalone re-split: rows(...) and splittable: D/P lines are required even without blockers; no ready at end.',
    `  then run ONCE: ${command(commands, 'check', ledger, seconds)} (fix every red row)`,
    `Chat: ONE line only -- \`${STATUS_LINE_FORMAT}\`; report actual counts supported by current evidence, never subjective percentages or invented numbers. Expand only on an anomaly.`,
    'The next re-arm is refused if this wake writes no ledger block.',
    'Between timer wakes: a worker interim notification (background work still running, no terminal result) gets an EMPTY reply.',
    `Without a delivered timer: on every meaningful human request, resume, private final, landing, or newly surfaced blocker, run ${command(commands, 'due', ledger, seconds)}. If JSON says due=true, re-arm if available and finish this full audit before unrelated next-batch work; otherwise handle the event normally. No event means no guaranteed wall-clock wake; this probe schedules nothing.`,
    'For v2 rows(...), use split->dispatched <new unit>, cannot-split: <tagged proof>, continuing: active <source-ref>, continuing: private-final <source-ref>, or continuing: tracking <source-ref> for a true aggregate parent. Cite current raw tool/child-state evidence; acceptance alone is not activity evidence. The orchestrator cross-checks original tool results; the checker validates only kind/ref syntax. No activity-receipt JSON registry or separate child registry. Use real Item/wake-cell IDs. D counts new dispatches and P counts all valid assessed verdicts; rows() and 0/0 remain valid with no additional split assessment when Decomposition covers every unfinished Item. Preserve older wake denominators unchanged.',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHeartbeatArm(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseArgs(argv, deps.env ?? process.env);
  if (parsed.template) {
    const message = `HEARTBEAT_TEMPLATE -- read-only; no wake delivered\n${formatLedgerTemplate(deps.now?.() ?? new Date(), { includeChildrenGuide: true })}`;
    (deps.stdout ?? process.stdout).write(`${message}\n`);
    return message;
  }
  const { seconds, probe, ledger, commands } = parsed;
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
  await (deps.sleep ?? sleep)(seconds * 1000);
  const message = formatWakeMessage({ seconds, probe, ledger, now: deps.now?.() ?? new Date(), commands });
  (deps.stdout ?? process.stdout).write(`${message}\n`);
  return message;
}

if (isMainModule(import.meta.url)) {
  runHeartbeatArm().catch((error) => {
    process.stderr.write(`heartbeat:arm: ${error.message}\n`);
    exitDrained(2);
  });
}
