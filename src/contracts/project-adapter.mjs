import { spawn, spawnSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitDrained } from '../lib/exit-drained.mjs';

const CONFIG_PATH = '.vibe-coding/project.config.json';
const PHASES = Object.freeze([
  'afterCreate',
  'beforeCandidate',
  'verifyCandidate',
  'beforePush',
  'afterLand',
]);
let importSequence = 0;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
// Consumer projects can tune contracts.hookTimeoutMs up to Node's timer ceiling.
const HOOK_TIMEOUT_MS = 120_000;
const MAX_HOOK_TIMEOUT_MS = 2_147_483_647;
const ownedHookGroups = new Set();
let lifecycleCleanupInstalled = false;

function killOwnedHookGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 5_000,
    });
    if (!result.error && result.status === 0) return;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

function terminateOwnedHookGroups() {
  for (const pid of ownedHookGroups) killOwnedHookGroup(pid);
}

function onHookParentExit() {
  terminateOwnedHookGroups();
}

const PARENT_SIGNALS = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
const parentSignalHandlers = new Map(Object.entries(PARENT_SIGNALS).map(([signal, exitCode]) => [signal, () => {
  terminateOwnedHookGroups();
  exitDrained(exitCode);
}]));

function registerOwnedHookGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ownedHookGroups.add(pid);
  if (lifecycleCleanupInstalled) return;
  lifecycleCleanupInstalled = true;
  process.on('exit', onHookParentExit);
  for (const [signal, handler] of parentSignalHandlers) process.on(signal, handler);
}

function unregisterOwnedHookGroup(pid) {
  if (!ownedHookGroups.has(pid)) return;
  killOwnedHookGroup(pid);
  ownedHookGroups.delete(pid);
  if (ownedHookGroups.size || !lifecycleCleanupInstalled) return;
  lifecycleCleanupInstalled = false;
  process.off('exit', onHookParentExit);
  for (const [signal, handler] of parentSignalHandlers) process.off(signal, handler);
}

// Each declared hook gets a fresh Node module graph. This prevents a changed
// transitive policy/helper module from being silently reused across lifecycle phases.
const EXIT_DRAINED_URL = new URL('../lib/exit-drained.mjs', import.meta.url).href;
const HOOK_RUNNER = `
import { exitDrained } from ${JSON.stringify(EXIT_DRAINED_URL)};
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [adapterPath, phase, contextText] = process.argv.slice(1);
const respond = (message) => writeSync(3, JSON.stringify(message));
const phases = ['afterCreate', 'beforeCandidate', 'verifyCandidate', 'beforePush', 'afterLand'];
const cleanupOrphanedHook = () => {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    exitDrained(143);
    return;
  }
  try { process.kill(-process.pid, 'SIGKILL'); } catch { /* process group already ended */ }
  exitDrained(143);
};
let closingNormally = false;
const closeParentChannel = () => {
  closingNormally = true;
  if (process.connected) process.disconnect();
};
process.once('disconnect', () => { if (!closingNormally) cleanupOrphanedHook(); });
try {
  const context = JSON.parse(contextText);
  const adapter = await import(pathToFileURL(adapterPath).href);
  const contract = adapter.adapterContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || contract.schemaVersion !== 1 ||
      !contract.hooks || typeof contract.hooks !== 'object' || Array.isArray(contract.hooks) ||
      Object.keys(contract).some((key) => !['schemaVersion', 'hooks'].includes(key)))
    throw new Error('project adapter has an invalid contract in the fresh module graph');
  for (const [hookPhase, name] of Object.entries(contract.hooks)) {
    if (!phases.includes(hookPhase) || typeof name !== 'string' || !name.trim())
      throw new Error('project adapter has an invalid hook declaration in the fresh module graph');
    if (typeof adapter[name] !== 'function')
      throw new Error('project adapter hook handler is missing in the fresh module graph');
  }
  const handlerName = contract.hooks[phase];
  if (!handlerName) {
    respond({ ok: true, ran: false });
    closeParentChannel();
  } else {
    const handler = adapter[handlerName];
    if (typeof handler !== 'function') throw new Error('project adapter hook handler is missing in the fresh module graph');
    const result = await handler(Object.freeze(context));
    respond({ ok: true, ran: true, result });
    closeParentChannel();
  }
} catch (error) {
  respond({ ok: false, error: error?.message || String(error) });
  process.exitCode = 1;
  closeParentChannel();
}
`;

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateContract(value, modulePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`project adapter ${modulePath} must export adapterContract`);
  if (value.schemaVersion !== 1 || !value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))
    throw new Error(`project adapter ${modulePath} has an invalid contract`);
  for (const key of Object.keys(value))
    if (!['schemaVersion', 'hooks'].includes(key)) throw new Error(`project adapter contract has unknown field: ${key}`);
  for (const [phase, handlerName] of Object.entries(value.hooks)) {
    if (!PHASES.includes(phase)) throw new Error(`project adapter contract has unknown hook: ${phase}`);
    if (typeof handlerName !== 'string' || !handlerName.trim())
      throw new Error(`project adapter hook ${phase} must name an exported handler`);
  }
  return Object.freeze({ schemaVersion: 1, hooks: Object.freeze({ ...value.hooks }) });
}

async function resolveConfiguredAdapter({ projectRoot }) {
  if (typeof projectRoot !== 'string' || !projectRoot)
    throw new TypeError('projectRoot is required');
  const root = await realpath(projectRoot);
  const configPath = resolve(root, CONFIG_PATH);
  let configText;
  try {
    configText = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ applicable: false, projectRoot: root });
    throw error;
  }
  let config;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    throw new Error(`invalid project config JSON at ${CONFIG_PATH}: ${error.message}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1)
    throw new Error(`invalid project config at ${CONFIG_PATH}: schemaVersion 1 is required`);
  const configuredContracts = Object.hasOwn(config, 'contracts') ? config.contracts : {};
  if (!configuredContracts || typeof configuredContracts !== 'object' || Array.isArray(configuredContracts))
    throw new Error('project config contracts must be an object');
  const hookTimeoutMs = Object.hasOwn(configuredContracts, 'hookTimeoutMs')
    ? configuredContracts.hookTimeoutMs : HOOK_TIMEOUT_MS;
  if (!Number.isSafeInteger(hookTimeoutMs) || hookTimeoutMs <= 0 || hookTimeoutMs > MAX_HOOK_TIMEOUT_MS)
    throw new Error(`project config contracts.hookTimeoutMs must be an integer from 1 to ${MAX_HOOK_TIMEOUT_MS}`);
  if (typeof config.adapter !== 'string' || !config.adapter.trim())
    throw new Error(`invalid project config at ${CONFIG_PATH}: adapter path is required`);
  if (isAbsolute(config.adapter)) throw new Error('project adapter path must be relative to the project root');

  const lexicalPath = resolve(root, config.adapter);
  if (!isWithin(root, lexicalPath)) throw new Error('project adapter path escapes the project root');
  let adapterPath;
  try {
    adapterPath = await realpath(lexicalPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`configured project adapter is missing: ${config.adapter}`, { cause: error });
    throw error;
  }
  if (!isWithin(root, adapterPath)) throw new Error('project adapter resolves outside the project root');
  if (!(await stat(adapterPath)).isFile()) throw new Error('configured project adapter is not a file');

  return Object.freeze({ applicable: true, projectRoot: root, adapterPath, hookTimeoutMs });
}

/** Load and validate the configured consumer adapter for inspection. */
export async function loadProjectAdapter({ projectRoot }) {
  const configured = await resolveConfiguredAdapter({ projectRoot });
  if (!configured.applicable) return configured;
  const moduleUrl = pathToFileURL(configured.adapterPath);
  moduleUrl.searchParams.set('adapter-load', String(++importSequence));
  const adapterModule = await import(moduleUrl.href);
  const contract = validateContract(adapterModule.adapterContract, configured.adapterPath);
  for (const [phase, name] of Object.entries(contract.hooks)) {
    if (typeof adapterModule[name] !== 'function')
      throw new Error(`project adapter hook ${phase} references missing exported function ${name}`);
  }
  return Object.freeze({
    applicable: true,
    projectRoot: configured.projectRoot,
    adapterPath: configured.adapterPath,
    contract,
    handlers: adapterModule,
    hookTimeoutMs: configured.hookTimeoutMs,
  });
}

/**
 * Run one declared project hook in an isolated fresh Node module graph.
 * Context and hook results cross a JSON protocol and therefore must be JSON-serializable.
 * Unsuccessful and skipped results fail closed.
 */
export async function runProjectHook({ projectRoot, phase, context = {}, signal }) {
  if (!PHASES.includes(phase)) throw new Error(`unknown project adapter phase: ${phase}`);
  const adapter = await resolveConfiguredAdapter({ projectRoot });
  if (!adapter.applicable) return Object.freeze({ applicable: false, phase, ok: true });
  if (!context || typeof context !== 'object' || Array.isArray(context))
    throw new TypeError('project adapter hook context must be an object');
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
    throw new TypeError('signal must be an AbortSignal');
  if (signal?.aborted) throw abortError();
  const hookContext = { ...context, projectRoot: adapter.projectRoot, phase };
  let contextText;
  try {
    contextText = JSON.stringify(hookContext);
  } catch (error) {
    throw new Error(`project adapter hook context must be JSON-serializable: ${error.message}`, { cause: error });
  }
  if (typeof contextText !== 'string' || Buffer.byteLength(contextText) > MAX_CONTEXT_BYTES)
    throw new Error(`project adapter hook context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  const { ran, result } = await invokeHook(adapter.projectRoot, adapter.adapterPath, phase, contextText, adapter.hookTimeoutMs, signal);
  if (!ran) return Object.freeze({ applicable: true, phase, ok: true, ran: false });
  if (result === false || (result && typeof result === 'object' &&
      (result.ok === false || result.skip === true))) {
    throw new Error(`project adapter hook ${phase} rejected the operation`);
  }
  return Object.freeze({ applicable: true, phase, ok: true, ran: true, result });
}

function abortError() {
  const error = new Error('project adapter hook was cancelled');
  error.name = 'AbortError';
  return error;
}

function invokeHook(projectRoot, adapterPath, phase, contextText, timeoutMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HOOK_RUNNER,
      adapterPath, phase, contextText], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = [];
    const stderr = [];
    const protocol = [];
    let stderrBytes = 0;
    let protocolBytes = 0;
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let overflowChannel = null;
    registerOwnedHookGroup(child.pid);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', cancel);
      unregisterOwnedHookGroup(child.pid);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const overflow = (channel) => {
      if (settled || overflowChannel) return;
      overflowChannel = channel;
      killOwnedHookGroup(child.pid);
    };
    const cancel = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killOwnedHookGroup(child.pid);
    };
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROTOCOL_BYTES) return overflow('diagnostic');
      stderr.push(chunk);
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROTOCOL_BYTES) return overflow('stdout');
      stdout.push(chunk);
    });
    child.stdio[3].on('data', (chunk) => {
      protocolBytes += chunk.length;
      if (protocolBytes > MAX_PROTOCOL_BYTES) return overflow('protocol');
      protocol.push(chunk);
    });
    child.once('error', (error) => finish(new Error(`could not launch project adapter hook ${phase}: ${error.message}`, { cause: error })));
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      killOwnedHookGroup(child.pid);
    }, timeoutMs);
    child.once('close', (code, signal) => {
      if (settled) return;
      if (stdout.length) process.stdout.write(Buffer.concat(stdout));
      if (stderr.length) process.stderr.write(Buffer.concat(stderr));
      if (overflowChannel) return finish(new Error(`project adapter hook ${phase} exceeded its ${overflowChannel} output limit`));
      if (timedOut) return finish(new Error(`project adapter hook ${phase} timed out after ${timeoutMs}ms`));
      if (cancelled) return finish(abortError());
      const raw = Buffer.concat(protocol).toString('utf8');
      let message;
      try { message = JSON.parse(raw); }
      catch (error) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        return finish(new Error(`project adapter hook ${phase} returned an invalid protocol${detail ? `: ${detail}` : ` (${code ?? signal})`}`, { cause: error }));
      }
      if (code !== 0 || message?.ok !== true)
        return finish(new Error(`project adapter hook ${phase} failed: ${message?.error || Buffer.concat(stderr).toString('utf8').trim() || `exit ${code ?? signal}`}`));
      finish(null, { ran: message.ran === true, result: message.result });
    });
  });
}

export { PHASES as PROJECT_ADAPTER_PHASES };
