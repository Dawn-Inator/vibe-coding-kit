// worktree-guard/hooks.mjs
//
// Generation and installation of the two git `reference-transaction` hooks
// this toolkit ships:
//
//   - stash-guard: installed on every MANAGED (linked) worktree. Blocks
//     `git stash push/pop/drop/store/clear` because refs/stash is one ref
//     shared by every worktree of a repository -- a stash op from worktree A
//     can clobber worktree B's shelved changes.
//   - primary-lock: installed once on the PRIMARY (main) worktree. Blocks a
//     non-human AI context (an AI CLI process, or a script-runtime process
//     launched from inside an AI CLI tool's own install directory) from
//     writing git refs directly on the primary worktree.
//
// Both hooks work the same way: `git config --worktree core.hooksPath
// <dir>` redirects hook lookups to a directory that exists only for one
// worktree (github.com/git/git Documentation/git-worktree -- per-worktree
// config requires `git config extensions.worktreeConfig true` first, which
// is the one shared-config write either install function performs). Because
// this hijacks core.hooksPath -- which may already be pointed at a real
// hook manager such as husky -- both install functions ALSO write forwarding
// shims for every standard client-side hook name so nothing else silently
// stops firing.
//
// Node built-ins only, zero third-party dependencies, ESM.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { samePathIdentity } from '../lib/path-identity.mjs';

// ---------------------------------------------------------------------------
// Small git/process helpers (deliberately self-contained -- this module does
// not import worktree-core.mjs, which is being written in parallel).
// ---------------------------------------------------------------------------

/**
 * Run a git command and return {status, stdout, stderr} (stdout/stderr
 * trimmed). Throws on non-zero exit unless options.allowFailure is true.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {{allowFailure?: boolean, env?: NodeJS.ProcessEnv}} [options]
 */
function runGit(args, cwd, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(' ')} failed (status ${result.status}) in ${cwd}: ${stderr || stdout}`,
    );
  }
  return { status: result.status, stdout, stderr };
}

/**
 * Absolute path to this worktree's own git dir (NOT the common dir -- a
 * linked worktree's `.git` is a file pointing elsewhere, so this always
 * asks git rather than assuming `<worktreePath>/.git` is a directory).
 *
 * @param {string} worktreePath
 * @returns {string}
 */
function gitDirAbsoluteForWorktree(worktreePath) {
  const gitDir = runGit(['rev-parse', '--git-dir'], worktreePath).stdout;
  return isAbsolute(gitDir) ? gitDir : resolve(worktreePath, gitDir);
}

/**
 * Absolute path to the repository's common git dir (shared by every
 * worktree of the repository -- where refs/stash, refs/heads, and the
 * shared `config` file live).
 *
 * @param {string} worktreePath
 * @returns {string}
 */
function gitCommonDirAbsolute(worktreePath) {
  const commonDir = runGit(['rev-parse', '--git-common-dir'], worktreePath).stdout;
  return isAbsolute(commonDir) ? commonDir : resolve(worktreePath, commonDir);
}

function stashGuardHooksDir(worktreePath) {
  return join(gitDirAbsoluteForWorktree(worktreePath), 'stash-guard-hooks');
}

function primaryLockHooksDir(primaryPath) {
  return join(gitDirAbsoluteForWorktree(primaryPath), 'primary-lock-hooks');
}

function resolveMaybeRelative(worktreePath, value) {
  return isAbsolute(value) ? value : resolve(worktreePath, value);
}

function setHookExecutable(path) {
  // Windows permissions are ACL based; Git for Windows runs hook scripts via
  // its bundled POSIX shell and enforces the file's Windows ACL.
  if (process.platform !== 'win32') chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// §A stash-guard hook
// ---------------------------------------------------------------------------

// NOTE: this template intentionally contains no `${...}` JS interpolation --
// every variable spot is a `@@TOKEN@@` literal substituted with
// String.prototype.replaceAll, so genuine bash `$var` / `${var}` syntax can
// be written verbatim below without fighting JS template-literal escaping.
const STASH_GUARD_HOOK_TEMPLATE = `#!/bin/sh
# Installed by the worktree-guard tool. Regenerated on every worktree create --
# do not hand-edit.
#
# refs/stash is one ref shared by every worktree of this repository. Git honors
# this hook's exit status only in the "prepared" state (githooks(5)), which is
# enough to abort the transaction before it commits -- so a \`git stash\`
# push/pop/apply/drop/clear run from this worktree is rejected before it can
# touch or destroy another worktree's shelved changes.
#
# Known gap (by design, not a bug): \`git stash apply\` does NOT update
# refs/stash at all -- it only merges the stashed tree into the working copy
# and index. This hook only ever sees a "prepared" ref-transaction event, so
# it cannot and does not block \`apply\`; it blocks push/drop/store/clear,
# the half of the stash surface that actually mutates the shared ref.
#
# Exception: @@STASH_GUARD_ALLOW_ENV@@=1, set only by this same directory's forwarding
# shims right before they exec a real git hook -- real-world tools legitimately
# use a short-lived internal \`git stash\` as an atomic backup/restore within a
# single git-hook run. A plain interactive \`git stash\` typed by a worker never
# has this env var set, so it is still blocked exactly as before.
[ "$@@STASH_GUARD_ALLOW_ENV@@" = "1" ] && exit 0
state="$1"
[ "$state" = "prepared" ] || exit 0
blocked=0
while IFS=" " read -r old new ref; do
  if [ "$ref" = "refs/stash" ]; then
    blocked=1
  fi
done
if [ "$blocked" = "1" ]; then
  echo "[worktree-guard] BLOCKED: git stash is disabled in managed worktrees -- refs/stash is shared across every worktree of this repo." >&2
  echo "[worktree-guard] Save instead:   git diff > /tmp/patch.diff" >&2
  echo "[worktree-guard] Discard instead: git restore <path>   (or: git checkout -- <path>)" >&2
  echo "[worktree-guard] Restore later:   git apply /tmp/patch.diff" >&2
  exit 64
fi
exit 0
`;

/**
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function stashGuardHookScript(config) {
  return STASH_GUARD_HOOK_TEMPLATE.replaceAll(
    '@@STASH_GUARD_ALLOW_ENV@@',
    config.envVars.stashGuardAllow,
  );
}

const HUSKY_FORWARD_SHIM_TEMPLATE = `#!/bin/sh
# Installed by the worktree-guard tool. This worktree's core.hooksPath points
# here so the reference-transaction hook next to this file can block \`git
# stash\`; every other hook is forwarded to the project's own real hook
# directory unchanged.
export @@STASH_GUARD_ALLOW_ENV@@=1
__wtg_rel='@@REAL_HOOKS_REL_TEMPLATE@@'
case "$__wtg_rel" in
  /*)
    target="$__wtg_rel"
    ;;
  *)
    __wtg_top=$(git rev-parse --show-toplevel 2>/dev/null)
    target="$__wtg_top/$__wtg_rel"
    ;;
esac
[ -f "$target" ] || exit 0
exec "$target" "$@"
`;

/**
 * @param {string} hookName
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function huskyForwardShimScript(hookName, config) {
  const relTemplate = config.realHooksPathTemplate.replaceAll('{{hookName}}', hookName);
  return HUSKY_FORWARD_SHIM_TEMPLATE
    .replaceAll('@@STASH_GUARD_ALLOW_ENV@@', config.envVars.stashGuardAllow)
    .replaceAll('@@REAL_HOOKS_REL_TEMPLATE@@', relTemplate);
}

/**
 * @param {string} worktreePath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 */
export function installStashGuardHook(worktreePath, config) {
  runGit(['config', 'extensions.worktreeConfig', 'true'], worktreePath, { allowFailure: true });
  const hooksDir = stashGuardHooksDir(worktreePath);
  mkdirSync(hooksDir, { recursive: true });

  const hookFile = join(hooksDir, 'reference-transaction');
  writeFileSync(hookFile, stashGuardHookScript(config));
  setHookExecutable(hookFile);

  for (const hookName of config.forwardedHookNames) {
    const shimFile = join(hooksDir, hookName);
    writeFileSync(shimFile, huskyForwardShimScript(hookName, config));
    setHookExecutable(shimFile);
  }

  runGit(['config', '--worktree', 'core.hooksPath', hooksDir], worktreePath);
}

/**
 * @param {string} worktreePath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {{installed: boolean, hooksPath: string|null, intact: boolean}}
 */
export function stashGuardStatus(worktreePath, config) {
  const res = runGit(['config', '--worktree', '--get', 'core.hooksPath'], worktreePath, {
    allowFailure: true,
  });
  if (res.status !== 0 || !res.stdout) {
    return { installed: false, hooksPath: null, intact: false };
  }

  const hooksPath = res.stdout;
  const expectedHooksDir = stashGuardHooksDir(worktreePath);
  const absoluteHooksPath = resolveMaybeRelative(worktreePath, hooksPath);
  const installed = samePathIdentity(absoluteHooksPath, expectedHooksDir);

  let intact = false;
  if (installed) {
    const hookFile = join(expectedHooksDir, 'reference-transaction');
    if (existsSync(hookFile)) {
      intact = readFileSync(hookFile, 'utf8') === stashGuardHookScript(config);
    }
  }

  return { installed, hooksPath, intact };
}

// ---------------------------------------------------------------------------
// §B primary-lock hook
// ---------------------------------------------------------------------------

const PRIMARY_LOCK_HOOK_TEMPLATE = `#!/bin/sh
# Installed by the worktree-guard tool. Regenerated by installPrimaryLockHook /
# refreshPrimaryLockHookIfStale -- do not hand-edit.
#
# Blocks a non-human AI context (an AI CLI process, or a script-runtime
# process launched from inside an AI CLI tool's own install directory) from
# writing git refs directly on the PRIMARY worktree. AI sessions must only
# write inside their own managed worktree, or through the sync-primary
# command -- never a raw git command here. Fires in the "prepared" state of
# the reference-transaction hook, which git honors before the transaction
# commits (githooks(5)).
AUDIT_LOG='@@AUDIT_LOG@@'
BYPASS_TOKEN='@@BYPASS_TOKEN@@'
PRIMARY_ROOT='@@PRIMARY_ROOT@@'
HOOKS_DIR='@@HOOKS_DIR@@'
state="$1"
[ "$state" = "prepared" ] || exit 0

current_toplevel=$(git rev-parse --show-toplevel 2>/dev/null)
[ "$current_toplevel" = "$PRIMARY_ROOT" ] || exit 0

pid="$PPID"
depth=0
chain=""
is_ai_ancestor=0
while [ -n "$pid" ] && [ "$depth" -lt 8 ]; do
  line=$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-200)
  [ -z "$line" ] && break
  if [ -z "$chain" ]; then chain="$line"; else chain="$chain <- $line"; fi
  # Handle both POSIX command lines and Windows process paths. Git for Windows
  # reports backslash-separated paths, which POSIX basename/dirname otherwise
  # treat as a single filename. Quoted executable and script paths preserve
  # spaces in common Windows command-line output.
  executable=$(printf '%s\n' "$line" | sed -n 's/^"\\([^"]*\\)".*/\\1/p')
  [ -n "$executable" ] || executable=$(printf '%s\n' "$line" | awk '{print $1}')
  executable_path=$(printf '%s' "$executable" | tr '\\' '/')
  exe_base=$(basename "$executable_path" 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/\\.exe$//')
  case "$exe_base" in
    # Git is a transport wrapper rather than the user process whose context
    # determines the policy. Ignore it without consuming the bounded walk.
    git)
      ;;
    *)
      case "$exe_base" in
        @@AI_CLI_PATTERN@@)
          is_ai_ancestor=1
          ;;
        @@SCRIPT_RUNTIME_PATTERN@@)
          # Multi-layer ancestor directory-segment walk: an AI CLI tool's
          # home directory (e.g. ~/.claude) can be an arbitrary number of
          # levels above the script file that a globally-installed CLI
          # actually execs (e.g. ~/.claude/local/cli.js -- ".claude" is
          # cli.js's GRANDPARENT, not its direct parent). Every ancestor
          # directory segment of the script path is checked as a WHOLE
          # segment (never a substring of a longer name) so a lane directory
          # like "claude-scratch-lane-abc123" can never false-positive. This
          # MUST stay behaviorally identical to matchesAiParentProcess() in
          # process-provenance.mjs, which performs the same whole-segment
          # walk over every dirname() component of the script path.
          quoted_executable=$(printf '"%s"' "$executable")
          case "$line" in
            "$quoted_executable"*) args=\${line#"$quoted_executable"} ;;
            *) args=$(printf '%s\n' "$line" | sed 's/^[^[:space:]]*[[:space:]]*//') ;;
          esac
          args=$(printf '%s\n' "$args" | sed 's/^[[:space:]]*//')
          second_word=$(printf '%s\n' "$args" | sed -n 's/^"\\([^"]*\\)".*/\\1/p')
          [ -n "$second_word" ] || second_word=$(printf '%s\n' "$args" | awk '{print $1}')
          second_word=$(printf '%s' "$second_word" | tr '\\' '/')
          walk_dir=$(dirname "$second_word" 2>/dev/null)
          walked=0
          while [ -n "$walk_dir" ] && [ "$walk_dir" != "/" ] && [ "$walk_dir" != "." ] && [ "$walked" -lt 10 ]; do
            seg_base=$(basename "$walk_dir" 2>/dev/null | tr '[:upper:]' '[:lower:]')
            # A directory segment like ".claude" is treated as equivalent to
            # the bare tool name "claude" -- strip at most one leading dot,
            # mirroring normalizeDirSegment() in process-provenance.mjs.
            seg_base=\${seg_base#.}
            case "$seg_base" in
              @@AI_CLI_PATTERN@@)
                is_ai_ancestor=1
                break
                ;;
            esac
            walk_dir=$(dirname "$walk_dir" 2>/dev/null)
            walked=$((walked + 1))
          done
          ;;
      esac
      ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  depth=$((depth + 1))
done
[ -z "$chain" ] && chain="-"

bypass_marker_found=0
if [ -d "$HOOKS_DIR" ]; then
  for marker in "$HOOKS_DIR"/.bypass-*.marker; do
    [ -e "$marker" ] || continue
    if [ -n "$(find "$marker" -mmin -2 2>/dev/null)" ]; then
      bypass_marker_found=1
      break
    fi
  done
fi

decision="allowed"
reason="human-or-unrecognized-context"
role_val="\${@@WORKER_ROLE_ENV@@:--}"
if [ "$@@PRIMARY_LOCK_BYPASS_ENV@@" = "$BYPASS_TOKEN" ]; then
  decision="allowed"
  reason="guard-internal-bypass"
elif [ "$bypass_marker_found" = "1" ]; then
  decision="allowed"
  reason="guard-internal-bypass-marker"
elif [ "$role_val" = "worker" ] || [ "$is_ai_ancestor" = "1" ]; then
  if [ "$@@PRIMARY_LOCK_ALLOW_ENV@@" = "1" ]; then
    decision="allowed"
    reason="escape-hatch-@@PRIMARY_LOCK_ALLOW_ENV@@"
  else
    decision="blocked"
    reason="ai-context(role=$role_val,ancestor-match=$is_ai_ancestor)"
  fi
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)
final_block=0
while IFS=" " read -r old new ref; do
  [ -z "$ref" ] && continue
  case "$ref" in
    HEAD|ORIG_HEAD|AUTO_MERGE|MERGE_HEAD|REBASE_HEAD)
      ref_decision="$decision"; ref_reason="$reason"
      ;;
    @@BRANCH_PREFIX_PATTERN@@)
      ref_decision="$decision"; ref_reason="$reason"
      if [ "$new" = "0000000000000000000000000000000000000000" ] && [ "$decision" = "allowed" ] && [ "$reason" = "guard-internal-bypass" ]; then
        ref_reason="guard-branch-cleanup"
      fi
      ;;
    refs/heads/*)
      ref_decision="$decision"; ref_reason="$reason"
      ;;
    refs/remotes/*)
      ref_decision="allowed"; ref_reason="remote-tracking-ref"
      ;;
    refs/tags/*)
      ref_decision="allowed"; ref_reason="tag-ref"
      ;;
    refs/stash)
      ref_decision="allowed"; ref_reason="stash-ref"
      ;;
    refs/@@INTERNAL_REF_NAMESPACE@@/*)
      ref_decision="allowed"; ref_reason="internal-ref"
      ;;
    refs/notes/*)
      ref_decision="allowed"; ref_reason="notes-ref"
      ;;
    *)
      ref_decision="$decision"; ref_reason="$reason"
      ;;
  esac
  [ "$ref_decision" = "blocked" ] && final_block=1
  printf '%s\tref=%s\told=%s\tnew=%s\tdecision=%s\treason=%s\tppid=%s\tancestors=%s\n' \\
    "$ts" "$ref" "$old" "$new" "$ref_decision" "$ref_reason" "$PPID" "$chain" \\
    >> "$AUDIT_LOG" 2>/dev/null
done

if [ "$final_block" = "1" ]; then
  echo "[worktree-guard] BLOCKED: a non-human AI context attempted a git ref change directly on the PRIMARY worktree." >&2
  echo "[worktree-guard] AI sessions must only write inside their OWN managed worktree, or through the sync-primary command -- never a raw git command on primary." >&2
  echo "[worktree-guard] reason=$reason ancestors=[$chain]" >&2
  echo "[worktree-guard] Legitimate human/orchestrator override: @@PRIMARY_LOCK_ALLOW_ENV@@=1 <cmd>" >&2
  echo "[worktree-guard] Audit trail: $AUDIT_LOG" >&2
  exit 64
fi
exit 0
`;

/**
 * @param {string} primaryPath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function primaryAuditLogPath(primaryPath, config) {
  return join(gitCommonDirAbsolute(primaryPath), config.primaryAuditLogFilename);
}

function unstampedPrimaryLockHookScript(primaryPath, config) {
  const primaryRoot = runGit(['rev-parse', '--show-toplevel'], primaryPath).stdout;
  const hooksDir = primaryLockHooksDir(primaryPath);
  const auditLog = primaryAuditLogPath(primaryPath, config);
  const aiCliPattern = config.aiCliExecutableNames.join('|');
  const scriptRuntimePattern = config.scriptRuntimeExecutableNames.join('|');
  const branchPrefixPattern = Object.values(config.tools)
    .map((tool) => `refs/heads/${tool.prefix}*`)
    .join('|');

  return PRIMARY_LOCK_HOOK_TEMPLATE
    .replaceAll('@@AUDIT_LOG@@', auditLog)
    .replaceAll('@@BYPASS_TOKEN@@', config.primaryLockBypassToken)
    .replaceAll('@@PRIMARY_ROOT@@', primaryRoot)
    .replaceAll('@@HOOKS_DIR@@', hooksDir)
    .replaceAll('@@AI_CLI_PATTERN@@', aiCliPattern)
    .replaceAll('@@SCRIPT_RUNTIME_PATTERN@@', scriptRuntimePattern)
    .replaceAll('@@WORKER_ROLE_ENV@@', config.envVars.workerRole)
    .replaceAll('@@PRIMARY_LOCK_BYPASS_ENV@@', config.envVars.primaryLockBypass)
    .replaceAll('@@PRIMARY_LOCK_ALLOW_ENV@@', config.envVars.primaryLockAllow)
    .replaceAll('@@INTERNAL_REF_NAMESPACE@@', config.internalRefNamespace)
    .replaceAll('@@BRANCH_PREFIX_PATTERN@@', branchPrefixPattern);
}

/**
 * @param {string} primaryPath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function primaryLockHookScript(primaryPath, config) {
  const body = unstampedPrimaryLockHookScript(primaryPath, config);
  const stamp = computeStamp(body);
  const lines = body.split('\n');
  lines.splice(1, 0, `# STAMP: ${stamp}`);
  return lines.join('\n');
}

/**
 * Stamp = "<contentHash12>-<generatorHash12>": a sha256-derived fingerprint
 * used purely for idempotency (install functions skip rewriting a file whose
 * freshly-regenerated content is byte-identical to what is already on disk).
 * `scriptBody` must be the rendered script WITHOUT the stamp line itself
 * (callers always compute the stamp before inserting it).
 *
 * @param {string} scriptBody
 * @returns {string}
 */
export function computeStamp(scriptBody) {
  const contentHash = createHash('sha256').update(scriptBody, 'utf8').digest('hex').slice(0, 12);
  const generatorHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex')
    .slice(0, 12);
  return `${contentHash}-${generatorHash}`;
}

function writeIfChanged(filePath, content, mode) {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) {
    return false;
  }
  writeFileSync(filePath, content);
  // Windows permissions are ACL based; chmod's POSIX executable bits are not
  // an authorization boundary there. Git for Windows invokes hooks through its
  // bundled POSIX shell and the existing Windows ACL controls access.
  if (process.platform !== 'win32') chmodSync(filePath, mode);
  return true;
}

/**
 * Fresh install or refresh: (re)generates the primary-lock hook and its
 * husky-forwarding shims, writing only the files whose content actually
 * changed, then points this worktree's core.hooksPath at them.
 *
 * @param {string} primaryPath
 * @param {string} lockedBy Free-form identity string recorded as metadata
 *   (e.g. an orchestrator session id) -- stored in worktree-level git config
 *   under `<configNamespace>.primaryLockedBy`, never embedded in the hook
 *   script itself.
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 */
export function installPrimaryLockHook(primaryPath, lockedBy, config) {
  runGit(['config', 'extensions.worktreeConfig', 'true'], primaryPath, { allowFailure: true });
  const hooksDir = primaryLockHooksDir(primaryPath);
  mkdirSync(hooksDir, { recursive: true });

  const hookFile = join(hooksDir, 'reference-transaction');
  writeIfChanged(hookFile, primaryLockHookScript(primaryPath, config), 0o755);

  for (const hookName of config.forwardedHookNames) {
    const shimFile = join(hooksDir, hookName);
    writeIfChanged(shimFile, huskyForwardShimScript(hookName, config), 0o755);
  }

  runGit(['config', '--worktree', 'core.hooksPath', hooksDir], primaryPath);
  runGit(
    ['config', '--worktree', `${config.configNamespace}.primaryLockedBy`, String(lockedBy)],
    primaryPath,
    { allowFailure: true },
  );
}

/**
 * Refresh-only: no-ops when the primary-lock hook was never installed on
 * this worktree (does not perform a first install), otherwise delegates to
 * installPrimaryLockHook (itself a no-op write when content is unchanged).
 *
 * @param {string} primaryPath
 * @param {string} lockedBy
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 */
export function refreshPrimaryLockHookIfStale(primaryPath, lockedBy, config) {
  if (!primaryLockHookIsInstalled(primaryPath, config)) return;
  installPrimaryLockHook(primaryPath, lockedBy, config);
}

/**
 * @param {string} primaryPath
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 * @returns {boolean}
 */
export function primaryLockHookIsInstalled(primaryPath, config) {
  const res = runGit(['config', '--worktree', '--get', 'core.hooksPath'], primaryPath, {
    allowFailure: true,
  });
  if (res.status !== 0 || !res.stdout) return false;

  const expectedHooksDir = primaryLockHooksDir(primaryPath);
  const absoluteHooksPath = resolveMaybeRelative(primaryPath, res.stdout);
  if (!samePathIdentity(absoluteHooksPath, expectedHooksDir)) return false;

  return existsSync(join(expectedHooksDir, 'reference-transaction'));
}

/**
 * `git worktree add` copies the SOURCE worktree's worktree-level config into
 * the newly created worktree, which can leak a core.hooksPath that was only
 * ever meant to apply to one specific worktree into the repo's SHARED
 * config. Detects and clears that leak.
 *
 * @param {string} primaryPath
 * @param {string} hooksDir Absolute path this sweep considers "owned" by
 *   worktree-guard and safe to unset if found in the shared config.
 * @param {typeof import('./config.mjs').DEFAULT_CONFIG} config
 */
export function sweepStaleSharedHooksPath(primaryPath, hooksDir, config) {
  void config; // no config-driven behavior yet; kept for signature stability
  const commonConfigPath = join(gitCommonDirAbsolute(primaryPath), 'config');
  const res = runGit(['config', '--file', commonConfigPath, '--get', 'core.hooksPath'], primaryPath, {
    allowFailure: true,
  });
  if (res.status !== 0 || !res.stdout) return;

  const absoluteCurrent = resolveMaybeRelative(primaryPath, res.stdout);
  const absoluteHooksDir = resolveMaybeRelative(primaryPath, hooksDir);
  if (!samePathIdentity(absoluteCurrent, absoluteHooksDir)) return;

  runGit(['config', '--file', commonConfigPath, '--unset', 'core.hooksPath'], primaryPath, {
    allowFailure: true,
  });
}

/**
 * @param {string} hooksDir
 * @returns {string} absolute path of the marker file just created
 */
export function createBypassMarker(hooksDir) {
  mkdirSync(hooksDir, { recursive: true });
  const suffix = randomBytes(4).toString('hex');
  const markerPath = join(hooksDir, `.bypass-${process.pid}-${suffix}.marker`);
  writeFileSync(markerPath, `${process.pid}\n${new Date().toISOString()}\n`);
  return markerPath;
}

/**
 * @param {string} markerPath
 */
export function removeBypassMarker(markerPath) {
  rmSync(markerPath, { force: true });
}
