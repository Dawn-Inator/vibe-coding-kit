import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  matchesAiParentProcess,
  isAiParentedCommandChain,
  getAncestorProcessCommands,
  aiParentEnvMarkers,
  findAiParentEnvMarker,
  isAiParentedEnvironment,
  detectAiParent,
  DEFAULT_ANCESTOR_DEPTH,
  listProcessCommands,
} from '../../src/worktrees/process-provenance.mjs';
import { listWindowsProcesses, probeWindowsDirectoryDeleteSafety } from '../../src/lib/windows-process.mjs';
import { DEFAULT_CONFIG } from '../../src/worktrees/config.mjs';

const config = DEFAULT_CONFIG;

test('matchesAiParentProcess: exact executable name match', () => {
  assert.equal(matchesAiParentProcess('claude', config), true);
});

test('matchesAiParentProcess: path-prefixed exact basename match', () => {
  assert.equal(matchesAiParentProcess('/usr/local/bin/claude --flag', config), true);
});

test('matchesAiParentProcess: regression -- substring in path must not match', () => {
  assert.equal(
    matchesAiParentProcess('bash -c "cd /tmp/claude-scratch-lane-abc123 && ls"', config),
    false,
  );
});

test('matchesAiParentProcess: node runtime + script dir named after AI tool matches', () => {
  assert.equal(
    matchesAiParentProcess('node /home/user/.claude/local/cli.js', config),
    true,
  );
});

test('matchesAiParentProcess: node runtime + unrelated script dir does not match', () => {
  assert.equal(
    matchesAiParentProcess('node /home/user/some-other-tool/cli.js', config),
    false,
  );
});

test('matchesAiParentProcess: node runtime + dir segment merely containing "claude" as a substring does not match', () => {
  assert.equal(
    matchesAiParentProcess('node /some/path/claude-scratch-lane-abc123/cli.js', config),
    false,
  );
});

test('matchesAiParentProcess: empty command line returns false without throwing', () => {
  assert.equal(matchesAiParentProcess('', config), false);
  assert.equal(matchesAiParentProcess(undefined, config), false);
});

test('isAiParentedCommandChain: all-non-AI chain returns false', () => {
  const chain = ['bash -c foo', '/usr/bin/zsh', 'login -pf dawn'];
  assert.equal(isAiParentedCommandChain(chain, config), false);
});

test('isAiParentedCommandChain: chain containing one AI match returns true', () => {
  const chain = ['bash -c foo', '/usr/local/bin/claude --resume', 'login -pf dawn'];
  assert.equal(isAiParentedCommandChain(chain, config), true);
});

test('isAiParentedCommandChain: empty array returns false', () => {
  assert.equal(isAiParentedCommandChain([], config), false);
});

test('matchesAiParentProcess: reliable-exe (NUL-delimited) form matches even when the executable\'s own path contains a space', () => {
  // Simulates what getAncestorProcessCommands produces when `ps -o comm=`
  // resolves an executable path containing a space (real case: a macOS
  // app-bundle install under "Application Support") -- naive whitespace
  // splitting of the plain `ps -o command=` line would truncate the
  // executable path at the first space and fail to match.
  const comm = '/Users/dawn/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude';
  const entry = `${comm}\u0000--output-format stream-json --verbose`;
  assert.equal(matchesAiParentProcess(entry, config), true);
});

test('matchesAiParentProcess: reliable-exe form does not fall prey to an unrelated match inside the args', () => {
  // The reliable-exe path itself is "bash" (not an AI tool); an argument
  // value happening to mention a path ending in "claude" must not cause a
  // false positive now that exe resolution is delimiter-based rather than
  // a line-wide search.
  const entry = `/bin/bash\u0000-c "echo /opt/claude some-arg"`;
  assert.equal(matchesAiParentProcess(entry, config), false);
});

test('matchesAiParentProcess: reliable-exe form still supports the script-runtime + AI-named-directory branch', () => {
  const entry = `/usr/local/bin/node\u0000/home/user/.claude/local/cli.js`;
  assert.equal(matchesAiParentProcess(entry, config), true);
});

test('matchesAiParentProcess: Windows executable suffix and backslash script paths are normalized', () => {
  assert.equal(matchesAiParentProcess('C:\\Program Files\\Claude\\claude.exe\u0000--resume', config), true);
  assert.equal(
    matchesAiParentProcess('C:\\Program Files\\node.exe\u0000"C:\\Users\\dawn\\.claude\\local\\cli.js"', config),
    true,
  );
  assert.equal(matchesAiParentProcess('C:\\tools\\claude-scratch-lane-abc123\\bash.exe\u0000-c foo', config), false);
});

test('getAncestorProcessCommands: real walk entries remain well-formed strings', () => {
  // POSIX may add a delimiter when `ps -o comm=` gives an unambiguous exe;
  // Windows uses the same representation with an OS-provided executable path.
  const result = getAncestorProcessCommands(2, {});
  for (const entry of result) assert.equal(typeof entry, 'string');
  for (const entry of result) {
    if (entry.includes('\u0000')) {
      const [executable, ...remainder] = entry.split('\u0000');
      assert.ok(executable.length > 0);
      assert.equal(remainder.length, 1);
    }
  }
});

test('getAncestorProcessCommands: test override splits on ";" and bypasses real ps walk', () => {
  const env = { WTG_TEST_PARENT_CHAIN_OVERRIDE: 'bash -c foo;claude --resume;login -pf dawn' };
  const result = getAncestorProcessCommands(3, env);
  assert.deepEqual(result, ['bash -c foo', 'claude --resume', 'login -pf dawn']);
});

test('getAncestorProcessCommands: real walk returns an array without throwing', () => {
  const result = getAncestorProcessCommands(2, {});
  assert.equal(Array.isArray(result), true);
});

// ---------------------------------------------------------------------------
// Environment markers (depth-independent) and the fake process table seam
// ---------------------------------------------------------------------------

/**
 * A fake `ps` over a process table { pid: { ppid, command, comm? } }.
 * Answers exactly the three queries getAncestorProcessCommands makes.
 */
function fakePs(table) {
  return (args) => {
    const field = args[1];
    const entry = table[Number(args[3])];
    if (!entry) return { status: 1, stdout: '' };
    if (field === 'command=') return { status: 0, stdout: `${entry.command}\n` };
    if (field === 'comm=') return { status: 0, stdout: `${entry.comm ?? entry.command.split(' ')[0]}\n` };
    if (field === 'ppid=') return { status: 0, stdout: `${entry.ppid}\n` };
    return { status: 1, stdout: '' };
  };
}

/** A chain of `wrappers` shell hops (pid 1000 nearest) above an AI CLI, then init. */
function chainWithAiAtDepth(wrappers) {
  const table = {};
  for (let i = 0; i < wrappers; i += 1) {
    table[1000 + i] = { ppid: 1000 + i + 1, command: `/bin/bash -c wrapper-${i}` };
  }
  table[1000 + wrappers] = { ppid: 1, command: '/usr/local/bin/claude --resume' };
  return table;
}

test('aiParentEnvMarkers: the union of every tool detectEnv list (one list, not a parallel one)', () => {
  const markers = aiParentEnvMarkers(config);
  for (const tool of Object.values(config.tools)) {
    for (const name of tool.detectEnv) assert.ok(markers.includes(name), name);
  }
  assert.ok(markers.includes('CLAUDECODE'));
  assert.equal(new Set(markers).size, markers.length, 'no duplicates');
  assert.deepEqual(aiParentEnvMarkers({}), []);
  assert.deepEqual(aiParentEnvMarkers({ tools: { x: {} } }), []);
});

test('findAiParentEnvMarker / isAiParentedEnvironment: set and non-empty counts, unset or empty does not', () => {
  assert.equal(findAiParentEnvMarker({ CLAUDECODE: '1' }, config), 'CLAUDECODE');
  assert.equal(isAiParentedEnvironment({ CODEX_SANDBOX: 'seatbelt' }, config), true);
  assert.equal(isAiParentedEnvironment({ CLAUDECODE: '' }, config), false);
  assert.equal(isAiParentedEnvironment({ PATH: '/bin', HOME: '/home/x' }, config), false);
  assert.equal(isAiParentedEnvironment(undefined, config), false);
});

test('marker names are configurable through config.tools[*].detectEnv', () => {
  const custom = {
    ...config,
    tools: { mine: { prefix: 'mine/', home: '.mine', detectEnv: ['MY_AI_SESSION'] } },
  };
  assert.equal(isAiParentedEnvironment({ MY_AI_SESSION: 'abc' }, custom), true);
  assert.equal(isAiParentedEnvironment({ CLAUDECODE: '1' }, custom), false, 'only configured names count');
});

test('detectAiParent: an env marker proves AI-parenthood even when the ancestry walk finds nothing (deep wrapper chain)', () => {
  // The AI CLI sits 12 hops above us; the walk is limited to DEFAULT_ANCESTOR_DEPTH, so ancestry alone misses it.
  const table = chainWithAiAtDepth(12);
  const ps = fakePs(table);
  assert.ok(DEFAULT_ANCESTOR_DEPTH < 12);
  assert.deepEqual(
    detectAiParent({ env: {}, config, ps, startPid: 1000 }),
    { aiParented: false, via: null },
    'old behavior: a chain deeper than the walk limit slips through',
  );
  assert.deepEqual(
    detectAiParent({ env: { CLAUDECODE: '1' }, config, ps, startPid: 1000 }),
    { aiParented: true, via: 'env:CLAUDECODE' },
  );
});

test('detectAiParent: the env marker short-circuits before any ps call', () => {
  let calls = 0;
  const ps = () => {
    calls += 1;
    return { status: 1, stdout: '' };
  };
  const result = detectAiParent({ env: { CODEX_THREAD_ID: 't-1' }, config, ps });
  assert.equal(result.via, 'env:CODEX_THREAD_ID');
  assert.equal(calls, 0);
});

test('detectAiParent: without a marker the ancestry walk is still the second signal', () => {
  const ps = fakePs(chainWithAiAtDepth(4));
  assert.deepEqual(detectAiParent({ env: {}, config, ps, startPid: 1000 }), { aiParented: true, via: 'ancestry' });
});

test('detectAiParent: human shell (no marker, no AI ancestor) is not AI-parented', () => {
  const table = {
    1000: { ppid: 1001, command: '/bin/zsh -l' },
    1001: { ppid: 1002, command: 'login -pf dawn' },
    1002: { ppid: 1, command: '/usr/libexec/launchd' },
  };
  assert.deepEqual(detectAiParent({ env: { PATH: '/bin' }, config, ps: fakePs(table), startPid: 1000 }), {
    aiParented: false,
    via: null,
  });
});

test('getAncestorProcessCommands: fake process table honours maxDepth and stops at init / missing pids', () => {
  const ps = fakePs(chainWithAiAtDepth(5));
  assert.equal(getAncestorProcessCommands(3, {}, { ps, startPid: 1000 }).length, 3);
  assert.equal(getAncestorProcessCommands(50, {}, { ps, startPid: 1000 }).length, 6);
  assert.deepEqual(getAncestorProcessCommands(5, {}, { ps: () => ({ status: 1, stdout: '' }), startPid: 1000 }), []);
});

test('detectAiParent: the test override chain (WTG_TEST_PARENT_CHAIN_OVERRIDE) still feeds the ancestry signal', () => {
  const env = { WTG_TEST_PARENT_CHAIN_OVERRIDE: 'bash -c foo;claude --resume' };
  assert.deepEqual(detectAiParent({ env, config }), { aiParented: true, via: 'ancestry' });
});

test('getAncestorProcessCommands: Windows ancestry uses native PID/PPID records', () => {
  const windowsProcessProvider = () => [
    {
      pid: 1000,
      ppid: 2000,
      executablePath: 'C:\\Program Files\\node.exe',
      commandLine: '"C:\\Program Files\\node.exe" "C:\\Users\\dawn\\.claude\\local\\cli.js"',
    },
    {
      pid: 2000,
      ppid: 1,
      executablePath: 'C:\\Program Files\\Claude\\claude.exe',
      commandLine: '"C:\\Program Files\\Claude\\claude.exe" --resume',
    },
  ];
  const commands = getAncestorProcessCommands(3, {}, {
    platform: 'win32', startPid: 1000, windowsProcessProvider,
  });
  assert.equal(commands.length, 2);
  assert.equal(isAiParentedCommandChain(commands, config), true);
  assert.ok(commands[0].includes('\u0000'));
});

// ---------------------------------------------------------------------------
// listProcessCommands: whole-machine snapshot used by the sync-primary idle scan
// ---------------------------------------------------------------------------

/** A fake `ps` answering the two full-listing queries listProcessCommands makes. */
function fakeListingPs({ comms, commands, failOn } = {}) {
  return (args) => {
    if (failOn === args[1]) return { status: 1, stdout: '' };
    if (args[1] === 'pid=,ppid=,comm=') return { status: 0, stdout: comms.join('\n') + '\n' };
    if (args[1] === 'pid=,command=') return { status: 0, stdout: commands.join('\n') + '\n' };
    return { status: 1, stdout: '' };
  };
}

test('listProcessCommands: joins comm and command by pid and keeps an exe path with spaces matchable', () => {
  const ps = fakeListingPs({
    comms: [
      '  100     1 /Users/x/Library/Application Support/claude/claude',
      '  200   100 /bin/bash',
      '  300     1 node',
    ],
    commands: [
      '  100 /Users/x/Library/Application Support/claude/claude --resume',
      '  200 /bin/bash -c foo',
      '  300 node /home/x/.claude/local/cli.js',
    ],
  });
  const list = listProcessCommands({ ps });
  assert.deepEqual(list.map((p) => [p.pid, p.ppid]), [[100, 1], [200, 100], [300, 1]]);
  assert.equal(matchesAiParentProcess(list[0].commandLine, config), true, 'exe path with a space');
  assert.equal(matchesAiParentProcess(list[1].commandLine, config), false);
  assert.equal(matchesAiParentProcess(list[2].commandLine, config), true, 'script runtime under an AI home dir');
});

test('listProcessCommands: a process missing from the command listing keeps its comm; ps failure throws', () => {
  const list = listProcessCommands({
    ps: fakeListingPs({ comms: ['  100     1 claude'], commands: [] }),
  });
  assert.equal(matchesAiParentProcess(list[0].commandLine, config), true);

  for (const failOn of ['pid=,command=', 'pid=,ppid=,comm=']) {
    assert.throws(
      () => listProcessCommands({ ps: fakeListingPs({ comms: [], commands: [], failOn }) }),
      /process listing failed/,
      failOn,
    );
  }
  assert.throws(
    () => listProcessCommands({ ps: () => ({ status: null, error: new Error('spawn ps ENOENT') }) }),
    /spawn ps ENOENT/,
  );
});

test('listProcessCommands: Windows records preserve cwd evidence and unreadable status', () => {
  const rows = listProcessCommands({
    platform: 'win32',
    windowsProcessProvider: () => [
      {
        pid: 100, ppid: 1, executablePath: 'C:\\Tools\\claude.exe',
        commandLine: '"C:\\Tools\\claude.exe" --resume',
        cwd: 'C:\\repo\\worktree', cwdStatus: 'readable',
      },
      {
        pid: 200, ppid: 1, executablePath: 'C:\\Tools\\codex.exe',
        commandLine: '"C:\\Tools\\codex.exe"', cwd: null, cwdStatus: 'unreadable', cwdErrorCode: 5,
      },
    ],
  });
  assert.equal(rows[0].commandLine.includes('\u0000'), true);
  assert.equal(rows[0].cwd, 'C:\\repo\\worktree');
  assert.equal(rows[0].cwdStatus, 'readable');
  assert.equal(rows[1].cwd, null);
  assert.equal(rows[1].cwdStatus, 'unreadable');
  assert.equal(rows[1].cwdErrorCode, 5);
});

test('listWindowsProcesses: invokes built-in PowerShell CIM probe and normalizes one-row JSON', () => {
  let invocation;
  const rows = listWindowsProcesses({
    platform: 'win32',
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          pid: 12, ppid: 3, executablePath: 'C:\\Tools\\claude.exe',
          commandLine: 'claude.exe --resume', cwd: null, cwdStatus: 'unreadable', cwdErrorCode: 5,
        }),
      };
    },
  });
  assert.equal(invocation.command, 'powershell.exe');
  assert.ok(invocation.args.includes('-NoProfile'));
  assert.ok(invocation.args.at(-1).includes('Get-CimInstance -ClassName Win32_Process'));
  const nativeSource = invocation.args.at(-1);
  assert.equal((nativeSource.match(/DllImport\("ntdll\.dll", EntryPoint = "NtQueryInformationProcess"/g) || []).length, 2);
  assert.doesNotMatch(nativeSource, /DllImport\("kernel32\.dll"[^\n]*\)\]\s*private static extern int NtQueryInformationProcess/);
  assert.match(nativeSource, /DllImport\("kernel32\.dll", SetLastError = true\)\]\s*private static extern IntPtr OpenProcess/);
  assert.match(nativeSource, /DllImport\("kernel32\.dll", SetLastError = true\)\]\s*private static extern bool ReadProcessMemory/);
  assert.match(nativeSource, /DllImport\("kernel32\.dll", SetLastError = true\)\]\s*private static extern bool CloseHandle/);
  assert.match(nativeSource, /DllImport\("kernel32\.dll", SetLastError = true\)\]\s*private static extern bool IsWow64Process/);
  assert.match(nativeSource, /IntPtr\.Size == 4 && Environment\.Is64BitOperatingSystem/);
  assert.match(nativeSource, /status = 'unknown'; errorCode = \$null/);
  assert.match(nativeSource, /catch \{[\s\S]*status = 'unknown'/);
  assert.match(nativeSource, /new IntPtr\(\(long\)\(uint\)BitConverter\.ToInt32/);
  assert.match(nativeSource, /wow64Peb\.ToInt64\(\) & 0xffffffffL/);
  assert.match(nativeSource, /processId == 0[\s\S]*status = "excluded"/);
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(rows, [{
    pid: 12, ppid: 3, executablePath: 'C:\\Tools\\claude.exe',
    commandLine: 'claude.exe --resume', cwd: null, cwdStatus: 'unreadable', cwdErrorCode: 5,
  }]);
});

test('listWindowsProcesses: filters the PID-zero System Idle placeholder from realistic CIM-shaped rows', () => {
  const rows = listWindowsProcesses({
    platform: 'win32',
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify([
        { pid: 0, ppid: 0, executablePath: null, commandLine: null, cwd: null, cwdStatus: 'excluded', cwdErrorCode: 0 },
        { pid: 4, ppid: 0, executablePath: 'C:\\Windows\\System32\\smss.exe', commandLine: 'smss.exe', cwd: null, cwdStatus: 'unreadable', cwdErrorCode: 5 },
      ]),
    }),
  });
  assert.deepEqual(rows, [{
    pid: 4, ppid: 0, executablePath: 'C:\\Windows\\System32\\smss.exe', commandLine: 'smss.exe',
    cwd: null, cwdStatus: 'unreadable', cwdErrorCode: 5,
  }]);

  assert.throws(
    () => listWindowsProcesses({
      platform: 'win32',
      spawn: () => ({ status: 0, stdout: JSON.stringify([{ pid: 0, ppid: 1 }]) }),
    }),
    /invalid PID record/,
    'only the known PID 0 / PPID 0 system placeholder is excluded',
  );
});

test('listWindowsProcesses: spawn, PowerShell, and malformed inventory failures throw', () => {
  assert.throws(
    () => listWindowsProcesses({ platform: 'win32', spawn: () => ({ error: new Error('ENOENT') }) }),
    /process inventory failed: ENOENT/,
  );
  assert.throws(
    () => listWindowsProcesses({ platform: 'win32', spawn: () => ({ status: 1, stderr: 'CIM failed' }) }),
    /process inventory failed \(PowerShell exit 1\): CIM failed/,
  );
  assert.throws(
    () => listWindowsProcesses({ platform: 'win32', spawn: () => ({ status: 0, stdout: '{bad json' }) }),
    /invalid JSON/,
  );
  for (const row of [
    { pid: 'x', ppid: 1 },
    { pid: -1, ppid: 1 },
    { pid: 1.5, ppid: 1 },
    { ppid: 1 },
    { pid: 1 },
    { pid: 1, ppid: -1 },
    { pid: 1, ppid: 1.5 },
  ]) {
    assert.throws(
      () => listWindowsProcesses({ platform: 'win32', spawn: () => ({ status: 0, stdout: JSON.stringify([row]) }) }),
      /invalid PID record/,
      JSON.stringify(row),
    );
  }
});

test('probeWindowsDirectoryDeleteSafety: unknown, denied, and incomplete results fail closed', () => {
  const probeWith = (response) => probeWindowsDirectoryDeleteSafety('C:\\repo\\candidate', {
    platform: 'win32', spawn: () => response,
  });
  assert.deepEqual(probeWith({ status: 0, stdout: '{"safe":false,"reason":"access-denied","checked":2}' }), {
    safe: false, reason: 'access-denied', checked: 2,
  });
  assert.deepEqual(probeWith({ status: 0, stdout: '{"safe":false,"reason":"unknown","checked":1}' }), {
    safe: false, reason: 'unknown', checked: 1,
  });
  assert.equal(probeWith({ status: 0, stdout: '{"safe":true,"reason":"unknown","checked":1}' }).safe, false);
  assert.equal(probeWith({ status: 0, stdout: '{"safe":true,"reason":"safe","checked":0}' }).safe, false);
  assert.equal(probeWith({ status: 0, stdout: 'not json' }).reason, 'invalid-probe-result');
  const failed = probeWindowsDirectoryDeleteSafety('C:\\repo\\candidate', {
    platform: 'win32',
    spawn: () => ({ status: 1, stderr: `C:\\repo\\candidate Add-Type compile error ${'x'.repeat(400)}` }),
  });
  assert.equal(failed.reason, 'probe-failed');
  assert.equal(failed.diagnostic.length, 300);
  assert.doesNotMatch(failed.diagnostic, /C:\\repo\\candidate/);
  assert.equal(probeWith({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }).reason, 'timeout');
});

test('probeWindowsDirectoryDeleteSafety: bounded PowerShell scan rejects unsafe entries before returning safe', () => {
  let invocation;
  const result = probeWindowsDirectoryDeleteSafety('C:\\repo\\candidate', {
    platform: 'win32', timeoutMs: 12000, maxEntries: 500, maxDepth: 12,
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '{"safe":false,"reason":"reparse-point","checked":1}' };
    },
  });
  const script = invocation.args.at(-1);
  assert.equal(result.reason, 'reparse-point');
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.options.timeout, 17000);
  assert.match(script, /CreateFileW/);
  assert.match(script, /DELETE = 0x00010000/);
  assert.match(script, /SHARE_ALL = 0x00000007/);
  assert.match(script, /OPEN_EXISTING = 3/);
  assert.match(script, /BACKUP_SEMANTICS = 0x02000000/);
  assert.match(script, /OPEN_REPARSE_POINT = 0x00200000/);
  assert.match(script, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(script, /GetFileInformationByHandle/);
  assert.match(script, /@checked = checkedCount/);
  assert.doesNotMatch(script, /FILE_FLAG_DELETE_ON_CLOSE|DeleteFile\(|RemoveDirectory\(/);
  assert.doesNotMatch(script, /__MAX_ENTRIES__/);
  assert.ok(script.includes(', 500, 12, 12000)'));
});

test('probeWindowsDirectoryDeleteSafety: live Windows child CWD blocks its nested directory, then succeeds after exit', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-delete-probe-'));
  const nested = join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    cwd: nested,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  let whileLive;
  let afterExit;
  try {
    await once(child, 'spawn');
    whileLive = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(whileLive.safe, false, JSON.stringify(whileLive));
    assert.ok(whileLive.checked >= 1);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    afterExit = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(afterExit.safe, true, JSON.stringify(afterExit));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('probeWindowsDirectoryDeleteSafety: Windows DELETE denial is reported unsafe and ACL is restored', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-delete-denied-'));
  const denied = join(root, 'denied');
  await mkdir(denied);
  const encodePath = (path) => Buffer.from(path, 'utf16le').toString('base64');
  const rootPath = encodePath(root);
  const deniedPath = encodePath(denied);
  const captureDacl = (encodedPath) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $acl = Get-Acl -LiteralPath $path; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  const restoreScript = (encodedPath, originalDacl) => `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $sddl = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${originalDacl}')); $acl = Get-Acl -LiteralPath $path; $acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $path -AclObject $acl`;
  const captureRoot = captureDacl(rootPath);
  const captureDenied = captureDacl(deniedPath);
  if (captureRoot.status !== 0 || captureDenied.status !== 0 || !String(captureRoot.stdout || '').trim() || !String(captureDenied.stdout || '').trim()) {
    await rm(root, { recursive: true, force: true });
    assert.fail(captureRoot.stderr || captureDenied.stderr || captureRoot.stdout || captureDenied.stdout || 'failed to capture fixture ACLs');
  }
  const originalRootDacl = String(captureRoot.stdout).trim();
  const originalDeniedDacl = String(captureDenied.stdout).trim();
  const applyDeny = (encodedPath, rights) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rights = [Security.AccessControl.FileSystemRights]::${rights}; $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, [Security.AccessControl.AccessControlType]::Deny); $acl = Get-Acl -LiteralPath $path; $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl`], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  const readbackScript = `$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${rootPath}')); $denied = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${deniedPath}')); $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User; $sid = $identity.Value; $account = $identity.Translate([Security.Principal.NTAccount]).Value; $delete = [int][Security.AccessControl.FileSystemRights]::Delete; $deleteChild = [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles; function Read-Acl($path, $delete, $deleteChild, $sid) { $acl = Get-Acl -LiteralPath $path; $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid } | ForEach-Object { [pscustomobject]@{ rights = [int]$_.FileSystemRights; inherited = [bool]$_.IsInherited; inheritanceFlags = [string]$_.InheritanceFlags } }); $mask = 0; foreach ($entry in $rules) { $mask = $mask -bor $entry.rights }; [pscustomobject]@{ path = $path; rules = $rules; deniesDelete = (($mask -band $delete) -ne 0); deniesDeleteChild = (($mask -band $deleteChild) -ne 0); icacls = @(& icacls.exe $path /c 2>&1 | ForEach-Object { [string]$_ }) } }; $rootAcl = Read-Acl $root $delete $deleteChild $sid; $deniedAcl = Read-Acl $denied $delete $deleteChild $sid; $parentIcacls = @(& icacls.exe (Split-Path -Parent $root) /c 2>&1 | ForEach-Object { [string]$_ }); $privileges = @(& whoami.exe /priv /fo csv /nh 2>&1 | ForEach-Object { [string]$_ }); $whoami = @(& whoami.exe /user /fo csv /nh 2>&1 | ForEach-Object { [string]$_ }); [pscustomobject]@{ sid = $sid; account = $account; whoami = $whoami; privileges = $privileges; root = $rootAcl; denied = $deniedAcl; parentIcacls = $parentIcacls } | ConvertTo-Json -Compress -Depth 5`;
  let rootDenyAttempted = false;
  let deniedDenyAttempted = false;
  try {
    rootDenyAttempted = true;
    const rootApplied = applyDeny(rootPath, 'DeleteSubdirectoriesAndFiles');
    assert.equal(rootApplied.status, 0, rootApplied.stderr || rootApplied.stdout || 'failed to deny parent FILE_DELETE_CHILD on the fixture root');
    deniedDenyAttempted = true;
    const deniedApplied = applyDeny(deniedPath, 'Delete');
    assert.equal(deniedApplied.status, 0, deniedApplied.stderr || deniedApplied.stdout || 'failed to deny DELETE on the nested fixture directory');

    const readback = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', readbackScript], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(readback.status, 0, readback.stderr || readback.stdout || 'failed to read back temporary deny ACL');
    const acl = JSON.parse(readback.stdout.trim());
    const diagnostic = JSON.stringify(acl);
    const rootRules = Array.isArray(acl.root?.rules) ? acl.root.rules : [acl.root?.rules].filter(Boolean);
    const deniedRules = Array.isArray(acl.denied?.rules) ? acl.denied.rules : [acl.denied?.rules].filter(Boolean);
    const rootIcacls = Array.isArray(acl.root?.icacls) ? acl.root.icacls : [acl.root?.icacls].filter(Boolean);
    const deniedIcacls = Array.isArray(acl.denied?.icacls) ? acl.denied.icacls : [acl.denied?.icacls].filter(Boolean);
    const whoamiLines = Array.isArray(acl.whoami) ? acl.whoami : [acl.whoami].filter(Boolean);
    assert.ok(acl.sid, `current token SID missing from readback: ${diagnostic}`);
    assert.ok(whoamiLines.some((line) => line.includes(acl.sid)), `whoami /user SID does not match the ACL principal: ${diagnostic}`);
    assert.ok(acl.privileges?.length > 0, `whoami /priv did not report token privileges: ${diagnostic}`);
    assert.ok(acl.root?.deniesDeleteChild, `explicit current-token FILE_DELETE_CHILD deny missing on fixture parent: ${diagnostic}`);
    assert.ok(acl.denied?.deniesDelete, `explicit current-token DELETE deny missing on nested directory: ${diagnostic}`);
    assert.ok(rootRules.some((rule) => !rule.inherited), `no explicit parent deny ACE for the current token: ${diagnostic}`);
    assert.ok(deniedRules.some((rule) => !rule.inherited), `no explicit child deny ACE for the current token: ${diagnostic}`);
    assert.ok(rootIcacls.some((line) => (line.includes(acl.sid) || line.includes(acl.account)) && /\(DENY\)/.test(line) && /\bDC\b/.test(line)), `icacls did not confirm FILE_DELETE_CHILD deny on fixture parent: ${diagnostic}`);
    assert.ok(deniedIcacls.some((line) => (line.includes(acl.sid) || line.includes(acl.account)) && /\(DENY\)/.test(line) && /\bD\b/.test(line)), `icacls did not confirm DELETE deny on nested directory: ${diagnostic}`);

    const result = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(result.safe, false, `${JSON.stringify(result)}; ACL readback: ${diagnostic}`);
    assert.equal(result.reason, 'access-denied', `${JSON.stringify(result)}; ACL readback: ${diagnostic}`);
  } finally {
    if (deniedDenyAttempted) {
      const restored = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', restoreScript(deniedPath, originalDeniedDacl)], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.equal(restored.status, 0, restored.stderr || restored.stdout || 'failed to restore nested fixture ACL');
    }
    if (rootDenyAttempted) {
      const restored = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', restoreScript(rootPath, originalRootDacl)], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.equal(restored.status, 0, restored.stderr || restored.stdout || 'failed to restore fixture-parent ACL');
    }
    await rm(root, { recursive: true, force: true });
  }
});
