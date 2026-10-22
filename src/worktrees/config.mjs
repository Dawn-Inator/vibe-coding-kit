// worktree-guard/config.mjs
//
// Central configuration schema for the worktree-guard toolkit. Every other
// module in this package reads its tunables from a config object shaped like
// DEFAULT_CONFIG (or an override merged on top of it) instead of hardcoding
// values, so an adopting project can retarget the whole toolkit by editing
// one JSON file rather than patching source.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectKit, readProjectConfig } from '../dependencies/submodule.mjs';

export const DEFAULT_CONFIG = {
  // AI git identity used for every commit made on the AI's behalf.
  // This default is deliberately an obvious placeholder -- INSTALL.md must
  // require every adopting project to replace it with a real identity before
  // relying on the fail-closed fixture-identity checks in git-identity.mjs.
  identity: {
    name: 'Worktree Guard AI Bot',
    email: 'ai-bot@example.invalid',
  },

  // Regex (as a string, compiled with new RegExp()) matched against local git
  // identity name/email on every begin/end/preflight entry point; a match
  // throws (fail-closed, never silently overwrite a leaked test-fixture
  // identity).
  fixtureIdentityPattern: '(Baseline Gate|Rehearsal Bot|@example\\.(test|invalid)|@local$)',

  // Per-AI-tool branch prefix + worktree home directory + environment
  // markers. `detectEnv` does double duty: it picks the tool for `create`
  // (worktree-core detectWorktreeTool) AND it is the proof that a process runs
  // under that AI CLI no matter how many wrapper processes sit in between
  // (process-provenance detectAiParent, used by the sync-primary gate). List
  // only variables the CLI itself exports on its own process; do not list
  // user-configured variables a human might export in a shell profile (a
  // tool's "home directory" variable, for example), or humans get gated.
  tools: {
    claude: {
      prefix: 'claude/',
      home: '.claude',
      detectEnv: ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_CODE_SESSION_ID'],
    },
    codex: {
      prefix: 'codex/',
      home: '.codex',
      detectEnv: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TASK_ID', 'CODEX_SANDBOX'],
    },
  },
  defaultTool: 'claude',

  // Ancestor-process executable-identity allowlists. MUST stay identical
  // between process-provenance.mjs and the bash hook templates in hooks.mjs
  // -- hooks.mjs renders the bash `case` arm directly from these arrays so
  // the two can never drift (both import from this same config object, never
  // duplicate the list).
  aiCliExecutableNames: ['claude', 'claude-code', 'codex', 'codex-cli'],
  scriptRuntimeExecutableNames: ['node', 'nodejs', 'bun', 'deno'],

  // Git-config namespace for per-worktree managed metadata
  // (git config --worktree <namespace>.<key> <value>).
  configNamespace: 'wtg.guard',

  // Internal git ref namespace always allowed through the primary-lock hook
  // (refs/<internalRefNamespace>/*).
  internalRefNamespace: 'wtg',

  // Capacity guards for `create`.
  maxWorktrees: 25,
  minFreeDiskGb: 5,

  // Mass-deletion guard.
  massDeletion: {
    threshold: 20,
    criticalPrefixes: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.github/workflows/',
      'LICENSE',
      'infra/',
    ],
  },

  // Where the project's OWN hook manager keeps its real hooks, as a template
  // with {{hookName}} substituted. Override if the adopting project doesn't
  // use husky.
  realHooksPathTemplate: '.husky/_/{{hookName}}',

  // Standard client-side git hook names the forwarding shims must cover.
  forwardedHookNames: [
    'applypatch-msg', 'commit-msg', 'post-applypatch', 'post-checkout',
    'post-commit', 'post-merge', 'post-rewrite', 'pre-applypatch',
    'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push',
    'pre-rebase', 'prepare-commit-msg',
  ],

  // State dir for the finish-lock mutex + queue (relative to the *common*
  // git dir unless absolute).
  stateDir: '.git/worktree-guard-state',

  // Finish-lock queue tuning.
  //   pollIntervalMs / defaultMaxWaitMs / etaMinutesPerTurn: waiting in line.
  //   heartbeatIntervalMs: how often the holder prints its status line.
  //   maxHoldMs: upper bound on how long `finish` may keep the lock while it
  //     runs its fetch / rebase / push. Each of those git calls gets the
  //     REMAINING budget as a hard timeout; when the budget runs out the lock
  //     is released and the command fails with a message saying so. A hung
  //     network call therefore cannot park every other session behind it.
  //     Raise it only if you add slow steps (a long gate) inside the lock.
  // Note: loadConfig replaces a top-level key as a whole, so an override file
  // that sets `queue` should list every field it cares about; omitted ones fall
  // back to the documented defaults at the point of use.
  queue: {
    pollIntervalMs: 7000,
    defaultMaxWaitMs: 45 * 60 * 1000,
    etaMinutesPerTurn: 5,
    heartbeatIntervalMs: 60000,
    maxHoldMs: 10 * 60 * 1000,
  },

  // Primary-checkout write guard (PreToolUse hook for file-editing tools).
  // Writes whose path is inside the primary checkout are denied unless the
  // path, relative to the primary root, starts with one of these prefixes.
  // Keep scratch areas that are deliberately shared (session notes, offload
  // files) here; everything else belongs in a managed worktree.
  primaryWriteGuard: {
    allowPrefixes: ['.workspace/'],
  },

  // Refs whose commits are already published. `finish` must never rewrite a
  // commit reachable from any of these (rebase / re-author would change its
  // hash and desynchronise everyone who already has it). Full ref names.
  sharedHistoryRefs: ['refs/remotes/origin/main'],

  // Dependency-install integrity after a worktree is created or rebased.
  //   lockfile: path (relative to the worktree) of the lockfile whose content
  //     decides whether installed dependencies are current. Empty = feature OFF.
  //   stampFile: where the hash of the lockfile at the last successful install
  //     is recorded (relative to the worktree; keep it inside the ignored
  //     dependency directory so it is never committed).
  //   installCommand: shell command that reinstalls dependencies. Empty falls
  //     back to postCreateInstallCommand; if both are empty a stale worktree
  //     cannot be repaired and begin / finish / deps-sync fail closed.
  // Checked by `create` (not for --worker roles, which only get a WARN) and by
  // `finish` after the rebase/merge and before the push; `deps-sync` repairs on demand.
  nodeDeps: {
    lockfile: '',
    stampFile: 'node_modules/.worktree-guard-lockfile-stamp',
    installCommand: '',
  },

  // Reclaiming worktrees abandoned by a crashed or switched-away session
  // (`cleanup --reclaim-stale --stale-days <n>`). The age is deliberately NOT
  // configurable here: it must be passed on every run, so no config file can
  // make a bare `--reclaim-stale` delete things.
  //   activeRecentHours: a worktree with real activity within this many hours --
  //     a HEAD or branch reflog entry, or a working-tree file mtime (admin-dir and
  //     index mtimes do not count: read-only git commands touch them) -- is
  //     considered in use and is never reclaimed (unless the caller passes
  //     --allow-recent). This is the safety line that stops one session from
  //     deleting another session's live worktree.
  //   lockHoldSeconds: `--apply` removes worktrees only while holding finish.lock;
  //     it holds the lock at most this long per turn, then releases it and queues
  //     again, so a long reclaim never blocks a waiting finish for minutes.
  //   patchIdBudgetSeconds: patch-id matching (landed by cherry-pick/squash, not by
  //     ancestry) re-reads the base's history and can take minutes on a large or
  //     force-pushed base. Once a pass has spent this long, the remaining worktrees
  //     are checked by ancestry only; any that would need patch-id are kept (never
  //     deleted) and the run says to rerun.
  // Note: loadConfig replaces a top-level key as a whole, so an override must
  // repeat every key it wants to keep (missing ones fall back to the defaults in code).
  reclaim: {
    activeRecentHours: 2,
    lockHoldSeconds: 20,
    patchIdBudgetSeconds: 120,
  },

  // `sync-primary` gate. A worker context is always refused, and the explicit
  // approval env var (envVars.syncPrimaryApprovedBy) always wins. For the
  // remaining case -- a top-level AI session with no approval variable -- the
  // command runs a fail-closed idle scan and proceeds only when nothing else
  // is active (see ai-idle-check.mjs).
  //   idleSelfAuthorize: false turns the scan off; such a caller is then
  //     refused and a human must set the approval variable (the old behaviour).
  //   idleMinutes: a linked worktree whose newest commit is younger than this
  //     counts as active (uncommitted changes always do).
  // Note: loadConfig replaces a top-level key as a whole; code reads each key
  // through syncPrimarySettings() so an override that sets only one of them
  // still gets the default for the other.
  syncPrimary: {
    idleSelfAuthorize: true,
    idleMinutes: 10,
  },

  // Env var names (all overridable so an adopting project can rename to
  // match its own conventions).
  envVars: {
    stashGuardAllow: 'WTG_STASH_GUARD_ALLOW',
    primaryLockBypass: 'WTG_PRIMARY_LOCK_BYPASS',
    primaryLockAllow: 'WTG_PRIMARY_LOCK_ALLOW',
    workerRole: 'WTG_WORKTREE_ROLE',
    workerTool: 'WTG_WORKTREE_TOOL',
    syncPrimaryApprovedBy: 'WTG_SYNC_PRIMARY_APPROVED_BY',
    testParentChainOverride: 'WTG_TEST_PARENT_CHAIN_OVERRIDE',
  },

  // Fixed bypass token baked into the primary-lock hook + this script's own
  // child git invocations. Any non-empty constant string works; only needs
  // to be unguessable enough that a human wouldn't type it by accident, not
  // secret.
  primaryLockBypassToken: 'wtg-internal-bypass-9f2a',

  // Audit log filenames, written under the common git dir.
  primaryAuditLogFilename: 'wtg-primary-audit.log',

  // Optional post-create hook: shell command string run in the new worktree
  // when --install is passed. Empty by default -- adopting projects fill
  // this in with their own package-manager install command.
  postCreateInstallCommand: '',

  // Per-client dependency-install + test/typecheck commands, keyed by a
  // short client name. Drives two things:
  //   - `create --with-deps[=<client>|all]`: after checkout, runs each
  //     selected client's `installCommand` in the new worktree (defaults to
  //     `defaultClient` when --with-deps has no value; `all` runs every
  //     registered client in registration order).
  //   - `client-check -- --app <client> [--typecheck] [files...]`: runs that
  //     client's `testCommand` (or `typecheckCommand` with --typecheck),
  //     appending any positional file args to the end of the command string.
  // This entry is a documented EXAMPLE, not a real dependency -- an adopting
  // project with a single app can leave `clients` as-is (installCommand ''
  // is a no-op) or delete the example key and add its own; a project with
  // several independently-testable clients/apps adds one entry per client
  // here instead of hardcoding client names in cli.mjs.
  clients: {
    app: {
      installCommand: '',
      testCommand: '',
      typecheckCommand: '',
    },
  },
  defaultClient: 'app',
};

/**
 * Load the effective config: DEFAULT_CONFIG shallow-merged with an optional
 * override JSON file. The merge is shallow -- each top-level key present in
 * the override file replaces the corresponding DEFAULT_CONFIG value in its
 * entirety (no deep/recursive merge), keeping the merge logic simple and
 * predictable.
 *
 * @param {string} [overridePath] Path to a JSON file with top-level config
 *   overrides. When omitted, falls back to env.WTG_CONFIG_PATH if set.
 * @param {NodeJS.ProcessEnv} [env] Environment to read the fallback path
 *   from. Defaults to process.env.
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig(overridePath, env = process.env) {
  const resolvedPath = overridePath || env.WTG_CONFIG_PATH;

  // Deep-clone DEFAULT_CONFIG so callers can freely mutate the returned
  // object without corrupting the shared default.
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (resolvedPath && !existsSync(resolvedPath)) {
    throw new Error(`Configured worktree config does not exist: ${resolvedPath}`);
  }

  const projectConfigPath = resolve(process.cwd(), '.vibe-coding/project.config.json');
  if (!resolvedPath && existsSync(projectConfigPath)) {
    inspectKit({ projectRoot: process.cwd() });
    const project = readProjectConfig(process.cwd());
    merged.identity = project.identity;
    for (const [key, value] of Object.entries(project.worktrees || {})) merged[key] = value;
    return merged;
  }

  if (!resolvedPath) {
    return merged;
  }

  const raw = readFileSync(resolvedPath, 'utf8');
  const overrides = JSON.parse(raw);

  for (const key of Object.keys(overrides)) {
    merged[key] = overrides[key];
  }

  return merged;
}

/**
 * The effective `sync-primary` settings, with each key falling back to its
 * documented default on its own (a partial `syncPrimary` override is common
 * and loadConfig replaces the whole key).
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @returns {{idleSelfAuthorize: boolean, idleMinutes: number}}
 */
export function syncPrimarySettings(config) {
  const raw = config?.syncPrimary ?? {};
  const minutes = raw.idleMinutes;
  return {
    // Only an explicit `false` disables the scan: a missing or malformed value
    // keeps the default (on), because the scan is the safer of the two paths.
    idleSelfAuthorize: raw.idleSelfAuthorize !== false,
    idleMinutes: typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
      ? minutes
      : DEFAULT_CONFIG.syncPrimary.idleMinutes,
  };
}
