// orchestration/dispatch-guard.mjs
//
// Decision logic for a Claude Code PreToolUse hook on the Agent/Task tool. The orchestration skill says
// every dispatch sets the worker model explicitly and never inherits the caller's tier; written rules alone
// were skipped often enough to burn quota, so this hook enforces the rule at dispatch time.
//
// Rules (ids are stable; `config.dispatchGuard.disabledRules` switches one off):
//   explicit-model -- the call carries no `model`, and its `subagent_type` names no role definition
//                     (project or user `.claude/agents/<type>.md`) that pins a model other than `inherit`.
//   opus-sub-planner-only -- the effective model (explicit `model`, else the role's pinned model) is an Opus
//                     model and `subagent_type` is not `sub-planner`.
//   fork-dispatch  -- `subagent_type: "fork"` always runs on the caller's model with its full context, so it
//                     can neither set a worker model nor provide an isolated reviewer.
//
// Cloud sessions: `mcp__claude-code-remote__create_session` (or any tool ending in `__create_session`) is a
// dispatch too. `explicit-model` requires a non-empty `model`; `opus-sub-planner-only` allows Opus only when
// `tags` contains `sub-planner`.
//
// Fails open: an unreadable input, config or role file never blocks a dispatch on a guard bug. Codex
// dispatches and agents started from workflow scripts do not pass through this hook.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../worktrees/config.mjs';
import { parseRole } from './roles.mjs';

export const RULE_IDS = Object.freeze(['explicit-model', 'fork-dispatch', 'opus-sub-planner-only']);
export const CLOUD_SESSION_TOOL = 'mcp__claude-code-remote__create_session';
export const GUARDED_TOOL_NAMES = Object.freeze(['Agent', 'Task', CLOUD_SESSION_TOOL]);
const isCloudSessionTool = (name) => typeof name === 'string' && (name === CLOUD_SESSION_TOOL || name.endsWith('__create_session'));
const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const REASONS = {
  'explicit-model':
    'Dispatch blocked by the vibe-coding-kit dispatch guard (explicit-model): set `model` on this call, or use a role definition that pins one (for example the kit roles `module-owner` or `explorer`). Every dispatch sets the worker model explicitly instead of inheriting the caller\'s tier; see agent-orchestration-guardrails, Worker Model Selection.',
  'fork-dispatch':
    'Dispatch blocked by the vibe-coding-kit dispatch guard (fork-dispatch): a `fork` always runs on the caller\'s model and carries its full context, so it cannot set a worker model or serve as an isolated reviewer. Dispatch a fresh agent with `model` set, or a kit role such as `reviewer`.',
  'opus-sub-planner-only':
    'Dispatch blocked by the vibe-coding-kit dispatch guard (opus-sub-planner-only): only the `sub-planner` role may use Opus. Use `sonnet` for executors and reviewers (independent, isolated context) and `haiku` for read-only exploration; see agent-orchestration-guardrails, Worker Model Selection.',
  'cloud-explicit-model':
    'Cloud session creation blocked by the vibe-coding-kit dispatch guard (explicit-model): creating a cloud/remote session must pass an explicit `model` (default `sonnet`) and must not inherit the coordinator\'s tier; see agent-orchestration-guardrails, Cloud / remote sessions.',
  'cloud-opus-sub-planner-only':
    'Cloud session creation blocked by the vibe-coding-kit dispatch guard (opus-sub-planner-only): only a session acting as a sub-planner may use Opus, and it must carry the `sub-planner` tag in `tags`. Use `sonnet` for execution sessions; see agent-orchestration-guardrails, Cloud / remote sessions.',
};

const isOpus = (model) => typeof model === 'string' && model.toLowerCase().includes('opus');

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

function reasonFor(rule, hints, key = rule) {
  const hint = hints && typeof hints[rule] === 'string' && hints[rule].trim() ? ` ${hints[rule].trim()}` : '';
  return `${REASONS[key]}${hint}`;
}

/**
 * Decide one tool call. Returns { allow: true } or { allow: false, rule, reason }.
 * `options`: { disabledRules, hints, agentDirs }.
 */
export function decideDispatch({ toolName, toolInput }, options = {}) {
  const cloud = isCloudSessionTool(toolName);
  if (!cloud && !GUARDED_TOOL_NAMES.includes(toolName)) return { allow: true };
  try {
    const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
    const disabled = new Set(options.disabledRules ?? []);
    if (cloud) {
      const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
      if (!model) {
        return disabled.has('explicit-model') ? { allow: true } : { allow: false, rule: 'explicit-model', reason: reasonFor('explicit-model', options.hints, 'cloud-explicit-model') };
      }
      const tags = Array.isArray(input.tags) ? input.tags : [];
      if (!disabled.has('opus-sub-planner-only') && isOpus(model) && !tags.includes('sub-planner')) {
        return { allow: false, rule: 'opus-sub-planner-only', reason: reasonFor('opus-sub-planner-only', options.hints, 'cloud-opus-sub-planner-only') };
      }
      return { allow: true };
    }
    const type = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
    if (type === 'fork') {
      return disabled.has('fork-dispatch') ? { allow: true } : { allow: false, rule: 'fork-dispatch', reason: reasonFor('fork-dispatch', options.hints) };
    }
    const explicit = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
    const pinned = type ? pinnedRoleModel(type, options.agentDirs ?? []) : null;
    if (!disabled.has('opus-sub-planner-only') && type !== 'sub-planner' && isOpus(explicit ?? pinned)) {
      return { allow: false, rule: 'opus-sub-planner-only', reason: reasonFor('opus-sub-planner-only', options.hints) };
    }
    if (disabled.has('explicit-model')) return { allow: true };
    if (explicit) return { allow: true };
    if (pinned) return { allow: true };
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
