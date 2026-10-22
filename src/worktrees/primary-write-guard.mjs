// worktree-guard/primary-write-guard.mjs
//
// Decision logic for a Claude Code PreToolUse hook that DENIES file-writing tool
// calls (Edit / Write / NotebookEdit / MultiEdit) whose target path lives inside
// the PRIMARY checkout of the repository.
//
// Why: a session (and every subagent it spawns) starts with its cwd in the primary
// checkout, and the file tools take absolute paths. An AI that forgot to `cd` into
// its worktree, or that reuses an absolute path from older context, silently dirties
// the shared checkout. Git-level hooks only see refs and index operations, never a
// plain file write, so this PreToolUse hook is the only place that can stop it.
//
// Known gap (on purpose): shell commands that write files (`>`, `sed -i`, `tee`...)
// are NOT inspected. Parsing shell reliably needs a real parser, and a hand-written
// lexer produces false positives that block legitimate work. Rely on the written
// worktree rule for Bash; this guard covers the structured file tools only.
//
// Primary root = dirname of `git rev-parse --git-common-dir`, resolved from the
// hook's cwd. That works from the primary and from any linked worktree. Both sides
// are compared after realpath, so a symlinked temp dir (macOS /tmp -> /private/tmp)
// cannot hide a path. A linked worktree's toplevel is a different directory tree than
// the primary's, but a worktree may be nested INSIDE the primary directory, so a path
// that falls inside any other registered worktree is never treated as primary-owned.
//
// Fails OPEN: if the primary cannot be resolved, or the input is unusable, the call is
// allowed. This is a mechanical backstop, not a security boundary.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadConfig } from './config.mjs';

// The PreToolUse `matcher` in claude-settings-snippet.json must list exactly these
// names; primary-write-guard.test.mjs asserts the two stay in sync.
export const GUARDED_TOOL_NAMES = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Paths (relative to the primary root) that may still be written in place.
export const DEFAULT_ALLOW_PREFIXES = Object.freeze(['.workspace/']);

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// realpath of a path that may not exist yet (a Write creating a new file): resolve the
// deepest existing ancestor and re-append the missing tail.
function realpathLenient(p) {
  const tail = [];
  let current = resolve(p);
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return join(real, ...tail.reverse());
    const parent = dirname(current);
    if (parent === current) return null;
    tail.push(basename(current));
    current = parent;
  }
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Primary checkout toplevel (realpath), or null when it cannot be resolved. */
export function resolvePrimaryRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!out) return null;
  const common = realpathOrNull(resolve(cwd, out.trim()));
  // A normal clone's common dir is `<primary>/.git`; anything else (bare repo,
  // submodule gitdir) has no primary toplevel to protect.
  return common && basename(common) === '.git' ? dirname(common) : null;
}

function otherWorktreeRoots(cwd, primaryRoot) {
  const out = git(cwd, ['worktree', 'list', '--porcelain']) ?? '';
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathOrNull(line.slice('worktree '.length).trim()))
    .filter((root) => root && root !== primaryRoot);
}

/** `config.primaryWriteGuard.allowPrefixes`, falling back to the default. Never throws. */
export function readAllowPrefixes(config) {
  try {
    const cfg = config ?? loadConfig();
    const list = cfg?.primaryWriteGuard?.allowPrefixes;
    if (Array.isArray(list) && list.every((p) => typeof p === 'string')) return list;
  } catch {
    // Unreadable config: use the default.
  }
  return [...DEFAULT_ALLOW_PREFIXES];
}

function matchesPrefix(relPath, prefixes) {
  const rel = relPath.split(sep).join('/');
  return prefixes.some((raw) => {
    const prefix = raw.replace(/^\.\//, '');
    return prefix.endsWith('/') ? rel.startsWith(prefix) || `${rel}/` === prefix : rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

function denyReason(path) {
  return [
    `Blocked: ${path} is inside the shared primary checkout, which must stay clean.`,
    'Do not write there. cd into the managed worktree created by `worktree:begin`',
    '(create one first if you have none) and retry the same edit with the path under',
    "that worktree's root.",
  ].join(' ');
}

/**
 * @param {{toolName?: string, toolInput?: object, cwd?: string, allowPrefixes?: string[]}} p
 * @returns {{allow: true} | {allow: false, reason: string}}
 */
export function decidePrimaryWrite({ toolName, toolInput, cwd, allowPrefixes } = {}) {
  try {
    if (!GUARDED_TOOL_NAMES.includes(toolName)) return { allow: true };
    const raw = toolInput?.file_path ?? toolInput?.notebook_path;
    if (typeof raw !== 'string' || raw === '') return { allow: true };

    const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
    const primary = resolvePrimaryRoot(base);
    if (!primary) return { allow: true };

    const target = realpathLenient(isAbsolute(raw) ? raw : resolve(base, raw));
    if (!target || !isInside(primary, target)) return { allow: true };
    if (otherWorktreeRoots(base, primary).some((root) => isInside(root, target))) return { allow: true };
    if (matchesPrefix(relative(primary, target), allowPrefixes ?? readAllowPrefixes())) return { allow: true };
    return { allow: false, reason: denyReason(target) };
  } catch {
    return { allow: true };
  }
}

/** Claude Code PreToolUse output. A deny carries only the reason (no `continue:false`). */
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
