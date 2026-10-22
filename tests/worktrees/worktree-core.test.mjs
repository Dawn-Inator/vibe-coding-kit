// worktree-guard/worktree-core.test.mjs
//
// Unit tests for worktree-core.mjs. Builds real throwaway git repositories
// under the OS tmpdir for every scenario -- no mocking of the git binary
// itself -- and cleans them up as it goes.
//
// Node built-ins only (node:test + node:assert), ESM.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isolatedFixtureGitEnv,
  withFixtureCommitIdentity,
} from '../support/isolated-git-env.mjs';

import { DEFAULT_CONFIG, loadConfig } from '../../src/worktrees/config.mjs';
import {
  git,
  gitText,
  gitRaw,
  gitLines,
  gitSubcommand,
  classifyTransientGitFailure,
  parseWorktreePorcelain,
  parsePorcelainEntries,
  parsePorcelainPaths,
  unquoteGitCPath,
  GIT_RETRY_MAX_ATTEMPTS,
  GIT_RETRY_BACKOFF_MS,
  discoverRepo,
  detectWorktreeTool,
  toolConfig,
  slugifyLabel,
  allocateWorktreeBranchName,
  uniqueWorktreePath,
  checkCapacity,
  readWorktreeMetadata,
  writeWorktreeMetadata,
  computeDeletedTrackedFiles,
  classifyMassDeletion,
  resolveUpstream,
  findSuspiciousDanglingStashCommits,
  findStashReflogValueMismatch,
  assessHeadLanded,
  formatUnmatchedCommits,
} from '../../src/worktrees/worktree-core.mjs';

const config = loadConfig(undefined, {});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Raw git invocation used only for test fixture setup (not the SUT). */
function run(args, cwd) {
  const result = spawnSync('git', withFixtureCommitIdentity(args), {
    cwd,
    encoding: 'utf8',
    env: isolatedFixtureGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`fixture setup failed: git ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

function initRepo() {
  const dir = makeTempDir('wtg-core-repo-');
  run(['init'], dir);
  run(['commit', '--allow-empty', '-m', 'initial commit'], dir);
  run(['branch', '-M', 'main'], dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// git / gitText wrapper
// ---------------------------------------------------------------------------

describe('git / gitText wrappers', () => {
  test('gitText returns trimmed stdout on success', () => {
    const repo = initRepo();
    const sha = gitText(['rev-parse', 'HEAD'], repo);
    assert.match(sha, /^[0-9a-f]{40}$/);
  });

  test('git does not throw on a failing command and reports non-zero status', () => {
    const repo = initRepo();
    const result = git(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('gitText throws on a failing command', () => {
    const repo = initRepo();
    assert.throws(() => gitText(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo));
  });
});

// ---------------------------------------------------------------------------
// discoverRepo
// ---------------------------------------------------------------------------

describe('discoverRepo', () => {
  test('resolves primary worktree as the first entry and lists linked worktrees', () => {
    const primary = initRepo();
    const linkedPath = join(primary, '..', `${primary.split('/').pop()}-linked`);
    run(['worktree', 'add', linkedPath, '-b', 'feature/test-branch'], primary);
    tempDirs.push(linkedPath);

    const repo = discoverRepo(primary);

    assert.equal(repo.worktrees.length, 2);
    assert.ok(repo.primaryWorktree);
    assert.equal(repo.primaryWorktree, repo.worktrees[0]);
    assert.equal(repo.primaryWorktree.path, repo.topLevel);
    assert.equal(repo.primaryWorktree.branch, 'main');

    const linked = repo.worktrees[1];
    assert.equal(linked.branch, 'feature/test-branch');
    assert.ok(linked.head);
    assert.ok(linked.path);
  });
});

// ---------------------------------------------------------------------------
// detectWorktreeTool / toolConfig
// ---------------------------------------------------------------------------

describe('detectWorktreeTool / toolConfig', () => {
  test('explicit override env wins', () => {
    const tool = detectWorktreeTool({ [config.envVars.workerTool]: 'codex' }, config);
    assert.equal(tool, 'codex');
  });

  test('detectEnv signal is used when no override is set', () => {
    const tool = detectWorktreeTool({ CODEX_SESSION_ID: 'abc' }, config);
    assert.equal(tool, 'codex');
  });

  test('falls back to defaultTool when nothing matches', () => {
    const tool = detectWorktreeTool({}, config);
    assert.equal(tool, config.defaultTool);
  });

  test('toolConfig throws for an unknown tool id', () => {
    assert.throws(() => toolConfig('not-a-real-tool', config));
  });

  test('toolConfig returns the tool entry for a known id', () => {
    assert.equal(toolConfig('claude', config).prefix, 'claude/');
  });
});

// ---------------------------------------------------------------------------
// slugifyLabel
// ---------------------------------------------------------------------------

describe('slugifyLabel', () => {
  test('strips diacritics, lowercases, and hyphenates', () => {
    assert.equal(slugifyLabel('Fïx Bùg #42!'), 'fix-bug-42');
  });

  test('a purely-symbolic label falls back to a non-empty default', () => {
    const slug = slugifyLabel('!!!@@@###');
    assert.notEqual(slug, '');
    assert.equal(slug, 'worktree');
  });

  test('long labels are truncated to 80 characters with no trailing hyphen', () => {
    const slug = slugifyLabel('a'.repeat(200));
    assert.ok(slug.length <= 80);
    assert.notEqual(slug[slug.length - 1], '-');
  });

  test('never returns an empty string', () => {
    assert.notEqual(slugifyLabel(''), '');
    assert.notEqual(slugifyLabel('   '), '');
  });
});

// ---------------------------------------------------------------------------
// allocateWorktreeBranchName
// ---------------------------------------------------------------------------

describe('allocateWorktreeBranchName', () => {
  test('allocates the base name first, then a -2 suffix once taken', () => {
    const primary = initRepo();
    let repo = discoverRepo(primary);

    const first = allocateWorktreeBranchName(repo, 'fix bug', 'claude', config);
    assert.equal(first, 'claude/fix-bug');

    // Simulate the branch already existing (created, but not checked out
    // anywhere -- exercises the show-ref fallback, not just repo.worktrees).
    run(['branch', first], primary);
    repo = discoverRepo(primary);

    const second = allocateWorktreeBranchName(repo, 'fix bug', 'claude', config);
    assert.equal(second, 'claude/fix-bug-2');
  });
});

// ---------------------------------------------------------------------------
// uniqueWorktreePath
// ---------------------------------------------------------------------------

describe('uniqueWorktreePath', () => {
  test('appends a numeric suffix when the target path already exists', () => {
    const root = makeTempDir('wtg-core-root-');
    const branchName = 'claude/some-feature';
    const first = uniqueWorktreePath(root, branchName);
    assert.equal(first, join(root, 'claude-some-feature'));

    mkDirSync(first);

    const second = uniqueWorktreePath(root, branchName);
    assert.equal(second, join(root, 'claude-some-feature-2'));
  });
});

function mkDirSync(path) {
  spawnSync('mkdir', ['-p', path]);
}

// ---------------------------------------------------------------------------
// checkCapacity
// ---------------------------------------------------------------------------

describe('checkCapacity', () => {
  test('throws when at or over maxWorktrees', () => {
    const smallConfig = { ...config, maxWorktrees: 2 };
    const fakeRepo = {
      topLevel: tmpdir(),
      worktrees: [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }],
    };
    assert.throws(() => checkCapacity(fakeRepo, smallConfig), /capacity/);
  });

  test('throws when free disk space is below the configured minimum', () => {
    const hugeMinConfig = { ...config, maxWorktrees: 999, minFreeDiskGb: 1e9 };
    const fakeRepo = { topLevel: tmpdir(), worktrees: [{ path: 'a' }] };
    assert.throws(() => checkCapacity(fakeRepo, hugeMinConfig), /free disk/);
  });

  test('does not throw when within capacity and disk space', () => {
    const okConfig = { ...config, maxWorktrees: 999, minFreeDiskGb: 0 };
    const fakeRepo = { topLevel: tmpdir(), worktrees: [{ path: 'a' }] };
    assert.doesNotThrow(() => checkCapacity(fakeRepo, okConfig));
  });
});

// ---------------------------------------------------------------------------
// readWorktreeMetadata / writeWorktreeMetadata
// ---------------------------------------------------------------------------

describe('worktree metadata round trip', () => {
  test('written metadata reads back identically, including values with spaces', () => {
    const repo = initRepo();
    assert.deepEqual(readWorktreeMetadata(repo, config), {});

    // Lowercase keys round-trip exactly. (git config variable names are
    // case-insensitive and git downcases them on storage -- see the
    // dedicated case-folding test below.)
    writeWorktreeMetadata(repo, { label: 'My Label', email: 'a@b.com' }, config);
    const readBack = readWorktreeMetadata(repo, config);
    assert.deepEqual(readBack, { label: 'My Label', email: 'a@b.com' });
  });

  test('mixed-case keys read back lowercased (git config variable-name behaviour)', () => {
    const repo = initRepo();
    writeWorktreeMetadata(repo, { ownerEmail: 'a@b.com' }, config);
    const readBack = readWorktreeMetadata(repo, config);
    assert.deepEqual(readBack, { owneremail: 'a@b.com' });
  });

  test('skips undefined/null/empty-string values', () => {
    const repo = initRepo();
    writeWorktreeMetadata(repo, { keep: 'value', dropped: '', alsoDropped: undefined }, config);
    const readBack = readWorktreeMetadata(repo, config);
    assert.deepEqual(readBack, { keep: 'value' });
  });
});

// ---------------------------------------------------------------------------
// checkCapacity + classifyMassDeletion
// ---------------------------------------------------------------------------

describe('classifyMassDeletion', () => {
  test('triggers on count threshold', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/file-${i}.js`);
    const result = classifyMassDeletion(files, config);
    assert.equal(result.deletedCount, 25);
    assert.equal(result.criticalHits.length, 0);
    assert.equal(result.isMassDeletion, true);
  });

  test('triggers on a single critical-path hit even under the count threshold', () => {
    const files = ['package.json', 'src/a.js'];
    const result = classifyMassDeletion(files, config);
    assert.equal(result.deletedCount, 2);
    assert.deepEqual(result.criticalHits, ['package.json']);
    assert.equal(result.isMassDeletion, true);
  });

  test('does not trigger when neither condition is met', () => {
    const files = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'];
    const result = classifyMassDeletion(files, config);
    assert.equal(result.isMassDeletion, false);
    assert.equal(result.criticalHits.length, 0);
  });
});

// ---------------------------------------------------------------------------
// computeDeletedTrackedFiles
// ---------------------------------------------------------------------------

describe('computeDeletedTrackedFiles', () => {
  test('lists files deleted relative to the merge-base of a base branch', () => {
    const repo = initRepo();
    run(['commit', '--allow-empty', '-m', 'unused'], repo);

    // Create three tracked files at the "base" point.
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      spawnSync('sh', ['-c', `printf 'content' > ${name}`], { cwd: repo });
    }
    run(['add', '.'], repo);
    run(['commit', '-m', 'add three files'], repo);
    run(['branch', 'base-point', 'HEAD'], repo);

    // Delete two of them in a later commit.
    run(['rm', 'b.txt'], repo);
    run(['rm', 'c.txt'], repo);
    run(['commit', '-m', 'delete two files'], repo);

    const deleted = computeDeletedTrackedFiles(repo, 'base-point').sort();
    assert.deepEqual(deleted, ['b.txt', 'c.txt']);
  });

  test('returns [] when baseBranch is falsy', () => {
    assert.deepEqual(computeDeletedTrackedFiles('/nonexistent', null), []);
    assert.deepEqual(computeDeletedTrackedFiles('/nonexistent', ''), []);
  });
});

// ---------------------------------------------------------------------------
// resolveUpstream
// ---------------------------------------------------------------------------

describe('resolveUpstream', () => {
  test('resolves remote + branch when upstream tracking is configured', () => {
    const bareRemote = makeTempDir('wtg-core-remote-');
    run(['init', '--bare'], bareRemote);

    const repo = initRepo();
    run(['remote', 'add', 'origin', bareRemote], repo);
    run(['push', '-u', 'origin', 'main'], repo);

    const upstream = resolveUpstream(repo);
    assert.deepEqual(upstream, { remote: 'origin', branch: 'main' });
  });

  test('returns nulls when no upstream is configured', () => {
    const repo = initRepo();
    const upstream = resolveUpstream(repo);
    assert.deepEqual(upstream, { remote: null, branch: null });
  });
});

// ---------------------------------------------------------------------------
// stash-audit diagnostics (light smoke coverage)
// ---------------------------------------------------------------------------

describe('stash-audit diagnostics', () => {
  test('findSuspiciousDanglingStashCommits returns [] on a repo with no dangling stash commits', () => {
    const repo = initRepo();
    const findings = findSuspiciousDanglingStashCommits(discoverRepo(repo));
    assert.deepEqual(findings, []);
  });

  test('findStashReflogValueMismatch returns null when refs/stash does not exist', () => {
    const repo = initRepo();
    assert.equal(findStashReflogValueMismatch(repo), null);
  });

  test('findStashReflogValueMismatch returns null for a normal, intact stash', () => {
    const repo = initRepo();
    spawnSync('sh', ['-c', "printf 'wip' > wip.txt"], { cwd: repo });
    run(['add', '.'], repo);
    run(['stash', 'push', '-m', 'test stash'], repo);

    const result = findStashReflogValueMismatch(repo);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Line-oriented git output must not be whole-blob trimmed
// ---------------------------------------------------------------------------
//
// Regression class: git() trims stdout. `git status --porcelain` prints
// " M path" for a file modified only in the working tree; trimming the whole
// blob removes that first line's leading space, so a fixed-column slice(3)
// then drops the first character of the path ("README.md" -> "EADME.md").
// Every parser of line-oriented output below is exercised with a first line
// that starts with a space.

describe('line-oriented output is parsed from untrimmed stdout', () => {
  test('git() keeps its trimming default; gitRaw() preserves the first line leading space', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n');
    run(['add', 'tracked.txt'], repo);
    run(['commit', '-m', 'add tracked'], repo);
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');

    const trimmed = git(['status', '--porcelain'], repo).stdout;
    const raw = gitRaw(['status', '--porcelain'], repo).stdout;
    assert.equal(trimmed, 'M tracked.txt', 'documents the trimming default (the old bug source)');
    assert.equal(raw, ' M tracked.txt\n');
    assert.deepEqual(gitLines(['status', '--porcelain'], repo), [' M tracked.txt']);
  });

  test('parsePorcelainPaths: a first line with a blank index column keeps its full path', () => {
    // Old code fed a trimmed blob to slice(3): "M tracked.txt".slice(3) === "acked.txt".
    assert.deepEqual(parsePorcelainPaths(' M tracked.txt\n?? new.txt\n'), ['tracked.txt', 'new.txt']);
    assert.deepEqual(parsePorcelainPaths(' D gone.txt\n'), ['gone.txt']);
  });

  test('parsePorcelainEntries: status codes verbatim, rename destination, quoted paths unquoted', () => {
    const entries = parsePorcelainEntries(
      ' M a.txt\nA  b.txt\nR  old name.txt -> "new name.txt"\n?? "sp ace.txt"\n?? "na\\303\\257ve.txt"\n',
    );
    assert.deepEqual(entries, [
      { statusCode: ' M', path: 'a.txt' },
      { statusCode: 'A ', path: 'b.txt' },
      { statusCode: 'R ', path: 'new name.txt' },
      { statusCode: '??', path: 'sp ace.txt' },
      { statusCode: '??', path: 'naïve.txt' },
    ]);
    assert.deepEqual(parsePorcelainEntries(''), []);
    assert.deepEqual(parsePorcelainEntries(undefined), []);
  });

  test('unquoteGitCPath decodes escapes and UTF-8 octal bytes', () => {
    assert.equal(unquoteGitCPath('"a\\"b"'), 'a"b');
    assert.equal(unquoteGitCPath('"tab\\there"'), 'tab\there');
    assert.equal(unquoteGitCPath('"\\344\\270\\255.txt"'), '中.txt');
  });

  test('parseWorktreePorcelain: tolerates CRLF and parses detached / branch records', () => {
    const text = [
      'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /repo-linked', 'HEAD bbb', 'detached', '',
    ].join('\r\n');
    assert.deepEqual(parseWorktreePorcelain(text), [
      { path: '/repo', branch: 'main', head: 'aaa' },
      { path: '/repo-linked', branch: null, head: 'bbb' },
    ]);
  });

  test('computeDeletedTrackedFiles: names with a leading space or non-ASCII bytes come back intact', () => {
    const repo = initRepo();
    writeFileSync(join(repo, ' lead.txt'), 'x\n');
    writeFileSync(join(repo, 'naïve.txt'), 'y\n');
    writeFileSync(join(repo, 'keep.txt'), 'z\n');
    run(['add', '-A'], repo);
    run(['commit', '-m', 'add files'], repo);
    run(['checkout', '-b', 'feature/delete'], repo);
    run(['rm', '--', ' lead.txt', 'naïve.txt'], repo);
    run(['commit', '-m', 'delete files'], repo);

    const deleted = computeDeletedTrackedFiles(repo, 'main').sort();
    assert.deepEqual(deleted, [' lead.txt', 'naïve.txt']);
  });

  test('readWorktreeMetadata keeps a value that ends in a space (last line is not trimmed)', () => {
    const repo = initRepo();
    writeWorktreeMetadata(repo, { aaa: 'first', zzz: 'trailing ' }, config);
    const metadata = readWorktreeMetadata(repo, config);
    assert.equal(metadata.aaa, 'first');
    assert.equal(metadata.zzz, 'trailing ');
  });
});

// ---------------------------------------------------------------------------
// Transient retry: closed signature set, fake runner, injected sleep
// ---------------------------------------------------------------------------

function fakeRunner(results) {
  const calls = [];
  const runner = (args, spawnOptions) => {
    calls.push({ args, spawnOptions });
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    return { status: 0, stdout: '', stderr: '', ...next };
  };
  runner.calls = calls;
  return runner;
}

function retryHarness() {
  const sleeps = [];
  const logs = [];
  return { sleeps, logs, sleep: (ms) => sleeps.push(ms), log: (m) => logs.push(m) };
}

const REF_LOCK_STDERRS = [
  "fatal: Unable to create '/repo/.git/refs/heads/x.lock': File exists.",
  "error: Unable to create '/repo/.git/packed-refs.lock': File exists.",
  "fatal: cannot lock ref 'refs/heads/x': is at abc but expected def",
];

const TRANSPORT_STDERRS = [
  "fatal: unable to access 'https://h/r.git/': Could not resolve host: h",
  'fatal: unable to access: Connection reset by peer',
  'fatal: unable to access: Connection timed out after 30001 milliseconds',
  'fatal: the remote end hung up unexpectedly',
  'error: RPC failed; curl 56 OpenSSL SSL_read: connection closed',
  'fatal: early EOF',
  'fatal: unable to access: LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to h:443',
];

describe('git(): transient retry', () => {
  test('constants: 3 attempts, 1s then 3s backoff', () => {
    assert.equal(GIT_RETRY_MAX_ATTEMPTS, 3);
    assert.deepEqual([...GIT_RETRY_BACKOFF_MS], [1000, 3000]);
  });

  for (const stderr of REF_LOCK_STDERRS) {
    test(`ref-lock collision is retried on a local write command: ${stderr.slice(0, 40)}`, () => {
      const h = retryHarness();
      const runner = fakeRunner([{ status: 128, stderr }, { status: 128, stderr }, { status: 0, stdout: 'ok' }]);
      const result = git(['update-ref', 'refs/heads/x', 'HEAD'], '/tmp', { runner, sleep: h.sleep, log: h.log });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'ok');
      assert.equal(result.attempts, 3);
      assert.equal(runner.calls.length, 3);
      assert.deepEqual(h.sleeps, [1000, 3000]);
      assert.equal(h.logs.length, 2);
    });
  }

  for (const stderr of TRANSPORT_STDERRS) {
    for (const sub of ['fetch', 'push']) {
      test(`transport error is retried on ${sub}: ${stderr.slice(0, 40)}`, () => {
        const h = retryHarness();
        const runner = fakeRunner([{ status: 128, stderr }, { status: 0 }]);
        const result = git([sub, 'origin', 'main'], '/tmp', { runner, sleep: h.sleep, log: h.log });
        assert.equal(result.status, 0);
        assert.equal(runner.calls.length, 2);
        assert.deepEqual(h.sleeps, [1000]);
      });
    }
  }

  test('the retry gives up after 3 attempts and returns the last failure', () => {
    const h = retryHarness();
    const runner = fakeRunner([{ status: 128, stderr: TRANSPORT_STDERRS[0] }]);
    const result = git(['fetch', 'origin'], '/tmp', { runner, sleep: h.sleep, log: h.log });
    assert.equal(result.status, 128);
    assert.equal(runner.calls.length, 3);
    assert.deepEqual(h.sleeps, [1000, 3000]);
    assert.throws(
      () => git(['fetch', 'origin'], '/tmp', { runner, sleep: h.sleep, log: h.log, allowFailure: false }),
      /git fetch origin failed \(exit 128\)/,
    );
  });

  test('transport errors are NOT retried on commands that never use the network', () => {
    const h = retryHarness();
    const runner = fakeRunner([{ status: 128, stderr: TRANSPORT_STDERRS[0] }]);
    git(['rev-parse', 'origin/main'], '/tmp', { runner, sleep: h.sleep, log: h.log });
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  const NON_TRANSIENT = [
    ['non-fast-forward rejection', ['push', 'origin', 'HEAD:main'],
      ' ! [rejected]        HEAD -> main (non-fast-forward)\nerror: failed to push some refs'],
    ['fetch-first rejection', ['push', 'origin', 'HEAD:main'],
      'hint: Updates were rejected because the remote contains work (fetch first)'],
    ['auth failure', ['push', 'origin', 'main'], "fatal: Authentication failed for 'https://h/r.git/'"],
    ['permission denied', ['fetch', 'origin'],
      'git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
    ['http 403 even though it says RPC failed', ['push', 'origin', 'main'],
      'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403'],
    ['pre-push hook refusal', ['push', 'origin', 'main'],
      'error: failed to push some refs (pre-push hook declined)'],
    ['directory/file ref conflict', ['branch', 'a/b'],
      "fatal: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create 'refs/heads/a/b'"],
    ['unrelated error', ['fetch', 'origin'], "fatal: couldn't find remote ref refs/heads/nope"],
    ['not a repository', ['fetch', 'nowhere'], "fatal: 'nowhere' does not appear to be a git repository"],
  ];
  for (const [label, args, stderr] of NON_TRANSIENT) {
    test(`fails on attempt 1, never retried: ${label}`, () => {
      const h = retryHarness();
      const runner = fakeRunner([{ status: 1, stderr }]);
      const result = git(args, '/tmp', { runner, sleep: h.sleep, log: h.log });
      assert.equal(result.status, 1);
      assert.equal(result.attempts, 1);
      assert.equal(runner.calls.length, 1);
      assert.deepEqual(h.sleeps, []);
      assert.equal(classifyTransientGitFailure(args, stderr), null);
    });
  }

  test('retry: false disables retrying entirely', () => {
    const h = retryHarness();
    const runner = fakeRunner([{ status: 128, stderr: TRANSPORT_STDERRS[0] }]);
    git(['fetch', 'origin'], '/tmp', { runner, sleep: h.sleep, log: h.log, retry: false });
    assert.equal(runner.calls.length, 1);
  });

  test('gitSubcommand skips leading global options so -c identity args do not hide the subcommand', () => {
    assert.equal(gitSubcommand(['-c', 'user.name=x', '-c', 'user.email=y', 'push', 'origin']), 'push');
    assert.equal(gitSubcommand(['-C', '/x', '--no-pager', 'fetch']), 'fetch');
    const h = retryHarness();
    const runner = fakeRunner([{ status: 128, stderr: TRANSPORT_STDERRS[1] }, { status: 0 }]);
    git(['-c', 'user.name=x', 'push', 'origin'], '/tmp', { runner, sleep: h.sleep, log: h.log });
    assert.equal(runner.calls.length, 2);
  });

  test('timeoutMs is passed to spawn; a timed-out call is reported, not retried, and throws a clear error', () => {
    const h = retryHarness();
    const runner = fakeRunner([{
      status: null,
      stderr: 'fatal: Connection timed out',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    }]);
    const result = git(['fetch', 'origin'], '/tmp', { runner, sleep: h.sleep, log: h.log, timeoutMs: 1234 });
    assert.equal(result.timedOut, true);
    assert.equal(runner.calls.length, 1, 'a timeout is never retried');
    assert.equal(runner.calls[0].spawnOptions.timeout, 1234);
    assert.throws(
      () => git(['fetch', 'origin'], '/tmp', { runner, timeoutMs: 1234, allowFailure: false }),
      /timed out after 1234ms/,
    );
  });

  test('a real git process hitting a real lock collision is retried until the lock clears', () => {
    const repo = initRepo();
    const lock = join(repo, '.git', 'refs', 'heads', 'locked.lock');
    writeFileSync(lock, '');
    const sleeps = [];
    const sleep = (ms) => {
      sleeps.push(ms);
      rmSync(lock, { force: true });
    };
    const result = git(['update-ref', 'refs/heads/locked', 'HEAD'], repo, { sleep, log: () => {} });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [1000]);
  });
});

describe('assessHeadLanded: ancestry first, patch-id content equivalence second', () => {
  function commitFile(repo, name, content, message = `add ${name}`) {
    writeFileSync(join(repo, name), content);
    run(['add', name], repo);
    run(['commit', '-m', message], repo);
    return run(['rev-parse', 'HEAD'], repo);
  }

  function featureBranch(repo, files) {
    run(['checkout', '-b', 'feature'], repo);
    return files.map(([name, content]) => commitFile(repo, name, content));
  }

  test('an ancestor of the base is landed via ancestry', () => {
    const repo = initRepo();
    featureBranch(repo, [['a.txt', 'a\n']]);
    run(['checkout', 'main'], repo);
    run(['merge', '--ff-only', 'feature'], repo);
    run(['checkout', 'feature'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, true);
    assert.equal(verdict.via, 'ancestry');
  });

  test('a squash-merged multi-commit branch is landed via patch-id (net diff)', () => {
    const repo = initRepo();
    featureBranch(repo, [['a.txt', 'a\n'], ['b.txt', 'b\n']]);
    run(['checkout', 'main'], repo);
    run(['merge', '--squash', 'feature'], repo);
    run(['commit', '-m', 'squash feature'], repo);
    run(['checkout', 'feature'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, true, verdict.reason);
    assert.equal(verdict.via, 'patch-id');
    assert.equal(assessHeadLanded(repo, 'main', { usePatchId: false }).landed, false);
  });

  test('a cherry-picked branch is landed via patch-id, even with unrelated base commits in between', () => {
    const repo = initRepo();
    const [first, second] = featureBranch(repo, [['a.txt', 'a\n'], ['b.txt', 'b\n']]);
    run(['checkout', 'main'], repo);
    commitFile(repo, 'other.txt', 'other\n');
    run(['cherry-pick', first, second], repo);
    commitFile(repo, 'later.txt', 'later\n');
    run(['checkout', 'feature'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, true, verdict.reason);
    assert.equal(verdict.via, 'patch-id');
  });

  test('one commit changed after landing is NOT landed and exactly that commit is listed', () => {
    const repo = initRepo();
    const [first, second] = featureBranch(repo, [['a.txt', 'a\n'], ['b.txt', 'b\n']]);
    run(['checkout', 'main'], repo);
    run(['cherry-pick', first], repo);
    // The second commit lands with different content.
    commitFile(repo, 'b.txt', 'b CHANGED\n', 'add b.txt (reworked)');
    run(['checkout', 'feature'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, false);
    assert.deepEqual(verdict.unmatched.map((entry) => entry.sha), [second]);
    assert.match(formatUnmatchedCommits(verdict.unmatched)[0], /add b\.txt/);
  });

  test('a merge commit unique to HEAD cannot be verified and blocks', () => {
    const repo = initRepo();
    featureBranch(repo, [['a.txt', 'a\n']]);
    run(['checkout', 'main'], repo);
    commitFile(repo, 'm.txt', 'm\n');
    run(['checkout', 'feature'], repo);
    run(['merge', '--no-ff', '-m', 'merge main into feature', 'main'], repo);
    const mergeSha = run(['rev-parse', 'HEAD'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, false);
    assert.ok(verdict.unmatched.some((entry) => entry.sha === mergeSha && /merge commit/.test(entry.reason)));
  });

  test('an empty commit unique to HEAD is trivially merged', () => {
    const repo = initRepo();
    const [only] = featureBranch(repo, [['a.txt', 'a\n']]);
    run(['commit', '--allow-empty', '-m', 'empty marker'], repo);
    run(['checkout', 'main'], repo);
    run(['cherry-pick', only], repo);
    run(['checkout', 'feature'], repo);
    const verdict = assessHeadLanded(repo, 'main');
    assert.equal(verdict.landed, true, verdict.reason);
  });

  test('an unrelated unmerged branch, an unknown base and an unknown head all report not landed', () => {
    const repo = initRepo();
    featureBranch(repo, [['a.txt', 'a\n']]);
    assert.equal(assessHeadLanded(repo, 'main').landed, false);
    assert.equal(assessHeadLanded(repo, 'no-such-branch').landed, false);
    assert.equal(assessHeadLanded(repo, 'main', { headRef: 'no-such-ref' }).landed, false);
  });
});

// Sanity: DEFAULT_CONFIG is usable directly too (not just via loadConfig).
describe('config sanity', () => {
  test('DEFAULT_CONFIG has the shape worktree-core.mjs expects', () => {
    assert.ok(DEFAULT_CONFIG.tools.claude);
    assert.ok(DEFAULT_CONFIG.massDeletion.threshold > 0);
  });
});
