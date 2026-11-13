import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(calls, 1);
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
      return command === 'codex' ? response(0, JSON.stringify({ installed: [] })) : response(1, JSON.stringify({ status: 'setup-required', reason: 'restart' }));
    };
    const result = await installOptionalComponent({ ...f, component: { ...f.component, path: componentPath }, env: { HOME: f.home }, platform: 'darwin', arch: 'arm64', runner });
    assert.equal(result.status, 'setup-required');
    assert.equal(calls.find(([command]) => command === 'node')[1][0], script);
  }
});
