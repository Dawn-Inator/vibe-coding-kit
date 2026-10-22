import { join } from 'node:path';

import { mkdtempTracked } from './temp-dirs.mjs';

/**
 * A test fixture that `git init`s a throwaway repo at a fresh `mkdtemp` root and then
 * runs `spawnSync`/`spawn`/`execFileSync('git', [...])` against it is dangerous if it
 * inherits the caller process's full ambient environment (the default when no `env`
 * override is passed): a `GIT_DIR`/`GIT_WORK_TREE`-shaped variable already set in that
 * environment can make git's own repository discovery prefer it over the explicit
 * `cwd`, so the fixture's "isolated" git calls land in a real shared `.git` instead of
 * the throwaway repo — silently corrupting whatever repository the ambient environment
 * was pointing at.
 *
 * Usage: pass the returned object as the `env` for every git subprocess call a test
 * fixture makes against its own throwaway repo (`spawnSync('git', args, { cwd, env:
 * isolatedFixtureGitEnv() })`). Prefer `git -c user.name=... -c user.email=...`
 * (see `fixtureGitIdentityArgs()` below) over a persistent `git config user.*` write
 * even once the environment is isolated — belt and suspenders.
 */

const DANGEROUS_GIT_ENV_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
]);

/**
 * Returns a fresh environment object safe to pass as a git subprocess's `env`: every
 * dangerous `GIT_*` variable that could redirect git's repository/config discovery
 * away from the explicit `cwd` is stripped, `GIT_CONFIG_NOSYSTEM=1` forces git to
 * ignore the machine-wide system config, and `GIT_CONFIG_GLOBAL` is redirected to a
 * brand-new one-shot temp file so the fixture's git calls can never read or write the
 * caller's real `~/.gitconfig`. `cwd` (passed to the spawn call, not to this function)
 * remains the only thing that determines which repository is touched.
 *
 * A fresh throwaway global-config temp file/dir is allocated on every call rather than
 * cached — this runs at most a handful of times per test file (once per fixture repo
 * setup), and a shared mutable temp file across unrelated fixture repos would itself be
 * a (much smaller) cross-fixture leakage surface. Allocated via `mkdtempTracked()`
 * (`./temp-dirs.mjs`), so it is swept by that module's exit/signal safety net even
 * though this helper has no `test.after()` of its own to hang cleanup on.
 */
export function isolatedFixtureGitEnv(base = process.env) {
  const env = { ...base };
  for (const name of DANGEROUS_GIT_ENV_VARS) {
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_KEY_') || name.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[name];
    }
  }
  const throwawayGlobalConfigDir = mkdtempTracked('vibe-coding-kit-fixture-gitconfig-');
  env.GIT_CONFIG_GLOBAL = join(throwawayGlobalConfigDir, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

// Default fixture identity for callers that don't need a distinctive per-test name —
// deliberately NOT matching `agent-worktrees/config.mjs`'s default
// `fixtureIdentityPattern` (this identity is only ever meant to land inside an
// isolated throwaway fixture repo, never a shared worktree's `.git/config`, but
// there's no reason to reuse a string that guard specifically watches for).
export const FIXTURE_GIT_IDENTITY = Object.freeze({
  name: 'Vibe Coding Kit Fixture',
  email: 'fixture@vibe-coding-kit.invalid',
});

/**
 * `-c user.name=... -c user.email=...` args to splice before a commit-creating git
 * subcommand, e.g. `git([...fixtureGitIdentityArgs(), 'commit', '-m', msg], cwd, {
 * env: isolatedFixtureGitEnv() })`. Preferred over a persistent `git config user.*`
 * write even against an already-isolated fixture repo — it cannot land anywhere but
 * the one commit it's attached to, regardless of environment.
 */
export function fixtureGitIdentityArgs(identity = FIXTURE_GIT_IDENTITY) {
  return ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
}

// Subcommands that create a new commit object and therefore need an explicit identity:
// the env this module returns intentionally carries none of its own (`GIT_CONFIG_GLOBAL`
// is redirected to a one-shot empty file), so a commit-creating call with no identity of
// its own falls through to git's OS-level hostname auto-detect — which resolves
// silently on some machines and refuses outright ("unable to auto-detect email
// address") on others, turning a latent gap into a host-dependent failure.
export const FIXTURE_COMMIT_CREATING_SUBCOMMANDS = Object.freeze([
  'commit',
  'cherry-pick',
  'merge',
  'rebase',
  'stash',
  'commit-tree',
  'am',
]);

/**
 * Splices `fixtureGitIdentityArgs()` in front of `args` when `args[0]` is one of
 * `FIXTURE_COMMIT_CREATING_SUBCOMMANDS`, so a shared per-file `git()`/`runGit()` wrapper
 * can inject identity for every commit-creating call it makes without every call site
 * repeating `-c user.name=...` itself — a no-op (returns `args` unchanged) for any other
 * subcommand. Usage: `spawnSync('git', withFixtureCommitIdentity(args), { cwd, env:
 * isolatedFixtureGitEnv() })` inside the wrapper's own body, once, rather than per call.
 */
export function withFixtureCommitIdentity(args, identity = FIXTURE_GIT_IDENTITY) {
  if (Array.isArray(args) && FIXTURE_COMMIT_CREATING_SUBCOMMANDS.includes(args[0])) {
    return [...fixtureGitIdentityArgs(identity), ...args];
  }
  return args;
}
