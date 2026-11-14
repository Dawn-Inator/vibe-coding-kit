import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectOptionalComponent, installOptionalComponent } from '../../src/optional/runtime.mjs';

function fixture(t, id = 'lark') {
  const root = mkdtempSync(join(tmpdir(), 'kit-optional-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kitRoot = join(root, 'kit');
  mkdirSync(join(kitRoot, 'optional', id), { recursive: true });
  return { kitRoot, home: join(root, 'home'), component: { id, type: id === 'codex-task-progress' ? 'plugin' : 'skills', path: `optional/${id}`, requirements: [] } };
}

function response(code, stdout = '', stderr = '') { return { code, stdout, stderr }; }

const realKitRoot = fileURLToPath(new URL('../..', import.meta.url));
function realComponent(id) {
  const catalog = JSON.parse(readFileSync(new URL('../../optional/catalog.json', import.meta.url), 'utf8'));
  return { id, ...catalog.components[id] };
}

test('installed lark-cli is detected and reused without installation', async (t) => {
  const f = fixture(t), calls = [];
  const runner = async (command, args, options) => { calls.push({ command, args, options }); return response(0, 'lark-cli v1.2.3\n'); };
  assert.equal((await inspectOptionalComponent({ ...f, runner })).status, 'installed');
  assert.equal((await installOptionalComponent({ ...f, runner })).status, 'installed');
  assert.equal(calls.filter((call) => call.command === 'npm').length, 0);
});

test('unsupported platform returns without probing or installing', async (t) => {
  const component = realComponent('codex-task-progress'); let calls = 0;
  const runner = async () => { calls += 1; return response(0); };
  assert.equal((await inspectOptionalComponent({ kitRoot: realKitRoot, component, platform: 'darwin', arch: 'x64', runner })).status, 'unsupported');
  assert.equal((await installOptionalComponent({ kitRoot: realKitRoot, component, platform: 'linux', arch: 'arm64', runner })).status, 'unsupported');
  assert.equal(calls, 0);
});

test('probe errors and malformed output are errors rather than missing', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const helper = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install', 'current', 'bin', 'goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true }); writeFileSync(helper, 'fixture');
  const runner = async () => response(0, 'not-json');
  assert.equal((await inspectOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner })).status, 'error');
  const failed = async () => response(2, '', 'permission denied');
  assert.equal((await inspectOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner: failed })).status, 'error');
});

test('valid doctor JSON confirms installed plugin even when doctor exits nonzero', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const helper = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install', 'current', 'bin', 'goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, 'fixture');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return response(1, JSON.stringify({ ok: false, details: { pluginInstalled: true }, diagnostics: ['unhealthy sidecar'] }));
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'installed');
  assert.equal(result.source, 'stable-install');
  assert.match(result.message, /plugin remains installed/);
  assert.equal(result.diagnostic.details.pluginInstalled, true);
  assert.equal(calls, 2);
});

test('fixed physical helper wins over the legacy current helper and reports launcher status', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const installRoot = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install');
  const fixed = join(installRoot, 'bin', 'goal-progress');
  const legacy = join(installRoot, 'current', 'bin', 'goal-progress');
  mkdirSync(join(fixed, '..'), { recursive: true });
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(fixed, 'fixed helper');
  writeFileSync(legacy, 'legacy helper retained');
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, fixed);
    return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
  };
  const result = await inspectOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'installed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cwd, join(installRoot, 'bin'));
  assert.deepEqual(calls[0].args, ['doctor', '--json']);
  assert.deepEqual(calls[1].args, ['launcher', '--status', '--json']);
  assert.equal(readFileSync(legacy, 'utf8'), 'legacy helper retained');
});

test('broken fixed helper fails closed without invoking a valid legacy helper', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const installRoot = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install');
  const fixed = join(installRoot, 'bin', 'goal-progress');
  const legacy = join(installRoot, 'current', 'bin', 'goal-progress');
  mkdirSync(join(fixed, '..'), { recursive: true });
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, 'legacy helper');
  writeFileSync(fixed, 'directory sentinel');
  rmSync(fixed);
  mkdirSync(fixed);
  let calls = 0;
  const result = await inspectOptionalComponent({
    ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64',
    runner: async () => { calls += 1; return response(0, JSON.stringify({ ok: true })); },
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /fixed goal-progress helper is not a regular non-symlink file/);
  assert.equal(calls, 0);
});

test('fixed helper symlink fails closed instead of falling back to the legacy helper', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const installRoot = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install');
  const fixed = join(installRoot, 'bin', 'goal-progress');
  const legacy = join(installRoot, 'current', 'bin', 'goal-progress');
  mkdirSync(join(fixed, '..'), { recursive: true });
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, 'legacy helper');
  const target = join(installRoot, 'target-helper');
  writeFileSync(target, 'target helper');
  symlinkSync(target, fixed);
  let calls = 0;
  const result = await inspectOptionalComponent({
    ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64',
    runner: async () => { calls += 1; return response(0, JSON.stringify({ ok: true })); },
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /fixed goal-progress helper is not a regular non-symlink file/);
  assert.equal(calls, 0);
});

test('fixed bin parent symlink fails closed with or without a target before legacy fallback', { skip: process.platform === 'win32' }, async (t) => {
  for (const dangling of [false, true]) {
    const f = fixture(t, 'codex-task-progress');
    const installRoot = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install');
    const fixedBin = join(installRoot, 'bin');
    const legacy = join(installRoot, 'current', 'bin', 'goal-progress');
    const targetBin = join(installRoot, 'fixed-bin-target');
    mkdirSync(targetBin, { recursive: true });
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(join(targetBin, 'goal-progress'), 'fixed helper');
    writeFileSync(legacy, 'legacy helper');
    symlinkSync(dangling ? join(installRoot, 'missing-bin-target') : targetBin, fixedBin, 'dir');
    let calls = 0;
    const result = await inspectOptionalComponent({
      ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64',
      runner: async () => { calls += 1; return response(0, JSON.stringify({ ok: true })); },
    });
    assert.equal(result.status, 'error');
    assert.match(result.message, /fixed goal-progress helper parent is not a physical directory/);
    assert.equal(calls, 0);
  }
});

test('legacy current helper remains usable when the fixed helper is absent', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const legacy = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install', 'current', 'bin', 'goal-progress');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, 'legacy helper');
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
  };
  const result = await inspectOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'installed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, legacy);
  assert.equal(calls[0].options.cwd, join(legacy, '..'));
  assert.deepEqual(calls[0].args, ['doctor', '--json']);
  assert.deepEqual(calls[1].args, ['launcher', '--status', '--json']);
});

test('missing lark-cli uses the documented package, then reprobes before success', async (t) => {
  const f = fixture(t), calls = [];
  let installed = false;
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'lark-cli') return installed ? response(0, 'lark-cli 1.0.0') : response(127);
    if (command === 'npm' && args[0] === '--version') return response(0, '10.0.0');
    if (command === 'npm' && args.join(' ') === 'install --global @larksuite/cli') { installed = true; return response(0); }
    return response(1);
  };
  const result = await installOptionalComponent({ ...f, runner, env: { PATH: '/safe', HOME: f.home, NPM_TOKEN: 'never-forward' } });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls.find((call) => call.command === 'npm' && call.args[0] === 'install')?.args, ['install', '--global', '@larksuite/cli']);
  assert.equal(calls.every((call) => !('NPM_TOKEN' in call.options.env)), true);
  assert.equal(calls.at(-1).command, 'lark-cli');
});

test('failed install reports error and never runs Lark configuration or login', async (t) => {
  const f = fixture(t), calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'lark-cli') return response(127);
    if (command === 'npm') return response(args[0] === '--version' ? 0 : 7);
    return response(1);
  };
  assert.equal((await installOptionalComponent({ ...f, runner })).status, 'error');
  assert.equal(calls.some(([command, args]) => command === 'lark-cli' && (args[0] === 'config' || args[0] === 'auth')), false);
});

function existingTaskProgressFixture(t) {
  const f = fixture(t, 'codex-task-progress');
  const helper = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install', 'bin', 'goal-progress');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, 'fixture helper');
  return { ...f, helper };
}

function doctorAndLauncherStatus(document) {
  return async (command, args) => {
    if (args[0] === 'doctor') return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
    if (args[0] === 'launcher' && args[1] === '--status') return response(0, JSON.stringify(document));
    return response(1, '', 'unexpected command');
  };
}

test('explicit managed Dock setup configures the launcher without restarting Codex or launching it', async (t) => {
  const f = existingTaskProgressFixture(t), calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'doctor') return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
    if (args[0] === 'launcher' && args[1] === '--status') return response(0, JSON.stringify({ launcherInstalled: false, dockConfigured: false }));
    if (args[0] === 'launcher' && args[1] === '--install') return response(0, JSON.stringify({ ok: true, details: { launcherInstalled: true, dockConfigured: true, launcherAppPath: '/Applications/Goal Progress.app' } }));
    return response(1, '', 'unexpected command');
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner, managedDock: true });
  assert.equal(result.status, 'installed');
  assert.equal(result.pluginInstalled, true);
  assert.equal(result.launcherInstalled, true);
  assert.equal(result.dockConfigured, true);
  assert.equal(result.launcherAppPath, '/Applications/Goal Progress.app');
  assert.equal(calls.some(({ args }) => args.includes('--restart-codex') || (args[0] === 'launch' && args.includes('--json'))), false);
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'launcher').map(({ args }) => args), [
    ['launcher', '--status', '--json'], ['launcher', '--install', '--dock', '--json'],
  ]);
});

test('fresh managed Dock opt-in defers Codex connection and configures the launcher after backend install', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  const helperScript = join(f.kitRoot, f.component.path, 'scripts', 'install-from-kit.mjs');
  mkdirSync(join(helperScript, '..'), { recursive: true });
  writeFileSync(helperScript, 'fixture installer');
  const installedHelper = join(f.home, 'Library', 'Application Support', 'CodexTaskProgress', 'install', 'bin', 'goal-progress');
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'codex') return response(0, JSON.stringify({ installed: [] }));
    if (command === 'node' && args[0] === helperScript && args[1] === '--check') {
      return response(0, JSON.stringify({ signing: { status: 'ready', candidates: [] } }));
    }
    if (command === 'node' && args[0] === helperScript && args[1] === '--defer-connection') {
      mkdirSync(join(installedHelper, '..'), { recursive: true });
      writeFileSync(installedHelper, 'fixture installed helper');
      return response(0, JSON.stringify({ status: 'installed', code: 'INSTALL_OK', connectionPending: true }));
    }
    if (command === installedHelper && args[0] === 'doctor') return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
    if (command === installedHelper && args[0] === 'launcher' && args[1] === '--status') return response(0, JSON.stringify({ launcherInstalled: false, dockConfigured: false }));
    if (command === installedHelper && args[0] === 'launcher' && args[1] === '--install') return response(0, JSON.stringify({ ok: true, details: { launcherInstalled: true, dockConfigured: true, launcherAppPath: '/Applications/Goal Progress.app' } }));
    return response(1, '', 'unexpected command');
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner, managedDock: true });
  assert.equal(result.status, 'installed');
  assert.equal(result.pluginInstalled, true);
  assert.equal(result.dockConfigured, true);
  assert.deepEqual(calls.find(({ command, args }) => command === 'node' && args[0] === helperScript && args.includes('--defer-connection'))?.args, [helperScript, '--defer-connection']);
  assert.equal(calls.some(({ args }) => args.includes('--restart-codex') || args[0] === 'launch'), false);
});

test('already configured managed Dock launcher is reused idempotently', async (t) => {
  const f = existingTaskProgressFixture(t), calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return doctorAndLauncherStatus({ launcherInstalled: true, dockConfigured: true, launcherAppPath: '/Applications/Goal Progress.app' })(command, args, options);
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner, managedDock: true });
  assert.equal(result.status, 'installed');
  assert.equal(result.dockConfigured, true);
  assert.equal(calls.some(({ args }) => args[1] === '--install'), false);
});

test('old helper without launcher support reports setup-required and is not rebuilt or upgraded', async (t) => {
  const f = existingTaskProgressFixture(t), calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'doctor') return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
    if (args[0] === 'launcher') return response(2, '', 'unknown command');
    return response(1);
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner, managedDock: true });
  assert.equal(result.status, 'setup-required');
  assert.match(result.message, /does not support managed Dock launchers/);
  assert.equal(calls.some(({ args }) => args[0] === 'install-from-kit.mjs' || args.includes('--restart-codex')), false);
});

test('installed plugin opt-out leaves an unconfigured Dock launcher untouched', async (t) => {
  const f = existingTaskProgressFixture(t), calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'doctor') return response(0, JSON.stringify({ ok: true, details: { pluginInstalled: true } }));
    if (args[0] === 'launcher' && args[1] === '--status') return response(0, JSON.stringify({ launcherInstalled: false, dockConfigured: false }));
    return response(1);
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner, managedDock: false });
  assert.equal(result.status, 'installed');
  assert.equal(result.pluginInstalled, true);
  assert.equal(result.launcherInstalled, false);
  assert.equal(calls.some(({ args }) => args[1] === '--install' || args[0] === 'launch'), false);
});

test('versioned requirements reject unknown versions and retain argv boundaries', async (t) => {
  const f = fixture(t, 'hyperframes'), calls = [];
  f.component.requirements = [{ command: 'node --version', minimumVersion: '22' }];
  const unknown = await inspectOptionalComponent({ ...f, runner: async (command, args) => { calls.push([command, args]); return response(0, 'node version unavailable'); } });
  assert.equal(unknown.status, 'error');
  assert.deepEqual(calls[0], ['node', ['--version']]);
  f.component.requirements = [{ command: 'node --version; touch /tmp/not-allowed', minimumVersion: '22' }];
  assert.equal((await inspectOptionalComponent({ ...f, runner: async () => response(0, 'v22.1.0') })).status, 'error');
});

test('actual catalog HyperFrames package argv is preserved and verified after install', async () => {
  const catalog = JSON.parse(readFileSync(new URL('../../optional/catalog.json', import.meta.url), 'utf8'));
  const component = { id: 'hyperframes', ...catalog.components.hyperframes };
  const kitRoot = new URL('../..', import.meta.url).pathname;
  const calls = [];
  let packageReady = false;
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'node') return response(0, 'v24.19.0');
    if (command === 'ffmpeg') return response(0, 'ffmpeg version 7.0.0');
    if (command === 'npx' && args[0] === '--no-install') return packageReady ? response(0, '0.8.149') : response(1, '', 'not installed');
    if (command === 'npx' && args[0] === '--yes') { packageReady = true; return response(0, '0.8.149'); }
    return response(1);
  };
  const result = await installOptionalComponent({ kitRoot, component, runner, platform: 'linux', arch: 'x64', env: { PATH: '/fixture', HOME: '/fixture-home' } });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls.filter(([command]) => command === 'npx').map(([, args]) => args), [
    ['--no-install', 'hyperframes@0.8.149', '--version'],
    ['--yes', 'hyperframes@0.8.149', '--version'],
    ['--no-install', 'hyperframes@0.8.149', '--version'],
  ]);
});

test('registered Task Progress plugin is reused at any version', async (t) => {
  const f = fixture(t, 'codex-task-progress'), calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    return response(0, JSON.stringify({ installed: [{ pluginId: 'codex-task-progress@codex-task-progress-local', installed: true, version: '0.1.0' }] }));
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'installed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['codex', ['plugin', 'list', '--marketplace', 'codex-task-progress-local', '--json']]);
  assert.equal(calls.flat(2).some((value) => typeof value === 'string' && value.includes('restart')), false);
});

test('Task Progress installer restart-required JSON becomes setup-required without restarting Codex', async (t) => {
  const component = realComponent('codex-task-progress'), calls = [];
  const home = mkdtempSync(join(tmpdir(), 'kit-optional-plugin-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'codex') return response(0, JSON.stringify({ installed: [] }));
    if (command === 'node' && args[1] === '--check') return response(0, JSON.stringify({ signing: { status: 'ready', candidates: [] } }));
    if (command === 'node') return response(1, JSON.stringify({ status: 'setup-required', reason: 'Installation is pending a Codex restart.' }));
    return response(1);
  };
  const result = await installOptionalComponent({ kitRoot: realKitRoot, component, env: { HOME: home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'setup-required');
  assert.match(result.message, /Installation is pending a Codex restart/);
  assert.equal(calls[1][0], 'node');
  assert.equal(calls[1][1][0], join(realKitRoot, component.installation.script));
  assert.equal(calls.some(([command, args]) => command === 'codex' && args.join(' ').includes('restart')), false);
});

test('component path traversal is rejected before runner invocation', async (t) => {
  const f = fixture(t); let calls = 0;
  const runner = async () => { calls += 1; return response(0); };
  assert.equal((await inspectOptionalComponent({ ...f, component: { ...f.component, path: '../escape' }, runner })).status, 'error');
  assert.equal(calls, 0);
});

test('catalog installer path traversal is rejected before plugin detection runs', async () => {
  const component = realComponent('codex-task-progress');
  component.installation.script = '../../outside.mjs';
  let calls = 0;
  const result = await installOptionalComponent({
    kitRoot: realKitRoot,
    component,
    env: { HOME: '/tmp/optional-runtime-test-home' },
    platform: 'darwin',
    arch: 'arm64',
    runner: async () => { calls += 1; return response(0); },
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /installer script path/);
  assert.equal(calls, 0);
});

test('Task Progress installer fallback follows the component path in both layouts', async (t) => {
  const f = fixture(t, 'codex-task-progress');
  for (const componentPath of ['optional/codex-task-progress', 'optional/plugins/codex-task-progress']) {
    const script = join(f.kitRoot, componentPath, 'scripts', 'install-from-kit.mjs');
    mkdirSync(join(script, '..'), { recursive: true }); writeFileSync(script, '');
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === 'codex') return response(0, JSON.stringify({ installed: [] }));
      if (args[1] === '--check') return response(0, JSON.stringify({ signing: { status: 'ready', candidates: [] } }));
      return response(1, JSON.stringify({ status: 'setup-required', reason: 'restart' }));
    };
    const result = await installOptionalComponent({ ...f, component: { ...f.component, path: componentPath }, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
    assert.equal(result.status, 'setup-required');
    assert.equal(calls.find(([command]) => command === 'node')[1][0], script);
  }
});

function signingPluginFixture(t) {
  const f = fixture(t, 'codex-task-progress');
  const helper = join(f.kitRoot, f.component.path, 'scripts', 'install-from-kit.mjs');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, 'fixture installer');
  return { ...f, helper };
}

const signingCandidates = [{ name: 'Developer ID Application: Example', identity: '0123456789abcdef0123456789abcdef01234567' }];

test('Task Progress installer performs a read-only signing check and stops before build when selection is absent', async (t) => {
  const f = signingPluginFixture(t), calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'codex') return response(0, JSON.stringify({ installed: [] }));
    if (command === 'node' && args[0] === f.helper && args[1] === '--check') {
      return response(0, JSON.stringify({ status: 'setup-required', signing: { status: 'confirmation-required', candidates: signingCandidates, configPath: '/local/signing.json' } }));
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'setup-required');
  assert.match(result.message, /0123456789abcdef0123456789abcdef01234567/);
  assert.match(result.message, new RegExp(`node '${f.helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --configure-signing --identity`));
  assert.deepEqual(calls.map(([, args]) => args.at(-1)), ['--json', '--check']);
});

test('Task Progress installer never auto-selects even one certificate and rejects an unknown confirmation', async (t) => {
  for (const confirmSigning of [undefined, async () => 'ffffffffffffffffffffffffffffffffffffffff']) {
    const f = signingPluginFixture(t), calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === 'codex') return response(0, JSON.stringify({ installed: [] }));
      if (command === 'node' && args[0] === f.helper && args[1] === '--check') return response(0, JSON.stringify({
        signing: { status: 'confirmation-required', candidates: signingCandidates, configPath: '/local/signing.json' },
      }));
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const result = await installOptionalComponent({ ...f, confirmSigning, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
    assert.equal(result.status, 'setup-required');
    assert.equal(calls.some(([, args]) => args.includes('--configure-signing')), false);
    assert.equal(calls.some(([, args]) => args[0] === f.helper && args.length === 1), false);
  }
});

test('Task Progress signing confirmation configures once, rechecks, then builds; installed reuse skips signing probes', async (t) => {
  const f = signingPluginFixture(t), calls = [];
  let configured = false, installed = false;
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'codex') return response(0, JSON.stringify({ installed: installed ? [{ pluginId: 'codex-task-progress@codex-task-progress-local', installed: true }] : [] }));
    if (command === 'node' && args[0] === f.helper && args[1] === '--check') return response(0, JSON.stringify({
      signing: configured ? { status: 'ready', candidates: [], configPath: '/local/signing.json' } : { status: 'confirmation-required', candidates: signingCandidates, configPath: '/local/signing.json' },
    }));
    if (command === 'node' && args[0] === f.helper && args[1] === '--configure-signing') {
      configured = true;
      return response(0, JSON.stringify({ status: 'configured' }));
    }
    if (command === 'node' && args[0] === f.helper && args.length === 1) {
      assert.equal(configured, true, 'build begins only after persisted signing choice');
      installed = true;
      return response(0, JSON.stringify({ status: 'installed', code: 'INSTALL_OK' }));
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const result = await installOptionalComponent({
    ...f,
    confirmSigning: async (candidates) => candidates[0].identity,
    env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner,
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls.filter(({ command, args }) => command === 'node').map(({ args }) => args.slice(1)), [
    ['--check'], ['--configure-signing', '--identity', signingCandidates[0].identity], ['--check'], [],
  ]);
  const reused = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(reused.status, 'installed');
  assert.equal(calls.filter(({ command, args }) => command === 'node' && args[0] === f.helper).length, 4);
});

test('Task Progress installer accepts explicit signing environment only through the safe child environment', async (t) => {
  const f = signingPluginFixture(t), calls = [];
  const identity = signingCandidates[0].identity;
  let installed = false;
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'codex') return response(0, JSON.stringify({ installed: installed ? [{ pluginId: 'codex-task-progress@codex-task-progress-local', installed: true }] : [] }));
    if (command === 'node' && args[0] === f.helper && args[1] === '--check') return response(0, JSON.stringify({ signing: { status: 'ready', candidates: [], configPath: '/local/signing.json' } }));
    if (command === 'node' && args[0] === f.helper && args.length === 1) {
      installed = true;
      return response(0, JSON.stringify({ status: 'installed', code: 'INSTALL_OK' }));
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const result = await installOptionalComponent({
    ...f, env: { HOME: f.home, GOAL_PROGRESS_CODESIGN_IDENTITY: identity, GOAL_PROGRESS_CODESIGN_CONFIG: '/tmp/safe-config.json', SECRET_SENTINEL: 'never-forward' },
    platform: 'darwin', arch: 'arm64', runner,
  });
  assert.equal(result.status, 'installed');
  const childEnv = calls.find(({ command, args }) => command === 'node' && args[1] === '--check').options.env;
  assert.equal(childEnv.GOAL_PROGRESS_CODESIGN_IDENTITY, identity);
  assert.equal(childEnv.GOAL_PROGRESS_CODESIGN_CONFIG, '/tmp/safe-config.json');
  assert.equal('SECRET_SENTINEL' in childEnv, false);
  const buildEnv = calls.find(({ command, args }) => command === 'node' && args[0] === f.helper && args.length === 1).options.env;
  assert.equal(buildEnv.GOAL_PROGRESS_CODESIGN_IDENTITY, identity);
  assert.equal(buildEnv.GOAL_PROGRESS_CODESIGN_CONFIG, '/tmp/safe-config.json');
});

test('unavailable signing reports an accurate eligible certificate recovery step', async (t) => {
  const f = signingPluginFixture(t);
  const runner = async (command, args) => command === 'codex'
    ? response(0, JSON.stringify({ installed: [] }))
    : response(0, JSON.stringify({ signing: { status: 'unavailable', candidates: [], configPath: '/local/signing.json' } }));
  const result = await installOptionalComponent({ ...f, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
  assert.equal(result.status, 'setup-required');
  assert.match(result.message, /eligible macOS code-signing certificate/);
  assert.doesNotMatch(result.message, /Developer ID signing certificate/);
});
