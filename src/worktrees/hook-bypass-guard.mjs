// worktree-guard/hook-bypass-guard.mjs
//
// Mechanical guard for the rule "an AI agent never bypasses git hooks and never uses `git stash` in a
// managed worktree". Written prohibitions alone are easy to ignore; this is a Claude Code PreToolUse hook on
// the Bash matcher (agent sessions only; a human's own terminal never goes through it). The hook CLI is
// hook-bypass-guard-hook.mjs.
//
// Denied (rule id in brackets, named in the deny message):
//   [no-verify]   `--no-verify` on ANY git subcommand (commit/push/merge/rebase/am...; unambiguous long-option
//                 prefixes such as `--no-ver` too) and `-n` (also inside a short cluster, `-nm`, `-anm`) for
//                 `git commit`. `git push -n` is --dry-run and is NOT a bypass, so it stays allowed.
//   [hooks-path]  `git -c core.hooksPath=...`, `--config core.hooksPath`, `-ccore.hooksPath=...`,
//                 `--config-env=core.hooksPath=VAR`, `git config core.hooksPath <value>` (a write), and the
//                 GIT_CONFIG_KEY_<n>=core.hooksPath / GIT_CONFIG_PARAMETERS env forms.
//   [husky-skip]  `HUSKY=0`, `HUSKY_SKIP_HOOKS=...` (before any command, bare, or via export/env), and `SKIP=...`
//                 (pre-commit skip list) before git/package-manager/node/shell/make or bare / exported, plus any
//                 project-configured variable names (`extraBypassEnvNames`).
//   [git-stash]   `git stash` in any form (also behind `-C dir`, `-c k=v`, `--git-dir=...` global options).
//
// Project knobs (config key `hookBypassGuard`, see config.mjs): `disabledRules`, `skipSensitivePrograms`,
// `extraBypassEnvNames`, `hints` (per-rule remediation text appended to the deny message).
//
// Parsing: a real shell lexer (quotes, backslashes, `$'...'`, comments, `&& || ; | & ( ) newline`, `$(...)`,
// backticks, `<(...)`, heredocs, here-strings), then per simple command: leading VAR=val, wrappers (env,
// command, sudo, nohup, exec, time, nice, timeout, xargs, `pnpm|npm|yarn exec`, npx, `bash -c`/`sh -c`/`eval`
// recursion), then git global-option skipping to find the subcommand. Words are concatenated after unquoting,
// so `--no-"verify"` and `g''it` resolve to what the shell would run.
//
// False positives avoided: only the ARGV of a recognised git command is inspected. `grep -- --no-verify f`,
// `echo "git commit --no-verify"`, a heredoc body fed to `cat`, a `# --no-verify` comment, and `git commit -m
// "--no-verify"` (message of `-m`) are allowed.
//
// Fail-safe (deny when unsure): an unterminated quote / unbalanced `$(`, or a program word that is dynamic
// (`$GIT commit --no-verify`, `$(which git) stash`) is analysed as if it were git. Unterminated input falls back
// to a coarse text scan: a hook-bypass token anywhere in the text next to the word `git` denies.
//
// Known limits (documented, not covered): bypasses assembled at run time (`--no-$X`, `eval "$(printf ...)"`),
// scripts that run git internally (`./deploy.sh`, a package script that shells out), git aliases
// (`git config alias.c 'commit -n'` then `git c`), data fed through `xargs`/pipes
// (`echo --no-verify | xargs git commit`), and `GIT_CONFIG_GLOBAL` pointing at a file that sets hooksPath. This is a
// guardrail against reflexive misuse, not a security boundary: hooks remain a repo convention, not a trust boundary.
//
// Fail open on a guard bug (any exception) -- a guard bug must never block a legitimate tool call.
// Node built-ins only, zero third-party dependencies, ESM.

import { loadConfig } from './config.mjs';
import { lexShell } from './hook-bypass-guard-lexer.mjs';

export const RULE_IDS = Object.freeze(['no-verify', 'hooks-path', 'husky-skip', 'git-stash']);

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=([\s\S]*)$/;
// Programs before which a bare `SKIP=...` is read as the pre-commit skip list. Projects extend or replace this
// through config `hookBypassGuard.skipSensitivePrograms`.
export const DEFAULT_SKIP_SENSITIVE_PROGRAMS = Object.freeze(['git', 'pnpm', 'npm', 'npx', 'yarn', 'node', 'make', 'pre-commit', 'husky']);
const GIT_GLOBAL_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source', '--list-cmds']);
// Short options of `git commit` that consume the rest of the cluster / next word as their argument.
const COMMIT_SHORT_WITH_ARG = new Set(['m', 'F', 'C', 'c', 't', 'S', 'u']);
const NO_VERIFY = '--no-verify';
const MIN_NO_VERIFY_PREFIX = 7; // `--no-ve`

// ───────────────────────────── analysis ─────────────────────────────

function basename(p) {
  const s = p.replace(/\/+$/, '');
  const k = s.lastIndexOf('/');
  return k >= 0 ? s.slice(k + 1) : s;
}

function isBypassEnv(name, value, ctx) {
  if (ctx.extraBypassEnvNames.has(name)) return true;
  if (name === 'HUSKY') return value === '0';
  if (name === 'HUSKY_SKIP_HOOKS') return true;
  if (name === 'SKIP') return value !== '';
  if (/^GIT_CONFIG_KEY_\d+$/.test(name)) return /^core\.hookspath$/i.test(value);
  if (name === 'GIT_CONFIG_PARAMETERS') return /core\.hookspath/i.test(value);
  return false;
}

const MSG = {
  'no-verify': (d) =>
    `Blocked [hook-bypass-guard/no-verify]: \`${d}\` bypasses git hooks. AI must never skip hooks (no \`--no-verify\` / \`git commit -n\`). ` +
    'Fix the failing hook (or report it as blocked) instead. (`git push -n` is --dry-run and is allowed.)',
  'hooks-path': (d) =>
    `Blocked [hook-bypass-guard/hooks-path]: \`${d}\` points git at a different hooks directory, which disables the repo hooks. ` +
    'AI must never set `core.hooksPath` (via `-c`, `--config`, `git config`, or GIT_CONFIG_* env).',
  'husky-skip': (d) =>
    `Blocked [hook-bypass-guard/husky-skip]: \`${d}\` disables git hook managers for the command. ` +
    'AI must never set HUSKY=0, HUSKY_SKIP_HOOKS or SKIP=. Let the hooks run; if they fail, fix the cause or report it.',
  'git-stash': () =>
    'Blocked [hook-bypass-guard/git-stash]: `git stash` is forbidden for agents: refs/stash is one ref shared by every worktree of the repository. ' +
    'Save with `git diff > patch` and discard with `git restore <path>`.',
};

function buildReason(rule, detail, hints) {
  const hint = typeof hints?.[rule] === 'string' ? hints[rule].trim() : '';
  return hint ? `${MSG[rule](detail)} ${hint}` : MSG[rule](detail);
}

function hit(rule, detail) {
  return { rule, detail };
}

/** Is `tok` an unambiguous long-option abbreviation of --no-verify (>= `--no-ve`)? */
function isNoVerifyOption(tok) {
  const t = tok.split('=')[0];
  return t.length >= MIN_NO_VERIFY_PREFIX && NO_VERIFY.startsWith(t) && t.startsWith('--no-');
}

/** Analyse the argv that follows `git` (global options included). Returns a hit or null. */
function analyzeGitArgs(args) {
  let i = 0;
  // 1. global options → find the subcommand; hooksPath via -c / --config / --config-env is a hit wherever it sits.
  while (i < args.length) {
    const a = args[i].text;
    if (a === '-c' || a === '--config') {
      const v = args[i + 1]?.text ?? '';
      if (/^core\.hookspath(=|$)/i.test(v)) return hit('hooks-path', `git ${a} ${v}`);
      i += 2;
      continue;
    }
    if (/^-c.+/.test(a) && !a.startsWith('--')) {
      if (/^-ccore\.hookspath/i.test(a)) return hit('hooks-path', `git ${a}`);
      i++;
      continue;
    }
    if (/^--config(-env)?=core\.hookspath/i.test(a)) return hit('hooks-path', `git ${a}`);
    if (a === '--config-env') {
      if (/^core\.hookspath/i.test(args[i + 1]?.text ?? '')) return hit('hooks-path', `git ${a} ${args[i + 1].text}`);
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      if (GIT_GLOBAL_OPTS_WITH_ARG.has(a)) i += 2;
      else if (isNoVerifyOption(a)) return hit('no-verify', `git ${a}`); // `git --no-verify …` is never valid; deny fail-safe
      else i++;
      continue;
    }
    break;
  }
  const sub = args[i]?.text;
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  if (sub === 'stash') return hit('git-stash', 'git stash');
  // 2. `--no-verify` (any subcommand) and `commit -n`.
  let optionsEnded = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k].text;
    if (a === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) continue;
    if (isNoVerifyOption(a)) return hit('no-verify', `git ${sub} ${a}`);
    if (sub === 'commit' && /^-[A-Za-z]+/.test(a) && !a.startsWith('--')) {
      for (const ch of a.slice(1)) {
        if (ch === 'n') return hit('no-verify', `git commit ${a}`);
        if (COMMIT_SHORT_WITH_ARG.has(ch)) break;
      }
    }
    // Options that take a separate value: skip it so `-m "--no-verify"` / `-F -n` are not misread.
    if (sub === 'commit' && (a === '-m' || a === '-F' || a === '-C' || a === '-c' || a === '-t' || a === '--message' || a === '--file' || a === '--author' || a === '--date' || a === '--template' || a === '--reuse-message' || a === '--reedit-message' || a === '--cleanup' || a === '-S' || a === '--gpg-sign')) {
      k++;
    }
    if (sub === 'push' && (a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec' || a === '--repo')) k++;
    if (sub === 'config' && /^core\.hookspath$/i.test(a)) {
      const following = rest.slice(k + 1).map((w) => w.text);
      const reads = rest.some((w) => /^--(get|get-all|get-regexp|list|show-origin|unset|unset-all|remove-section)$|^-l$/.test(w.text));
      if (!reads && following.length > 0) return hit('hooks-path', `git config ${a} ${following[0]}`);
    }
  }
  return null;
}

const WRAPPERS_SIMPLE = new Set(['command', 'builtin', 'exec', 'nohup', 'sudo', 'doas', 'time', 'nice', 'ionice', 'setsid', 'stdbuf', 'chronic', 'caffeinate', 'unbuffer']);
const WRAPPERS_WITH_NUMBER = new Set(['timeout']);

/** Analyse one simple command. Returns a hit or null. `ctx.rules` filters rules; `ctx.depth` bounds recursion. */
function analyzeCommand(cmd, ctx) {
  const words = cmd.words;
  let i = 0;
  const envHits = [];
  const assigns = [];
  // leading VAR=val
  while (i < words.length) {
    const m = ENV_ASSIGN_RE.exec(words[i].text);
    if (!m || words[i].text.startsWith('=')) break;
    assigns.push([m[1], m[2]]);
    i++;
  }
  let program = words[i];
  let args = words.slice(i + 1);
  // wrapper unwrapping
  for (let guard = 0; guard < 8 && program; guard++) {
    const p = basename(program.text);
    if (p === 'env') {
      let j = 0;
      while (j < args.length) {
        const a = args[j].text;
        const m = ENV_ASSIGN_RE.exec(a);
        if (m) assigns.push([m[1], m[2]]);
        else if (a === '-u' || a === '-C' || a === '-S' || a === '--unset' || a === '--chdir' || a === '--split-string') j++;
        else if (!a.startsWith('-')) break;
        j++;
      }
      program = args[j];
      args = args.slice(j + 1);
      continue;
    }
    if (WRAPPERS_SIMPLE.has(p) || WRAPPERS_WITH_NUMBER.has(p)) {
      let j = 0;
      while (j < args.length && args[j].text.startsWith('-')) j += (p === 'sudo' && /^-[uUgGhpCcrt]$/.test(args[j].text)) || (p === 'nice' && args[j].text === '-n') ? 2 : 1;
      if (WRAPPERS_WITH_NUMBER.has(p)) j++; // duration
      program = args[j];
      args = args.slice(j + 1);
      continue;
    }
    if (p === 'xargs') {
      let j = 0;
      while (j < args.length && args[j].text.startsWith('-')) j += /^-[IiLnPsEdaIJ]$/.test(args[j].text) ? 2 : 1;
      program = args[j];
      args = args.slice(j + 1);
      continue;
    }
    if (p === 'pnpm' || p === 'npm' || p === 'yarn') {
      const j = args.findIndex((a) => !a.text.startsWith('-'));
      if (j >= 0 && ['exec', 'dlx', 'x'].includes(args[j].text) && args[j + 1]) {
        // keep the pnpm program for env rules by checking assigns now, then unwrap.
        program = args[j + 1];
        args = args.slice(j + 2);
        ctx.sawPackageManager = true;
        continue;
      }
    }
    if (p === 'npx') {
      let j = 0;
      while (j < args.length && args[j].text.startsWith('-')) j++;
      program = args[j];
      args = args.slice(j + 1);
      continue;
    }
    break;
  }

  const progName = program ? basename(program.text) : null;

  // ── husky-skip / hooks-path env prefixes ──
  for (const [name, value] of assigns) {
    if (!isBypassEnv(name, value, ctx)) continue;
    if (name.startsWith('GIT_CONFIG')) {
      envHits.push(hit('hooks-path', `${name}=${value}`));
    } else if (name === 'SKIP') {
      if (!progName || SHELLS.has(progName) || ctx.skipSensitivePrograms.has(progName) || program?.dyn) envHits.push(hit('husky-skip', `${name}=${value}`));
    } else {
      envHits.push(hit('husky-skip', `${name}=${value}`));
    }
  }
  if (progName === 'export' || progName === 'declare' || progName === 'typeset' || progName === 'set') {
    for (const a of args) {
      const m = ENV_ASSIGN_RE.exec(a.text);
      if (m && isBypassEnv(m[1], m[2], ctx)) envHits.push(hit(m[1].startsWith('GIT_CONFIG') ? 'hooks-path' : 'husky-skip', `${progName} ${a.text}`));
    }
  }
  for (const h of envHits) if (ctx.rules.has(h.rule)) return h;

  if (!program) return null;

  // ── shell wrappers: bash -c "<script>", eval, source heredocs ──
  if (SHELLS.has(progName)) {
    const cIdx = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
    if (cIdx >= 0 && args[cIdx + 1]) {
      const r = analyzeScript(args[cIdx + 1].text, ctx);
      if (r) return r;
    } else {
      // reads its script from stdin: heredoc / here-string bodies attached to this command.
      for (const body of cmd.stdinTexts) {
        const r = analyzeScript(body, ctx);
        if (r) return r;
      }
      ctx.shellReadsStdin = true;
    }
    return null;
  }
  if (progName === 'eval') {
    return analyzeScript(args.map((a) => a.text).join(' '), ctx);
  }
  if (progName === 'source' || progName === '.') {
    ctx.shellReadsStdin = true;
    return null;
  }

  // ── git ──
  if (progName === 'git' || progName === 'git-stash' || progName === 'hub' || progName === 'gh-git') {
    if (progName === 'git-stash') return ctx.rules.has('git-stash') ? hit('git-stash', 'git-stash') : null;
    const h = analyzeGitArgs(args);
    return h && ctx.rules.has(h.rule) ? h : null;
  }
  // Dynamic program word (`$GIT …`, `$(which git) …`): fail-safe, analyse as git.
  if (program.dyn && /^\$|^`/.test(program.text)) {
    const h = analyzeGitArgs(args);
    return h && ctx.rules.has(h.rule) ? h : null;
  }
  return null;
}

function analyzeScript(text, ctx) {
  if (ctx.depth > 6) return null;
  ctx.depth++;
  try {
    const lex = lexShell(text);
    if (lex.ambiguous) ctx.ambiguous = true;
    for (const cmd of lex.commands) {
      const r = analyzeCommand(cmd, ctx);
      if (r) return r;
    }
    for (const inner of lex.nested) {
      const r = analyzeScript(inner, ctx);
      if (r) return r;
    }
    // `cat <<EOF | bash` / `source <(…)`: a stdin-reading shell anywhere makes every heredoc body executable.
    if (ctx.shellReadsStdin) {
      ctx.shellReadsStdin = false;
      for (const body of lex.heredocBodies) {
        const r = analyzeScript(body, ctx);
        if (r) return r;
      }
    }
    return null;
  } finally {
    ctx.depth--;
  }
}

// Coarse text scan used only when the lexer gave up (unterminated quote / unbalanced `$(`).
const COARSE = [
  ['no-verify', /--no-ve[a-z]*|\bgit\b[^\n]*\bcommit\b[^\n]*\s-[A-Za-mo-z]*n/],
  ['hooks-path', /core\.hookspath/i],
  ['husky-skip', /\bHUSKY\s*=\s*0|\bHUSKY_SKIP_HOOKS\b|\bSKIP\s*=/],
  ['git-stash', /\bgit\b[^\n]*\bstash\b/],
];

/** The effective `config.hookBypassGuard` settings, each key falling back to its default. Never throws. */
export function readHookBypassSettings(config) {
  const defaults = { disabledRules: [], skipSensitivePrograms: [...DEFAULT_SKIP_SENSITIVE_PROGRAMS], extraBypassEnvNames: [], hints: {} };
  try {
    const cfg = (config ?? loadConfig())?.hookBypassGuard ?? {};
    const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    return {
      disabledRules: strings(cfg.disabledRules) ? cfg.disabledRules : defaults.disabledRules,
      skipSensitivePrograms: strings(cfg.skipSensitivePrograms) ? cfg.skipSensitivePrograms : defaults.skipSensitivePrograms,
      extraBypassEnvNames: strings(cfg.extraBypassEnvNames) ? cfg.extraBypassEnvNames : defaults.extraBypassEnvNames,
      hints: cfg.hints && typeof cfg.hints === 'object' && !Array.isArray(cfg.hints) ? cfg.hints : defaults.hints,
    };
  } catch {
    return defaults; // unreadable config: use the defaults
  }
}

/**
 * Decide a shell command string. Returns { allow:true } or { allow:false, rule, reason }.
 * `options` takes the same keys as `config.hookBypassGuard` (`disabledRules`, `skipSensitivePrograms`,
 * `extraBypassEnvNames`, `hints`); a disabled rule behaves as if deleted (the tests use that as a mutation proof).
 */
export function decideHookBypass(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0) return { allow: true };
  const disabled = options.disabledRules ?? [];
  const rules = new Set(RULE_IDS.filter((r) => !disabled.includes(r)));
  const ctx = {
    rules,
    depth: 0,
    ambiguous: false,
    shellReadsStdin: false,
    skipSensitivePrograms: new Set(options.skipSensitivePrograms ?? DEFAULT_SKIP_SENSITIVE_PROGRAMS),
    extraBypassEnvNames: new Set(options.extraBypassEnvNames ?? []),
  };
  const found = analyzeScript(command, ctx);
  if (found) return { allow: false, rule: found.rule, reason: buildReason(found.rule, found.detail, options.hints) };
  if (ctx.ambiguous && /\bgit\b|\$\{?\w*GIT/i.test(command)) {
    for (const [rule, re] of COARSE) {
      if (rules.has(rule) && re.test(command)) {
        return { allow: false, rule, reason: buildReason(rule, '(unparseable command containing a hook-bypass token next to git)', options.hints) };
      }
    }
  }
  return { allow: true };
}

export function decideHookBypassTool({ toolName, toolInput }, options) {
  if (toolName !== 'Bash') return { allow: true };
  try {
    return decideHookBypass(toolInput?.command, options);
  } catch {
    return { allow: true }; // fail open on a guard bug
  }
}

export function formatHookOutput(decision) {
  if (decision.allow) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}
