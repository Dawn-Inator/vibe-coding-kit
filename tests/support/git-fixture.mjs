// Portable, zero-dependency Git fixture runner for starter-kit tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { isolatedFixtureGitEnv, withFixtureCommitIdentity } from './isolated-git-env.mjs';

export { isolatedFixtureGitEnv };

const FIXTURE_SPAWN_TIMEOUT_MS = 60_000;

function fixtureEnv(options) {
  return { ...isolatedFixtureGitEnv(), ...options?.env };
}

function assertFixtureProcessRan(result, what) {
  if (result.error || result.signal !== null || result.status === null) {
    throw new Error(
      `fixture prerequisite failed: ${what} did not complete ` +
        `(error=${result.error?.code ?? 'none'}, signal=${result.signal ?? 'none'})`,
    );
  }
}

export function gitOut(args, cwd, options = {}) {
  return execFileSync('git', withFixtureCommitIdentity(args), {
    cwd,
    encoding: 'utf8',
    timeout: FIXTURE_SPAWN_TIMEOUT_MS,
    env: fixtureEnv(options),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
  });
}

export function gitResult(args, cwd, options = {}) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), {
    cwd,
    encoding: 'utf8',
    timeout: FIXTURE_SPAWN_TIMEOUT_MS,
    env: fixtureEnv(options),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
  });
  assertFixtureProcessRan(result, 'git');
  if (options.check && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export function gitTrim(args, cwd, options = {}) {
  return gitResult(args, cwd, { ...options, check: true }).stdout.trim();
}
