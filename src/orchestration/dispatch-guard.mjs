// orchestration/dispatch-guard.mjs
//
// Decision logic for a Claude Code PreToolUse hook on the Agent/Task tool. The orchestration skill says
// every dispatch sets the worker model explicitly and never inherits the caller's tier; written rules alone
// were skipped often enough to burn quota, so this hook enforces the rule at dispatch time.
//
// Rules (ids are stable; `config.dispatchGuard.disabledRules` switches one off):
//   explicit-model -- the call carries no `model`, and its `subagent_type` names no role definition
//                     (project or user `.claude/agents/<type>.md`) that pins a model other than `inherit`.
//   fork-dispatch  -- `subagent_type: "fork"` always runs on the caller's model with its full context, so it
//                     can neither set a worker model nor provide an isolated reviewer.
//
// Fails open: an unreadable input, config or role file never blocks a dispatch on a guard bug. Codex
// dispatches and agents started from workflow scripts do not pass through this hook.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../worktrees/config.mjs';
import { parseRole } from './roles.mjs';

export const RULE_IDS = Object.freeze(['explicit-model', 'fork-dispatch']);
export const GUARDED_TOOL_NAMES = Object.freeze(['Agent', 'Task']);
const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const REASONS = {
  'explicit-model':
    'Dispatch blocked by the vibe-coding-kit dispatch guard (explicit-model): set `model` on this call, or use a role definition that pins one (for example the kit roles `module-owner` or `explorer`). Every dispatch sets the worker model explicitly instead of inheriting the caller\'s tier; see agent-orchestration-guardrails, Worker Model Selection.',
  'fork-dispatch':
    'Dispatch blocked by the vibe-coding-kit dispatch guard (fork-dispatch): a `fork` always runs on the caller\'s model and carries its full context, so it cannot set a worker model or serve as an isolated reviewer. Dispatch a fresh agent with `model` set, or a kit role such as `reviewer`.',
};

/** The effective `config.dispatchGuard` settings, each key falling back to its default. Never throws. */
export function readDispatchGuardSettings(config) {
  const defaults = { disabledRules: [], hints: {} };
  try {
    const cfg = (config ?? loadConfig())?.dispatchGuard ?? {};
    const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    return {
      disabledRules: strings(cfg.disabledRules) ? cfg.disabledRules : defaults.disabledRules,
      hints: cfg.hints && typeof cfg.hints === 'object' && !Array.isArray(cfg.hints) ? cfg.hints : defaults.hints,
    };
  } catch {
    return defaults;
  }
}

/**
 * The model a role definition pins, or null. Looks in each directory in order (project first, then user)
 * for `<name>.md`; a name with a namespace (`plugin:agent`) or path characters is never resolved.
 */
export function pinnedRoleModel(name, agentDirs) {
  if (typeof name !== 'string' || !ROLE_NAME_RE.test(name)) return null;
  for (const dir of agentDirs) {
    if (!dir) continue;
    const path = join(dir, `${name}.md`);
    try {
      if (!existsSync(path)) continue;
      const model = parseRole(`${name}.md`, readFileSync(path, 'utf8')).fields.model;
      return model && model !== 'inherit' ? model : null;
    } catch {
      return null; // malformed role file: treat as unpinned, the caller can still pass `model`
    }
  }
  return null;
}

/** Role directories for a hook invocation: the project's `.claude/agents`, then the user's. */
export function defaultAgentDirs({ projectDir, home = homedir() } = {}) {
  return [projectDir ? join(projectDir, '.claude', 'agents') : null, home ? join(home, '.claude', 'agents') : null];
}

function reasonFor(rule, hints) {
  const hint = hints && typeof hints[rule] === 'string' && hints[rule].trim() ? ` ${hints[rule].trim()}` : '';
  return `${REASONS[rule]}${hint}`;
}

/**
 * Decide one tool call. Returns { allow: true } or { allow: false, rule, reason }.
 * `options`: { disabledRules, hints, agentDirs }.
 */
export function decideDispatch({ toolName, toolInput }, options = {}) {
  if (!GUARDED_TOOL_NAMES.includes(toolName)) return { allow: true };
  try {
    const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
    const disabled = new Set(options.disabledRules ?? []);
    const type = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
    if (type === 'fork') {
      return disabled.has('fork-dispatch') ? { allow: true } : { allow: false, rule: 'fork-dispatch', reason: reasonFor('fork-dispatch', options.hints) };
    }
    if (disabled.has('explicit-model')) return { allow: true };
    if (typeof input.model === 'string' && input.model.trim()) return { allow: true };
    if (type && pinnedRoleModel(type, options.agentDirs ?? [])) return { allow: true };
    return { allow: false, rule: 'explicit-model', reason: reasonFor('explicit-model', options.hints) };
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
