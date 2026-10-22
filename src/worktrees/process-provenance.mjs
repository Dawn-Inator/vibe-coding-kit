// worktree-guard/process-provenance.mjs
//
// Best-effort detection of whether the current process (or its ancestor
// chain) was launched by an AI CLI tool (claude/codex/...), used to decide
// whether certain guard behaviors (e.g. primary-worktree lock bypass
// eligibility) apply. Two independent signals, either one is sufficient:
//
//   1. Environment markers (depth-independent). The AI CLI sets variables such
//      as CLAUDECODE on its own process and every descendant inherits them, so
//      no number of wrapper scripts between the CLI and this process can hide
//      it. The marker names are the per-tool `detectEnv` lists in config.tools
//      -- the same lists worktree-core uses to pick a tool -- so there is one
//      place to edit when a CLI changes what it exports.
//   2. The ancestor process chain, walked with `ps`. Matching is deliberately
//      strict: it checks the exact basename of the executable in a command
//      line, never a substring match against the whole command line -- see
//      matchesAiParentProcess for why. The walk is depth-limited, which is
//      why signal 1 exists.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

const TEST_PARENT_CHAIN_OVERRIDE_ENV = 'WTG_TEST_PARENT_CHAIN_OVERRIDE';

// A directory segment like ".claude" (an AI tool's home directory, see
// config.tools.*.home) is treated as equivalent to the bare tool name
// "claude" when walking a script's ancestor directories below -- strip at
// most one leading dot before comparing.
function normalizeDirSegment(segment) {
  return String(segment || '').replace(/^\./, '').toLowerCase();
}

/**
 * True when `commandLine` looks like it was launched as an AI CLI tool
 * process (an exact match on config.aiCliExecutableNames), or as a script
 * runtime (config.scriptRuntimeExecutableNames) whose script path has an
 * ancestor directory named after an AI CLI tool (e.g. a globally installed
 * CLI living under "~/.claude/local/cli.js").
 *
 * Regression guard: matching is always on a *whole path segment*
 * (the executable's exact basename, or one exact directory-name segment of
 * the script path), never a substring search over the whole command line
 * or path. A command line like
 * "/some/path/claude-scratch-lane-abc123/bin/bash -c foo" must NOT match --
 * basename(argv[0]) is "bash", which is not in aiCliExecutableNames, and
 * "claude" is only a substring of the segment "claude-scratch-lane-abc123"
 * (not an exact segment match), even though the string "claude" appears
 * somewhere in the path.
 *
 * Space-in-executable-path handling: plain `ps -o command=` output joins
 * the executable path and its arguments with spaces, which is ambiguous to
 * split back apart when the executable's OWN path contains a space (real
 * case: macOS app-bundle installs frequently land under
 * "~/Library/Application Support/..."). `getAncestorProcessCommands` below
 * resolves this by separately querying `ps -o comm=` (which macOS returns
 * as the full, unbroken executable path even when it contains spaces) and
 * prefixing it onto the returned entry as `${comm}\u0000${argsOnly}`. When
 * that U+0000 marker is present, this function trusts `comm` for the exe
 * check instead of naively splitting on whitespace; when it's absent (a
 * plain string, e.g. from a test or from WTG_TEST_PARENT_CHAIN_OVERRIDE),
 * it falls straight back to the original whitespace-split behavior, so
 * every previously-supported input shape keeps working unchanged.
 *
 * @param {string} commandLine
 * @param {{aiCliExecutableNames: string[], scriptRuntimeExecutableNames: string[]}} config
 * @returns {boolean}
 */
export function matchesAiParentProcess(commandLine, config) {
  const raw = String(commandLine || '');
  const nulIndex = raw.indexOf('\u0000');
  const reliableExe = nulIndex === -1 ? null : raw.slice(0, nulIndex);
  const line = nulIndex === -1 ? raw : raw.slice(nulIndex + 1);

  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!reliableExe && tokens.length === 0) return false;

  const exe = reliableExe ? basename(reliableExe).toLowerCase() : basename(tokens[0]).toLowerCase();
  if (config.aiCliExecutableNames.includes(exe)) return true;

  if (config.scriptRuntimeExecutableNames.includes(exe)) {
    // When reliableExe is set, the exe portion has already been split off
    // by getAncestorProcessCommands, so `tokens[0]` of the remainder is the
    // first argument (the script path). Otherwise it's `tokens[1]` of the
    // naive whitespace split, as before.
    const scriptArg = reliableExe ? tokens[0] : tokens[1];
    if (!scriptArg) return false;
    const aiNames = new Set(config.aiCliExecutableNames.map((name) => name.toLowerCase()));
    const dirSegments = dirname(scriptArg).split(/[\\/]+/).filter(Boolean);
    if (dirSegments.some((segment) => aiNames.has(normalizeDirSegment(segment)))) {
      return true;
    }
  }

  return false;
}

/**
 * True when any command line in `commands` (an array of ancestor process
 * command lines, ordered nearest-first) matches matchesAiParentProcess.
 *
 * @param {string[]} commands
 * @param {{aiCliExecutableNames: string[], scriptRuntimeExecutableNames: string[]}} config
 * @returns {boolean}
 */
export function isAiParentedCommandChain(commands, config) {
  if (!Array.isArray(commands) || commands.length === 0) return false;
  return commands.some((commandLine) => matchesAiParentProcess(commandLine, config));
}

/**
 * The environment variable names that mark a process as running under an AI
 * CLI: the union of every `config.tools[*].detectEnv` list.
 *
 * @param {{tools?: Record<string, {detectEnv?: string[]}>}} config
 * @returns {string[]}
 */
export function aiParentEnvMarkers(config) {
  const names = new Set();
  for (const tool of Object.values(config?.tools ?? {})) {
    for (const name of tool?.detectEnv ?? []) names.add(name);
  }
  return [...names];
}

/**
 * The first AI-CLI environment marker that is set (non-empty) in `env`, or
 * null. A human interactive shell does not carry these.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Parameters<typeof aiParentEnvMarkers>[0]} config
 * @returns {string|null}
 */
export function findAiParentEnvMarker(env, config) {
  if (!env) return null;
  return aiParentEnvMarkers(config).find((name) => env[name] !== undefined && env[name] !== '') ?? null;
}

/**
 * True when an AI-CLI environment marker is present, regardless of how many
 * processes sit between the CLI and the caller.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Parameters<typeof aiParentEnvMarkers>[0]} config
 * @returns {boolean}
 */
export function isAiParentedEnvironment(env, config) {
  return findAiParentEnvMarker(env, config) !== null;
}

function defaultPs(args) {
  // A busy machine easily produces more than spawnSync's default 1 MiB of
  // output for a full process listing; a truncated listing must not be mistaken
  // for a complete one.
  return spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Best-effort walk of the ancestor process chain (starting at the current
 * process's parent) via `ps`, returning up to `maxDepth` command lines
 * ordered nearest-first. Every step is best-effort: any failure to resolve
 * a command line or parent pid stops the walk early rather than throwing.
 *
 * Test seams: when env.WTG_TEST_PARENT_CHAIN_OVERRIDE is set, it is split on
 * ';' and returned directly, bypassing the real process tree. Alternatively
 * `options.ps(args)` replaces the `ps` call (returning `{status, stdout}`)
 * and `options.startPid` replaces the starting pid, so a test can walk a fake
 * process table of any depth.
 *
 * @param {number} [maxDepth]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ps?: (args: string[]) => {status: number|null, stdout?: string}, startPid?: number}} [options]
 * @returns {string[]}
 */
export function getAncestorProcessCommands(maxDepth = 3, env = process.env, options = {}) {
  const override = env[TEST_PARENT_CHAIN_OVERRIDE_ENV];
  if (override) {
    return override.split(';').filter(Boolean);
  }

  const ps = options.ps ?? defaultPs;
  const commands = [];
  let pid = options.startPid ?? process.ppid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!pid || pid <= 1) break;

    const commandResult = ps(['-o', 'command=', '-p', String(pid)]);
    if (commandResult.status !== 0) break;
    const commandLine = (commandResult.stdout || '').trim();
    if (!commandLine) break;

    // Best-effort: also resolve the executable's own path via `ps -o comm=`,
    // which (unlike `command=`) is never ambiguously joined with arguments --
    // see matchesAiParentProcess's doc comment for why this matters. Only
    // used to prefix the entry when it's a genuine, unambiguous prefix of
    // commandLine; any failure or mismatch just falls back to the plain
    // commandLine string (the original, still-correct behavior for the
    // common case where the executable's own path has no spaces).
    const commResult = ps(['-o', 'comm=', '-p', String(pid)]);
    const comm = commResult.status === 0 ? (commResult.stdout || '').trim() : '';
    let entry = commandLine;
    if (comm && commandLine.startsWith(comm)) {
      const argsOnly = commandLine.slice(comm.length).trim();
      entry = `${comm}\u0000${argsOnly}`;
    }
    commands.push(entry);

    const ppidResult = ps(['-o', 'ppid=', '-p', String(pid)]);
    if (ppidResult.status !== 0) break;
    const nextPidRaw = (ppidResult.stdout || '').trim();
    const nextPid = Number.parseInt(nextPidRaw, 10);
    if (!Number.isFinite(nextPid) || nextPid <= 0) break;

    pid = nextPid;
  }

  return commands;
}

/** How many ancestors the `ps` walk inspects. The env marker covers anything deeper. */
export const DEFAULT_ANCESTOR_DEPTH = 8;

/**
 * Decide whether the current process is AI-parented, and say why.
 *
 * Order: the environment marker first (cheap, depth-independent, proof on its
 * own), then the ancestor walk as the second signal.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   config: {tools?: Record<string, {detectEnv?: string[]}>, aiCliExecutableNames: string[], scriptRuntimeExecutableNames: string[]},
 *   maxDepth?: number,
 *   ps?: Parameters<typeof getAncestorProcessCommands>[2]['ps'],
 *   startPid?: number,
 * }} params
 * @returns {{aiParented: boolean, via: string|null}} `via` is `env:<NAME>`, `ancestry`, or null
 */
export function detectAiParent({ env = process.env, config, maxDepth = DEFAULT_ANCESTOR_DEPTH, ps, startPid }) {
  const marker = findAiParentEnvMarker(env, config);
  if (marker) return { aiParented: true, via: `env:${marker}` };

  const commands = getAncestorProcessCommands(maxDepth, env, { ps, startPid });
  if (isAiParentedCommandChain(commands, config)) return { aiParented: true, via: 'ancestry' };

  return { aiParented: false, via: null };
}

/**
 * Snapshot of every running process: `{pid, ppid, commandLine}`, where
 * `commandLine` has the same shape `getAncestorProcessCommands` produces (the
 * `comm` / args split with a U+0000 marker when `comm` is an unambiguous prefix
 * of the full command), so it can be fed straight to `matchesAiParentProcess`.
 *
 * Throws when `ps` cannot be run or fails: callers that need an affirmative
 * answer (the sync-primary idle scan) treat that as "unknown", never "empty".
 *
 * @param {{ps?: (args: string[]) => {status: number|null, stdout?: string, error?: Error}}} [options]
 * @returns {{pid: number, ppid: number, commandLine: string}[]}
 */
export function listProcessCommands(options = {}) {
  const ps = options.ps ?? defaultPs;
  const run = (args) => {
    const result = ps(args);
    if (result.error) throw new Error(`process listing failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`process listing failed: ps exited ${result.status}`);
    return String(result.stdout || '').split(/\r?\n/);
  };

  const commandByPid = new Map();
  for (const line of run(['-axo', 'pid=,command='])) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match) commandByPid.set(Number(match[1]), match[2]);
  }

  const processes = [];
  for (const line of run(['-axo', 'pid=,ppid=,comm='])) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const comm = match[3];
    const full = commandByPid.get(pid);
    let commandLine = full ?? comm;
    if (full && full.startsWith(comm)) commandLine = `${comm}\u0000${full.slice(comm.length).trim()}`;
    processes.push({ pid, ppid: Number(match[2]), commandLine });
  }
  return processes;
}
